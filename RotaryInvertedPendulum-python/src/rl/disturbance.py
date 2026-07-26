"""Calibrated disturbance protocol — knock the pendulum with a repeatable
impulse and measure how well a policy recovers.

Why this exists: balanced fraction saturates. The champion holds 1.000 over
300 s undisturbed, and so does its challenger, so the metric returns the same
number for a good policy and a better one. Hand-pushing discriminates but is
not reproducible — force, direction and contact point differ every time, so
neither two policies nor two runs of one policy can be compared. A fixed
motor-driven impulse is identical on every repetition, and turns "it felt
good" into recovery times that can be ranked.

The impulse overrides the ACTUATOR command (`a_cmd` on the rig,
`smoothed_action` in the sim) for a couple of ticks, downstream of the
smoothing boxcar and upstream of nothing. The policy's own output is left
untouched, so `prev_action` never carries the kick: the policy sees motion it
did not command, which is what makes this a disturbance rather than an action
it has to own.

Kicks alternate sign, so every metric splits left vs right. That makes this a
sharper symmetry probe than swing-up direction preference — it measures
recovery from an identical impulse on each side, and it works on a policy that
never has to swing up at all (see reference/symmetry.md).

Caveats, because they bound what the numbers mean:
  - A motor kick excites the BASE; a hand push excites the TIP. Different
    disturbance shapes. This ranks policies, it does not measure a hand push.
  - The impulse is bounded by the motor's own accel/velocity envelope — you
    cannot kick harder than the plant can push itself.

MEASURED 2026-07-26, and it shaped the design: response to a fixed kick is
BIMODAL, not graded. At 50 Hz on this rig the champion peaks at ~7 deg and
always recovers up to amp 0.75, and is flat on its back (~170 deg) by 0.90 —
an inverted pendulum's recoverable basin has a hard edge, so there is no band
where it is displaced 30 deg and fights back. Peak angle and recovery time are
therefore near-useless as primary metrics; both are bimodal.

WHAT EACH METRIC IS ACTUALLY WORTH — positive-controlled against five policies
whose rig behaviour is known (2026-07-26). Read this before trusting a number.

  critical amplitude              MEASURES THE PLANT, NOT THE POLICY. The
                                  staircase that found it is DELETED; this is
                                  the record of why, so it is not rebuilt.
      smooth50 0.622, sym_s1 0.594, tmc_centred 0.591, tmc_still 0.581,
      v11 0.583 — all within 7%, and tmc_centred (rig 0.803, 44 drops) is
      indistinguishable from tmc_still (rig 1.000). The recoverable basin edge
      is set by pendulum geometry and motor authority; any competent balancer
      catches what is inside it and fails outside. Do NOT rank policies on it.
      It also has a ceiling trap: amplitude cannot exceed 1.0 (the action
      range), so a threshold near it is compressed and inflates the direction
      ratio — a 2-tick impulse gave a spurious 1.12x asymmetry that vanished to
      1.01x at 3 ticks.

  peak |theta|                    USELESS. Plant-determined: 6.07/6.11/6.20/
      6.32 deg across policies that behave completely differently on the rig.

  recovery time + balanced        MEASURES RECOVERY BRISKNESS, not rig quality.
  fraction UNDER kicks            Over ~230 kicks/policy: sym_s1 0.12 s / 0.972,
      tmc_still 0.18 s / 0.965, smooth50 0.30 s / 0.850, tmc_centred 0.32 s /
      0.963. It cleanly separates the two champion candidates — sym_s1 settles
      2.5x faster than smooth50 and holds 0.972 vs 0.850 under an identical
      protocol — but it does NOT flag tmc_centred, so it is not a deployment
      predictor. Use it for matched-protocol A/B between good policies.
      RECOVER_DEG must sit near the policy's own pendulum std (~3 deg); at the
      old 10 deg default every kick reported 0.00 s.

  ARM WALK PER KICK               THE ONE THAT WORKS. tmc_centred 17.0 deg vs
      13.2-13.9 for the rest — it is the only metric here that isolates the
      policy that deploys badly, and it agrees with what the rig measured
      independently (arm sigma 17.1, arm speed 2.72). Use this one to decide
      whether a policy is safe to deploy. Caveat: one known-bad policy is a
      sample of one — treat the 13-15 vs 18+ boundary as indicative.

WHY THIS MODULE EARNS ITS KEEP: every UNDISTURBED sim metric ranks tmc_centred
BEST of four policies (arm sigma 4.1 vs 6.2-9.4, off-centre 5.5 vs 7.0-34.6,
gate 0.774) — and it is the one that deployed at 0.803 with 44 drops while the
others held 1.000. Kicking it is the only offline measurement that flags it.
That is the sim-to-rig predictor gap this project keeps falling into; run a
sub-critical kick before spending rig time on a policy that looks calm in sim.

DIRECTION SPLIT DOES NOT SEE THE SWING-UP ASYMMETRY, and that is expected
rather than a defect: this protocol fires only while balanced, and near upright
the policies are already close to equivariant (see reference/symmetry.md). The
asymmetry mirror augmentation fixes lives in the SWING-UP, which this test
deliberately never enters. Measure that with direction bias and signed arm
lean, not with kicks.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field

import numpy as np

import balance_metrics

# A kick counts as recovered once |theta| holds under this for HOLD_S. Must sit
# near the policy's own pendulum std (~1.5-3 deg) or every kick reports 0.00 s.
RECOVER_DEG = 3.0
HOLD_S = 0.5
# Past this the pendulum is over, not perturbed — scored as a drop.
DROP_DEG = 60.0


class KickSchedule:
    """Decides when to fire, and with which sign.

    Owns the balance predicate rather than leaving it to each caller, so the
    sim harness and the rig loop fire on the same definition of "balanced" that
    `balance_metrics` reports — and a threshold retune reaches all of them.

    Fires only while balanced, so a kick lands on a policy holding station
    rather than one still swinging up or already falling; otherwise the
    recovery window measures the wrong thing.
    """

    def __init__(self, every_s: float = 8.0, amp: float = 0.6,
                 settle_s: float = 3.0):
        self.every_s = float(every_s)
        self.amp = float(amp)
        self.settle_s = float(settle_s)
        self._last_t = -math.inf
        self._sign = 1.0

    def due(self, t_s: float, theta_rad: float,
            pen_vel_rad_s: float) -> float | None:
        """Signed amplitude if a kick should fire now, else None."""
        balanced = (abs(theta_rad) <= balance_metrics.BAL_THETA_RAD
                    and abs(pen_vel_rad_s) <= balance_metrics.BAL_PEN_VEL_RAD_S)
        if not balanced or t_s < self.settle_s:
            return None
        if t_s - self._last_t < self.every_s:
            return None
        self._last_t = t_s
        value = self._sign * self.amp
        self._sign = -self._sign
        return value


@dataclass
class KickResult:
    t_s: float
    sign: float
    peak_deg: float
    recovery_s: float | None   # None = never settled inside the window
    dropped: bool
    arm_walk_deg: float


@dataclass
class DisturbanceReport:
    kicks: list[KickResult] = field(default_factory=list)

    @property
    def n(self) -> int:
        return len(self.kicks)

    def summary(self, sign: float | None = None) -> dict:
        ks = [k for k in self.kicks if sign is None or k.sign == sign]
        if not ks:
            return {}
        # Recovery only over kicks it survived: a dropped kick's "recovery" is
        # the pendulum spinning through 360 deg back to upright, a different
        # event that would corrupt the median.
        rec = [k.recovery_s for k in ks
               if k.recovery_s is not None and not k.dropped]
        return {
            "n": len(ks),
            "settled": len(rec),
            "peak_med": float(np.median([k.peak_deg for k in ks])),
            "peak_worst": max(k.peak_deg for k in ks),
            "rec_med": float(np.median(rec)) if rec else float("nan"),
            "rec_worst": max(rec) if rec else float("nan"),
            "drops": sum(k.dropped for k in ks),
            "arm_walk": float(np.mean([k.arm_walk_deg for k in ks])),
        }

    def report_lines(self) -> list[str]:
        s = self.summary()
        if not s:
            return ["  no kicks fired — policy never held balance long enough"]
        out = [
            f"  peak |theta|      : median {s['peak_med']:.1f} deg, "
            f"worst {s['peak_worst']:.1f} deg",
            f"  recovery time     : median {s['rec_med']:.2f} s, "
            f"worst {s['rec_worst']:.2f} s "
            f"({s['settled']}/{s['n']} settled)",
            f"  drops             : {s['drops']} / {s['n']}",
            f"  arm walk / kick   : {s['arm_walk']:.1f} deg   <- the metric "
            f"that discriminates",
        ]
        left, right = self.summary(+1.0), self.summary(-1.0)
        if left and right:
            out.append(
                f"  direction split   : + median {left['rec_med']:.2f} s, "
                f"{left['drops']}/{left['n']} drops")
            out.append(
                f"                      - median {right['rec_med']:.2f} s, "
                f"{right['drops']}/{right['n']} drops")
            lo = min(left["rec_med"], right["rec_med"])
            hi = max(left["rec_med"], right["rec_med"])
            if lo > 0 and math.isfinite(hi):
                out.append(f"  recovery asymmetry: {hi / lo:.2f}x "
                           f"(1.00 = symmetric)")
        return out


def analyse(t_s, phi_rad, motor_pos_rad, kick_t, kick_sign) -> DisturbanceReport:
    """Score each kick's aftermath.

    Takes raw `phi_rad` and wraps to angle-from-upright here, so callers never
    open-code the convention. Each kick's window runs to the next kick, so
    recovery is always measured before the next disturbance lands.
    """
    t_s = np.asarray(t_s, dtype=float)
    th = np.degrees(np.abs(balance_metrics.wrap_pi(
        np.asarray(phi_rad, dtype=float) - np.pi)))
    arm = np.degrees(np.asarray(motor_pos_rad, dtype=float))
    dt = float(np.median(np.diff(t_s))) if len(t_s) > 1 else 1.0
    hold_n = max(2, int(round(HOLD_S / dt)))
    rep = DisturbanceReport()

    for i, (t0, sign) in enumerate(zip(kick_t, kick_sign)):
        t_end = kick_t[i + 1] if i + 1 < len(kick_t) else t_s[-1]
        w = (t_s >= t0) & (t_s < t_end)
        if not w.any():
            continue
        tw, thw, armw = t_s[w], th[w], arm[w]

        # Settled = |theta| under RECOVER_DEG for hold_n consecutive samples.
        # Rolling count via cumsum: one pass instead of rebuilding a boolean
        # window per candidate index.
        under = (thw <= RECOVER_DEG).astype(np.int32)
        recovery, end = None, len(tw) - 1
        if len(under) >= hold_n:
            c = np.concatenate(([0], np.cumsum(under)))
            hits = np.flatnonzero((c[hold_n:] - c[:-hold_n]) == hold_n)
            if len(hits):
                end = int(hits[0])
                recovery = float(tw[end] - t0)

        rep.kicks.append(KickResult(
            t_s=float(t0), sign=float(np.sign(sign)),
            peak_deg=float(thw.max()),
            recovery_s=recovery, dropped=bool(thw.max() > DROP_DEG),
            arm_walk_deg=float(abs(armw[end] - armw[0])),
        ))
    return rep
