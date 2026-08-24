/**
 * Every declared cable, as tube geometry that draws itself on.
 *
 * Three jobs, in order: turn each waypoint into a world position, string those
 * into a curve, and sweep a tube along it. There is no routing anywhere here —
 * a route already says where it goes.
 */
import {
  Curve,
  CurvePath,
  Group,
  LineCurve3,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  QuadraticBezierCurve3,
  Quaternion,
  CatmullRomCurve3,
  TubeGeometry,
  Vector3,
} from 'three';
import { rig } from './rig.ts';
import {
  CLEAR,
  cable,
  routeId,
  touches,
  LOOSE_RADIUS_M,
  type Bend,
  type Cable,
  type Loom,
  type Point,
  type Route,
  type Section,
  type Span,
  type Side,
  type Trace,
} from './wires.ts';
import type { AssemblyManifest, VendorManifest } from './manifests.ts';
import { NETLIST } from './config/netlist.ts';
import type { PartHandle } from './parts.ts';
import type { SceneState } from './state.ts';
import { easeOut, tween, type Track } from './animate.ts';

/** Below this, two waypoints are the same point and the leg between them is noise. */
const EPS = 1e-9;
/** Tube segments along a plain run. Enough that a filleted corner reads round. */
const SEGMENTS = 96;
/** How long a cable takes to draw itself on, end to end. */
const WIRE_DRAW_MS = 420;
/** The gap between cables when a step turns several on at once. */
const WIRE_STAGGER_MS = 70;

// --- turning waypoints into positions ---------------------------------------

const AXIS: Record<Side, [number, number]> = {
  '+x': [0, 1],
  '-x': [0, -1],
  '+y': [1, 1],
  '-y': [1, -1],
  '+z': [2, 1],
  '-z': [2, -1],
};

export interface Frames {
  parts: Map<string, PartHandle>;
  assembly: AssemblyManifest;
  vendor: VendorManifest;
}

class Resolver {
  private readonly ctx: Frames;
  /** Whose route is being resolved, so a failure says which one. */
  private where = '';

  constructor(ctx: Frames) {
    this.ctx = ctx;
  }

  for<T>(routeId: string, fn: () => T): T {
    const before = this.where;
    this.where = routeId;
    try {
      return fn();
    } finally {
      this.where = before;
    }
  }

  private fail(message: string): never {
    throw new Error(`assembly: route "${this.where}" ${message}`);
  }

  private handle(id: string): PartHandle {
    const part = this.ctx.parts.get(id);
    if (!part) this.fail(`names part "${id}", which is not in the scene`);
    part.group.updateWorldMatrix(true, false);
    return part;
  }

  /** The part a waypoint hangs off, so `shift` knows whose axes to use. */
  private owner(point: Span): string {
    if (point.at === 'shift') return this.owner(point.of);
    if (point.at === 'lead') return point.of.part;
    return point.at === 'hole' ? point.board : point.part;
  }

  /** Measurements are filed under the mesh's name; routes name the part's id. */
  private features(part: string): Record<string, { value: number | number[] }> {
    const key = this.ctx.assembly.parts[part]?.mesh ?? part;
    const found = this.ctx.assembly.features[key];
    if (!found) this.fail(`reads features of "${part}", which has none measured`);
    return found;
  }

  private scalar(part: string, key: string): number {
    const entry = this.features(part)[key];
    if (!entry) this.fail(`reads ${part}.${key}, which is not measured`);
    return entry.value as number;
  }

  /** A feature's z, or the midpoint of two — a cable in a channel rides between. */
  private height(part: string, z?: string | [string, string]): number {
    if (!z) return 0;
    if (typeof z === 'string') return this.scalar(part, z);
    return (this.scalar(part, z[0]) + this.scalar(part, z[1])) / 2;
  }

  /** A part's mesh frame: the model inside its group, turn already applied. */
  private meshFrame(part: string): Object3D {
    const frame = this.handle(part).meshFrame;
    frame.updateWorldMatrix(true, false);
    return frame;
  }

