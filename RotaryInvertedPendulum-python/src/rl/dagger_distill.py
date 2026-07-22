"""DAgger refinement of a distilled student — the step that makes students deploy.

Plain behaviour cloning (distill.py) fits the teacher's actions on the
teacher's states, but at deploy time the student visits ITS OWN states, and
near the unstable equilibrium small action errors compound (covariate
shift). DAgger closes the loop: roll out the CURRENT student in sim, label
every state it visits with the teacher's deterministic action, aggregate,
retrain, repeat. Each round is gated closed-loop and the best-gating
student is kept.

The one knob that decided the 2026-07-22 on-device record: `--transport`.
Rollouts and the gate run under the transport of the TARGET DEPLOYMENT:

  device   — no tick delay, 5-15 ms lag (standalone RLControl.ino; the
             Nano has no serial/USB/host-inference latency). The recipe
             that produced the 0.892 BALANCED standalone champion.
  tethered — 1 tick + 0-15 ms lag (run_policy.py through LowLevelServer).

Aiming the DAgger at the wrong transport costs real performance (0.881 vs
0.892 on-device from the same teacher — and the direct-RL alternative
without imitation smoothing failed outright at 0.24; see
docs/end_to_end_runbook.md).

Usage (after distill.py has produced the BC student + dataset):

    python dagger_distill.py \\
        --teacher runs/<run>/best_model.zip \\
        --bc-dir  runs/<run>/distill_h16_aug \\
        --out-dir runs/<run>/distill_h16_dagger_dev \\
        --transport device
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

import numpy as np
import torch
import torch.nn.functional as F
from stable_baselines3 import SAC

from distill import StudentMLP, _student_predict_factory
from pendulum_env import RotaryInvertedPendulumEnv
from run_config import find_run_config


TRANSPORTS = {
    # (dr_delay_range, dr_lag_range) for rollouts; (delay, lag) for the gate
    "device": (((0, 0), (0.005, 0.015)), (0, 0.008)),
    "tethered": (((1, 1), (0.000, 0.015)), (1, 0.008)),
}


def make_env(cfg: dict, *, dr: bool, transport: str) -> RotaryInvertedPendulumEnv:
    (delay_range, lag_range), (gate_delay, gate_lag) = TRANSPORTS[transport]
    kwargs = dict(
        control_freq_hz=float(cfg.get("control_freq_hz", 35.0)),
        episode_length_s=8.0,
        action_mode=str(cfg.get("action_mode", "velocity")),
        obs_history_len=int(cfg.get("obs_history_len") or 1),
        obs_include_velocities=bool(cfg.get("obs_include_velocities", True)),
        firmware_obs_model=bool(cfg.get("firmware_obs_model", True)),
        domain_randomization=dr,
    )
    if dr:
        kwargs.update(dr_action_delay_steps_range=delay_range,
                      dr_action_lag_tau_range_s=lag_range)
    else:
        kwargs.update(dr_theta_bias_max_rad=0.0,
                      action_delay_steps=gate_delay,
                      action_lag_tau_s=gate_lag)
    for key in ("max_accel_rad_s2", "max_velocity_rad_s", "max_action_delta_rad"):
        if cfg.get(key) is not None:
            kwargs[key] = float(cfg[key])
    return RotaryInvertedPendulumEnv(**kwargs)


def gate(predict_fn, cfg: dict, transport: str, n_ep: int = 10) -> float:
    """Honest balanced fraction (|θ|≤15°, |θ̇|≤2 rad/s), deterministic."""
    env = make_env(cfg, dr=False, transport=transport)
    fracs = []
    for ep in range(n_ep):
        obs, _ = env.reset(seed=100 + ep)
        bal = n = 0
        done = False
        while not done:
            a, _ = predict_fn(obs, deterministic=True)
            obs, _, term, trunc, info = env.step(a)
            th = abs(((info["phi"] - np.pi + np.pi) % (2 * np.pi)) - np.pi)
            pv = abs(float(env.data.qvel[env._pen_qvel_addr]))
            # velocity gate 4.0 — see analyze_onboard.py
            bal += (th <= np.radians(15) and pv <= 4.0)
            n += 1
            done = term or trunc
        fracs.append(bal / max(1, n))
    return float(np.mean(fracs))


def rollout_and_label(predict_fn, teacher: SAC, cfg: dict, transport: str,
                      n_steps: int, seed0: int):
    env = make_env(cfg, dr=True, transport=transport)
    obs_l, act_l = [], []
    ep = 0
    while len(obs_l) < n_steps:
        obs, _ = env.reset(seed=seed0 + ep)
        done = False
        while not done and len(obs_l) < n_steps:
            obs_l.append(np.asarray(obs, dtype=np.float32).copy())
            ta, _ = teacher.predict(obs, deterministic=True)  # teacher labels
            act_l.append(np.asarray(ta, dtype=np.float32).reshape(-1))
            sa, _ = predict_fn(obs, deterministic=True)       # student drives
            obs, _, term, trunc, _ = env.step(sa)
            done = term or trunc
        ep += 1
    return np.stack(obs_l), np.stack(act_l)


def retrain(model: StudentMLP, obs: np.ndarray, tgt: np.ndarray,
            epochs: int, lr: float, batch: int, seed: int) -> float:
    obs_t = torch.from_numpy(obs)
    tgt_t = torch.from_numpy(tgt)
    opt = torch.optim.Adam(model.parameters(), lr=lr)
    torch.manual_seed(seed)
    n = obs_t.shape[0]
    loss = torch.tensor(float("nan"))
    for _ in range(epochs):
        perm = torch.randperm(n)
        for i in range(0, n, batch):
            sel = perm[i:i + batch]
            loss = F.mse_loss(model(obs_t[sel]), tgt_t[sel])
            opt.zero_grad()
            loss.backward()
            opt.step()
    return float(loss.item())


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="DAgger-refine a distilled student")
    p.add_argument("--teacher", required=True, type=Path,
                   help="SAC .zip to imitate (usually the rig-fine-tuned best_model)")
    p.add_argument("--bc-dir", required=True, type=Path,
                   help="distill.py output dir holding student.pt + dataset.npz "
                        "(the BC warm start and the initial aggregate dataset)")
    p.add_argument("--out-dir", required=True, type=Path)
    p.add_argument("--transport", choices=tuple(TRANSPORTS), default="device",
                   help="transport regime of the TARGET DEPLOYMENT (default: "
                        "device — the standalone Nano)")
    p.add_argument("--rounds", type=int, default=5)
    p.add_argument("--steps-per-round", type=int, default=40_000)
    p.add_argument("--epochs", type=int, default=300,
                   help="retrain epochs in round 1; decays as epochs/round")
    p.add_argument("--lr", type=float, default=5e-4)
    p.add_argument("--batch-size", type=int, default=1024)
    p.add_argument("--seed", type=int, default=0)
    args = p.parse_args(argv if argv is not None else sys.argv[1:])

    teacher = SAC.load(str(args.teacher), device="cpu")
    cfg = find_run_config(args.teacher) or {}

    ckpt = torch.load(args.bc_dir / "student.pt", map_location="cpu",
                      weights_only=True)
    student = StudentMLP(hidden=ckpt["hidden"], obs_dim=ckpt["obs_dim"],
                         act_dim=ckpt["act_dim"])
    student.load_state_dict(ckpt["state_dict"])
    data = np.load(args.bc_dir / "dataset.npz")
    agg_obs = np.asarray(data["obs"], dtype=np.float32)
    agg_act = np.asarray(data["action_target"], dtype=np.float32)

    args.out_dir.mkdir(parents=True, exist_ok=True)

    def save(mse: float) -> None:
        torch.save({"state_dict": student.state_dict(), "hidden": ckpt["hidden"],
                    "obs_dim": ckpt["obs_dim"], "act_dim": ckpt["act_dim"],
                    "val_mse": mse}, args.out_dir / "student.pt")

    predict = _student_predict_factory(student)
    best = gate(predict, cfg, args.transport)
    print(f"[dagger] round 0 (BC student): gate {best:.3f} "
          f"@ {args.transport} transport, dataset {len(agg_obs)}", flush=True)
    save(float("nan"))

    for r in range(1, args.rounds + 1):
        obs_new, act_new = rollout_and_label(
            predict, teacher, cfg, args.transport,
            args.steps_per_round, seed0=args.seed + r * 10_000)
        agg_obs = np.concatenate([agg_obs, obs_new])
        agg_act = np.concatenate([agg_act, act_new])
        mse = retrain(student, agg_obs, agg_act,
                      epochs=max(1, args.epochs // r), lr=args.lr,
                      batch=args.batch_size, seed=args.seed)
        predict = _student_predict_factory(student)
        score = gate(predict, cfg, args.transport)
        print(f"[dagger] round {r}: +{len(obs_new)} student-visited samples "
              f"(total {len(agg_obs)}), mse {mse:.5f}, gate {score:.3f}", flush=True)
        if score > best:
            best = score
            save(mse)
            print(f"[dagger]   new best -> {args.out_dir / 'student.pt'}", flush=True)

    print(f"[dagger] done. best gate {best:.3f} @ {args.transport} transport")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
