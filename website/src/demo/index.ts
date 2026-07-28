/**
 * Landing-page demo orchestrator.
 *
 * One mode: the flashed network driving MuJoCo in the tab. The 2.4 MB of
 * gzipped WASM is fetched when the demo scrolls into view rather than at page
 * load, so a visitor who never reaches it never pays for it.
 *
 * Drag the pendulum to disturb it; switch control off to watch it fall, and
 * back on to watch the same network swing it up again.
 */

import constants from '../generated/constants.json';
import { PendulumRenderer } from './renderer.ts';
import { Policy, type PolicyWeights } from './policy.ts';
import { PendulumController, type Constants } from './control.ts';
import { Sparkline } from './sparkline.ts';

const C = constants as unknown as Constants;

/** Value readouts refresh at this rate. The simulation ticks 50 times a
 *  second, and text changing that fast reads as flicker rather than
 *  information — the traces carry the fast detail. */
const READOUT_HZ = 5;

function el<T extends HTMLElement>(root: ParentNode, sel: string): T {
  const found = root.querySelector<T>(sel);
  if (!found) throw new Error(`demo: missing element ${sel}`);
  return found;
}

export async function mountDemo(root: HTMLElement): Promise<void> {
  const canvas = el<HTMLCanvasElement>(root, '[data-canvas]');
  const status = el(root, '[data-status]');
  const hint = el(root, '[data-demo-hint]');
  const toggle = el<HTMLInputElement>(root, '[data-control-toggle]');
  const toggleLabel = el(root, '[data-control-label]');

  // Ranges are fixed where the quantity has a natural one, so a trace means the
  // same thing from one glance to the next: sin, cos and the action are bounded
  // by construction, and the motor is bounded by its own safety rails. The two
  // velocities autoscale, because their range depends on how hard the policy is
  // working. Every tile shades the K-frame stack it is currently reading.
  const K = C.control.obsFrames;
  // The tiles are not inside `root`: the stage sits in the hero and the tiles
  // full-width below it, so they are two separate subtrees. There is one demo per
  // page, so resolving them from the document is unambiguous.
  const spark = (key: string, opts: Record<string, number>) =>
    new Sparkline(el<HTMLCanvasElement>(document, `[data-plot="${key}"]`), {
      ...opts,
      highlightLast: K,
    });

  const plots = {
    // Autoscaled with a floor, not pinned to the +-125 deg safety rails: the
    // policy holds the arm within a few hundredths of a radian while balancing,
    // so a rail-to-rail scale draws a flat line and hides the hunting that is
    // the whole point. The floor stops that noise filling the tile, and the
    // scale opens up on its own during a swing-up or a rail excursion.
    motorPos: spark('motorPos', { minSpan: 0.4, zero: 0 }),
    sinTheta: spark('sinTheta', { min: -1, max: 1, zero: 0 }),
    cosTheta: spark('cosTheta', { min: -1, max: 1, zero: 0 }),
    motorVel: spark('motorVel', { minSpan: 2, zero: 0 }),
    penVel: spark('penVel', { minSpan: 4, zero: 0 }),
    action: spark('action', { min: -1, max: 1, zero: 0 }),
  };
  const values = {
    motorPos: el(document, '[data-plot-value="motorPos"]'),
    sinTheta: el(document, '[data-plot-value="sinTheta"]'),
    cosTheta: el(document, '[data-plot-value="cosTheta"]'),
    motorVel: el(document, '[data-plot-value="motorVel"]'),
    penVel: el(document, '[data-plot-value="penVel"]'),
    action: el(document, '[data-plot-value="action"]'),
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

  let controller: PendulumController | null = null;
  let loading: Promise<PendulumController> | null = null;

  function setHint(): void {
    if (!controller) hint.textContent = '';
    else if (toggle.checked) {
      hint.textContent = 'Drag the pendulum to push it — the network has to catch it.';
    } else {
      hint.textContent =
        'Control is off. Switch it back on and the network swings it up again.';
    }
  }

  async function ensureLive(): Promise<PendulumController> {
    if (controller) return controller;
    if (loading) return loading;

    loading = (async () => {
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
      // mjOBJ_BODY = 1. Looked up by name rather than hardcoded so a change to
      // the MJCF's body order cannot silently push on the wrong link.
      const name2id = (mujoco as never as {
        mj_name2id(m: unknown, t: number, n: string): number;
      }).mj_name2id;
      const pendulumBody = name2id(model, 1, 'pendulum');
      if (pendulumBody > 0) {
        renderer.setGrabDelegate({
          tryGrab: (p) => {
            c.grab(pendulumBody, p);
            return true;
          },
          drag: (p) => c.dragTo(p),
          release: () => {
            c.release();
            renderer.setDragArrow(null);
          },
        });
      }
      controller = c;
      status.textContent = '';
      setHint();
      return c;
    })();

    try {
      return await loading;
    } catch (err) {
      loading = null;
      status.textContent = 'Could not load the physics engine.';
      console.error(err);
      throw err;
    }
  }

  toggle.addEventListener('change', () => {
    toggleLabel.textContent = toggle.checked ? 'Control on' : 'Control off';
    setHint();
  });

  const MAX_TICKS_PER_FRAME = 8;
  let accumulator = 0;
  let lastFrameMs = performance.now();
  let lastReadoutMs = 0;
  let running = false;

  function frame(nowMs: number): void {
    if (!running) return;
    const dt = Math.min(0.25, (nowMs - lastFrameMs) / 1000);
    lastFrameMs = nowMs;

    if (controller) {
      accumulator += dt;
      const period = controller.controlPeriodS;
      let ticks = 0;
      let state = null;
      while (accumulator >= period && ticks < MAX_TICKS_PER_FRAME) {
        state = toggle.checked ? controller.step() : controller.coast();
        // One sample per tick, inside the loop. Pushing once per animation
        // frame instead resamples the signal at the display's refresh rate,
        // which drops or duplicates ticks and would make the shaded K-frame
        // window mean "the last few repaints" rather than the policy's input.
        const o = state.obs;
        plots.motorPos.push(o.motorPos);
        plots.sinTheta.push(o.sinTheta);
        plots.cosTheta.push(o.cosTheta);
        plots.motorVel.push(o.motorVel);
        plots.penVel.push(o.penVel);
        plots.action.push(state.action);
        accumulator -= period;
        ticks++;
      }
      if (ticks === MAX_TICKS_PER_FRAME) accumulator = 0;

      if (state) {
        renderer.setJointAngles(state.motorPosRad, state.pendulumPosRad);
        // Redrawn every frame, not just on pointermove: the held point travels
        // with the body, so a stale arrow would detach from it while swinging.
        renderer.setDragArrow(controller.grabArrow());

        if (nowMs - lastReadoutMs > 1000 / READOUT_HZ) {
          lastReadoutMs = nowMs;
          const o = state.obs;
          values.motorPos.textContent = o.motorPos.toFixed(2);
          values.sinTheta.textContent = o.sinTheta.toFixed(3);
          values.cosTheta.textContent = o.cosTheta.toFixed(3);
          values.motorVel.textContent = o.motorVel.toFixed(2);
          values.penVel.textContent = o.penVel.toFixed(2);
          values.action.textContent = state.action.toFixed(2);
        }
      }
      for (const p of Object.values(plots)) p.draw();
    }

    renderer.render();
    requestAnimationFrame(frame);
  }

  // Load on approach and pause when scrolled away: this is a landing page, and
  // there is no reason to burn a visitor's battery — or 2.4 MB of their
  // bandwidth — on a pendulum they never scroll to.
  const io = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.isIntersecting) {
        void ensureLive().catch(() => {});
        if (!running) {
          running = true;
          lastFrameMs = performance.now();
          requestAnimationFrame(frame);
        }
      } else {
        running = false;
      }
    }
  });
  io.observe(canvas);

  status.textContent = '';
  root.dataset.ready = 'true';
  requestAnimationFrame(frame);
}
