"""Score how mirror-symmetric a policy is — one number, any policy format.

The plant, the reward and the reset distribution are all mirror-symmetric
(see `symmetry.py`), so an ideal policy satisfies pi(Ms) = -pi(s). Nothing in
SAC enforces that, and a policy that breaks it swings up one way
preferentially and catches worse on the other side. This script measures it.

Accepts the three forms a policy exists in on this project:

    runs/<run>/best_model.zip                SAC teacher
    runs/<run>/distill_h16/student.pt        distilled student
    ../firmware/RLControl/policy_weights.h
                                             what is actually flashed

State distribution to score over (in decreasing order of how much the number
means, since only states the policy actually visits matter):

    --sim-steps N     roll the policy out in the DR sim (default)
    --dataset x.npz   a distill dataset's `obs` (exact rig+sim obs vectors)
    --buffer x.pkl    a replay buffer's observations
    --random N        uniform box over plausible states — coarse global check

Usage:
    python analyze_symmetry.py ../firmware/RLControl/policy_weights.h
    python analyze_symmetry.py runs/<run>/best_model.zip --sim-steps 20000
    python analyze_symmetry.py runs/<run>/distill_h16/student.pt --dataset runs/<run>/distill_h16/dataset.npz
"""

from __future__ import annotations

import argparse
import math
import re
import sys
from pathlib import Path

import numpy as np

import symmetry
from run_config import find_run_config


# ---------------------------------------------------------------------------
# Policy loading — each loader returns (predict_fn, obs_dim, label)
# ---------------------------------------------------------------------------

def _load_sac(path: Path, device: str):
    from stable_baselines3 import SAC

    model = SAC.load(str(path), device=device)
    obs_dim = int(model.observation_space.shape[0])

    def predict(obs):
        return model.predict(obs, deterministic=True)[0]

    return predict, obs_dim, f"SAC teacher ({obs_dim}-dim obs)"


def _load_student(path: Path, device: str):
    import torch

    from distill import StudentMLP

    ckpt = torch.load(path, map_location=device, weights_only=True)
    model = StudentMLP(hidden=ckpt["hidden"], obs_dim=ckpt["obs_dim"],
                       act_dim=ckpt["act_dim"]).to(device).eval()
    model.load_state_dict(ckpt["state_dict"])

    @torch.no_grad()
    def predict(obs):
        t = torch.from_numpy(np.asarray(obs, dtype=np.float32)).to(device)
        return model(t).cpu().numpy()

    return (predict, int(ckpt["obs_dim"]),
            f"student MLP h{ckpt['hidden']} ({ckpt['obs_dim']}-dim obs, "
            f"val_mse={ckpt.get('val_mse', float('nan')):.6f})")


def _load_weights_header(path: Path, _device: str):
    """Parse `policy_weights.h` and rebuild the forward pass in numpy.

    Reads the flashed artefact itself, so this measures the policy the rig
    is actually running — not a checkpoint that may or may not match it.
    Mirrors `numpy_forward` in distill.py (ReLU, ReLU, tanh).
    """
    txt = path.read_text()

    def grab(name: str) -> list[float]:
        i = txt.index(f"POLICY_{name}[")
        j = txt.index("};", i)
        return [float(v) for v in
                re.findall(r"([-+]?\d*\.?\d+(?:e[-+]?\d+)?)f", txt[i:j])]

    obs_dim = int(re.search(r"POLICY_OBS_DIM\s+(\d+)", txt).group(1))
    hidden = int(re.search(r"POLICY_HIDDEN_DIM\s+(\d+)", txt).group(1))
    W1 = np.array(grab("W1"), dtype=np.float32).reshape(hidden, obs_dim)
    B1 = np.array(grab("B1"), dtype=np.float32)
    W2 = np.array(grab("W2"), dtype=np.float32).reshape(hidden, hidden)
    B2 = np.array(grab("B2"), dtype=np.float32)
    W3 = np.array(grab("W3"), dtype=np.float32).reshape(1, hidden)
    B3 = np.array(grab("B3"), dtype=np.float32)

    def predict(obs):
        x = np.asarray(obs, dtype=np.float32)
        h1 = np.maximum(0.0, x @ W1.T + B1)
        h2 = np.maximum(0.0, h1 @ W2.T + B2)
        return np.tanh(h2 @ W3.T + B3)

    return predict, obs_dim, f"flashed weights {obs_dim}->{hidden}->{hidden}->1"


def load_policy(path: Path, device: str):
    if path.suffix == ".zip":
        return _load_sac(path, device)
    if path.suffix in (".pt", ".pth"):
        return _load_student(path, device)
    if path.suffix == ".h":
        return _load_weights_header(path, device)
    raise SystemExit(f"unrecognised policy format: {path.suffix} "
                     "(expected .zip, .pt or .h)")


