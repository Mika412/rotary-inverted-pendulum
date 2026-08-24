/**
 * The build script: the whole assembly, in the order it is really done.
 *
 * This is the file most edits touch. A step names itself (`id` is its URL hash,
 * so every step is linkable), says what it is doing and why, cites the measured
 * millimetres behind the claim, frames the camera on a part rather than at a
 * coordinate, and lists the verbs that get the scene into its finished state.
 *
 * Parts are added to an assembly in `rig.ts`, never to a step. A step asks an
 * assembly for what it owns — `board.install()`, `motorUnit.wire('coils')` — so
 * it reads as the instruction it is.
 */
import type { AssemblyStep } from './state.ts';
import { callout, ghost, highlight } from './state.ts';
import {
  armUnit,
  board,
  enclosure,
  motorUnit,
  pendulumUnit,
} from './rig.ts';

/**
 * The build script.
 *
 * A step says which parts appear and why, never where — every placement is
 * measured into `public/sim/assembly.json`. What it names are **assemblies**,
 * which own their parts and the cables that run among them, so a step reads as
 * the instruction it is: put the board in, wire its power, fit the plug.
 *
 * `<assembly>.wire('stage')` turns on the routes in that stage, not the nets.
 * The two differ wherever one net is drawn by more than one cable — ground runs
 * across the board *and* out to the encoder in a twisted pair — and keying on
 * the net turned both on at once.
 */

