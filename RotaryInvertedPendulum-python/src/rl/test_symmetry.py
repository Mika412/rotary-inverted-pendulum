"""Checks that the rig's mirror symmetry is really exact where we claim it is.

Everything in `symmetry.py` — the augmentation, the symmetrised distillation,
the paired eval — rests on one claim: mirroring a transition gives another
valid transition of the SAME MDP, with the SAME reward. If a future change
breaks that (an asymmetric reward term, a one-sided clamp, a `floor` where a
`round` belongs), the augmentation silently starts teaching SAC physics the
rig does not have. These tests fail loudly instead.

Run directly — no pytest needed, so it works in the same bare environment as
the rest of the pipeline:

    python test_symmetry.py
"""

from __future__ import annotations

import math
import sys

import numpy as np

import symmetry
from pendulum_env import RotaryInvertedPendulumEnv
from reward import RewardWeights, compute_reward


FAILURES: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"  {'PASS' if ok else 'FAIL'}  {name}{'  — ' + detail if detail else ''}")
    if not ok:
        FAILURES.append(f"{name}: {detail}")


def test_sign_vectors() -> None:
    print("sign vectors")
    s6 = symmetry.obs_signs(obs_history_len=4, obs_include_velocities=True)
    check("K=4 with velocities is 24-dim", s6.shape == (24,), str(s6.shape))
    check("cos channels are the only ones not flipped",
          np.array_equal(np.where(s6 > 0)[0], np.array([2, 8, 14, 20])),
          str(np.where(s6 > 0)[0]))
    check("mirror is an involution",
          np.array_equal(s6 * s6, np.ones(24)))
    s4 = symmetry.obs_signs(obs_history_len=2, obs_include_velocities=False)
    check("K=2 without velocities is 8-dim", s4.shape == (8,), str(s4.shape))
    check("inferring layout from obs_dim agrees",
          np.array_equal(symmetry.obs_signs_for_dim(24, obs_history_len=4), s6)
          and np.array_equal(symmetry.obs_signs_for_dim(8, obs_history_len=2), s4))
    bad = False
    try:
        symmetry.obs_signs_for_dim(24, obs_history_len=5)
    except ValueError:
        bad = True
    check("a non-divisible obs_dim/K raises", bad)
    bad = False
    try:
        symmetry.obs_signs_for_dim(25, obs_history_len=5)  # frame_dim 5: neither layout
    except ValueError:
        bad = True
    check("an impossible frame_dim raises", bad)


def test_engage_is_a_fixed_point() -> None:
    print("the engage state is a mirror fixed point")
    for k in (1, 4):
        obs = symmetry.engage_obs(obs_history_len=k)
        signs = symmetry.obs_signs(obs_history_len=k)
        mirrored = symmetry.mirror_obs(obs, signs)
        check(f"K={k}: Ms == s at the engage state",
              np.allclose(mirrored, obs, atol=1e-6),
              f"max diff {np.abs(mirrored - obs).max():.2e}")


def test_reward_is_invariant() -> None:
    print("reward invariance")
    # Every optional term on at once — a term that is odd in any argument
    # would show up here.
    w = RewardWeights(
        k_action_rate=0.05, k_motor_jerk=0.01, k_stillness_bonus=5.0,
        k_alive_offset=15.0, k_upright_alive=5.0,
    )
    rng = np.random.default_rng(0)
    worst = 0.0
    for _ in range(20000):
        args = dict(
            theta=float(rng.uniform(-math.pi, math.pi)),
            pen_vel=float(rng.uniform(-30, 30)),
            motor_pos=float(rng.uniform(-2.2, 2.2)),
            motor_vel=float(rng.uniform(-12, 12)),
            action=float(rng.uniform(-1, 1)),
            prev_action=float(rng.uniform(-1, 1)),
            prev_motor_vel=float(rng.uniform(-12, 12)),
        )
        r = compute_reward(weights=w, **args)
        r_mirror = compute_reward(weights=w, **{k: -v for k, v in args.items()})
        worst = max(worst, abs(r - r_mirror))
    check("r(Ms, -a) == r(s, a) over 20k random states", worst < 1e-9,
          f"worst |diff| {worst:.2e}")


