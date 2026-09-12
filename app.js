// Bench — talks to a board over Web Serial, splits incoming text into lines,
// and treats any line matching <PR>{...}</PR> as pin telemetry (see
// firmware/pin_reporter.h). Everything else is just shown in the console.

// ---------------------------------------------------------------------------
// Board layout — best-effort default for the common 38-pin "ESP32 DevKit V1"
// (DOIT-style) board sold by most local shops. If your board's printed
// silkscreen labels differ, edit BOARD_LEFT / BOARD_RIGHT below to match —
// each entry is { silk: 'label printed on your board', pin: GPIO number or
// null for power/ground pins. Any reported pin NOT listed here still shows
// up in the "other reported pins" fallback list, so nothing is ever lost
// even if this default doesn't match your exact clone.
// ---------------------------------------------------------------------------

const BOARD_LEFT = [
  { silk: 'EN',  pin: null },
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
  { silk: 'GND', pin: null },
  { silk: 'D13', pin: 13 },
  { silk: 'D9',  pin: 9 },
  { silk: 'D10', pin: 10 },
  { silk: 'D11', pin: 11 },
  { silk: 'VIN', pin: null },
];

const BOARD_RIGHT = [
  { silk: '3V3', pin: null },
  { silk: 'D15', pin: 15 },
  { silk: 'D2',  pin: 2 },
  { silk: 'D4',  pin: 4 },
  { silk: 'D16', pin: 16 },
  { silk: 'D17', pin: 17 },
  { silk: 'D5',  pin: 5 },
  { silk: 'D18', pin: 18 },
  { silk: 'D19', pin: 19 },
  { silk: 'GND', pin: null },
  { silk: 'D21', pin: 21 },
  { silk: 'RX0', pin: 3 },
  { silk: 'TX0', pin: 1 },
  { silk: 'D22', pin: 22 },
  { silk: 'D23', pin: 23 },
  { silk: 'GND', pin: null },
];

const els = {
  connectBtn: document.getElementById('connectBtn'),
  disconnectBtn: document.getElementById('disconnectBtn'),
  baudRate: document.getElementById('baudRate'),
  connDot: document.getElementById('connDot'),
  connLabel: document.getElementById('connLabel'),
  supportWarning: document.getElementById('supportWarning'),
  boardLeft: document.getElementById('boardLeft'),
  boardRight: document.getElementById('boardRight'),
  pinGrid: document.getElementById('pinGrid'),
  pinCount: document.getElementById('pinCount'),
  console: document.getElementById('console'),
  hideTelemetry: document.getElementById('hideTelemetry'),
  clearConsole: document.getElementById('clearConsole'),
  sendForm: document.getElementById('sendForm'),
  sendInput: document.getElementById('sendInput'),
  lineEnding: document.getElementById('lineEnding'),
};

const PR_OPEN = '<PR>';
const PR_CLOSE = '</PR>';

let port = null;
let reader = null;
let writer = null;
let readLoopPromise = null;
let keepReading = false;
let lineBuffer = '';

const boardSlots = new Map();   // gpio number -> { valueEl, rowEl }
const fallbackCards = new Map(); // gpio number -> card elements, for pins not on the board layout

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

function buildBoardSide(container, entries, side) {
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'board__pin board__pin--' + side + (entry.pin === null ? ' board__pin--power' : '');

    const valueEl = document.createElement('span');
    valueEl.className = 'board__value';
    valueEl.textContent = entry.pin === null ? '' : '–';

    const dot = document.createElement('span');
    dot.className = 'board__dot';

    const silk = document.createElement('span');
    silk.className = 'board__silk';
    silk.textContent = entry.silk;

    if (side === 'left') {
      row.append(valueEl, dot, silk);
    } else {
      row.append(silk, dot, valueEl);
    }

    container.appendChild(row);

    if (entry.pin !== null) {
      boardSlots.set(entry.pin, { valueEl, rowEl: row, silk: entry.silk });
    }
  }
}

