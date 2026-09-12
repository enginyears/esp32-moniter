// Bench — talks to a board over Web Serial, splits incoming text into lines,
// and treats any line matching <PR>{...}</PR> as pin telemetry (see
// firmware/pin_reporter.h). Everything else is just shown in the console.

// ---------------------------------------------------------------------------
// Board layout — best-effort reading of the photographed board's silkscreen.
// NOT independently confirmed against your exact board (a 30-pin vs 38-pin
// mismatch was flagged and unresolved as of this version) — verify against
// your board and edit these arrays if anything is off. Each entry:
//   { silk: 'label on your board', pin: GPIO number or null, kind?: 'gnd'|'power' }
// `kind` only applies to null-pin (non-GPIO) entries.
// ---------------------------------------------------------------------------

const BOARD_TOP = [
  { silk: '3V3', pin: null, kind: 'power' },
  { silk: 'D23', pin: 23 },
  { silk: 'D22', pin: 22 },
  { silk: 'TX0', pin: 1 },
  { silk: 'RX0', pin: 3 },
  { silk: 'D19', pin: 19 },
  { silk: 'D18', pin: 18 },
  { silk: 'D5',  pin: 5 },
  { silk: 'TX2', pin: 17 },
  { silk: 'RX2', pin: 16 },
  { silk: 'D4',  pin: 4 },
  { silk: 'D2',  pin: 2 },
  { silk: 'D15', pin: 15 },
  { silk: 'GND', pin: null, kind: 'gnd' },
];

const BOARD_BOTTOM = [
  { silk: 'VIN', pin: null, kind: 'power' },
  { silk: 'EN',  pin: null, kind: 'power' },
  { silk: 'VP',  pin: 36 },
  { silk: 'VN',  pin: 39 },
  { silk: 'D34', pin: 34 },
  { silk: 'D35', pin: 35 },
  { silk: 'D32', pin: 32 },
  { silk: 'D33', pin: 33 },
  { silk: 'D25', pin: 25 },
  { silk: 'D26', pin: 26 },
  { silk: 'D27', pin: 27 },
  { silk: 'D14', pin: 14 },
  { silk: 'D12', pin: 12 },
  { silk: 'D13', pin: 13 },
  { silk: 'D9',  pin: 9 },
  { silk: 'D10', pin: 10 },
  { silk: 'D11', pin: 11 },
  { silk: 'GND', pin: null, kind: 'gnd' },
];

// The blue status LED on this board is wired to GPIO2. Change if yours differs.
const STATUS_LED_PIN = 2;

// ADC1-only pins with no output driver and no internal pull-up/down.
const INPUT_ONLY_PINS = new Set([34, 35, 36, 39]);
// Connected to the module's internal SPI flash on a standard WROOM-32 — don't use as GPIO.
const FLASH_RESERVED_PINS = new Set([6, 7, 8, 9, 10, 11]);

const HISTORY_LIMIT = 300;          // samples kept per pin
const GRAPH_WINDOW_MS = 30000;      // graph window shown
const STALE_MS = 4000;              // board pin dims after this long with no update
const FALLBACK_REMOVE_MS = 15000;   // fallback card removed after this long with no update

const els = {
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  baudRate: document.getElementById('baudRate'),
  connDot: document.getElementById('connDot'),
  connLabel: document.getElementById('connLabel'),
  supportWarning: document.getElementById('supportWarning'),
  boardTop: document.getElementById('boardTop'),
  boardBottom: document.getElementById('boardBottom'),
  linkLed: document.getElementById('linkLed'),
  statusLed: document.getElementById('statusLed'),
  pinGrid: document.getElementById('pinGrid'),
  pinCount: document.getElementById('pinCount'),
  console: document.getElementById('console'),
  hideTelemetry: document.getElementById('hideTelemetry'),
  clearConsole: document.getElementById('clearConsole'),
  sendForm: document.getElementById('sendForm'),
  sendInput: document.getElementById('sendInput'),
  lineEnding: document.getElementById('lineEnding'),
  graphSvg: document.getElementById('graphSvg'),
  graphEmpty: document.getElementById('graphEmpty'),
  graphMeta: document.getElementById('graphMeta'),
};

const PR_OPEN = '<PR>';
const PR_CLOSE = '</PR>';

let port = null;
let reader = null;
let writer = null;
let readLoopPromise = null;
let keepReading = false;
let userInitiatedDisconnect = false;
let lineBuffer = '';

