// Bench — talks to a board over Web Serial, splits incoming text into lines,
// and treats any line matching <PR>{...}</PR> as pin telemetry (see
// firmware/pin_reporter.h). Everything else is just shown in the console.

// ---------------------------------------------------------------------------
// Board layout — read directly off a clear photo of the actual board (30-pin
// ESP32-WROOM-32 DevKit: 15 pins per side, no D9/D10/D11 flash pins broken
// out, but D16/D17 present as RX2/TX2). If yours differs, edit these arrays.
// Each entry: { silk, pin: GPIO or null, kind?: 'gnd'|'power', uart?: true }
// ---------------------------------------------------------------------------

const BOARD_LEFT = [
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
  { silk: 'GND', pin: null, kind: 'gnd' },
  { silk: 'VIN', pin: null, kind: 'power' },
];

const BOARD_RIGHT = [
  { silk: 'D23', pin: 23 },
  { silk: 'D22', pin: 22 },
  { silk: 'TX0', pin: 1,  uart: true },
  { silk: 'RX0', pin: 3,  uart: true },
  { silk: 'D21', pin: 21 },
  { silk: 'D19', pin: 19 },
  { silk: 'D18', pin: 18 },
  { silk: 'D5',  pin: 5 },
  { silk: 'TX2', pin: 17, uart: true },
  { silk: 'RX2', pin: 16, uart: true },
  { silk: 'D4',  pin: 4 },
  { silk: 'D2',  pin: 2 },
  { silk: 'D15', pin: 15 },
  { silk: 'GND', pin: null, kind: 'gnd' },
  { silk: '3V3', pin: null, kind: 'power' },
];

const STATUS_LED_PIN = 2;
const INPUT_ONLY_PINS = new Set([34, 35, 36, 39]);
const FLASH_RESERVED_PINS = new Set([6, 7, 8, 9, 10, 11]); // not exposed on this board's headers, kept for completeness

const HISTORY_LIMIT = 300;
const GRAPH_WINDOW_MS = 30000;
const STALE_MS = 4000;
const OTHER_REMOVE_MS = 15000;

const els = {
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  baudRate: document.getElementById('baudRate'),
  connDot: document.getElementById('connDot'),
  connLabel: document.getElementById('connLabel'),
  supportWarning: document.getElementById('supportWarning'),
  boardLeft: document.getElementById('boardLeft'),
  boardRight: document.getElementById('boardRight'),
  linkLed: document.getElementById('linkLed'),
  statusLed: document.getElementById('statusLed'),
  otherSignals: document.getElementById('otherSignals'),
  otherSignalsList: document.getElementById('otherSignalsList'),
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
const otherChips = new Map();    // gpio -> chip element
const pinHistory = new Map();    // gpio -> [{t, val}]
const pinMeta = new Map();       // gpio -> { label, type }
const lastSeen = new Map();      // gpio -> timestamp
const powerPinEls = [];
let selectedPin = null;

const TYPE_INFO = {
  d: { unit: '', max: 1 },
  p: { unit: '/255', max: 255 },
  a: { unit: '/4095', max: 4095 },
};

if (!('serial' in navigator)) {
  els.supportWarning.hidden = false;
  els.connectBtn.disabled = true;
}

// ---------------------------------------------------------------------------
// Build the static board diagram once
// ---------------------------------------------------------------------------

function pinFlagInfo(pin) {
  if (INPUT_ONLY_PINS.has(pin)) {
    return { icon: 'i', warn: false, text: 'Input-only: no output driver, no internal pull-up/down.' };
  }
  if (FLASH_RESERVED_PINS.has(pin)) {
    return { icon: '\u26D4', warn: true, text: 'Connected to the module\u2019s internal SPI flash \u2014 avoid using as GPIO.' };
  }
  return null;
}

function buildBoardCol(container, entries, side) {
  for (const entry of entries) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'board-pin';

    const silk = document.createElement('span');
    silk.className = 'board-pin__silk';
    silk.textContent = entry.silk;
    if (entry.uart) {
      const icon = document.createElement('span');
      icon.className = 'pin-icon pin-icon--uart';
      icon.textContent = '\u21C4 ';
      silk.prepend(icon);
    }

    const pad = document.createElement('span');
    pad.className = 'board-pin__pad';

    const value = document.createElement('span');
    value.className = 'board-pin__value';

    if (side === 'left') btn.append(silk, pad, value);
    else btn.append(value, pad, silk);

    if (entry.pin === null) {
      btn.disabled = true;
      if (entry.kind === 'gnd') {
        btn.classList.add('board-pin--gnd');
        value.textContent = '\u23DA';
      } else if (entry.kind === 'power') {
        btn.classList.add('board-pin--power');
        value.textContent = '';
        powerPinEls.push(pad);
      }
    } else {
      value.textContent = '\u2013';
      btn.addEventListener('click', () => selectPin(entry.pin));
      boardSlots.set(entry.pin, { valueEl: value, padEl: pad, rowEl: btn, type: null });

      const flag = pinFlagInfo(entry.pin);
      if (flag) {
        const flagEl = document.createElement('span');
        flagEl.className = 'pin-flag' + (flag.warn ? ' pin-flag--warn' : '');
        flagEl.textContent = flag.icon;
        flagEl.title = flag.text;
        if (side === 'left') btn.append(flagEl); else btn.prepend(flagEl);
      }
    }

    container.appendChild(btn);
  }
}

buildBoardCol(els.boardLeft, BOARD_LEFT, 'left');
buildBoardCol(els.boardRight, BOARD_RIGHT, 'right');

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
    if (err.name !== 'NotFoundError') logSystem('Connection failed: ' + err.message);
  }
});

