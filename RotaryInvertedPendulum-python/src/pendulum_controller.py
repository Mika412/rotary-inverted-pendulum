import time
from enum import Enum

from serial import Serial, SerialException


class Command(Enum):
    GET_POSITION = "GET_POSITION"
    CHECK_READY = "CHECK_READY"
    SET_TARGET = "SET_TARGET"


class Pendulum:
    def __init__(self, serial_path: str, baud_rate: int = 115200) -> None:
        self.baud_rate = baud_rate

        self.arduino = None
        self.initialized = False

        # Set up the serial connection
        try:
            self.arduino = Serial(serial_path, baud_rate, timeout=1)
        except SerialException as e:
            print(f"Warning: Failed to initialize serial connection: {e}")

        if self.arduino and self.arduino.is_open:
            self.initialized = True

    def __del__(self) -> None:
        self.close()

    def check_ready(self) -> bool:
        # Send the CHECK_READY command to the Arduino
        self.arduino.write(f"{Command.CHECK_READY}\n".encode())

        # Wait for the response
        response = self.arduino.readline().decode().strip()

        # Check if the Arduino is ready
        return response == "READY"

    def get_position(self) -> float:
        """
        Get the current position of the stepper motor from the Arduino.
        """
        # Send the GET_POSITION command to the Arduino
        self.arduino.write(f"{Command.GET_POSITION}\n".encode())

        # Read the response from the Arduino
        response = self.arduino.readline().decode().strip()

        # Return the position
        return float(response)

    def set_target(self, target_position: int) -> None:
        """
        Set the target position of the stepper motor on the Arduino.
        """
        # Send the SET_TARGET command to the Arduino
        self.arduino.write(f"{Command.SET_TARGET} {target_position}\n".encode())

        # Print the target position
        print(f"Sent target position: {target_position}")

    def close(self) -> None:
        if self.arduino:
            self.arduino.close()
