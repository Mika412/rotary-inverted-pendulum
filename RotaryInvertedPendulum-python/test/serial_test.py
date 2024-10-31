#!/usr/bin/env python3

import time

import serial

from src.pendulum_controller import Pendulum


def main():
    # Create the Pendulum object and initialize the connection
    pendulum = Pendulum(serial_path="/dev/cu.usbserial-110", baud_rate=9600)

    if not pendulum.initialized:
        exit()

    # Check if the Arduino is ready to receive commands
    while not pendulum.check_ready():
        print("Pendulum is not ready. Retrying...")
        time.sleep(0.1)  # Wait for 100 ms before trying again

    print("Pendulum is ready to receive commands.")

    for i in range(10):
        pendulum.get_position()
        time.sleep(0.1)

    pendulum.set_target(1600)

    for i in range(10):
        pendulum.get_position()
        time.sleep(0.1)

    # Close the serial connection
    pendulum.close()


if __name__ == "__main__":
    main()
