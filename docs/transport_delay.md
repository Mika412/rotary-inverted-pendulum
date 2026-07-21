# Transport delay: how it shrank, and how we measure it

This rig used to have ~50 ms of laptop-to-motor transport delay. It's
now ~14 ms. The path there was three fixes, each attacking a different
layer of the pipeline. None of the three was about "delay" *per se*;
they targeted other problems and the delay drop was the by-product.

## The pipeline

```
policy(obs) -> action  ┐
                       │  (1) USB serial          ~1–5 ms
                       ▼
                   Arduino loop  -- (2) Cmd dispatch
                                 -- (3) Stepper driver / ISR
                                 -- (4) Motor mechanical response
                       │
                       ▼
                  AS5600 encoder -- (5) I²C read       ~5 ms
                       │
                       ▼
                 policy obs(t+1)
```

Total round-trip transport delay = (1) + (2) + (3) + (4) + (5).

## The three fixes (in chronological order)

| Date       | Fix                                                                      | Layer it targets | Why                                                                                  | Side effect on delay                                                                            |
|------------|--------------------------------------------------------------------------|------------------|--------------------------------------------------------------------------------------|-------------------------------------------------------------------------------------------------|
| 2026-05-03 | `AccelStepper` → `FastAccelStepper` (commit `c46480d`)                   | (3) stepper      | Polled step-pulse timing in AccelStepper jittered above 50 k steps/s², causing step-skipping; firmware position diverged from reality. FastAccelStepper drives STEP from Timer1 OC1A ISR — honest pulses. Required moving STEP_PIN to pin 9. | Slight: ISR timing is more deterministic than polled, so jitter on layer (3) shrinks. Median delay roughly unchanged. |
| 2026-05-16 | Action semantics: position-target → angular-acceleration (commit `396c5d4`) | (3) stepper      | Position commands forced a fresh trapezoidal land-on-target ramp each control tick (10–30 ms of mechanical lag per tick). Closed-loop sim-vs-real diverged at resonance; sim_upright=0.14 vs real_upright=0.73 on identical action sequences. Switching to `moveByAcceleration(int32 steps_s2, allow_reverse=true)` lets the motor integrate accel continuously across ticks, with smooth zero-crossing direction reversal. | **Big drop.** Removes the per-tick targeting ramp (10–30 ms). This is the dominant contributor to the 50 ms → ~14 ms reduction. |
| 2026-05-16 | Observation extended with `prev_action` (commit `cae2a1b`)               | (1) policy       | Even after fixes 1 + 2 the remaining ~14 ms makes the system a POMDP from the policy's point of view — it can't tell whether obs(t) reflects action(t) or action(t-1). Adding `prev_action` to the obs restores the Markov property for the action pipeline. | None directly. Doesn't change the physical delay; lets the policy reason about it. |
| 2026-05-28 | `setForwardPlanningTimeInMs(20 → 8)` in `LowLevelServer.ino`             | (3) stepper      | FastAccelStepper pre-plans a queue of step commands; a new `moveByAcceleration()` only affects pulses *after* the already-queued window. The 20 ms default queue was the dominant remaining lag source (the τ ≈ 20 ms half-and-half command mixing measured 2026-05-20 by `accel_lag_moving_probe.py`). 8 ms = two cyclic-task periods, the library's documented safe minimum. | Re-probed 2026-07-21 (`accel_lag_moving_runs/2026-07-21_*`): τ = 13–20 ms across 8 trials, median ≈ 17 ms, **with this firmware confirmed flashed immediately before the probe** — only marginally below the May 20 measurement (19–23 ms), so the remaining lag lives elsewhere (stepper task cycle ≤4 ms, serial RTT ~2.5 ms, and the firmware's ~8 ms velocity-regression window, which smears the measured knee by up to half its width). Note the large-step trials (−50/−80) cross v=0 inside the fit window and overshoot the expected post-slope — trust the −10/−30 trials most. Curriculum stage-3 default tightened to [10, 25] ms, centred on the re-measured τ. |

## Current measurement (2026-05-16)

Two methods, same conclusion.

### Method 1 — sysid_accel step test (pendulum held)

Recorded by `sysid_accel.py step` at 200 Hz logging while driving the
firmware directly via `set_acceleration` calls. Motor responds within
**one 200 Hz sample (≤ 5 ms)** of an accel-command step change. This
measures layers (1) + (2) + (3) + (4) without the I²C/Python read leg.

### Method 2 — real-rig deploy log half-step model fit

From `run_policy.py --log /tmp/pdfix.npz` running at the policy's 35 Hz
control rate. Pick a step where the commanded accel changes sharply and
look at the velocity delta two steps later:

```
idx 91: prev cmd = -37.5,  cmd = -149,  observed Δv = -2.69 rad/s
        expected if 0-step delay         -4.25
        expected if 1-step delay         -1.07
        expected if ½-step delay  ✓      -2.66
```

Fits a **½-control-step delay model** to within filter noise. At 35 Hz
control, that's **≈ 14 ms** of effective transport delay end-to-end —
including the encoder read and Python decision time that method 1
skips.

## Closed-loop measurement (2026-07-21) — the probe underestimates

Teacher-forced one-step fits over the day's 14 preserved deploy logs
(`recordings/deploy_logs_2026-07-21/`): reset the sim to the real logged
state every tick, apply the LOGGED accel command, and fit the delay model
(integer-tick shift + first-order tau) that minimises next-tick motor
error. No chaotic accumulation, no P-law confound. Result:

- **35 Hz logs (v4–v6): total command→motion delay ≈ 30–45 ms** —
  optimum at shift = 1 tick (28.6 ms) + tau 0–17 ms, robust to the
  velocity-init convention (central vs backward differences), and 3×
  better motor fit than the zero-delay model (23 vs 69 mrad RMSE).
- 50 Hz logs (v1–v3): ≈ 15–30 ms, flatter fit (spin-dominated data).

Two systematic errors had hidden this:

1. **`sim_vs_real.py` alignment bug** (fixed): log row *i* holds the state
   the action on row *i* was computed FROM, so sim's post-step state
   matches real row *i+1*; the replay compared index-to-index, injecting a
   one-step phantom delay into every prior estimate.
2. **The standalone probe measures the wrong loop.** `accel_lag_moving_probe`'s
   τ ≈ 17 ms captures send → motion (serial write + planning queue +
   ramp), but the closed loop ALSO pays the read-side latency every tick:
   encoder sample age, GET_STATE round-trip, host inference. The
   teacher-forced fit sees the whole path and lands ~1 tick higher.

Model placement matters too: in velocity mode the host P-law runs with no
delay, so sim applies the delay/lag to the **accel command it sends**, not
to the policy's velocity setpoint (fixed in `pendulum_env.py` the same
day). Curriculum stage 3 now trains delay = 1 tick + tau ∈ [0, 15] ms.

## Implications

- **DR ranges in `pendulum_env.py` are still position-mode calibrated.**
  `DR_ACTION_DELAY_STEPS_RANGE = (1, 3)` was set when the real delay was
  ~50 ms (1–3 steps at 35 Hz). Post-accel-mode reality is ~½ step.
- Integer-step delay DR (sample 0 or 1) is a coarse fit to a fractional
  delay. A continuous **action-lag** DR (first-order filter with random
  tau ∈ ~[5, 20] ms) matches the real layer (3)+(4) dynamics more
  directly and gives the optimiser a smoother gradient than 0-or-1
  discrete sampling.
- Curriculum stage 2/3 delay ranges should be tightened to bracket the
  actual ~14 ms, not the historical 30–50 ms.