def _rollout(env, actions, *, mirror: bool, seed: int):
    """Step a fixed action sequence from a fixed seed; return obs and rewards."""
    obs, _ = env.reset(seed=seed)
    if mirror:
        # Mirror the sampled initial state, matching eval_randomized's helper.
        import mujoco

        d, m = env.data, env
        d.qpos[m._motor_qpos_addr] = -d.qpos[m._motor_qpos_addr]
        d.qpos[m._pen_qpos_addr] = -d.qpos[m._pen_qpos_addr]
        d.qvel[m._motor_qvel_addr] = -d.qvel[m._motor_qvel_addr]
        d.qvel[m._pen_qvel_addr] = -d.qvel[m._pen_qvel_addr]
        m._motor_target = -m._motor_target
        m._lagged_target = -m._lagged_target
        m._prev_cmd_pos = -m._prev_cmd_pos
        m._theta_bias_rad = -m._theta_bias_rad
        mujoco.mj_forward(m.model, d)
        if m.firmware_obs_model:
            m.seed_measurement_ring()
        m._obs_history.clear()
        obs = m._obs()
    seq_obs = [np.array(obs, dtype=np.float64)]
    seq_r = []
    for a in actions:
        obs, r, term, trunc, _ = env.step([-a if mirror else a])
        seq_obs.append(np.array(obs, dtype=np.float64))
        seq_r.append(r)
        if term or trunc:
            break
    return np.array(seq_obs), np.array(seq_r)


def test_plant_is_equivariant() -> None:
    """The real claim: mirroring the state and negating the action produces
    the mirrored trajectory, step for step, with identical rewards.

    Run without DR so the comparison is deterministic — DR samples per
    episode from symmetric distributions, which makes the *distribution*
    symmetric but not any individual episode (base tilt in particular is a
    property of the table, not of the state).
    """
    print("plant + observation equivariance (no DR, both action modes)")
    rng = np.random.default_rng(1)
    actions = rng.uniform(-1, 1, 200)
    for action_mode in ("velocity", "accel", "position_delta"):
        for firmware_obs in (False, True):
            env = RotaryInvertedPendulumEnv(
                action_mode=action_mode,
                control_freq_hz=50.0,
                obs_history_len=4,
                firmware_obs_model=firmware_obs,
                action_smooth_window=4,
                dr_theta_bias_max_rad=0.0,
                domain_randomization=False,
                reward_alive_offset=15.0,
                reward_upright_alive_weight=5.0,
                reward_stillness_bonus_weight=5.0,
            )
            signs = symmetry.obs_signs(obs_history_len=4)
            o1, r1 = _rollout(env, actions, mirror=False, seed=7)
            o2, r2 = _rollout(env, actions, mirror=True, seed=7)
            n = min(len(o1), len(o2))
            obs_err = float(np.abs(o1[:n] * signs - o2[:n]).max())
            rew_err = float(np.abs(r1[:min(len(r1), len(r2))]
                                   - r2[:min(len(r1), len(r2))]).max())
            tag = f"{action_mode}, firmware_obs={firmware_obs}"
            # 1e-9 would be right in exact arithmetic; MuJoCo accumulates
            # float64 round-off asymmetrically over 200 steps of a stiff
            # servo, so allow a small drift while still catching any real
            # sign error (those show up at O(0.1) or more).
            check(f"{tag}: mirrored obs match", obs_err < 1e-6,
                  f"max |M·o1 - o2| = {obs_err:.2e}")
            check(f"{tag}: rewards match", rew_err < 1e-6,
                  f"max |r1 - r2| = {rew_err:.2e}")
            check(f"{tag}: same episode length", len(o1) == len(o2),
                  f"{len(o1)} vs {len(o2)}")


