// Bench — ESP32 pin monitor
//
// Talks to an ESP32 board over Web Serial.
//
// Incoming lines containing:
//
//   <PR>{...}</PR>
//
// are treated as telemetry.
//
// Everything else is displayed in the serial console.
//
// The board diagram below matches the photographed 30-pin ESP32
// DevKit-style board.


/* ==========================================================
   BOARD LAYOUT
   ==========================================================

   Your photographed board is a 30-pin ESP32 board.

   SIDE 1:
   3V3
   GND
   D15
   D2
   D4
   RX2
   TX2
   D5
   D18
   D19
   D21
   RX0
   TX0
   D22
   D23

   SIDE 2:
   VIN
   GND
   D13
   D12
   D14
   D27
   D26
   D25
   D33
   D32
   D35
   D34
   VN
   VP
   EN

   ========================================================== */

const BOARD_TOP = [

  { silk: '3V3', pin: null },

  { silk: 'GND', pin: null },

  { silk: 'D15', pin: 15 },

  { silk: 'D2', pin: 2 },

  { silk: 'D4', pin: 4 },

  { silk: 'RX2', pin: 16 },

  { silk: 'TX2', pin: 17 },

  { silk: 'D5', pin: 5 },

  { silk: 'D18', pin: 18 },

  { silk: 'D19', pin: 19 },

  { silk: 'D21', pin: 21 },

  { silk: 'RX0', pin: 3 },

  { silk: 'TX0', pin: 1 },

  { silk: 'D22', pin: 22 },

  { silk: 'D23', pin: 23 },

];


const BOARD_BOTTOM = [

  { silk: 'VIN', pin: null },

  { silk: 'GND', pin: null },

  { silk: 'D13', pin: 13 },

  { silk: 'D12', pin: 12 },

  { silk: 'D14', pin: 14 },

  { silk: 'D27', pin: 27 },

  { silk: 'D26', pin: 26 },

  { silk: 'D25', pin: 25 },

  { silk: 'D33', pin: 33 },

  { silk: 'D32', pin: 32 },

  { silk: 'D35', pin: 35 },

  { silk: 'D34', pin: 34 },

  { silk: 'VN', pin: 39 },

  { silk: 'VP', pin: 36 },

  { silk: 'EN', pin: null },

];


// Blue onboard status LED.
// On the photographed board this is GPIO2.
const STATUS_LED_PIN = 2;


// Maximum number of history samples retained for each pin.
const HISTORY_LIMIT = 300;


// Graph displays the most recent 30 seconds.
const GRAPH_WINDOW_MS = 30000;


// ==========================================================
// DOM ELEMENTS
// ==========================================================

const els = {

  connectBtn:
    document.getElementById('connectBtn'),

  disconnectBtn:
    document.getElementById('disconnectBtn'),

  baudRate:
    document.getElementById('baudRate'),

  connDot:
    document.getElementById('connDot'),

  connLabel:
    document.getElementById('connLabel'),

  supportWarning:
    document.getElementById('supportWarning'),

  boardTop:
    document.getElementById('boardTop'),

  boardBottom:
    document.getElementById('boardBottom'),

  powerLed:
    document.getElementById('powerLed'),

  statusLed:
    document.getElementById('statusLed'),

  pinGrid:
    document.getElementById('pinGrid'),

  pinCount:
    document.getElementById('pinCount'),

  console:
    document.getElementById('console'),

  hideTelemetry:
    document.getElementById('hideTelemetry'),

  clearConsole:
    document.getElementById('clearConsole'),

  sendForm:
    document.getElementById('sendForm'),

  sendInput:
    document.getElementById('sendInput'),

  lineEnding:
    document.getElementById('lineEnding'),

  graphSvg:
    document.getElementById('graphSvg'),

  graphEmpty:
    document.getElementById('graphEmpty'),

  graphMeta:
    document.getElementById('graphMeta'),

};


// ==========================================================
// SERIAL / TELEMETRY STATE
// ==========================================================

const PR_OPEN = '<PR>';

const PR_CLOSE = '</PR>';


let port = null;

let reader = null;

let writer = null;

let readLoopPromise = null;

let keepReading = false;

let lineBuffer = '';


// GPIO -> board UI elements
const boardSlots = new Map();


// GPIO -> fallback card
const fallbackCards = new Map();


// GPIO -> historical readings
const pinHistory = new Map();


// GPIO -> latest metadata
const pinMeta = new Map();


// Currently selected graph pin
let selectedPin = null;


