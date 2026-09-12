# Bench — live ESP32 pin monitor + serial console, in the browser

A static website that connects to an ESP32 over USB (via the [Web Serial
API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)) and
shows:

- a board diagram styled after a real ESP32 DevKit, with each pin's live
  value shown right next to it — click any pin to graph its value over time
- digital pins graph as a step trace, analog/PWM as a normal line
- pins flagged with **i** for known caveats (input-only ADC pins, or pins
  reserved for the module's internal flash)
- a normal serial monitor for everything else your sketch prints
- a box to send text back to the board

No server, no build step, no external dependencies (including no Google
Fonts — everything renders with system fonts, so it works fully offline
once the page itself is loaded/cached).

## ⚠ Board layout is not yet confirmed

The pin diagram (`BOARD_TOP` / `BOARD_BOTTOM` in `app.js`) was read off a
photo of one specific board and has **not** been independently verified —
in particular there's an open question of whether that board is a 30-pin or
38-pin ESP32 DevKit, which changes whether `TX2`/`RX2` (GPIO17/16) actually
exist on it. If your board's printed labels don't match what's on screen,
edit those two arrays — each entry is:

```js
{ silk: 'label printed on your board', pin: <GPIO number>, kind: 'gnd' | 'power' }
```

Use `pin: null` for non-GPIO pins, and set `kind: 'gnd'` (renders `⏚`) or
`kind: 'power'` (lights up while connected, for 3V3/VIN/EN) so those still
display sensibly.

## What this does not do, and why

**It cannot see the value of an arbitrary pin just because your code exists
on the chip.** USB serial is a plain byte stream — the website only ever
receives what your firmware chooses to `Serial.print()`. There is no way for
a browser, or anything on the host PC, to read GPIO state directly over a
USB-serial link.

So the pin dashboard works like this: your sketch includes
[`firmware/pin_reporter.h`](firmware/pin_reporter.h), lists the pins you
care about, and calls one function in `loop()`. That function periodically
prints a single tagged line like:

```
<PR>{"t":48213,"pins":[{"pin":2,"type":"d","val":1,"label":"onboard_led"},{"pin":5,"type":"p","val":128,"label":"fan_pwm"}]}</PR>
```

The website looks for `<PR>...</PR>` on each line, parses the JSON, and
updates the dashboard — everything else in the stream (your own debug
prints) just shows up in the console untouched.

**This also does not flash arbitrary `.ino`/PlatformIO projects from the
browser.** A browser can't compile Arduino/ESP-IDF C++. You flash normally
(Arduino IDE / PlatformIO / `arduino-cli`); this website only *talks* to the
board afterwards over the same USB-serial connection.

**The two LED indicators next to the chip are not both real readings.**
- `D2` (blue) is real — it mirrors whatever your firmware reports for
  GPIO2, the pin this board's onboard status LED is wired to.
- `LINK` (red) is **not** a real power reading — the board's actual power
  LED is hardwired straight to the 3.3V rail, which the browser has no way
  to read over serial. `LINK` instead reflects whether the Web Serial
  connection is currently open, as the closest available proxy. Same idea
  for the small dots next to the 3V3/VIN/EN pins — they light up while
  connected, not because anything measured actual voltage there.

## Pin caveats (the **i** badges)

- **Input-only** (GPIO 34/35/36/39): these have no output driver and no
  internal pull-up/down on the ESP32 silicon itself — fine to read, don't
  try to drive them as outputs.
- **Flash-reserved** (GPIO 6–11): wired internally to the module's SPI
  flash chip on a standard ESP32-WROOM-32. Using these as general-purpose
  GPIO will interfere with the chip reading its own program and will likely
  crash or fail to boot. They're flagged, not hidden, in case your specific
  board exposes them for another reason — but don't wire anything to them
  without knowing exactly why.

## Firmware side

1. Copy `firmware/pin_reporter.h` into your project:
   - **Arduino IDE**: same folder as your `.ino` (shows as a second tab).
   - **PlatformIO**: into `include/` (auto-added to the compiler's search
     path, so `#include "pin_reporter.h"` from `src/main.cpp` finds it).
2. Look at `firmware/example_sketch/example_sketch.ino` for the pattern:
   - `#include "pin_reporter.h"` and declare `PinReporter PinRep;`
   - list the pins you want visible, with a type per pin:
     - `PR_DIGITAL_IN` / `PR_DIGITAL_OUT` — reports 0/1 via `digitalRead()`
     - `PR_PWM` — reports 0–255 via `ledcRead()`. **API differs by ESP32
       Arduino core version**: core 3.x+ (current) uses
       `ledcAttach(pin, freq, resolution)` / `ledcWrite(pin, duty)`,
       addressed by pin. Older core 2.x uses channel-based
       `ledcSetup(channel, ...)` / `ledcAttachPin(pin, channel)` /
       `ledcWrite(channel, duty)` — if you're on that core, change
       `pin_reporter.h`'s `PR_PWM` case back to `ledcRead(p.ledcChannel)`.
     - `PR_ANALOG_IN` — reports the raw 0–4095 ADC reading via
       `analogRead()`
   - call `PinRep.begin(pins, count, intervalMs)` once in `setup()`
   - call `PinRep.loop()` once per `loop()` iteration
3. Flash normally, then **close your IDE's own serial monitor** before
   opening the website — only one program can hold the serial port at a
   time.
4. If the LED stops blinking right after you connect from the website: this
   is expected, not a bug. Opening a serial connection can toggle DTR/RTS
   lines through the board's auto-reset circuit, which can drop the chip
   into bootloader mode. Press the physical **EN**/RST button once after
   connecting to force it back into normal run mode.

## Website side

Files:

```
index.html   — page structure
style.css    — PCB/HUD styling (no external font dependency)
app.js       — Web Serial connect/read/write, board layout, graphing, staleness
```

Open the page, click **Connect device**, pick your board's port (look for
"USB Single Serial" or similar — not a Bluetooth or motherboard COM port),
match the baud rate to your sketch's `Serial.begin()` value (115200 by
default), and the diagram updates as soon as the first `<PR>` line arrives.

### Running locally

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Web Serial requires `localhost` or
HTTPS — it will not work opened directly as a `file://` path.

### Deploying to GitHub Pages

1. Push this folder to your repo.
2. Repo **Settings → Pages → Source**: deploy from the branch containing
   these files.
3. GitHub Pages serves over HTTPS automatically. Source: [enginyears.github.io/esp32-moniter](https://enginyears.github.io/esp32-moniter/)

## Browser support

Web Serial is Chromium-only: Chrome, Edge, Opera, Brave. Not available in
Firefox or Safari. The page shows a warning and disables the connect button
if it detects an unsupported browser.

## Extending it

- **More pins / different board**: edit `BOARD_TOP` / `BOARD_BOTTOM` — the
  fallback list below the diagram still catches anything not listed there,
  so nothing is ever lost even mid-edit.
- **Different stale/removal timing**: `STALE_MS` and `FALLBACK_REMOVE_MS`
  near the top of `app.js`.
- **One-click flashing**: add `esptool-js` and a precompiled `.bin` if you
  later want to flash from the page instead of your IDE.
