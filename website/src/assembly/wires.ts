/**
 * How a cable is declared: where it starts, where it goes, and how it bends.
 *
 * A route is a list of **sections**, and a section is "carry on from where we
 * are, through these points, in this style". Two styles:
 *
 *   sharp(a, b, c)   straight legs with the corners rounded off — cut and bent
 *                    hookup wire, which is what a board link is
 *   curve(a, b, c)   a spline through the points — a flying lead, a moulded
 *                    ribbon, a loom, anything that hangs in its own stiffness
 *
 * Sections chain, so a run that leaves the board square, curves through a
 * channel and squares off again is three sections in a row. Each picks up where
 * the last one ended; nothing has to be repeated.
 *
 * ## The rule this vocabulary exists to enforce
 *
 * **Nothing here is a coordinate.** There is no constructor anywhere in this
 * file that takes three numbers. A waypoint names a measured thing — a pad, a
 * hole in a published grid, a feature out of `measure_assembly.py`, a face of a
 * part's measured bounding box — and `resolve.ts` looks it up. Move a module and
 * its wires follow; re-cut a channel and the loom in it moves.
 *
 * Scalars survive in exactly one place: `CLEAR`, below. Every entry there is a
 * *clearance* — a distance applied along a measured direction from a measured
 * point — and every one carries the physical reason it is the size it is. A
 * number that cannot be written that way does not belong in a route.
 */

/** Metres. Only ever applied along a measured direction from a measured point. */
type Clear = number;

export const CLEAR = {
  /** A soldered link stands a wire's thickness off the FR4 it lies on. */
  offBoard: 0.0009,
  /** How high a lead climbs to clear the modules standing on the board. */
  overModule: 0.006,
  /** Slack behind the back panel, so a panel wire reads as a loop, not a strut. */
  behindPanel: 0.006,
  /** Below the lid seam, by which point the loom is already inside the boss bore. */
  bossEntry: 0.006,
  /** Out of the arm's channel before the cable climbs into the open beam. */
  channelExit: 0.004,
  /** The tightest corner real hookup wire will take. */
  bend: 0.0016,
  /** One conductor diameter: how far apart wires sharing a channel stack. */
  stack: 0.0012,
} as const;

export type Side = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

/** A measured pad, from the vendor manifest's `anchors`. */
interface PadPoint {
  at: 'pad';
  part: string;
  pad: string;
}

export type Point =
  | PadPoint
  /** A hole in a carrier board's published grid. Indices, not millimetres. */
  | { at: 'hole'; board: string; i: number; j: number }
  /** The centre of one face of a part's measured bounding box. */
  | { at: 'face'; part: string; side: Side }
  /** A measured feature, resolved in that part's own mesh frame. */
  | {
      at: 'feature';
      part: string;
      /** A 2-vector feature giving x and y — `lid.wireBossCentre`. */
      xy?: string;
      /** A scalar feature giving z. Two names mean their midpoint, which is
       *  where a cable sits in a channel: on neither the floor nor the roof. */
      z?: string | [string, string];
      /** Which entry, when the feature is a list of points. */
      nth?: number;
    }
  /** Offset from another point, along one of its part's own measured axes.
   *  A traced path may be shifted too, as long as it names one end of itself:
   *  hanging the next section off the far end of a channel is the whole reason
   *  `end` exists. */
  | { at: 'shift'; of: Point | Trace; along: Side; by: Clear }
  /** Off a solder tag along the tag, or out of the back of a connector shell.
   *  The direction and reach are the part's published `leads`, measured from
   *  its CAD — a wire leaves a terminal along the terminal, never from above. */
  | { at: 'lead'; of: PadPoint };

/**
 * A traced polyline feature — `arm.wireSlotPath` and its kind. It expands to
 * many points rather than one, so it is its own thing.
 */
export interface Trace {
  at: 'trace';
  part: string;
  key: string;
  z: string | [string, string];
  /** Just the last station, for hanging the next section off the channel's end. */
  end?: true;
}