// ==========================================================
// TELEMETRY TYPES
// ==========================================================

const TYPE_INFO = {

  d: {
    unit: '',
    max: 1,
    name: 'Digital'
  },

  p: {
    unit: '/255',
    max: 255,
    name: 'PWM'
  },

  a: {
    unit: '/4095',
    max: 4095,
    name: 'Analog'
  },

};


// ==========================================================
// WEB SERIAL SUPPORT CHECK
// ==========================================================

if (!('serial' in navigator)) {

  els.supportWarning.hidden = false;

  els.connectBtn.disabled = true;

}


// ==========================================================
// BOARD CREATION
// ==========================================================

function buildBoardRow(container, entries) {

  for (const entry of entries) {

    const btn = document.createElement('button');

    btn.type = 'button';

    btn.className = 'board-pin';


    // ------------------------------------------------------
    // Current reading value
    // ------------------------------------------------------

    const value = document.createElement('span');

    value.className = 'board-pin__value';

    value.textContent =
      entry.pin === null ? '' : '–';


    // ------------------------------------------------------
    // Physical pin pad
    // ------------------------------------------------------

    const pad = document.createElement('span');

    pad.className = 'board-pin__pad';


    // ------------------------------------------------------
    // Silkscreen label
    // ------------------------------------------------------

    const silk = document.createElement('span');

    silk.className = 'board-pin__silk';

    silk.textContent = entry.silk;


    // ------------------------------------------------------
    // Information button
    //
    // This is the new ⓘ beside each GPIO.
    // ------------------------------------------------------

    let infoButton = null;


    if (entry.pin !== null) {

      infoButton = document.createElement('button');

      infoButton.type = 'button';

      infoButton.className = 'pin-info';

      infoButton.textContent = 'i';

      infoButton.setAttribute(
        'aria-label',
        `Information for GPIO ${entry.pin}`
      );


      // Prevent clicking the information button from
      // selecting the pin for the graph.
      infoButton.addEventListener(
        'click',
        (event) => {

          event.stopPropagation();

          showPinInfo(
            infoButton,
            entry.pin
          );

        }
      );


      // Hover information.
      infoButton.addEventListener(
        'mouseenter',
        () => {

          showPinInfo(
            infoButton,
            entry.pin
          );

        }
      );


      infoButton.addEventListener(
        'mouseleave',
        hidePinInfo
      );

    }


    // Add everything to the pin button.

    btn.append(
      value,
      pad,
      silk
    );


    if (infoButton) {

      btn.appendChild(infoButton);

    }


    container.appendChild(btn);


    // ------------------------------------------------------
    // Power / ground / EN pins are not GPIO telemetry pins.
    // ------------------------------------------------------

    if (entry.pin === null) {

      btn.disabled = true;

    }

    else {

      btn.addEventListener(
        'click',
        () => selectPin(entry.pin)
      );


      boardSlots.set(
        entry.pin,
        {
          valueEl: value,
          padEl: pad,
          rowEl: btn,
          infoEl: infoButton
        }
      );

    }

  }

}


// Build the two sides.

buildBoardRow(
  els.boardTop,
  BOARD_TOP
);

buildBoardRow(
  els.boardBottom,
  BOARD_BOTTOM
);


// ==========================================================
// PIN INFORMATION POPUP
// ==========================================================

let pinInfoPopup = null;


function createPinInfoPopup() {

  if (pinInfoPopup) {
    return pinInfoPopup;
  }


  pinInfoPopup = document.createElement('div');

  pinInfoPopup.className =
    'pin-info-popup';


  pinInfoPopup.setAttribute(
    'role',
    'tooltip'
  );


  document.body.appendChild(
    pinInfoPopup
  );


  return pinInfoPopup;

}


