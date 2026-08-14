"""Distill the SAC actor into a tiny MLP that fits on the Arduino Nano.

End-to-end pipeline (Phase 5 of RL_PLAN.md):

    1. dataset: load the teacher and its real-rig replay buffer, re-evaluate
       deterministic-mean actions on the buffer's observations, and dump
       (obs, action_target) to an .npz. Optionally augment with sim
       rollouts from the same teacher (--sim-augment-steps).
    2. train:   fit a 5 -> H -> H -> 1 student MLP (default H=32) by MSE
       regression on the dataset, with tanh on the output to match SAC's
       squashed action range.
    3. parity:  numpy reimplementation of the forward pass; bit-exact-ish
       agreement (<= 1e-5) against the PyTorch student on the val set,
       so we know the exported weights match what the Arduino will compute.

Designed to run end-to-end:

    python distill.py \\
        --teacher runs/async_35hz_v3_fastaccel/last.zip \\
        --buffer  runs/async_35hz_v3_fastaccel/replay_buffer.pkl \\
        --out-dir runs/async_35hz_v3_fastaccel/distill_h32_aug

Each stage caches its output and is skipped if the output exists, unless
--force is passed. Real-rig acceptance is then via
`run_policy.py --policy <out-dir>/student.pt` against the actual hardware
— see website/src/content/docs/train/pipeline.mdx.

Every run prints the teacher's and the student's **mirror asymmetry** (see
`symmetry.py`), including the action at the engage state, which is the
swing-up direction baked into the flashed weights. To symmetrise an existing
champion without retraining anything:

    python distill.py --teacher ... --buffer ... --out-dir ... \\
        --symmetrize-teacher --mirror-augment --mirror-loss-weight 1.0
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F
from stable_baselines3 import SAC

import symmetry
from pendulum_env import RotaryInvertedPendulumEnv
from run_config import find_run_config


# ---------------------------------------------------------------------------
# Student network
# ---------------------------------------------------------------------------

class StudentMLP(nn.Module):
    """5 -> H -> H -> 1 MLP with ReLU hidden + tanh head.

    The tanh matches SAC's squashed-Gaussian action range [-1, 1] so the
    student's output can be plugged into the same action-integration code
    that consumes the teacher's deterministic action.
    """

    def __init__(self, hidden: int = 16, obs_dim: int = 5, act_dim: int = 1):
        super().__init__()
        self.fc1 = nn.Linear(obs_dim, hidden)
        self.fc2 = nn.Linear(hidden, hidden)
        self.fc3 = nn.Linear(hidden, act_dim)
        self.hidden = hidden
        self.obs_dim = obs_dim
        self.act_dim = act_dim

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        x = F.relu(self.fc1(x))
        x = F.relu(self.fc2(x))
        return torch.tanh(self.fc3(x))


def _student_predict_factory(model: StudentMLP, device: str = "cpu"):
    """Return a function with SB3-style `predict(obs, deterministic=True)`.

    Lets us reuse `evaluate_one` from eval_randomized.py without modification.
    """
    model = model.to(device).eval()

    @torch.no_grad()
    def predict(obs, deterministic: bool = True):  # noqa: ARG001 (deterministic always true)
        arr = np.asarray(obs, dtype=np.float32)
        # Accept (5,) or (1, 5).
        if arr.ndim == 1:
            arr = arr[None, :]
        t = torch.from_numpy(arr).to(device)
        a = model(t).cpu().numpy()
        return a[0] if a.shape[0] == 1 else a, None

    return predict


# ---------------------------------------------------------------------------
# Stage 1: build distillation dataset from the replay buffer
# ---------------------------------------------------------------------------

def _teacher_sim_rollouts(
    model: SAC,
    *,
    n_steps: int,
    control_freq_hz: float,
    seed: int = 0,
    teacher_config: dict | None = None,
) -> tuple[np.ndarray, np.ndarray]:
    """Roll out the deterministic teacher in the DR sim env and collect (obs, action).

    Used to augment the real-rig replay buffer when its size or coverage
    is insufficient for the student to fit (compounding errors at deploy
    time despite low MSE — classic behavior-cloning covariate shift).

    The env is built from the teacher's config.json (action mode, scales,
    obs stacking, firmware measurement model) — an env with the wrong obs
    layout would silently produce garbage augmentation data. Transport
    delay is randomised over the stage-3 training range (1 tick +
    [0, 15] ms) so the augmented obs distribution covers the rig.
    """
    cfg = teacher_config or {}
    env_kwargs = dict(
        # Inherited from the teacher's config.json — see dagger_distill.make_env.
        params_path=cfg.get("params_path"),
        control_freq_hz=control_freq_hz,
        episode_length_s=8.0,
        domain_randomization=True,
        action_mode=str(cfg.get("action_mode", "accel")),
        obs_history_len=int(cfg.get("obs_history_len") or 1),
        obs_include_velocities=bool(cfg.get("obs_include_velocities", True)),
        firmware_obs_model=bool(cfg.get("firmware_obs_model", False)),
        action_smooth_window=int(cfg.get("action_smooth_window") or 1),
        dr_action_delay_steps_range=(1, 1),
        dr_action_lag_tau_range_s=(0.0, 0.015),
    )
    for key in ("max_accel_rad_s2", "max_velocity_rad_s", "max_action_delta_rad"):
        if cfg.get(key) is not None:
            env_kwargs[key] = float(cfg[key])
    env = RotaryInvertedPendulumEnv(**env_kwargs)
    env.reset(seed=seed)
    obs_list: list[np.ndarray] = []
    act_list: list[np.ndarray] = []
    ep = 0
    while sum(len(o) for o in obs_list) < n_steps:
        obs, _ = env.reset(seed=seed + ep)
        ep_obs = []
        ep_act = []
        for _ in range(int(8.0 * control_freq_hz)):
            ep_obs.append(np.asarray(obs, dtype=np.float32).copy())
            a, _ = model.predict(obs, deterministic=True)
            ep_act.append(np.asarray(a, dtype=np.float32).reshape(-1))
            obs, _, term, trunc, _ = env.step(a)
            if term or trunc:
                break
        obs_list.append(np.asarray(ep_obs, dtype=np.float32))
        act_list.append(np.asarray(ep_act, dtype=np.float32))
        ep += 1
    obs = np.concatenate(obs_list, axis=0)[:n_steps]
    act = np.concatenate(act_list, axis=0)[:n_steps]
    print(f"[dataset]   sim augmentation: {obs.shape[0]} steps from {ep} episodes")
    return obs, act


def stage_dataset(
    teacher_path: Path,
    buffer_path: Path,
    out_path: Path,
    *,
    device: str = "cpu",
    batch_size: int = 4096,
    sim_augment_steps: int = 0,
    control_freq_hz: float = 50.0,
    seed: int = 0,
    symmetrize_teacher: bool = False,
    mirror_augment: bool = False,
    obs_history_len: int | None = None,
    params_path: Path | None = None,
) -> None:
    """Re-evaluate the teacher's deterministic action over the buffer's observations.

    Optionally augment with sim rollouts of the teacher to grow the obs
    distribution beyond what the real-rig buffer covers.

    Two symmetry options, both off by default (see
    `website/src/content/docs/reference/symmetry.md`):

    `symmetrize_teacher` replaces each target with the teacher's *odd
    projection* ½(a(s) − a(Ms)), the closest exactly-equivariant policy to
    the teacher in the L2 sense. This is how an existing champion gets
    symmetrised without retraining anything.

    `mirror_augment` appends (Ms, −a) for every sample, making the dataset
    mirror-closed. The two belong together: symmetrising the target changes
    what the student does, so the student visits states the teacher never
    did — but those states are exactly the mirror images of the teacher's,
    which is what the augmentation supplies. Using either alone leaves the
    student either off-distribution or fitting an asymmetric target.
    """
    print(f"[dataset] loading teacher: {teacher_path}")
    model = SAC.load(str(teacher_path), device=device)
    teacher_config = find_run_config(teacher_path)
    if params_path is not None:
        teacher_config = dict(teacher_config or {})
        teacher_config["params_path"] = str(params_path)
    obs_dim = int(model.observation_space.shape[0])
    k_frames = int(
        obs_history_len if obs_history_len is not None
        else (teacher_config or {}).get("obs_history_len") or 1
    )
    signs = symmetry.obs_signs_for_dim(obs_dim, obs_history_len=k_frames)
    if buffer_path is None:
        # Sim-only teacher (no rig fine-tune yet): the dataset is purely
        # teacher rollouts in the DR sim.
        if sim_augment_steps <= 0:
            raise SystemExit("--buffer omitted requires --sim-augment-steps > 0")
        print("[dataset] no replay buffer — sim-rollout-only dataset")
        n = 0
        obs = np.empty((0, model.observation_space.shape[0]), dtype=np.float32)
        actions = np.empty((0, model.action_space.shape[0]), dtype=np.float32)
    else:
        print(f"[dataset] loading replay buffer: {buffer_path}")
        model.load_replay_buffer(str(buffer_path))

        rb = model.replay_buffer
        n = int(rb.size())
        print(f"[dataset] buffer holds {n} transitions")

        # SB3's ReplayBuffer stores observations as (buffer_size, n_envs, *obs_shape).
        obs_full = np.asarray(rb.observations, dtype=np.float32)
        if obs_full.ndim == 3:
            # (buffer_size, n_envs=1, obs_dim) -> (buffer_size, obs_dim)
            obs_full = obs_full[:, 0, :]
        # Buffer is a ring; only [0:n] are filled if not full, otherwise rotate.
        if rb.full:
            # rb.pos is the next write index = oldest valid sample
            pos = int(rb.pos)
            obs = np.concatenate([obs_full[pos:], obs_full[:pos]], axis=0)
        else:
            obs = obs_full[:n]

        # Re-evaluate teacher deterministically in batches (cheap on CPU).
        actions = np.empty((n, model.action_space.shape[0]), dtype=np.float32)
        t0 = time.time()
        for i in range(0, n, batch_size):
            chunk = obs[i : i + batch_size]
            a, _ = model.predict(chunk, deterministic=True)
            actions[i : i + batch_size] = a
        dt = time.time() - t0
        print(f"[dataset] re-evaluated teacher on {n} obs in {dt:.1f}s")

    if sim_augment_steps > 0:
        print(f"[dataset] generating {sim_augment_steps} sim rollout steps with the teacher")
        if teacher_config:
            print(f"[dataset]   env from config.json: "
                  f"action_mode={teacher_config.get('action_mode')}, "
                  f"K={teacher_config.get('obs_history_len')}, "
                  f"fw_model={teacher_config.get('firmware_obs_model')}")
        sim_obs, sim_act = _teacher_sim_rollouts(
            model, n_steps=sim_augment_steps,
            control_freq_hz=control_freq_hz, seed=seed,
            teacher_config=teacher_config,
        )
        obs = np.concatenate([obs, sim_obs], axis=0)
        actions = np.concatenate([actions, sim_act], axis=0)
        print(f"[dataset] combined dataset: {obs.shape[0]} samples "
              f"({n} real + {sim_obs.shape[0]} sim)")

    # --- Teacher asymmetry, before anything is changed ---------------------
    # Measured on exactly the states being distilled, so it is directly
    # comparable to the student's score printed at the end of stage_train.
    def _teacher_predict(batch):
        out = np.empty((len(batch), model.action_space.shape[0]), dtype=np.float32)
        for i in range(0, len(batch), batch_size):
            out[i : i + batch_size] = model.predict(
                batch[i : i + batch_size], deterministic=True)[0]
        return out

    if len(obs):
        engage = symmetry.engage_obs(
            obs_history_len=k_frames,
            obs_include_velocities=(obs_dim // k_frames) == symmetry.FRAME_DIM_WITH_VEL,
        )
        rep = symmetry.asymmetry(_teacher_predict, obs, signs, engage=engage)
        print("[dataset] teacher mirror asymmetry over this dataset:")
        for line in rep.report_lines():
            print(f"  {line.strip()}")

    if symmetrize_teacher and len(obs):
        # Odd projection: ½(a(s) − a(Ms)). `actions` already holds a(s) for
        # both the buffer rows and the sim rows, so only a(Ms) is new work.
        mirrored_actions = _teacher_predict(symmetry.mirror_obs(obs, signs))
        before = actions.copy()
        actions = 0.5 * (actions - mirrored_actions)
        shift = float(np.abs(actions - before).mean())
        print(f"[dataset] symmetrised teacher targets: mean |change| = {shift:.4f} "
              f"(0 would mean the teacher was already equivariant)")

    if mirror_augment and len(obs):
        obs = np.concatenate([obs, symmetry.mirror_obs(obs, signs)], axis=0)
        actions = np.concatenate([actions, -actions], axis=0)
        print(f"[dataset] mirror-augmented: {obs.shape[0]} samples "
              f"(dataset is now mirror-closed)")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(out_path, obs=obs, action_target=actions,
                        symmetrize_teacher=symmetrize_teacher,
                        mirror_augment=mirror_augment,
                        obs_history_len=k_frames)
    print(f"[dataset] saved -> {out_path} ({out_path.stat().st_size / 1e6:.1f} MB)")

    # Coverage diagnostic: print a small theta x motor_pos histogram.
    # Frames stack oldest -> newest; read the NEWEST frame's channels
    # ([motor_pos, sin, cos, ...] at the tail of the obs vector). With
    # K=1 this reduces to columns 0..2 as before.
    frame = obs.shape[1] // max(1, k_frames)
    base = obs.shape[1] - frame
    theta = np.arctan2(obs[:, base + 1], obs[:, base + 2])
    motor_pos = obs[:, base + 0]
    print("[dataset] coverage histogram (theta deg x motor_pos deg):")
    theta_edges = np.linspace(-180.0, 180.0, 7)  # 6 bins of 60°
    motor_edges = np.linspace(-130.0, 130.0, 6)  # 5 bins
    H, _, _ = np.histogram2d(
        np.degrees(theta), np.degrees(motor_pos),
        bins=[theta_edges, motor_edges],
    )
    # Normalise by total dataset size, not just the real-buffer size — `n`
    # is the buffer size, but `obs` may have been grown by sim augmentation.
    H_norm = H / max(1, obs.shape[0])
    header = "  theta\\motor " + "".join(
        f"{motor_edges[i]:>7.0f}…{motor_edges[i+1]:>4.0f}" for i in range(len(motor_edges) - 1)
    )
    print(header)
    for i in range(len(theta_edges) - 1):
        row = f"  {theta_edges[i]:>5.0f}..{theta_edges[i+1]:>4.0f}: "
        row += " ".join(f"{100*H_norm[i, j]:>10.2f}%" for j in range(H.shape[1]))
        print(row)


# ---------------------------------------------------------------------------
# Stage 2: train the student
# ---------------------------------------------------------------------------

def stage_train(
    dataset_path: Path,
    out_path: Path,
    *,
    hidden: int = 16,
    epochs: int = 30,
    batch_size: int = 1024,
    lr: float = 1e-3,
    val_frac: float = 0.1,
    seed: int = 0,
    device: str = "cpu",
    mirror_loss_weight: float = 0.0,
    obs_history_len: int | None = None,
) -> dict:
    """Fit the student by MSE regression on the teacher's actions.

    `mirror_loss_weight` > 0 adds the LOSS-method symmetry regulariser
    (Abdolhosseini et al. 2019, the most consistent of the four methods they
    compare): mean(‖f(s) + f(Ms)‖²) alongside the MSE. Unlike mirror data
    augmentation it constrains the student *directly* rather than through the
    data, so it also symmetrises regions the dataset covers thinly — but it
    is still soft, so the student keeps a small residual asymmetry to break
    the tie at the engage state (see `symmetry.py`).
    """
    print(f"[train] dataset: {dataset_path}")
    data = np.load(dataset_path)
    obs = np.asarray(data["obs"], dtype=np.float32)
    target = np.asarray(data["action_target"], dtype=np.float32)
    n = obs.shape[0]
    print(f"[train] {n} samples, obs_dim={obs.shape[1]}, act_dim={target.shape[1]}")

    # K for the mirror map: the CLI value wins, else the dataset's own record
    # (written by stage_dataset), else 1. Getting this wrong would mirror the
    # wrong channels, so fail loudly rather than guess.
    k_frames = int(
        obs_history_len if obs_history_len is not None
        else (data["obs_history_len"] if "obs_history_len" in data.files else 1)
    )
    signs = symmetry.obs_signs_for_dim(obs.shape[1], obs_history_len=k_frames)
    signs_t = torch.from_numpy(signs).to(device)

    rng = np.random.default_rng(seed)
    idx = rng.permutation(n)
    n_val = int(val_frac * n)
    val_idx, train_idx = idx[:n_val], idx[n_val:]

    obs_t = torch.from_numpy(obs).to(device)
    tgt_t = torch.from_numpy(target).to(device)

    train_obs = obs_t[train_idx]
    train_tgt = tgt_t[train_idx]
    val_obs = obs_t[val_idx]
    val_tgt = tgt_t[val_idx]

    torch.manual_seed(seed)
    model = StudentMLP(hidden=hidden, obs_dim=obs.shape[1], act_dim=target.shape[1]).to(device)
    n_params = sum(p.numel() for p in model.parameters())
    print(f"[train] student MLP 5->{hidden}->{hidden}->1, {n_params} params, "
          f"{n_params * 4} bytes float32")

    opt = torch.optim.Adam(model.parameters(), lr=lr)

    n_train = train_obs.shape[0]
    last_val = float("nan")
    for epoch in range(1, epochs + 1):
        model.train()
        perm = torch.randperm(n_train, device=device)
        train_loss_sum = 0.0
        mirror_loss_sum = 0.0
        seen = 0
        for i in range(0, n_train, batch_size):
            sel = perm[i : i + batch_size]
            x = train_obs[sel]
            y = train_tgt[sel]
            pred = model(x)
            mse = F.mse_loss(pred, y)
            loss = mse
            if mirror_loss_weight > 0.0:
                # f(Ms) should equal -f(s); penalise the sum.
                mirror_term = (pred + model(x * signs_t)).pow(2).mean()
                loss = loss + mirror_loss_weight * mirror_term
                mirror_loss_sum += mirror_term.item() * x.shape[0]
            opt.zero_grad()
            loss.backward()
            opt.step()
            train_loss_sum += mse.item() * x.shape[0]
            seen += x.shape[0]
        train_loss = train_loss_sum / max(1, seen)

        model.eval()
        with torch.no_grad():
            val_pred = model(val_obs)
            val_loss = F.mse_loss(val_pred, val_tgt).item()
        last_val = val_loss
        if epoch % 100 == 0 or epoch in (1, epochs):
            extra = (f"  mirror={mirror_loss_sum / max(1, seen):.6f}"
                     if mirror_loss_weight > 0.0 else "")
            print(f"[train] epoch {epoch:3d}/{epochs}  "
                  f"train_mse={train_loss:.6f}  val_mse={val_loss:.6f}{extra}")

    out_path.parent.mkdir(parents=True, exist_ok=True)
    torch.save(
        {
            "state_dict": model.state_dict(),
            "hidden": hidden,
            "obs_dim": obs.shape[1],
            "act_dim": target.shape[1],
            "val_mse": last_val,
            "obs_history_len": k_frames,
        },
        out_path,
    )
    print(f"[train] saved -> {out_path}, final val_mse={last_val:.6f}")

    # The student's own mirror asymmetry over the validation states, next to
    # the teacher's score from stage_dataset — the pair is the whole point of
    # a symmetrised distill run. `engage_action` is the swing-up direction
    # baked into the weights that get flashed.
    with torch.no_grad():
        def _predict(batch):
            t = torch.from_numpy(np.asarray(batch, dtype=np.float32)).to(device)
            return model(t).cpu().numpy()

        engage = symmetry.engage_obs(
            obs_history_len=k_frames,
            obs_include_velocities=(obs.shape[1] // k_frames) == symmetry.FRAME_DIM_WITH_VEL,
        )
        rep = symmetry.asymmetry(_predict, obs[val_idx], signs, engage=engage)
    print("[train] student mirror asymmetry over the validation states:")
    for line in rep.report_lines():
        print(f"  {line.strip()}")
    return {
        "val_mse": last_val, "hidden": hidden, "n_params": n_params,
        "asymmetry": rep.rms_error, "engage_action": rep.engage_action,
    }


# ---------------------------------------------------------------------------
# Stage 3: numpy parity check
# ---------------------------------------------------------------------------

def numpy_forward(weights: dict, x: np.ndarray) -> np.ndarray:
    """Forward pass mirroring the Arduino C++ code: ReLU, ReLU, tanh."""
    h1 = np.maximum(0.0, x @ weights["W1"].T + weights["B1"])
    h2 = np.maximum(0.0, h1 @ weights["W2"].T + weights["B2"])
    out = np.tanh(h2 @ weights["W3"].T + weights["B3"])
    return out


def _extract_weights(model: StudentMLP) -> dict:
    sd = model.state_dict()
    return {
        "W1": sd["fc1.weight"].cpu().numpy().astype(np.float32),
        "B1": sd["fc1.bias"].cpu().numpy().astype(np.float32),
        "W2": sd["fc2.weight"].cpu().numpy().astype(np.float32),
        "B2": sd["fc2.bias"].cpu().numpy().astype(np.float32),
        "W3": sd["fc3.weight"].cpu().numpy().astype(np.float32),
        "B3": sd["fc3.bias"].cpu().numpy().astype(np.float32),
    }


def stage_parity(
    student_path: Path,
    dataset_path: Path,
    *,
    n_check: int = 4096,
    seed: int = 0,
    device: str = "cpu",
    tol: float = 1e-5,
) -> float:
    ckpt = torch.load(student_path, map_location=device, weights_only=True)
    model = StudentMLP(
        hidden=ckpt["hidden"],
        obs_dim=ckpt["obs_dim"],
        act_dim=ckpt["act_dim"],
    ).to(device).eval()
    model.load_state_dict(ckpt["state_dict"])

    weights = _extract_weights(model)
    data = np.load(dataset_path)
    obs = np.asarray(data["obs"], dtype=np.float32)
    rng = np.random.default_rng(seed)
    idx = rng.choice(obs.shape[0], size=min(n_check, obs.shape[0]), replace=False)
    sample = obs[idx]

    with torch.no_grad():
        torch_out = model(torch.from_numpy(sample).to(device)).cpu().numpy()
    numpy_out = numpy_forward(weights, sample)

    diff = np.abs(torch_out - numpy_out)
    max_diff = float(diff.max())
    print(f"[parity] checked {sample.shape[0]} samples, "
          f"max|torch - numpy| = {max_diff:.3e} (tol {tol:.0e})")
    if max_diff > tol:
        raise RuntimeError(
            f"numpy/PyTorch mismatch {max_diff:.3e} > tol {tol:.0e}; "
            "exported weights would not match what the Arduino computes."
        )
    return max_diff


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Distill SAC teacher to a Nano-sized student MLP")
    p.add_argument("--teacher", required=True, type=Path,
                   help="path to the SAC .zip checkpoint to distill")
    p.add_argument("--buffer", type=Path, default=None,
                   help="path to the teacher's replay_buffer.pkl (real-rig "
                        "data). Omit for sim-only teachers — the dataset is "
                        "then purely sim rollouts.")
    p.add_argument("--out-dir", required=True, type=Path,
                   help="output directory; dataset.npz and student.pt go here")
    p.add_argument("--params-path", type=Path, default=None,
                   help="override the rig sysid file inherited from the "
                        "teacher's config.json (see train_sac.py --params-path)")
    p.add_argument("--hidden", type=int, default=32,
                   help="student hidden-layer width (32 was the production "
                        "value for async_35hz_v2_extend; 16 underfits)")
    p.add_argument("--epochs", type=int, default=800)
    p.add_argument("--batch-size", type=int, default=1024)
    p.add_argument("--lr", type=float, default=1e-3)
    p.add_argument("--seed", type=int, default=0)
    p.add_argument("--device", default="cpu")
    p.add_argument("--control-freq", type=float, default=50.0,
                   help="must match the teacher's training rate")
    p.add_argument("--sim-augment-steps", type=int, default=100000,
                   help="add N teacher sim-rollout steps to the real-rig buffer. "
                        "100k was the production value for async_35hz_v2_extend "
                        "(real-rig buffer is only ~17k transitions, which "
                        "underfits even a 1.5 KB student). Set to 0 to use "
                        "real-rig data only.")
    p.add_argument("--symmetrize-teacher", action="store_true",
                   help="fit the student to the teacher's ODD PROJECTION "
                        "½(a(s) − a(Ms)) instead of a(s) — the closest "
                        "exactly-mirror-symmetric policy to the teacher. "
                        "Symmetrises an existing champion with no retraining. "
                        "Pair with --mirror-augment.")
    p.add_argument("--mirror-augment", action="store_true",
                   help="append (Ms, −a) for every sample, making the dataset "
                        "mirror-closed (2x size). The mirrored transition is a "
                        "genuine one — the plant and reward are mirror-symmetric "
                        "— so this is exact, not approximate.")
    p.add_argument("--mirror-loss-weight", type=float, default=0.0,
                   help="add w·mean((f(s) + f(Ms))²) to the student's loss "
                        "(the LOSS method, most consistent of the four in "
                        "Abdolhosseini et al. 2019). Constrains the student "
                        "directly rather than through the data. Try 1.0; "
                        "watch val_mse for the cost of the constraint.")
    p.add_argument("--obs-history-len", type=int, default=None,
                   help="K, stacked frames — needed for the mirror map. "
                        "Default: from the teacher's config.json (dataset "
                        "stage) or the dataset's own record (train stage).")
    p.add_argument("--force", action="store_true",
                   help="re-run all stages even if cached outputs exist")
    args = p.parse_args(argv if argv is not None else sys.argv[1:])

    out_dir = args.out_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    dataset_path = out_dir / "dataset.npz"
    student_path = out_dir / "student.pt"

    # Stage 1
    if args.force or not dataset_path.exists():
        stage_dataset(
            args.teacher, args.buffer, dataset_path,
            device=args.device,
            sim_augment_steps=args.sim_augment_steps,
            control_freq_hz=args.control_freq,
            seed=args.seed,
            symmetrize_teacher=args.symmetrize_teacher,
            mirror_augment=args.mirror_augment,
            obs_history_len=args.obs_history_len,
            params_path=args.params_path,
        )
    else:
        print(f"[dataset] cached -> {dataset_path} (use --force to rebuild)")

    # Stage 2
    if args.force or not student_path.exists():
        stage_train(
            dataset_path, student_path,
            hidden=args.hidden, epochs=args.epochs,
            batch_size=args.batch_size, lr=args.lr,
            seed=args.seed, device=args.device,
            mirror_loss_weight=args.mirror_loss_weight,
            obs_history_len=args.obs_history_len,
        )
    else:
        print(f"[train] cached -> {student_path} (use --force to retrain)")

    # Stage 3 — parity. Closed-loop sim eval was removed because it isn't
    # a meaningful acceptance signal for real-rig fine-tuned teachers (the
    # teacher itself fails 0/20 in DR sim because fine-tuning specialised
    # it away from sim DR). The real acceptance test is `run_policy.py
    # --policy <out-dir>/student.pt` against the actual hardware.
    stage_parity(student_path, dataset_path, device=args.device)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
