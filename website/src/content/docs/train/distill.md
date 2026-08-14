---
title: 3. Distill the student
description: Behaviour cloning then DAgger aimed at the deployment transport — the step that makes a network small enough to run on the Nano actually work there.
---

Two sub-steps: behaviour cloning, then DAgger **aimed at the transport
the network will deploy into**. Both cheap (~1 min + ~2 min, no rig), and
always run together, so one wrapper does the pair and then scores the student
in sim:

```bash
cd policy
./distill_student.sh <run>_async
```

It passes `--buffer` automatically when the run has one (a rig fine-tune) and
falls back to teacher rollouts alone for a sim-only teacher. `HIDDEN`,
`TRANSPORT`, `ROUNDS`, `BC_EPOCHS` and `SEED` override the defaults; `FORCE=1`
redoes the behaviour-cloning stage instead of reusing it. It deliberately does
**not** write `policy_weights.h` — overwriting the header that holds your best
policy should be a decision, so it prints the export and flash commands
instead.

The underlying steps, if you want them separately (e.g. to re-run DAgger
against an existing BC dataset):

```bash
python distill.py \
    --teacher runs/<run>_async/best_model.zip \
    --buffer  runs/<run>_async/replay_buffer.pkl \
    --out-dir runs/<run>_async/distill_h16_aug \
    --hidden 16

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

## Test the student (optional)

A quick sanity that the student behaves before flashing. Note it runs under the
TETHERED transport, which the device-aimed student was not optimised for —
expect it somewhat below the teacher here; the real acceptance test is
[step 4](/rotary-inverted-pendulum/train/flash/)'s on-device capture.

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

An earlier version of this gate used the kick test's `arm walk / kick` with a
13–15° pass band. That threshold rested on one policy and failed its first
out-of-sample test in both directions — a 19.6° student deployed at 1.000
while a 9.4° one spun. The kick protocol remains useful for
disturbance-recovery A/Bs between good policies (`disturbance.py` documents
what each metric is worth); it is not a deployment gate.
