"""Evaluate a trained policy across N randomized environments.

Each episode samples a different physical configuration from the
domain-randomization ranges in `pendulum_env.py`:

    pendulum mass    ±10% around the sysid value
    pendulum COM     ±10%
    pendulum friction × [0.5, 2.0] of nominal
    motor tau        sampled from DR_MOTOR_TAU_RANGE_S
    action delay     sampled from DR_ACTION_DELAY_STEPS_RANGE
    motor stiction   sampled from DR_MOTOR_FRICTIONLOSS_RANGE_N_M
    + position/velocity observation noise + AS5600 encoder quantisation

For each episode, the policy is run deterministically for
`--episode-length-s` seconds. An episode counts as **solved** if:

    1. The pendulum was within ±`--upright-threshold-deg` of upright for
       at least `--success-frac` of the last `--hold-window-s` seconds.
    2. AND the episode did not terminate early on a ±135° hard-stop hit.

Defaults: ±15°, last 1.0 s, 0.9 fraction. Success criterion is then a
simple per-episode ✓/✗ which is aggregated into an overall solve rate.

The script seeds the env with `seed + episode_index` so the same
`--seed` reproduces an identical 20-episode physical-config set across
runs — useful for comparing policies head-to-head.

Phase 2 / 2.5 success target: solve rate ≥ 90% on N=20 episodes.

Usage:
    python eval_randomized.py runs/<run>/best_model.zip --n-episodes 20
    python eval_randomized.py runs/<run>/best_model.zip --n-episodes 50 --upright-threshold-deg 10

Output (per episode and summary):
    [ k/N] ✓/✗  reward  upright_last_Xs%  max|motor|°  tau  delay  TERM
    Solved: X/N (Y%)
    Mean reward, mean upright_last_window, hard-stop terminations.
"""

from __future__ import annotations

import argparse
import math
import sys
from pathlib import Path

import numpy as np
from stable_baselines3 import SAC

from pendulum_env import RotaryInvertedPendulumEnv, _wrap_pi
from run_config import find_run_config


