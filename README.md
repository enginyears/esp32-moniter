# Bench — live ESP32 pin monitor + serial console, in the browser

A static website that connects to an ESP32 over USB (via the [Web Serial
API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Serial_API)) and
shows a board diagram with live pin values, a serial monitor, and a
click-to-graph pin history — no server, no build step, no external
dependencies (works fully offline once loaded).

Live site: https://enginyears.github.io/esp32-moniter/

## Board layout — confirmed against your actual board

Read directly off a clear photo of your board: a 30-pin ESP32-WROOM-32
DevKit, 15 pins per side. This variant keeps GPIO16/17 (`RX2`/`TX2`) but
doesn't break out the flash pins (GPIO9/10/11) at all — that's the actual
difference from the 38-pin variant, not just a smaller header count.

If you ever swap to a different board, edit `BOARD_LEFT` / `BOARD_RIGHT` in
`app.js`. Each entry:

```js
{ silk: 'label on your board', pin: <GPIO or null>, kind?: 'gnd'|'power', uart?: true }
```

## Legend

- **⏚** — ground pin
- **⚡** — power pin (3V3 / VIN / EN); lights up while connected as an
  inferred "powered" indicator, not a real voltage measurement
- **⇄** — UART pin (fixed hardware assignment: TX0/RX0 = UART0, TX2/RX2 = UART2)
- **∿** — shown next to a pin's value while your firmware is currently
  reporting it as PWM
- **⛔** — avoid using as GPIO (wired to the module's internal SPI flash)

The small circled **i** on GPIO34/35/36/39 (input-only, no output driver, no
internal pull-up/down) isn't in the legend — hover it on the pin itself for
the explanation.

## What this does not do, and why

**It cannot see the value of an arbitrary pin just because your code exists
on the chip.** USB serial is a plain byte stream — the site only ever
receives what your firmware chooses to `Serial.print()`. Your sketch
includes [`pin_reporter.h`](pin_reporter.h), lists the
pins you care about, and calls one function in `loop()` that periodically
prints a tagged line:

```
<PR>{"t":48213,"pins":[{"pin":2,"type":"d","val":1,"label":"onboard_led"}]}</PR>
```

The site parses `<PR>...</PR>` lines and updates the dashboard; everything
else in the stream (your own debug prints) shows up in the console
untouched. Any reported pin not on the diagram appears as a small inline
"Other signals" chip under the legend instead of a full card — click it to
graph it too.

**This does not flash arbitrary `.ino`/PlatformIO projects from the
browser** — a browser can't compile C++. Flash normally, then connect from
here afterwards over the same USB-serial link.

**`LINK` (red) is not a real power reading.** The board's actual power LED
is hardwired to 3.3V, unreadable over serial. `LINK` reflects whether the
Web Serial connection is open, as the closest available proxy. `D2` (blue)
*is* real — it mirrors GPIO2's live state from your firmware.

**Disconnecting now blanks every value on screen** — previously a value
could sit on screen showing stale data after disconnect; `resetLiveValues()`
clears the dashboard, LEDs, and "other signals" list every time the
connection drops (including an unexpected unplug).

**The `EN` / `BOOT` buttons drawn on the diagram are not clickable** — they
represent the buttons on the physical board so the diagram reads correctly;
pressing them only works with your fingers, not the mouse.

## Firmware side

1. Copy `firmware/pin_reporter.h` into your project (Arduino IDE: same
   folder as your `.ino`; PlatformIO: into `include/`).
2. See `firmware/example_sketch/example_sketch.ino` for the pattern —
   `PR_DIGITAL_IN`/`PR_DIGITAL_OUT` (0/1 via `digitalRead()`), `PR_PWM`
   (0–255 via `ledcRead()` — **core 3.x+ uses `ledcAttach(pin,...)` /
   `ledcWrite(pin,...)`, addressed by pin; older core 2.x uses
   channel-based `ledcSetup`/`ledcAttachPin`/`ledcWrite(channel,...)`,
   in which case revert `pin_reporter.h`'s `PR_PWM` case to
   `ledcRead(p.ledcChannel)`), or `PR_ANALOG_IN` (0–4095 via `analogRead()`).
   Call `PinRep.begin(pins, count, intervalMs)` once in `setup()` and
   `PinRep.loop()` once per `loop()`.
3. Close your IDE's own serial monitor before connecting from the website —
   only one program can hold the port at a time.
4. If the LED stops blinking right after connecting: expected, not a bug —
   opening the serial connection can toggle DTR/RTS through the board's
   auto-reset circuit and drop it into bootloader mode. Press the physical
   **EN** button once to force it back into normal run mode.

## Website side

```
index.html   — page structure
style.css    — PCB/HUD styling, no external font dependency
app.js       — Web Serial connect/read/write, board layout, graphing, staleness
```

Open, **Connect device**, pick the port labeled something like "USB Single
Serial" (not a Bluetooth or motherboard COM port), match the baud rate to
your sketch, done.

### Running locally

```bash
python3 -m http.server 8000
```
Open `http://localhost:8000` — Web Serial needs `localhost` or HTTPS, not `file://`.

### Deploying to GitHub Pages

Push to your repo, enable Pages in **Settings → Pages**, done — Pages
serves HTTPS automatically.

## Browser support

Web Serial is Chromium-only (Chrome, Edge, Opera, Brave) — not Firefox or
Safari. The page warns and disables the connect button if unsupported.

## Suggested next features

**Must-have, if you're going to rely on this day to day:**
- **Auto-reconnect** to the last-used port on page load (Web Serial exposes
  already-granted ports via `navigator.serial.getPorts()`), so you're not
  re-picking the device every refresh.
- **Export history** — a "download CSV" button for the currently graphed
  pin's buffered samples, since the in-memory history disappears on refresh.
- **Multiple pins on one graph at once** — right now it's one pin at a
  time; overlaying two or three (e.g. a button and the LED it drives) would
  make cause/effect a lot easier to read.
- **A visible warning when two pins' report intervals imply the firmware is
  flooding the serial line** (e.g. reporting >20 pins at 10ms) — right now
  a misconfigured `intervalMs` just quietly saturates the port.

**Nice-to-have:**
- **Persist the legend/board choice** in `localStorage` so returning users
  don't need to re-check anything (not needed for the pin data itself,
  which should stay live-only).
- **A "record" toggle** that keeps the full session log downloadable as
  `.txt`, separate from the scrollback buffer.
- **Command presets** — buttons for a few frequently sent serial strings
  instead of retyping them in the send box each time.
- **Dark/light theme toggle**, if you ever demo this somewhere brightly lit.

**On multi-board support later:** the cleanest path when you get there is a
`BOARD_PROFILES` object (one entry per board: its `left`/`right` pin
arrays, `statusLedPin`, `inputOnlyPins`, `flashReservedPins`) with a
dropdown that swaps which profile `app.js` builds from — the rest of the
app (telemetry parsing, graphing, staleness) doesn't need to change at all,
since none of it assumes a specific board today.
