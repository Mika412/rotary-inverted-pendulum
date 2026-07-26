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

## Next

[6. Flash the standalone sketch →](/rotary-inverted-pendulum/train/flash/)
