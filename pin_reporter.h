#pragma once
#include <Arduino.h>

// ---------------------------------------------------------------------------
// pin_reporter.h
//
// Drop this file into the same folder as your .ino (Arduino IDE will show it
// as a second tab automatically). It gives you one class, PinReporter, that
// periodically prints the current state of whichever pins you list to
// Serial, wrapped in <PR> ... </PR> markers. The companion website looks for
// those markers and ignores everything else, so your own Serial.print()
// debug lines keep working untouched in the same stream.
//
// This does NOT read hardware registers behind your back — it only reports
// pins you explicitly configure with begin(). digitalRead() only reflects
// reality if you already set the pin's mode with pinMode(); PWM values only
// reflect reality if you drive that pin with the ESP32 LEDC API
// (ledcSetup/ledcAttachPin/ledcWrite), because that's the only way the chip
// exposes a readable duty cycle back to you.
// ---------------------------------------------------------------------------

#define PR_MAX_LABEL_LEN 24

enum PRPinType : uint8_t {
  PR_DIGITAL_IN,   // digitalRead(pin) -> 0 or 1
  PR_DIGITAL_OUT,  // digitalRead(pin) -> 0 or 1 (works even though it's an output)
  PR_PWM,          // ledcRead(ledcChannel) -> 0-255 (or up to 2^bits-1 if you changed resolution)
  PR_ANALOG_IN     // analogRead(pin) -> 0-4095 (ESP32 ADC is 12-bit by default)
};

struct PRPinConfig {
  uint8_t pin;            // GPIO number
  PRPinType type;         // how to read it
  uint8_t ledcChannel;    // unused on ESP32 Arduino core 3.x+ (LEDC is addressed by pin now);
                          // kept for source compatibility, set to 0
  const char* label;      // optional, shown on the dashboard instead of "GPIO n"
};

class PinReporter {
  public:
    // pins: pointer to an array of PRPinConfig you keep alive (e.g. a global array)
    // count: number of entries in that array
    // intervalMs: how often to send a report (default 150ms, ~6-7 updates/sec)
    void begin(PRPinConfig* pins, uint8_t count, unsigned long intervalMs = 150) {
      _pins = pins;
      _count = count;
      _interval = intervalMs;
      _last = 0;
    }

    // Call this once per loop() iteration. It only actually sends data every
    // `intervalMs`, so calling it every loop is fine and won't flood Serial.
    void loop() {
      if (_pins == nullptr) return;
      unsigned long now = millis();
      if (now - _last < _interval) return;
      _last = now;
      send();
    }

  private:
    PRPinConfig* _pins = nullptr;
    uint8_t _count = 0;
    unsigned long _interval = 150;
    unsigned long _last = 0;

    void send() {
      Serial.print(F("<PR>{\"t\":"));
      Serial.print(millis());
      Serial.print(F(",\"pins\":["));
      for (uint8_t i = 0; i < _count; i++) {
        PRPinConfig &p = _pins[i];
        long value = 0;
        const char* typeStr = "d";

        switch (p.type) {
          case PR_DIGITAL_IN:
          case PR_DIGITAL_OUT:
            value = digitalRead(p.pin);
            typeStr = "d";
            break;
          case PR_PWM:
            value = ledcRead(p.pin);   // core 3.x+: LEDC is read back by pin, not channel
            typeStr = "p";
            break;
          case PR_ANALOG_IN:
            value = analogRead(p.pin);
            typeStr = "a";
            break;
        }

        Serial.print(F("{\"pin\":"));
        Serial.print(p.pin);
        Serial.print(F(",\"type\":\""));
        Serial.print(typeStr);
        Serial.print(F("\",\"val\":"));
        Serial.print(value);
        if (p.label != nullptr && p.label[0] != '\0') {
          Serial.print(F(",\"label\":\""));
          Serial.print(p.label);
          Serial.print(F("\""));
        }
        Serial.print(F("}"));
        if (i < _count - 1) Serial.print(F(","));
      }
      Serial.print(F("]}</PR>"));
      Serial.println();
    }
};