buildBoardSide(els.boardLeft, BOARD_LEFT, 'left');
buildBoardSide(els.boardRight, BOARD_RIGHT, 'right');

// ---------------------------------------------------------------------------
// Connect / disconnect
// ---------------------------------------------------------------------------

els.connectBtn.addEventListener('click', async () => {
  try {
    port = await navigator.serial.requestPort();
    await port.open({ baudRate: Number(els.baudRate.value) });

    setConnected(true);
    logSystem('Connected at ' + els.baudRate.value + ' baud.');

    writer = port.writable.getWriter();
    keepReading = true;
    readLoopPromise = readLoop();
  } catch (err) {
    if (err.name !== 'NotFoundError') {
      logSystem('Connection failed: ' + err.message);
    }
  }
});

els.disconnectBtn.addEventListener('click', () => disconnect());

async function disconnect() {
  keepReading = false;
  try {
    if (reader) await reader.cancel();
  } catch (_) {}

  if (readLoopPromise) await readLoopPromise.catch(() => {});

  try {
    if (writer) { writer.releaseLock(); writer = null; }
    if (port) await port.close();
  } catch (_) {}

  port = null;
  setConnected(false);
  logSystem('Disconnected.');
}

function setConnected(isConnected) {
  els.connDot.classList.toggle('is-live', isConnected);
  els.connLabel.textContent = isConnected ? 'Connected' : 'Not connected';
  els.connectBtn.disabled = isConnected;
  els.disconnectBtn.disabled = !isConnected;
  els.baudRate.disabled = isConnected;
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
    logSystem('Read error: ' + err.message);
  } finally {
    reader.releaseLock();
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
// Dashboard — board diagram + fallback grid for anything not on the diagram
// ---------------------------------------------------------------------------

const TYPE_INFO = {
  d: { unit: '', max: 1 },
  p: { unit: '/255', max: 255 },
  a: { unit: '/4095', max: 4095 },
};

function updateDashboard(report) {
  if (!report.pins || !Array.isArray(report.pins)) return;

  let matchedCount = 0;

  for (const p of report.pins) {
    const slot = boardSlots.get(p.pin);
    if (slot) {
      matchedCount++;
      slot.valueEl.textContent = p.val;
      slot.rowEl.classList.toggle('board__pin--live', p.type === 'd' ? p.val === 1 : true);
      slot.rowEl.classList.toggle('board__pin--low', p.type === 'd' && p.val === 0);
    } else {
      renderFallbackCard(p);
    }
  }

  els.pinCount.textContent = matchedCount + ' on diagram · ' + fallbackCards.size +
    ' other · last update ' + new Date().toLocaleTimeString();
}

function renderFallbackCard(p) {
  let card = fallbackCards.get(p.pin);
  if (!card) {
    if (fallbackCards.size === 0) els.pinGrid.innerHTML = '';
    const el = document.createElement('div');
    el.className = 'pin-card';
    el.innerHTML = `
      <div class="pin-card__label">${escapeHtml(p.label || ('GPIO ' + p.pin))}</div>
      <div class="pin-card__gpio">GPIO${p.pin} · ${typeName(p.type)} · not on diagram</div>
      <div class="pin-card__row">
        <span class="pin-card__value">–</span>
        <span class="pin-card__unit"></span>
      </div>
      <div class="pin-card__bar"><div class="pin-card__bar-fill"></div></div>
    `;
    card = {
      el,
      valueEl: el.querySelector('.pin-card__value'),
      unitEl: el.querySelector('.pin-card__unit'),
      barEl: el.querySelector('.pin-card__bar-fill'),
    };
    fallbackCards.set(p.pin, card);
    els.pinGrid.appendChild(el);
  }

  const info = TYPE_INFO[p.type] || TYPE_INFO.d;
  card.valueEl.textContent = p.val;
  card.unitEl.textContent = info.unit;
  const pct = Math.max(0, Math.min(100, (p.val / info.max) * 100));
  card.barEl.style.width = pct + '%';
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
  }
});
