#include <AccelStepper.h>
#include <AS5600.h>
#include <Wire.h>

#include "StepperUtils.h"

// Communication speed
const long BAUD_RATE = 2000000;

// Command bytes
#define CMD_READY 0x01
#define CMD_GET_STATE 0x02
#define CMD_SET_TARGET 0x03
#define CMD_ENGAGE_MOTOR 0x04
#define CMD_DISENGAGE_MOTOR 0x05

// Define stepper motor pins
#define DIR_PIN 2
#define STEP_PIN 3

// State variables
AccelStepper stepper(AccelStepper::DRIVER, STEP_PIN, DIR_PIN, 0, 0, false);
AMS_5600 ams5600;

volatile bool motor_engaged = false;
long motor_target_position = 0;

// Timing for state updates
unsigned long current_time = 0;

// Function prototypes
void handleCommand();
void sendState();
float convertRawAngleToRadians();

void setup()
{
    Serial.begin(BAUD_RATE);
    Wire.begin();

    // Initialize stepper motor
    stepper.setEnablePin(5);                     // Motor enable pin
    stepper.setPinsInverted(false, false, true); // DIR, STEP, ENABLE inverted
    stepper.setMaxSpeed(200000);                 // Set maximum motor speed
    stepper.setAcceleration(100000);             // Set motor acceleration

    // Wait for serial connection
    while (!Serial) { ; }

    // Wait for pendulum magnet
    while (!ams5600.detectMagnet()) { delay(500); }
}

void loop()
{
    if (Serial.available() > 0)
    {
        handleCommand();
    }

    if (motor_engaged)
    {
        stepper.moveTo(motor_target_position);
        stepper.run();
    }
}

/*
 * Handle incoming commands.
 */
void handleCommand()
{
    uint8_t command = Serial.read(); // Read the command byte

    switch (command)
    {
    case CMD_READY:
        // Respond with a single byte to confirm readiness
        Serial.write(CMD_READY);
        break;

    case CMD_GET_STATE:
        sendState();
        break;

    case CMD_SET_TARGET:
        // Wait until 4 bytes (size of float) are available in the buffer
        while (Serial.available() < sizeof(float)) { ; }
        // Now we can safely read the 4 bytes
        float target_radians;
        Serial.readBytes((char *)&target_radians, sizeof(float));
        motor_target_position = radiansToSteps(target_radians);
        break;

    case CMD_ENGAGE_MOTOR:
        motor_engaged = true;
        stepper.enableOutputs();
        break;

    case CMD_DISENGAGE_MOTOR:
        motor_engaged = false;
        stepper.disableOutputs();
        break;

    default:
        // Ignore unknown commands
        break;
    }
}

/*
 * Send the current state of the system:
 * - Current time in microseconds (4 bytes)
 * - Stepper motor position in radians (4 bytes, float)
 * - Pendulum position in radians (4 bytes, float)
 */
void sendState()
{
    current_time = micros(); // Get the current time

    float motor_position_radians = stepsToRadians(stepper.currentPosition());
    float pendulum_position_radians = convertRawAngleToRadians();

    // Flip the signs of the motor and pendulum positions
    motor_position_radians *= -1;
    pendulum_position_radians *= -1;

    // Pack and send the data
    Serial.write((byte *)&current_time, sizeof(current_time));
    Serial.write((byte *)&motor_position_radians, sizeof(motor_position_radians));
    Serial.write((byte *)&pendulum_position_radians, sizeof(pendulum_position_radians));
}

/*
 * Convert the raw angle from the AS5600 magnetic encoder to degrees.
 */
float convertRawAngleToRadians()
{
    static long raw_prev = 0;
    static bool first_reading = true;
    static float position = 0.0f;

    // Get the current position of the AS5600
    long raw = ams5600.getRawAngle();

    if (first_reading)
    {
        raw_prev = raw;
        first_reading = false;
    }
    long delta = raw - raw_prev;

    // Handle wrap around
    if (delta >  2047) delta -= 4096;
    if (delta < -2047) delta += 4096;

    // Map the 0–4095 segments of the AS5600 to 0–2pi radians (0–360 degrees)
    // 2pi radians / 4096 segments = 0.001533981 radians per segment
    // 360 degrees / 4096 segments = 0.087890625 degrees per segment
    position += (float)delta * 0.001533981;

    // Save the current raw angle for the next iteration
    raw_prev = raw;

    return position;
}