const boardSlots = new Map();    // gpio -> { valueEl, padEl, rowEl }
const fallbackCards = new Map(); // gpio -> card elements
const pinHistory = new Map();    // gpio -> [{t, val}]
const pinMeta = new Map();       // gpio -> { label, type }
const lastSeen = new Map();      // gpio -> timestamp
const powerPinEls = [];          // pad elements for 3V3/VIN/EN, lit while connected
let selectedPin = null;

const TYPE_INFO = {
  d: { unit: '', max: 1 },
  p: { unit: '/255', max: 255 },
  a: { unit: '/4095', max: 4095 },
};

// ---------------------------------------------------------------------------
// Feature detection
// ---------------------------------------------------------------------------

if (!('serial' in navigator)) {
  els.supportWarning.hidden = false;
  els.connectBtn.disabled = true;
}

// ---------------------------------------------------------------------------
// Build the static board diagram once
// ---------------------------------------------------------------------------

function pinFlagInfo(pin) {
  if (INPUT_ONLY_PINS.has(pin)) {
    return 'Input-only: no output driver, no internal pull-up/down on this pin.';
  }
  if (FLASH_RESERVED_PINS.has(pin)) {
    return 'Connected to the module\u2019s internal SPI flash \u2014 avoid using as general GPIO.';
  }
  return null;
}

function buildBoardRow(container, entries) {
  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'board-pin';

    const value = document.createElement('span');
    value.className = 'board-pin__value';

    const pad = document.createElement('span');
    pad.className = 'board-pin__pad';

    const silk = document.createElement('span');
    silk.className = 'board-pin__silk';
    silk.textContent = entry.silk;

    btn.append(value, pad, silk);

    if (entry.pin === null) {
      btn.disabled = true;
      if (entry.kind === 'gnd') {
        btn.classList.add('board-pin--gnd');
        value.textContent = '\u23DA'; // ⏚ ground symbol
      } else if (entry.kind === 'power') {
        btn.classList.add('board-pin--power');
        value.textContent = '';
        powerPinEls.push(pad);
      }
    } else {
      value.textContent = '\u2013';
      btn.addEventListener('click', () => selectPin(entry.pin));
      boardSlots.set(entry.pin, { valueEl: value, padEl: pad, rowEl: btn });

      const flagText = pinFlagInfo(entry.pin);
      if (flagText) {
        const flag = document.createElement('span');
        flag.className = 'pin-flag';
        flag.textContent = 'i';
        flag.title = flagText;
        btn.appendChild(flag);
      }
    }

    container.appendChild(btn);
  }
}

buildBoardRow(els.boardTop, BOARD_TOP);
buildBoardRow(els.boardBottom, BOARD_BOTTOM);

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

els.connectBtn.addEventListener('click', async () => {
  els.connectBtn.disabled = true;
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: Number(els.baudRate.value) });

    userInitiatedDisconnect = false;
    setConnected(true);
    logSystem('Connected at ' + els.baudRate.value + ' baud.');

    writer = port.writable.getWriter();
    keepReading = true;
    readLoopPromise = readLoop();
  } catch (err) {
    setConnected(false);
    if (err.name !== 'NotFoundError') {
      logSystem('Connection failed: ' + err.message);
    }
  }
});

els.disconnectBtn.addEventListener('click', async () => {
  userInitiatedDisconnect = true;
  await teardown('Disconnected.');
});

// Catches a physical unplug even if nothing in our own read/write path errors first.
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (port && e.target === port) {
      userInitiatedDisconnect = true; // nothing left to gracefully close on our end
      teardown('Device unplugged.');
    }
  });
}

async function teardown(reason) {
  keepReading = false;
  try { if (reader) await reader.cancel(); } catch (_) {}
  if (readLoopPromise) await readLoopPromise.catch(() => {});
  try { if (writer) writer.releaseLock(); } catch (_) {}
  writer = null;
  try { if (port) await port.close(); } catch (_) {}
  port = null;
  setConnected(false);
  if (reason) logSystem(reason);
}

function setConnected(isConnected) {
  els.connDot.classList.toggle('is-live', isConnected);
  els.connLabel.textContent = isConnected ? 'Connected' : 'Not connected';
  els.connectBtn.disabled = isConnected;
  els.disconnectBtn.disabled = !isConnected;
  els.baudRate.disabled = isConnected;
  els.linkLed.classList.toggle('is-on', isConnected);
  if (!isConnected) els.statusLed.classList.remove('is-on');
  for (const pad of powerPinEls) {
    pad.parentElement.classList.toggle('is-powered', isConnected);
  }
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

async function readLoop() {
  const textDecoder = new TextDecoderStream();
  const readableClosed = port.readable.pipeTo(textDecoder.writable);
  reader = textDecoder.readable.getReader();

  try {
    while (keepReading) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) handleIncoming(value);
    }
  } catch (err) {
    // Read errors usually mean the device went away mid-session.
    if (!userInitiatedDisconnect) {
      queueMicrotask(() => teardown('Device disconnected unexpectedly.'));
    }
  } finally {
    try { reader.releaseLock(); } catch (_) {}
    await readableClosed.catch(() => {});
  }
}

