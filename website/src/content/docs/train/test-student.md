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

## The offline pre-flight — do this one even if you skip the tethered run

Undisturbed sim metrics can rank a policy *best* that then fails on the rig.
That has happened here: one candidate had the lowest arm σ, the lowest
off-centre and the highest gate of its cohort, and deployed at 0.803 with 44
drops while its rivals held 1.000. Kicking the pendulum with a repeatable
impulse is the only offline measurement that flagged it.

```bash
python analyze_sim.py runs/<run>_async/distill_h16_dagger_dev/student.pt \
    --kick-amp 0.45 --kick-ticks 3 --kick-every-s 6 \
    --episodes 24 --kick-episode-s 60
```

**Read `arm walk / kick` and nothing else.** Good policies sit at 13–15°; the
one that failed on the rig sat at 18.3°. Treat it as a pass/fail gate, not a
ranking — the current champion scored *slightly worse* than its predecessor on
every other line of that report and then deployed better than anything before
it. `disturbance.py` records which metrics are worth what, and why critical
kick amplitude measures the plant rather than the policy.

