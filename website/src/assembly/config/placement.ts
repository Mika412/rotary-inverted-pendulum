/**
 * Where every part of the rig sits, and which way it is offered up.
 *
 * Hand-edited. Move a part by changing its `position`; change the direction it
 * travels in by changing its `approach`. Everything is in metres, because that
 * is what the renderer works in.
 *
 * `position` is in the part's parent frame — for anything inside the box that
 * is the `enclosure` frame below, which carries the quarter turn the enclosure
 * meshes are drawn at, so a part's numbers read the same way round as the box.
 *
 * `features` are named points and paths on the printed parts, in that part's
 * own mesh frame. Cables route through them by name, so re-cutting the arm's
 * wire channel here moves the loom that runs in it.
 */
import type { AssemblyManifest } from '../manifests.ts';

export const PLACEMENT: AssemblyManifest = {
  baseTopZ: 0.07,
  nodePositionM: {
    arm: [0, 0, 0.075],
  },
  airGapM: 0.00142,
  nodeApproachM: {
    base: [0, 0, 0.08],
    lid: [0, 0, 0.08],
    arm: [0, 0, 0.08],
    pendulum: [0.05, 0, 0],
  },
  frames: {
    enclosure: {
      parent: null,
      rotationRad: [0, 0, 1.570796],
    },
    "base-mesh": {
      parent: "base",
      rotationRad: [0, 0, 1.570796],
    },
    "lid-mesh": {
      parent: "lid",
      rotationRad: [0, 0, 1.570796],
    },
    "arm-mesh": {
      parent: "arm",
      rotationRad: [0, 0, 0],
    },
    "pendulum-mesh": {
      parent: "pendulum",
      rotationRad: [0, 0, 1.570796],
    },
  },
  parts: {
    "motor-plate": {
      kind: "printed",
      mesh: "motor plate",
      parent: "enclosure",
      position: [0, 0, 0.0439],
      approach: [0, 0, 0.06],
      note: "cross arms drop into four slots in the enclosure walls",
    },
    motor: {
      kind: "vendor",
      parent: "enclosure",
      position: [0, 0, 0.0479],
      approach: [0, 0, 0.05],
      note: "rear face on the bracket; body press-fits the 42.2 mm socket",
    },
    heatsink: {
      kind: "vendor",
      parent: "enclosure",
      position: [0, 0, 0.0479],
      approach: [0, 0, -0.05],
      note: "sticks to the motor's back, hanging into the bracket's diamond",
    },
    protoboard: {
      kind: "vendor",
      parent: "enclosure",
      position: [-0.008414, 0.013458, 0.0092],
      approach: [0, 0, 0.05],
      note: "lands on four standoff shoulders; pegs locate its corners",
    },
    bearing: {
      kind: "vendor",
      parent: "arm",
      position: [0.0555, 0, 0.014],
      approach: [0.03, 0, 0],
      note: "pressed in from the arm's tip until it meets the shoulder",
    },
    magnet: {
      kind: "vendor",
      parent: "pendulum-mesh",
      position: [0, 0.014, 0],
      approach: [0, 0.02, 0],
      note: "diametric magnet, glued into the boss face, reads on the AS5600",
    },
    coin: {
      kind: "vendor",
      parent: "pendulum-mesh",
      position: [0, 0, 0.064],
      approach: [0, 0, 0.04],
      note: "dropped in at the print pause, then sealed over",
    },
    nano: {
      kind: "vendor",
      parent: "enclosure",
      position: [-0.026194, 0.021078, 0.0108],
      meshRotationRad: [0, 0, -1.570796],
      approach: [0, 0, 0.03],
      source: "diagram:system-without-batteries.drawio",
      approximate: false,
      note: "USB lined up with the measured back-wall slot",
    },
    driver: {
      kind: "vendor",
      parent: "enclosure",
      position: [0.005556, 0.007108, 0.0108],
      meshRotationRad: [0, 0, 0],
      approach: [0, 0, 0.03],
      source: "diagram:system-without-batteries.drawio",
      approximate: true,
      note: "board layout follows the wiring diagram; nothing measures it",
    },
    "cap-electrolytic": {
      kind: "vendor",
      parent: "enclosure",
      position: [0.016486, 0.012958, 0.0108],
      meshRotationRad: [0, 0, 0],
      approach: [0, 0, 0.03],
      source: "diagram:system-without-batteries.drawio",
      approximate: true,
      note: "board layout follows the wiring diagram; nothing measures it",
    },
    "cap-ceramic": {
      kind: "vendor",
      parent: "enclosure",
      position: [0.016486, 0.004958, 0.0108],
      meshRotationRad: [0, 0, 0],
      approach: [0, 0, 0.03],
      source: "diagram:system-without-batteries.drawio",
      approximate: true,
      note: "board layout follows the wiring diagram; nothing measures it",
    },
    as5600: {
      kind: "vendor",
      parent: "arm",
      position: [0.047, 0, 0.014],
      approach: [0, 0, -0.02],
      note: "slides up the groove in the arm's walls, chip face toward the magnet",
    },
    "plug-motor": {
      kind: "vendor",
      parent: "enclosure",
      position: [-0.027, 0, 0.05573],
      approach: [-0.02, 0, 0],
      note: "4-way plug on the motor's coil socket",
    },
    "plug-encoder-power": {
      kind: "vendor",
      parent: "arm",
      position: [0.03787, -0.0065, 0.01694],
      approach: [-0.02, 0, 0],
      note: "3-way socket on the encoder's header",
    },
    "plug-encoder-i2c": {
      kind: "vendor",
      parent: "arm",
      position: [0.03787, 0.00649, 0.01812],
      approach: [-0.02, 0, 0],
      note: "4-way socket on the encoder's header",
    },
    jack: {
      kind: "vendor",
      parent: "enclosure",
      position: [-0.00425, 0.041598, 0.025],
      approach: [0, 0.04, 0],
      note: "panel-mounted through the back wall's jack cutout",
    },
    switch: {
      kind: "vendor",
      parent: "enclosure",
      position: [0.020674, 0.043598, 0.025],
      approach: [0, 0.04, 0],
      note: "panel-mounted through the back wall's switch cutout",
    },
    "bumper-0": {
      kind: "vendor",
      model: "bumper",
      parent: "enclosure",
      position: [-0.035, -0.035, 0.001],
      approach: [0, 0, -0.03],
      note: "self-adhesive foot, into a 9 mm recess in the underside",
    },
    "bumper-1": {
      kind: "vendor",
      model: "bumper",
      parent: "enclosure",
      position: [-0.035, 0.035, 0.001],
      approach: [0, 0, -0.03],
      note: "self-adhesive foot, into a 9 mm recess in the underside",
    },
    "bumper-2": {
      kind: "vendor",
      model: "bumper",
      parent: "enclosure",
      position: [0.035, -0.035, 0.001],
      approach: [0, 0, -0.03],
      note: "self-adhesive foot, into a 9 mm recess in the underside",
    },
    "bumper-3": {
      kind: "vendor",
      model: "bumper",
      parent: "enclosure",
      position: [0.035, 0.035, 0.001],
      approach: [0, 0, -0.03],
      note: "self-adhesive foot, into a 9 mm recess in the underside",
    },
  },
  features: {
    base: {
      topZ: {
        value: 0.07,
        source: "mesh:base.stl",
        note: "seam where the lid lands",
      },
      bumperRecessCentres: {
        value: [-0.035, -0.035, -0.035, 0.035, 0.035, -0.035, 0.035, 0.035],
        source: "mesh:base.stl",
        note: "four cabinet-door bumpers",
      },
      bumperRecessSide: {
        value: 0.009,
        source: "mesh:base.stl",
      },
      bumperRecessDepth: {
        value: 0.001,
        source: "mesh:base.stl",
      },
      boardSeatZ: {
        value: 0.0092,
        source: "mesh:base.stl",
        note: "standoff shoulder the protoboard rests on",
      },
      boardCentre: {
        value: [-0.008414, 0.013458],
        source: "mesh:base.stl",
      },
      boardHoleSpan: {
        value: [0.057077, 0.037327],
        source: "mesh:base.stl",
        note: "peg centres \u2014 the board's corner mounting holes",
      },
      backWallY: {
        value: 0.043598,
        source: "mesh:base.stl",
      },
      backWallThickness: {
        value: 0.002,
        source: "mesh:base.stl",
      },
      usbCentre: {
        value: [-0.025424, 0.025],
        source: "mesh:base.stl",
        note: "back-wall cutout",
      },
      usbSize: {
        value: [0.014, 0.008],
        source: "mesh:base.stl",
      },
      jackCentre: {
        value: [-0.00425, 0.025],
        source: "mesh:base.stl",
        note: "back-wall cutout",
      },
      jackSize: {
        value: [0.01, 0.01],
        source: "mesh:base.stl",
      },
      switchCentre: {
        value: [0.020674, 0.025],
        source: "mesh:base.stl",
        note: "back-wall cutout",
      },
      switchSize: {
        value: [0.021, 0.02],
        source: "mesh:base.stl",
      },
      motorPlateSlotFloorZ: {
        value: 0.0439,
        source: "mesh:base.stl",
        note: "where the motor plate's arms land",
      },
      motorPlateSlotSpanZ: {
        value: [0.0398, 0.0489],
        source: "mesh:base.stl",
      },
      motorPlateSlotWidth: {
        value: 0.0252,
        source: "mesh:base.stl",
      },
    },
    "motor plate": {
      halfWidth: {
        value: 0.0415,
        source: "mesh:motor plate.stl",
      },
      frameThickness: {
        value: 0.004,
        source: "mesh:motor plate.stl",
        note: "the motor's rear face rests on this",
      },
      towerBaseZ: {
        value: 0.004,
        source: "mesh:motor plate.stl",
      },
      towerTopZ: {
        value: 0.012,
        source: "mesh:motor plate.stl",
      },
      motorSocket: {
        value: 0.0422,
        source: "mesh:motor plate.stl",
        note: "square the NEMA17 body press-fits into",
      },
      cornerGapCentres: {
        value: [0.02925, 0.02925, -0.02925, 0.02925, -0.02925, -0.02925, 0.02925, -0.02925],
        source: "mesh:motor plate.stl",
        note: "x,y per open quadrant, anticlockwise from +x+y; the way past the bracket",
      },
      heatsinkOpeningHalfDiagonal: {
        value: 0.028426,
        source: "mesh:motor plate.stl",
        note: "diamond; clearance for the motor's heat sink",
      },
    },
    lid: {
      seamZ: {
        value: 0,
        source: "mesh:lid.stl",
        note: "mesh origin is the seam; the lid mounts at the base's top face",
      },
      skirtDepth: {
        value: 0.004,
        source: "mesh:lid.stl",
        note: "press-fit spigot",
      },
      shaftOpeningDiameter: {
        value: 0.022,
        source: "mesh:lid.stl",
        note: "NEMA17 pilot boss",
      },
      wireSlotReach: {
        value: 0.0295,
        source: "mesh:lid.stl",
      },
      wireBossCentre: {
        value: [0, 0.028064],
        source: "mesh:lid.stl",
        note: "wire exit; also the arm's mechanical hard stop",
      },
      wireBossTopZ: {
        value: 0.01,
        source: "mesh:lid.stl",
      },
    },
    arm: {
      shaftBoreDiameter: {
        value: 0.00495,
        source: "mesh:arm.stl",
        note: "5 mm D-shaft",
      },
      shaftBoreDepth: {
        value: 0.016,
        source: "mesh:arm.stl",
      },
      wireChannelDepth: {
        value: 0.0052,
        source: "mesh:arm.stl",
        note: "the lid's wire boss rides up inside this",
      },
      bearingPocketDiameter: {
        value: 0.0221,
        source: "mesh:arm.stl",
        note: "608 outer race",
      },
      bearingPocketZ: {
        value: 0.014,
        source: "mesh:arm.stl",
      },
      bearingPocketY: {
        value: 0,
        source: "mesh:arm.stl",
      },
      bearingPocketSpanX: {
        value: [0.052, 0.06],
        source: "mesh:arm.stl",
      },
      tipX: {
        value: 0.06,
        source: "mesh:arm.stl",
      },
      wireSlotPath: {
        value: [
          -0.013, 0, -0.012, 0, -0.011, 0,
          -0.01, 0, -0.009, -0.00012, -0.008, -0.00012,
          -0.007, -0.00075, -0.006, -0.00175, -0.005, -0.00325,
          -0.004, -0.0045, -0.003, -0.00525, -0.002, -0.00562,
          -0.001, -0.00588, 0, -0.006, 0.001, -0.00588,
          0.002, -0.00562, 0.003, -0.00525, 0.004, -0.0045,
          0.005, -0.00325, 0.006, -0.00175, 0.007, -0.00075,
          0.008, -0.00012, 0.009, -0.00012, 0.01, 0,
          0.011, 0, 0.012, 0, 0.013, 0,
          0.014, 0, 0.015, 0, 0.016, 0,
          0.017, 0, 0.018, 0, 0.019, 0,
          0.02, 0, 0.021, 0, 0.022, 0,
          0.023, 0, 0.024, 0, 0.025, 0,
          0.026, 0, 0.027, 0, 0.028, 0,
          0.029, 0, 0.03, 0,
        ],
        source: "mesh:arm.stl",
        note: "x, y pairs: the cable's route through the hub's underside",
      },
      wireSlotRoofZ: {
        value: 0.0048,
        source: "mesh:arm.stl",
      },
      beamCavityRoofZ: {
        value: 0.026,
        source: "mesh:arm.stl",
      },
      encoderSlotSpanX: {
        value: [0.04612, 0.04788],
        source: "mesh:arm.stl",
        note: "1.8 mm groove for the AS5600 board",
      },
      encoderSlotHalfWidth: {
        value: 0.01175,
        source: "mesh:arm.stl",
      },
      beamWallHalfWidth: {
        value: 0.01,
        source: "mesh:arm.stl",
      },
    },
    pendulum: {
      bossDiameter: {
        value: 0.0081,
        source: "mesh:pendulum.stl",
        note: "608 inner race",
      },
      bossSpanY: {
        value: [0.003, 0.014],
        source: "mesh:pendulum.stl",
      },
      magnetSeatDiameter: {
        value: 0.0041,
        source: "mesh:pendulum.stl",
        note: "diametric magnet, glued in",
      },
      magnetSeatDepth: {
        value: 0.0015,
        source: "mesh:pendulum.stl",
      },
      magnetFaceY: {
        value: 0.014,
        source: "mesh:pendulum.stl",
      },
      coinPocketDiameter: {
        value: 0.026,
        source: "mesh:pendulum.stl",
        note: "UK 2p, 25.91 mm",
      },
      coinCentreZ: {
        value: 0.064,
        source: "mesh:pendulum.stl",
      },
      tipZ: {
        value: 0.08,
        source: "mesh:pendulum.stl",
      },
    },
  },
};
