/**
 * Every part in the scene, as something that can be placed, painted and moved.
 *
 * `loadParts` reads the three manifests the build scripts publish, builds the
 * frame graph they describe, loads a mesh for each part and hands back a
 * `PartHandle` per part: where it is seated, which way it is offered up, how far
 * out its runway starts, and the path it travels if it is carried in from the
 * bench. Everything after that — the choreography, the wiring, the framing —
 * works in terms of those handles and never touches a manifest again.
 *
 * `place` and `paint` are the only two functions that write to a part. Motion
 * sets fields on the handle and calls `place`; anything to do with how it looks
 * sets fields and calls `paint`. Keeping them apart is what stops a part that is
 * fading in from being confused with one that is deliberately see-through.
 */
import {
  Box3,
  CatmullRomCurve3,
  Color,
  FrontSide,
  Group,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  Quaternion,
  type Texture,
  Vector3,
} from 'three';
import type { AssemblyManifest, SceneManifest, VendorManifest } from './manifests.ts';
import { PLACEMENT } from './config/placement.ts';
import { PRINTED } from './config/printed.ts';
import { VENDOR } from './config/vendor.ts';
import {
  PART_GROUPS,
  TUTORIAL_FINISH,
  colorOf,
  type PartColors,
  type PartGroup,
} from '../theme/partColors.ts';

/**
 * How far out a part starts, as a multiple of its measured approach offset.
 *
 * The measurements are a few centimetres, which at these framings just makes a
 * part appear and shuffle. Scaling along the *same* measured axis keeps the
 * direction honest while letting the part read as brought in and fitted.
 */
const RUNWAY = 2.6;

/**
 * Where a sub-assembly is built before it goes in. The board is populated on the
 * bench beside the enclosure and lowered in as one piece, which is how it is
 * actually done — you cannot solder headers at the bottom of a closed box.
 */
export const BENCH = new Vector3(0.108, 0.012, -0.0072);

/**
 * World height the travelling sub-assembly is carried at. Everything on the rig
 * is below this, so a part crossing between the bench and its seat goes up, over
 * and down rather than straight through the enclosure wall — which is both what
 * you physically do and the only path that never intersects anything.
 */
export const CARRY_Z = 0.135;

/**
 * The arc a benched sub-assembly travels along on its way in: up clear of
 * everything on the rig, across, and down into its seat.
 *
 * A straight interpolation from the bench drags the board sideways through the
 * enclosure wall, which is both wrong and impossible. Expressed here as a pure
 * function of the seat height so it can be checked without a renderer — a
 * headless browser rendering in software gets three frames through a transition
 * this long, which is not enough to sample the apex of anything.
 *
 * Returned in the part's own parent frame, hence `intoParent`.
 */
function carryPath(
  seatedWorldZ: number,
  benchLocal: Vector3,
  intoParent: Quaternion
): CatmullRomCurve3 {
  const climb = Math.max(0.012, CARRY_Z - seatedWorldZ);
  const overSeat = new Vector3(0, 0, climb).applyQuaternion(intoParent.clone());
  const overBench = benchLocal.clone().add(overSeat);
  return new CatmullRomCurve3(
    [new Vector3(0, 0, 0), overSeat, overBench, benchLocal],
    false,
    'catmullrom',
    0.0
  );
}

/** Emissive strength of a highlighted part. */
const GLOW_STRENGTH = 0.6;

export interface PartHandle {
  id: string;
  group: Group;
  /**
   * The loaded model inside `group`, which already carries whatever turn the
   * mesh is drawn at — so this is the frame every measurement of this part is
   * written in. Routing resolves features through it, which is what stopped
   * that quarter turn being re-derived by hand wherever it was needed.
   */
  meshFrame: Object3D;
  seated: Vector3;
  approach: Vector3;
  axis: Vector3;
  runway: number;
  benchPath: CatmullRomCurve3;
  centre: Vector3;
  bounds: Box3;
  materials: PartMaterial[];
  meshes: Object3D[];
  label: string;
  approximate: boolean;
  fade: number;
  ghost: number;
  glow: number;
  offset: number;
  spin: number;
  benched: number;
}

const carry = new Vector3();

