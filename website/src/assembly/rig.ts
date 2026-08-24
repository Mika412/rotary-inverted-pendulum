/**
 * The rig, as nested assemblies: what goes together, and the cables that run
 * among the things that go together.
 *
 * An assembly owns parts, it may own child assemblies, and it owns the routes
 * whose cables physically run through it. Its methods return the actions a step
 * would otherwise write out by hand:
 *
 *     actions: [board.install(), ghost('base')]
 *
 * Nesting is concatenation: `parts` is this assembly's own followed by each
 * child's, in declaration order, and so is `routes`.
 */
import { Vector3 } from 'three';
import {
  CLEAR,
  curve,
  face,
  feature,
  hole,
  lead,
  loom,
  pad,
  sharp,
  shift,
  trace,
  wire,
  type Point,
  type Route,
  routeId,
  touches,
  type Section,
  type Span,
} from './wires.ts';
import { bench, fit, ghost, install, wires } from './state.ts';
import type { Action } from './state.ts';

// --- the assembly factory ---------------------------------------------------

/**
 * A named group of parts that go together, with the cables that live among them.
 *
 * It owns parts, it may own child assemblies, and it owns the routes whose
 * cables physically run through it. Its methods return the actions a step would
 * otherwise write out by hand:
 *
 *     actions: [board.install(), ghost('base')]
 *
 * Nesting is concatenation: `parts` is this assembly's own followed by each
 * child's, in declaration order, and so is `routes`.
 */

interface AssemblySpec {
  id: string;
  /** Owned parts, in the order they go together. */
  parts?: string[];
  /** Nested assemblies. Their parts and routes count as this one's too. */
  children?: Assembly[];
  /** Cables declared here. Declare a route where its cable physically lives. */
  routes?: Route[];
  /**
   * The part this assembly's own cables are built on, so they travel with it.
   *
   * Half the wiring on this rig is soldered off the rig — that is the whole
   * point of building the board on the bench — and a cable made there has to
   * move when the board does. Naming a carrier says so. It applies only to
   * routes whose every end is inside this assembly: a lead to the back panel
   * cannot be carried in, because one end of it is bolted to the wall.
   */
  carrier?: string;
}

export interface Assembly {
  readonly id: string;
  /** Own parts, then each child's, in declaration order. */
  readonly parts: string[];
  readonly routes: Route[];
  /** Wiring stages this assembly can be asked for, in declaration order. */
  readonly groups: string[];

  /** Build these off the rig. No arguments: everything this assembly owns. */
  bench(...ids: string[]): Action[];
  /** Seat these straight onto the rig. No arguments: everything it owns. */
  fit(...ids: string[]): Action[];
  /** Bring the whole thing in from the bench as one piece. */
  install(): Action[];
  /** Draw the cables in these stages. No arguments: all of them. */
  wire(...groups: string[]): Action[];
  /** Cutaway everything this assembly owns. */
  ghost(): Action[];
}

