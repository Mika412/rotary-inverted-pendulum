"""Measure host↔Nano serial round-trip time against the `TestSerial` sketch.

`TestSerial.ino` echoes every byte it receives. Timing that echo bounds how
fast any tethered control loop can possibly run: step 2 (fine-tuning) closes
its loop over this link, so an RTT of R ms caps the achievable rate at 1000/R
Hz before the policy has done any thinking at all.

Expect roughly 2.5 ms at 115200 baud (~400 Hz ceiling). Materially worse
usually means a USB hub, a serial-port power-management setting, or a cable.

Usage:
    python measure_serial_rtt.py --port /dev/cu.usbserial-10
    python measure_serial_rtt.py --port /dev/cu.usbserial-10 --baud 115200 --trials 200
"""
from __future__ import annotations

import argparse
import time

import numpy as np
import serial


# The Nano reboots when the port opens; nothing sent before the sketch is
# running will be echoed.
RESET_SETTLE_S = 1.0
TEST_BYTE = b"\x55"  # 0b01010101 — alternating bits, so a stuck line shows up.


def measure_single(port: serial.Serial, timeout_s: float) -> float | None:
    """One write→echo round trip, in milliseconds. None on timeout/mismatch."""
    port.reset_input_buffer()
    port.reset_output_buffer()

    t_start = time.perf_counter()
    port.write(TEST_BYTE)
    port.flush()

    deadline = t_start + timeout_s
    while time.perf_counter() < deadline:
        if port.in_waiting:
            received = port.read(1)
            elapsed_ms = (time.perf_counter() - t_start) * 1000.0
            return elapsed_ms if received == TEST_BYTE else None
    return None


def measure(port_name: str, baud: int, trials: int, warmup: int,
            timeout_s: float) -> None:
    print(f"Opening {port_name} at {baud} baud...")
    with serial.Serial(port_name, baud, timeout=timeout_s) as port:
        time.sleep(RESET_SETTLE_S)
        port.reset_input_buffer()
        port.reset_output_buffer()

        print(f"Running {warmup} warmup trials (discarded)...")
        for _ in range(warmup):
            measure_single(port, timeout_s)

        print(f"Running {trials} measurement trials...")
        rtts, timeouts = [], 0
        for i in range(trials):
            rtt = measure_single(port, timeout_s)
            if rtt is None:
                timeouts += 1
                print(f"  warning: no/!= echo on trial {i + 1}")
            else:
                rtts.append(rtt)

    print("=" * 52)
    if not rtts:
        print(f"ERROR: no valid measurements ({timeouts} timeouts).")
        print("Is TestSerial.ino flashed, and is --baud right?")
        print("=" * 52)
        return

    a = np.asarray(rtts)
    print(f"Successful trials: {a.size}/{trials}   timeouts: {timeouts}")
    print("\nRound-trip time (ms):")
    print(f"  min {a.min():.3f}   mean {a.mean():.3f}   "
          f"median {np.median(a):.3f}   max {a.max():.3f}   std {a.std():.3f}")
    if a.size >= 10:
        p50, p95, p99 = np.percentile(a, [50, 95, 99])
        print(f"  p50 {p50:.3f}   p95 {p95:.3f}   p99 {p99:.3f}")
    print(f"\nMax theoretical loop rate: {1000.0 / a.mean():.1f} Hz")
    print("=" * 52)


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--port", required=True, help="e.g. /dev/cu.usbserial-10")
    ap.add_argument("--baud", type=int, default=115200,
                    help="must match TestSerial.ino's BAUD_RATE (default: %(default)s)")
    ap.add_argument("--trials", type=int, default=100)
    ap.add_argument("--warmup", type=int, default=5)
    ap.add_argument("--timeout-s", type=float, default=1.0)
    args = ap.parse_args()

    if args.trials <= 0:
        ap.error("--trials must be positive")
    measure(args.port, args.baud, args.trials, args.warmup, args.timeout_s)


if __name__ == "__main__":
    main()