# ---------------------------------------------------------------------------
# State distributions
# ---------------------------------------------------------------------------

def obs_from_sim(predict, *, n_steps: int, obs_dim: int, config: dict,
                 control_freq_hz: float, seed: int) -> np.ndarray:
    """Roll the policy out in the DR sim and collect the states it visits."""
    from pendulum_env import RotaryInvertedPendulumEnv

    env_kwargs = dict(
        control_freq_hz=control_freq_hz,
        episode_length_s=8.0,
        domain_randomization=True,
        action_mode=str(config.get("action_mode", "accel")),
        obs_history_len=int(config.get("obs_history_len") or 1),
        obs_include_velocities=bool(config.get("obs_include_velocities", True)),
        firmware_obs_model=bool(config.get("firmware_obs_model", False)),
        action_smooth_window=int(config.get("action_smooth_window") or 1),
    )
    for key in ("max_accel_rad_s2", "max_velocity_rad_s", "max_action_delta_rad"):
        if config.get(key) is not None:
            env_kwargs[key] = float(config[key])
    env = RotaryInvertedPendulumEnv(**env_kwargs)
    if int(env.observation_space.shape[0]) != obs_dim:
        raise SystemExit(
            f"env obs_dim {env.observation_space.shape[0]} != policy obs_dim "
            f"{obs_dim} — pass --obs-history-len to match the policy "
            f"(config.json said K={env_kwargs['obs_history_len']})"
        )
    collected: list[np.ndarray] = []
    ep = 0
    while sum(len(c) for c in collected) < n_steps:
        obs, _ = env.reset(seed=seed + ep)
        rows = []
        for _ in range(int(env.episode_length_s * control_freq_hz)):
            rows.append(np.asarray(obs, dtype=np.float32).copy())
            a = np.asarray(predict(np.asarray(obs, dtype=np.float32)[None, :]))
            obs, _, term, trunc, _ = env.step(a.reshape(-1))
            if term or trunc:
                break
        collected.append(np.asarray(rows, dtype=np.float32))
        ep += 1
    out = np.concatenate(collected, axis=0)[:n_steps]
    print(f"  sampled {len(out)} states from {ep} DR-sim episodes")
    return out


def obs_from_random(*, n: int, obs_dim: int, obs_history_len: int,
                    seed: int) -> np.ndarray:
    """Uniform box over plausible states, with a frozen frame history.

    Deliberately crude: the history is one frame repeated, so this covers the
    input space broadly but not the temporal manifold the policy really sees.
    Use it as a global sanity check, not as the headline number.
    """
    from pendulum_env import MOTOR_SAFE_LIMIT_RAD, MAX_VELOCITY_RAD_S

    rng = np.random.default_rng(seed)
    frame_dim = obs_dim // obs_history_len
    theta = rng.uniform(-np.pi, np.pi, n)
    cols = [rng.uniform(-MOTOR_SAFE_LIMIT_RAD, MOTOR_SAFE_LIMIT_RAD, n),
            np.sin(theta), np.cos(theta)]
    if frame_dim == symmetry.FRAME_DIM_WITH_VEL:
        cols += [rng.uniform(-MAX_VELOCITY_RAD_S, MAX_VELOCITY_RAD_S, n),
                 rng.uniform(-25.0, 25.0, n)]
    cols.append(rng.uniform(-1.0, 1.0, n))
    frame = np.stack(cols, axis=1).astype(np.float32)
    return np.tile(frame, obs_history_len)


def obs_from_dataset(path: Path) -> np.ndarray:
    d = np.load(path)
    if "obs" not in d.files:
        raise SystemExit(f"{path} has no 'obs' array (keys: {d.files})")
    return np.asarray(d["obs"], dtype=np.float32)


def obs_from_buffer(path: Path) -> np.ndarray:
    import pickle

    with open(path, "rb") as f:
        rb = pickle.load(f)
    obs = np.asarray(rb.observations, dtype=np.float32)
    if obs.ndim == 3:  # (buffer_size, n_envs, obs_dim)
        obs = obs[:, 0, :]
    n = int(rb.size())
    if rb.full:
        pos = int(rb.pos)
        return np.concatenate([obs[pos:], obs[:pos]], axis=0)
    return obs[:n]


# ---------------------------------------------------------------------------
# Reporting
# ---------------------------------------------------------------------------

