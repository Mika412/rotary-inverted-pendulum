---
title: Serial protocols
description: The binary LowLevelServer protocol and the text protocol used by the on-device PID sketch.
---

Two sketches speak to a host, and they use different protocols.

## `LowLevelServer` — binary, 2,000,000 baud

The Nano acts as a low-level server: the host reads state, decides an action,
and sends it back. This is the transport used for real-rig fine-tuning and for
any computer-side controller.

Commands are a single byte, some followed by a little-endian IEEE-754 `float`
(4 bytes, AVR native order).

| Byte | Command | Payload | Reply |
| --- | --- | --- | --- |
| `0x01` | `CMD_READY` | — | echoes `0x01` |
| `0x02` | `CMD_GET_STATE` | — | 20-byte state packet (below) |
| `0x03` | `CMD_SET_ACCEL` | `float` angular acceleration, rad/s² | — |
| `0x04` | `CMD_ENGAGE_MOTOR` | — | — |
| `0x05` | `CMD_DISENGAGE_MOTOR` | — | — |
| `0x06` | `CMD_TARE_PENDULUM` | — | re-zeroes the pendulum angle to the current reading |
| `0x07` | `CMD_SET_TARGET` | `float` absolute motor position, rad | — |

:::note[`0x03` is acceleration, not position]
`CMD_SET_ACCEL` was formerly `CMD_SET_TARGET` and took a position. The switch to
commanding acceleration is the change that made on-device deployment viable —
the reasoning is in [transport
delay](/rotary-inverted-pendulum/reference/transport-delay/). Position-mode
commanding still exists, but moved to `0x07`.
:::

### The state packet

`CMD_GET_STATE` replies with five little-endian values, 20 bytes total:

| Offset | Type | Field |
| --- | --- | --- |
| 0 | `uint32` | timestamp, microseconds |
| 4 | `float` | motor position, rad |
| 8 | `float` | pendulum position, rad |
| 12 | `float` | motor velocity, rad/s |
| 16 | `float` | pendulum velocity, rad/s |

Two details matter if you are writing a client:

- **The timestamp is the sample time, not the reply time.** It is taken from the
  buffer entry the positions came from, so `(t, pos, vel)` is self-consistent and
  can be time-aligned without inheriting up to a sample of bias.
- **Velocities are finite differences over a window**, not instantaneous
  derivatives — `(newest − oldest)/Δt` across the firmware's 8 ms sampling
  window. The simulation reproduces this exactly, including the quantisation,
  because the resulting noise is something the policy trains against.
- **Signs are flipped** relative to the raw sensors, to match the simulation
  frame the Python clients expect.

### Safety behaviour you cannot override

Past the ±125° soft limit, the firmware ignores the host's acceleration command
and applies a fixed opposing brake. This is not the same as commanding zero
acceleration: with `allow_reverse` enabled, zero means *hold current speed*, so a
motor travelling outbound at 5 rad/s would coast into the hard stop if the host
went quiet. The brake decelerates regardless of host liveness.

A dropped byte is handled by bailing out: `CMD_SET_ACCEL` reads its 4 payload
bytes with a 5 ms timeout, and a short read aborts the command rather than
consuming the next one. The following command re-syncs the parser.

### Handshake

Always call ready-check after opening the port and wait for the echo. Opening a
serial port resets the Nano, so anything sent before the sketch is running is
lost.

## `PIDControl` — text, 500,000 baud

The self-contained PID sketch takes single-character commands:

| Command | Effect |
| --- | --- |
| `P` | toggle CSV data output at 100 Hz |
| `M` | print magnet status |
| `R` | reset PID state |

LED blink rate reports state: fast (100 ms) means waiting, slow (500 ms) means
data output is enabled.

There is also an older text protocol (`"1"` ready, `"2"` motor position, `"3"`
pendulum position, `"4 <pos>"` set target, `"5"` start, `"6"` stop) used by the
legacy gamepad script.

## `RLControl` — no host protocol

The standalone RL sketch does not take commands. It prints telemetry at 500,000
baud, which is what `analyze_onboard.py` captures to score a deployment. On boot
it also prints `[boot] policy(hanging/upright) = …`, which you can compare
against the PyTorch student on the same reference inputs if you suspect a weight
export or PROGMEM bug.

Because opening the port resets the board, hang the pendulum still *before*
launching a capture — the resting pose becomes the encoder zero.