export const ASSEMBLY_STEPS: AssemblyStep[] = [
  {
    id: 'base',
    title: 'Start with the base',
    body: 'The printed enclosure. Its side walls carry ventilation slots, the back panel is cut for the USB cable, the power jack and the rocker switch, and the underside has four recesses for rubber feet. Everything else drops into it: the whole rig is press-fit, with no fasteners anywhere.',
    cite: 'Bumper recesses measured at 9 × 9 × 1 mm, on a 70 mm square pitch.',
    camera: { wide: true, yaw: 0.9, pitch: 0.32 },
    actions: [enclosure.fit('base')],
  },

  {
    id: 'board',
    title: 'Start the board on the bench',
    body: 'The electronics are their own sub-assembly, built off the rig. Start with the bare 40 × 60 mm protoboard, on the bench, where you can reach both sides of it.',
    cite: 'Peg centres measured 57.1 × 37.3 mm apart — a 40 × 60 board’s corner holes.',
    camera: { focus: 'protoboard', yaw: 0.9, pitch: 0.66, fill: 0.44 },
    actions: [board.bench('protoboard')],
  },
  {
    id: 'nano',
    title: 'Arduino Nano on headers',
    body: 'The Nano sits in female headers rather than soldered flat, because you will pull it out repeatedly while iterating on firmware. Its USB end will face the back panel once the board goes in.',
    cite: 'Board layout follows the wiring diagram; nothing in the enclosure fixes it.',
    camera: { focus: 'nano', yaw: 0.9, pitch: 0.66, fill: 0.34 },
    actions: [board.bench('nano'), highlight('nano')],
  },
  {
    id: 'driver',
    title: 'Stepper driver on headers',
    body: 'The TMC2209 goes in headers too — it is the part most likely to be swapped, and it is the one component that can destroy the motor if its current limit is wrong. Set Vref to about 0.9 V *before* the motor is ever connected.',
    cite: 'TMC2209 sets RMS current, the DRV8825 peak — see the electronics page.',
    camera: { focus: 'driver', yaw: 1.15, pitch: 0.66, fill: 0.34 },
    actions: [
      board.bench('driver'),
      highlight('driver'),
      callout('driver', 'Vref ≈ 0.9 V before the motor goes on'),
    ],
  },
  {
    id: 'caps',
    title: 'Decoupling capacitors',
    body: 'A 22 µF electrolytic and a 100 nF ceramic go right next to the driver’s power pins. The motor coils switch thousands of times a second and each switch kicks the supply; these absorb it. Without them the encoder reads noise and the Nano can glitch.',
    cite: 'Two-stage decoupling on the 12 V rail at the driver’s VMOT pin.',
    camera: { focus: 'cap-electrolytic', yaw: 1.0, pitch: 0.6, fill: 0.24 },
    actions: [
      board.bench('cap-electrolytic', 'cap-ceramic'),
      highlight('cap-electrolytic', 'cap-ceramic'),
    ],
  },
  {
    id: 'board-wiring',
    title: 'Wire the board on the bench',
    body: 'Solder the links now, while you can still turn the board over: twelve volts and ground between the driver and the Nano, and the three control lines. This is why the board is built off the rig — once it is at the bottom of a closed box you can reach one side of it and not the other. Cut the hookup wire long; excess is easy to manage, a wire two millimetres short turns the next joint into a fight.',
    cite: 'DIR, STEP and ENABLE read from RLControl.ino, and confirmed against the wiring diagram.',
    camera: { focus: 'protoboard', yaw: 0.9, pitch: 0.72, fill: 0.5 },
    actions: [board.wire('board')],
  },
  {
    id: 'board-in',
    title: 'The board assembly goes in',
    body: 'Only now does the populated board go into the enclosure — headers, modules, capacitors and every link already soldered. It lowers in from the top onto four standoffs as one piece, wiring and all.',
    cite: 'Standoff shoulders set the height; the pegs above locate the corner holes.',
    camera: { focus: 'protoboard', yaw: 0.9, pitch: 0.78, fill: 0.4 },
    actions: [board.install()],
  },

  {
    id: 'jack',
    title: 'Barrel jack through the back',
    body: 'The 5.5 × 2.1 mm socket pushes in from outside and is captured by the panel. It carries the 12 V rail that feeds the driver directly and the Nano through its onboard regulator.',
    cite: 'Cutout measured 10 × 10 mm, centred 25 mm above the floor.',
    camera: { focus: 'jack', yaw: 3.35, pitch: 0.2, fill: 0.22 },
    actions: [enclosure.fit('jack'), ghost('base')],
  },
  {
    id: 'switch',
    title: 'Rocker switch through the back',
    body: 'The 20 mm rocker breaks the 12 V line, so you can power-cycle the rig without pulling the plug. You will do that constantly: it is the first thing to try when the controller misbehaves.',
    cite: 'Cutout measured 21 × 20 mm for a 20 mm round switch.',
    camera: { focus: 'switch', yaw: 3.35, pitch: 0.2, fill: 0.22 },
    actions: [enclosure.fit('switch'), ghost('base')],
  },
  {
    id: 'power-wiring',
    title: 'Power in from the back panel',
    body: 'Three flying leads that could not be made until now: the jack to the switch, the switch on to the driver’s VMOT, and the jack’s ground to the board. These are the only joints in the box, and they are short on purpose — everything else was done on the bench.',
    cite: 'Twelve volts feeds the driver directly and the Nano through its regulator.',
    camera: { focus: 'protoboard', yaw: 0.9, pitch: 0.78, fill: 0.55 },
    actions: [board.wire('panel'), ghost('base')],
  },

  {
    id: 'bracket',
    title: 'Motor bracket on the bench',
    body: 'The motor and its bracket are the second sub-assembly, and they go together off the rig for the same reason: once the bracket is seated in the enclosure you cannot reach its socket.',
    cite: 'Slot floor measured at 43.9 mm above the enclosure floor; slot width 25.2 mm.',
    camera: { focus: 'motor-plate', yaw: 0.9, pitch: 0.35, fill: 0.4 },
    actions: [motorUnit.bench('motor-plate')],
  },
  {
    id: 'motor',
    title: 'NEMA17 into the bracket',
    body: 'The motor body press-fits into the square socket formed by the bracket’s four corner towers, resting its rear face on the frame. The towers stop it turning under load — a stepper skipping steps is bad enough without the whole motor moving.',
    cite: 'Socket measured at 42.2 mm square — a NEMA17 body is 42.3 mm.',
    camera: { focus: 'motor', yaw: 0.9, pitch: 0.3, fill: 0.42 },
    actions: [motorUnit.bench('motor')],
  },
  {
    id: 'heatsink',
    title: 'Heat sink on the motor’s back',
    body: 'The bracket’s central opening is a diamond, not a square: too small for the motor to fall through, and shaped to clear the finned heat sink stuck to its rear face. The sink keeps the motor comfortable through the long training sessions the RL pipeline needs.',
    cite: 'Diamond opening: 40.2 mm side, against a 42.3 mm motor.',
    camera: { focus: 'heatsink', yaw: 0.9, pitch: -0.2, fill: 0.4 },
    actions: [motorUnit.bench('heatsink'), highlight('heatsink')],
  },
  {
    id: 'motor-in',
    title: 'The motor unit goes in',
    body: 'Bracket, motor and heat sink lower into the enclosure together. Four cross arms on the bracket slide down slots moulded into the walls and land on a ledge, which is what sets the motor’s height for good.',
    cite: 'Bracket + frame + motor body = 69.9 mm, against a 70 mm lid underside.',
    camera: { focus: 'motor', yaw: 0.9, pitch: 0.4, fill: 0.42 },
    actions: [motorUnit.install(), ghost('base')],
  },
  {
    id: 'motor-wiring',
    title: 'Motor coil wiring',
    body: 'The motor arrives with a four-way ribbon already on it — red, black, blue, green, in that order — that plugs into the socket on the side of its body. The other end goes to the driver’s coil outputs. Get a pair swapped and the motor buzzes without turning, and the coil pin order differs between the TMC2209 and the DRV8825, so check yours against the electronics page.',
    cite: 'Both coils wired, with the pin numbers read from the firmware.',
    camera: { focus: 'motor', yaw: 1.1, pitch: 0.6, fill: 0.6 },
    actions: [motorUnit.fit('plug-motor'), motorUnit.wire('coils'), ghost('base', 'motor-plate')],
  },

  {
    id: 'lid',
    title: 'Lid on',
    body: 'The lid’s skirt press-fits into the top of the base. Its central opening takes the motor’s 22 mm pilot boss, and the slot running off it is where the encoder wires will escape — through a boss that doubles as the arm’s mechanical hard stop.',
    cite: 'Shaft opening measured at 22.0 mm; skirt 4 mm deep.',
    camera: { wide: true, yaw: 0.9, pitch: 0.3 },
    actions: [enclosure.fit('lid')],
  },

  {
    id: 'encoder',
    title: 'AS5600 into the arm, from underneath',
    body: 'The arm is the third sub-assembly. The sensor board slides up into a groove milled across the arm’s side walls — 1.8 mm wide for a 1.55 mm board — which sets the air gap for you, with the chip facing outward toward where the magnet will be. `TestEncoder` reports magnet strength on startup, so check it before committing any glue.',
    cite: 'Groove and magnet seat are measured, and the gap between them comes out at 1.4 mm.',
    camera: { focus: 'as5600', yaw: 0.55, pitch: -0.15, fill: 0.26 },
    actions: [
      armUnit.bench('arm', 'as5600', 'plug-encoder-power', 'plug-encoder-i2c'),
      ghost('arm'),
      callout('as5600', '1.4 mm air gap to the magnet'),
    ],
  },
  {
    id: 'bearing',
    title: 'Bearing into the arm tip',
    body: 'A single 608 skate bearing presses into the pocket at the end of the arm until it meets a shoulder. Skate bearings are built for low friction and are easy to de-shield and re-lubricate, which matters — the friction measurement later depends on the pendulum swinging freely for a long time.',
    cite: 'Pocket measured 22.1 mm at 14 mm above the arm’s underside.',
    camera: { focus: 'bearing', yaw: 0.5, pitch: 0.24, fill: 0.26 },
    actions: [armUnit.bench('bearing'), ghost('arm')],
  },
  {
    id: 'arm-on',
    title: 'Arm onto the motor shaft',
    body: 'The completed arm drops onto the motor’s flatted 5 mm shaft. Its D-shaped bore matches, so it cannot slip under acceleration, and it comes to rest on the lid’s wire boss — that boss is the hard stop that sets the arm’s height.',
    cite: 'Boss top and shaft-minus-bore agree to a tenth of a millimetre.',
    camera: { focus: 'arm', yaw: 0.75, pitch: 0.28, fill: 0.42 },
    actions: [armUnit.install()],
  },
  {
    id: 'sensor-wiring',
    title: 'Encoder wiring through the lid slot',
    body: 'The last four wires — 5 V, ground and the two I²C lines, twisted into one loom — come up through the keyhole slot beside the shaft and are inside the arm from there on. The channel in the arm’s underside curves right around the motor bore before running out to the sensor: that curve is where the cable’s slack lives, so the arm can sweep without dragging on it.',
    cite: 'Routed along arm.wireSlotPath, traced out of the mesh itself.',
    camera: { focus: 'arm', yaw: 0.95, pitch: 0.45, fill: 0.62 },
    actions: [armUnit.wire('encoder'), ghost('lid', 'arm')],
  },

  {
    id: 'pendulum',
    title: 'Pendulum through the bearing',
    body: 'The pendulum is built up before it goes on: the 2p coin is already sealed inside the plastic — the print pauses at layer 21 so you can drop it in — and a small magnet is glued into the end of the boss, on the rotation axis, facing the sensor. Then the 8.1 mm boss slides through the bearing’s bore.',
    cite: 'Boss 8.1 mm into an 8 mm bore; coin pocket 26.0 mm for a 25.91 mm 2p.',
    camera: { focus: 'pendulum', yaw: 0.65, pitch: 0.18, fill: 0.5 },
    actions: [
      pendulumUnit.fit(),
      highlight('magnet'),
      callout('magnet', 'diametric — poles across the disc'),
    ],
  },
  {
    id: 'feet',
    title: 'Four feet underneath',
    body: 'Cabinet door bumpers press into the four recesses in the underside. Without them the rig walks across the desk during swing-up, which is more disruptive than it sounds when you are trying to record a clean free swing.',
    camera: { wide: true, yaw: 1.2, pitch: -0.28 },
    actions: [enclosure.fit('bumper-0', 'bumper-1', 'bumper-2', 'bumper-3')],
  },
  {
    id: 'done',
    title: 'Built',
    body: 'That is the whole rig — about £20 in parts, no fasteners, every joint press-fit. Next: power it on and check each subsystem in turn before running any controller.',
    camera: { wide: true, yaw: 0.9, pitch: 0.28 },
    actions: [],
  },
];
