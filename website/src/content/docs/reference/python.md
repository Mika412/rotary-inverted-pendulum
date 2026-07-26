---
title: Python tooling
description: The simulation environment, training scripts, system identification and deployment clients.
---

Everything in
[`RotaryInvertedPendulum-python/`](https://github.com/ferrolho/rotary-inverted-pendulum/tree/main/RotaryInvertedPendulum-python).
The project is `uv`-managed, so prefix commands with `uv run`, or activate the
project environment once and drop the prefix.

:::caution[macOS and the MuJoCo viewer]
Anything that opens the MuJoCo viewer (the `--eval` rollouts) must run under
`mjpython`, not `python` — the viewer needs a special launcher to satisfy Cocoa's
main-thread requirements.

```bash
uv run mjpython train_sac.py --eval …
```
:::

## The simulation

`pendulum_env.py` is the Gymnasium environment and the centre of gravity of the
whole stack. It builds its MuJoCo model programmatically from measured
parameters, so the simulation follows the rig rather than a hand-written model
file.

Its inputs come from exactly two places — this separation is deliberate and
breaking it is a bug:

| Quantity | Source |
| --- | --- |
| Pendulum mass, COM, inertia | Onshape CAD → `urdf/model.urdf` → `pendulum_geometry.py` |
| Viscous + Coulomb friction | Measured per rig → `sysid_params.json` |
| Arm geometry | Constants in `pendulum_env.py` (not yet CAD-validated) |
| Motor and encoder limits | Constants mirroring the firmware |

The environment also models the *measurement chain*, not just the physics:
encoder quantisation, the firmware's 8 ms finite-difference velocity window, and
the fact that the motor channel reads the commanded step counter rather than the
true joint. That last detail matters — leaking the simulated servo's tracking
error into the observation creates an oscillation that exists only in simulation
and destroys policies that work fine on hardware.

## Scripts by purpose

### System identification

| Script | Purpose |
| --- | --- |
| `sysid_wizard.py` | Guided free-swing measurement, writes `sysid_params.json` |
| `sysid_core.py` | Friction derivation and cross-checks against measured period |
| `freeswing_probe.py` | Raw free-swing capture |
| `sysid_accel.py`, `accel_lag_moving_probe.py`, `accel_step_probe.py` | Actuator lag and acceleration-response measurement |
| `tick_budget_probe.py` | How much time inference actually has per tick |

### Training

| Script | Purpose |
| --- | --- |
| `curriculum_train.sh` | The canonical recipe — three domain-randomisation stages. Its defaults *are* the production configuration |
| `train_sac.py` | SAC trainer |
| `finetune_async.py` | Real-rig fine-tuning with the threaded runtime |
| `finetune_real.py` | Earlier synchronous fine-tuner |
| `async_control.py` | The threaded control runtime ([design](/rotary-inverted-pendulum/reference/async-control/)) |
| `reward.py`, `run_config.py` | Reward terms and run configuration |

### Distillation and export

| Script | Purpose |
| --- | --- |
| `distill_student.sh` | **The one command to use** — runs BC, then DAgger at the deployment transport, then scores the student in sim. Defaults are the validated recipe; env vars override |
| `distill.py` | Behaviour cloning from teacher + real-rig buffer |
| `dagger_distill.py` | DAgger at the deployment transport — the step that makes it deploy |
| `export_weights.py` | Emits the PROGMEM `policy_weights.h` the Nano is flashed with |

### Deployment and evaluation

| Script | Purpose |
| --- | --- |
| `run_policy.py` | Run a policy on the rig, tethered |
| `real_env.py`, `lowlevel_client.py` | Hardware bridge over the binary protocol |
| `analyze_onboard.py` | Capture and score a *standalone* deployment |
| `analyze_run.py`, `analyze_deploy.py` | Score tethered runs |
| `sim_vs_real.py` | Replay a real log through the simulation to find model error |
| `eval_randomized.py`, `eval_dr_sensitivity.py` | Robustness across randomised parameters |
| `fft_deploy.py` | Frequency analysis of a deployment, for diagnosing vibration |

## Judging a run honestly

Every scoring path reports a **balanced fraction** computed from the true
pendulum angle, plus streak lengths and revolution counts. It deliberately does
not use the upright indicator derived from the policy's own observation, because
that proxy is satisfied by spinning the arm — which is exactly how earlier
evaluations were misled.

Deploy `best_model.zip` (best deterministic evaluation), never `last.zip`.

## Also here

`gamepad_control.py` drives the rig manually from a gamepad over the older text
protocol. It predates the RL work and is useful mostly for checking that the
mechanics respond sensibly.
