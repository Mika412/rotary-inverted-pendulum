/**
 * The page: DOM in, scene out.
 *
 * `mountAssembly` binds the rendered step list to the scene and the clock. It
 * owns the things that are neither geometry nor animation — which step is
 * current, the prev/next buttons, the step rail, the URL hash, the keyboard,
 * the see-through toggle, the callout labels projected back into HTML — and
 * hands everything else to `animate.ts`.
 *
 * The camera never teleports: every move starts from wherever the camera
 * actually is, including wherever the reader last dragged it, so interrupting a
 * transition leaves it where the current frame put it rather than snapping to
 * the pose the last step was heading for.
 */
import {
  CAMERA_LEAD_MS,
  CAMERA_MS,
  GHOST_MS,
  cameraTrack,
  fadeFor,
  ghostFor,
  partTracks,
} from './animate.ts';
import { Harness } from './harness.ts';
import {
  applyPartColors,
  BENCH,
  boundsOf,
  loadParts,
  paint,
  place,
  type PartHandle,
} from './parts.ts';
import { getColors, subscribe } from '../theme/partColors.ts';
import { Stage } from './scene.ts';
import { shell } from './rig.ts';
import { ASSEMBLY_STEPS } from './steps.ts';
import {
  DEFAULT_CAMERA,
  snapshot,
  stateAt,
  type Callout,
  type CameraPose,
  type CameraSpec,
  type SceneState,
} from './state.ts';
import { Timeline, duration, prefersReducedMotion, tween, type Track } from './animate.ts';
import { Box3, Vector3 } from 'three';

/**
 * Steps crossed before a transition counts as a jump.
 *
 * A jump flies wide first and ghosts the enclosure, so the parts landing inside
 * it are watchable; flying straight to a close-up plays the cascade off-frame.
 */
const JUMP_THRESHOLD = 2;


interface Marker {
  el: HTMLElement;
  part: PartHandle;
}

class Annotations {
  private markers = new Map<string, Marker>();

  constructor(private readonly layer: HTMLElement) {}

  set(callouts: Callout[], parts: Map<string, PartHandle>): void {
    const wanted = new Map<string, Callout>();
    for (const callout of callouts) {
      if (parts.has(callout.part)) wanted.set(`${callout.part}:${callout.text}`, callout);
    }

    for (const [key, marker] of this.markers) {
      if (wanted.has(key)) continue;
      marker.el.remove();
      this.markers.delete(key);
    }

    for (const [key, callout] of wanted) {
      if (this.markers.has(key)) continue;
      const el = document.createElement('div');
      el.className = 'rig__callout';
      el.innerHTML =
        '<span class="rig__callout-dot"></span><span class="rig__callout-text"></span>';
      el.querySelector('.rig__callout-text')!.textContent = callout.text;
      this.layer.appendChild(el);
      requestAnimationFrame(() => el.classList.add('is-shown'));
      this.markers.set(key, { el, part: parts.get(callout.part)! });
    }
  }

  update(stage: Stage): void {
    const width = this.layer.clientWidth || 1;
    for (const { el, part } of this.markers.values()) {
      const { x, y, inFront } = stage.project(part.centre);
      const visible = inFront && part.fade > 0.05;
      el.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      el.style.visibility = visible ? 'visible' : 'hidden';
      el.classList.toggle('is-flipped', x > width * 0.55);
    }
  }

  clear(): void {
    for (const { el } of this.markers.values()) el.remove();
    this.markers.clear();
  }
}

