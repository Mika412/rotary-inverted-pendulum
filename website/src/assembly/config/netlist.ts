/**
 * What connects to what: every net, and the pad it lands on at each end.
 *
 * Hand-edited. A hop is `[part, pad]`, and the pads have to exist on the parts
 * in `vendor.ts` — a wire to a pad that is not there throws when it resolves,
 * naming the route, rather than quietly going missing from the picture.
 *
 * `pins` are the Nano's, and they must match the `DIR_PIN`, `STEP_PIN` and
 * `ENABLE_PIN` declared in `firmware/RLControl/RLControl.ino`. Nothing checks
 * that for you; if you move a pin in the sketch, move it here.
 */
export interface Netlist {
  pins: Record<string, number>;
  nets: {
    id: string;
    label: string;
    colour: string;
    kind: 'firmware' | 'diagram';
    note?: string;
    path: [string, string][];
  }[];
}

export const NETLIST: Netlist = {
  pins: {
    dir: 2,
    step: 9,
    enable: 5,
  },
  nets: [
    {
      id: "v12",
      label: "12 V rail",
      colour: "#d92b2b",
      kind: "diagram",
      path: [
        ["jack", "+"],
        ["switch", "in"],
        ["switch", "out"],
        ["driver", "VMOT"],
        ["nano", "VIN"],
      ],
    },
    {
      id: "gnd",
      label: "Ground",
      colour: "#1b1b1b",
      kind: "diagram",
      path: [
        ["jack", "-"],
        ["driver", "GND"],
        ["nano", "GND"],
        ["as5600", "GND"],
      ],
    },
    {
      id: "v5",
      label: "5 V to the encoder",
      colour: "#e8871a",
      kind: "diagram",
      path: [
        ["nano", "5V"],
        ["as5600", "VCC"],
      ],
    },
    {
      id: "sda",
      label: "I\u00b2C data",
      colour: "#f06292",
      kind: "diagram",
      note: "A4 is the ATmega328 hardware SDA \u2014 not a firmware choice",
      path: [
        ["nano", "A4"],
        ["as5600", "SDA"],
      ],
    },
    {
      id: "scl",
      label: "I\u00b2C clock",
      colour: "#c2185b",
      kind: "diagram",
      note: "A5 is the ATmega328 hardware SCL \u2014 not a firmware choice",
      path: [
        ["nano", "A5"],
        ["as5600", "SCL"],
      ],
    },
    {
      id: "dir",
      label: "Direction",
      colour: "#2e9e4f",
      kind: "firmware",
      path: [
        ["nano", "D2"],
        ["driver", "DIR"],
      ],
    },
    {
      id: "step",
      label: "Step",
      colour: "#2e9e4f",
      kind: "firmware",
      note: "must be Timer1 OC1A \u2014 FastAccelStepper drives stepping from its ISR",
      path: [
        ["nano", "D9"],
        ["driver", "STEP"],
      ],
    },
    {
      id: "enable",
      label: "Enable",
      colour: "#e0c020",
      kind: "firmware",
      note: "active low on both the TMC2209 and the DRV8825",
      path: [
        ["nano", "D5"],
        ["driver", "EN"],
      ],
    },
    {
      id: "coil-a",
      label: "Motor coil A",
      colour: "#9aa0a6",
      kind: "diagram",
      note: "identify each coil with a multimeter \u2014 the low-resistance pair is one coil",
      path: [
        ["driver", "1A"],
        ["motor", "A+"],
      ],
    },
    {
      id: "coil-a-return",
      label: "Motor coil A return",
      colour: "#9aa0a6",
      kind: "diagram",
      path: [
        ["driver", "1B"],
        ["motor", "A-"],
      ],
    },
    {
      id: "coil-b",
      label: "Motor coil B",
      colour: "#9aa0a6",
      kind: "diagram",
      path: [
        ["driver", "2A"],
        ["motor", "B+"],
      ],
    },
    {
      id: "coil-b-return",
      label: "Motor coil B return",
      colour: "#9aa0a6",
      kind: "diagram",
      path: [
        ["driver", "2B"],
        ["motor", "B-"],
      ],
    },
  ],
};