function showPinInfo(button, pin) {

  const popup = createPinInfoPopup();

  const meta =
    pinMeta.get(pin) || {};


  const type =
    TYPE_INFO[meta.type] ||
    TYPE_INFO.d;


  const label =
    meta.label ||
    `GPIO ${pin}`;


  const value =
    meta.value !== undefined
      ? meta.value
      : 'No reading yet';


  popup.innerHTML = `

    <div class="pin-info-popup__title">
      GPIO ${pin}
    </div>

    <div class="pin-info-popup__row">

      <span class="pin-info-popup__key">
        Label
      </span>

      <span class="pin-info-popup__value">
        ${escapeHtml(label)}
      </span>

    </div>

    <div class="pin-info-popup__row">

      <span class="pin-info-popup__key">
        Type
      </span>

      <span class="pin-info-popup__value">
        ${escapeHtml(type.name)}
      </span>

    </div>

    <div class="pin-info-popup__row">

      <span class="pin-info-popup__key">
        Reading
      </span>

      <span class="pin-info-popup__value">
        ${escapeHtml(String(value))}
      </span>

    </div>

  `;


  const rect =
    button.getBoundingClientRect();


  let left =
    rect.right + 8;


  let top =
    rect.top;


  // Keep the popup inside the screen.

  if (left + 230 > window.innerWidth) {

    left =
      rect.left - 238;

  }


  if (top + 140 > window.innerHeight) {

    top =
      window.innerHeight - 150;

  }


  popup.style.left =
    `${Math.max(8, left)}px`;

  popup.style.top =
    `${Math.max(8, top)}px`;


  popup.classList.add(
    'is-visible'
  );

}


function hidePinInfo() {

  if (!pinInfoPopup) {
    return;
  }

  pinInfoPopup.classList.remove(
    'is-visible'
  );

}


// ==========================================================
// CONNECT
// ==========================================================

els.connectBtn.addEventListener(
  'click',
  async () => {

    try {

      port =
        await navigator.serial.requestPort();


      await port.open({
        baudRate:
          Number(els.baudRate.value)
      });


      setConnected(true);


      logSystem(
        'Connected at ' +
        els.baudRate.value +
        ' baud.'
      );


      writer =
        port.writable.getWriter();


      keepReading = true;


      readLoopPromise =
        readLoop();

    }

    catch (err) {

      if (err.name !== 'NotFoundError') {

        logSystem(
          'Connection failed: ' +
          err.message
        );

      }

    }

  }
);


els.disconnectBtn.addEventListener(
  'click',
  () => disconnect()
);


// ==========================================================
// DISCONNECT
// ==========================================================

async function disconnect() {

  keepReading = false;


  try {

    if (reader) {

      await reader.cancel();

    }

  }

  catch (_) {}


  if (readLoopPromise) {

    await readLoopPromise
      .catch(() => {});

  }


  try {

    if (writer) {

      writer.releaseLock();

      writer = null;

    }


    if (port) {

      await port.close();

    }

  }

  catch (_) {}


  port = null;


  setConnected(false);


  logSystem(
    'Disconnected.'
  );

}


// ==========================================================
// CONNECTION UI
// ==========================================================

function setConnected(isConnected) {

  els.connDot.classList.toggle(
    'is-live',
    isConnected
  );


  els.connLabel.textContent =
    isConnected
      ? 'Connected'
      : 'Not connected';


  els.connectBtn.disabled =
    isConnected;


  els.disconnectBtn.disabled =
    !isConnected;


  els.baudRate.disabled =
    isConnected;


  /*
   * The real PWR LED is connected to the board's
   * power rail and cannot be read through Serial.
   *
   * Therefore the connection is used as the UI proxy.
   */

  els.powerLed.classList.toggle(
    'is-on',
    isConnected
  );


  if (!isConnected) {

    els.statusLed.classList.remove(
      'is-on'
    );

  }

}


// ==========================================================
// SERIAL READING
// ==========================================================

async function readLoop() {

  const textDecoder =
    new TextDecoderStream();


  const readableClosed =
    port.readable.pipeTo(
      textDecoder.writable
    );


  reader =
    textDecoder.readable.getReader();


  try {

    while (keepReading) {

      const {
        value,
        done
      } =
        await reader.read();


      if (done) {
        break;
      }


      if (value) {

        handleIncoming(value);

      }

    }

  }

  catch (err) {

    logSystem(
      'Read error: ' +
      err.message
    );

  }

  finally {

    reader.releaseLock();

    await readableClosed
      .catch(() => {});

  }

}


// ==========================================================
// SPLIT SERIAL STREAM INTO LINES
// ==========================================================

function handleIncoming(chunk) {

  lineBuffer += chunk;


  const lines =
    lineBuffer.split(/\r?\n/);


  lineBuffer =
    lines.pop();


  for (const line of lines) {

    if (line.length === 0) {
      continue;
    }


    processLine(line);

  }

}


// ==========================================================
// PROCESS ONE SERIAL LINE
// ==========================================================