  /** One waypoint, in world space. */
  point(spec: Point | Trace): Vector3 {
    switch (spec.at) {
      case 'trace': {
        // A traced path is many points, so using one as a waypoint has to say
        // which. Only its far end makes sense — that is where a channel hands
        // the cable on to whatever comes next.
        if (!spec.end) {
          this.fail(
            `uses the whole of ${spec.part}.${spec.key} as one waypoint; ` +
              `say end: true to hang off the end of it`
          );
        }
        const path = this.span(spec);
        return path[path.length - 1];
      }

      case 'pad': {
        const part = this.handle(spec.part);
        const local = this.ctx.vendor.parts[spec.part]?.anchors?.[spec.pad];
        if (!local) this.fail(`lands on ${spec.part}.${spec.pad}, which has no anchor`);
        return new Vector3(...local).applyMatrix4(part.group.matrixWorld);
      }

      case 'lead': {
        // A pin covered by a connector is not where its wire starts: the wire
        // starts at the back of the shell, in line with the pin. `leads` is the
        // measured way out, so this is a direction in the part's own frame and
        // has to be turned with it — `transformDirection` normalises, so the
        // reach is reapplied afterwards. Trusting its result unscaled is a one
        // metre displacement, which throws the cable clean out of the scene.
        const part = this.handle(spec.of.part);
        const at = this.point(spec.of);
        const local = this.ctx.vendor.parts[spec.of.part]?.leads?.[spec.of.pad];
        if (!local) {
      this.fail(`follows ${spec.of.part}.${spec.of.pad}'s lead, which is not published`);
    }
        const along = new Vector3(...local);
        const reach = along.length();
        return at.add(along.transformDirection(part.group.matrixWorld).multiplyScalar(reach));
      }

      case 'hole': {
        const part = this.handle(spec.board);
        const grid = this.ctx.vendor.parts[spec.board]?.grid;
        if (!grid) this.fail(`names a hole on "${spec.board}", which publishes no grid`);
        if (spec.i < 0 || spec.j < 0 || spec.i >= grid.cols || spec.j >= grid.rows) {
          this.fail(
            `names hole (${spec.i}, ${spec.j}) on a ${grid.cols} x ${grid.rows} board`
          );
        }
        const local = new Vector3(
          grid.originM[0] + (spec.i - (grid.cols - 1) / 2) * grid.pitchM,
          grid.originM[1] + (spec.j - (grid.rows - 1) / 2) * grid.pitchM,
          grid.originM[2]
        );
        return local.applyMatrix4(part.group.matrixWorld);
      }

      case 'face': {
        const box = this.handle(spec.part).bounds;
        const at = box.getCenter(new Vector3());
        const [axis, sign] = AXIS[spec.side];
        at.setComponent(axis, sign > 0 ? box.max.getComponent(axis) : box.min.getComponent(axis));
        return at;
      }

      case 'feature': {
        let x = 0;
        let y = 0;
        if (spec.xy) {
          const value = this.features(spec.part)[spec.xy]?.value;
          if (!Array.isArray(value)) {
            this.fail(`reads ${spec.part}.${spec.xy} as a point, but it is a number`);
          }
          const n = spec.nth ?? 0;
          if (value.length < n * 2 + 2) {
            this.fail(`reads ${spec.part}.${spec.xy}[${n}], which is not there`);
          }
          [x, y] = [value[n * 2], value[n * 2 + 1]];
        }
        const z = this.height(spec.part, spec.z);
        return this.meshFrame(spec.part).localToWorld(new Vector3(x, y, z));
      }

      case 'shift': {
        const at = this.point(spec.of);
        const part = this.handle(this.owner(spec.of));
        const [axis, sign] = AXIS[spec.along];
        const along = new Vector3();
        along.setComponent(axis, sign);
        // The part's own axis, in world — so "+z off the board" follows the
        // board when the enclosure turns, rather than meaning world up.
        along.transformDirection(part.group.matrixWorld);
        return at.addScaledVector(along, spec.by);
      }
    }
  }

