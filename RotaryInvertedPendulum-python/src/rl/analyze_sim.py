"""Score a policy in the deployment-transport sim — the off-rig counterpart
to `analyze_onboard.py`.

Reports the same honest balance metrics AND the same calmness metrics as
`analyze_onboard.py`, so a sim number and a rig number can be compared
side by side without re-deriving anything. Accepts either a SAC teacher
checkpoint (`.zip`) or a distilled student (`.pt`), so teacher→student
regressions show up before any rig time is spent.

Balance gate matches the rest of the stack: |θ| ≤ 15° AND |θ̇| ≤ 4 rad/s.

Calmness (measured over balanced samples only — a real Furuta balances
WITH arm motion, so the question is never "is the arm still" but "how much
motion does this policy need"):

    pendulum std   pendulum-angle scatter about upright
    arm std        motor-angle scatter about its mean
    arm off-centre mean |motor angle| — slow drift away from centre
    arm sway <1s   the sub-second component of arm motion (the balancing
                   wiggle), separated from slow drift
    arm speed      motor angular-speed RMS
    motor-cmd      mean |Δ smoothed action| × Hz — what the actuator (and
                   hence the base) actually sees; the base-excitation proxy

Usage:
    python analyze_sim.py runs/<run>_stage3/best_model.zip
    python analyze_sim.py runs/<run>/distill_h16_dagger_dev/student.pt
    python analyze_sim.py <policy> --transport tethered --episodes 20
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np

import balance_metrics
from dagger_distill import make_env
from run_config import find_run_config


def _load_policy(path: Path, device: str):
    """Return a `predict(obs, deterministic=True) -> (action, None)` callable."""
    if str(path).endswith(".pt"):
        import torch

        from distill import StudentMLP, _student_predict_factory

        ck = torch.load(path, map_location=device, weights_only=True)
        model = StudentMLP(hidden=ck["hidden"], obs_dim=ck["obs_dim"],
                           act_dim=ck["act_dim"]).eval()
        model.load_state_dict(ck["state_dict"])
        label = (f"student {ck['obs_dim']}->{ck['hidden']}->{ck['hidden']}"
                 f"->{ck['act_dim']}")
        return _student_predict_factory(model, device=device), label
    from stable_baselines3 import SAC

    model = SAC.load(path, device=device)
    return model.predict, "SAC teacher"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Score a policy in the deployment-transport sim")
    p.add_argument("policy", help="path to a SAC .zip or a distilled .pt")
    p.add_argument("--transport", choices=("device", "tethered"),
                   default="device",
                   help="which deployment transport to score under — "
                        "'device' (standalone RLControl: no tick delay, "
                        "5-15 ms lag) or 'tethered' (via LowLevelServer). "
                        "Must match where the policy will actually run.")
    p.add_argument("--episodes", type=int, default=20)
    p.add_argument("--seed", type=int, default=100,
                   help="first episode seed; episodes use seed+i so runs "
                        "are reproducible and comparable across policies")
    p.add_argument("--device", default="cpu")
    args = p.parse_args(argv if argv is not None else sys.argv[1:])

    policy_path = Path(args.policy)
    cfg = find_run_config(policy_path)
    if cfg is None:
        raise SystemExit(
            f"no config.json found near {policy_path} — cannot build a "
            "matching env (action mode, rate, smoothing window)")
    predict, label = _load_policy(policy_path, args.device)
    env = make_env(cfg, dr=False, transport=args.transport)
    hz = float(cfg.get("control_freq_hz", 50.0))

    scored = []
    for ep in range(args.episodes):
        obs, _ = env.reset(seed=args.seed + ep)
        motor, phi, action, cmd = [], [], [], []
        done = False
        while not done:
            a, _ = predict(obs, deterministic=True)
            obs, _, term, trunc, info = env.step(a)
            motor.append(float(info["motor_pos"]))
            phi.append(float(info["phi"]))
            action.append(float(np.asarray(a).reshape(-1)[0]))
            cmd.append(float(info["smoothed_action"]))
            done = term or trunc
        scored.append(balance_metrics.score(
            phi=phi, motor_pos=motor, action=action, hz=hz, motor_cmd=cmd))

    def avg(attr):
        vals = [getattr(m, attr) for m in scored if getattr(m, attr) is not None]
        return float(np.mean(vals)) if vals else None

    if avg("pendulum_std_deg") is None:
        print(f"{policy_path}: never held balance long enough to score "
              f"calmness (gate {avg('balanced_fraction'):.3f})")
        return 1

    print(f"\n{policy_path}")
    print(f"  {label}, {args.transport} transport, {args.episodes} episodes "
          f"@ {hz:.0f} Hz")
    print(f"  balanced fraction:       {avg('balanced_fraction'):.3f}")
    print(f"  longest balanced streak: {avg('longest_streak_s'):.2f} s "
          f"(per 8 s episode)")
    print(f"  pendulum std (bal):      {avg('pendulum_std_deg'):.2f} deg")
    print(f"  arm std (bal):           {avg('arm_std_deg'):.1f} deg")
    print(f"  arm off-centre (bal):    {avg('arm_off_centre_deg'):.1f} deg")
    print(f"  arm sway <1s (bal):      {avg('arm_sway_deg'):.2f} deg")
    print(f"  arm speed RMS (bal):     {avg('arm_speed_rms'):.2f} rad/s")
    print(f"  motor-cmd travel:        {avg('motor_cmd_travel'):.1f} /s")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
