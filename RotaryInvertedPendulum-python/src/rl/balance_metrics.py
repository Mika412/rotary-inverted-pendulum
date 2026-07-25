"""Single source of truth for the honest balance + calmness metrics.

`analyze_onboard.py` (rig captures) and `analyze_sim.py` (sim rollouts) both
compute their numbers here, so a sim figure and a rig figure are always the
same quantity and can be compared directly. Keeping two copies of this maths
is how the two silently drift and stop being comparable — the same mistake
`reward.py` exists to prevent for the reward function. Add metrics here, not
in the callers.

**Honest balance gate**: |theta| <= 15 deg AND |theta_dot| <= 4 rad/s. Both
conditions matter. A theta-band-only criterion scores a pendulum that swings
*through* upright at speed, so spin-up and Kapitza-style vibrational
stabilisation inflate it; those run at >= 7-20 rad/s and the velocity gate
rejects them. The limit is 4.0 rather than the original 2.0 because tight
policies micro-oscillate at ~5 Hz and momentarily exceed 2 rad/s while
balancing perfectly — 2.0 underrated exactly the policies worth keeping.

**Calmness** is measured over balanced samples only. A real Furuta balances
WITH arm motion — the base has to move under the pendulum — so the question
is never "is the arm still" but "how much motion does this policy need".
Arm motion is split into a slow drift (>1 s, wandering off centre) and the
sub-second sway (the ~0.6 Hz balancing wiggle), because they have different
causes and different fixes.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

BAL_THETA_RAD = math.radians(15.0)
BAL_PEN_VEL_RAD_S = 4.0


def wrap_pi(x):
    """Wrap angle(s) into [-pi, pi]."""
    return ((np.asarray(x) + np.pi) % (2.0 * np.pi)) - np.pi


@dataclass
class BalanceMetrics:
    """Scored trajectory. Calmness fields are None when the policy never held
    balance for a full second (nothing meaningful to characterise)."""

    n_samples: int
    dt_s: float
    hz: float
    balanced_fraction: float
    longest_streak_s: float
    catches: int
    pendulum_revolutions: float
    action_abs_mean: float
    verdict: str
    balanced_mask: np.ndarray = field(repr=False)
    # Calmness (balanced phase only)
    pendulum_std_deg: float | None = None
    arm_std_deg: float | None = None
    arm_off_centre_deg: float | None = None
    arm_sway_deg: float | None = None
    arm_speed_rms: float | None = None
    motor_cmd_travel: float | None = None

    @property
    def has_calmness(self) -> bool:
        return self.pendulum_std_deg is not None

    def report_lines(self) -> list[str]:
        """Metric lines in the canonical order/wording used by both scripts."""
        lines = [
            f"  balanced fraction:       {self.balanced_fraction:.3f}",
            f"  longest balanced streak: {self.longest_streak_s:.2f} s",
            f"  catches (>=1s):          {self.catches}",
            f"  pendulum revolutions:    {self.pendulum_revolutions:.1f} gross",
            f"  |action| mean:           {self.action_abs_mean:.3f}",
            f"  verdict:                 {self.verdict}",
        ]
        if self.has_calmness:
            lines += [
                f"  pendulum std (bal):      {self.pendulum_std_deg:.2f} deg",
                f"  arm std (bal):           {self.arm_std_deg:.1f} deg",
                f"  arm off-centre (bal):    {self.arm_off_centre_deg:.1f} deg",
                f"  arm sway <1s (bal):      {self.arm_sway_deg:.2f} deg",
                f"  arm speed RMS (bal):     {self.arm_speed_rms:.2f} rad/s",
            ]
            if self.motor_cmd_travel is not None:
                lines.append(
                    f"  motor-cmd travel:        {self.motor_cmd_travel:.1f} /s")
        return lines


def score(*, phi, motor_pos, action, t_s=None, hz=None, motor_cmd=None
          ) -> BalanceMetrics:
    """Score one trajectory.

    `phi` is the pendulum joint angle in the sim convention (phi = pi is
    upright); `motor_pos` the arm angle (rad); `action` the raw policy output.
    Supply `t_s` (per-sample timestamps, rig captures) or `hz` (uniform rate,
    sim rollouts). `motor_cmd` is the post-smoothing command the actuator saw,
    when available — it drives the base-excitation proxy.
    """
    phi = np.asarray(phi, dtype=float)
    motor_pos = np.asarray(motor_pos, dtype=float)
    action = np.asarray(action, dtype=float)
    if t_s is not None:
        t_s = np.asarray(t_s, dtype=float)
        dt = float(np.median(np.diff(t_s)))
    elif hz is not None:
        dt = 1.0 / float(hz)
        t_s = np.arange(len(phi)) * dt
    else:
        raise ValueError("supply either t_s or hz")
    n = len(phi)

    theta = wrap_pi(phi - np.pi)
    pen_vel = np.gradient(np.unwrap(phi), t_s)
    balanced = ((np.abs(theta) <= BAL_THETA_RAD)
                & (np.abs(pen_vel) <= BAL_PEN_VEL_RAD_S))

    one_s = max(1, int(round(1.0 / dt)))
    best = cur = catches = 0
    for b in balanced:
        cur = cur + 1 if b else 0
        if cur == one_s:
            catches += 1
        best = max(best, cur)
    travel_rev = float(np.sum(np.abs(np.diff(np.unwrap(phi)))) / (2 * np.pi))

    frac = float(balanced.mean())
    if frac >= 0.5 and best * dt >= 2.0:
        verdict = "BALANCED"
    elif travel_rev > 5 and frac < 0.3:
        verdict = "SPINNING"
    else:
        verdict = "PARTIAL"

    m = BalanceMetrics(
        n_samples=n, dt_s=dt, hz=1.0 / dt,
        balanced_fraction=frac,
        longest_streak_s=best * dt,
        catches=catches,
        pendulum_revolutions=travel_rev,
        action_abs_mean=float(np.abs(action).mean()),
        verdict=verdict,
        balanced_mask=balanced,
    )

    if int(balanced.sum()) >= one_s:
        drift = np.convolve(motor_pos, np.ones(one_s) / one_s, mode="same")
        sway = motor_pos - drift
        arm_vel = np.gradient(motor_pos, t_s)
        m.pendulum_std_deg = math.degrees(theta[balanced].std())
        m.arm_std_deg = math.degrees(motor_pos[balanced].std())
        m.arm_off_centre_deg = math.degrees(np.abs(motor_pos[balanced]).mean())
        m.arm_sway_deg = math.degrees(sway[balanced].std())
        m.arm_speed_rms = float(np.sqrt((arm_vel[balanced] ** 2).mean()))
        if motor_cmd is not None:
            cmd = np.asarray(motor_cmd, dtype=float)
            m.motor_cmd_travel = float(
                np.mean(np.abs(np.diff(cmd))[balanced[1:]]) / dt)
    return m
