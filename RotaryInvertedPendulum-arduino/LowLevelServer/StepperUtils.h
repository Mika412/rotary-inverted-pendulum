#ifndef STEPPER_UTILS_H
#define STEPPER_UTILS_H

const int microstepsPerRev = 1600; // 200 steps * 8 microsteps

// Convert steps to degrees
float stepsToDegrees(int steps)
{
  return (steps / float(microstepsPerRev)) * 360.0;
}

// Convert steps to radians
float stepsToRadians(int steps)
{
  return (steps / float(microstepsPerRev)) * (2 * PI);
}

// Convert degrees to steps
int degreesToSteps(float degrees)
{
  return round((degrees / 360.0) * microstepsPerRev);
}

// Convert radians to steps
int radiansToSteps(float radians)
{
  return round((radians / (2 * PI)) * microstepsPerRev);
}

#endif
