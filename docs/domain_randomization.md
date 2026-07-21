# Domain Randomization (sim training)

Sim-to-real for this rig is a closed-loop instability problem on a
position-controlled stepper. Anything we miss in the sim model the
policy will silently overfit to. Domain randomization (DR) is the
mechanism we use to bridge that gap: we train against a *distribution*
of plausible rigs rather than a single nominal one, so the policy is
robust to the residual mismatch between our identified parameters and
whatever the real hardware looks like on a given day.

This doc summarises **what is randomized, by how much, and why**, plus
how DR fits into the curriculum schedule and where the knobs live in
code. For the end-to-end pipeline this feeds into see
[`end_to_end_runbook.md`](end_to_end_runbook.md). For the transition-level contract see
[`rl_transitions.md`](rl_transitions.md). For the sysid measurements
that set the bracketed values see [`sysid_runbook.md`](sysid_runbook.md).

## How to enable it

```bash
python train_sac.py --domain-randomization ...
```

Or, equivalently, run the full curriculum:

```bash
./curriculum_train.sh <run-name-prefix>
```

The flag flips a single boolean on the env
([`pendulum_env.py:248`](../RotaryInvertedPendulum-python/src/rl/pendulum_env.py#L248)).
When off, the env runs deterministically against the nominal
sysid params — useful for debugging but **never** for the policy that
will be deployed.

The **eval env always stays deterministic** (DR off), so best-model
selection during training tracks performance on the nominal-physics
reference scenario instead of being washed out by sample-to-sample
randomisation noise. See
[`train_sac.py:86`](../RotaryInvertedPendulum-python/src/rl/train_sac.py#L86).

## What is randomized

All ranges are defined as module constants in
[`pendulum_env.py:61-97`](../RotaryInvertedPendulum-python/src/rl/pendulum_env.py#L61-L97).
Most are sampled **once per episode** in
[`_sample_dr_params`](../RotaryInvertedPendulum-python/src/rl/pendulum_env.py#L384);
the dt-jitter and observation noise are sampled **per step**.

### Physical parameters (per episode)

| Parameter                                   | Range                | Source constant                                  | Why this width                                                                                                                                                                                                                                                      |
| ------------------------------------------- | -------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pendulum mass                               | nominal × (1 ± 0.10) | `DR_PENDULUM_MASS_FRAC = 0.10`                   | Narrowed from ±0.20 after CAD cross-check (Onshape part with PLA-density-corrected materials) agreed with sysid `m·d` to within 1%; mass is a one-shot scale measurement and the remaining uncertainty (unmodelled magnet, infill variation) sits well inside ±10%. |
| Pendulum COM distance                       | nominal × (1 ± 0.10) | `DR_PENDULUM_COM_FRAC = 0.10`                    | Bearing seating and tip mass placement vary; ±10 % covers reasonable rebuilds.                                                                                                                                                                                      |
| Pendulum joint friction (viscous + Coulomb) | nominal × [0.5, 2.0] | `DR_PENDULUM_FRICTION_MULT_RANGE = (0.5, 2.0)`   | Friction depends on grease state, temperature, and bearing seating; same multiplier applied to both terms because they share the bearing as a source.                                                                                                               |
| Motor joint stiction (`frictionloss`)       | [0.0, 0.005] N·m     | `DR_MOTOR_FRICTIONLOSS_RANGE_N_M = (0.0, 0.005)` | Steppers have detent torque that the position actuator doesn't capture; lower bound includes 0 for backward compat with Phase 2 policies trained without stiction.                                                                                                  |

Nominal values come from
[`sysid_params.json`](../RotaryInvertedPendulum-python/src/rl/sysid_params.json),
written by the Phase 0 sysid pipeline. **Pendulum inertia about its own
COM** (`PENDULUM_I_COM_SWING_KG_M2` at
[`pendulum_env.py:71`](../RotaryInvertedPendulum-python/src/rl/pendulum_env.py#L71))
is hard-coded from Onshape CAD rather than back-computed from sysid
`I_axis − m·d²` — it's a geometric property of the part, not a quantity
that varies with rebuilds, so it isn't randomised. MuJoCo applies
parallel-axis automatically from `body_ipos`, giving per-episode pivot
inertia `m·d² + I_com_swing`. Previously this was forced to ≈0 (point-
mass approximation); the CAD value (~8.06e-6 kg·m²) adds ~25% to the
effective pivot inertia at nominal, matching the measured `I_axis`.

### Actuator / control-loop realism (per episode)

| Parameter                                  | Range                            | Source constant                    | Why this width                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------------ | -------------------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Motor accel envelope                       | [110, 190] rad/s²                | `DR_MOTOR_ACCEL_RANGE_RAD_S2`      | Brackets `MAX_ACCEL_RAD_S2 = 150` so the policy trains both above and below its command cap — models load-dependent stepper torque headroom. |
| Transport delay: integer-tick queue        | curriculum-staged (see below)    | `--dr-delay-min/max`               | Teacher-forced fits over the 2026-07-21 deploy logs put the TOTAL command→motion delay at ~30–45 ms at 35 Hz — more than one control tick. In velocity mode the queue delays the accel command the host sends (the P-law itself is host-side and instant). See [`transport_delay.md`](transport_delay.md). |
| Transport delay: first-order lag τ         | curriculum-staged (see below)    | `--dr-action-lag-tau-min/max`      | Fractional-tick remainder on top of the integer queue; composes with it (filter, then queue). |
| Motor first-order target lag τ             | [0.010, 0.030] s                 | `DR_MOTOR_TAU_RANGE_S`             | Position-delta mode only — models the stepper's ramp-to-target bandwidth. Not sampled in accel/velocity modes. |
| Control-step dt jitter                     | n_substeps × (1 ± 0.05) per step | `DR_CONTROL_DT_JITTER_FRAC = 0.05` | Empirically the single most important DR. Without it, SAC at strict timing finds the **active-correction attractor** (motor saws ±0.5 rad even when balanced); with it, SAC finds the **calm minimal-action attractor** that dominates real-world performance. See [`control_rate_selection.md`](control_rate_selection.md) "calm vs active attractors". |
| Obs staleness (firmware model only)        | [0.002, 0.010] s                 | `DR_OBS_STALENESS_RANGE_S`         | Age of the state snapshot when the host acts on it: encoder sample age (0–2 ms at the firmware's 500 Hz sampling) + GET_STATE serial round-trip. Only sampled when `firmware_obs_model` is on. |

### Observation noise (per step)

| Parameter                   | Range                                 | Source constant              | Why this width                                                                                                                  |
| --------------------------- | ------------------------------------- | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| Pendulum angle quantisation | snapped to AS5600 LSB (2π / 4096 rad) | `PENDULUM_LSB_RAD`           | Models the encoder's 12-bit resolution. Always applied when DR is on.                                                           |
| Motor angle quantisation (firmware model only) | snapped to step LSB (2π / 1600 rad) | `MOTOR_STEP_LSB_RAD`   | The firmware's motor position is the step counter at 8× microstepping. Applied at measurement capture when `firmware_obs_model` is on. |
| Position noise σ            | 0.005 rad                             | `DR_OBS_NOISE_STD_POS_RAD`   | Mimics finite-diff jitter and encoder noise observed on the rig. Added to motor pos and pendulum angle.                         |
| Velocity noise σ            | 0.15 rad/s (0.05 with firmware model) | `DR_OBS_NOISE_STD_VEL_RAD_S` / `DR_OBS_NOISE_STD_VEL_RESIDUAL_RAD_S` | The firmware's window finite-difference produces ±1-LSB spikes of ~0.2–0.5 rad/s. Legacy path brackets them with a 0.15 Gaussian; with `firmware_obs_model` on, the spikes emerge mechanistically from quantised differencing, so the Gaussian drops to a 0.05 residual (I²C/sample-time jitter) to avoid double-counting. |

### The firmware measurement model (`firmware_obs_model`)

Additive Gaussians approximate the rig's sensing; the firmware measurement
model reproduces it **mechanistically**. When enabled (`--firmware-obs-model`
/ `FIRMWARE_OBS_MODEL=1`), the sim keeps a physics-rate ring of joint
positions and builds each observation the way `LowLevelServer.ino` builds a
GET_STATE reply: positions quantised to encoder/step resolution and stale
by 2–10 ms (DR-sampled), velocities finite-differenced over the firmware's
8 ms window. The motor channel reads the COMMANDED path (the firmware's
"sensor" is its own step counter, and the stepper executes commands
near-perfectly); the pendulum channel reads the physical joint (AS5600).
The model affects observations only — the velocity-mode P-law tracks the
host's commanded-velocity integrator on both sim and rig (feeding the
quantised measurement back at the control-frequency gain injected a
±17 rad/s² accel dither; measured, then removed host-side on 2026-07-21).
Obs shape is unchanged; the flag is recorded in `config.json` and
inherited by `eval_randomized.py`.

## Curriculum staging

Training in three stages
([`curriculum_train.sh`](../RotaryInvertedPendulum-python/src/rl/curriculum_train.sh))
is more reliable than one shot at full DR width. Each stage `--resume`s
from the last so capabilities accumulate.

Only the **transport delay** is annealed across stages; every other DR
dimension activates at its full range from stage 2 (stage 1 runs without
DR so the swing-up + balance skill is found first).

| Stage          | Tick delay | Lag τ      | DR overall | Steps             |
| -------------- | ---------- | ---------- | ---------- | ----------------- |
| **1 — skill**  | 0          | 0          | off        | `STEPS_PER_STAGE` |
| **2 — ramp**   | {0, 1}     | [0, 20] ms | on         | `STEPS_PER_STAGE` |
| **3 — final**  | 1          | [0, 15] ms | on         | `STEPS_PER_STAGE` |

Stage 3 concentrates the training mass on the measured total delay
(~30–45 ms at 35 Hz: one 28.6 ms tick + fractional remainder) instead of
spreading it over delays the rig never produces — wide delay DR was
observed (2026-05-20) to make policies needlessly conservative.

## Reset diversity (not strictly DR, but adjacent)

`reset()` itself adds initial-condition diversity that is essential for
the policy to learn recovery from arbitrary starts:

- **Motor start**: uniform in ±0.7 × motor safety limit (≈ ±88°). Keeps
  the reset clear of the ±125° clamp while covering most of the working
  range. Without this, the policy never practises returning from the
  limit and gets stuck there at deploy time
  ([`pendulum_env.py:362-374`](../RotaryInvertedPendulum-python/src/rl/pendulum_env.py#L362-L374)).
- **Pendulum start**: hanging-down ± 0.05 rad (small noise around the
  natural rest angle).

This is on regardless of `--domain-randomization` because it's about
training-state coverage, not modelling-error robustness.

## Where the knobs live

| Knob                                | Default                              | Where it's set / read                                                                                                                                                           |
| ----------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Module constants (`DR_*`)           | as above                             | [`pendulum_env.py:61-97`](../RotaryInvertedPendulum-python/src/rl/pendulum_env.py#L61-L97)                                                                                      |
| Per-instance overrides (curriculum) | None → fall back to module constants | `RotaryInvertedPendulumEnv.__init__` ([`pendulum_env.py:255-284`](../RotaryInvertedPendulum-python/src/rl/pendulum_env.py#L255-L284))                                           |
| CLI overrides                       | unset → module defaults              | `train_sac.py` flags `--dr-tau-min/max`, `--dr-delay-min/max`, `--dr-dt-jitter-frac` ([`train_sac.py:198-226`](../RotaryInvertedPendulum-python/src/rl/train_sac.py#L198-L226)) |
| Curriculum stage values             | hard-coded ms targets                | [`curriculum_train.sh`](../RotaryInvertedPendulum-python/src/rl/curriculum_train.sh)                                                                                            |

## Editing the ranges

When real hardware tells you something the sim missed:

1. **Re-run sysid first.** If the nominal parameters drifted (new
   bearings, motor swap, etc.), update those before widening DR — DR
   doesn't replace good identification, it just brackets its residuals.
   See [`sysid_runbook.md`](sysid_runbook.md).
2. **Widen the matching DR range** in `pendulum_env.py`. Keep ranges
   conservative — they should bracket measured reality with margin, not
   include physically implausible regimes (those just slow training and
   teach the policy nothing useful).
3. **Re-train from scratch through the full curriculum.** Resume from
   stage-3 checkpoints is unsafe when the underlying distribution
   shifts; stage-1 will adapt the basics fastest.
4. **Validate with `eval_randomized.py`** to spot-check the policy's
   robustness across the new range before deploying.

## Related

- [`control_rate_selection.md`](control_rate_selection.md) — why dt
  jitter is the load-bearing DR knob on this rig.
- [`rl_transitions.md`](rl_transitions.md) — the `(s, a, r, s')`
  contract DR perturbs.
- [`sysid_runbook.md`](sysid_runbook.md) — measurement procedure for
  the nominal values DR brackets.
- [`async_control_architecture.md`](async_control_architecture.md) —
  how the deployment runtime preserves the timing assumptions DR
  trained against.