export function assembly(spec: AssemblySpec): Assembly {
  const parts = [...(spec.parts ?? []), ...(spec.children ?? []).flatMap((c) => c.parts)];
  // A route is carried when the assembly names a carrier and the route stays
  // inside it. Derived rather than declared per route: "does this cable leave
  // the assembly" is a question the parts list already answers.
  //
  // Carrying returns a *copy*. Routes are module-level consts, so writing the
  // carrier onto the caller's object would make a second `assembly()` over the
  // same array see the first one's answer.
  const inside = new Set(spec.parts ?? []);
  const carried = (spec.routes ?? []).map((route) =>
    spec.carrier && touches(route).every((part) => inside.has(part))
      ? { ...route, carrier: spec.carrier }
      : route
  );
  const routes = [...carried, ...(spec.children ?? []).flatMap((c) => c.routes)];
  const groups = [...new Set(routes.map((r) => r.group))];

  const own = (ids: string[]): string[] => {
    if (!ids.length) return parts;
    const stranger = ids.find((id) => !parts.includes(id));
    if (stranger) {
      throw new Error(`assembly "${spec.id}" does not own the part "${stranger}"`);
    }
    return ids;
  };

  return {
    id: spec.id,
    parts,
    routes,
    groups,

    bench: (...ids) => [bench(...own(ids))],
    fit: (...ids) => [fit(...own(ids))],
    install: () => [install(...parts)],
    ghost: () => [ghost(...parts)],

    // Turning on a *stage* rather than a list of nets is what keeps ground's
    // board hop separate from ground's encoder hop: they are the same net, drawn
    // by two routes, in two different stages. Naming the net turned on both, so
    // the encoder's black conductor appeared three steps early, stretched from
    // the board to a sensor still on the bench.
    wire: (...want) => {
      const asked = want.length ? want : groups;
      const missing = asked.find((g) => !groups.includes(g));
      if (missing) {
        throw new Error(
          `assembly "${spec.id}" has no wiring stage "${missing}" ` +
            `(it has ${groups.map((g) => `"${g}"`).join(', ') || 'none'})`
        );
      }
      const drawn = routes.filter((r) => asked.includes(r.group)).map(routeId);
      return [wires(...drawn)];
    },
  };
}

// --- enclosure --------------------------------------------------------------

/**
 * The two printed halves, on their own.
 *
 * A long jump through the build ghosts these while the parts cascade in, so the
 * reader can see what is landing inside. Naming them here rather than in the
 * viewer keeps the one list there was of "which parts are the box" in the file
 * that already knows what the box is made of.
 */
export const shell = assembly({ id: 'shell', parts: ['base', 'lid'] });

/**
 * The printed box and everything that mounts in its walls.
 *
 * No routes of its own. The jack and the rocker are wired *to*, not wired
 * *through*, and the cables that reach them belong to the board they run back
 * to — a route is declared where its cable physically lives, and those two live
 * on the board's side of the enclosure.
 */
export const enclosure = assembly({
  id: 'enclosure',
  parts: ['jack', 'switch', 'bumper-0', 'bumper-1', 'bumper-2', 'bumper-3'],
  children: [shell],
});

// --- board ------------------------------------------------------------------

/**
 * The electronics: a protoboard, the two modules that plug into it, the
 * decoupling beside the driver, and every cable that runs between them.
 *
 * ## Holes, not coordinates
 *
 * A module sits in female headers, so its pins are inside a socket and
 * unreachable. The wire is soldered into the **board hole beside** the header,
 * and that is what `H` below names — indices into the 2.54 mm grid published in
 * `public/models/vendor/manifest.json`, which is the same grid the pad texture
 * is drawn on. Each one is one pitch outboard of the pin it serves, along the
 * module's short axis, which is the direction that clears the module's own
 * footprint, which the vendor manifest publishes as a hole grid.
 *
 * `STEP` is the one exception at two pitches: the hole beside its pin is under
 * the electrolytic capacitor, and you cannot solder under a component body.
 *
 * ## Two stages, because half of this is done off the rig
 *
 * `board` is everything soldered while the board is still on the bench, where
 * both sides of it are reachable — which is the whole reason it is built off the
 * rig in the first place. `panel` is the three flying leads to the jack and the
 * rocker, which cannot be made until the board is in the box and the back-panel
 * hardware is fitted.
 *
 * Cables in the `board` stage ride the protoboard and are carried in with it,
 * which is what `carrier` below says: a cable whose every end is inside this
 * assembly travels with the assembly.
 */

/** The carrier every board-level hole index is measured against. */
const BOARD = 'protoboard';

/** The board's named holes, as grid indices. */
const H = {
  // Nano, digital row — the free column to the module's left.
  d2: [0, 7],
  d5: [0, 10],
  d9: [0, 14],
  // Nano, power and analogue row — the free column to its right.
  vin: [8, 3],
  gnd: [8, 4],
  v5: [8, 6],
  a5: [8, 9],
  a4: [8, 10],
  // Driver, power row. The four coil holes run in the ribbon's own order.
  vmot: [13, 1],
  driverGnd: [13, 2],
  coilB2: [13, 3],
  coilB1: [13, 4],
  coilA1: [13, 5],
  coilA2: [13, 6],
  // Driver, control row.
  enable: [20, 1],
  dir: [20, 8],
  step: [20, 9],
  // Not terminals: the free rows along the board's far edge, where a flying
  // lead from the back panel comes down before it crosses the board. Coming
  // straight in from the panel instead cuts the corner through whatever stands
  // between — the rocker's own body, on the way to the jack.
  underJack: [12, 13],
  underSwitch: [20, 13],
  underBoss: [14, 13],
} as const;

