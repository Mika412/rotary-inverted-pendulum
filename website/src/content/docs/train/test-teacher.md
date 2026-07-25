---
title: 3 · Test the teacher on the rig
description: Thirty seconds of rig time that decides whether the teacher is worth distilling — and the point you can stop at if you keep the laptop attached.
---

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
`last.zip`.

## Judge by the honest metrics

Judge by the HONEST metrics printed at the end (balanced fraction / streaks /
revolutions — the upright proxy is spoofable by spinning):

- **balanced fraction ≥ 0.85, verdict BALANCED** → solid teacher,
  proceed to step 4 to remove the tether. (2026-07-21 reference: 0.911.)
- **0.4–0.85** → more fine-tune episodes (back to
  [step 2](/rotary-inverted-pendulum/train/fine-tune/) with
  `--resume-buffer`) usually keep climbing if the deterministic evals
  were still rising.
- **below that** → diagnose before distilling: re-sysid, replay the log
  through `sim_vs_real.py`, check the transport-delay assumptions.

:::tip[You can stop here]
If you're happy keeping the laptop attached, this is a finished controller.
The teacher runs at 50 Hz over USB serial just fine, and steps 4–6 exist only
to remove the tether.
:::

## Next

[4 · Distill the student →](/rotary-inverted-pendulum/train/distill/)