export async function mountAssembly(root: HTMLElement): Promise<void> {
  const canvas = root.querySelector<HTMLCanvasElement>('[data-canvas]');
  if (!canvas) throw new Error('assembly: no canvas');

  const status = root.querySelector<HTMLElement>('[data-status]');
  const overlay = root.querySelector<HTMLElement>('[data-overlay]');
  const stepEls = Array.from(root.querySelectorAll<HTMLElement>('[data-step]'));
  const prev = root.querySelector<HTMLButtonElement>('[data-prev]');
  const next = root.querySelector<HTMLButtonElement>('[data-next]');
  const counter = root.querySelector<HTMLElement>('[data-counter]');
  const progress = root.querySelector<HTMLElement>('[data-progress]');
  const ghostToggle = root.querySelector<HTMLInputElement>('[data-ghost-toggle]');
  const followToggle = root.querySelector<HTMLInputElement>('[data-follow-toggle]');
  const tocLinks = Array.from(
    document.querySelectorAll<HTMLAnchorElement>('[data-toc-step]')
  );

  root.dataset.hydrated = 'true';

  const baseUrl = root.dataset.baseUrl ?? '/';
  const annotations = new Annotations(overlay ?? root);
  const stage = new Stage(canvas, () => draw());
  const harness = new Harness();

  const draw = () => {
    stage.render();
    annotations.update(stage);
  };

  const { parts, assembly, vendor } = await loadParts(baseUrl, stage.root);
  harness.build(parts, assembly, vendor);
  stage.add(harness.group);
  if (status) status.textContent = '';

  const order = new Map<string, number>();
  ASSEMBLY_STEPS.forEach((_, i) => {
    for (const id of stateAt(ASSEMBLY_STEPS, i).visible) {
      if (!order.has(id)) order.set(id, i);
    }
  });

  const timeline = new Timeline(draw, prefersReducedMotion());

  let index = 0;
  let seeThrough = ghostToggle ? ghostToggle.checked : true;
  let follow = followToggle ? followToggle.checked : true;
  let lastHash = location.hash;

  const view = (i: number): SceneState => {
    const state = stateAt(ASSEMBLY_STEPS, i);
    if (seeThrough) return state;
    const plain = snapshot(state);
    plain.ghosted.clear();
    return plain;
  };

  const handlesIn = (state: SceneState): PartHandle[] =>
    [...state.visible]
      .map((id) => parts.get(id))
      .filter((p): p is PartHandle => Boolean(p));

  const boundsIn = (state: SceneState): Box3 => boundsOf(handlesIn(state));

  const resolvePose = (spec: CameraSpec, state: SceneState): CameraPose => {
    const yaw = spec.yaw ?? DEFAULT_CAMERA.yaw;
    const pitch = spec.pitch ?? DEFAULT_CAMERA.pitch;
    if (spec.wide) return stage.overviewPose(boundsIn(state), yaw, pitch);

    const target = { ...DEFAULT_CAMERA.target };
    let distance = DEFAULT_CAMERA.distance;
    const part = spec.focus ? parts.get(spec.focus) : undefined;
    if (part) {
      if (state.benched.has(part.id)) {
        // `centre` is world space and `benchPath` is the parent's, so the two
        // can only be added directly when the parent is unrotated — which the
        // arm no longer is. The path ends at the bench, and the bench is BENCH.
        target.x = part.centre.x + BENCH.x;
        target.y = part.centre.y + BENCH.y;
        target.z = part.centre.z + BENCH.z;
      } else {
        target.x = part.centre.x;
        target.y = part.centre.y;
        target.z = part.centre.z;
      }
      distance = stage.fitPart(part.bounds, spec.fill ?? 0.5);
    }
    if (spec.target) {
      target.x = spec.target[0];
      target.y = spec.target[1];
      target.z = spec.target[2];
    }
    if (spec.offset) {
      target.x += spec.offset[0];
      target.y += spec.offset[1];
      target.z += spec.offset[2];
    }
    return { yaw, pitch, distance, target };
  };

  const settle = (state: SceneState, pose: CameraPose | null): void => {
    for (const [id, part] of parts) {
      part.fade = fadeFor(state, id);
      part.ghost = ghostFor(state, id);
      part.glow = state.highlighted.has(id) ? 1 : 0;
      part.offset = state.offsets.get(id) ?? 0;
      part.spin = state.spins.get(id) ?? 0;
      part.benched = state.benched.has(id) ? 1 : 0;
      place(part);
      paint(part);
    }
    harness.apply(state);
    if (pose) stage.applyPose(pose);
    annotations.set(state.callouts, parts);
    draw();
  };

  const paintChrome = (): void => {
    const step = ASSEMBLY_STEPS[index];
    for (const [n, el] of stepEls.entries()) {
      el.classList.toggle('is-current', n === index);
    }
    for (const [n, link] of tocLinks.entries()) {
      if (n === index) link.setAttribute('aria-current', 'step');
      else link.removeAttribute('aria-current');
    }
    if (counter) counter.textContent = `${index + 1} / ${ASSEMBLY_STEPS.length}`;
    if (progress) {
      progress.style.setProperty(
        '--progress',
        `${(index / (ASSEMBLY_STEPS.length - 1)) * 100}%`
      );
    }
    if (prev) prev.disabled = index === 0;
    if (next) next.disabled = index === ASSEMBLY_STEPS.length - 1;

    const hash = `#step-${step.id}`;
    if (location.hash !== hash) history.replaceState(null, '', hash);
    lastHash = hash;
  };

  const go = (target: number, animate: boolean): void => {
    const previous = index;
    index = Math.max(0, Math.min(ASSEMBLY_STEPS.length - 1, target));
    const crossed = Math.abs(index - previous);
    const from = view(previous);
    const to = view(index);

    timeline.interrupt();
    paintChrome();

    if (!animate) {
      settle(to, follow ? resolvePose(ASSEMBLY_STEPS[index].camera ?? {}, to) : null);
      return;
    }

    const isJump = crossed >= JUMP_THRESHOLD;
    const startDelay = isJump && follow ? CAMERA_LEAD_MS : 0;
    const during = isJump && seeThrough ? withSeeThroughShell(to) : to;

    const tracks: Track[] = partTracks({
      from,
      to: during,
      parts,
      order,
      crossed,
      startDelay,
    });
    const cascadeEnd = duration(tracks);

    if (during !== to) {
      for (const id of shell.parts) {
        const part = parts.get(id);
        if (!part || !to.visible.has(id)) continue;
        tracks.push(
          tween(
            ghostFor(during, id),
            ghostFor(to, id),
            (v) => {
              part.ghost = v;
              paint(part);
            },
            { at: cascadeEnd, dur: GHOST_MS }
          )
        );
      }
    }

    tracks.push(...harness.tracks(to, startDelay));

    if (follow) {
      const apply = (pose: CameraPose) => stage.applyPose(pose);
      const final = resolvePose(ASSEMBLY_STEPS[index].camera ?? {}, to);
      if (isJump) {
        const wide = stage.overviewPose(
          boundsIn(to),
          final.yaw,
          Math.max(0.2, final.pitch)
        );
        tracks.push(cameraTrack(stage.pose, wide, apply, { dur: CAMERA_MS }));
        tracks.push(cameraTrack(wide, final, apply, { at: cascadeEnd, dur: CAMERA_MS }));
      } else {
        tracks.push(cameraTrack(stage.pose, final, apply, { dur: CAMERA_MS }));
      }
    }

    annotations.set(to.callouts, parts);
    timeline.play(tracks);
  };

  prev?.addEventListener('click', () => go(index - 1, true));
  next?.addEventListener('click', () => go(index + 1, true));

  for (const [n, link] of tocLinks.entries()) {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      go(n, true);
    });
  }

  window.addEventListener('hashchange', () => {
    if (location.hash === lastHash) return;
    const n = ASSEMBLY_STEPS.findIndex((s) => `#step-${s.id}` === location.hash);
    if (n >= 0) go(n, true);
  });

  root.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowRight') {
      go(index + 1, true);
      e.preventDefault();
    } else if (e.key === 'ArrowLeft') {
      go(index - 1, true);
      e.preventDefault();
    }
  });

  ghostToggle?.addEventListener('change', () => {
    seeThrough = ghostToggle.checked;
    const state = view(index);
    const tracks: Track[] = [];
    for (const [id, part] of parts) {
      const want = ghostFor(state, id);
      if (Math.abs(part.ghost - want) < 1e-3) continue;
      tracks.push(
        tween(
          part.ghost,
          want,
          (v) => {
            part.ghost = v;
            paint(part);
          },
          { dur: GHOST_MS }
        )
      );
    }
    timeline.play(tracks);
  });

  followToggle?.addEventListener('change', () => {
    follow = followToggle.checked;
    if (!follow) return;
    const state = view(index);
    const final = resolvePose(ASSEMBLY_STEPS[index].camera ?? {}, state);
    timeline.play([
      cameraTrack(stage.pose, final, (pose) => stage.applyPose(pose), {
        dur: CAMERA_MS,
      }),
    ]);
  });

  const card = root.querySelector<HTMLElement>('.rig__card');
  const rail = root.querySelector<HTMLElement>('.rig__rail');

  const reframe = (): void => {
    const stageBox = canvas.getBoundingClientRect();
    const cardBox = card?.getBoundingClientRect();
    const railBox = rail?.offsetParent ? rail.getBoundingClientRect() : null;

    let left = 0;
    let right = stageBox.width;
    let top = 0;
    let bottom = stageBox.height;

    if (cardBox) {
      if (cardBox.width < stageBox.width * 0.6) left = cardBox.right - stageBox.left;
      else bottom = cardBox.top - stageBox.top;
    }
    if (railBox) right = railBox.left - stageBox.left;

    stage.setClearRegion(left, Math.max(left + 1, right), top, Math.max(top + 1, bottom));
  };

  applyPartColors(parts, getColors());
  draw();
  const unsubscribeColors = subscribe((colors) => {
    applyPartColors(parts, colors);
    draw();
  });

  const resize = new ResizeObserver(() => {
    stage.resize();
    reframe();
  });
  resize.observe(canvas);
  reframe();

  const fromHash = ASSEMBLY_STEPS.findIndex(
    (s) => `#step-${s.id}` === location.hash
  );
  index = fromHash >= 0 ? fromHash : 0;
  go(index, false);
  if (fromHash >= 0) root.scrollIntoView({ block: 'start', behavior: 'auto' });

  document.addEventListener(
    'astro:before-swap',
    () => {
      resize.disconnect();
      unsubscribeColors();
      timeline.dispose();
      annotations.clear();
      harness.dispose();
      stage.dispose();
    },
    { once: true }
  );


  root.dataset.ready = 'true';
}

function withSeeThroughShell(state: SceneState): SceneState {
  const copy = snapshot(state);
  for (const id of shell.parts) if (copy.visible.has(id)) copy.ghosted.add(id);
  return copy;
}
