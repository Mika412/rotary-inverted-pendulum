#!/usr/bin/env bash
# Turn a fine-tuned teacher into the small student that gets flashed.
#
# Runs the two stages that always follow one another — behaviour cloning, then
# DAgger at the deployment transport — and then scores the student in sim, so a
# teacher that cannot be imitated shows up before any rig time is spent. Same
# shape as curriculum_train.sh: the defaults are the validated recipe, env vars
# override. Directory names follow the existing convention, so runs made by
# hand and runs made by this script are interchangeable.
#
# Usage:
#   ./distill_student.sh <run-name>              # runs/<run-name>/best_model.zip
#   HIDDEN=32 ./distill_student.sh <run-name>
#
# Env:
#   HIDDEN=16              student width (16 is the production size)
#   TRANSPORT=device       where the student will run: device (standalone
#                          RLControl) or tethered (via LowLevelServer)
#   BC_EPOCHS / ROUNDS / STEPS_PER_ROUND / SEED   pass-through knobs
#   FORCE=1                re-run stages whose outputs already exist
#
# `--buffer` is passed automatically when the run has a replay buffer (a rig
# fine-tune); sim-only teachers are distilled from teacher rollouts alone.
#
# This deliberately does NOT write policy_weights.h — that header holds the
# best policy we have, and overwriting it should be a decision, not a side
# effect. The export + flash commands are printed at the end.

set -euo pipefail

RUN="${1:?usage: distill_student.sh <run-name> (a directory under runs/)}"
HIDDEN="${HIDDEN:-16}"
TRANSPORT="${TRANSPORT:-device}"
BC_EPOCHS="${BC_EPOCHS:-800}"
ROUNDS="${ROUNDS:-5}"
STEPS_PER_ROUND="${STEPS_PER_ROUND:-40000}"
SEED="${SEED:-0}"
# Per-rig sysid file. Unset → inherited from the teacher's config.json, which
# is normally what you want (the student should be gated against the same rig
# the teacher was trained for). Set it only to override that inheritance.
PARAMS_PATH="${PARAMS_PATH:-}"

cd "$(dirname "$0")"

PARAMS_ARGS=()
if [ -n "$PARAMS_PATH" ]; then
    PARAMS_ARGS=(--params-path "$PARAMS_PATH")
fi

RUN_DIR="runs/$RUN"
TEACHER="$RUN_DIR/best_model.zip"
if [ ! -f "$TEACHER" ]; then
    echo "no teacher at $TEACHER" >&2
    echo "(pass the run directory name, e.g. 'v11_async' or 'v11_stage3')" >&2
    exit 1
fi

# 'dev' rather than 'device' to match the directories already in runs/.
case "$TRANSPORT" in
    device)   T_SUFFIX=dev ;;
    tethered) T_SUFFIX=teth ;;
    *) echo "unknown TRANSPORT=$TRANSPORT (device|tethered)" >&2; exit 1 ;;
esac
BC_DIR="$RUN_DIR/distill_h${HIDDEN}_aug"
DAGGER_DIR="$RUN_DIR/distill_h${HIDDEN}_dagger_${T_SUFFIX}"
STUDENT="$DAGGER_DIR/student.pt"

# Expanded via ${arr[@]+"${arr[@]}"} below — plain "${arr[@]}" on an empty
# array trips `set -u` on macOS's bash 3.2 (same trap as curriculum_train.sh).
BUFFER_ARGS=()
if [ -f "$RUN_DIR/replay_buffer.pkl" ]; then
    BUFFER_ARGS=(--buffer "$RUN_DIR/replay_buffer.pkl")
    echo "Distilling $RUN (h$HIDDEN, $TRANSPORT transport, real-rig buffer + sim rollouts)"
else
    echo "Distilling $RUN (h$HIDDEN, $TRANSPORT transport, sim rollouts only — no replay buffer)"
fi

FORCE_ARGS=()
[ -n "${FORCE:-}" ] && FORCE_ARGS=(--force)

echo "=== 1/3 behaviour cloning -> $BC_DIR ==="
if [ -f "$BC_DIR/student.pt" ] && [ -z "${FORCE:-}" ]; then
    echo "  exists, skipping (FORCE=1 to redo)"
else
    python distill.py \
        --teacher "$TEACHER" \
        ${BUFFER_ARGS[@]+"${BUFFER_ARGS[@]}"} \
        --out-dir "$BC_DIR" \
        --hidden "$HIDDEN" \
        --epochs "$BC_EPOCHS" \
        --seed "$SEED" \
        ${PARAMS_ARGS[@]+"${PARAMS_ARGS[@]}"} \
        ${FORCE_ARGS[@]+"${FORCE_ARGS[@]}"}
fi

echo "=== 2/3 DAgger at the $TRANSPORT transport -> $DAGGER_DIR ==="
python dagger_distill.py \
    --teacher "$TEACHER" \
    --bc-dir "$BC_DIR" \
    --out-dir "$DAGGER_DIR" \
    --transport "$TRANSPORT" \
    --rounds "$ROUNDS" \
    --steps-per-round "$STEPS_PER_ROUND" \
    --seed "$SEED" \
    ${PARAMS_ARGS[@]+"${PARAMS_ARGS[@]}"}

echo "=== 3/3 scoring the student in sim ==="
python analyze_sim.py "$STUDENT" --transport "$TRANSPORT" \
    ${PARAMS_ARGS[@]+"${PARAMS_ARGS[@]}"}

cat <<EOF

Judge the gate against the TEACHER's, not an absolute bar — sim under-predicts
smooth students on the rig, most of all when the teacher was rig-fine-tuned:
    python analyze_sim.py $TEACHER

To flash this student (overwrites the header holding the current best policy):
    python export_weights.py --student $STUDENT \\
        --header ../../../RotaryInvertedPendulum-arduino/RLControl/policy_weights.h \\
        --source-name $RUN/$(basename "$DAGGER_DIR")
    (cd ../../.. && arduino-cli compile --upload -p /dev/cu.usbserial-10 \\
        --fqbn arduino:avr:nano:cpu=atmega328 RotaryInvertedPendulum-arduino/RLControl)
    python analyze_onboard.py --port /dev/cu.usbserial-10 --duration-s 300 \\
        --log recordings/$RUN.npz

Restore the current best policy with:
    git checkout -- ../../../RotaryInvertedPendulum-arduino/RLControl/policy_weights.h
EOF
