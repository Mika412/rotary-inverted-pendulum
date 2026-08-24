/**
 * A fixed-target orbit camera: yaw, pitch, zoom, and nothing else.
 *
 * Shared by the landing-page demo and the assembly tutorial. Both frame one
 * small object on a canvas whose aspect ratio the page decides, and neither
 * wants OrbitControls — panning and roll would only let a visitor lose the rig.
 *
 * The pointer gesture is deliberately overloadable. In the demo a drag that
 * starts on the pendulum pushes it instead of orbiting, so `claimPointer` gets
 * first refusal on every press; return true and the orbit stays out of the way
 * for the rest of that gesture.
 */

import type { PerspectiveCamera } from 'three';

export interface OrbitLimits {
  minPitch: number;
  maxPitch: number;
  minDistance: number;
  maxDistance: number;
}

export interface OrbitOptions extends Partial<OrbitLimits> {
  yaw?: number;
  pitch?: number;
  distance?: number;
  target?: { x: number; y: number; z: number };
  /** Canvas aspect the framing was tuned against. See `fitScale`. */
  designAspect?: number;
  /** Ceiling on the narrow-canvas pull-back. */
  maxFitPullback?: number;
  /** Redraw request — the camera never renders anything itself. */
  onChange: () => void;
  /** First refusal on a press. Return true to take the gesture. */
  claimPointer?: (e: PointerEvent) => boolean;
  /** Called for each move of a claimed gesture. */
  onClaimedMove?: (e: PointerEvent) => void;
  /** Called when a claimed gesture ends. */
  onClaimedEnd?: () => void;
  /** Called on hover while no gesture is active, for cursor affordances. */
  onHover?: (e: PointerEvent) => void;
  /** Vertical field of view in degrees, used to scale panning to the zoom. */
  fovDeg?: number;
  /** Allow the target to be dragged around. Off for the landing-page demo,
   *  where the rig is the only subject and panning can only lose it. */
  pannable?: boolean;
}

const DEFAULTS: OrbitLimits & {
  designAspect: number;
  maxFitPullback: number;
} = {
  minPitch: -0.25,
  maxPitch: 1.4,
  minDistance: 0.16,
  maxDistance: 0.9,
  designAspect: 2,
  /**
   * Holding the horizontal field exactly constant would back off 2.2x on a
   * portrait canvas, leaving the rig a small object in a large empty panel — it
   * is taller than it is wide, so preserving width buys nothing but margin.
   */
  maxFitPullback: 1.3,
};

export class OrbitCamera {
  yaw: number;
  pitch: number;
  distance: number;
  readonly target: { x: number; y: number; z: number };

  private readonly limits: OrbitLimits;
  private readonly designAspect: number;
  private readonly maxFitPullback: number;
  private readonly opts: OrbitOptions;

