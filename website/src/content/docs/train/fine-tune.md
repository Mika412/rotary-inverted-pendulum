---
title: 2. Fine-tune on the real rig
description: Closing the sim-to-real gap with 30–80 real-rig episodes, using the async orchestrator.
---

The sim policy will not balance on hardware on its first try
(sim-to-real gap). Async fine-tuning closes that gap with ~30–80
real-rig episodes (~10–25 min wall clock).

Flash the LowLevelServer first so the laptop can drive the rig over the
binary protocol:

```bash
arduino-cli compile --upload -p /dev/cu.usbserial-1130 \
    --fqbn arduino:avr:nano:cpu=atmega328 \
    RotaryInvertedPendulum-arduino/LowLevelServer
```

Then run the async orchestrator. Rate, action mode, action scale, the
reward extras and the smoothing window are all either defaults or
**inherited from the checkpoint's `config.json`** — you do not retype them,
and `run_config.check_config` aborts if they ever disagree.
`--resume-buffer` is optional on the first session; on subsequent sessions,
point it at the previous run's `replay_buffer.pkl` to keep accumulated
real-rig transitions:

```bash
cd RotaryInvertedPendulum-python/src/rl

# First fine-tune session
python finetune_async.py \
    --policy runs/<sim-run>_stage3/best_model.zip \
    --port /dev/cu.usbserial-1130 \
    --episodes 50 \
    --run-name async_v1

# Subsequent sessions, buffer-resumed
python finetune_async.py \
    --policy runs/async_v1/best_model.zip \
    --resume-buffer runs/async_v1/replay_buffer.pkl \
    --port /dev/cu.usbserial-1130 \
    --episodes 30 \
    --run-name async_v1_extend
```

Architecture detail: [the async control
runtime](/rotary-inverted-pendulum/reference/async-control/).

Add `--mirror-augment` to store each transition's mirror image too. Rig time
is the scarce resource and these sessions are lopsided — measured 2.5–4×
more arrivals at upright from one side than the other — so mirroring doubles
what each episode covers at no rig cost. [Mirror
symmetry](/rotary-inverted-pendulum/reference/symmetry/) covers what it gives
up (≤1° of per-rig base-tilt specialisation, less than the sim curriculum
already randomises over).

## Listen to the motor

The orchestrator disengages the motor for `--reset-settle-s` (default 15)
between episodes so the pendulum coasts to rest passively. **Listen** to
the motor during the first few episodes — a smooth whirr is fine, a
buzzy/grinding sound means step-skipping (drop `MOTOR_ACCELERATION` in
`LowLevelServer.ino` and `RLControl.ino` from 50 k → 30 k and re-flash).