export function place(part: PartHandle): void {
  const k = part.offset * RUNWAY;
  if (part.benched > 0.0001) part.benchPath.getPoint(part.benched, carry);
  else carry.set(0, 0, 0);
  part.group.position.set(
    part.seated.x + part.approach.x * k + carry.x,
    part.seated.y + part.approach.y * k + carry.y,
    part.seated.z + part.approach.z * k + carry.z
  );
  if (part.spin) part.group.quaternion.setFromAxisAngle(part.axis, part.spin);
  else part.group.quaternion.identity();
}

export function paint(part: PartHandle): void {
  part.group.visible = part.fade > 0.004;
  const clear = part.ghost <= 0.001 && part.fade >= 0.999;
  for (const m of part.materials) {
    applyGlass(m, part.ghost, part.fade);
    m.emissiveIntensity = part.glow * GLOW_STRENGTH;
  }
  const order = clear ? 0 : GHOST_RENDER_ORDER;
  for (const mesh of part.meshes) mesh.renderOrder = order;
}

/**
 * Apply the reader's chosen colours. Only `.color` is written, so ghosting,
 * highlighting and every animation channel are untouched — `paint()` never
 * reads or writes colour, and an override therefore survives every step.
 */
export function applyPartColors(
  parts: Map<string, PartHandle>,
  colors: PartColors
): void {
  for (const [group, meshes] of Object.entries(PART_GROUPS) as [PartGroup, string[]][]) {
    for (const mesh of meshes) {
      const part = parts.get(mesh);
      if (!part) continue;
      const override = colors[group];
      const fallback = TUTORIAL_FINISH[mesh]?.color;
      for (const material of part.materials) {
        if (override) material.color.set(override);
        else if (fallback !== undefined) material.color.setHex(fallback);
      }
    }
  }
}

export function boundsOf(parts: Iterable<PartHandle>): Box3 {
  const box = new Box3();
  for (const part of parts) box.union(part.bounds);
  return box;
}

interface LoadedScene {
  parts: Map<string, PartHandle>;
  assembly: AssemblyManifest;
  vendor: VendorManifest;
  /** Joint frames, so the harness can route through a part's own coordinates. */
  frames: Map<string, Group>;
}