def test_mirror_replay_buffer() -> None:
    print("MirrorReplayBuffer")
    import gymnasium as gym

    obs_space = gym.spaces.Box(low=-10.0, high=10.0, shape=(24,), dtype=np.float32)
    act_space = gym.spaces.Box(low=-1.0, high=1.0, shape=(1,), dtype=np.float32)
    signs = symmetry.obs_signs(obs_history_len=4)
    buf = symmetry.MirrorReplayBuffer(
        100, obs_space, act_space, n_envs=1, obs_sign=signs)
    rng = np.random.default_rng(2)
    obs = rng.normal(size=(1, 24)).astype(np.float32)
    nxt = rng.normal(size=(1, 24)).astype(np.float32)
    act = np.array([[0.42]], dtype=np.float32)
    buf.add(obs, nxt, act, np.array([1.5], dtype=np.float32),
            np.array([False]), [{}])
    check("one add() writes two transitions", buf.size() == 2, str(buf.size()))
    check("second obs is the mirror of the first",
          np.allclose(buf.observations[1, 0], obs[0] * signs))
    check("second next_obs is the mirror of the first",
          np.allclose(buf.next_observations[1, 0], nxt[0] * signs))
    check("second action is negated",
          np.allclose(buf.actions[1, 0], -act[0]))
    check("reward is unchanged", np.allclose(buf.rewards[1], buf.rewards[0]))

    bad = False
    try:
        symmetry.MirrorReplayBuffer(100, obs_space, act_space, n_envs=1,
                                    obs_sign=np.ones(8, dtype=np.float32))
    except ValueError:
        bad = True
    check("a wrong-length obs_sign raises", bad)
    bad = False
    try:
        symmetry.MirrorReplayBuffer(100, obs_space, act_space, n_envs=1)
    except ValueError:
        bad = True
    check("a missing obs_sign raises", bad)


def test_asymmetry_score() -> None:
    print("asymmetry score")
    signs = symmetry.obs_signs(obs_history_len=4)
    rng = np.random.default_rng(3)
    obs = rng.normal(size=(500, 24)).astype(np.float32)
    w = rng.normal(size=24)

    # An exactly odd policy: linear, no bias, only on the flipped channels.
    odd_w = w * (signs < 0)
    rep = symmetry.asymmetry(lambda x: x @ odd_w, obs, signs)
    check("an odd policy scores 0", rep.rms_error < 1e-5,
          f"rms {rep.rms_error:.2e}")

    # An exactly even policy: only reads the cos channels.
    even_w = w * (signs > 0)
    rep = symmetry.asymmetry(lambda x: x @ even_w, obs, signs)
    check("an even policy scores 2x its RMS action",
          abs(rep.relative_error - 2.0) < 1e-4, f"rel {rep.relative_error:.4f}")

    # A constant policy is the pure-bias case: pi(s) + pi(Ms) = 2c.
    rep = symmetry.asymmetry(lambda x: np.full(len(x), 0.3), obs, signs,
                             engage=symmetry.engage_obs(obs_history_len=4))
    check("a constant policy's error is twice the constant",
          abs(rep.rms_error - 0.6) < 1e-6, f"rms {rep.rms_error:.6f}")
    check("engage_action is reported", rep.engage_action is not None
          and abs(rep.engage_action - 0.3) < 1e-6)


def main() -> int:
    for fn in (test_sign_vectors, test_engage_is_a_fixed_point,
               test_reward_is_invariant, test_plant_is_equivariant,
               test_mirror_replay_buffer, test_asymmetry_score):
        fn()
    print()
    if FAILURES:
        print(f"{len(FAILURES)} FAILURE(S):")
        for f in FAILURES:
            print(f"  - {f}")
        return 1
    print("all symmetry checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
