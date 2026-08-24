/**
 * Motion: a generic clock, and what this viewer's transitions look like on it.
 *
 * `Timeline` knows nothing about the rig — it plays tracks, each a function of
 * a 0..1 parameter over a window. Everything below `partTracks` is where the
 * scene's own rules live: a part travels its runway and presses into its seat,
 * a departing one stays opaque until it has finished moving, and a skip
 * compresses through stagger rather than by making every part faster.
 */
import { paint, place, type PartHandle } from './parts.ts';
import type { CameraPose, SceneState } from './state.ts';

type Ease = (t: number) => number;

export interface Track {
  at: number;
  dur: number;
  ease: Ease;
  apply(k: number): void;
  hold?: boolean;
}

interface TrackOptions {
  at?: number;
  dur?: number;
  ease?: Ease;
  hold?: boolean;
}

const clamp01 = (t: number) => (t < 0 ? 0 : t > 1 ? 1 : t);

export const linear: Ease = (t) => t;
export const easeOut: Ease = (t) => 1 - (1 - t) ** 3;
const easeInOut: Ease = (t) =>
  t < 0.5 ? 4 * t ** 3 : 1 - (-2 * t + 2) ** 3 / 2;
/** For a part on its way out: it should still be moving when it is let go. */


const leaveOut: Ease = (t) => 1 - (1 - t) ** 2;

export const press =
  (overshoot: number): Ease =>
  (t) => {
    if (t >= 1) return 1;
    const settle = t > 0.8 ? Math.sin(((t - 0.8) / 0.2) * Math.PI) : 0;
    return easeOut(t) + settle * overshoot;
  };

export function track(
  apply: (k: number) => void,
  options: TrackOptions = {}
): Track {
  return {
    at: options.at ?? 0,
    dur: options.dur ?? 0,
    ease: options.ease ?? linear,
    hold: options.hold,
    apply,
  };
}

export function tween(
  from: number,
  to: number,
  set: (value: number) => void,
  options: TrackOptions = {}
): Track {
  if (from === to) return track(() => set(to), { ...options, dur: 0 });
  return track((k) => set(from + (to - from) * k), options);
}

export function duration(tracks: Track[]): number {
  return tracks.reduce((longest, t) => Math.max(longest, t.at + t.dur), 0);
}