export async function loadParts(
  baseUrl: string,
  root: Group
): Promise<LoadedScene> {
  // The three of these are plain config in `config/`, not fetched: there is
  // nothing about them a build step knows better than whoever is editing them.
  const scene = PRINTED;
  const assembly = PLACEMENT;
  const vendor = VENDOR;

  // `assembly.json` may seat a printed part somewhere other than the demo's
  // scene does — the arm rides the lid's wire boss, not the seam it shares with
  // the base — and that is committed data rather than something derived here.
  const seated = Object.fromEntries(
    Object.entries(scene.nodes).map(([name, node]) => [
      name,
      { ...node, position: assembly.nodePositionM?.[name] ?? node.position },
    ])
  );
  const frames = buildFrames(root, seated, assembly.frames ?? {});

  const parts = new Map<string, PartHandle>();
  const { createMeshLoader } = await import('../three/loader.ts');
  const loader = createMeshLoader(baseUrl, 2);
  const jobs: Promise<void>[] = [];

  const add = async (spec: {
    id: string;
    file: string;
    parent: Object3D;
    seated: Vector3;
    approach: Vector3;
    meshRotation?: [number, number, number];
    meshOffset?: [number, number, number];
    style?: { color: number; roughness: number; metalness: number };
    colour?: string;
    finish?: { roughness: number; metalness: number };
    label: string;
    approximate?: boolean;
  }): Promise<void> => {
    const asset = await loader.load(`${baseUrl}${spec.file}`);
    // A printed part is one colour the reader may override, so it gets one
    // material. A bought part keeps the materials its CAD was authored with.
    const flat = spec.style ??
      (spec.colour || spec.finish
        ? {
            color: new Color(spec.colour ?? '#8a8f98').getHex(),
            roughness: spec.finish?.roughness ?? 0.5,
            metalness: spec.finish?.metalness ?? 0.4,
          }
        : null);
    const override = colorOf(spec.id);
    const materials: PartMaterial[] = [];
    const bySource = new Map<MeshStandardMaterial, PartMaterial>();
    const adopt = (source: MeshStandardMaterial): PartMaterial => {
      let material = flat ? materials[0] : bySource.get(source);
      if (!material) {
        material = createPartMaterial(flat ?? styleOf(source));
        if (override) material.color.set(override);
        materials.push(material);
        bySource.set(source, material);
      }
      return material;
    };
    const meshes: Object3D[] = [];
    asset.traverse((child) => {
      const mesh = child as Mesh;
      if (!mesh.isMesh) return;
      const source = mesh.material as MeshStandardMaterial;
      mesh.material = adopt(source);
      source.dispose();
      meshes.push(child);
    });
    if (spec.meshOffset) asset.position.set(...spec.meshOffset);
    if (spec.meshRotation) asset.rotation.set(...spec.meshRotation);

    const group = new Group();
    group.position.copy(spec.seated);
    group.add(asset);
    group.visible = false;
    spec.parent.add(group);
    group.updateWorldMatrix(true, true);

    const approach = spec.approach.clone();
    const bounds = new Box3().setFromObject(group);
    const parentRotation = new Quaternion();
    spec.parent.getWorldQuaternion(parentRotation);
    const intoParent = parentRotation.invert();
    const benchLocal = BENCH.clone().applyQuaternion(intoParent.clone());

    const seatedWorld = new Vector3();
    group.getWorldPosition(seatedWorld);
    const benchPath = carryPath(seatedWorld.z, benchLocal, intoParent);
    parts.set(spec.id, {
      id: spec.id,
      group,
      meshFrame: asset,
      seated: spec.seated.clone(),
      approach,
      axis: approach.lengthSq() > 0 ? approach.clone().normalize() : new Vector3(0, 0, 1),
      runway: approach.length() * RUNWAY,
      benchPath,
      centre: bounds.getCenter(new Vector3()),
      bounds,
      materials,
      meshes,
      label: spec.label,
      approximate: Boolean(spec.approximate),
      fade: 0,
      ghost: 0,
      glow: 0,
      offset: 0,
      spin: 0,
      benched: 0,
    });
  };

  for (const [name, node] of Object.entries(scene.nodes)) {
    const file = node.mesh ? scene.meshes[node.mesh]?.file : undefined;
    if (!node.mesh || !file) throw new Error(`assembly: no mesh for node "${name}"`);
    jobs.push(
      add({
        id: name,
        file,
        parent: frames.get(name)!,
        seated: new Vector3(0, 0, 0),
        // Which way a printed part is offered up is a property of how it mates,
        // not of the renderer: the pendulum's boss slides along the hinge, the
        // rest drop in from above. `build_assembly` says which.
        approach: new Vector3(...(assembly.nodeApproachM?.[name] ?? [0, 0, 0.08])),
        meshRotation: node.meshRotationRad,
        meshOffset: node.meshOffset,
        style: TUTORIAL_FINISH[node.mesh],
        label: name,
      })
    );
  }

  for (const [id, part] of Object.entries(assembly.parts)) {
    const isPrinted = part.kind === 'printed';
    const file = isPrinted
      ? scene.meshes[part.mesh!]?.file
      : vendor.parts[part.model ?? id]?.file;
    if (!file) throw new Error(`assembly: no model for part "${id}"`);
    const spec = vendor.parts[part.model ?? id];
    const parent = part.parent ? frames.get(part.parent) : root;
    if (!parent) throw new Error(`assembly: part "${id}" wants missing parent`);
    jobs.push(
      add({
        id,
        file,
        parent,
        seated: new Vector3(...part.position),
        approach: new Vector3(...part.approach),
        meshRotation: part.meshRotationRad,
        style: isPrinted ? TUTORIAL_FINISH[part.mesh!] : undefined,
        colour: spec?.colour,
        finish: spec?.finish,
        label: spec?.label ?? id,
        approximate: Boolean(part.approximate ?? spec?.approximate),
      })
    );
  }

  await Promise.all(jobs);
  loader.dispose();
  for (const part of parts.values()) {
    place(part);
    paint(part);
  }
  return { parts, assembly, vendor, frames };
}

// --- the frame graph the parts hang off -------------------------------------

