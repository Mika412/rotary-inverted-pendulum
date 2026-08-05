---
title: 5. Test the student (optional)
description: A quick tethered sanity check before flashing — expect it below the teacher, because the student was aimed at a different transport.
---

A quick sanity that the student behaves before flashing. Note it runs
under the TETHERED transport, which the device-aimed student was not
optimised for — expect it somewhat below the teacher here; the real
acceptance test is [step 6](/rotary-inverted-pendulum/train/flash/)'s
on-device capture.

```bash
python run_policy.py \
    --policy runs/<run>_async/distill_h16_dagger_dev/student.pt \
    --port /dev/cu.usbserial-1130 \
    --duration-s 30
```

## The offline pre-flight: the sensitivity gate

Gate the policy twice in sim — once as trained, once with the firmware
measurement model switched off (clean observations, identical physics):

```bash
python analyze_sim.py runs/<run>_async/distill_h16_dagger_dev/student.pt --episodes 20
python analyze_sim.py runs/<run>_async/distill_h16_dagger_dev/student.pt --episodes 20 \
    --no-firmware-obs-model
```

A robust policy scores ≈ the same both ways (clean observations are strictly
more information). A policy that **collapses without the measurement model**
has overfitted the simulated measurement statistics instead of solving the
control problem, and the real rig's statistics always deviate from the model
— measured deviations include a ~10 ms actual velocity window vs the 8 ms
modelled. Calibration from matched deployments: **fw-OFF ≥ ~0.7 deployed at
1.000 standalone; fw-OFF ≤ ~0.3 spun (0.13–0.57), four out of four.**
Brittleness is inherited from the teacher (largely seed luck), so gate the
*curriculum teacher* the same way before spending any rig time — a brittle
draw costs one CPU retrain with a new seed, not a wasted fine-tune.

An earlier version of this page gated on the kick test's `arm walk / kick`
with a 13–15° pass band. That threshold rested on one policy and failed its
first out-of-sample test in both directions — a 19.6° student deployed at
1.000 while a 9.4° one spun. The kick protocol remains useful for
disturbance-recovery A/Bs between good policies (`disturbance.py` documents
what each metric is worth); it is not a deployment gate.

