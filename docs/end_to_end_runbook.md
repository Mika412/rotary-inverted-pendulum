# End-to-End Runbook

How to take a freshly-built rig from "no policy at all" to "balances
standalone on the Nano, no laptop tether". Each step lists the command,
the expected wall-clock cost, and what the next step depends on.

For *how a single transition works*, see [`rl_transitions.md`](rl_transitions.md).
For the decision log behind the hardware/firmware shape of the pipeline, see
[`transport_delay.md`](transport_delay.md).

```
   ┌──────────┐    ┌──────────┐    ┌──────────────┐    ┌──────────────┐
   │ 0 sysid  │───▶│ 1 sim    │───▶│ 2 fine-tune  │───▶│ 3 test       │
   │  recordings    curriculum     real-rig async      teacher tethered
   └──────────┘    └──────────┘    └──────────────┘    └──────┬───────┘
                                                              │ scored ≥ 0.9?
                                                              ▼
                                  ┌──────────────────────┐    ┌──────────┐
                                  │ 6 flash + verify     │◀───│ 4 distill│
                                  │ on-device standalone │    │ student  │
                                  └──────────────────────┘    └────┬─────┘
                                                                   │
                                                              ┌────▼──────┐
                                                              │ 5 test    │
                                                              │ student   │
                                                              │ tethered  │
                                                              └───────────┘
```

If you only need the upright/balance behaviour and are happy keeping the
laptop attached: stop after step 3. Steps 4–6 only exist to remove the
tether.

## Action mode — velocity is the production mode

The validated pipeline uses **`velocity`** mode end-to-end: the policy's
action is a velocity setpoint (±3.5 rad/s), converted to accel commands
each tick by a P-law tracking the controller's own commanded-velocity
integrator (never the quantised measured velocity — that injected a
±17 rad/s² dither, removed 2026-07-21), over the same `CMD_SET_ACCEL`
firmware transport in every deployment. All defaults — the curriculum,
`train_sac.py` at 35 Hz, `RLControl.ino` — are set for this mode; run
the commands as written.

Legacy modes remain selectable for comparisons (`--action-mode accel` /
`position_delta`, see [`rl_transitions.md`](rl_transitions.md)) but no
current tooling defaults to them and RLControl.ino no longer speaks
position-delta.

## Prerequisites

- macOS / Linux dev box with `arduino-cli`, the `arduino:avr` core, and
  the `AS5600` (RobTillaart) + `FastAccelStepper` libraries installed.
- Python env set up per [`../RotaryInvertedPendulum-python/README.md`](../RotaryInvertedPendulum-python/README.md).
  The project is `uv`-managed: prefix each command below with `uv run`
  (e.g. `uv run python train_sac.py …`, `uv run bash curriculum_train.sh …`),
  or activate the project venv once and drop the prefix. **macOS only:**
  commands that open the MuJoCo viewer (the `--eval` rollouts) must use
  `mjpython`, not `python` — e.g. `uv run mjpython train_sac.py --eval …`.
- Rig wired with **STEP on pin 9**, DIR on pin 2, ENABLE on pin 5, AS5600
  on I²C (A4/A5). Pin 9 is required by FastAccelStepper on ATmega328
  (Timer1 OC1A — see the pin notes in `LowLevelServer.ino`) and works for
  AccelStepper too.

In the commands below, replace `/dev/cu.usbserial-1130` with whatever
port `arduino-cli board list` shows for your Nano.

## 0. System identification — measure the rig

Pinning the dynamics parameters once. Outputs `sysid_params.json`,
which `pendulum_env.py` reads to build the sim.

Full protocol: [`sysid_runbook.md`](sysid_runbook.md). Re-run any time
the rig changes mechanically (new bearings, rebuilt arm, changed
microstepping, swapped motor).

## 1. Train the teacher in sim — curriculum

The repo's canonical recipe trains a SAC actor through three DR stages
of increasing realism. End-to-end ~25 min on the MacBook (CPU, single
env). The trained teacher is `runs/<name>_stage3/best_model.zip`.

```bash
cd RotaryInvertedPendulum-python/src/rl
bash curriculum_train.sh
```

`curriculum_train.sh` reads `sysid_params.json` and runs three DR stages
(no DR → transport-delay ramp → concentrated on the measured rig delay).
Its defaults ARE the validated production recipe — velocity mode, 35 Hz,
±3.5 rad/s, K=4 frame stacking, gSDE, stillness bonus, firmware
measurement model — so a bare invocation trains the canonical teacher.
Every component now defaults to 35 Hz; if you override the rate, keep it
identical across training, fine-tuning, and deployment — a policy trained
at one rate produces garbage at another (measured: an over-budget
inference that sagged the on-device loop to 25 Hz turned a balancing
policy into a spinner).

## 2. Fine-tune on the real rig — async

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

Then run the async orchestrator. `--resume-buffer` is optional on the
first session; on subsequent sessions, point it at the previous run's
`replay_buffer.pkl` to keep accumulated real-rig transitions:

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

Architecture detail: [`async_control_architecture.md`](async_control_architecture.md).

The orchestrator disengages the motor for `--reset-settle-s` (default 5)
between episodes so the pendulum coasts to rest passively. **Listen** to
the motor during the first few episodes — a smooth whirr is fine, a
buzzy/grinding sound means step-skipping (drop `MOTOR_ACCELERATION` in
`LowLevelServer.ino` and `RLControl.ino` from 50 k → 30 k and re-flash).

