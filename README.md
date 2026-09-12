# Bench — live ESP32 pin monitor + serial console, in the browser

A static website that connects to an ESP32 over USB (via the [Web Serial
API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)) and
shows:

- a live dashboard of whichever pins your sketch tells it to report — digital
  0/1, PWM 0–255, or raw analog readings
- a normal serial monitor for everything else your sketch prints
- a box to send text back to the board

No server, no build step, no npm install. Open `index.html` (served over
HTTPS or from `localhost`) in Chrome or Edge and connect.

## What this does *not* do, and why

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
prints) just shows up in the console untouched. This also means the pin list
on the dashboard is **whatever your firmware reports**, not tied to a fixed
board layout — add or remove pins by editing the array in your sketch.

**This also does not flash arbitrary `.ino` files from the browser.** A
browser can't compile Arduino C++. You flash your sketch the normal way
(Arduino IDE / `arduino-cli` / PlatformIO); this website only *talks* to the
board afterwards over the same USB-serial connection. If you want one-click
flashing from the site later, that's a separate, addable piece (a
precompiled `.bin` + [`esptool-js`](https://github.com/espressif/esptool-js))
— it's not included here since you said you'll flash yourself.

## Firmware side

1. Copy `firmware/pin_reporter.h` into your sketch's folder (Arduino IDE
   will show it as a second tab).
2. Look at `firmware/example_sketch/example_sketch.ino` for the pattern:
   - `#include "pin_reporter.h"` and declare `PinReporter PinRep;`
   - list the pins you want visible, with a type per pin:
     - `PR_DIGITAL_IN` / `PR_DIGITAL_OUT` — reports 0/1 via `digitalRead()`
     - `PR_PWM` — reports 0–255 via `ledcRead()`; only meaningful if you're
       driving that pin with the ESP32 LEDC API (`ledcSetup` /
       `ledcAttachPin` / `ledcWrite`) — `analogWrite()`-style PWM has no
       readback path on ESP32
     - `PR_ANALOG_IN` — reports the raw 0–4095 ADC reading via `analogRead()`
   - call `PinRep.begin(pins, count, intervalMs)` once in `setup()`
   - call `PinRep.loop()` once per `loop()` iteration
3. Everything else in your sketch — including blinking the onboard LED — is
   untouched. As long as the LED pin is in your monitored-pins list, its
   state shows up on the dashboard the moment you toggle it.
4. Flash normally, keep the Serial Monitor in your IDE closed (only one
   program can hold the serial port at a time), then connect from the
   website instead.

## The board diagram

The dashboard draws an ESP32 as two pin header columns around a chip block,
with each pin's live value shown right next to it — the default layout
matches the common **38-pin ESP32 DevKit V1** ("DOIT" style) sold by most
generic shops. It's a best-effort default, not a guarantee it matches your
exact board: clone manufacturers vary slightly, especially around the flash
pins (D9/D10/D11) near the bottom of the left column.

To check or fix it:
- Look at the text printed directly on your board next to each pin (its
  silkscreen) and compare against `BOARD_LEFT` / `BOARD_RIGHT` near the top
  of `app.js`.
- If a label or position is wrong, edit those two arrays — each entry is
  `{ silk: 'label on your board', pin: <GPIO number> }` (use `pin: null`
  for power/ground pins, which never carry a value).
- Any pin your firmware reports that isn't in either array still isn't
  lost — it shows up in the **Other reported pins** list below the diagram,
  labeled with its raw GPIO number, so you can always see the value even
  before you've fixed the layout.

## Website side

Files:

```
index.html   — page structure
style.css    — instrument-panel styling
app.js       — Web Serial connect/read/write, line parsing, dashboard render
```

Nothing to configure. Open the page, click **Connect device**, pick your
board's port from the browser's picker, choose the matching baud rate (must
match the `Serial.begin()` value in your sketch — 115200 by default in the
example), and pin cards will appear as soon as the first `<PR>` line arrives.

### Running locally

Any static file server works, e.g.:

```bash
python3 -m http.server 8000
```

Then open `http://localhost:8000`. Web Serial requires either `localhost` or
HTTPS — it will not work opened directly as a `file://` path.

### Deploying to GitHub Pages

1. Push this folder to a GitHub repo.
2. Repo **Settings → Pages → Source**: deploy from the branch containing
   these files (root, or `/docs` if you move them there).
3. GitHub Pages serves over HTTPS automatically, so Web Serial will work
   once it's live.

## Browser support

Web Serial is currently Chromium-only: Chrome, Edge, Opera, Brave. It is not
available in Firefox or Safari. The page shows a warning banner and disables
the connect button if it detects an unsupported browser.

## Extending it

- **More pins / different board**: just edit the `monitoredPins` array in
  your sketch — the website adapts automatically, it doesn't hardcode a pin
  layout.
- **Arduino Uno/Nano support**: the same `<PR>` protocol works on classic
  AVR boards too — swap `ledcRead()` for tracking your own PWM duty variable
  (AVR has no LEDC readback), everything else in `pin_reporter.h` is
  portable Arduino API.
- **One-click flashing**: add `esptool-js` and a precompiled `.bin` to flash
  before connecting, if you later want that instead of flashing from your
  IDE.