els.disconnectBtn.addEventListener('click', async () => {
  userInitiatedDisconnect = true;
  await teardown('Disconnected.');
});

if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', (e) => {
    if (port && e.target === port) {
      userInitiatedDisconnect = true;
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

  if (!isConnected) {
    els.statusLed.classList.remove('is-on');
    for (const pad of powerPinEls) pad.parentElement.classList.remove('is-powered');
    resetLiveValues();
  } else {
    for (const pad of powerPinEls) pad.parentElement.classList.add('is-powered');
  }
}

// Blanks every displayed value on disconnect so nothing stale lingers on screen.
function resetLiveValues() {
  for (const slot of boardSlots.values()) {
    slot.valueEl.textContent = '\u2013';
    slot.rowEl.classList.remove('board-pin--live', 'board-pin--low', 'board-pin--stale');
  }
  otherChips.clear();
  els.otherSignalsList.innerHTML = '';
  els.otherSignals.hidden = true;
  lastSeen.clear();
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

  for (const p of report.pins) {
    lastSeen.set(p.pin, now);
    recordHistory(p, now);
    pinMeta.set(p.pin, { label: p.label, type: p.type });

    if (p.pin === STATUS_LED_PIN) {
      els.statusLed.classList.toggle('is-on', p.val === 1);
    }

    const slot = boardSlots.get(p.pin);
    if (slot) {
      slot.type = p.type;
      renderSlotValue(slot, p);
    } else {
      renderOtherSignal(p, now);
    }
  }

  if (selectedPin !== null) renderGraph();
}

function recordHistory(p, now) {
  let hist = pinHistory.get(p.pin);
  if (!hist) { hist = []; pinHistory.set(p.pin, hist); }
  hist.push({ t: now, val: p.val });
  if (hist.length > HISTORY_LIMIT) hist.shift();
}

function renderSlotValue(slot, p) {
  const prefix = p.type === 'p' ? '\u223F' : ''; // ∿ prefix for live PWM pins
  slot.valueEl.textContent = prefix + p.val;
  slot.rowEl.classList.remove('board-pin--stale');
  const isHigh = p.type === 'd' ? p.val === 1 : p.val > 0;
  slot.rowEl.classList.toggle('board-pin--live', isHigh);
  slot.rowEl.classList.toggle('board-pin--low', !isHigh);
}

function renderOtherSignal(p, now) {
  let chip = otherChips.get(p.pin);
  if (!chip) {
    chip = document.createElement('span');
    chip.className = 'board__other-chip';
    chip.title = 'Click to graph';
    chip.addEventListener('click', () => selectPin(p.pin));
    otherChips.set(p.pin, chip);
    els.otherSignalsList.appendChild(chip);
    els.otherSignals.hidden = false;
  }
  chip.textContent = (p.label || ('GPIO' + p.pin)) + ': ' + p.val;
}

// ---------------------------------------------------------------------------
// Staleness sweep
// ---------------------------------------------------------------------------

setInterval(() => {
  const now = Date.now();

  for (const slot of boardSlots.values()) {
    // only dim pins that have actually reported at least once
  }
  for (const [gpio, slot] of boardSlots) {
    const seen = lastSeen.get(gpio);
    if (seen && now - seen > STALE_MS) slot.rowEl.classList.add('board-pin--stale');
  }

  for (const [gpio, chip] of otherChips) {
    const seen = lastSeen.get(gpio) || 0;
    if (now - seen > OTHER_REMOVE_MS) {
      chip.remove();
      otherChips.delete(gpio);
      if (otherChips.size === 0) els.otherSignals.hidden = true;
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

  const W = 520, H = 220, PAD_L = 34, PAD_R = 10, PAD_T = 10, PAD_B = 24;
  const plotW = W - PAD_L - PAD_R, plotH = H - PAD_T - PAD_B;

  const t0 = usable[0].t;
  const tSpan = Math.max(1, usable[usable.length - 1].t - t0);

  const toXY = (s) => {
    const x = PAD_L + ((s.t - t0) / tSpan) * plotW;
    const y = PAD_T + plotH - (s.val / info.max) * plotH;
    return [x, y];
  };

  let pathD;
  if (meta.type === 'd') {
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
  const windowSec = Math.round(Math.min(GRAPH_WINDOW_MS, now - t0) / 1000);
  els.graphMeta.textContent = label + ' · ' + latest + info.unit + ' · last ' + windowSec + 's';

  els.graphSvg.innerHTML = `
    <line class="graph-axis" x1="${PAD_L}" y1="${PAD_T + plotH}" x2="${PAD_L + plotW}" y2="${PAD_T + plotH}" />
    <line class="graph-axis" x1="${PAD_L}" y1="${PAD_T}" x2="${PAD_L}" y2="${PAD_T + plotH}" />
    <text class="graph-tick" x="4" y="${PAD_T + 4}">${info.max}</text>
    <text class="graph-tick" x="4" y="${PAD_T + plotH}">0</text>
    <text class="graph-tick" x="${PAD_L}" y="${H - 6}">-${windowSec}s</text>
    <text class="graph-tick" x="${PAD_L + plotW - 18}" y="${H - 6}">now</text>
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
els.clearConsole.addEventListener('click', () => { els.console.innerHTML = ''; });

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

els.sendForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = els.sendInput.value;
  if (!text || !writer) return;

  const ending = els.lineEnding.value === '\\n' ? '\n' : els.lineEnding.value === '\\r\\n' ? '\r\n' : '';
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
