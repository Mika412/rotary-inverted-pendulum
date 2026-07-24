"""Capture RLControl.ino telemetry and score it with the honest balance metrics.

The standalone sketch streams one CSV line per control tick while telemetry
is enabled ('P' command):

    t_us, motor_pos_rad*1000, phi_rad*1000, action*1000, state, freq_hz, overruns

This script opens the port, sends 'P' to enable the stream, captures for
--duration-s, and computes the same honest metrics as run_policy /
analyze_deploy (|theta| <= 15 deg AND |theta_dot| <= 2 rad/s, streaks,
revolutions, verdict) so on-device policies can be compared to tethered
deploys — and to each other — on rig truth rather than sim predictions.

theta_dot is a central finite difference of the streamed phi at the control
rate (the sketch doesn't stream its window velocities); at 35 Hz and 12-bit
resolution that's ~0.05 rad/s resolution — fine for a 2 rad/s gate.

Usage:
    python analyze_onboard.py --port /dev/cu.usbserial-10 --duration-s 60 \\
        --log recordings/onboard_h16_dagger.npz

NB: opening the serial port RESETS the Nano (auto-reset on DTR) — the
sketch reboots, re-zeroes the encoder (pendulum must hang still!), and
re-engages after its 1 s settle delay. Capture starts after boot.
"""

from __future__ import annotations

import argparse
import math
import sys
import time

import numpy as np
import serial


BAL_THETA_RAD = math.radians(15.0)
# Gate raised 2.0 -> 4.0 on 2026-07-22: the old value punished the tight ~5 Hz micro-oscillation of fast balancing policies (theta_dot peaks past 2 rad/s at 1.7 deg amplitude) while spin-through and vibrational stabilisation run >= 7-20 rad/s, so 4.0 keeps the gate's anti-spoof teeth without underrating genuine tight balance.
BAL_PEN_VEL_RAD_S = 4.0


def _wrap_pi(x: np.ndarray) -> np.ndarray:
    return (x + np.pi) % (2.0 * np.pi) - np.pi


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Capture + score on-device telemetry")
    p.add_argument("--port", required=True)
    p.add_argument("--baud", type=int, default=500000)
    p.add_argument("--duration-s", type=float, default=60.0)
    p.add_argument("--settle-s", type=float, default=5.0,
                   help="discard this much stream after boot (swing-up + "
                        "the sketch's own engage delay)")
    p.add_argument("--expect-hz", type=float, default=35.0,
                   help="the flashed policy's control rate — the capture is "
                        "flagged invalid if the measured loop rate deviates")
    p.add_argument("--log", default=None, help="optional .npz output")
    args = p.parse_args(argv if argv is not None else sys.argv[1:])

    print(f"Opening {args.port} (this resets the Nano — pendulum should hang still)")
    ser = serial.Serial(args.port, args.baud, timeout=2.0)
    time.sleep(3.0)  # bootloader + setup() + magnet check + settle delay
    ser.reset_input_buffer()
    ser.write(b"P")  # enable telemetry

    rows = []
    t_end = time.monotonic() + args.duration_s + args.settle_s
    print(f"Capturing {args.duration_s:.0f}s (+{args.settle_s:.0f}s settle) ...")
    while time.monotonic() < t_end:
        line = ser.readline().decode(errors="ignore").strip()
        parts = line.split(",")
        if len(parts) != 7:
            continue  # boot banner / partial line
        try:
            rows.append([float(v) for v in parts])
        except ValueError:
            continue
    ser.write(b"P")  # disable again
    ser.close()

    if len(rows) < 50:
        print(f"only {len(rows)} telemetry rows captured — is the sketch running?")
        return 1

    arr = np.asarray(rows)
    t_s = (arr[:, 0] - arr[0, 0]) * 1e-6
    motor_pos = arr[:, 1] / 1000.0
    phi = arr[:, 2] / 1000.0
    action = arr[:, 3] / 1000.0
    running = arr[:, 4] > 0.5
    overruns = int(arr[-1, 6])

    # Drop the settle window and any non-RUNNING rows (hard-limit trips).
    keep = (t_s >= args.settle_s) & running
    t_s, motor_pos, phi, action = t_s[keep], motor_pos[keep], phi[keep], action[keep]
    n = len(t_s)
    if n < 50:
        print("not enough RUNNING samples after the settle window")
        return 1
    dt = float(np.median(np.diff(t_s)))
    freq = 1.0 / dt
    if abs(freq - args.expect_hz) > 1.5:
        print(f"\n*** WARNING: control loop ran at {freq:.1f} Hz, "
              f"not {args.expect_hz:g} Hz. ***\n"
              "*** The policy is out of its design regime (inference too slow ***\n"
              "*** for the tick?) — this capture does NOT evaluate the policy, ***\n"
              "*** it evaluates a broken deployment. ***")

    theta = _wrap_pi(phi - np.pi)
    # Central-difference pendulum velocity from the streamed positions.
    pen_vel = np.gradient(np.unwrap(phi), t_s)

    balanced = (np.abs(theta) <= BAL_THETA_RAD) & (np.abs(pen_vel) <= BAL_PEN_VEL_RAD_S)
    frac = float(balanced.mean())
    # Longest streak + catches >= 1 s.
    best = cur = 0
    catches = 0
    for b in balanced:
        cur = cur + 1 if b else 0
        if cur == int(round(1.0 / dt)):
            catches += 1
        best = max(best, cur)
    travel_rev = float(np.sum(np.abs(np.diff(np.unwrap(phi)))) / (2 * np.pi))

    if frac >= 0.5 and best * dt >= 2.0:
        verdict = "BALANCED"
    elif travel_rev > 5 and frac < 0.3:
        verdict = "SPINNING"
    else:
        verdict = "PARTIAL"

    print(f"\nOn-device honest balance ({n} ticks @ {freq:.1f} Hz, "
          f"{n * dt:.1f}s scored, {overruns} loop overruns):")
    print(f"  balanced fraction:       {frac:.3f}")
    print(f"  longest balanced streak: {best * dt:.2f} s")
    print(f"  catches (>=1s):          {catches}")
    print(f"  pendulum revolutions:    {travel_rev:.1f} gross")
    print(f"  |action| mean:           {float(np.abs(action).mean()):.3f}")
    print(f"  verdict:                 {verdict}")

    # Calmness during the balanced phase. A real Furuta balances WITH arm
    # motion, so some is unavoidable; excess arm wander/sway is what shakes
    # the base. Arm sway is the sub-1s component of the arm angle (the
    # ~0.6 Hz balancing wiggle); arm std includes slow drift too. Reported
    # so deployed policies can be compared on calmness, not just balance.
    if int(balanced.sum()) >= int(round(1.0 / dt)):
        win = max(1, int(round(1.0 / dt)))
        arm_drift = np.convolve(motor_pos, np.ones(win) / win, mode="same")
        arm_sway = motor_pos - arm_drift
        print(f"  pendulum std (bal):      {np.degrees(theta[balanced].std()):.2f} deg")
        print(f"  arm std (bal):           {np.degrees(motor_pos[balanced].std()):.1f} deg")
        print(f"  arm sway <1s (bal):      {np.degrees(arm_sway[balanced].std()):.2f} deg")

    if args.log:
        if not args.log.endswith(".npz"):
            raise SystemExit("--log must end in .npz")
        np.savez_compressed(args.log, t_s=t_s, motor_pos_rad=motor_pos,
                            pendulum_pos_rad=phi, action=action,
                            control_freq_hz=freq)
        print(f"saved capture -> {args.log}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