  /** One waypoint, or the whole traced path when it is a channel. */
  span(spec: Span): Vector3[] {
    if (spec.at !== 'trace') return [this.point(spec)];

    const flat = this.features(spec.part)[spec.key]?.value;
    if (!Array.isArray(flat)) this.fail(`traces ${spec.part}.${spec.key}, which is not a path`);
    const frame = this.meshFrame(spec.part);
    const z = this.height(spec.part, spec.z);

    const out: Vector3[] = [];
    for (let i = 0; i < flat.length; i += 2) {
      out.push(frame.localToWorld(new Vector3(flat[i], flat[i + 1], z)));
    }
    if (!out.length) this.fail(`traces ${spec.part}.${spec.key}, which is empty`);
    return spec.end ? [out[out.length - 1]] : out;
  }

  /** A whole declared route, as one curve. */
  route(routeId: string, sections: Section[]): Curve<Vector3> {
    return this.for(routeId, () => {
      const legs: Leg[] = sections.map((section) => ({
        bend: section.bend,
        points: section.via.flatMap((via) => this.span(via)),
        radius: section.bend === 'sharp' ? section.radius : undefined,
      }));
      return chain(legs);
    });
  }
}

// --- curves -----------------------------------------------------------------
/**
 * Curves laid end to end, measured by arc length across the whole run.
 *
 * `CurvePath` already parameterises by length once its pieces are added, which
 * is all this ever needed; the hand-rolled version it replaces did the same
 * arithmetic itself.
 */
function joined(pieces: Curve<Vector3>[]): Curve<Vector3> {
  const path = new CurvePath<Vector3>();
  for (const piece of pieces) {
    if (piece.getLength() > EPS) path.add(piece);
  }
  return path.curves.length ? path : new LineCurve3(new Vector3(), new Vector3());
}

/** Drop waypoints that repeat, which would otherwise make a zero-length leg. */
function distinct(points: Vector3[]): Vector3[] {
  const out: Vector3[] = [];
  for (const point of points) {
    if (!out.length || out[out.length - 1].distanceTo(point) > EPS) out.push(point.clone());
  }
  return out;
}

/**
 * A polyline with its corners rounded, as a curve.
 *
 * Straight legs stay straight, so a wire that should run parallel to a board
 * edge does. The radius is clamped to half the shorter adjacent leg, so a tight
 * zig-zag degrades to a smaller radius rather than overshooting into the
 * previous corner. Collinear corners cost nothing — the arc degenerates.
 */
function fillet(points: Vector3[], radius: number = CLEAR.bend): Curve<Vector3> {
  const via = distinct(points);
  if (via.length < 2) return new LineCurve3(via[0] ?? new Vector3(), via[0] ?? new Vector3());
  if (via.length === 2) return new LineCurve3(via[0], via[1]);

  const pieces: Curve<Vector3>[] = [];
  let cursor = via[0].clone();

  for (let i = 1; i < via.length - 1; i++) {
    const corner = via[i];
    const inDir = corner.clone().sub(via[i - 1]);
    const outDir = via[i + 1].clone().sub(corner);
    const inLen = inDir.length();
    const outLen = outDir.length();
    if (inLen < EPS || outLen < EPS) continue;
    inDir.divideScalar(inLen);
    outDir.divideScalar(outLen);

    // A corner that does not turn needs no arc, and its cross product is noise.
    if (inDir.dot(outDir) > 1 - 1e-6) continue;

    // Never eat more than half of either leg, or two arcs would overlap.
    const cut = Math.min(radius, inLen / 2, outLen / 2);
    const start = corner.clone().addScaledVector(inDir, -cut);
    const end = corner.clone().addScaledVector(outDir, cut);

    if (cursor.distanceTo(start) > EPS) pieces.push(new LineCurve3(cursor, start));
    pieces.push(new QuadraticBezierCurve3(start, corner.clone(), end));
    cursor = end;
  }

  pieces.push(new LineCurve3(cursor, via[via.length - 1]));
  return joined(pieces);
}

/**
 * A soft cable: a smooth spline through its waypoints.
 *
 * Centripetal parameterisation keeps the curve from looping back on itself when
 * two waypoints fall close together. Two points is a straight line and stays
 * one — a run that should sag says so with a waypoint, rather than every short
 * hop picking up a droop nobody asked for.
 */