def theta_sweep(predict, *, obs_history_len: int, obs_include_velocities: bool,
                thetas=(-0.20, -0.10, -0.05, -0.02, 0.0, 0.02, 0.05, 0.10, 0.20),
                ) -> list[str]:
    """Action vs theta at rest, arm centred — the balance gain, both sides.

    Equivariance forces pi(-theta) = -pi(theta) here, so the two columns
    should be mirror images. A gain that differs between the sides is the
    balance half of the asymmetry (the swing-up half shows up at the engage
    state).
    """
    lines = ["  theta      action     mirrored -action    |sum|"]
    for th in thetas:
        obs = symmetry.engage_obs(obs_history_len=obs_history_len,
                                  obs_include_velocities=obs_include_velocities,
                                  theta=th)
        obs_m = symmetry.engage_obs(obs_history_len=obs_history_len,
                                    obs_include_velocities=obs_include_velocities,
                                    theta=-th)
        a = float(np.asarray(predict(obs[None, :])).reshape(-1)[0])
        am = float(np.asarray(predict(obs_m[None, :])).reshape(-1)[0])
        lines.append(f"  {math.degrees(th):+6.1f} deg  {a:+8.4f}   "
                     f"{-am:+8.4f}          {abs(a + am):.4f}")
    return lines