export type Span = Point | Trace;

export type Bend = 'sharp' | 'curve';

export type Section =
  | { bend: 'sharp'; via: Span[]; radius?: Clear }
  | { bend: 'curve'; via: Span[] };

// --- waypoints --------------------------------------------------------------

export const pad = (part: string, name: string): PadPoint =>
  ({ at: 'pad', part, pad: name });

export const hole = (board: string, i: number, j: number): Point =>
  ({ at: 'hole', board, i, j });

export const face = (part: string, side: Side): Point => ({ at: 'face', part, side });

export const feature = (
  part: string,
  spec: { xy?: string; z?: string | [string, string]; nth?: number }
): Point => ({ at: 'feature', part, ...spec });

export const shift = (of: Point | Trace, along: Side, by: Clear): Point =>
  ({ at: 'shift', of, along, by });

export const lead = (of: PadPoint): Point => ({ at: 'lead', of });

export const trace = (
  part: string,
  key: string,
  spec: { z: string | [string, string]; end?: true }
): Trace => ({ at: 'trace', part, key, ...spec });

// --- sections ---------------------------------------------------------------

export const sharp = (...via: Span[]): Section => ({ bend: 'sharp', via });
export const curve = (...via: Span[]): Section => ({ bend: 'curve', via });

// --- routes -----------------------------------------------------------------

/** One conductor of a loom, and where each of its own ends lands. */
interface Strand {
  net: string;
  /** Defaults to the netlist's pad for this net on the loom's first part. A
   *  board-mounted end must name its hole instead: the pin is inside a socket,
   *  and the wire is soldered into the board beside it. */
  from?: Point;
  to?: Point;
}

export interface Wire extends Carried {
  kind: 'wire';
  /** The net this draws, and the two parts this hop of it joins. */
  net: string;
  between: [string, string];
  /** A cable in `cables.ts`, for gauge and colour. Omitted means a plain wire
   *  in the netlist's own colour — which is what a signal link is. */
  cable?: string;
  /** Wiring stage. A step turns on a group, not a net — which is what keeps
   *  ground's board hop and ground's encoder hop independent of each other. */
  group: string;
  /** Terminal to terminal. */
  route: Section[];
}

export interface Loom extends Carried {
  kind: 'loom';
  /** A cable declared below: its form, its conductor colours, its gauge. */
  cable: string;
  between: [string, string];
  group: string;
  /** In the cable's own conductor order — outermost first for a ribbon. */
  conductors: Strand[];
  /**
   * The bundle's centreline, **breakout to breakout**.
   *
   * Its first and last resolved points are where the conductors come apart, so
   * the fan-out is declared rather than being a fixed fraction of the run. Ask
   * for it late and the bundle stays together right up to the header; ask for it
   * early and it opens out across the board, which is what a real loom does when
   * its pins are far apart.
   */
  route: Section[];
  /** How each conductor's tail, breakout to its own terminal, is drawn. */
  tail?: [Bend, Bend];
  /** Length over which a twist unwinds into a breakout. Default: one pitch. */
  unwind?: Clear;
}

/**
 * Common to both, and filled in by `assembly()` rather than by hand: the part a
 * cable is built on and travels with. A cable with no carrier is built in world
 * space and may only be drawn once everything it touches is seated.
 */
interface Carried {
  carrier?: string;
}

export type Route = (Wire | Loom) & Carried;

export const wire = (spec: Omit<Wire, 'kind'>): Wire => ({ kind: 'wire', ...spec });
export const loom = (spec: Omit<Loom, 'kind'>): Loom => ({ kind: 'loom', ...spec });