function handleIncoming(chunk) {
  lineBuffer += chunk;
  const lines = lineBuffer.split(/\r?\n/);
  lineBuffer = lines.pop();
  for (const line of lines) {
    if (line.length === 0) continue;
    processLine(line);
  }
}

function processLine(line) {
  const start = line.indexOf(PR_OPEN);
  const end = line.indexOf(PR_CLOSE);

  if (start !== -1 && end !== -1 && end > start) {
    const jsonText = line.slice(start + PR_OPEN.length, end);
    try {
      const report = JSON.parse(jsonText);
      updateDashboard(report);
      if (!els.hideTelemetry.checked) logLine(line, 'telemetry');
      return;
    } catch (err) {
      // fall through, print as-is
    }
  }

  logLine(line, 'received');
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

function updateDashboard(report) {
  if (!report.pins || !Array.isArray(report.pins)) return;
  const now = Date.now();
  let matchedCount = 0;

  for (const p of report.pins) {
    lastSeen.set(p.pin, now);
    recordHistory(p, now);
    pinMeta.set(p.pin, { label: p.label, type: p.type });

    if (p.pin === STATUS_LED_PIN) {
      els.statusLed.classList.toggle('is-on', p.val === 1);
    }

    const slot = boardSlots.get(p.pin);
    if (slot) {
      matchedCount++;
      renderSlotValue(slot, p);
    } else {
      renderFallbackCard(p, now);
    }
  }

  els.pinCount.textContent = matchedCount + ' on diagram · ' + fallbackCards.size +
    ' other · ' + new Date().toLocaleTimeString();

  if (selectedPin !== null) renderGraph();
}

function recordHistory(p, now) {
  let hist = pinHistory.get(p.pin);
  if (!hist) {
    hist = [];
    pinHistory.set(p.pin, hist);
  }
  hist.push({ t: now, val: p.val });
  if (hist.length > HISTORY_LIMIT) hist.shift();
}

function renderSlotValue(slot, p) {
  slot.valueEl.textContent = p.val;
  slot.rowEl.classList.remove('board-pin--stale');
  const isHigh = p.type === 'd' ? p.val === 1 : p.val > 0;
  slot.rowEl.classList.toggle('board-pin--live', isHigh);
  slot.rowEl.classList.toggle('board-pin--low', !isHigh);
}

function renderFallbackCard(p, now) {
  let card = fallbackCards.get(p.pin);
  if (!card) {
    if (fallbackCards.size === 0) els.pinGrid.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'pin-card';

    const flagText = pinFlagInfo(p.pin);
    el.innerHTML = `
      <div class="pin-card__label">${escapeHtml(p.label || ('GPIO ' + p.pin))}${flagText ? ' <span class="pin-flag pin-flag--inline" title="' + escapeHtml(flagText) + '">i</span>' : ''}</div>
      <div class="pin-card__gpio">GPIO${p.pin} · ${typeName(p.type)}</div>
      <div class="pin-card__value">–</div>
    `;
    el.addEventListener('click', () => selectPin(p.pin));
    card = { el, valueEl: el.querySelector('.pin-card__value') };
    fallbackCards.set(p.pin, card);
    els.pinGrid.appendChild(el);
  }
  card.valueEl.textContent = p.val;
  card.el.classList.remove('pin-card--stale');
}

function typeName(t) {
  if (t === 'd') return 'digital';
  if (t === 'p') return 'pwm';
  if (t === 'a') return 'analog';
  return t;
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

// ---------------------------------------------------------------------------
// Staleness sweep — dims silent board pins, removes long-silent fallback cards
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();

  for (const [gpio, slot] of boardSlots) {
    const seen = lastSeen.get(gpio);
    if (seen && now - seen > STALE_MS) {
      slot.rowEl.classList.add('board-pin--stale');
    }
  }

  for (const [gpio, card] of fallbackCards) {
    const seen = lastSeen.get(gpio) || 0;
    if (now - seen > FALLBACK_REMOVE_MS) {
      card.el.remove();
      fallbackCards.delete(gpio);
    } else if (now - seen > STALE_MS) {
      card.el.classList.add('pin-card--stale');
    }
  }
}, 1000);

