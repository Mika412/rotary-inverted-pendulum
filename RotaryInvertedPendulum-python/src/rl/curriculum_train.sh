#!/usr/bin/env bash
# Curriculum-learning training script. 3 stages, each --resumes from the
# previous, so the policy doesn't relearn the basics every time.
#
#   Stage 1: NO DR                                   (find the swing-up + balance skill)
#   Stage 2: delay ∈ {0, 1} ticks + tau ∈ [0, 20 ms] (introduce transport delay)
#   Stage 3: delay = 1 tick + tau ∈ [0, 15 ms]       (concentrate on the measurement)
#
# Transport-delay model: an integer-tick queue composed with a first-order
# lag, both applied (in velocity mode) to the accel COMMAND the host sends
# — the P-law itself runs host-side with no delay. Teacher-forced one-step
# fits over the 2026-07-21 deploy logs measured the TOTAL command→motion
# delay at ~30–45 ms at 35 Hz and ~15–30 ms at 50 Hz — i.e. consistently
# MORE than one control tick at 35 Hz. The earlier "τ ≈ 17 ms" story came
# from the standalone probe, which misses the read-side latency the full
# closed loop pays every tick; and the pre-2026-07-21 replay analysis
# additionally suffered a one-step alignment bug in sim_vs_real.py.
# Stage 3 = 1 tick + [0, 15 ms] brackets the measurement at both rates
# (28.6–43.6 ms at 35 Hz, 20–35 ms at 50 Hz). See website/src/content/docs/reference/transport-delay.md.
#
# Stage-3 concentration rationale (unchanged): wider DR spreads training
# mass over scenarios the rig never produces and the policy turns
# conservative — concentrate near the measurement, keep stage 2 wider
# only as a curriculum ramp.
#
# Per the 2026-05-16 DR-sensitivity probe, every other DR dimension
# (motor accel envelope, pendulum mass/COM/friction, dt jitter, encoder
# noise, motor stiction) is benign at deploy. Stage 2/3 leave those at
# the env's defaults — they activate alongside action-lag when
# --domain-randomization is on, giving free robustness without an extra
# curriculum knob to tune.
#
# Control rate: 50 Hz validated 2026-05-20 with sustained-balance deploy
# (0.968 avg upright). The earlier "35 Hz sweet spot" finding was a
# position-mode artifact (planning thrash at high rates); accel mode
# composes commands smoothly. See website/src/content/docs/reference/control-rate.md.
#
# Usage:
#     ./curriculum_train.sh <run-name-prefix>
# Produces runs/<prefix>_stage{1,2,3}/, final policy at
# runs/<prefix>_stage3/best_model.zip.
#
# Run from this directory, e.g. `uv run bash curriculum_train.sh <prefix>`.
#
# Defaults = the validated vel_v8 production recipe (2026-07-22):
# velocity mode @ 35 Hz, ±3.5 rad/s authority, K=4 frame stacking, gSDE,
# stillness bonus 5, firmware measurement model on. `bash
# curriculum_train.sh <name>` with no env vars trains the canonical
# teacher. Legacy modes (accel / position_delta) remain selectable.
#
# Environment overrides (defaults shown):
#     CONTROL_FREQ=35
#     ACTION_MODE=velocity                 # or accel / position_delta (legacy)
#     MAX_ACCEL_RAD_S2=150
#     MAX_VELOCITY_RAD_S=3.5               # velocity-mode action scale = the
#                                          # policy's correction authority (also
#                                          # the accel-mode speed cap).
#     MAX_ACTION_DELTA_RAD=                 # position mode only; unset → env default 0.10
#     STEPS_PER_STAGE=100000
#     SEED=0
#     DEVICE=cuda                          # use cpu on macOS laptop
#     DR_LAG_TAU_MIN_S2=0.000              # stage 2 lag lower bound (s)
#     DR_LAG_TAU_MAX_S2=0.020              # stage 2 lag upper bound (s)
#     DR_LAG_TAU_MIN_S3=0.000              # stage 3 lag lower bound (s)
#     DR_LAG_TAU_MAX_S3=0.015              # stage 3 lag upper bound (s)
#     DR_DELAY_MIN_S2=0                    # stage 2 integer-tick delay lower bound
#     DR_DELAY_MAX_S2=1                    # stage 2 integer-tick delay upper bound
#     DR_DELAY_MIN_S3=1                    # stage 3 integer-tick delay lower bound
#     DR_DELAY_MAX_S3=1                    # stage 3 integer-tick delay upper bound
#     FIRMWARE_OBS_MODEL=                  # if set (any value), sim observations and
#                                          # the velocity-mode P-law feedback come from
#                                          # a model of the firmware measurement
#                                          # pipeline (quantised positions, 8 ms
#                                          # window-difference velocities, 2–10 ms
#                                          # staleness) instead of perfect MuJoCo
#                                          # state. Recorded in config.json.
#     REWARD_ACTION_RATE_WEIGHT=           # if set, re-enables the (a_t − a_{t-1})² penalty
#                                          # to suppress motor chatter at balance. Measured
#                                          # ineffective against the learned PWM dither at
#                                          # every weight tried (0.03/0.3/1.0) — use
#                                          # ACTION_SMOOTH_WINDOW instead.
#     ACTION_SMOOTH_WINDOW=                # if set, the actuator receives the moving average
#                                          # of the last N policy outputs (firmware boxcar,
#                                          # mirrored in sim). 4 nulls the PWM dither at
#                                          # rate/2 and rate/4 exactly (1.5-tick delay).
#                                          # Must match ACTION_SMOOTH_WINDOW in RLControl.ino.
#     OBS_HISTORY_LEN=                     # frames stacked into the observation;
#                                          # unset → env default 1 (single frame).
#                                          # 4 gives the policy obs+action history
#                                          # to filter sensor noise and infer the
#                                          # per-episode θ-bias.
#     DROP_VEL_OBS=                        # if set (any value), observation frames
#                                          # are positions-only — the policy derives
#                                          # velocities from the stacked history.
#                                          # Requires OBS_HISTORY_LEN >= 2.
#     USE_SDE=                             # if set (any value), train with gSDE
#                                          # (smooth state-dependent exploration
#                                          # instead of per-step Gaussian noise).
#                                          # Only affects stage 1 — resumed stages
#                                          # keep the checkpoint's setting.
#     MIRROR_AUGMENT=                      # DEFAULT ON. Set 0 or empty to opt out.
#                                          # Every transition is
#                                          # stored with its mirror image (Ms, -a, r, Ms').
#                                          # The plant, reward and reset distribution are
#                                          # all mirror-symmetric, so this is exact —
#                                          # it stops SAC picking an arbitrary preferred
#                                          # swing-up direction. Applies to all three
#                                          # stages. Check the result with
#                                          # `analyze_symmetry.py runs/<prefix>_stage3/best_model.zip`
#                                          # — the engage-state self-start must still pass.
#                                          # See website/src/content/docs/reference/symmetry.md.

