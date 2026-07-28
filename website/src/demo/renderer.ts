/**
 * three.js rendering of the rig, using the actual printable meshes.
 *
 * The transform chain comes from public/sim/scene.json, which is generated from
 * the MJCF rather than the URDF — see build_scene() in scripts/export_assets.py
 * for why the URDF cannot be trusted for visual placement.
 */

import {
  AmbientLight,
  ArrowHelper,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

export interface RendererGrabDelegate {
  /** Called with the world-space hit point; return false to decline the grab
   *  (and let the gesture orbit the camera instead). */
  tryGrab(p: [number, number, number]): boolean;
  drag(p: [number, number, number]): void;
  release(): void;
}

export interface SceneManifest {
  armLengthM: number;
  baseTopZ: number;
  nodes: Record<
    string,
    {
      mesh: string;
      parent: string | null;
      position: [number, number, number];
      /** Shifts the mesh inside its joint group so its bore sits on the pivot. */
      meshOffset?: [number, number, number];
      /** Turns the mesh inside its joint group so the part's own pivot axis
       *  lands on that group's hinge. Intrinsic XYZ, radians. */
      meshRotationRad?: [number, number, number];
      rotationAxis?: 'x' | 'y' | 'z';
      joint?: 'motor' | 'pendulum';
      angleOffsetRad?: number;
    }
  >;
  meshes: Record<string, { file: string }>;
}

const MATERIALS: Record<string, { color: number; roughness: number; metalness: number }> = {
  // Printed PLA: matte, no specular highlight to speak of.
  base: { color: 0x2f3542, roughness: 0.85, metalness: 0.05 },
  lid: { color: 0x3d4454, roughness: 0.85, metalness: 0.05 },
  arm: { color: 0x4a90d9, roughness: 0.6, metalness: 0.1 },
  pendulum: { color: 0xe8503a, roughness: 0.5, metalness: 0.15 },
};

/** The canvas aspect the camera framing below was tuned against. */
const DESIGN_ASPECT = 2;

/**
 * Ceiling on the narrow-canvas pull-back. Holding the horizontal field exactly
 * constant would back off 2.2x on a portrait canvas, which leaves the rig a
 * small object in a large empty panel — the rig is taller than it is wide, so
 * preserving width buys nothing but margin. This is enough to clear the bottom
 * of the enclosure, which is the part that was being cut.
 */
const MAX_FIT_PULLBACK = 1.3;

export class PendulumRenderer {
  private readonly renderer: WebGLRenderer;
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private readonly root = new Group();
  private readonly joints: { motor: Object3D[]; pendulum: Object3D[] } = {
    motor: [],
    pendulum: [],
  };
  private readonly offsets = new Map<Object3D, number>();
  private readonly axes = new Map<Object3D, 'x' | 'y' | 'z'>();
  private manifest?: SceneManifest;
  private disposed = false;

  // Orbit state — a few lines of pointer maths beats pulling in OrbitControls
  // for a fixed-target camera that only needs yaw, pitch and zoom.
  // Framed to hold the whole rig: the enclosure top is at z≈0.07 and the
  // pendulum tip reaches z≈0.15 when upright, so the target sits between them.
  private yaw = 0.9;
  private pitch = 0.28;
  private distance = 0.36;
  /**
   * Extra pull-back for canvases narrower than DESIGN_ASPECT. `fov` is the
   * *vertical* field of view, so a narrow canvas keeps the same world height and
   * simply shows less width — which on a phone crops the enclosure. Backing off
   * by the shortfall holds the horizontal field constant instead, so the whole
   * rig stays in frame at any width. Wide canvases get 1, unchanged.
   */
  private fitScale = 1;
  private readonly target = { x: 0.01, y: 0, z: 0.105 };

  // Drag-to-disturb. The plane is rebuilt at grab time so the pointer maps to
  // world space sensibly from whatever angle the camera happens to be at.
  /** The pendulum group — the only body a pointer may push. The arm is held by
   *  a stiff position servo and cannot meaningfully be moved by a force. */
  private grabGroup: Object3D | null = null;
  private readonly raycaster = new Raycaster();
  private readonly dragPlane = new Plane();
  private readonly ndc = new Vector2();
  private readonly scratch = new Vector3();
  private readonly scratch2 = new Vector3();
  /** The drag arrow, as in zalo's mujoco_wasm demo: you should be able to see
   *  the force you are applying, not just its effect. */
  private readonly dragArrow = new ArrowHelper(
    new Vector3(0, 1, 0),
    new Vector3(),
    0.05,
    0xff5533
  );
  /** Set by the demo to claim a drag that starts on a grabbable body. */
  private grabDelegate: RendererGrabDelegate | null = null;

  constructor(private readonly canvas: HTMLCanvasElement, baseUrl: string) {
    this.renderer = new WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new Scene();
    this.camera = new PerspectiveCamera(38, 1, 0.01, 10);

    // Z-up, matching the MJCF and the URDF.
    this.camera.up.set(0, 0, 1);
    this.scene.add(this.root);
    this.dragArrow.visible = false;
    for (const m of [this.dragArrow.line.material, this.dragArrow.cone.material]) {
      (m as { transparent: boolean; opacity: number }).transparent = true;
      (m as { transparent: boolean; opacity: number }).opacity = 0.85;
    }
    this.scene.add(this.dragArrow);

    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(0.25, -0.3, 0.45);
    this.scene.add(key);
    const rim = new DirectionalLight(0x88aaff, 0.7);
    rim.position.set(-0.3, 0.25, 0.2);
    this.scene.add(rim);

    this.baseUrl = baseUrl;
    this.attachPointerControls();
    this.resize();
  }

  private baseUrl: string;

  async load(): Promise<void> {
    const manifestUrl = `${this.baseUrl}sim/scene.json`;
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`renderer: ${manifestUrl} → HTTP ${res.status}`);
    const manifest = (await res.json()) as SceneManifest;
    this.manifest = manifest;

    const draco = new DRACOLoader();
    // Self-hosted decoder: a strict-CSP static host cannot reach a CDN.
    draco.setDecoderPath(`${this.baseUrl}draco/`);
    // Four meshes, so one worker is enough; DRACOLoader has no main-thread
    // mode (a limit of 0 makes it dereference a worker it never created).
    draco.setWorkerLimit(1);
    const gltf = new GLTFLoader();
    gltf.setDRACOLoader(draco);

    const groups = new Map<string, Group>();
    for (const name of Object.keys(manifest.nodes)) groups.set(name, new Group());

    // Parent first, so a child's transform composes with its parent's.
    for (const [name, node] of Object.entries(manifest.nodes)) {
      const group = groups.get(name)!;
      const parent = node.parent ? groups.get(node.parent) : undefined;
      (parent ?? this.root).add(group);
      group.position.set(...node.position);

      if (node.joint) {
        this.joints[node.joint].push(group);
        this.axes.set(group, node.rotationAxis ?? 'z');
        this.offsets.set(group, node.angleOffsetRad ?? 0);
      }
    }

    await Promise.all(
      Object.entries(manifest.nodes).map(async ([name, node]) => {
        const file = manifest.meshes[node.mesh]?.file;
        if (!file) throw new Error(`renderer: no mesh entry for node "${name}"`);
        const asset = await gltf.loadAsync(`${this.baseUrl}${file}`);
        const style = MATERIALS[node.mesh] ?? { color: 0x888888, roughness: 0.7, metalness: 0.1 };
        const material = new MeshStandardMaterial(style);
        asset.scene.traverse((child) => {
          if ((child as Mesh).isMesh) (child as Mesh).material = material;
        });
        // Applied to the mesh, not the group: the group's origin IS the pivot
        // and its axes ARE the joint's, so the mesh is slid and turned within
        // it until the part's own bore and axis coincide with them.
        if (node.meshOffset) asset.scene.position.set(...node.meshOffset);
        if (node.meshRotationRad) asset.scene.rotation.set(...node.meshRotationRad);
        groups.get(name)!.add(asset.scene);
        if (name === 'pendulum') this.grabGroup = groups.get(name)!;
      })
    );

    draco.dispose();
    this.render();
  }

  /** Pose the rig from joint angles, in radians. */
  setJointAngles(motorRad: number, pendulumRad: number): void {
    for (const g of this.joints.motor) this.applyAngle(g, motorRad);
    for (const g of this.joints.pendulum) this.applyAngle(g, pendulumRad);
  }

  private applyAngle(group: Object3D, angle: number): void {
    const axis = this.axes.get(group) ?? 'z';
    const total = angle + (this.offsets.get(group) ?? 0);
    group.rotation.set(0, 0, 0);
    group.rotation[axis] = total;
  }

  setGrabDelegate(d: RendererGrabDelegate | null): void {
    this.grabDelegate = d;
  }

  private attachPointerControls(): void {
    let dragging = false;
    let grabbing = false;
    let lastX = 0;
    let lastY = 0;

    const down = (e: PointerEvent) => {
      this.canvas.setPointerCapture(e.pointerId);
      // A drag that starts ON a body disturbs it; anywhere else orbits. One
      // gesture, disambiguated by what is under the pointer — so the demo
      // needs no modifier key and works the same under touch.
      const hit = this.grabDelegate
        ? this.pickPendulum(e.clientX, e.clientY)
        : null;
      if (hit && this.grabDelegate!.tryGrab(hit)) {
        grabbing = true;
        this.canvas.style.cursor = 'grabbing';
        return;
      }
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const move = (e: PointerEvent) => {
      if (grabbing) {
        const p = this.pointerOnDragPlane(e.clientX, e.clientY);
        if (p) this.grabDelegate!.drag(p);
        return;
      }
      if (!dragging) {
        // Cursor affordance: dragging the pendulum is not otherwise discoverable.
        if (this.grabDelegate) {
          this.canvas.style.cursor = this.pickPendulum(e.clientX, e.clientY)
            ? 'grab'
            : 'default';
        }
        return;
      }
      this.yaw -= (e.clientX - lastX) * 0.008;
      this.pitch = Math.max(
        -0.25,
        Math.min(1.4, this.pitch + (e.clientY - lastY) * 0.006)
      );
      lastX = e.clientX;
      lastY = e.clientY;
      this.render();
    };
    const up = (e: PointerEvent) => {
      dragging = false;
      if (grabbing) {
        grabbing = false;
        this.grabDelegate?.release();
        this.canvas.style.cursor = 'default';
      }
      if (this.canvas.hasPointerCapture(e.pointerId)) {
        this.canvas.releasePointerCapture(e.pointerId);
      }
    };

    this.canvas.addEventListener('pointerdown', down);
    this.canvas.addEventListener('pointermove', move);
    this.canvas.addEventListener('pointerup', up);
    this.canvas.addEventListener('pointercancel', up);
    this.canvas.addEventListener(
      'wheel',
      (e) => {
        // Only claim the wheel gesture while zooming actually does something,
        // so the page still scrolls normally at the zoom limits.
        const next = Math.max(0.16, Math.min(0.9, this.distance + e.deltaY * 0.0005));
        if (next !== this.distance) {
          e.preventDefault();
          this.distance = next;
          this.render();
        }
      },
      { passive: false }
    );
  }

  /** Screen point → NDC, shared by the pick and the drag. */
  private toNdc(clientX: number, clientY: number): Vector2 {
    const r = this.canvas.getBoundingClientRect();
    return this.ndc.set(
      ((clientX - r.left) / r.width) * 2 - 1,
      -((clientY - r.top) / r.height) * 2 + 1
    );
  }

  /**
   * Hit-test the grabbable bodies. Returns the hit body and world point, or null if
   * the pointer missed — which is what lets the same gesture orbit the camera
   * everywhere else.
   */
  /**
   * Hit-test the pendulum. Returns the world-space hit point, or null if the
   * pointer missed — which is what lets the same gesture orbit the camera
   * everywhere else.
   */
  pickPendulum(clientX: number, clientY: number): [number, number, number] | null {
    if (!this.grabGroup) return null;
    this.raycaster.setFromCamera(this.toNdc(clientX, clientY), this.camera);
    const hits = this.raycaster.intersectObject(this.grabGroup, true);
    if (!hits.length) return null;
    const p = hits[0].point;
    // Freeze a camera-facing plane through the hit so the drag stays under the
    // pointer regardless of orbit angle.
    this.dragPlane.setFromNormalAndCoplanarPoint(
      this.camera.getWorldDirection(this.scratch).clone().negate(),
      p
    );
    return [p.x, p.y, p.z];
  }

  /** Where the pointer now sits on the plane frozen at grab time. */
  pointerOnDragPlane(clientX: number, clientY: number): [number, number, number] | null {
    this.raycaster.setFromCamera(this.toNdc(clientX, clientY), this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, this.scratch);
    return hit ? [hit.x, hit.y, hit.z] : null;
  }

  /**
   * Draw the force being applied: tail at the held point on the pendulum, head
   * at the pointer. Hidden when `ends` is null.
   */
  setDragArrow(
    ends: { from: [number, number, number]; to: [number, number, number] } | null
  ): void {
    if (!ends) {
      this.dragArrow.visible = false;
      return;
    }
    const tail = this.scratch.set(...ends.from);
    const dir = this.scratch2.set(...ends.to).sub(tail);
    const len = dir.length();
    // Below a pixel or two the cone renders as noise at the grab point.
    if (len < 1e-3) {
      this.dragArrow.visible = false;
      return;
    }
    this.dragArrow.position.copy(tail);
    this.dragArrow.setDirection(dir.normalize());
    this.dragArrow.setLength(len, Math.min(0.02, len * 0.35), 0.008);
    this.dragArrow.visible = true;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.fitScale = Math.min(MAX_FIT_PULLBACK, Math.max(1, DESIGN_ASPECT / this.camera.aspect));
    this.camera.updateProjectionMatrix();
    this.render();
  }

  setBackground(color: string | null): void {
    this.scene.background = color ? new Color(color) : null;
    this.render();
  }

  render(): void {
    if (this.disposed) return;
    const cp = Math.cos(this.pitch);
    const d = this.distance * this.fitScale;
    this.camera.position.set(
      this.target.x + d * cp * Math.cos(this.yaw),
      this.target.y + d * cp * Math.sin(this.yaw),
      this.target.z + d * Math.sin(this.pitch)
    );
    this.camera.lookAt(this.target.x, this.target.y, this.target.z);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }
}