export function prefersReducedMotion(): boolean {
  return (
    typeof matchMedia === 'function' &&
    matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

export class Timeline {
  private tracks: Track[] = [];
  private span = 0;
  private startedAt = 0;
  private frame = 0;
  private done: (() => void) | null = null;
  private readonly onFrame: () => void;
  private readonly instant: boolean;

  constructor(onFrame: () => void, instant = false) {
    this.onFrame = onFrame;
    this.instant = instant;
  }

  get running(): boolean {
    return this.frame !== 0;
  }

  load(tracks: Track[]): void {
    this.interrupt();
    this.tracks = tracks;
    this.span = duration(tracks);
    this.done = null;
  }

  play(tracks: Track[], done?: () => void): void {
    this.load(tracks);
    this.done = done ?? null;
    if (this.instant || this.span <= 0) {
      this.complete();
      return;
    }
    this.startedAt = performance.now();
    this.seek(0);
    this.frame = requestAnimationFrame(this.step);
  }

  seek(ms: number): void {
    for (const t of this.tracks) {
      t.apply(t.ease(t.dur <= 0 ? 1 : clamp01((ms - t.at) / t.dur)));
    }
    this.onFrame();
  }

  interrupt(): void {
    this.stopFrame();
    if (!this.tracks.length) return;
    for (const t of this.tracks) if (!t.hold) t.apply(t.ease(1));
    this.onFrame();
    this.clear();
  }

  dispose(): void {
    this.stopFrame();
    this.clear();
  }

  private step = (now: number): void => {
    const elapsed = now - this.startedAt;
    if (elapsed >= this.span) {
      this.frame = 0;
      this.complete();
      return;
    }
    this.seek(elapsed);
    this.frame = requestAnimationFrame(this.step);
  };

  private complete(): void {
    this.seek(this.span);
    const done = this.done;
    this.clear();
    done?.();
  }

  private clear(): void {
    this.tracks = [];
    this.span = 0;
    this.done = null;
  }

  private stopFrame(): void {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }
}

// --- what this app's transitions look like ----------------------------------

/** How long one part takes to travel its runway and seat. */
const STEP_DURATION_MS = 560;
/** The gap between parts when several land in the same step. */
const STEP_STAGGER_MS = 130;
/** The whole of a multi-step jump, however many parts it cascades. */
const SKIP_BUDGET_MS = 2400;
/** Floor on one part's own travel in a skip: below this it reads as a jump cut. */
const SKIP_MIN_DURATION_MS = 380;
export const CAMERA_MS = 620;
export const CAMERA_LEAD_MS = 380;
/** Fading a part in or out, and lifting a highlight. */
const FADE_MS = 260;
export const GHOST_MS = 320;

/** How far a press-fit overshoots its seat, as a fraction of its runway. */
const SETTLE_FRACTION = 0.05;
/**
 * Absolute cap on that overshoot. The whole rig is 87 mm across, so a long
 * runway would otherwise turn a 5 % settle into a part visibly punching through
 * its own seat.
 */
const SETTLE_MAX_M = 0.002;

interface Pace {
  duration: number;
  stagger: number;
}

export function pace(moving: number, crossed: number): Pace {
  const spread = moving * STEP_STAGGER_MS + STEP_DURATION_MS;
  if (crossed > 1 || spread > SKIP_BUDGET_MS) {
    const duration = Math.max(SKIP_MIN_DURATION_MS, SKIP_BUDGET_MS * 0.32);
    const stagger =
      moving > 1 ? Math.max(70, (SKIP_BUDGET_MS - duration) / (moving - 1)) : 0;
    return { duration, stagger };
  }
  return { duration: STEP_DURATION_MS, stagger: STEP_STAGGER_MS };
}

export function fadeFor(state: SceneState, id: string): number {
  return state.visible.has(id) ? 1 : 0;
}

export function ghostFor(state: SceneState, id: string): number {
  return state.visible.has(id) && state.ghosted.has(id) ? 1 : 0;
}

function overshootFor(part: PartHandle): number {
  if (part.runway <= 0) return 0;
  return Math.min(SETTLE_FRACTION, SETTLE_MAX_M / part.runway);
}

const write = (part: PartHandle, key: 'fade' | 'ghost' | 'glow') =>
  (value: number) => {
    part[key] = value;
    paint(part);
  };

const moveTo = (part: PartHandle, key: 'offset' | 'spin' | 'benched') =>
  (value: number) => {
    part[key] = value;
    place(part);
  };

interface PartTracksInput {
  from: SceneState;
  to: SceneState;
  parts: Map<string, PartHandle>;
  order: Map<string, number>;
  crossed: number;
  startDelay?: number;
}

export function partTracks(input: PartTracksInput): Track[] {
  const { from, to, parts, order, crossed, startDelay = 0 } = input;
  const rank = (id: string) => order.get(id) ?? 0;
  const resolve = (ids: string[]): PartHandle[] =>
    ids.map((id) => parts.get(id)).filter((p): p is PartHandle => Boolean(p));

  const arriving = resolve(
    [...to.visible].filter((id) => !from.visible.has(id)).sort((a, b) => rank(a) - rank(b))
  );
  const leaving = resolve(
    [...from.visible].filter((id) => !to.visible.has(id)).sort((a, b) => rank(b) - rank(a))
  );

  const { duration, stagger } = pace(arriving.length + leaving.length, crossed);
  const tracks: Track[] = [];
  let slot = 0;

  for (const part of leaving) {
    const at = startDelay + slot * stagger;
    slot += 1;
    tracks.push(
      tween(part.offset, 1, moveTo(part, 'offset'), {
        at,
        dur: duration,
        ease: leaveOut,
      })
    );
    tracks.push(
      tween(part.fade, 0, write(part, 'fade'), { at: at + duration, dur: FADE_MS })
    );
    if (part.glow) {
      tracks.push(tween(part.glow, 0, write(part, 'glow'), { at, dur: FADE_MS }));
    }
  }

  for (const part of arriving) {
    const at = startDelay + slot * stagger;
    slot += 1;
    part.offset = 1;
    part.fade = 1;
    part.benched = to.benched.has(part.id) ? 1 : 0;
    part.ghost = ghostFor(to, part.id);
    part.glow = to.highlighted.has(part.id) ? 1 : 0;
    place(part);
    paint(part);
    tracks.push(
      tween(1, 0, moveTo(part, 'offset'), {
        at,
        dur: duration,
        ease: press(overshootFor(part)),
      })
    );
  }

  const settled = new Set([...arriving, ...leaving].map((p) => p.id));
  for (const [id, part] of parts) {
    if (settled.has(id)) continue;

    const wantFade = fadeFor(to, id);
    if (Math.abs(part.fade - wantFade) > 1e-3) {
      tracks.push(
        tween(part.fade, wantFade, write(part, 'fade'), { at: startDelay, dur: FADE_MS })
      );
    }

    const wantGhost = ghostFor(to, id);
    if (Math.abs(part.ghost - wantGhost) > 1e-3) {
      tracks.push(
        tween(part.ghost, wantGhost, write(part, 'ghost'), {
          at: startDelay,
          dur: GHOST_MS,
          ease: easeInOut,
        })
      );
    }

    const wantGlow = to.highlighted.has(id) ? 1 : 0;
    if (Math.abs(part.glow - wantGlow) > 1e-3) {
      tracks.push(
        tween(part.glow, wantGlow, write(part, 'glow'), { at: startDelay, dur: FADE_MS })
      );
    }

    const wantOffset = to.offsets.get(id) ?? 0;
    if (Math.abs(part.offset - wantOffset) > 1e-4) {
      tracks.push(
        tween(part.offset, wantOffset, moveTo(part, 'offset'), {
          at: startDelay,
          dur: duration,
          ease: easeInOut,
        })
      );
    }

    const wantBench = to.benched.has(id) ? 1 : 0;
    if (Math.abs(part.benched - wantBench) > 1e-4) {
      tracks.push(
        tween(part.benched, wantBench, moveTo(part, 'benched'), {
          at: startDelay,
          dur: duration,
          ease: easeInOut,
        })
      );
    }

    const wantSpin = to.spins.get(id) ?? 0;
    if (Math.abs(part.spin - wantSpin) > 1e-4) {
      tracks.push(
        tween(part.spin, wantSpin, moveTo(part, 'spin'), {
          at: startDelay,
          dur: duration,
          ease: easeInOut,
        })
      );
    }
  }

  return tracks;
}

function lerpAngle(a: number, b: number, k: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * k;
}

function interpolatePose(
  from: CameraPose,
  to: CameraPose,
  k: number
): CameraPose {
  const lerp = (a: number, b: number) => a + (b - a) * k;
  return {
    yaw: lerpAngle(from.yaw, to.yaw, k),
    pitch: lerp(from.pitch, to.pitch),
    distance: lerp(from.distance, to.distance),
    target: {
      x: lerp(from.target.x, to.target.x),
      y: lerp(from.target.y, to.target.y),
      z: lerp(from.target.z, to.target.z),
    },
  };
}

export function cameraTrack(
  from: CameraPose,
  to: CameraPose,
  apply: (pose: CameraPose) => void,
  options: { at?: number; dur?: number } = {}
): Track {
  return track((k) => apply(interpolatePose(from, to, k)), {
    at: options.at ?? 0,
    dur: options.dur ?? CAMERA_MS,
    ease: easeInOut,
    hold: true,
  });
}