/**
 * A board hole, lifted to where a soldered wire's centreline actually runs.
 *
 * `layer` exists because three wires have to share one channel. The Nano covers
 * the board from its second row up, leaving a single free column beside it and
 * one free row below, and DIR, STEP and ENABLE all have to get from that column
 * round to the driver's far side. On the real board they lie on top of each
 * other there; stacking them by a wire diameter is that, drawn.
 */
const at = ([i, j]: readonly [number, number], layer = 0): Point =>
  shift(hole(BOARD, i, j), '+z', CLEAR.offBoard + layer * CLEAR.stack);

/**
 * Out of the Nano's digital column, under its bottom edge, and into the open
 * board beyond it — the one way round, shared by all three control wires.
 */
const roundTheNano = (from: readonly [number, number], layer: number): Span[] => [
  at(from, layer),
  at([0, 0], layer),
];

export const board = assembly({
  id: 'board',
  parts: [BOARD, 'nano', 'driver', 'cap-electrolytic', 'cap-ceramic'],
  carrier: BOARD,
  routes: [
    // --- on the bench: board links, with both sides still reachable
    wire({
      net: 'v12',
      between: ['driver', 'nano'],
      cable: 'power',
      group: 'board',
      // In the clear channel the layout leaves between the two modules.
      route: [sharp(at(H.vmot), at([10, 1]), at([10, 3]), at(H.vin))],
    }),
    wire({
      net: 'gnd',
      between: ['driver', 'nano'],
      cable: 'power',
      group: 'board',
      route: [sharp(at(H.driverGnd), at([11, 2]), at([11, 4]), at(H.gnd))],
    }),
    wire({
      net: 'dir',
      between: ['nano', 'driver'],
      group: 'board',
      route: [
        sharp(
          ...roundTheNano(H.d2, 0),
          at([12, 0], 0),
          at([12, 11], 0),
          at([21, 11], 0),
          at([21, 8], 0),
          at(H.dir)
        ),
      ],
    }),
    wire({
      net: 'step',
      between: ['nano', 'driver'],
      group: 'board',
      route: [
        sharp(
          ...roundTheNano(H.d9, 1),
          at([10, 0], 1),
          at([10, 12], 1),
          at([21, 12], 1),
          at([21, 9], 1),
          at(H.step)
        ),
      ],
    }),
    wire({
      net: 'enable',
      between: ['nano', 'driver'],
      group: 'board',
      // Straight under the driver's own bottom edge rather than over the top of
      // it: EN is the pin nearest that corner, so going the long way round would
      // be a longer wire for no reason.
      route: [sharp(...roundTheNano(H.d5, 2), at([20, 0], 2), at(H.enable))],
    }),

    // --- in the box: the three leads that reach the back panel
    wire({
      net: 'v12',
      between: ['jack', 'switch'],
      cable: 'power',
      group: 'panel',
      // Behind the back panel, where there is nothing to bend around. Both ends
      // leave along their own solder tags; the loop between them is slack, which
      // is why it is a curve and not a strut.
      route: [
        curve(
          lead(pad('jack', '+')),
          shift(face('switch', '-y'), '-y', CLEAR.behindPanel),
          lead(pad('switch', 'in'))
        ),
      ],
    }),
    wire({
      net: 'v12',
      between: ['switch', 'driver'],
      cable: 'power',
      group: 'panel',
      // A flying lead, not bent hookup wire: it leaves the rocker's blade, drops
      // to the board directly below it, and crosses to the driver's VMOT hole.
      route: [
        curve(
          lead(pad('switch', 'out')),
          shift(at(H.underSwitch), '+z', CLEAR.overModule),
          at(H.vmot)
        ),
      ],
    }),
    wire({
      net: 'gnd',
      between: ['jack', 'driver'],
      cable: 'power',
      group: 'panel',
      route: [
        curve(
          lead(pad('jack', '-')),
          shift(at(H.underJack), '+z', CLEAR.overModule),
          at(H.driverGnd)
        ),
      ],
    }),
  ],
});

