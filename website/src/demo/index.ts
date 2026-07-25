/**
 * Landing-page demo orchestrator.
 *
 * Two modes, deliberately distinct:
 *
 *   replay — real telemetry captured from the standalone Nano. Loads
 *            immediately (~250 KB) so the page has something true on it at
 *            first paint. It is a recording, so it cannot be perturbed, and
 *            the UI says so rather than faking interactivity.
 *
 *   live   — the flashed network driving MuJoCo in the tab. Costs 2.4 MB of
 *            gzipped WASM, so it is fetched only when the visitor asks for it.
 *            This is the mode that can be nudged.
 */

import constants from '../generated/constants.json';
import { PendulumRenderer } from './renderer.ts';
import { Policy, type PolicyWeights } from './policy.ts';
import { PendulumController, type Constants, BALANCED_THRESHOLD_RAD } from './control.ts';

type Mode = 'replay' | 'live';

interface Replay {
  controlFreqHz: number;
  samples: number;
  durationS: number;
  scale: number;
  actionScale: number;
  motorPos: number[];
  pendulumPos: number[];
  action: number[];
  source: string;
}

const C = constants as unknown as Constants;

function wrapPi(a: number): number {
  let x = (a + Math.PI) % (2 * Math.PI);
  if (x < 0) x += 2 * Math.PI;
  return x - Math.PI;
}

function el<T extends HTMLElement>(root: HTMLElement, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`demo: missing element ${sel}`);
  return found;
}

