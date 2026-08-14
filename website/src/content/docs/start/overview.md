---
title: What you are building
description: An overview of the rig, what each part does, and which path through this documentation you want.
---

A rotary inverted pendulum: a rod hanging off the end of a motor-driven arm,
which the controller has to swing up and then hold vertical. It is the standard
demonstration problem for feedback control, because vertical is an *unstable*
equilibrium — the only way to stay there is to keep moving the thing underneath.

Total cost is around **£20** in parts. The equivalent teaching rig from a
lab-equipment vendor is roughly two hundred times that.

## The parts, and what each one does

| Part | Job |
| --- | --- |
| NEMA17 stepper + TMC2209 driver | Rotates the arm. The stepper is commanded in *acceleration*, not position. |
| AS5600 magnetic encoder | Measures the pendulum's angle, 12-bit (4096 counts per turn), over I²C. |
| Arduino Nano (ATmega328) | Reads the encoder, runs the controller, drives the stepper. |
| Printed enclosure, arm, pendulum | The mechanics. The pendulum link has a slot for a 2p coin as tip mass. |

The Nano is the interesting constraint. It has 2 KB of RAM and no floating-point
unit, and it has to close a control loop fast enough to catch a falling
pendulum. That constraint is what shapes the entire training pipeline.

## Two ways to run it

**Tethered.** The Nano acts as a low-level server over USB serial; a laptop
reads state, decides an action, and sends it back. This is how the policy is
fine-tuned on the real rig, and how any computer-side controller would run.

**Standalone.** The controller runs entirely on the Nano, no laptop attached.
This is the end state, and getting there is most of what the documentation
below is about — a network small enough to fit has to be *distilled* from a
larger one, not trained directly.

## Which path do you want?

- **I want to build one.** Start at the [bill of
  materials](/rotary-inverted-pendulum/build/bom/) and work forwards. The build
  section ends with a rig that responds to test sketches.
- **I have a rig and want it balancing.** Go to [the
  pipeline](/rotary-inverted-pendulum/train/pipeline/). It is ordered, each step
  is idempotent, and it tells you what to check before moving on.
- **I want to understand the design decisions.** The *How it works* section is
  the reasoning: what a [transition](/rotary-inverted-pendulum/reference/transitions/)
  is, what gets [randomised](/rotary-inverted-pendulum/reference/domain-randomization/)
  and why, and the [transport-delay](/rotary-inverted-pendulum/reference/transport-delay/)
  work that made on-device deployment possible at all.
- **I just want to see it work.** The demo on the [front
  page](/rotary-inverted-pendulum/) runs the deployed network in your browser.

## A note on honesty in these docs

Several numbers in this documentation are measured, and are reported with the
date and conditions of the measurement. Where something was tried and failed —
training a tiny network directly with RL, for instance, which failed on hardware
twice — that is written down too, because the failure is the reason the pipeline
has the shape it does.

The scoring metrics used throughout deliberately avoid the observation the
policy sees: an "is it upright?" check computed from the policy's own inputs can
be satisfied by spinning the arm continuously, and early evaluations were fooled
exactly that way.
