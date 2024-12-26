const long BAUD_RATE = 115200;

void setup()
{
    Serial.begin(BAUD_RATE); // Start serial communication at defined baud rate
    while (!Serial) { ; }    // Wait for the serial port to connect
}

void loop()
{
    if (Serial.available() > 0)
    {
        char incomingByte = Serial.read(); // Read the incoming byte
        Serial.write(incomingByte);        // Echo it back to the sender
    }
}
