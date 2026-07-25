/**
 * three.js rendering of the rig, using the actual printable meshes.
 *
 * The transform chain comes from public/sim/scene.json, which is generated from
 * the MJCF rather than the URDF — see build_scene() in scripts/export_assets.py
 * for why the URDF cannot be trusted for visual placement.
 */

import {
  AmbientLight,
  Color,
  DirectionalLight,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  Scene,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';

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
  private readonly target = { x: 0.01, y: 0, z: 0.105 };

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
        // Applied to the mesh, not the group: the group's origin IS the pivot,
        // so the mesh slides within it until its bore coincides with that pivot.
        if (node.meshOffset) asset.scene.position.set(...node.meshOffset);
        groups.get(name)!.add(asset.scene);
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

  private attachPointerControls(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;

    const down = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      this.canvas.setPointerCapture(e.pointerId);
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
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

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
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
    this.camera.position.set(
      this.target.x + this.distance * cp * Math.cos(this.yaw),
      this.target.y + this.distance * cp * Math.sin(this.yaw),
      this.target.z + this.distance * Math.sin(this.pitch)
    );
    this.camera.lookAt(this.target.x, this.target.y, this.target.z);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.disposed = true;
    this.renderer.dispose();
  }
}