set -euo pipefail

PREFIX="${1:-curriculum}"
SEED="${SEED:-0}"
# Resume point: 2 or 3 skips earlier stages and picks up their best_model.zip.
START_STAGE="${START_STAGE:-1}"
STEPS_PER_STAGE="${STEPS_PER_STAGE:-100000}"
DEVICE="${DEVICE:-cuda}"
CONTROL_FREQ="${CONTROL_FREQ:-50}"
ACTION_MODE="${ACTION_MODE:-velocity}"
MAX_ACCEL_RAD_S2="${MAX_ACCEL_RAD_S2:-150}"
MAX_ACTION_DELTA_RAD="${MAX_ACTION_DELTA_RAD:-}"
MAX_VELOCITY_RAD_S="${MAX_VELOCITY_RAD_S:-3.5}"
DR_LAG_TAU_MIN_S2="${DR_LAG_TAU_MIN_S2:-0.000}"
DR_LAG_TAU_MAX_S2="${DR_LAG_TAU_MAX_S2:-0.020}"
DR_LAG_TAU_MIN_S3="${DR_LAG_TAU_MIN_S3:-0.000}"
DR_LAG_TAU_MAX_S3="${DR_LAG_TAU_MAX_S3:-0.015}"
DR_DELAY_MIN_S2="${DR_DELAY_MIN_S2:-0}"
DR_DELAY_MAX_S2="${DR_DELAY_MAX_S2:-1}"
DR_DELAY_MIN_S3="${DR_DELAY_MIN_S3:-1}"
DR_DELAY_MAX_S3="${DR_DELAY_MAX_S3:-1}"
FIRMWARE_OBS_MODEL="${FIRMWARE_OBS_MODEL:-1}"
REWARD_ACTION_RATE_WEIGHT="${REWARD_ACTION_RATE_WEIGHT:-}"
REWARD_STILLNESS_BONUS_WEIGHT="${REWARD_STILLNESS_BONUS_WEIGHT:-5}"
USE_SDE="${USE_SDE:-1}"
OBS_HISTORY_LEN="${OBS_HISTORY_LEN:-4}"
DROP_VEL_OBS="${DROP_VEL_OBS:-}"
# ON by default: the flashed champion is the mirror-augmented student, so a
# bare run has to include it to reproduce the champion. MIRROR_AUGMENT= (empty)
# opts out.
MIRROR_AUGMENT="${MIRROR_AUGMENT-1}"
ACTION_SMOOTH_WINDOW="${ACTION_SMOOTH_WINDOW:-4}"
NET_ARCH="${NET_ARCH:-}"
REWARD_MOTOR_POS_WEIGHT="${REWARD_MOTOR_POS_WEIGHT:-}"
DR_OBS_STALENESS_MAX="${DR_OBS_STALENESS_MAX:-}"
REWARD_MOTOR_VEL_WEIGHT="${REWARD_MOTOR_VEL_WEIGHT:-}"

