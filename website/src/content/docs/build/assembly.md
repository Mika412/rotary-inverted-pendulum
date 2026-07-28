---
title: Assemble the rig
description: Mechanical assembly order for the enclosure, motor mount, arm and pendulum.
---

:::caution[This page is a scaffold, not a finished guide]
The repository has never had a written assembly guide — the build was documented
in [video](https://www.youtube.com/watch?v=rKChjuuR7K8) instead. The structure
below is derived from the meshes, the URDF and the wiring documentation, and the
steps marked **TODO** need filling in by someone with the physical rig in front
of them.

They are deliberately left blank rather than guessed at: a plausible-sounding
but wrong torque spec or bearing orientation costs a builder a reprint.
:::

## Before you start

You should already have:

- All parts printed per [Print the parts](/rotary-inverted-pendulum/build/printing/),
  including the pendulum link **with the 2p coin sealed inside** — if you skipped
  the layer-21 pause, reprint it. Its mass and inertia are load-bearing
  assumptions for the whole training pipeline.
- Everything on the [bill of materials](/rotary-inverted-pendulum/build/bom/).
- Hookup wire cut slightly long. Excess is easy to manage; a wire two
  millimetres short turns the next joint into a fight.

## 1. Motor into the motor plate

The `motor plate.stl` part carries the NEMA17 and mounts inside the enclosure.

**TODO:** screw size and length for the NEMA17 face mount (M3 × ?), whether the
plate mounts to the base before or after the motor, and which way the motor's
wire exit should face relative to the cable channel.

## 2. Motor plate into the base

**TODO:** fastener spec and orientation. Note which face of `base.stl` is the
top — the arm mounts at 75 mm above the base origin, and the printed base is
70 mm tall, so the arm plane sits just above the enclosure lip.

## 3. Encoder mounting and magnet

The AS5600 reads a diametric magnet that must sit on the pendulum's rotation
axis, close to the sensor face and centred on it. Getting this wrong is the most
common cause of a rig that reads noise.

**TODO:** magnet retention method, target air gap, and how the AS5600 breakout
is held. The [electronics page](/rotary-inverted-pendulum/build/electronics/)
covers the wiring; this step is the mechanical placement.

:::tip
`TestEncoder` reports magnet strength on startup, so you can verify this step
before committing to glue. See
[First power-on](/rotary-inverted-pendulum/build/first-power-on/).
:::

## 4. Arm onto the motor shaft

The arm's rotation axis is the motor axis, and the arm extends 65 mm to the
pendulum pivot (`ARM_LENGTH_M` in `pendulum_env.py` — this value is a
simulation constant, so if your arm differs, the simulation is wrong).

**TODO:** shaft coupling method (set screw onto the flat? press fit?), and how
to establish the arm's zero position relative to the enclosure so the ±125°
software limits sit symmetrically.

## 5. Pendulum onto the arm

The pendulum swings freely on a bearing at the arm tip, about an axis running
*along* the arm — so it swings in the vertical plane perpendicular to the arm,
which is what lets the arm's rotation drive it.

**TODO:** bearing part and seat fit, shaft retention, and how much free play is
acceptable. Note the goal: the pendulum should swing for a long time when
released, because the [free-swing recording](/rotary-inverted-pendulum/train/sysid/)
used to measure friction depends on getting many clean oscillations.

## 6. Lid and cable management

**TODO:** cable routing so the arm's ±135° travel never tugs the encoder wires.
The software limit exists to stop wires choking, so the mechanical routing has to
be consistent with it.

## Acceptance checks before wiring

Regardless of the gaps above, the rig should pass these before you power
anything:

- The arm rotates freely by hand through its full intended travel, with no
  binding and no wire tension at the extremes.
- The pendulum, released from horizontal, swings for **many** oscillations before
  stopping. A pendulum that stops in two or three swings has too much bearing
  friction, and no amount of training will compensate for it.
- The pendulum hangs straight down at rest, repeatably. That resting pose becomes
  the encoder zero every time the firmware boots.