// ---------------------------------------------------------------------------
// Pin selection + graph
// ---------------------------------------------------------------------------

function selectPin(pin) {
  selectedPin = pin;

  for (const [gpio, slot] of boardSlots) {
    slot.rowEl.classList.toggle('board-pin--selected', gpio === pin);
  }
  for (const [gpio, card] of fallbackCards) {
    card.el.classList.toggle('pin-card--selected', gpio === pin);
  }

  renderGraph();
}

function renderGraph() {
  const hist = pinHistory.get(selectedPin);
  const meta = pinMeta.get(selectedPin) || {};
  const label = meta.label || ('GPIO ' + selectedPin);

  if (!hist || hist.length === 0) {
    els.graphEmpty.hidden = false;
    els.graphSvg.innerHTML = '';
    els.graphMeta.textContent = label + ' · no data yet';
    return;
  }

  els.graphEmpty.hidden = true;
  const info = TYPE_INFO[meta.type] || TYPE_INFO.d;
  const now = Date.now();
  const points = hist.filter((s) => now - s.t <= GRAPH_WINDOW_MS);
  const usable = points.length >= 2 ? points : hist.slice(-2);

  const W = 480, H = 200, PAD = 8;
  const t0 = usable[0].t;
  const tSpan = Math.max(1, (usable[usable.length - 1].t - t0));

  const toXY = (s) => {
    const x = PAD + ((s.t - t0) / tSpan) * (W - PAD * 2);
    const y = H - PAD - (s.val / info.max) * (H - PAD * 2);
    return [x, y];
  };

  let pathD;
  if (meta.type === 'd') {
    // Step trace: hold the previous value until the instant it changes.
    let [x0, y0] = toXY(usable[0]);
    pathD = `M ${x0.toFixed(1)} ${y0.toFixed(1)}`;
    for (let i = 1; i < usable.length; i++) {
      const [x1, y1] = toXY(usable[i]);
      pathD += ` L ${x1.toFixed(1)} ${y0.toFixed(1)} L ${x1.toFixed(1)} ${y1.toFixed(1)}`;
      y0 = y1;
    }
  } else {
    pathD = usable.map((s, i) => {
      const [x, y] = toXY(s);
      return (i === 0 ? 'M ' : 'L ') + x.toFixed(1) + ' ' + y.toFixed(1);
    }).join(' ');
  }

  const latest = usable[usable.length - 1].val;
  els.graphMeta.textContent = label + ' · ' + latest + info.unit + ' · last ' +
    Math.round(Math.min(GRAPH_WINDOW_MS, now - t0) / 1000) + 's';

  els.graphSvg.innerHTML = `
    <line class="graph-axis" x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" />
    <line class="graph-axis" x1="${PAD}" y1="${PAD}" x2="${PAD}" y2="${H - PAD}" />
    <path class="graph-line" d="${pathD}" />
  `;
}

// ---------------------------------------------------------------------------
// Console
// ---------------------------------------------------------------------------

function logLine(text, kind) {
  const div = document.createElement('div');
  div.className = 'console__line' + (kind === 'telemetry' ? ' console__line--telemetry' : '');
  div.textContent = text;
  appendConsole(div);
}

function logSystem(text) {
  const div = document.createElement('div');
  div.className = 'console__line console__line--system';
  div.textContent = text;
  appendConsole(div);
}

function logSent(text) {
  const div = document.createElement('div');
  div.className = 'console__line console__line--sent';
  div.textContent = text;
  appendConsole(div);
}

function appendConsole(div) {
  const atBottom = els.console.scrollHeight - els.console.scrollTop - els.console.clientHeight < 40;
  els.console.appendChild(div);
  if (atBottom) els.console.scrollTop = els.console.scrollHeight;
}

els.clearConsole.addEventListener('click', () => {
  els.console.innerHTML = '';
});

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

els.sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.sendInput.value;
  if (!text || !writer) return;

  const ending = els.lineEnding.value === '\\n' ? '\n'
    : els.lineEnding.value === '\\r\\n' ? '\r\n'
    : '';
  const bytes = new TextEncoder().encode(text + ending);

  try {
    await writer.write(bytes);
    logSent(text);
    els.sendInput.value = '';
  } catch (err) {
    logSystem('Send failed: ' + err.message);
    if (!userInitiatedDisconnect) teardown('Device disconnected unexpectedly.');
  }
});
