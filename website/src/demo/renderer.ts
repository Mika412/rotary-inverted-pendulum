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
  CylinderGeometry,
  DirectionalLight,
  Group,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  PerspectiveCamera,
  Plane,
  Quaternion,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Object3D,
} from 'three';
import { OrbitCamera } from '../three/orbit.ts';
import { createMeshLoader } from '../three/loader.ts';
import {
  DEMO_FINISH,
  PART_GROUPS,
  colorOf,
  defaultColors,
  type PartColors,
  type PartGroup,
} from '../theme/partColors.ts';
import type { SceneManifest } from '../assembly/manifests.ts';

// One declaration, shared with the build guide, which loads the same file.
export type { SceneManifest };

/** The demo's own finish, and the colours the picker resets to. */
const MATERIALS = DEMO_FINISH;
export const DEMO_PART_COLORS = defaultColors(DEMO_FINISH);

export interface RendererGrabDelegate {
  /** Called with the world-space hit point; return false to decline the grab
   *  (and let the gesture orbit the camera instead). */
  tryGrab(p: [number, number, number]): boolean;
  drag(p: [number, number, number]): void;
  release(): void;
}



/** Radius of the drag rod, in metres — the rig's base is 87 mm across. */
const DRAG_ROD_RADIUS = 0.0016;
/** MuJoCo's own drag connector is a saturated red; matching it is the point. */
const DRAG_COLOR = 0xdd2222;
/** The axis the drag rod's geometry is laid out along. */
const UP_Y = new Vector3(0, 1, 0);

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
  /** One material per mesh name, kept so the colour picker can reach them. */
  private readonly partMaterials = new Map<string, MeshStandardMaterial>();
  private readonly axes = new Map<Object3D, 'x' | 'y' | 'z'>();
  private disposed = false;

  /**
   * Orbit, zoom and the narrow-canvas fit all live in OrbitCamera, which the
   * assembly tutorial shares. Framed to hold the whole rig: the enclosure top is
   * at z≈0.07 and the pendulum tip reaches z≈0.15 when upright, so the target
   * sits between them.
   */
  private readonly orbit: OrbitCamera;

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
  /**
   * The applied force, drawn the way MuJoCo's own viewer draws it: a rod from
   * the held point on the body out to the pointer, with a ball at the pointer
   * end. An arrowhead was the earlier choice, but a cone reads as a *direction*
   * when what this actually shows is a connection — you are dragging a point on
   * the body toward the cursor, and the rod's length is the displacement the
   * spring is working against.
   *
   * Two meshes: a unit-height cylinder stretched along its own +y, and a ball at
   * the pointer end. Only the cylinder is ever scaled, so the ball stays
   * spherical and the rod's radius is constant whatever the length. The far end
   * is left flat because it sits against the body it is pulling, where a cap
   * would not be visible.
   *
   * MJCF's `fromto` expresses a capsule like this in one attribute, and
   * `build_mjcf` uses it for the sim's own capsules — but that is an MJCF
   * attribute drawn by MuJoCo's visualiser, and here MuJoCo is only the physics;
   * three.js draws the scene. `CapsuleGeometry` is no help either, since its
   * caps belong to the same mesh and stretching one to the drag length squashes
   * them into ellipsoids.
   */
  private readonly dragForce = new Group();
  private readonly dragRod = new Mesh(
    new CylinderGeometry(DRAG_ROD_RADIUS, DRAG_ROD_RADIUS, 1, 12),
    new MeshBasicMaterial({ color: DRAG_COLOR, transparent: true, opacity: 0.9 })
  );
  private readonly dragBall = new Mesh(
    new SphereGeometry(DRAG_ROD_RADIUS * 2.4, 16, 12),
    new MeshBasicMaterial({ color: DRAG_COLOR, transparent: true, opacity: 0.9 })
  );
  private readonly dragQuat = new Quaternion();
  /** Set by the demo to claim a drag that starts on a grabbable body. */
  private grabDelegate: RendererGrabDelegate | null = null;
  /**
   * Visual-minus-physics offset for the grabbable body. The MJCF has no
   * enclosure, so its bodies sit 84 mm below the meshes the pointer actually
   * hits. Without correcting for it, the point handed to `grab()` is not on the
   * body at all: MuJoCo stores it as a body-frame offset, which then swings
   * through empty space as the pendulum rotates — and applies the drag force at
   * the wrong lever arm.
   */
  private readonly grabOffset = new Vector3();

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
    // The rod's own geometry runs along +y, centred; both pieces are placed in
    // the group's local +y so the group only has to be aimed and stretched.
    // Laid out along the group's +y, positioned per drag in setDragArrow.
    this.dragForce.add(this.dragRod, this.dragBall);
    this.dragForce.visible = false;
    this.scene.add(this.dragForce);

    this.scene.add(new AmbientLight(0xffffff, 0.55));
    const key = new DirectionalLight(0xffffff, 2.1);
    key.position.set(0.25, -0.3, 0.45);
    this.scene.add(key);
    const rim = new DirectionalLight(0x88aaff, 0.7);
    rim.position.set(-0.3, 0.25, 0.2);
    this.scene.add(rim);

    this.baseUrl = baseUrl;
    this.orbit = new OrbitCamera(canvas, {
      target: { x: 0.01, y: 0, z: 0.105 },
      onChange: () => this.render(),
      // A drag that starts ON a body disturbs it; anywhere else orbits. One
      // gesture, disambiguated by what is under the pointer — so the demo needs
      // no modifier key and works the same under touch.
      claimPointer: (e) => {
        const hit = this.grabDelegate
          ? this.pickPendulum(e.clientX, e.clientY)
          : null;
        if (hit && this.grabDelegate!.tryGrab(hit)) {
          this.canvas.style.cursor = 'grabbing';
          return true;
        }
        return false;
      },
      onClaimedMove: (e) => {
        const p = this.pointerOnDragPlane(e.clientX, e.clientY);
        if (p) this.grabDelegate!.drag(p);
      },
      onClaimedEnd: () => {
        this.grabDelegate?.release();
        this.canvas.style.cursor = 'default';
      },
      onHover: (e) => {
        // Cursor affordance: dragging the pendulum is not otherwise discoverable.
        if (!this.grabDelegate) return;
        this.canvas.style.cursor = this.pickPendulum(e.clientX, e.clientY)
          ? 'grab'
          : 'default';
      },
    });
    this.resize();
  }

  private baseUrl: string;

  async load(): Promise<void> {
    const manifestUrl = `${this.baseUrl}sim/scene.json`;
    const res = await fetch(manifestUrl);
    if (!res.ok) throw new Error(`renderer: ${manifestUrl} → HTTP ${res.status}`);
    const manifest = (await res.json()) as SceneManifest;

    const loader = createMeshLoader(this.baseUrl);

    const groups = new Map<string, Group>();
    for (const name of Object.keys(manifest.nodes)) groups.set(name, new Group());

    // Parent first, so a child's transform composes with its parent's.
    for (const [name, node] of Object.entries(manifest.nodes)) {
      const group = groups.get(name)!;
      const parent = node.parent ? groups.get(node.parent) : undefined;
      (parent ?? this.root).add(group);
      group.position.set(...node.position);

      if (node.joint === 'motor' || node.joint === 'pendulum') {
        this.joints[node.joint].push(group);
        this.axes.set(group, node.rotationAxis ?? 'z');
        this.offsets.set(group, node.angleOffsetRad ?? 0);
      }
    }

    await Promise.all(
      Object.entries(manifest.nodes).map(async ([name, node]) => {
        const mesh = node.mesh;
        const file = mesh ? manifest.meshes[mesh]?.file : undefined;
        if (!mesh || !file) throw new Error(`renderer: no mesh entry for node "${name}"`);
        const scene = await loader.load(`${this.baseUrl}${file}`);
        const style = MATERIALS[mesh] ?? { color: 0x888888, roughness: 0.7, metalness: 0.1 };
        const material = new MeshStandardMaterial(style);
        const override = colorOf(mesh);
        if (override) material.color.set(override);
        this.partMaterials.set(mesh, material);
        scene.traverse((child) => {
          if ((child as Mesh).isMesh) (child as Mesh).material = material;
        });
        // Applied to the mesh, not the group: the group's origin IS the pivot
        // and its axes ARE the joint's, so the mesh is slid and turned within
        // it until the part's own bore and axis coincide with them.
        if (node.meshOffset) scene.position.set(...node.meshOffset);
        if (node.meshRotationRad) scene.rotation.set(...node.meshRotationRad);
        groups.get(name)!.add(scene);
        if (name === 'pendulum') {
          this.grabGroup = groups.get(name)!;
          if (node.physicsOffsetM) this.grabOffset.set(...node.physicsOffsetM);
        }
      })
    );

    loader.dispose();
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
   * Hit-test the pendulum. Returns the hit point in *physics* coordinates, or
   * null if the pointer missed — which is what lets the same gesture orbit the
   * camera everywhere else.
   *
   * Everything this class hands the grab delegate is in MuJoCo's frame, and
   * everything it is handed back is too, so the controller never has to know the
   * renderer stands the rig on an enclosure the physics model does not have.
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
    return this.toPhysics(p);
  }

  /** Visual world point -> physics world point. */
  private toPhysics(p: Vector3): [number, number, number] {
    return [p.x - this.grabOffset.x, p.y - this.grabOffset.y, p.z - this.grabOffset.z];
  }

  /** Where the pointer now sits on the plane frozen at grab time. */
  pointerOnDragPlane(clientX: number, clientY: number): [number, number, number] | null {
    this.raycaster.setFromCamera(this.toNdc(clientX, clientY), this.camera);
    const hit = this.raycaster.ray.intersectPlane(this.dragPlane, this.scratch);
    return hit ? this.toPhysics(hit) : null;
  }

  /**
   * Draw the force being applied: rod from the held point on the pendulum out to
   * the pointer, ball at the pointer end. Hidden when `ends` is null.
   */
  setDragArrow(
    ends: { from: [number, number, number]; to: [number, number, number] } | null
  ): void {
    if (!ends) {
      this.dragForce.visible = false;
      return;
    }
    const tail = this.scratch.set(...ends.from).add(this.grabOffset);
    const dir = this.scratch2.set(...ends.to).add(this.grabOffset).sub(tail);
    const len = dir.length();
    // Shorter than the ball itself, the rod is just a smear at the grab point.
    if (len < DRAG_ROD_RADIUS * 2) {
      this.dragForce.visible = false;
      return;
    }
    this.dragForce.position.copy(tail);
    // Aim the group's +y — the axis both pieces are laid out along — down the
    // vector to the pointer, then stretch only that axis to its length.
    this.dragQuat.setFromUnitVectors(UP_Y, dir.normalize());
    this.dragForce.quaternion.copy(this.dragQuat);
    // The length lives on the rod alone — the group is never scaled, so the ball
    // needs no inverse scale to stay round.
    this.dragRod.scale.set(1, len, 1);
    this.dragRod.position.set(0, len / 2, 0);
    this.dragBall.position.set(0, len, 0);
    this.dragForce.visible = true;
  }

  resize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.orbit.fit(this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.render();
  }

  /**
   * Recolour a group of parts. Only `.color` is touched, so nothing about the
   * lighting, the sim or the frame loop is disturbed — and because the demo
   * stops rendering when scrolled out of view, this repaints once itself.
   */
  applyPartColors(colors: PartColors, defaults: Record<string, number>): void {
    for (const [group, meshes] of Object.entries(PART_GROUPS) as [PartGroup, string[]][]) {
      for (const mesh of meshes) {
        const material = this.partMaterials.get(mesh);
        if (!material) continue;
        const override = colors[group];
        if (override) material.color.set(override);
        else if (defaults[mesh] !== undefined) material.color.setHex(defaults[mesh]);
      }
    }
    this.render();
  }

  setBackground(color: string | null): void {
    this.scene.background = color ? new Color(color) : null;
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
    this.renderer.dispose();
  }
}
