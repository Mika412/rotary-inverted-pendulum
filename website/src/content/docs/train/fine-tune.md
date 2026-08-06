---
title: 2. Fine-tune on the real rig
description: Closing the sim-to-real gap with real-rig episodes, using the async orchestrator — and the 30 seconds of rig time that decide whether the teacher is worth distilling.
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

Mirror augmentation is **on by default**, storing each transition's mirror
image alongside it. Rig time is the scarce resource and these sessions are
lopsided — measured 2.5–4× more arrivals at upright from one side than the
other — so mirroring doubles what each episode covers at no rig cost. [Mirror
symmetry](/rotary-inverted-pendulum/reference/symmetry/) covers what it gives
up (≤1° of per-rig base-tilt specialisation, less than the sim curriculum
already randomises over).

`--no-mirror-augment` opts out, for an asymmetric baseline. Prefer not to:
the champion was fine-tuned with it, and the un-mirrored version of this stage
is what produced the persistent arm lean that weeks of reward tuning failed to
fix. If a capture shows `arm lean signed` well off zero and a direction bias,
check this flag first.

## Listen to the motor

The orchestrator disengages the motor for `--reset-settle-s` (default 15)
between episodes so the pendulum coasts to rest passively. **Listen** to
the motor during the first few episodes — a smooth whirr is fine, a
buzzy/grinding sound means step-skipping (drop `MOTOR_ACCELERATION` in
`LowLevelServer.ino` and `RLControl.ino` from 50 k → 30 k and re-flash).

## Test the teacher on the rig

Confirms the fine-tuned teacher actually balances before spending more time on
it. Cheap — 30 seconds of rig time:

```bash
python run_policy.py \
    --policy runs/<run>_async/best_model.zip \
    --port /dev/cu.usbserial-1130 \
    --duration-s 30 \
    --log recordings/<run>_ft.npz
```

Always deploy `best_model.zip` (deterministic-eval best), never `last.zip`.

Judge by the HONEST metrics printed at the end (balanced fraction / streaks /
revolutions — the upright proxy is spoofable by spinning):

- **balanced fraction ≥ 0.85, verdict BALANCED** → solid teacher, proceed to
  [step 3](/rotary-inverted-pendulum/train/distill/) to remove the tether.
  (2026-07-21 reference: 0.911.)
- **0.4–0.85** → more fine-tune episodes usually keep climbing if the
  deterministic evals were still rising: another block with `--resume-buffer`,
  as above.
- **below that** → diagnose before distilling: re-sysid, replay the log
  through `sim_vs_real.py`, check the transport-delay assumptions.

Also re-run the [sensitivity
gate](/rotary-inverted-pendulum/train/distill/#the-offline-pre-flight-the-sensitivity-gate)
on the fine-tuned `best_model.zip`. Fine-tuning has preserved
observation-robustness in every lineage measured, so treat it as a cheap
regression check — a collapse would mean the session taught the policy to
exploit measurement statistics, and distilling it would waste the rig time.

:::tip[You can stop here]
If you're happy keeping the laptop attached, this is a finished controller.
The teacher runs at 50 Hz over USB serial just fine, and steps 3–4 exist only
to remove the tether.
:::

## How many episodes?

More than the eval curve suggests. Deterministic-eval reward flattens early —
and in one measured block it went *backwards* — while the metrics you actually
care about kept improving sharply. Two lineages on the same rig, both from a
sim teacher, differing only in stepper driver:

| | \[DRV8825] 30 ep | 60 ep | 90 ep | | \[TMC2209] 30 ep | 60 ep |
| --- | --- | --- | --- | --- | --- | --- |
| arm sway <1 s | 15.1° | 8.25° | 5.10° | | 4.22° | **3.23°** |
| arm speed RMS | 2.98 | 1.43 | 0.86 | | 0.76 | **0.58** |
| \|action\| mean | 0.623 | 0.313 | 0.275 | | 0.236 | **0.177** |
| pendulum std | 6.74° | 3.23° | 1.83° | | 1.62° | **1.23°** |
| balanced | 0.972 | 1.000 | 1.000 | | 0.993 | **1.000** |

So **judge a block by the standalone capture, not by the eval reward**, and
keep extending while the capture keeps getting calmer. Sessions chain through
`--resume-buffer`, so this costs nothing but rig time — a 30-episode block is
about six minutes.

Two things the second lineage settles:

**A smoother driver is worth roughly 3× the rig time.** The TMC2209 reached in
30 episodes what the DRV8825 needed 90 for, and kept going. See [why it runs
smoother](/rotary-inverted-pendulum/build/electronics/#why-it-runs-smoother).

**Keep extending even after `best_model` stops advancing.** The TMC lineage's
second block set its best deterministic eval at episode 5 and never beat it, so
the promoted teacher had 35 episodes behind it — yet its student halved
`|action|` versus the 30-episode one. The gain came through the *distill*: the
replay buffer holds every episode, and the teacher relabels all of it, so more
rig time buys state coverage even when the checkpoint stops improving.
