This example shows the Arduino running a very simple server for testing purposes.

The Arduino Nano is keeping track of a sine and cosine wave over time and also listening to incoming requests over the serial via USB.

If it receives a byte for 'S' or 'C', it replies with the value of the sine or cosine wave, respectively.

Instructions:

1. Flash the `TestServer.ino` file to the Arduino Nano using e.g. Arduino IDE.

2. Navigate into the Julia project folder with:

    ```
    cd ~/git/Rotary\ Inverted\ Pendulum/RotaryInvertedPendulum-julia
    ```

3. Run the Julia script to measure the average communication frequency with:

    ```
    julia --project=. ../RotaryInvertedPendulum-arduino/TestServer/client.jl
    ```