function processLine(line) {

  const start =
    line.indexOf(PR_OPEN);


  const end =
    line.indexOf(PR_CLOSE);


  if (
    start !== -1 &&
    end !== -1 &&
    end > start
  ) {

    const jsonText =
      line.slice(
        start + PR_OPEN.length,
        end
      );


    try {

      const report =
        JSON.parse(jsonText);


      updateDashboard(report);


      if (!els.hideTelemetry.checked) {

        logLine(
          line,
          'telemetry'
        );

      }


      return;

    }

    catch (err) {

      // Invalid telemetry.
      // Show it normally in console.

    }

  }


  logLine(
    line,
    'received'
  );

}


// ==========================================================
// DASHBOARD UPDATE
// ==========================================================

function updateDashboard(report) {

  if (
    !report.pins ||
    !Array.isArray(report.pins)
  ) {

    return;

  }


  const now =
    Date.now();


  let matchedCount = 0;


  for (const p of report.pins) {

    recordHistory(
      p,
      now
    );


    // Store complete current metadata.

    pinMeta.set(
      p.pin,
      {
        label: p.label,
        type: p.type,
        value: p.val
      }
    );


    // Update the D2 status LED.

    if (
      p.pin === STATUS_LED_PIN
    ) {

      els.statusLed.classList.toggle(
        'is-on',
        p.val === 1
      );

    }


    // Look for the pin on the physical board.

    const slot =
      boardSlots.get(p.pin);


    if (slot) {

      matchedCount++;


      renderSlotValue(
        slot,
        p
      );

    }

    else {

      renderFallbackCard(
        p
      );

    }

  }


  els.pinCount.textContent =
    matchedCount +
    ' on diagram · ' +
    fallbackCards.size +
    ' other · ' +
    new Date().toLocaleTimeString();


  if (selectedPin !== null) {

    renderGraph();

  }

}


// ==========================================================
// HISTORY
// ==========================================================

function recordHistory(p, now) {

  let hist =
    pinHistory.get(p.pin);


  if (!hist) {

    hist = [];

    pinHistory.set(
      p.pin,
      hist
    );

  }


  hist.push({
    t: now,
    val: p.val
  });


  if (
    hist.length >
    HISTORY_LIMIT
  ) {

    hist.shift();

  }

}


// ==========================================================
// RENDER BOARD PIN
// ==========================================================

function renderSlotValue(slot, p) {

  slot.valueEl.textContent =
    p.val;


  const isHigh =
    p.type === 'd'
      ? p.val === 1
      : p.val > 0;


  slot.rowEl.classList.toggle(
    'board-pin--live',
    isHigh
  );


  slot.rowEl.classList.toggle(
    'board-pin--low',
    !isHigh
  );


  // Make the information icon cyan once
  // telemetry has been received.

  if (slot.infoEl) {

    slot.infoEl.classList.add(
      'has-data'
    );

  }

}


// ==========================================================
// FALLBACK CARD
// ==========================================================

function renderFallbackCard(p) {

  let card =
    fallbackCards.get(p.pin);


  if (!card) {

    if (
      fallbackCards.size === 0
    ) {

      els.pinGrid.innerHTML = '';

    }


    const el =
      document.createElement('div');


    el.className =
      'pin-card';


    el.innerHTML = `

      <div class="pin-card__label">
        ${escapeHtml(
          p.label ||
          ('GPIO ' + p.pin)
        )}
      </div>

      <div class="pin-card__gpio">
        GPIO${p.pin} ·
        ${typeName(p.type)}
      </div>

      <div class="pin-card__value">
        –
      </div>

    `;


    el.addEventListener(
      'click',
      () => selectPin(p.pin)
    );


    card = {

      el,

      valueEl:
        el.querySelector(
          '.pin-card__value'
        )

    };


    fallbackCards.set(
      p.pin,
      card
    );


    els.pinGrid.appendChild(
      el
    );

  }


  card.valueEl.textContent =
    p.val;

}


// ==========================================================
// TYPE NAME
// ==========================================================

function typeName(t) {

  if (t === 'd') {
    return 'digital';
  }

  if (t === 'p') {
    return 'pwm';
  }

  if (t === 'a') {
    return 'analog';
  }

  return t;

}


// ==========================================================
// HTML ESCAPE
// ==========================================================

