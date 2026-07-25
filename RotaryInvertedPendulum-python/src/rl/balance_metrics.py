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

**Direction split**: the plant is mirror-symmetric (see `symmetry.py`), so
every metric here has a left and a right version that should agree. They
often don't — a policy that broke the symmetry during training swings up one
way and catches worse on the other side, which shows up as `direction_bias`
and a gap between `catch_rate_ccw` / `catch_rate_cw`. Scored per arrival at
upright rather than per sample, because that is the event the asymmetry acts
on. See `website/src/content/docs/reference/symmetry.md`.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

BAL_THETA_RAD = math.radians(15.0)
BAL_PEN_VEL_RAD_S = 4.0

# An "arrival" at upright: the pendulum entering this band around vertical.
# Wide enough that a failed catch still counts as an attempt (so the catch
# rate has an honest denominator), narrow enough to exclude the pendulum
# merely passing through the upper half on the way round.
ARRIVAL_THETA_RAD = math.radians(60.0)


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
    # Signed counterpart of `arm_off_centre_deg`, which takes |.| and so
    # cannot see a consistent lean. A policy balancing on a symmetric rig
    # should average ~0 here; a persistent offset is either a broken
    # symmetry in the policy or a real asymmetry in the rig (base tilt
    # shifts true upright by an amount that varies with arm angle, so the
    # arm settles where gravity's swing-plane component vanishes).
    arm_off_centre_signed_deg: float | None = None
    # Direction split (see the module docstring). Counted per arrival at
    # upright; CCW/CW is the sign of the pendulum's angular velocity on
    # arrival. None when the trajectory contains no arrivals at all.
    arrivals_ccw: int = 0
    arrivals_cw: int = 0
    catches_ccw: int = 0
    catches_cw: int = 0

    @property
    def has_calmness(self) -> bool:
        return self.pendulum_std_deg is not None

    @property
    def arrivals(self) -> int:
        return self.arrivals_ccw + self.arrivals_cw

    @property
    def catch_rate_ccw(self) -> float | None:
        return self.catches_ccw / self.arrivals_ccw if self.arrivals_ccw else None

    @property
    def catch_rate_cw(self) -> float | None:
        return self.catches_cw / self.arrivals_cw if self.arrivals_cw else None

    @property
    def direction_bias(self) -> float | None:
        """|CCW - CW| / total arrivals, in [0, 1]. 0 = both sides equally used.

        A fair coin over n arrivals sits near sqrt(2/(pi*n)), so read this
        against `arrivals`: 0.3 over 10 arrivals is noise, 0.3 over 200 is a
        policy with a side.
        """
        n = self.arrivals
        return abs(self.arrivals_ccw - self.arrivals_cw) / n if n else None

    @property
    def catch_rate_gap(self) -> float | None:
        """|catch_rate_ccw - catch_rate_cw|, or None if one side never happened."""
        a, b = self.catch_rate_ccw, self.catch_rate_cw
        return abs(a - b) if a is not None and b is not None else None

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
            if self.arm_off_centre_signed_deg is not None:
                lines.append(
                    f"  arm lean signed (bal):   "
                    f"{self.arm_off_centre_signed_deg:+.1f} deg")
            if self.motor_cmd_travel is not None:
                lines.append(
                    f"  motor-cmd travel:        {self.motor_cmd_travel:.1f} /s")
        lines += self.direction_report_lines()
        return lines

    def direction_report_lines(self) -> list[str]:
        """The left/right split. Empty when the pendulum never reached upright."""
        if not self.arrivals:
            return ["  arrivals at upright:     0 (no direction split)"]
        rate = lambda r: "  n/a" if r is None else f"{100 * r:3.0f}%"
        lines = [
            f"  arrivals CCW / CW:       {self.arrivals_ccw} / {self.arrivals_cw}"
            f"   (bias {self.direction_bias:.2f})",
            f"  catch rate CCW / CW:     {rate(self.catch_rate_ccw)} / "
            f"{rate(self.catch_rate_cw)}",
        ]
        if self.catch_rate_gap is not None and self.catch_rate_gap >= 0.25:
            lines.append(
                f"  *** catch rate differs by {100 * self.catch_rate_gap:.0f} "
                f"points between directions — broken mirror symmetry ***")
        return lines


def _direction_stats(theta, pen_vel, balanced, one_s: int) -> dict:
    """Split arrivals at upright by the direction the pendulum came from.

    An arrival is a contiguous run of samples inside `ARRIVAL_THETA_RAD`; its
    direction is the sign of `pen_vel` on entry. It counts as caught if a
    balanced streak of at least `one_s` samples starts inside it, reusing the
    same balance gate as the rest of the module so the two agree by
    construction. A trajectory that starts already near upright has no entry
    sample to read a direction from, so that leading run is skipped.
    """
    near = np.abs(theta) <= ARRIVAL_THETA_RAD
    # Balanced streak length ending at each sample, then "does a >= one_s
    # streak exist anywhere in [i, j)" via a running maximum per run.
    streak = np.zeros(len(balanced), dtype=int)
    run = 0
    for i, b in enumerate(balanced):
        run = run + 1 if b else 0
        streak[i] = run
    out = {"arrivals_ccw": 0, "arrivals_cw": 0, "catches_ccw": 0, "catches_cw": 0}
    i = 1  # start at 1: sample 0 has no entry transition to read
    n = len(theta)
    while i < n:
        if not (near[i] and not near[i - 1]):
            i += 1
            continue
        j = i
        while j < n and near[j]:
            j += 1
        ccw = pen_vel[i] > 0.0
        caught = bool(streak[i:j].max() >= one_s) if j > i else False
        out["arrivals_ccw" if ccw else "arrivals_cw"] += 1
        if caught:
            out["catches_ccw" if ccw else "catches_cw"] += 1
        i = j
    return out


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
        **_direction_stats(theta, pen_vel, balanced, one_s),
    )

    if int(balanced.sum()) >= one_s:
        drift = np.convolve(motor_pos, np.ones(one_s) / one_s, mode="same")
        sway = motor_pos - drift
        arm_vel = np.gradient(motor_pos, t_s)
        m.pendulum_std_deg = math.degrees(theta[balanced].std())
        m.arm_std_deg = math.degrees(motor_pos[balanced].std())
        m.arm_off_centre_deg = math.degrees(np.abs(motor_pos[balanced]).mean())
        m.arm_off_centre_signed_deg = math.degrees(motor_pos[balanced].mean())
        m.arm_sway_deg = math.degrees(sway[balanced].std())
        m.arm_speed_rms = float(np.sqrt((arm_vel[balanced] ** 2).mean()))
        if motor_cmd is not None:
            cmd = np.asarray(motor_cmd, dtype=float)
            m.motor_cmd_travel = float(
                np.mean(np.abs(np.diff(cmd))[balanced[1:]]) / dt)
    return m