function flying(points: Vector3[]): Curve<Vector3> {
  const via = distinct(points);
  if (via.length < 2) return new LineCurve3(via[0] ?? new Vector3(), via[0] ?? new Vector3());
  if (via.length === 2) return new LineCurve3(via[0], via[1]);
  return new CatmullRomCurve3(via, false, 'centripetal', 0.5);
}

interface Leg {
  bend: Bend;
  points: Vector3[];
  radius?: number;
}

/**
 * Sections laid end to end, each carrying on from where the last one stopped.
 *
 * The join is exact: a section is handed the previous section's final point as
 * its own first, so the run is continuous by construction rather than by the two
 * ends happening to be declared at the same place.
 */
function chain(legs: Leg[]): Curve<Vector3> {
  const pieces: Curve<Vector3>[] = [];
  let cursor: Vector3 | null = null;

  for (const leg of legs) {
    const points: Vector3[] = cursor ? [cursor, ...leg.points] : [...leg.points];
    if (points.length < 2) continue;
    pieces.push(leg.bend === 'sharp' ? fillet(points, leg.radius) : flying(points));
    cursor = points[points.length - 1]!.clone();
  }

  if (!pieces.length) return new LineCurve3(new Vector3(), new Vector3());
  return pieces.length === 1 ? pieces[0]! : joined(pieces);
}

// --- bundles ----------------------------------------------------------------

/**
 * Frames that follow a curve without spinning about it.
 *
 * three.js's own Frenet frames are built from curvature, so they whip round
 * through an inflection and flip outright where a run is briefly straight. A
 * helix swept on those comes out kinked. Parallel transport carries one frame
 * along the curve instead, rotating it only as much as the tangent turns.
 */
function transportFrames(points: Vector3[]): { normal: Vector3; binormal: Vector3 }[] {
  const tangents = points.map((_, i) => {
    const before = points[Math.max(0, i - 1)]!;
    const after = points[Math.min(points.length - 1, i + 1)]!;
    const tangent = after.clone().sub(before);
    return tangent.lengthSq() > 1e-12 ? tangent.normalize() : new Vector3(1, 0, 0);
  });

  const first = tangents[0]!;
  const seed = Math.abs(first.z) > 0.9 ? new Vector3(1, 0, 0) : new Vector3(0, 0, 1);
  let normal = seed.clone().sub(first.clone().multiplyScalar(seed.dot(first))).normalize();

  const out: { normal: Vector3; binormal: Vector3 }[] = [];
  for (let i = 0; i < points.length; i++) {
    if (i > 0) {
      const turn = new Quaternion().setFromUnitVectors(tangents[i - 1]!, tangents[i]!);
      normal = normal.clone().applyQuaternion(turn).normalize();
    }
    out.push({
      normal: normal.clone(),
      binormal: new Vector3().crossVectors(tangents[i]!, normal).normalize(),
    });
  }
  return out;
}

const smooth = (x: number): number => {
  const c = Math.min(1, Math.max(0, x));
  return c * c * (3 - 2 * c);
};

/**
 * One conductor of a bundle: the shared centreline, the offset that makes it a
 * twist or a ribbon, and its own tail out to its own pin at each end.
 *
 * A twisted pair has to stop twisting before it can land on two pins, so its
 * pattern decays to nothing over `unwind` — one twist pitch by default, the
 * cable's own measurement rather than a number picked to look right. A ribbon
 * does not: its conductors are moulded side by side and stay that way into the
 * connector.
 */