# Optional flag block: only pass each --reward-* arg if the user set it.
# Expanded via ${arr[@]+"${arr[@]}"} below — plain "${arr[@]}" on an empty
# array trips `set -u` on macOS's bash 3.2.
EXTRA_REWARD_ARGS=()
if [ -n "$REWARD_ACTION_RATE_WEIGHT" ]; then
    EXTRA_REWARD_ARGS+=(--reward-action-rate-weight "$REWARD_ACTION_RATE_WEIGHT")
fi
if [ -n "$REWARD_STILLNESS_BONUS_WEIGHT" ]; then
    EXTRA_REWARD_ARGS+=(--reward-stillness-bonus-weight "$REWARD_STILLNESS_BONUS_WEIGHT")
fi

# Action-mode args threaded into every stage so the whole curriculum trains
# one consistent mode. --max-action-delta-rad only bites in position mode.
COMMON_ARGS=(--action-mode "$ACTION_MODE")
if [ -n "$MAX_ACTION_DELTA_RAD" ]; then
    COMMON_ARGS+=(--max-action-delta-rad "$MAX_ACTION_DELTA_RAD")
fi
if [ -n "$MAX_VELOCITY_RAD_S" ]; then
    COMMON_ARGS+=(--max-velocity-rad-s "$MAX_VELOCITY_RAD_S")
fi
if [ -n "$USE_SDE" ]; then
    COMMON_ARGS+=(--use-sde)
fi
if [ -n "$OBS_HISTORY_LEN" ]; then
    COMMON_ARGS+=(--obs-history-len "$OBS_HISTORY_LEN")
fi
if [ -n "$DROP_VEL_OBS" ]; then
    COMMON_ARGS+=(--drop-velocity-obs)