def engage_rollout(predict, *, config: dict, obs_history_len: int,
                   control_freq_hz: float, seconds: float) -> list[str]:
    """Will this policy start at all from the rig's exact engage state?

    The rig tares the arm and the encoder at engage, so the first observation
    is the mirror fixed point — where a symmetric policy is *supposed* to be
    near zero. That is the price of symmetry (see `symmetry.py`), and this
    check prices it before anything is flashed: it puts the sim in exactly
    that state, with no DR and no theta bias to break the tie, and reports
    how long the policy takes to get up and how hard it pushes on the way.

    A policy that never reaches upright here would sit still on the rig too,
    and needs a deliberate tie-break (engage from a non-centred arm).
    """
    from pendulum_env import RotaryInvertedPendulumEnv

    env_kwargs = dict(
        control_freq_hz=control_freq_hz,
        episode_length_s=max(seconds, 1.0),
        domain_randomization=False,
        dr_theta_bias_max_rad=0.0,
        action_mode=str(config.get("action_mode", "accel")),
        obs_history_len=obs_history_len,
        obs_include_velocities=bool(config.get("obs_include_velocities", True)),
        firmware_obs_model=bool(config.get("firmware_obs_model", False)),
        action_smooth_window=int(config.get("action_smooth_window") or 1),
    )
    for key in ("max_accel_rad_s2", "max_velocity_rad_s", "max_action_delta_rad"):
        if config.get(key) is not None:
            env_kwargs[key] = float(config[key])
    env = RotaryInvertedPendulumEnv(**env_kwargs)
    obs, _ = env.reset(seed=0)

    # Force the exact engage state: arm at its zero, pendulum hanging, at rest.
    env.data.qpos[env._motor_qpos_addr] = 0.0
    env.data.qpos[env._pen_qpos_addr] = 0.0
    env.data.qvel[env._motor_qvel_addr] = 0.0
    env.data.qvel[env._pen_qvel_addr] = 0.0
    env._motor_target = 0.0
    env._lagged_target = 0.0
    env._prev_cmd_pos = 0.0
    env._motor_vel = 0.0
    env._prev_action = 0.0
    env._obs_history.clear()
    import mujoco

    mujoco.mj_forward(env.model, env.data)
    if env.firmware_obs_model:
        env.seed_measurement_ring()
    obs = env._obs()

    n_steps = int(seconds * control_freq_hz)
    first_action = float(np.asarray(predict(obs[None, :])).reshape(-1)[0])
    t_upright = None
    direction = 0.0
    peak_action = 0.0
    for i in range(n_steps):
        a = float(np.asarray(predict(np.asarray(obs, dtype=np.float32)[None, :])
                             ).reshape(-1)[0])
        peak_action = max(peak_action, abs(a))
        obs, _, term, trunc, info = env.step([a])
        theta = math.atan2(math.sin(float(info["phi"]) - math.pi),
                           math.cos(float(info["phi"]) - math.pi))
        if t_upright is None and abs(theta) <= math.radians(15.0):
            t_upright = (i + 1) / control_freq_hz
            direction = float(np.sign(env.data.qvel[env._pen_qvel_addr]))
            break
        if term or trunc:
            break
    lines = [
        f"  action at the very first tick:  {first_action:+.4f}",
        f"  peak |action| before upright:   {peak_action:.4f}",
    ]
    if t_upright is None:
        lines.append(
            f"  *** never reached upright in {seconds:.0f} s — this policy "
            f"would not self-start on the rig ***")
    else:
        lines.append(f"  time to upright:                {t_upright:.2f} s "
                     f"({'CCW' if direction > 0 else 'CW'})")
    return lines


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(
        description="Measure a policy's mirror asymmetry",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__)
    p.add_argument("policy", type=Path,
                   help="a SAC .zip, a distilled student .pt, or policy_weights.h")
    p.add_argument("--obs-history-len", type=int, default=None,
                   help="K, the number of stacked frames. Default: from the "
                        "run's config.json, else inferred assuming 6-dim "
                        "frames (obs_dim/6).")
    p.add_argument("--sim-steps", type=int, default=20000,
                   help="score on states from this many DR-sim rollout steps "
                        "(the default state distribution). 0 to skip.")
    p.add_argument("--dataset", type=Path, default=None,
                   help="score on a distill dataset.npz's obs instead")
    p.add_argument("--buffer", type=Path, default=None,
                   help="score on a replay_buffer.pkl's observations instead")
    p.add_argument("--random", type=int, default=0,
                   help="also score on N uniform random states (coarse check)")
    p.add_argument("--control-freq", type=float, default=None,
                   help="sim rollout rate; default from config.json, else 50")
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="cpu")
    p.add_argument("--max-states", type=int, default=200000,
                   help="subsample larger state sets to this many rows")
    p.add_argument("--engage-rollout", type=float, default=10.0,
                   help="seconds to simulate from the rig's exact engage "
                        "state (arm centred, pendulum hanging, at rest, no "
                        "DR) to check the policy self-starts. A symmetrised "
                        "policy is near zero there by construction, so this "
                        "prices the risk before flashing. 0 to skip.")
    args = p.parse_args(argv if argv is not None else sys.argv[1:])

    if not args.policy.exists():
        raise SystemExit(f"no such policy: {args.policy}")
    predict, obs_dim, label = load_policy(args.policy, args.device)
    config = find_run_config(args.policy) or {}
    k = args.obs_history_len
    if k is None:
        k = int(config.get("obs_history_len") or 0) or None
    if k is None:
        # No provenance (e.g. policy_weights.h sitting in the sketch dir).
        # Frames are 6-dim in every deployed configuration; 4-dim frames only
        # exist behind --drop-velocity-obs, which was never shipped.
        if obs_dim % symmetry.FRAME_DIM_WITH_VEL != 0:
            raise SystemExit(
                f"cannot infer K for obs_dim={obs_dim}; pass --obs-history-len")
        k = obs_dim // symmetry.FRAME_DIM_WITH_VEL
        print(f"no config.json found — assuming K={k} (6-dim frames)")
    signs = symmetry.obs_signs_for_dim(obs_dim, obs_history_len=k)
    with_vel = (obs_dim // k) == symmetry.FRAME_DIM_WITH_VEL
    control_freq = float(args.control_freq or config.get("control_freq_hz") or 50.0)

    print(f"Policy: {args.policy}")
    print(f"        {label}, K={k}, "
          f"{'with' if with_vel else 'without'} velocity channels")

    engage = symmetry.engage_obs(obs_history_len=k, obs_include_velocities=with_vel)

    sources: list[tuple[str, np.ndarray]] = []
    if args.dataset is not None:
        sources.append((f"dataset {args.dataset.name}", obs_from_dataset(args.dataset)))
    if args.buffer is not None:
        sources.append((f"buffer {args.buffer.name}", obs_from_buffer(args.buffer)))
    if not sources and args.sim_steps > 0:
        print(f"\nRolling out in the DR sim ({args.sim_steps} steps @ "
              f"{control_freq:g} Hz)...")
        sim_config = dict(config)
        sim_config["obs_history_len"] = k
        sources.append(("DR sim rollout", obs_from_sim(
            predict, n_steps=args.sim_steps, obs_dim=obs_dim,
            config=sim_config, control_freq_hz=control_freq, seed=args.seed)))
    if args.random > 0:
        sources.append((f"{args.random} uniform random states", obs_from_random(
            n=args.random, obs_dim=obs_dim, obs_history_len=k, seed=args.seed)))
    if not sources:
        raise SystemExit("nothing to score — give --sim-steps, --dataset, "
                         "--buffer or --random")

    rng = np.random.default_rng(args.seed)
    for name, obs in sources:
        if obs.shape[1] != obs_dim:
            print(f"\n{name}: SKIPPED — obs_dim {obs.shape[1]} != policy's {obs_dim}")
            continue
        if len(obs) > args.max_states:
            obs = obs[rng.choice(len(obs), size=args.max_states, replace=False)]
        rep = symmetry.asymmetry(predict, obs, signs, engage=engage)
        print(f"\nAsymmetry over {name}:")
        for line in rep.report_lines():
            print(line)

    print("\nBalance gain, mirrored pairs (arm centred, at rest):")
    for line in theta_sweep(predict, obs_history_len=k,
                            obs_include_velocities=with_vel):
        print(line)

    if args.engage_rollout > 0:
        print(f"\nSelf-start from the exact engage state "
              f"({args.engage_rollout:.0f} s, no DR):")
        sim_config = dict(config)
        for line in engage_rollout(predict, config=sim_config,
                                   obs_history_len=k,
                                   control_freq_hz=control_freq,
                                   seconds=args.engage_rollout):
            print(line)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
