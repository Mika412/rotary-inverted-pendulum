---
title: First power-on
description: Verify the Nano, encoder and motor with the test sketches before running any controller.
---

Four test sketches, in this order. Each one isolates a single failure mode, so
when something is wrong you know which part to look at. Do not skip ahead to a
controller — a mis-seated magnet or an over-driven motor is much easier to
diagnose here.

## Prerequisites

Install [`arduino-cli`](https://arduino.github.io/arduino-cli/latest/installation/)
and the AVR core:

```bash
arduino-cli core install arduino:avr
```

Find your board's port:

```bash
arduino-cli board list
```

Every flash command below follows the same shape (run from the repository root):

```bash
arduino-cli compile --upload -p <PORT> \
    --fqbn arduino:avr:nano:cpu=atmega328 \
    RotaryInvertedPendulum-arduino/<SketchName>
```

:::caution
Use `cpu=atmega328`, not `cpu=atmega328old`. The wrong bootloader setting fails
to upload, usually with a timeout that looks like a cable fault.
:::

## 1. Is the board alive? — `TestHeartbeat`

Blinks a double pulse: ON 100 ms, OFF 100 ms, ON 100 ms, OFF 1000 ms, repeating.
Prints a heartbeat count at 115200 baud.

If this does not run, nothing else will. Check power, cable and bootloader
before touching anything mechanical.

## 2. Does the encoder see the magnet? — `TestEncoder`

Reads the AS5600 with multi-revolution tracking and prints
`pendulum_deg:<value>` at 115200 baud, in a format the Arduino IDE's Serial
Plotter understands.

- LED **solid** during setup, while waiting for magnet detection.
- LED **flashing** once it is producing readings.

| Symptom | Cause |
| --- | --- |
| `Waiting for magnet...` forever | Magnet not close enough, or not on the sensor's axis |
| `Magnet strength too weak` / `too strong` | Air gap wrong — aim for roughly 1–2 mm |
| Readings jump erratically | Magnet off-centre, or not a *diametric* magnet |

Do this before gluing anything in the [assembly
step](/rotary-inverted-pendulum/build/assembly/). Turn the pendulum by hand
through a full revolution and confirm the angle tracks smoothly and wraps
cleanly.

## 3. Does the motor turn cleanly? — `TestMotor`

Oscillates the arm between +90° and −90°, at 20,000 steps/sec — ten times slower
than production, so you can actually watch it.

**Listen to it.** A smooth whirr is correct. A buzzing or grinding sound means
the driver is skipping steps, which usually means the current limit is wrong.

:::danger[Set the current limit before running this]
The TMC2209's Vref sets **RMS** current; the DRV8825's sets **peak**. Carrying a
DRV8825 number across to a TMC2209 over-drives the motor — a factory-default
1.2–1.3 V (≈0.9 A RMS) destroyed a motor within five minutes.

Target **≈0.9 V (0.64 A RMS)** on a TMC2209, or 0.45 V (0.9 A peak) on a
DRV8825, and verify by touch: warm is fine, too hot to hold is not. Full
procedure on the [electronics
page](/rotary-inverted-pendulum/build/electronics/).
:::

Also confirm `MICROSTEPS` in the sketch matches how you actually wired the
driver — **16** for the TMC2209 with MS1 and MS2 high, 8 for a DRV8825. A
mismatch silently halves or doubles the arm's real speed and range while the
firmware believes otherwise, and every downstream calibration inherits the
error.

## 4. Is the serial link fast enough? — `TestSerial`

Echoes bytes so you can measure round-trip time:

```bash
julia --project=./RotaryInvertedPendulum-julia \
    ./RotaryInvertedPendulum-arduino/TestSerial/measure_serial_rtt.jl <PORT> 115200
```

Expect roughly **2.5 ms** round trip, implying about 400 Hz theoretical maximum.
This matters because the tethered fine-tuning step closes its loop over this
link — see [transport delay](/rotary-inverted-pendulum/reference/transport-delay/)
for what that latency does to a learned controller.

## Watching serial output reliably

Opening a serial port resets the Nano, and naive `cat` or `stty` usage tends to
either double-reset the board or capture stale buffered data. Use the helper:

```bash
./RotaryInvertedPendulum-arduino/scripts/monitor_serial.sh <PORT> <BAUD> <DURATION>
```

It handles the reset and flushes the buffer first, giving clean output.

## Optional: the hand-tuned PID

Before the learned controller, this rig balanced with a PID running entirely on
the Nano. It is a good confidence check that your mechanics are sound, and it
needs no laptop after flashing.

```bash
arduino-cli compile --upload -p <PORT> \
    --fqbn arduino:avr:nano:cpu=atmega328 \
    RotaryInvertedPendulum-arduino/PIDControl
```

Serial runs at 500000 baud. `P` toggles CSV data output at 100 Hz, `M` shows
magnet status, `R` resets the PID state. The gains and the reasoning behind them
are in the [tuning
history](/rotary-inverted-pendulum/reference/pid-tuning-history/).

:::note
The PID engages only when the pendulum is already near vertical — it does not
swing up. Lift the pendulum by hand to within about 25° of upright and it will
take over. Swinging up from hanging is something the learned policy does and the
PID does not.
:::

## Next

Your rig works. Now measure it:

[System identification →](/rotary-inverted-pendulum/train/sysid/)