fi
if [ -n "$FIRMWARE_OBS_MODEL" ]; then
    COMMON_ARGS+=(--firmware-obs-model)
fi
if [ -n "$MIRROR_AUGMENT" ] && [ "$MIRROR_AUGMENT" != 0 ]; then
    COMMON_ARGS+=(--mirror-augment)
fi
if [ -n "$ACTION_SMOOTH_WINDOW" ]; then
    COMMON_ARGS+=(--action-smooth-window "$ACTION_SMOOTH_WINDOW")
fi
if [ -n "$DR_OBS_STALENESS_MAX" ]; then
    COMMON_ARGS+=(--dr-obs-staleness-max "$DR_OBS_STALENESS_MAX")
fi
if [ -n "$NET_ARCH" ]; then
    COMMON_ARGS+=(--net-arch "$NET_ARCH")
fi
if [ -n "$REWARD_MOTOR_POS_WEIGHT" ]; then
    COMMON_ARGS+=(--reward-motor-pos-weight "$REWARD_MOTOR_POS_WEIGHT")
fi
if [ -n "$REWARD_MOTOR_VEL_WEIGHT" ]; then
    COMMON_ARGS+=(--reward-motor-vel-weight "$REWARD_MOTOR_VEL_WEIGHT")
fi

run_stage1="${PREFIX}_stage1"
run_stage2="${PREFIX}_stage2"
run_stage3="${PREFIX}_stage3"

echo "Curriculum config:"
echo "  action mode: ${ACTION_MODE}"
if [ -n "$USE_SDE" ]; then
    echo "  exploration: gSDE"
fi
if [ -n "$FIRMWARE_OBS_MODEL" ]; then
    echo "  firmware measurement model: ON"
fi
if [ -n "$MIRROR_AUGMENT" ] && [ "$MIRROR_AUGMENT" != 0 ]; then
    echo "  mirror augmentation: ON (every transition stored with its mirror)"
else
    echo "  mirror augmentation: OFF (asymmetric baseline)"
fi
if [ -n "$DR_OBS_STALENESS_MAX" ]; then
    echo "  obs staleness DR: up to ${DR_OBS_STALENESS_MAX} s (measured rig value 0.0156)"
fi
if [ -n "$REWARD_STILLNESS_BONUS_WEIGHT" ]; then
    echo "  reward_stillness_bonus_weight: $REWARD_STILLNESS_BONUS_WEIGHT"
fi
echo "  control rate: ${CONTROL_FREQ} Hz, max accel: ${MAX_ACCEL_RAD_S2} rad/s²"
echo "  stage 2 delay: [${DR_DELAY_MIN_S2}, ${DR_DELAY_MAX_S2}] ticks + lag tau [$(awk -v t="$DR_LAG_TAU_MIN_S2" 'BEGIN{ printf "%.0f", t*1000 }'), $(awk -v t="$DR_LAG_TAU_MAX_S2" 'BEGIN{ printf "%.0f", t*1000 }')] ms"
echo "  stage 3 delay: [${DR_DELAY_MIN_S3}, ${DR_DELAY_MAX_S3}] ticks + lag tau [$(awk -v t="$DR_LAG_TAU_MIN_S3" 'BEGIN{ printf "%.0f", t*1000 }'), $(awk -v t="$DR_LAG_TAU_MAX_S3" 'BEGIN{ printf "%.0f", t*1000 }')] ms"
if [ -n "$REWARD_ACTION_RATE_WEIGHT" ]; then
    echo "  reward_action_rate_weight: $REWARD_ACTION_RATE_WEIGHT (re-enabled, default 0.0)"
fi
if [ -n "$ACTION_SMOOTH_WINDOW" ]; then
    echo "  action_smooth_window: $ACTION_SMOOTH_WINDOW (firmware boxcar on the action)"
fi
if [ -n "$NET_ARCH" ]; then
    echo "  net_arch: $NET_ARCH (actor/critic hidden sizes)"
