"""Capture RLControl.ino telemetry and score it with the honest balance metrics.

The standalone sketch streams one CSV line per control tick while telemetry
is enabled ('P' command):

    t_us, motor_pos_rad*1000, phi_rad*1000, action*1000, state, freq_hz, overruns

This script opens the port, sends 'P' to enable the stream, captures for
--duration-s, and scores it with `balance_metrics` — the same module
`analyze_sim.py` uses — so on-device policies can be compared to sim
predictions, to tethered deploys, and to each other on rig truth.

theta_dot is a central finite difference of the streamed phi at the control
rate (the sketch doesn't stream its window velocities); at 35 Hz and 12-bit
resolution that's ~0.05 rad/s resolution — fine for the 4 rad/s gate.

Usage:
    python analyze_onboard.py --port /dev/cu.usbserial-10 --duration-s 60 \\
        --log recordings/onboard_h16_dagger.npz

NB: opening the serial port RESETS the Nano (auto-reset on DTR) — the
sketch reboots, re-zeroes the encoder (pendulum must hang still!), and
re-engages after its 1 s settle delay. Capture starts after boot.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

import numpy as np
import serial

import balance_metrics
from pendulum_env import OBS_STALENESS_NOMINAL_S


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description="Capture + score on-device telemetry")
    p.add_argument("--port", required=True)
    p.add_argument("--baud", type=int, default=500000)
    p.add_argument("--duration-s", type=float, default=60.0)
    p.add_argument("--settle-s", type=float, default=5.0,
                   help="discard this much stream after boot (swing-up + "
                        "the sketch's own engage delay)")
    p.add_argument("--expect-hz", type=float, default=50.0,
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
        if len(parts) < 7:
            continue  # boot banner / partial line
        # 13 fields: velocities the policy consumed (9-11) and the velocity
        # finite-difference window span in µs (12). Pad older short lines
        # with NaN so the array stays rectangular.
        parts = parts[:13]
        try:
            row = [float(v) for v in parts]
        except ValueError:
            continue
        row += [float("nan")] * (13 - len(row))
        rows.append(row)
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
    # Sample->command latency, present since the sketch started reporting it.
    latency_us = arr[:, 7] if arr.shape[1] > 7 else None
    # On-chip velocities the policy consumed + P-law integrator (NaN on
    # captures from older sketches).
    motor_vel = arr[:, 9] / 1000.0
    pen_vel = arr[:, 10] / 1000.0
    v_cmd = arr[:, 11] / 1000.0
    vel_span_ms = arr[:, 12] / 1000.0

    # Drop the settle window and any non-RUNNING rows (hard-limit trips).
    keep = (t_s >= args.settle_s) & running
    t_s, motor_pos, phi, action = t_s[keep], motor_pos[keep], phi[keep], action[keep]
    motor_vel, pen_vel, v_cmd = motor_vel[keep], pen_vel[keep], v_cmd[keep]
    vel_span_ms = vel_span_ms[keep]
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

    m = balance_metrics.score(phi=phi, motor_pos=motor_pos, action=action,
                              t_s=t_s)

    print(f"\nOn-device honest balance ({n} ticks @ {freq:.1f} Hz, "
          f"{n * dt:.1f}s scored, {overruns} loop overruns):")
    for line in m.report_lines():
        print(line)

    if latency_us is not None:
        lat = latency_us[keep]
        print(f"  sample->command latency     : mean {lat.mean() / 1000:.2f} ms, "
              f"p95 {np.percentile(lat, 95) / 1000:.2f} ms, "
              f"max {int(arr[-1, 8]) / 1000:.2f} ms")
        print(f"    (sim models this as obs_staleness_s = "
              f"{OBS_STALENESS_NOMINAL_S * 1000:.0f} ms nominal)")

    # Sampler health: the on-chip window velocity vs the velocity implied by
    # the logged positions. Large residuals mean the policy is acting on
    # velocity estimates that don't match its own position channel — the
    # observation-side fault class that tethered runs (which log the full
    # observation) can see and standalone runs previously couldn't.
    if not np.all(np.isnan(motor_vel)):
        dt_med = float(np.median(np.diff(t_s)))
        mv_pos = np.gradient(motor_pos) / dt_med
        pv_pos = np.gradient(phi) / dt_med
        res_m = motor_vel - mv_pos
        res_p = pen_vel - pv_pos
        print(f"  on-chip velocity vs d(pos)/dt : motor residual "
              f"std {np.nanstd(res_m):.2f} rad/s, pendulum {np.nanstd(res_p):.2f} rad/s")
        print(f"  velocity spikes |v|>10 rad/s  : motor "
              f"{int(np.nansum(np.abs(motor_vel) > 10))}, pendulum "
              f"{int(np.nansum(np.abs(pen_vel) > 10))} of {len(motor_vel)} ticks")
    if not np.all(np.isnan(vel_span_ms)):
        print(f"  velocity FD window span       : mean "
              f"{np.nanmean(vel_span_ms):.1f} ms, p95 "
              f"{np.nanpercentile(vel_span_ms, 95):.1f} ms  (designed 8.0 ms — "
              f"the span firmware_obs_model trains against)")

    if args.log:
        if not args.log.endswith(".npz"):
            raise SystemExit("--log must end in .npz")
        # gitignored dir, absent in a fresh clone; failing here would throw
        # away a capture that already cost rig time.
        Path(args.log).parent.mkdir(parents=True, exist_ok=True)
        extra = {} if latency_us is None else {"latency_us": latency_us[keep]}
        np.savez_compressed(args.log, t_s=t_s, motor_pos_rad=motor_pos,
                            pendulum_pos_rad=phi, action=action,
                            motor_vel_rad_s=motor_vel, pendulum_vel_rad_s=pen_vel,
                            v_cmd_rad_s=v_cmd, vel_span_ms=vel_span_ms,
                            control_freq_hz=freq, **extra)
        print(f"saved capture -> {args.log}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