/** Every part a route touches, so the viewer knows when it may be drawn. */
export function touches(route: Route): string[] {
  const parts = new Set<string>(route.between);
  const walk = (point: Span): void => {
    if (point.at === 'shift') walk(point.of);
    else if (point.at === 'lead') parts.add(point.of.part);
    else if ('part' in point) parts.add(point.part);
    else if ('board' in point) parts.add(point.board);
  };
  for (const section of route.route) for (const via of section.via) walk(via);
  if (route.kind === 'loom') {
    for (const strand of route.conductors) {
      if (strand.from) walk(strand.from);
      if (strand.to) walk(strand.to);
    }
  }
  return [...parts];
}

/** The nets a route draws. */
/**
 * What a step turns on.
 *
 * Deliberately the *route*, not the net. Ground is one net drawn by several
 * routes — across the board, and out to the encoder in a twisted pair — and
 * they go on at different points in the build. Keying on the net turned on all
 * of them at once, which put the encoder's black conductor on screen three steps
 * early, stretched from the board to a sensor still sitting on the bench.
 *
 * Derived rather than typed, so a route cannot be declared with a stale id.
 * They come out unique, which is what lets a step name one.
 */
export const routeId = (route: Route): string =>
  `${route.kind === 'wire' ? route.net : route.cable}@${route.between.join('-')}`;

// --- what a cable looks like ------------------------------------------------

/** Twisted conductors wrap around each other; a ribbon lies flat. */
type CableForm = 'twisted' | 'ribbon' | 'loose';

export interface Cable {
  id: string;
  form: CableForm;
  label: string;
  /** Conductor colours, keyed by net. Order in a route decides the ribbon's. */
  colours: Record<string, string>;
  /** Conductor radius. 12 V wire really is thicker than signal wire. */
  radiusM: number;
  /** Twist length along the bundle. Ignored by the other forms. */
  pitchM?: number;
  /**
   * Spacing between conductors. For a twisted bundle it is the radius of the
   * helix each one follows; for a ribbon it is the pitch between them, and
   * setting it to one conductor diameter is what makes them touch — a ribbon
   * with a gap down the middle of it is not a ribbon.
   */
  spreadM: number;
}

export const LOOSE_RADIUS_M = 0.00055;

const CABLE_LIST: Cable[] = [
  {
    // The AS5600 carries two headers, three pins on one side and four on the
    // other, so the loom arrives as two twisted pairs and not one bundle of
    // four. Power lands on the three-way side.
    id: 'encoder-power',
    form: 'twisted',
    label: 'Encoder power pair',
    colours: { gnd: '#141414', v5: '#c0392b' },
    radiusM: 0.00042,
    pitchM: 0.016,
    spreadM: 0.00042,
  },
  {
    id: 'encoder-i2c',
    form: 'twisted',
    label: 'Encoder I²C pair',
    colours: { sda: '#e8e8e8', scl: '#d8c020' },
    radiusM: 0.00042,
    pitchM: 0.016,
    spreadM: 0.00042,
  },
  {
    // The motor ships with a moulded plug on one end and bare pins on the
    // other, its four conductors side by side the whole way. Colour order is
    // the one on the cable, left to right.
    id: 'motor',
    form: 'ribbon',
    label: 'Motor coil ribbon',
    colours: {
      'coil-a': '#c0392b',
      'coil-a-return': '#141414',
      'coil-b': '#2f6fd0',
      'coil-b-return': '#2e9e4f',
    },
    radiusM: 0.0006,
    spreadM: 0.0012,
  },
  {
    // Separate conductors, but heavier gauge: these carry the whole motor
    // current, and on the bench they are visibly fatter than the signal wires.
    id: 'power',
    form: 'loose',
    label: 'Power wiring',
    colours: { v12: '#c0392b', gnd: '#141414' },
    radiusM: 0.0009,
    spreadM: 0.0009,
  },
];

/** The cables above, by id, for `cable()` to look up. */
const CABLES = new Map(CABLE_LIST.map((c) => [c.id, c]));

export function cable(id: string): Cable {
  const found = CABLES.get(id);
  if (!found) throw new Error(`assembly: no cable "${id}" — see wires.ts`);
  return found;
}