fi
if [ -n "$REWARD_MOTOR_POS_WEIGHT" ]; then
    echo "  reward_motor_pos_weight: $REWARD_MOTOR_POS_WEIGHT (arm centering, default 0.5)"
fi
if [ -n "$REWARD_MOTOR_VEL_WEIGHT" ]; then
    echo "  reward_motor_vel_weight: $REWARD_MOTOR_VEL_WEIGHT (arm-speed damping, default 0.005)"
fi
echo

if [ "$START_STAGE" -le 1 ]; then
echo "=== Stage 1 (no DR) ==="
python -u train_sac.py \
    --total-steps "$STEPS_PER_STAGE" \
    --device "$DEVICE" \
    --control-freq "$CONTROL_FREQ" \
    --max-accel-rad-s2 "$MAX_ACCEL_RAD_S2" \
    "${COMMON_ARGS[@]}" \
    ${EXTRA_REWARD_ARGS[@]+"${EXTRA_REWARD_ARGS[@]}"} \
    --run-name "$run_stage1" \
    --seed "$SEED"
else
    echo "=== Stage 1 skipped (START_STAGE=$START_STAGE) ==="
fi

if [ "$START_STAGE" -le 2 ]; then
echo "=== Stage 2 (delay [${DR_DELAY_MIN_S2}, ${DR_DELAY_MAX_S2}] ticks, lag tau [${DR_LAG_TAU_MIN_S2}, ${DR_LAG_TAU_MAX_S2}] s) ==="
python -u train_sac.py \
    --total-steps "$STEPS_PER_STAGE" \
    --device "$DEVICE" \
    --control-freq "$CONTROL_FREQ" \
    --max-accel-rad-s2 "$MAX_ACCEL_RAD_S2" \
    --domain-randomization \
    --dr-action-lag-tau-min "$DR_LAG_TAU_MIN_S2" \
    --dr-action-lag-tau-max "$DR_LAG_TAU_MAX_S2" \
    --dr-delay-min "$DR_DELAY_MIN_S2" \
    --dr-delay-max "$DR_DELAY_MAX_S2" \
    "${COMMON_ARGS[@]}" \
    ${EXTRA_REWARD_ARGS[@]+"${EXTRA_REWARD_ARGS[@]}"} \
    --resume "runs/${run_stage1}/best_model.zip" \
    --run-name "$run_stage2" \
    --seed "$SEED"
else
    echo "=== Stage 2 skipped (START_STAGE=$START_STAGE) ==="
fi

echo "=== Stage 3 (delay [${DR_DELAY_MIN_S3}, ${DR_DELAY_MAX_S3}] ticks, lag tau [${DR_LAG_TAU_MIN_S3}, ${DR_LAG_TAU_MAX_S3}] s) ==="
python -u train_sac.py \
    --total-steps "$STEPS_PER_STAGE" \
    --device "$DEVICE" \
    --control-freq "$CONTROL_FREQ" \
    --max-accel-rad-s2 "$MAX_ACCEL_RAD_S2" \
    --domain-randomization \
    --dr-action-lag-tau-min "$DR_LAG_TAU_MIN_S3" \
    --dr-action-lag-tau-max "$DR_LAG_TAU_MAX_S3" \
    --dr-delay-min "$DR_DELAY_MIN_S3" \
    --dr-delay-max "$DR_DELAY_MAX_S3" \
    "${COMMON_ARGS[@]}" \
    ${EXTRA_REWARD_ARGS[@]+"${EXTRA_REWARD_ARGS[@]}"} \
    --resume "runs/${run_stage2}/best_model.zip" \
    --run-name "$run_stage3" \
    --seed "$SEED"

echo "=== Curriculum complete. Final policy: runs/${run_stage3}/best_model.zip ==="
echo "Deploy/fine-tune at the same control rate AND action mode: --control-freq ${CONTROL_FREQ} --action-mode ${ACTION_MODE}"