def evaluate_one(model, env, *, episode_steps: int, upright_threshold_rad: float,
                 hold_window_s: float = 1.0, control_freq_hz: float = 35.0) -> dict:
    """Run a single episode. Return per-episode metrics."""
    obs, _ = env.reset()
    total_reward = 0.0
    upright_history = []
    motor_pos_history = []
    info = {}

    for _ in range(episode_steps):
        action, _ = model.predict(obs, deterministic=True)
        obs, r, term, trunc, info = env.step(action)
        total_reward += r

        # Recompute theta in env's sim convention (theta=0 upright).
        phi = float(info["phi"])
        theta = _wrap_pi(phi - math.pi)
        # Gate on pendulum velocity too (obs[4]) — a θ-band-only criterion
        # scores samples where the pendulum swings *through* upright at
        # speed, so spinning/Kapitza policies inflate it. 2 rad/s matches
        # analyze_deploy.honest_balance_metrics.
        pen_vel = float(obs[4])
        upright = abs(theta) <= upright_threshold_rad and abs(pen_vel) <= 2.0
        upright_history.append(upright)
        motor_pos_history.append(float(info["motor_pos"]))

        if term or trunc:
            break

    n = len(upright_history)
    last_window = int(hold_window_s * control_freq_hz)
    last_window = min(last_window, n)
    held = sum(upright_history[-last_window:]) / max(1, last_window)
    upright_frac = sum(upright_history) / max(1, n)
    return {
        "reward": total_reward,
        "steps": n,
        "terminated_early": term,
        "upright_frac_overall": float(upright_frac),
        "upright_frac_last_window": float(held),
        "max_motor_pos": float(max(abs(p) for p in motor_pos_history)) if motor_pos_history else 0.0,
        # The env publishes `action_lag_tau_s` (continuous tau, post-2026-05-16
        # rename from the legacy `motor_tau_s` field). Keep the metric key as
        # `motor_tau_s` so existing log consumers don't break, but read from
        # the correct source.
        "motor_tau_s": info.get("action_lag_tau_s", 0.0),
        "action_delay_steps": info.get("action_delay_steps", 0),
    }


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Evaluate a policy on N randomized envs")
    p.add_argument("policy", help="path to a .zip checkpoint")
    p.add_argument("--n-episodes", type=int, default=20)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--episode-length-s", type=float, default=8.0)
    p.add_argument("--control-freq", type=float, default=35.0,
                   help="canonical operating rate for this rig — see "
                        "docs/control_rate_selection.md.")
    p.add_argument("--upright-threshold-deg", type=float, default=15.0,
                   help="theta within ±this is counted as 'upright'")
    p.add_argument("--hold-window-s", type=float, default=1.0,
                   help="success = upright fraction in this trailing window >= 0.9")
    p.add_argument("--success-frac", type=float, default=0.9,
                   help="trailing-window upright fraction needed to call an episode 'solved'")
    p.add_argument("--device", default="cpu")
    p.add_argument("--action-mode", choices=("accel", "velocity", "position_delta"),
                   default=None,
                   help="default: read from the checkpoint's config.json "
                        "(fallback 'accel'). The action scales "
                        "(max_accel/max_velocity/max_action_delta) are also "
                        "taken from config.json when present.")
    p.add_argument("--no-randomize", action="store_true",
                   help="evaluate on the deterministic env instead")
    # DR range overrides. Module defaults sit on the wide side; pass these to
    # evaluate at a range that matches your training distribution / the rig.
    p.add_argument("--dr-delay-min", type=int, default=None,
                   help="override DR action-delay range minimum (steps)")
    p.add_argument("--dr-delay-max", type=int, default=None,
                   help="override DR action-delay range maximum (steps)")
    p.add_argument("--dr-accel-min", type=float, default=None,
                   help="override DR motor_max_accel range minimum (rad/s²)")
    p.add_argument("--dr-accel-max", type=float, default=None,
                   help="override DR motor_max_accel range maximum (rad/s²)")
    args = p.parse_args(argv if argv is not None else sys.argv[1:])

    print(f"Loading policy from {args.policy}")
    model = SAC.load(args.policy, device=args.device)

    delay_range = None
    if args.dr_delay_min is not None or args.dr_delay_max is not None:
        if args.dr_delay_min is None or args.dr_delay_max is None:
            p.error("--dr-delay-min and --dr-delay-max must be provided together")
        delay_range = (args.dr_delay_min, args.dr_delay_max)
    accel_range = None
    if args.dr_accel_min is not None or args.dr_accel_max is not None:
        if args.dr_accel_min is None or args.dr_accel_max is None:
            p.error("--dr-accel-min and --dr-accel-max must be provided together")
        accel_range = (args.dr_accel_min, args.dr_accel_max)

    # Action mode + scales come from the checkpoint's recorded config so the
    # eval env matches what the policy was trained on (both modes share the
    # same obs/action spaces, so a mismatch fails silently otherwise).
    cfg = find_run_config(args.policy) or {}
    action_mode = args.action_mode or cfg.get("action_mode", "accel")
    env_kwargs = dict(
        control_freq_hz=args.control_freq,
        episode_length_s=args.episode_length_s,
        action_mode=action_mode,
        obs_history_len=int(cfg.get("obs_history_len") or 1),
        obs_include_velocities=bool(cfg.get("obs_include_velocities", True)),
        firmware_obs_model=bool(cfg.get("firmware_obs_model", False)),
        domain_randomization=not args.no_randomize,
        dr_action_delay_steps_range=delay_range,
        dr_motor_accel_range_rad_s2=accel_range,
    )
    for cfg_key, env_key in (("max_accel_rad_s2", "max_accel_rad_s2"),
                             ("max_velocity_rad_s", "max_velocity_rad_s"),
                             ("max_action_delta_rad", "max_action_delta_rad")):
        if cfg.get(cfg_key) is not None:
            env_kwargs[env_key] = float(cfg[cfg_key])
    print(f"Eval env: action_mode={action_mode}"
          + (" (from config.json)" if args.action_mode is None and cfg else ""))
    env = RotaryInvertedPendulumEnv(**env_kwargs)
    if delay_range is not None or accel_range is not None:
        print(f"DR overrides: delay={delay_range} steps, accel={accel_range} rad/s²")
    # Make per-episode RNG distinct.
    env.reset(seed=args.seed)

    upright_thr_rad = math.radians(args.upright_threshold_deg)
    episode_steps = int(args.episode_length_s * args.control_freq)

    metrics = []
    for ep in range(args.n_episodes):
        env.reset(seed=args.seed + ep)
        m = evaluate_one(
            model, env,
            episode_steps=episode_steps,
            upright_threshold_rad=upright_thr_rad,
            hold_window_s=args.hold_window_s,
            control_freq_hz=args.control_freq,
        )
        m["solved"] = m["upright_frac_last_window"] >= args.success_frac and not m["terminated_early"]
        metrics.append(m)
        flag = "✓" if m["solved"] else "✗"
        print(
            f"[{ep+1:3d}/{args.n_episodes}] {flag} "
            f"reward={m['reward']:7.2f}  "
            f"upright_last_{args.hold_window_s:.0f}s={m['upright_frac_last_window']*100:5.1f}%  "
            f"max|motor|={math.degrees(m['max_motor_pos']):.1f}°  "
            f"tau={m['motor_tau_s']*1000:5.1f}ms  delay={m['action_delay_steps']}  "
            f"{'TERM' if m['terminated_early'] else ''}"
        )

    n_solved = sum(1 for m in metrics if m["solved"])
    print()
    print(f"Solved: {n_solved}/{len(metrics)} ({100.0*n_solved/len(metrics):.1f}%)")
    print(f"Mean reward: {np.mean([m['reward'] for m in metrics]):.2f}")
    print(f"Mean upright_last_window: {np.mean([m['upright_frac_last_window'] for m in metrics])*100:.1f}%")
    print(f"Hard-stop terminations: {sum(1 for m in metrics if m['terminated_early'])}")

    target = args.success_frac
    return 0 if (n_solved / len(metrics)) >= 0.9 else 1


if __name__ == "__main__":
    raise SystemExit(main())
