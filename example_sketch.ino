// Example: your normal sketch + two extra lines for the pin dashboard.
//
// This blinks the onboard LED, reads a button, sweeps a PWM pin, and reads
// an analog pin — completely normally. The only additions are:
//   1. #include "pin_reporter.h"  + PinReporter PinRep;
//   2. Listing the pins you want visible on the dashboard
//   3. Calling PinRep.loop() once per loop()
//
// Adjust pin numbers / labels for your own board and wiring.

#include "pin_reporter.h"

PinReporter PinRep;

// GPIO2 is the onboard LED on most ESP32 DevKit boards. Change if yours differs.
const uint8_t LED_PIN    = 2;
const uint8_t BUTTON_PIN = 4;
const uint8_t PWM_PIN    = 5;
const uint8_t PWM_CHANNEL = 0;
const uint8_t ANALOG_PIN = 34;

PRPinConfig monitoredPins[] = {
  { LED_PIN,    PR_DIGITAL_OUT, 0,           "onboard_led" },
  { BUTTON_PIN, PR_DIGITAL_IN,  0,           "button" },
  { PWM_PIN,    PR_PWM,         PWM_CHANNEL, "fan_pwm" },
  { ANALOG_PIN, PR_ANALOG_IN,   0,           "pot" },
};

unsigned long lastBlink = 0;
bool ledState = false;

void setup() {
  Serial.begin(115200);

  pinMode(LED_PIN, OUTPUT);
  pinMode(BUTTON_PIN, INPUT_PULLUP);

  ledcAttach(PWM_PIN, 5000, 8);   // pin, freq (Hz), resolution (bits) — core 3.x+ API

  // Tell the reporter which pins to watch and how often to send updates.
  PinRep.begin(monitoredPins, 4, 150); // 150ms between reports
}

void loop() {
  // --- your own code, unmodified ---
  if (millis() - lastBlink > 500) {
    lastBlink = millis();
    ledState = !ledState;
    digitalWrite(LED_PIN, ledState);
  }

  // demo PWM sweep so you see the fan_pwm value move on the dashboard
  ledcWrite(PWM_PIN, (millis() / 10) % 256);   // core 3.x+: write by pin, not channel

  // any of your own Serial.print()/println() calls still work fine and will
  // show up in the website's serial monitor alongside the pin data
  // Serial.println("doing my own thing");

  // --- the one line you add for the dashboard ---
  PinRep.loop();
}
