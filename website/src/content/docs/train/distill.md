---
title: 4. Distill the student
description: Behaviour cloning then DAgger aimed at the deployment transport — the step that makes a network small enough to run on the Nano actually work there.
---

Two sub-steps: behaviour cloning, then DAgger **aimed at the transport
the network will deploy into**. Both cheap (~1 min + ~20 min, no rig).

```bash
# 4a. Behaviour cloning: real-rig buffer + sim-augmented teacher rollouts
python distill.py \
    --teacher runs/<run>_async/best_model.zip \
    --buffer  runs/<run>_async/replay_buffer.pkl \
    --out-dir runs/<run>_async/distill_h16_aug \
    --hidden 16

# 4b. DAgger at the DEVICE transport (the step that makes it deploy)
python dagger_distill.py \
    --teacher runs/<run>_async/best_model.zip \
    --bc-dir  runs/<run>_async/distill_h16_aug \
    --out-dir runs/<run>_async/distill_h16_dagger_dev \
    --transport device
```

## Why this shape

All measured, 2026-07-22:

- **H=16 is the production width.** Software float on the AVR costs
  ~19 µs per multiply-accumulate, so H=16 lands at ~12 ms — inside the
  20 ms tick at 50 Hz. H=32 float (~35-40 ms) does not fit and silently
  sagged the loop (measured at 35 Hz: 28.6 ms tick → 25 Hz actual, which
  turned a balancing policy into a spinner). `analyze_onboard --expect-hz`
  exists to catch exactly that.
- **BC alone does not deploy** (closed-loop gate 0.12 despite good MSE —
  covariate shift near the unstable equilibrium). DAgger fixes it, but
  ONLY when its rollouts run under the deployment transport: the
  standalone Nano has no serial/USB/host latency (`--transport device`),
  and aiming the DAgger there was worth 0.881 → 0.892 on the rig.
- **Do not skip imitation in favour of training a tiny actor with RL
  directly.** Tried twice: the tiny
  direct-RL actors matched the big teacher in sim and even fine-tuned
  well tethered, then failed standalone at ~0.24 both times — RL
  produces sharp, timing-exploiting controllers that break when the
  transport changes, while the student's slight underfit acts as gain
  reduction and buys exactly that robustness.

## Acceptance — judge relative to the teacher

Judge the DAgger gate (printed per round — honest balanced
fraction in the device-transport sim) **relative to the teacher's own gate,
not against an absolute bar.** Sim systematically under-predicts smooth
students on the rig, and it under-predicts them *most* when the teacher was
rig-fine-tuned, because such a teacher has adapted to dynamics the rigid-base
sim cannot reproduce: measured 0.763 → 0.892, 0.569 → 0.881, and the current
champion gated just **0.655 in sim yet deployed at 0.996**. A student that
reaches roughly its teacher's gate (or better) is good; an absolute
"≥ 0.7" rule would have rejected the champion.

## Next

[5. Test the student on the rig →](/rotary-inverted-pendulum/train/test-student/)
