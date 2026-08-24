/**
 * The stage the rig stands on: renderer, lights, camera rig and shadow.
 *
 * Kept apart from the viewer so that "what a three.js scene needs" and "what
 * this tutorial does with it" are separate problems. `Stage` knows about poses,
 * framing and the size of the canvas; it knows nothing about steps.
 *
 * Two of its choices are load-bearing and look odd without the reason. The room
 * environment is what makes a ghosted part read as a shell rather than vanish,
 * so the direct lights are held low instead of the environment being cut down.
 * And the projection is offset with `setViewOffset` so the rig sits in the part
 * of the canvas the step card does not cover — the frame is centred on what the
 * reader can actually see, not on the canvas.
 */
import {
  AmbientLight,
  Box3,
  CanvasTexture,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  PMREMGenerator,
  Scene,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { OrbitCamera } from '../three/orbit.ts';
import type { CameraPose } from './state.ts';

/** Matches the front-page demo, so the rig reads at the same scale on both. */
const FOV_DEG = 38;
/** Radius of the fake contact shadow under the rig, in metres. */
const SHADOW_SIZE = 0.26;

function shadowTexture(): CanvasTexture {
  const size = 256;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const gradient = ctx.createRadialGradient(
    size / 2,
    size / 2,
    0,
    size / 2,
    size / 2,
    size / 2
  );
  gradient.addColorStop(0, 'rgba(0,0,0,0.42)');
  gradient.addColorStop(0.45, 'rgba(0,0,0,0.20)');
  gradient.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  return new CanvasTexture(canvas);
}

interface FitOptions {
  fill: number;
  aspect: number;
  fovDeg: number;
  minRadius?: number;
  minDistance?: number;
  maxDistance?: number;
}

/** Closest the camera will fit to a subject, in metres. */
const DEFAULT_MIN = 0.045;
/** Furthest it will pull back, in metres. */
const DEFAULT_MAX = 0.9;

/**
 * Smallest subject the framing pretends to see. A 4 mm magnet fitted at its own
 * scale fills the frame with the enclosure wall behind it and teaches nothing —
 * every close-up needs a few centimetres of the rig around it to be locatable.
 */
const MIN_SUBJECT_RADIUS = 0.019;

function fitDistance(bounds: Box3, options: FitOptions): number {
  const size = bounds.getSize(new Vector3());
  const radius = Math.max(
    options.minRadius ?? MIN_SUBJECT_RADIUS,
    0.5 * Math.hypot(size.x, size.y, size.z)
  );

  const vFov = (options.fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * options.aspect);
  const tightest = Math.min(vFov, hFov);

  const fill = Math.min(0.95, Math.max(0.05, options.fill));
  const distance = radius / Math.tan((tightest / 2) * fill);

  return Math.min(
    options.maxDistance ?? DEFAULT_MAX,
    Math.max(options.minDistance ?? DEFAULT_MIN, distance)
  );
}

function forwardFrom(yaw: number, pitch: number): Vector3 {
  const cp = Math.cos(pitch);
  return new Vector3(
    -cp * Math.cos(yaw),
    -cp * Math.sin(yaw),
    -Math.sin(pitch)
  ).normalize();
}

function fitBoxDistance(
  bounds: Box3,
  yaw: number,
  pitch: number,
  options: { aspect: number; fovDeg: number; padding?: number }
): { distance: number; target: Vector3 } {
  const target = bounds.getCenter(new Vector3());
  const forward = forwardFrom(yaw, pitch);
  const worldUp = new Vector3(0, 0, 1);
  const right = new Vector3().crossVectors(forward, worldUp).normalize();
  const up = new Vector3().crossVectors(right, forward).normalize();

  const vFov = (options.fovDeg * Math.PI) / 180;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * options.aspect);

  let halfUp = 0;
  let halfRight = 0;
  let depth = 0;
  const corner = new Vector3();
  for (const x of [bounds.min.x, bounds.max.x]) {
    for (const y of [bounds.min.y, bounds.max.y]) {
      for (const z of [bounds.min.z, bounds.max.z]) {
        corner.set(x, y, z).sub(target);
        halfUp = Math.max(halfUp, Math.abs(corner.dot(up)));
        halfRight = Math.max(halfRight, Math.abs(corner.dot(right)));
        depth = Math.max(depth, Math.abs(corner.dot(forward)));
      }
    }
  }

  const distance =
    Math.max(halfUp / Math.tan(vFov / 2), halfRight / Math.tan(hFov / 2)) +
    depth * 0.5;

  return { distance: distance * (options.padding ?? 1.05), target };
}