/**
 * The frame graph everything else is positioned in.
 *
 * Three kinds of frame live in one map, because a part does not care which kind
 * it is parented to:
 *
 *   - **joint frames**, from `scene.json` — the arm turns about one, the
 *     pendulum hangs off another. These carry a position and, for a joint, its
 *     rest angle.
 *   - **`enclosure`**, from `assembly.json` — the quarter turn the box's meshes
 *     are drawn at, so everything inside it is positioned in the base's own
 *     coordinates and inherits the turn instead of repeating it.
 *   - **`<name>-mesh`**, from `assembly.json` — a joint frame plus the turn its
 *     mesh is drawn at, so a point measured out of `<name>.stl` can be placed
 *     without anyone re-deriving that turn by hand.
 *
 * That last kind is the one rule this file exists to make true: **a measured
 * feature of part P resolves in `P-mesh`.** The alternative is what was here
 * before — the same quarter turn written out longhand as `[-y, x, z]`, once in
 * the Python that emits positions and again in the TypeScript that routed
 * wires, with nothing keeping the two copies honest.
 */

export interface FrameSpec {
  parent?: string | null;
  rotationRad: [number, number, number];
}

interface SceneNode {
  parent?: string | null;
  position: [number, number, number];
  rotationAxis?: 'x' | 'y' | 'z';
  angleOffsetRad?: number;
}

function buildFrames(
  root: Object3D,
  nodes: Record<string, SceneNode>,
  frames: Record<string, FrameSpec>
): Map<string, Group> {
  const built = new Map<string, Group>();

  const attach = (name: string, parent: string | null | undefined): Group => {
    const group = new Group();
    // A frame may name a parent declared after it. Resolving lazily would mean
    // ordering the JSON by hand and getting a silently detached subtree when
    // someone reorders it, so an unknown parent is an error instead.
    if (parent) {
      const under = built.get(parent);
      if (!under) throw new Error(`assembly: frame "${name}" wants missing parent "${parent}"`);
      under.add(group);
    } else {
      root.add(group);
    }
    built.set(name, group);
    return group;
  };

  // Joint frames first: the mesh frames below are children of these.
  for (const [name, node] of Object.entries(nodes)) {
    const group = attach(name, node.parent);
    group.position.set(...node.position);
    if (node.rotationAxis && node.angleOffsetRad) {
      group.rotation[node.rotationAxis] = node.angleOffsetRad;
    }
  }

  for (const [name, frame] of Object.entries(frames)) {
    attach(name, frame.parent).rotation.set(...frame.rotationRad);
  }

  return built;
}

// --- materials --------------------------------------------------------------

/** A cutaway part is a thin shell, not a fog. */
const GHOST_OPACITY = 0.2;
/** Ghosted parts draw last, so they do not paint over what they reveal. */
const GHOST_RENDER_ORDER = 10;

type PartMaterial = MeshStandardMaterial;

interface PartStyle {
  color: number;
  roughness: number;
  metalness: number;
  emissive?: number;
  map?: Texture | null;
}

function createPartMaterial(options: PartStyle): PartMaterial {
  const material = new MeshStandardMaterial({
    color: options.color,
    roughness: options.roughness,
    metalness: options.metalness,
    map: options.map ?? null,
    side: FrontSide,
  });
  material.emissive = new Color(options.emissive ?? 0xffc14d);
  material.emissiveIntensity = 0;
  return material;
}

/**
 * The style a loaded glTF material was authored with.
 *
 * The bought parts carry their own materials now — a motor is aluminium and a
 * dark stack, a board is green with gold pads — so the viewer reads them back
 * out rather than painting the whole part one colour. Everything downstream
 * (ghosting, highlighting, fading) works per material and already iterates a
 * list, so a part with six materials needs nothing else.
 */
function styleOf(source: MeshStandardMaterial): PartStyle {
  return {
    color: source.color?.getHex() ?? 0x8a8f98,
    roughness: source.roughness ?? 0.5,
    metalness: source.metalness ?? 0.4,
    map: source.map,
  };
}

function applyGlass(material: PartMaterial, ghost: number, fade: number): void {
  const solid = ghost <= 0.001;
  const glass = solid ? 1 : GHOST_OPACITY + (1 - GHOST_OPACITY) * (1 - ghost);
  const opacity = fade * glass;
  const clear = solid && fade >= 0.999;

  if (material.transparent === clear) {
    material.transparent = !clear;
    material.needsUpdate = true;
  }
  material.opacity = opacity;
  material.depthWrite = clear;
}
