---
title: Buy instead of build?
description: How this rig compares to commercial and kit alternatives, and what you give up either way.
---

Building is not the only option, and it is worth being clear about the
trade-offs before you spend a weekend printing parts.

## The options

| Option | Cost | Notes |
| --- | --- | --- |
| This project | ~£20 | Printed parts, hobby stepper, magnetic encoder. Full source and docs. |
| AliExpress kits | \$100–\$200 | [Search results](https://www.aliexpress.com/w/wholesale-rotary-inverted-pendulum.html). Assembled mechanics, variable quality, usually no documented control stack. |
| Quanser QUBE Servo 2 | ~£4,500 | [Product page](https://www.quanser.com/products/qube-servo-2). Precision hardware, courseware, MATLAB/Simulink integration, support. |

## What you get by building this one

- **The whole stack is inspectable.** Every constant, measurement and design
  decision is in the repository, including the ones that turned out to be wrong.
- **It is a real sim-to-real problem.** The rig is imprecise enough that
  policies trained purely in simulation do *not* transfer, which is what makes
  the fine-tuning and distillation steps meaningful rather than ceremonial.
- **It runs untethered.** The end state is a self-contained device with a
  learned controller on an 8-bit microcontroller.

## What you give up

- **Precision.** A stepper driving a printed arm through a printed bearing seat
  is not a servo on a precision gearbox. Friction varies between rebuilds — which
  is why [system identification](/rotary-inverted-pendulum/train/sysid/) is a
  required step rather than an optional one.
- **Repeatability between rigs.** Your friction parameters will not match the
  ones in this repository, and the champion policy's numbers were measured on
  one specific rig.
- **Support and courseware.** There is no lab manual and no one to email.

## If you are choosing for teaching

The commercial rigs exist for good reasons: they survive a lab full of students,
they come with material, and they behave identically across benches. If you need
twelve rigs that all do the same thing on the same afternoon, buy them.

If you want one rig where a student can see and change every layer — the
mechanics, the firmware, the reward function, the network — this is a better
object to learn from, and it costs a rounding error by comparison.

## Related work

Other people's takes on the same problem, several of which informed this build:

- [Desktop Inverted Pendulum, build-its-inprogress](https://build-its-inprogress.blogspot.com/2016/08/desktop-inverted-pendulum-part-2-control.html) ([full series](https://build-its-inprogress.blogspot.com/search/label/Pendulum))
- [Furuta pendulum, dagor.dev](https://www.dagor.dev/blog/furuta-pendulum)
- [The Rotary Control Lab — Quanser brochure (PDF)](https://tecsolutions.us/sites/default/files/quanser/The%20Rotary%20Control%20Lab%20Brochure_4.pdf)
- [Survey paper, *Trans. Inst. Meas. Control*](https://journals.sagepub.com/doi/full/10.1177/00202940211035406)
- Video builds: [[1]](https://www.youtube.com/watch?v=2koXcs0IhOc), [[2]](https://www.youtube.com/watch?v=bY4t6yfBA24), [[3]](https://www.youtube.com/watch?v=VVQ-PGfJMuA)