export class Stage {
  readonly root = new Group();
  readonly orbit: OrbitCamera;

  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly shadow: Mesh;
  private disposed = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    onChange: () => void
  ) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(FOV_DEG, 1, 0.005, 10);
    this.camera.up.set(0, 0, 1);
    this.scene.add(this.root);

    // No tone mapping: ACES rolls highlights off, and a colour the reader picks
    // has to come back as that colour rather than a pastel of it.
    //
    // The room environment stays, though, and is not decoration. A ghosted part
    // is one thin translucent shell, so what makes it read as a shell at all is
    // being lit from every direction — cut the room down and the enclosure goes
    // black against a dark background and the cutaway stops working. The direct
    // lights are held low to keep the total exposure where albedo, not
    // brightness, decides what you see.
    const pmrem = new PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.85;
    pmrem.dispose();

    this.scene.add(new AmbientLight(0xffffff, 0.2));
    const key = new DirectionalLight(0xffffff, 0.9);
    key.position.set(0.25, -0.3, 0.45);
    this.scene.add(key);
    const rim = new DirectionalLight(0x88aaff, 0.35);
    rim.position.set(-0.3, 0.25, 0.2);
    this.scene.add(rim);

    this.shadow = new Mesh(
      new PlaneGeometry(SHADOW_SIZE, SHADOW_SIZE),
      new MeshBasicMaterial({
        map: shadowTexture(),
        transparent: true,
        depthWrite: false,
      })
    );
    this.shadow.position.set(0, 0, 0.0006);
    this.shadow.renderOrder = -1;
    this.root.add(this.shadow);

    this.orbit = new OrbitCamera(canvas, {
      distance: 0.34,
      pitch: 0.35,
      target: { x: 0, y: 0, z: 0.05 },
      minDistance: 0.08,
      maxDistance: 0.9,
      designAspect: 0.85,
      maxFitPullback: 1.2,
      pannable: true,
      fovDeg: FOV_DEG,
      onChange,
    });
    this.resize();
  }

  add(object: Object3D): void {
    this.root.add(object);
  }

  get pose(): CameraPose {
    return {
      yaw: this.orbit.yaw,
      pitch: this.orbit.pitch,
      distance: this.orbit.distance,
      target: { ...this.orbit.target },
    };
  }

  applyPose(pose: CameraPose): void {
    this.orbit.set(pose);
  }

  get aspect(): number {
    return this.camera.aspect;
  }

  readonly fovDeg = FOV_DEG;

  overviewPose(box: Box3, yaw: number, pitch: number): CameraPose {
    if (box.isEmpty()) {
      return { yaw, pitch, distance: 0.24, target: { x: 0, y: 0, z: 0.05 } };
    }
    const { distance, target } = fitBoxDistance(box, yaw, pitch, {
      aspect: this.camera.aspect,
      fovDeg: this.camera.fov,
      padding: 1.06,
    });
    return { yaw, pitch, distance, target: { x: target.x, y: target.y, z: target.z } };
  }

  fitPart(bounds: Box3, fill: number): number {
    return fitDistance(bounds, {
      fill,
      aspect: this.camera.aspect,
      fovDeg: this.camera.fov,
    });
  }

  project(point: Vector3): { x: number; y: number; inFront: boolean } {
    const ndc = point.clone().project(this.camera);
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (ndc.x * 0.5 + 0.5) * rect.width,
      y: (-ndc.y * 0.5 + 0.5) * rect.height,
      inFront: ndc.z < 1,
    };
  }

  /**
   * The rectangle of the canvas that nothing is covering, in CSS pixels from the
   * canvas's own top-left. The rig is centred on this rather than on the canvas,
   * so it never sits half behind the step card or the rail.
   */
  setClearRegion(left: number, right: number, top: number, bottom: number): void {
    this.clear = { left, right, top, bottom };
    this.resize();
  }

  private clear = { left: 0, right: 0, top: 0, bottom: 0 };

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);

    const shiftX = (this.clear.left + this.clear.right) / 2 - w / 2;
    const shiftY = (this.clear.top + this.clear.bottom) / 2 - h / 2;
    const dx = Math.min(Math.abs(shiftX), w * 0.35);
    const dy = Math.min(Math.abs(shiftY), h * 0.35);

    if (dx > 1 || dy > 1) {
      const fullW = w + 2 * dx;
      const fullH = h + 2 * dy;
      this.camera.aspect = fullW / fullH;
      this.camera.setViewOffset(
        fullW,
        fullH,
        shiftX > 0 ? 0 : 2 * dx,
        shiftY > 0 ? 0 : 2 * dy,
        w,
        h
      );
    } else {
      this.camera.aspect = w / h;
      this.camera.clearViewOffset();
    }

    this.orbit.fit(w / h, h);
    this.camera.updateProjectionMatrix();
    this.render();
  }

  render(): void {
    if (this.disposed) return;
    this.orbit.applyTo(this.camera);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    this.orbit.dispose();
    this.shadow.geometry.dispose();
    (this.shadow.material as MeshBasicMaterial).map?.dispose();
    (this.shadow.material as MeshBasicMaterial).dispose();
    this.renderer.dispose();
  }
}