/**
 * The holes and the lift, so the looms that leave the board can start from the
 * same places its own links do. A loom is declared in the assembly it runs to —
 * the coil ribbon with the motor, the encoder pairs with the arm — but it still
 * begins at a hole in this board, and there should be one list of those.
 */
const boardHole = at;

// --- motor ------------------------------------------------------------------

/**
 * The motor and the bracket that holds it, plus the ribbon that feeds its coils.
 *
 * The bracket is a cross inside a square: four arms reaching the enclosure's
 * walls, the motor filling the middle, and the four corners open. Those corners
 * are the only way a cable gets from the board below up to the plug on the far
 * side of the motor, which is why `cornerGapCentres` is measured rather than
 * worked out from the bracket's outline.
 */

/**
 * The open quadrant the ribbon climbs through, counting anticlockwise from the
 * plate's own +x+y. It is the one on the plug's side of the motor: the plug
 * hangs off the motor's coil boss, and going up any other corner would mean
 * crossing back over the motor to reach it.
 */
const CORNER = 1;

const cornerAt = (z: string) =>
  feature('motor-plate', { xy: 'cornerGapCentres', nth: CORNER, z });

export const motorUnit = assembly({
  id: 'motor-unit',
  parts: ['motor-plate', 'motor', 'heatsink', 'plug-motor'],
  routes: [
    loom({
      cable: 'motor',
      between: ['driver', 'motor'],
      group: 'coils',
      // The motor ships with this made up: four conductors side by side, a
      // moulded plug on one end, bare tinned ends on the other.
      //
      // Listed in the order they lie **across the plug**, which is the end that
      // cannot be rewired — the plug is moulded, so the board end is the one
      // that has to match it. Listed the other way round, every conductor lands
      // on the pin belonging to the one opposite it and the whole ribbon reads
      // inverted, which is exactly what it did.
      conductors: [
        { net: 'coil-b-return', from: boardHole(H.coilB2) },
        { net: 'coil-b', from: boardHole(H.coilB1) },
        { net: 'coil-a-return', from: boardHole(H.coilA2) },
        { net: 'coil-a', from: boardHole(H.coilA1) },
      ],
      route: [
        // Breakout over the board, then a straight climb out to the bracket's
        // open corner. It clears the heat sink by going *outboard* on the way
        // up: the sink is 40 mm square under the motor and the corner is 41 mm
        // out, so the diagonal misses it where a vertical rise would not.
        sharp(
          shift(boardHole(H.coilB1), '+z', CLEAR.overModule),
          cornerAt('towerBaseZ')
        ),
        // Past the towers it hangs rather than turning, so this section curves.
        // It ends at the back of the plug's shell, which is both where the
        // conductors come apart and where they physically enter the connector.
        curve(cornerAt('towerTopZ'), face('plug-motor', '-y')),
      ],
      tail: ['sharp', 'curve'],
    }),
  ],
});

// --- arm --------------------------------------------------------------------

/**
 * The arm, the bearing in its tip, and the encoder that rides in it.
 *
 * The encoder is its own assembly because it is its own thing: a sensor board
 * and the two sockets on it, built into the arm before the arm goes on the
 * motor. The arm carries it, which is what nesting says.
 *
 * ## The way out of the box
 *
 * Both encoder pairs take the same road, so it is written once. They come up
 * beside the motor shaft through the boss moulded into the lid — the *bore* of
 * it, not the open slot beside it, which is clearance for the arm's channel to
 * sweep over — and from that point on they are inside the arm. The channel in
 * the arm's underside carries them out to the sensor.
 *
 * Only the run outboard of the boss is used. The channel also loops right
 * around the motor bore on the inboard side; that loop is slack that lets the
 * arm sweep without dragging on the cable, and the wires join the channel where
 * they come up rather than doubling back down a 2 mm slot to travel it.
 */