export async function mountDemo(root: HTMLElement): Promise<void> {
  const canvas = el<HTMLCanvasElement>(root, '[data-canvas]');
  const status = el(root, '[data-status]');
  const readouts = {
    theta: el(root, '[data-theta]'),
    action: el(root, '[data-action]'),
    balanced: el(root, '[data-balanced]'),
    streak: el(root, '[data-streak]'),
    mode: el(root, '[data-mode-label]'),
  };
  const buttons = {
    replay: el<HTMLButtonElement>(root, '[data-mode="replay"]'),
    live: el<HTMLButtonElement>(root, '[data-mode="live"]'),
    nudge: el<HTMLButtonElement>(root, '[data-action-nudge]'),
    reset: el<HTMLButtonElement>(root, '[data-action-reset]'),
  };

  const baseUrl = root.dataset.baseUrl ?? '/';

  const renderer = new PendulumRenderer(canvas, baseUrl);
  const ro = new ResizeObserver(() => renderer.resize());
  ro.observe(canvas);

  status.textContent = 'Loading the rig…';
  try {
    await renderer.load();
  } catch (err) {
    status.textContent = 'Could not load the 3D model.';
    console.error(err);
    return;
  }

  // ---- replay ----------------------------------------------------------
  let replay: Replay | null = null;
  try {
    const res = await fetch(`${baseUrl}sim/replay.json`);
    if (res.ok) replay = (await res.json()) as Replay;
  } catch {
    /* falls through to live-only below */
  }

  // ---- live (lazily constructed) ---------------------------------------
  let controller: PendulumController | null = null;
  let liveLoading: Promise<PendulumController> | null = null;

  async function ensureLive(): Promise<PendulumController> {
    if (controller) return controller;
    if (liveLoading) return liveLoading;

    liveLoading = (async () => {
      status.textContent = 'Loading the physics engine (2.4 MB)…';
      const [{ default: loadMujoco }, xml, weights] = await Promise.all([
        import('@mujoco/mujoco'),
        fetch(`${baseUrl}sim/model.xml`).then((r) => {
          if (!r.ok) throw new Error(`model.xml → HTTP ${r.status}`);
          return r.text();
        }),
        fetch(`${baseUrl}sim/policy.json`).then((r) => {
          if (!r.ok) throw new Error(`policy.json → HTTP ${r.status}`);
          return r.json() as Promise<PolicyWeights>;
        }),
      ]);

      const mujoco = await loadMujoco();
      const model = mujoco.MjModel.from_xml_string(xml);
      const data = new mujoco.MjData(model);
      const c = new PendulumController({
        mujoco: mujoco as never,
        model,
        data: data as never,
        policy: new Policy(weights),
        constants: C,
      });
      c.reset();
      controller = c;
      status.textContent = '';
      return c;
    })();

    try {
      return await liveLoading;
    } catch (err) {
      liveLoading = null;
      status.textContent = 'Could not load the physics engine.';
      console.error(err);
      throw err;
    }
  }

  // ---- mode switching --------------------------------------------------
  let mode: Mode = replay ? 'replay' : 'live';

  function paintModeButtons(): void {
    for (const [name, button] of Object.entries(buttons) as [Mode | string, HTMLButtonElement][]) {
      if (name === 'replay' || name === 'live') {
        button.setAttribute('aria-pressed', String(mode === name));
      }
    }
    const isLive = mode === 'live';
    buttons.nudge.disabled = !isLive;
    buttons.nudge.title = isLive
      ? 'Disturb the pendulum and watch the policy recover'
      : 'A recording cannot be perturbed — switch to the live network first';
    buttons.reset.textContent = isLive ? 'Reset' : 'Restart';
    readouts.mode.textContent = isLive
      ? `live · MuJoCo in your browser · ${C.control.frequencyHz} Hz`
      : `recording · real hardware · ${replay?.controlFreqHz.toFixed(0)} Hz`;
  }

  async function setMode(next: Mode): Promise<void> {
    if (next === mode) return;
    if (next === 'live') {
      buttons.live.disabled = true;
      try {
        await ensureLive();
      } finally {
        buttons.live.disabled = false;
      }
    }
    mode = next;
    replayIndex = 0;
    accumulator = 0;
    paintModeButtons();
  }

  buttons.replay.addEventListener('click', () => {
    if (replay) void setMode('replay');
  });
  buttons.live.addEventListener('click', () => void setMode('live'));
  buttons.nudge.addEventListener('click', () => {
    if (mode !== 'live' || !controller) return;
    // Sign alternates so repeated clicks push both ways rather than
    // accumulating spin in one direction.
    nudgeSign *= -1;
    controller.nudge(nudgeSign * 5.5);
  });
  buttons.reset.addEventListener('click', () => {
    if (mode === 'live') controller?.reset();
    else replayIndex = 0;
    accumulator = 0;
  });

  let nudgeSign = 1;

  if (!replay) {
    buttons.replay.disabled = true;
    buttons.replay.title = 'No on-device capture is bundled with this build';
  }

  // ---- animation loop --------------------------------------------------
  let replayIndex = 0;
  let accumulator = 0;
  let lastFrameMs = performance.now();
  let running = true;

  // A tab that has been backgrounded returns a huge dt; stepping through all
  // of it would freeze the page. Cap catch-up at a few ticks per frame.
  const MAX_TICKS_PER_FRAME = 8;

  // Replay metrics are computed over the whole capture up front: they describe
  // the recording, not the portion played so far, and the numbers should match
  // what analyze_onboard.py reported for this capture.
  const replayMetrics = replay
    ? (() => {
        let n = 0;
        for (const raw of replay.pendulumPos) {
          if (Math.abs(wrapPi(raw * replay.scale - Math.PI)) < BALANCED_THRESHOLD_RAD) n++;
        }
        return { balancedFraction: n / replay.pendulumPos.length };
      })()
    : null;

  function frame(nowMs: number): void {
    if (!running) return;
    const dt = Math.min(0.25, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;

    if (mode === 'live' && controller) {
      accumulator += dt;
      const period = controller.controlPeriodS;
      let ticks = 0;
      let state = null;
      while (accumulator >= period && ticks < MAX_TICKS_PER_FRAME) {
        state = controller.step();
        accumulator -= period;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_FRAME) accumulator = 0;

      if (state) {
        renderer.setJointAngles(state.motorPosRad, state.pendulumPosRad);
        const m = controller.metrics;
        readouts.theta.textContent = `${(state.thetaRad * (180 / Math.PI)).toFixed(1)}°`;
        readouts.action.textContent = state.action.toFixed(2);
        readouts.balanced.textContent = m.balancedFraction.toFixed(3);
        readouts.streak.textContent = `${m.currentStreakS.toFixed(1)} s`;
      }
    } else if (replay) {
      accumulator += dt;
      const period = 1 / replay.controlFreqHz;
      while (accumulator >= period) {
        replayIndex = (replayIndex + 1) % replay.samples;
        accumulator -= period;
      }
      const motor = replay.motorPos[replayIndex] * replay.scale;
      const pend = replay.pendulumPos[replayIndex] * replay.scale;
      const action = replay.action[replayIndex] * replay.actionScale;
      renderer.setJointAngles(motor, pend);
      const theta = wrapPi(pend - Math.PI);
      readouts.theta.textContent = `${(theta * (180 / Math.PI)).toFixed(1)}°`;
      readouts.action.textContent = action.toFixed(2);
      readouts.balanced.textContent = replayMetrics!.balancedFraction.toFixed(3);
      readouts.streak.textContent = `${(replayIndex / replay.controlFreqHz).toFixed(1)} s`;
    }

    renderer.render();
    requestAnimationFrame(frame);
  }

  // Pause when scrolled out of view: this is a landing page, and there is no
  // reason to burn a visitor's battery simulating a pendulum they cannot see.
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting && !running) {
        running = true;
        lastFrameMs = performance.now();
        requestAnimationFrame(frame);
      } else if (!entry.isIntersecting) {
        running = false;
      }
    }
  });
  io.observe(canvas);

  paintModeButtons();
  status.textContent = '';
  root.dataset.ready = 'true';
  requestAnimationFrame(frame);
}