function strand(spec: {
  centre: Curve<Vector3>;
  cable: Cable;
  index: number;
  count: number;
  from: Vector3;
  to: Vector3;
  tail: [Bend, Bend];
  unwind?: number;
}): { curve: Curve<Vector3>; steps: number } {
  const { centre, cable: dress, index, count } = spec;
  const length = centre.getLength();
  const turns = dress.pitchM ? length / dress.pitchM : 0;
  // Enough samples that a turn is round rather than polygonal, and never fewer
  // than a plain tube would have used anyway.
  const steps = Math.max(SEGMENTS / 2, Math.ceil(turns * 24));
  const spine = centre.getSpacedPoints(steps);
  const frames = transportFrames(spine);

  const twisted = dress.form === 'twisted';
  const unwind = spec.unwind ?? dress.pitchM ?? 0;
  const fade = length > 0 ? Math.min(0.5, unwind / length) : 0;

  const bundle: Vector3[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const point = spine[i]!.clone();
    let across: number;
    let up = 0;

    if (twisted) {
      const angle = 2 * Math.PI * (turns * t + index / count);
      across = Math.cos(angle) * dress.spreadM;
      up = Math.sin(angle) * dress.spreadM;
      // Unwound at both ends, so the pair arrives at the breakout together and
      // the tails leave from one place rather than from a moving helix.
      const ease = fade > 0 ? smooth(t / fade) * smooth((1 - t) / fade) : 1;
      across *= ease;
      up *= ease;
    } else {
      across = (index - (count - 1) / 2) * dress.spreadM;
    }

    // `across` rides the binormal, which stays roughly horizontal along a run
    // that is not itself vertical — so a ribbon lies flat rather than standing
    // its conductors on edge, stacked one above another.
    bundle.push(
      point
        .addScaledVector(frames[i]!.binormal, across)
        .addScaledVector(frames[i]!.normal, up)
    );
  }

  const curve = chain([
    { bend: spec.tail[0], points: [spec.from, bundle[0]!] },
    { bend: 'curve', points: bundle.slice(1) },
    { bend: spec.tail[1], points: [spec.to] },
  ]);
  return { curve, steps: steps * 2 };
}

// --- building the tubes -----------------------------------------------------

interface Conductor {
  mesh: Mesh;
  /** Which declared route drew this, and which parts have to be present. */
  route: string;
  needs: string[];
  /** True when this rides a part, so it travels to and from the bench with it. */
  carried: boolean;
  indexCount: number;
  progress: number;
}

/** The pad a net lands on, at one end of a hop. */
function padOf(net: string, part: string): string | null {
  const entry = NETLIST.nets.find((n) => n.id === net);
  return entry?.path.find(([p]) => p === part)?.[1] ?? null;
}

/** A loom conductor's own terminal: declared, or the netlist's pad by default. */
function terminal(loom: Loom, index: number, end: 0 | 1): Point {
  const strand = loom.conductors[index];
  const declared = end === 0 ? strand.from : strand.to;
  if (declared) return declared;
  const part = loom.between[end];
  const pad = padOf(strand.net, part);
  if (!pad) {
    throw new Error(
      `assembly: loom "${routeId(loom)}" has no terminal for ${strand.net} on ` +
        `"${part}", and the netlist does not give it one`
    );
  }
  return { at: 'pad', part, pad };
}

export class Harness {
  readonly group = new Group();

  private readonly conductors: Conductor[] = [];
  private readonly materials: MeshStandardMaterial[] = [];
  private readonly geometries: TubeGeometry[] = [];

  build(
    parts: Map<string, PartHandle>,
    assembly: AssemblyManifest,
    vendor: VendorManifest
  ): void {
    const resolver = new Resolver({ parts, assembly, vendor });

    for (const route of rig.routes) {
      const id = routeId(route);
      const needs = touches(route).filter((part) => parts.has(part));
      const carrier = route.carrier ? parts.get(route.carrier) : undefined;
      if (route.carrier && !carrier) {
        throw new Error(
          `assembly: route "${id}" rides "${route.carrier}", which is not in the scene`
        );
      }
      const centre = resolver.route(id, route.route);

      if (route.kind === 'wire') {
        const dress = dressOf(route);
        this.add(centre, dress.colour, dress.radiusM, id, needs, carrier);
        continue;
      }

      const spec = cable(route.cable);
      const count = route.conductors.length;
      resolver.for(id, () => {
        for (let i = 0; i < count; i++) {
          const one = strand({
            centre,
            cable: spec,
            index: i,
            count,
            from: resolver.point(terminal(route, i, 0)),
            to: resolver.point(terminal(route, i, 1)),
            tail: route.tail ?? ['curve', 'curve'],
            unwind: route.unwind,
          });
          const net = route.conductors[i]!.net;
          this.add(one.curve, spec.colours[net]!, spec.radiusM, id, needs, carrier, one.steps);
        }
      });
    }
  }

