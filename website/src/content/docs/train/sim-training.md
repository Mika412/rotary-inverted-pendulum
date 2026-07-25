---
title: 1. Train the teacher in sim
description: The three-stage domain-randomisation curriculum that trains the large SAC teacher, in about 25 minutes on a laptop.
---

The repo's canonical recipe trains a SAC actor through three DR stages
of increasing realism. End-to-end ~25 min on the MacBook (CPU, single
env). The trained teacher is `runs/<name>_stage3/best_model.zip`.

```bash
cd RotaryInvertedPendulum-python/src/rl
bash curriculum_train.sh
```

`curriculum_train.sh` reads `sysid_params.json` and runs three DR stages
(no DR → transport-delay ramp → concentrated on the measured rig delay).
Its defaults ARE the validated production recipe — velocity mode, 50 Hz,
±3.5 rad/s, K=4 frame stacking, gSDE, stillness bonus, firmware
measurement model, 4-tap actuator action smoothing — so a bare invocation
trains the canonical teacher, and a bare run of this whole pipeline
reproduces a champion-grade policy — the resulting `config.json` matches the
champion's knob for knob, and an independent from-scratch run measured
**0.980 balanced with a 265 s unbroken hold** against the champion's 1.000 /
299 s. Expect that ballpark rather than an exact tie: the fine-tune samples a
different rig session, so runs differ by a percent or two of balanced
fraction and a few degrees of arm motion.

Every component defaults to 50 Hz; if you override the rate, keep it
identical across training, fine-tuning, and deployment — a policy trained
at one rate produces garbage at another (measured: an over-budget
inference that sagged the on-device loop to 25 Hz turned a balancing
policy into a spinner).

## Faster iteration

Training is learner-bound (~97% of wall-clock is the SAC gradient update, not
the sim), so parallel envs / GPU don't help. For cheap exploration:

```bash
NET_ARCH=128,128 STEPS_PER_STAGE=70000 ./curriculum_train.sh
```

is ~2.4× faster. Explore-only, though: that smaller/shorter teacher
fine-tunes to ~0.97 deployed vs the default 256×256/100k's 0.996
(measurably more drops) — train final champions at the defaults.

## What the stages do

Stage boundaries and the reasoning behind each randomised parameter are on the
[domain randomization page](/rotary-inverted-pendulum/reference/domain-randomization/).

## Mirror symmetry (experimental)

The rig is left/right symmetric, but a plain SAC run picks an arbitrary
preferred swing-up direction and catches worse on the other side. `MIRROR_AUGMENT=1`
stores every transition alongside its mirror image, which is exact rather than
synthetic:

```bash
MIRROR_AUGMENT=1 bash curriculum_train.sh sym_v1
python analyze_symmetry.py runs/sym_v1_stage3/best_model.zip   # must still self-start
```

Costs no measurable throughput. Check the result before spending rig time —
the evidence, the caveats, and why symmetrising a *finished* teacher does not
work are on the [mirror symmetry
page](/rotary-inverted-pendulum/reference/symmetry/).