  /**
   * Extra pull-back for canvases narrower than `designAspect`. `fov` is the
   * *vertical* field of view, so a narrow canvas keeps the same world height and
   * simply shows less width — which on a phone crops the subject. Backing off by
   * the shortfall holds the horizontal field constant instead. Wide canvases
   * get 1, unchanged.
   */
  private fitScale = 1;
  private detach: (() => void) | null = null;
  /** Canvas height in CSS pixels, for converting a drag into world units. */
  private viewportHeight = 1;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    options: OrbitOptions
  ) {
    this.opts = options;
    this.yaw = options.yaw ?? 0.9;
    this.pitch = options.pitch ?? 0.28;
    this.distance = options.distance ?? 0.36;
    this.target = { ...(options.target ?? { x: 0, y: 0, z: 0 }) };
    this.limits = {
      minPitch: options.minPitch ?? DEFAULTS.minPitch,
      maxPitch: options.maxPitch ?? DEFAULTS.maxPitch,
      minDistance: options.minDistance ?? DEFAULTS.minDistance,
      maxDistance: options.maxDistance ?? DEFAULTS.maxDistance,
    };
    this.designAspect = options.designAspect ?? DEFAULTS.designAspect;
    this.maxFitPullback = options.maxFitPullback ?? DEFAULTS.maxFitPullback;
    this.attach();
  }

  /** Point a camera at the target from the current yaw/pitch/distance. */
  applyTo(camera: PerspectiveCamera): void {
    const cp = Math.cos(this.pitch);
    const d = this.distance * this.fitScale;
    camera.position.set(
      this.target.x + d * cp * Math.cos(this.yaw),
      this.target.y + d * cp * Math.sin(this.yaw),
      this.target.z + d * Math.sin(this.pitch)
    );
    camera.lookAt(this.target.x, this.target.y, this.target.z);
  }

  /** Recompute the narrow-canvas pull-back. Call from the renderer's resize. */
  fit(aspect: number, heightPx?: number): void {
    this.fitScale = Math.min(
      this.maxFitPullback,
      Math.max(1, this.designAspect / aspect)
    );
    if (heightPx) this.viewportHeight = heightPx;
  }

  /**
   * Slide the target sideways and up/down, in the plane facing the camera.
   *
   * Scaled by the current distance and field of view, so a drag moves whatever
   * is under the pointer by roughly that many pixels however far out you are.
   */
  pan(dxPx: number, dyPx: number): void {
    const d = this.distance * this.fitScale;
    const worldPerPx =
      (2 * d * Math.tan(((this.opts.fovDeg ?? 38) * Math.PI) / 360)) /
      this.viewportHeight;

    // Camera basis from yaw/pitch, the same convention `applyTo` uses.
    const cp = Math.cos(this.pitch);
    const fx = -cp * Math.cos(this.yaw);
    const fy = -cp * Math.sin(this.yaw);
    const fz = -Math.sin(this.pitch);

    // right = normalize(forward × worldUp), worldUp = +z, so it stays horizontal.
    const rl = Math.hypot(fy, -fx) || 1;
    const rx = fy / rl;
    const ry = -fx / rl;

    // up = right × forward.
    const ux = ry * fz;
    const uy = -rx * fz;
    const uz = rx * fy - ry * fx;

    // Drag right and the scene follows the pointer, so the target goes left.
    const kx = -dxPx * worldPerPx;
    const ky = dyPx * worldPerPx;
    this.target.x += rx * kx + ux * ky;
    this.target.y += ry * kx + uy * ky;
    this.target.z += uz * ky;
    this.opts.onChange();
  }

  /** Move the camera somewhere specific — used to frame each assembly step. */
  set(pose: { yaw?: number; pitch?: number; distance?: number; target?: { x: number; y: number; z: number } }): void {
    if (pose.yaw !== undefined) this.yaw = pose.yaw;
    if (pose.pitch !== undefined) {
      this.pitch = clamp(pose.pitch, this.limits.minPitch, this.limits.maxPitch);
    }
    if (pose.distance !== undefined) {
      this.distance = clamp(
        pose.distance,
        this.limits.minDistance,
        this.limits.maxDistance
      );
    }
    if (pose.target) Object.assign(this.target, pose.target);
    this.opts.onChange();
  }

  private attach(): void {
    let orbiting = false;
    let panning = false;
    let claimed = false;
    let lastX = 0;
    let lastY = 0;

    // Right button, middle button or shift — the three conventions a 3D viewer
    // is expected to accept for panning.
    const wantsPan = (e: PointerEvent) =>
      Boolean(this.opts.pannable) && (e.button === 1 || e.button === 2 || e.shiftKey);

    const down = (e: PointerEvent) => {
      this.canvas.setPointerCapture(e.pointerId);
      if (wantsPan(e)) {
        panning = true;
        lastX = e.clientX;
        lastY = e.clientY;
        this.canvas.style.cursor = 'move';
        e.preventDefault();
        return;
      }
      if (this.opts.claimPointer?.(e)) {
        claimed = true;
        return;
      }
      orbiting = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };

    const move = (e: PointerEvent) => {
      if (claimed) {
        this.opts.onClaimedMove?.(e);
        return;
      }
      if (panning) {
        this.pan(e.clientX - lastX, e.clientY - lastY);
        lastX = e.clientX;
        lastY = e.clientY;
        return;
      }
      if (!orbiting) {
        this.opts.onHover?.(e);
        return;
      }
      this.yaw -= (e.clientX - lastX) * 0.008;
      this.pitch = clamp(
        this.pitch + (e.clientY - lastY) * 0.006,
        this.limits.minPitch,
        this.limits.maxPitch
      );
      lastX = e.clientX;
      lastY = e.clientY;
      this.opts.onChange();
    };

    const up = (e: PointerEvent) => {
      orbiting = false;
      if (panning) {
        panning = false;
        this.canvas.style.cursor = 'default';
      }
      if (claimed) {
        claimed = false;
        this.opts.onClaimedEnd?.();
      }
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    };

    // Right-dragging must not open the context menu mid-pan.
    const context = (e: Event) => {
      if (this.opts.pannable) e.preventDefault();
    };
    this.canvas.addEventListener('contextmenu', context);

    const wheel = (e: WheelEvent) => {
      // Only claim the wheel gesture while zooming actually does something, so
      // the page still scrolls normally at the zoom limits.
      const next = clamp(
        this.distance + e.deltaY * 0.0005,
        this.limits.minDistance,
        this.limits.maxDistance
      );
      if (next !== this.distance) {
        e.preventDefault();
        this.distance = next;
        this.opts.onChange();
      }
    };

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener('wheel', wheel, { passive: false });

    this.detach = () => {
      this.canvas.removeEventListener('contextmenu', context);
      this.canvas.removeEventListener('pointerdown', down);
      this.canvas.removeEventListener('pointermove', move);
      this.canvas.removeEventListener('pointerup', up);
      this.canvas.removeEventListener('pointercancel', up);
      this.canvas.removeEventListener('wheel', wheel);
    };
  }

  dispose(): void {
    this.detach?.();
    this.detach = null;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