/** The lid's wire boss, on the axis of the bore the loom leaves by. */
const boss = (z: string): Point => feature('lid', { xy: 'wireBossCentre', z });

const throughTheLid = (from: Point, socket: string): Section[] => [
  // Across the board to the hole directly under the boss, and only then up.
  // The rise has to be vertical and it has to be *there*: the motor fills the
  // middle 42 mm of the box from the bracket to the lid, and the boss is the
  // one point clear of it that also has a hole beneath it.
  sharp(
    from,
    shift(from, '+z', CLEAR.overModule),
    shift(boardHole(H.underBoss), '+z', CLEAR.overModule),
    boss('seamZ')
  ),
  // Inside the arm from here: the channel, traced out of arm.stl itself. It
  // runs the full diameter of the arm, and the kink in the middle of it is the
  // detour round the motor's own bore — which is the slack that lets the arm
  // sweep its ±135° without dragging on the cable.
  curve(boss('wireBossTopZ'), trace('arm', 'wireSlotPath', { z: 'wireSlotRoofZ' })),
  // Out of the channel's far end, up into the open beam, and on to the back of
  // the socket — which is where the pair really does come apart onto its pins.
  curve(
    shift(
      trace('arm', 'wireSlotPath', {
        end: true,
        z: ['wireSlotRoofZ', 'beamCavityRoofZ'],
      }),
      '+x',
      CLEAR.channelExit
    ),
    shift(face(socket, '-x'), '-x', CLEAR.channelExit)
  ),
];

/**
 * The AS5600 carries two headers, three pins on one side and four on the other,
 * so the loom arrives as two twisted pairs rather than one bundle of four.
 */
const encoder = assembly({
  id: 'encoder',
  parts: ['as5600', 'plug-encoder-power', 'plug-encoder-i2c'],
  routes: [
    loom({
      cable: 'encoder-power',
      between: ['nano', 'as5600'],
      group: 'encoder',
      conductors: [
        { net: 'gnd', from: boardHole(H.gnd) },
        { net: 'v5', from: boardHole(H.v5) },
      ],
      route: throughTheLid(boardHole(H.gnd), 'plug-encoder-power'),
      tail: ['sharp', 'curve'],
    }),
    loom({
      cable: 'encoder-i2c',
      between: ['nano', 'as5600'],
      group: 'encoder',
      conductors: [
        { net: 'sda', from: boardHole(H.a4) },
        { net: 'scl', from: boardHole(H.a5) },
      ],
      route: throughTheLid(boardHole(H.a4), 'plug-encoder-i2c'),
      tail: ['sharp', 'curve'],
    }),
  ],
});

export const armUnit = assembly({
  id: 'arm-unit',
  parts: ['arm', 'bearing'],
  children: [encoder],
});

// --- pendulum ---------------------------------------------------------------

/**
 * The pendulum, built up before it goes on: the 2p already sealed inside the
 * plastic and the magnet glued into the boss. Nothing is wired to it — the
 * magnet is read across an air gap, which is the whole point of it.
 */
export const pendulumUnit = assembly({
  id: 'pendulum-unit',
  parts: ['pendulum', 'coin', 'magnet'],
});

// --- the whole rig ----------------------------------------------------------

/**
 * The whole rig, as one assembly.
 *
 * Children are listed in build order, so `rig.parts` is every part the tutorial
 * places, in the order it places them, and `rig.routes` is every cable it draws.
 * The harness builds from that list, so a part that belongs to no assembly is
 * never drawn, and a route to a pad that does not exist throws when it is
 * resolved rather than quietly going missing from the picture.
 */
export const rig = assembly({
  id: 'rig',
  children: [enclosure, board, motorUnit, armUnit, pendulumUnit],
});