function escapeHtml(str) {

  return String(str).replace(
    /[&<>"']/g,
    (c) => ({

      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'

    }[c])
  );

}


// ==========================================================
// PIN SELECTION
// ==========================================================

function selectPin(pin) {

  selectedPin =
    pin;


  for (
    const [gpio, slot]
    of boardSlots
  ) {

    slot.rowEl.classList.toggle(
      'board-pin--selected',
      gpio === pin
    );

  }


  for (
    const [gpio, card]
    of fallbackCards
  ) {

    card.el.classList.toggle(
      'pin-card--selected',
      gpio === pin
    );

  }


  renderGraph();

}


// ==========================================================
// GRAPH
// ==========================================================

function renderGraph() {

  const hist =
    pinHistory.get(
      selectedPin
    );


  const meta =
    pinMeta.get(
      selectedPin
    ) || {};


  const label =
    meta.label ||
    ('GPIO ' + selectedPin);


  if (
    !hist ||
    hist.length === 0
  ) {

    els.graphEmpty.hidden =
      false;

    els.graphSvg.innerHTML =
      '';

    els.graphMeta.textContent =
      label +
      ' · no data yet';

    return;

  }


  els.graphEmpty.hidden =
    true;


  const info =
    TYPE_INFO[meta.type] ||
    TYPE_INFO.d;


  const now =
    Date.now();


  const points =
    hist.filter(
      (s) =>
        now - s.t <=
        GRAPH_WINDOW_MS
    );


  const usable =
    points.length >= 2
      ? points
      : hist.slice(-2);


  const W = 480;

  const H = 200;

  const PAD = 8;


  const t0 =
    usable[0].t;


  const tSpan =
    Math.max(
      1,
      usable[
        usable.length - 1
      ].t - t0
    );


  const coords =
    usable.map(
      (s) => {

        const x =
          PAD +
          ((s.t - t0) /
            tSpan) *
          (W - PAD * 2);


        const y =
          H -
          PAD -
          (s.val /
            info.max) *
          (H - PAD * 2);


        return (
          x.toFixed(1) +
          ',' +
          y.toFixed(1)
        );

      }
    );


  const latest =
    usable[
      usable.length - 1
    ].val;


  els.graphMeta.textContent =
    label +
    ' · ' +
    latest +
    info.unit +
    ' · last ' +
    Math.round(
      Math.min(
        GRAPH_WINDOW_MS,
        now - t0
      ) / 1000
    ) +
    's';


  els.graphSvg.innerHTML = `

    <line
      class="graph-axis"
      x1="${PAD}"
      y1="${H - PAD}"
      x2="${W - PAD}"
      y2="${H - PAD}"
    />

    <line
      class="graph-axis"
      x1="${PAD}"
      y1="${PAD}"
      x2="${PAD}"
      y2="${H - PAD}"
    />

    <polyline
      class="graph-line"
      points="${coords.join(' ')}"
    />

  `;

}


// ==========================================================
// CONSOLE
// ==========================================================

function logLine(text, kind) {

  const div =
    document.createElement('div');


  div.className =
    'console__line' +
    (
      kind === 'telemetry'
        ? ' console__line--telemetry'
        : ''
    );


  div.textContent =
    text;


  appendConsole(div);

}


function logSystem(text) {

  const div =
    document.createElement('div');


  div.className =
    'console__line console__line--system';


  div.textContent =
    text;


  appendConsole(div);

}


function logSent(text) {

  const div =
    document.createElement('div');


  div.className =
    'console__line console__line--sent';


  div.textContent =
    text;


  appendConsole(div);

}


function appendConsole(div) {

  const atBottom =
    els.console.scrollHeight -
    els.console.scrollTop -
    els.console.clientHeight <
    40;


  els.console.appendChild(
    div
  );


  if (atBottom) {

    els.console.scrollTop =
      els.console.scrollHeight;

  }

}


// ==========================================================
// CLEAR CONSOLE
// ==========================================================

els.clearConsole.addEventListener(
  'click',
  () => {

    els.console.innerHTML =
      '';

  }
);


// ==========================================================
// SEND TO ESP32
// ==========================================================

els.sendForm.addEventListener(
  'submit',
  async (e) => {

    e.preventDefault();


    const text =
      els.sendInput.value;


    if (
      !text ||
      !writer
    ) {

      return;

    }


    const ending =
      els.lineEnding.value === '\\n'
        ? '\n'
        : els.lineEnding.value === '\\r\\n'
          ? '\r\n'
          : '';


    const bytes =
      new TextEncoder().encode(
        text + ending
      );


    try {

      await writer.write(
        bytes
      );


      logSent(
        text
      );


      els.sendInput.value =
        '';

    }

    catch (err) {

      logSystem(
        'Send failed: ' +
        err.message
      );

    }

  }
);
