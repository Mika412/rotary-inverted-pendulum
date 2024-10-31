#!/usr/bin/env python

import time
from enum import Enum

import pygame
import serial

from pendulum_controller import Pendulum


def main():
    # Relevant parameters
    control_frequency = 100
    motor_multiplier = 50.0
    actual_position_motor = 0
    target_position_motor = 0

    # Initialize pygame
    pygame.init()

    if not pygame.joystick.get_count():
        print("No joysticks available")
        exit()

    # Set up the Xbox controller
    joystick = None
    for i in range(pygame.joystick.get_count()):
        if "Xbox" in pygame.joystick.Joystick(i).get_name():
            joystick = pygame.joystick.Joystick(i)
            joystick.init()

    # Create the Pendulum object and initialize the connection
    pendulum = Pendulum(serial_path="/dev/cu.usbserial-110")

    if not pendulum.initialized:
        exit()

    # Wait for the Pendulum to initialize
    while not pendulum.check_ready():
        print("Pendulum is not ready. Retrying...")
        time.sleep(0.1)  # Wait for 100 ms before trying again

    print("Pendulum is ready to receive commands.")

    # Initialize variables for tracking time
    last_update_time = time.time()

    # Main loop
    running = True
    while running:
        for event in pygame.event.get():
            if event.type == pygame.QUIT:
                running = False

        # Get the state of the controller
        pygame.event.pump()
        x_axis = joystick.get_axis(0)  # Get the x-axis value of the left joystick

        # Deadzone for the joystick
        if abs(x_axis) < 0.1:
            x_axis = 0.0

        # Adjust motor position based on joystick input
        target_position_motor += int(x_axis * motor_multiplier)

        # Clamp motor position between 0.0 and 1.0
        # target_position_motor = max(0.0, min(1.0, target_position_motor))

        # Get current time
        current_time = time.time()

        # Check if it is time to update the motor
        if current_time - last_update_time >= 1.0 / control_frequency:
            # Get the current position of the motor
            actual_position_motor = pendulum.get_position()

            print(
                f"Current position: {actual_position_motor}, Target Position: {target_position_motor}"
            )

            # Set the target position of the motor
            pendulum.set_target(target_position_motor)

            # Update last update time
            last_update_time = current_time

        # Sleep for a short period of time
        time.sleep(0.01)  # 10 ms

    # Close the serial connection
    pendulum.close()

    # Quit pygame
    pygame.quit()


if __name__ == "__main__":
    main()
