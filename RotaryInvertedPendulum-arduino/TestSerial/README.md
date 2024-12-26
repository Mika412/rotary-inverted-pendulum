Instructions:

1. Flash the `TestSerial.ino` file to the Arduino Nano using e.g. Arduino IDE.

2. Run the Julia script to measure the round trip time with:

    ```
    julia --project=. ./scripts/measure_serial_rtt.jl /dev/cu.usbserial-110 115200
    ```
