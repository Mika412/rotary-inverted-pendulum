This example demonstrates real-time control and visualisation of the device over serial via a USB cable.

The Arduino is running a low-level server that handles commands from the laptop over the serial.

The Julia "client" script is showing a 3D representation of the device, retrieving its state in real time, as well as controlling the motor to a target position which tracks a sine wave.

Instructions:

1. Flash the `LowLevelServer.ino` file to the Arduino Nano using e.g. Arduino IDE.

2. Navigate into the Julia project folder with:

    ```
    cd ~/git/Rotary\ Inverted\ Pendulum/RotaryInvertedPendulum-julia
    ```

3. Run the Julia script to measure the average communication frequency with:

    ```
    julia --project=. ../RotaryInvertedPendulum-arduino/LowLevelServer/client.jl --visualise
    ```