## 3. Test the teacher on the rig — tethered

Confirms the fine-tuned teacher actually balances before spending more
time on it. Cheap (30 seconds of rig time).

```bash
python run_policy.py \
    --policy runs/<run>_async/best_model.zip \
    --port /dev/cu.usbserial-1130 \
    --duration-s 30 \
    --log recordings/<run>_ft.npz
```

Always deploy `best_model.zip` (deterministic-eval best), never
`last.zip`. Judge by the HONEST metrics printed at the end (balanced
fraction / streaks / revolutions — the upright proxy is spoofable by
spinning):
- **balanced fraction ≥ 0.85, verdict BALANCED** → solid teacher,
  proceed to step 4 to remove the tether. (2026-07-21 reference: 0.911.)
- **0.4–0.85** → more fine-tune episodes (back to step 2 with
  `--resume-buffer`) usually keep climbing if the deterministic evals
  were still rising.
- **below that** → diagnose before distilling: re-sysid, replay the log
  through `sim_vs_real.py`, check the transport-delay assumptions.

If you're happy keeping the laptop attached, **you can stop here**.
The teacher runs at 35 Hz over USB serial just fine.

## 4. Distill — shrink the actor for the deployment transport

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

Why this shape (all measured, 2026-07-22):

- **H=16 is the production width.** It runs in ~8 ms on the Nano; H=32
  float (~23 ms) does not fit the 28.6 ms tick and silently sagged the
  loop to 25 Hz.
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

Acceptance: the DAgger gate (printed per round, honest balanced fraction
in the device-transport sim) should reach **≥ 0.7**; sim under-predicts
smooth students on the rig (0.763 gated → 0.892 measured).

## 5. Test the student on the rig — tethered (optional)

A quick sanity that the student behaves before flashing. Note it runs
under the TETHERED transport, which the device-aimed student was not
optimised for — expect it somewhat below the teacher here; the real
acceptance test is step 6's on-device capture.

```bash
python run_policy.py \
    --policy runs/<run>_async/distill_h16_dagger_dev/student.pt \
    --port /dev/cu.usbserial-1130 \
    --duration-s 30
```

## 6. Flash the standalone sketch — remove the tether

```bash
# Export PROGMEM weights into the Arduino sketch directory
python export_weights.py \
    --student runs/<run>_async/distill_h16_dagger_dev/student.pt \
    --header  ../../../RotaryInvertedPendulum-arduino/RLControl/policy_weights.h \
    --source-name <run>/distill_h16_dagger_dev

# Flash
cd ../../..
arduino-cli compile --upload -p /dev/cu.usbserial-1130 \
    --fqbn arduino:avr:nano:cpu=atmega328 \
    RotaryInvertedPendulum-arduino/RLControl
```

Keep the pendulum hanging straight down through the 1 s settle delay
after boot (LED solid HIGH) — that pose becomes the encoder zero for
the engagement. The sketch then swings up and balances autonomously.

**Score it with the honest metrics** (the same gate as every other
deployment — opening the port resets the Nano, so hang the pendulum
still before launching):

```bash
cd RotaryInvertedPendulum-python/src/rl
python analyze_onboard.py --port /dev/cu.usbserial-1130 --duration-s 60 \
    --log recordings/onboard_<run>.npz
```

Read the header line first: it must say **~35.0 Hz**. An off-rate
capture (the script warns loudly) means inference exceeded the tick
budget and the numbers evaluate a broken deployment, not the policy.
2026-07-22 reference: balanced fraction **0.892**, 5 s streaks, verdict
BALANCED. Boot also prints `[boot] policy(hanging/upright) = …` on
serial (500 kbaud) — compare against the PyTorch student on the same
reference frames if you suspect an export/PROGMEM bug.

## Re-running individual steps

Every step is idempotent and can be re-run on its own:

| Want to | Re-run | Resume from |
|---|---|---|
| Tweak rewards or DR ranges | step 1 | scratch |
| Add real-rig data | step 2 | `--resume-buffer` |
| Re-distill (new teacher or transport) | step 4 | existing teacher |
| More DAgger rounds | step 4b | existing `--bc-dir` |
| Re-flash with the same student | step 6 | existing `.h` |

## Troubleshooting

- **Policy balances tethered but spins on the Nano**: check, in order:
  (1) `analyze_onboard`'s rate line — if the loop isn't ~35 Hz, the
  network is too big for the tick (H=16 is the budget); (2) whether the
  flashed network is an imitation student or a direct-RL actor — actors
  are transport-brittle and fail standalone even when excellent tethered
  (measured twice, 2026-07-22); (3) the encoder zero — captured at
  engage time; reset the Arduino with the pendulum hanging still.
- **Boot self-test prints `[FATAL] FastAccelStepper config rejected`**:
  the requested `MOTOR_MAX_SPEED` exceeds FastAccelStepper's AVR cap of
  50 kSteps/s for a single stepper. Check the constant in
  `RLControl.ino`.
- **Pendulum swings but never reaches upright**: motor authority is
  too low. Verify the `MOTOR_ACCELERATION` matches between
  `LowLevelServer.ino` (used during fine-tuning) and `RLControl.ino`
  (used at deployment). They must agree, otherwise the policy is
  trained against one set of dynamics and deployed against another.