  /**
   * One conductor, as a tube.
   *
   * A carried cable is baked into its carrier's own frame and hung off its
   * group, so benching the board takes its wiring with it. The route is still
   * resolved in world — every waypoint it names is a world position at the
   * moment of building — and only the finished geometry is moved, which keeps
   * the resolver ignorant of any of this.
   */
  private add(
    curve: Curve<Vector3>,
    colour: string,
    radiusM: number,
    route: string,
    needs: string[],
    carrier?: PartHandle,
    steps = SEGMENTS
  ): void {
    const geometry = new TubeGeometry(curve, steps, radiusM, 6, false);
    if (carrier) {
      carrier.group.updateWorldMatrix(true, false);
      geometry.applyMatrix4(carrier.group.matrixWorld.clone().invert());
    }
    const material = new MeshStandardMaterial({
      color: colour,
      roughness: 0.4,
      metalness: 0.05,
    });
    const mesh = new Mesh(geometry, material);
    mesh.geometry.setDrawRange(0, 0);
    mesh.visible = false;
    (carrier ? carrier.group : this.group).add(mesh);
    this.geometries.push(geometry);
    this.materials.push(material);
    this.conductors.push({
      mesh,
      route,
      needs,
      carried: Boolean(carrier),
      indexCount: geometry.index?.count ?? 0,
      progress: 0,
    });
  }

  /**
   * Whether this conductor should be on screen.
   *
   * The step has to have asked for its route, and every part the route runs to
   * or past has to be present. A carried cable may be drawn on the bench, since
   * it and everything it joins are on the bench together and it moves with
   * them. An uncarried one may not: it is built in world space, so drawing it
   * while one of its ends is still on the bench stretches it across the room.
   */
  private targetFor(state: SceneState, conductor: Conductor): number {
    if (!state.wires.has(conductor.route)) return 0;
    const there = (id: string): boolean =>
      state.visible.has(id) && (conductor.carried || !state.benched.has(id));
    return conductor.needs.every(there) ? 1 : 0;
  }

  apply(state: SceneState): void {
    for (const conductor of this.conductors) {
      conductor.progress = this.targetFor(state, conductor);
      draw(conductor);
    }
  }

  tracks(state: SceneState, at = 0): Track[] {
    const out: Track[] = [];
    let slot = 0;
    for (const conductor of this.conductors) {
      const target = this.targetFor(state, conductor);
      if (Math.abs(conductor.progress - target) < 1e-3) continue;
      const delay = target > conductor.progress ? slot * WIRE_STAGGER_MS : 0;
      if (target > conductor.progress) slot += 1;
      out.push(
        tween(
          conductor.progress,
          target,
          (v) => {
            conductor.progress = v;
            draw(conductor);
          },
          { at: at + delay, dur: WIRE_DRAW_MS, ease: easeOut }
        )
      );
    }
    return out;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
    for (const g of this.geometries) g.dispose();
  }
}

/** A single wire's dress: its cable's if it names one, else the net's own. */
function dressOf(route: Route & { kind: 'wire' }): { colour: string; radiusM: number } {
  if (route.cable) {
    const spec = cable(route.cable);
    const colour = spec.colours[route.net];
    if (!colour) {
      throw new Error(
        `assembly: route "${routeId(route)}" is dressed as "${route.cable}", ` +
          `which carries no conductor for "${route.net}"`
      );
    }
    return { colour, radiusM: spec.radiusM };
  }
  const entry = NETLIST.nets.find((n) => n.id === route.net);
  return { colour: entry?.colour ?? '#8a8f98', radiusM: LOOSE_RADIUS_M };
}

function draw(conductor: Conductor): void {
  conductor.mesh.visible = conductor.progress > 0.001;
  const shown = Math.floor((conductor.indexCount * conductor.progress) / 3) * 3;
  conductor.mesh.geometry.setDrawRange(0, shown);
}
