'use strict';
/* N54 Monitor: BLE ELM327 dashboard for the BMW N54 (E9x 335i).
   Standard SAE J1979 mode 01 PIDs + user-defined BMW DME channels. */

const $ = (s) => document.querySelector(s);
const hex2 = (n) => n.toString(16).toUpperCase().padStart(2, '0');

// ---------------------------------------------------------------- settings
const DEFAULTS = {
  boostU: 'psi', railU: 'bar', tempU: 'F', shift: 6500,
  warnCool: 112, warnRail: 30, warnBoost: 20, force: false, custom: [],
};
let S = { ...DEFAULTS };
try { S = { ...DEFAULTS, ...JSON.parse(localStorage.getItem('n54set') || '{}') }; } catch {}
const saveS = () => { try { localStorage.setItem('n54set', JSON.stringify(S)); } catch {} };

// ---------------------------------------------------------------- live state (metric internally)
const V = { rpm: null, map: null, baro: 101.3, boostT: null, rail: null, cool: null,
  wg1: null, wg2: null, wg1c: null, wg2c: null };
const SRC = { rail: '–', wg: '–', boost: '–' };
const PK = {};
const resetPeaks = () => Object.assign(PK, { rpm: 0, boost: -99, cool: -99, railMin: Infinity });
resetPeaks();

// ---------------------------------------------------------------- terminal log
const termLog = [];
function log(msg, cls = '') {
  termLog.push([msg, cls]); if (termLog.length > 400) termLog.shift();
  const el = $('#termLog'); if (!el || $('#drawer').hidden) return;
  const d = document.createElement('div'); d.className = cls; d.textContent = msg; el.appendChild(d);
  while (el.childNodes.length > 400) el.firstChild.remove();
  el.scrollTop = el.scrollHeight;
}
function toast(msg, ms = 3500) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), ms);
}
function setStatus(txt, mode) {
  $('#statusText').textContent = txt;
  $('#dot').className = 'dot' + (mode ? ' ' + mode : '');
}

// ---------------------------------------------------------------- BLE transport
// Known service UUIDs used by BLE ELM327 clones and OBDLink/Vgate/Veepeak devices.
const BLE_SERVICES = [
  0xfff0, 0xffe0, 0x18f0, 0xffb0, 0xfee7, 0xbeef,
  'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
  '0000fff0-0000-1000-8000-00805f9b34fb',
  '49535343-fe7d-4ae5-8fa9-9fafd205e455', // Microchip transparent UART
  '6e400001-b5a3-f393-e0a9-e50e24dcca9e', // Nordic UART
];
class BleTransport {
  constructor() { this.onData = () => {}; this.onClose = () => {}; this.dec = new TextDecoder(); this.enc = new TextEncoder(); }
  async connect() {
    if (!navigator.bluetooth) throw new Error('This browser has no Web Bluetooth. Use Chrome on Android, or the Bluefy browser on iPhone.');
    this.dev = await navigator.bluetooth.requestDevice({ acceptAllDevices: true, optionalServices: BLE_SERVICES });
    this.dev.addEventListener('gattserverdisconnected', () => this.onClose());
    setStatus('Connecting to ' + (this.dev.name || 'adapter') + '…', 'busy');
    const gatt = await this.dev.gatt.connect();
    const services = await gatt.getPrimaryServices();
    let best = null;
    for (const svc of services) {
      let chars; try { chars = await svc.getCharacteristics(); } catch { continue; }
      const n = chars.find((c) => c.properties.notify || c.properties.indicate);
      const w = chars.find((c) => c.properties.writeWithoutResponse || c.properties.write);
      if (n && w) { best = { n, w, svc }; break; }
      if (!best && (n || w)) best = { n, w, svc, partial: true };
    }
    if (!best || !best.n || !best.w) throw new Error('No serial (notify+write) characteristic found on this adapter. Is it a BLE OBD adapter?');
    this.rx = best.n; this.tx = best.w;
    this.noResp = !!this.tx.properties.writeWithoutResponse;
    await this.rx.startNotifications();
    this.rx.addEventListener('characteristicvaluechanged', (e) => this.onData(this.dec.decode(e.target.value)));
    this.name = (this.dev.name || 'BLE adapter') + ' [' + best.svc.uuid.slice(4, 8) + ']';
  }
  async write(str) {
    const bytes = this.enc.encode(str);
    for (let i = 0; i < bytes.length; i += 20) {
      const chunk = bytes.slice(i, i + 20);
      if (this.noResp && this.tx.writeValueWithoutResponse) await this.tx.writeValueWithoutResponse(chunk);
      else if (this.tx.writeValueWithResponse) await this.tx.writeValueWithResponse(chunk);
      else await this.tx.writeValue(chunk);
    }
  }
  disconnect() { try { this.dev?.gatt?.disconnect(); } catch {} }
}


// ---------------------------------------------------------------- Native BLE transport (Android APK build)
const NATIVE = window.N54Native && window.N54Native.Capacitor.isNativePlatform() ? window.N54Native : null;
class NativeBleTransport {
  constructor() { this.onData = () => {}; this.onClose = () => {}; this.dec = new TextDecoder(); this.enc = new TextEncoder(); }
  async connect() {
    const { BleClient } = NATIVE;
    await BleClient.initialize();
    if (!(await BleClient.isEnabled())) { try { await BleClient.requestEnable(); } catch {} }
    const dev = await BleClient.requestDevice({});
    this.id = dev.deviceId;
    setStatus('Connecting to ' + (dev.name || dev.deviceId) + '…', 'busy');
    await BleClient.connect(this.id, () => this.onClose(), { timeout: 15000 });
    const services = await BleClient.getServices(this.id);
    let best = null;
    const rank = (svc) => (/^0000(180[0-9a-f]|18[0-9a-f]{2})-/.test(svc.uuid) && !/^000018f0/.test(svc.uuid) ? 1 : 0); // skip standard GATT/GAP-type services first
    for (const svc of [...services].sort((a, b) => rank(a) - rank(b))) {
      const n = svc.characteristics.find((c) => c.properties.notify || c.properties.indicate);
      const w = svc.characteristics.find((c) => c.properties.writeWithoutResponse || c.properties.write);
      if (n && w) { best = { svc: svc.uuid, n: n.uuid, w: w.uuid, noResp: !!w.properties.writeWithoutResponse }; break; }
    }
    if (!best) throw new Error('No serial (notify+write) characteristic found. Services: ' + services.map((s) => s.uuid.slice(4, 8)).join(','));
    this.b = best;
    await BleClient.startNotifications(this.id, best.svc, best.n, (dv) => this.onData(this.dec.decode(dv)));
    this.name = (dev.name || 'BLE adapter') + ' [' + best.svc.slice(4, 8) + ']';
  }
  async write(str) {
    const { BleClient } = NATIVE; const bytes = this.enc.encode(str);
    for (let i = 0; i < bytes.length; i += 20) {
      const dv = new DataView(bytes.slice(i, i + 20).buffer);
      if (this.b.noResp) await BleClient.writeWithoutResponse(this.id, this.b.svc, this.b.w, dv);
      else await BleClient.write(this.id, this.b.svc, this.b.w, dv);
    }
  }
  disconnect() { if (this.id) NATIVE.BleClient.disconnect(this.id).catch(() => {}); }
}

// ---------------------------------------------------------------- Demo transport (simulated N54 + ELM327)
class DemoTransport {
  constructor() { this.onData = () => {}; this.onClose = () => {}; this.name = 'Demo simulator'; this.t0 = performance.now(); this.cool = 40; }
  async connect() {}
  disconnect() { this.onClose(); }
  sim() {
    const t = (performance.now() - this.t0) / 1000;
    const cyc = t % 14; // idle 4s, pull 6s, decel 4s
    let rpm, load;
    if (cyc < 4) { rpm = 750 + Math.sin(t * 3) * 15; load = 0.1; }
    else if (cyc < 10) { const p = (cyc - 4) / 6; rpm = 2000 + p * 4900; load = 1; }
    else { rpm = 6900 - (cyc - 10) / 4 * 6100; load = 0.05; }
    this.cool = Math.min(98, this.cool + 0.05);
    const spool = load > 0.5 ? Math.min(1, (rpm - 1800) / 1200) : 0;
    const boostKpa = spool * 62 * (1 - Math.max(0, rpm - 5500) / 4000) + (Math.random() - 0.5) * 3; // ~9 psi stock-ish
    const tgt = load > 0.5 ? 62 * (1 - Math.max(0, rpm - 5500) / 4000) : 0;
    const rail = load > 0.5 ? 19000 + Math.random() * 800 - (rpm > 6000 ? 4000 : 0) : 5000 + Math.random() * 200; // kPa gauge
    const wgc = load > 0.5 ? 60 + spool * 25 : 10; const wga = wgc - 4 + Math.random() * 3;
    return { rpm, map: 101 + boostKpa, tgt: 101 + tgt, rail, cool: this.cool, wgc, wga };
  }
  write(str) {
    const cmd = str.trim().toUpperCase().replace(/\s/g, '');
    let r = 'OK';
    const s = this.sim();
    const b = (n) => hex2(Math.max(0, Math.min(255, Math.round(n))));
    const w = (n) => { n = Math.max(0, Math.min(65535, Math.round(n))); return hex2(n >> 8) + hex2(n & 255); };
    const SUP = new Set([0x05, 0x0b, 0x0c, 0x0d, 0x11, 0x20, 0x23, 0x33, 0x40, 0x60, 0x70, 0x72]);
    const bitmap = (base) => { let v = 0; for (let i = 1; i <= 32; i++) if (SUP.has(base + i)) v |= 1 << (32 - i); return (v >>> 0).toString(16).toUpperCase().padStart(8, '0'); };
    if (cmd === 'ATZ' || cmd === 'ATWS') r = '\r\rELM327 v1.5';
    else if (cmd === 'ATI') r = 'ELM327 v1.5';
    else if (cmd === 'ATRV') r = (13.9 + Math.random() * 0.2).toFixed(1) + 'V';
    else if (cmd === 'ATDPN') r = 'A6';
    else if (cmd === 'ATDP') r = 'AUTO, ISO 15765-4 (CAN 11/500)';
    else if (cmd.startsWith('AT')) r = 'OK';
    else if (/^01(00|20|40|60)$/.test(cmd)) r = '41' + cmd.slice(2) + bitmap(parseInt(cmd.slice(2), 16));
    else if (cmd === '010C') r = '410C' + w(s.rpm * 4);
    else if (cmd === '0105') r = '4105' + b(s.cool + 40);
    else if (cmd === '010B') r = '410B' + b(s.map);
    else if (cmd === '0133') r = '413365';
    else if (cmd === '0123') r = '4123' + w(s.rail / 10);
    else if (cmd === '0170') r = '4170' + '03' + w(s.tgt * 32) + w(s.map * 32) + '0000' + '0000' + '00';
    else if (cmd === '0172') r = '4172' + '0F' + b(s.wgc * 2.55) + b(s.wga * 2.55) + b(s.wgc * 2.55) + b((s.wga + 1) * 2.55);
    else r = 'NO DATA';
    setTimeout(() => this.onData(r + '\r\r>'), 15 + Math.random() * 15);
  }
}

// ---------------------------------------------------------------- ELM327 protocol driver
class Elm {
  constructor(tr) {
    this.tr = tr; this.buf = ''; this.pending = null; this.q = Promise.resolve();
    tr.onData = (s) => this.onData(s);
  }
  send(cmd, timeout = 1500) {
    const p = this.q.then(() => this._send(cmd, timeout));
    this.q = p.catch(() => {});
    return p;
  }
  _send(cmd, timeout) {
    return new Promise((res, rej) => {
      this.buf = '';
      this.pending = { res, rej, cmd };
      this.timer = setTimeout(() => { this.pending = null; rej(new Error('timeout: ' + cmd)); }, timeout);
      if ($('#termVerbose')?.checked) log('> ' + cmd, 'tx');
      Promise.resolve(this.tr.write(cmd + '\r')).catch((e) => { clearTimeout(this.timer); this.pending = null; rej(e); });
    });
  }
  onData(s) {
    this.buf += s;
    const i = this.buf.indexOf('>');
    if (i < 0 || !this.pending) return;
    const raw = this.buf.slice(0, i); this.buf = this.buf.slice(i + 1);
    clearTimeout(this.timer);
    const p = this.pending; this.pending = null;
    const lines = raw.replace(/\0/g, '').split(/[\r\n]+/).map((l) => l.trim())
      .filter((l) => l && l !== p.cmd && !/^SEARCHING/i.test(l) && !/^BUS INIT/i.test(l));
    if ($('#termVerbose')?.checked) log(lines.join(' | '));
    p.res(lines);
  }
}
const ELM_ERR = /NO DATA|\?|ERROR|STOPPED|UNABLE|BUFFER FULL|NO RESPONSE|BUS BUSY|FB ERROR|DATA ERROR/i;

// Extract data bytes that follow `prefix` (e.g. "410C") from an ELM response (handles multi-frame "0:" lines).
function bytesAfter(lines, prefix) {
  const norm = lines.map((l) => l.replace(/\s/g, '').toUpperCase());
  for (const l of norm) {
    const i = l.indexOf(prefix);
    if (i >= 0 && !/^[0-9A-F]:/.test(l)) return toBytes(l.slice(i + prefix.length));
  }
  const joined = norm.filter((l) => !/^[0-9A-F]{3}$/.test(l)).map((l) => l.replace(/^[0-9A-F]:/, '')).join('');
  const i = joined.indexOf(prefix);
  return i >= 0 ? toBytes(joined.slice(i + prefix.length)) : null;
}
const toBytes = (h) => { const out = []; for (let i = 0; i + 1 < h.length; i += 2) { const v = parseInt(h.substr(i, 2), 16); if (isNaN(v)) break; out.push(v); } return out; };

// ---------------------------------------------------------------- PID definitions (SAE J1979 mode 01)
const PIDS = {
  0x0c: { n: 'RPM', f: (d) => { V.rpm = (d[0] * 256 + d[1]) / 4; } },
  0x05: { n: 'Coolant', f: (d) => { V.cool = d[0] - 40; } },
  0x0b: { n: 'MAP', f: (d) => { V.map = d[0]; SRC.boost = 'MAP'; } },
  0x33: { n: 'Baro', f: (d) => { if (d[0] > 50) V.baro = d[0]; } },
  0x87: { n: 'MAP ext', f: (d) => { if (d[0] & 1) { V.map = (d[1] * 256 + d[2]) / 32; SRC.boost = 'MAP+'; } } },
  0x70: { n: 'Boost ctl', f: (d) => {
    if (d[0] & 1) V.boostT = (d[1] * 256 + d[2]) * 0.03125;
    if (d[0] & 2) { V.map = (d[3] * 256 + d[4]) * 0.03125; SRC.boost = 'PID70'; }
  } },
  0x59: { n: 'Rail abs', f: (d) => { V.rail = (d[0] * 256 + d[1]) * 10 - V.baro; SRC.rail = 'PID59'; } },
  0x23: { n: 'Rail gauge', f: (d) => { if (SRC.rail !== 'PID59') { V.rail = (d[0] * 256 + d[1]) * 10; SRC.rail = 'PID23'; } } },
  0x72: { n: 'Wastegate', f: (d) => {
    if (d[0] & 1) V.wg1c = d[1] * 100 / 255; if (d[0] & 2) V.wg1 = d[2] * 100 / 255;
    if (d[0] & 4) V.wg2c = d[3] * 100 / 255; if (d[0] & 8) V.wg2 = d[4] * 100 / 255;
    SRC.wg = 'PID72';
  } },
};
let sup = new Set();
const fails = {};

// ---------------------------------------------------------------- connection lifecycle
let tr = null, elm = null, running = false, wakeLock = null;

async function start(demo) {
  if (running || tr) { stop(); return; }
  tr = demo ? new DemoTransport() : NATIVE ? new NativeBleTransport() : new BleTransport();
  try {
    setStatus(demo ? 'Starting demo…' : 'Pick your OBD adapter…', 'busy');
    await tr.connect();
    tr.onClose = () => { if (tr) { toast('Adapter disconnected'); stop(); } };
    elm = new Elm(tr);
    $('#infoAdapter').textContent = tr.name;
    await initElm();
    running = true;
    $('#btnConnect').textContent = 'Disconnect';
    $('#btnDemo').disabled = true;
    await getWake();
    pollLoop();
  } catch (e) {
    log('ERROR ' + e.message, 'err');
    if (e.name !== 'NotFoundError' && !/cancel/i.test(e.message)) toast(e.message, 6000);
    stop();
  }
}
function stop() {
  running = false;
  const t = tr; tr = null; elm = null;
  try { t?.disconnect(); } catch {}
  wakeLock?.release?.().catch(() => {}); wakeLock = null;
  $('#btnConnect').textContent = 'Connect';
  $('#btnDemo').disabled = false;
  setStatus('Disconnected');
  $('#hz').textContent = '0.0';
}

async function getWake() {
  try { wakeLock = await navigator.wakeLock?.request('screen'); wakeLock?.addEventListener('release', () => (wakeLock = null)); } catch {}
}
async function initElm() {
  setStatus('Initialising ELM327…', 'busy');
  try { await elm.send('ATZ', 3000); } catch { await elm.send('ATWS', 3000).catch(() => {}); }
  const ver = await elm.send('ATI').catch(() => []);
  $('#infoElm').textContent = ver.join(' ') || '?';
  for (const c of ['ATE0', 'ATL0', 'ATS0', 'ATH0', 'ATAT1', 'ATSP0']) await elm.send(c).catch(() => {});
  setStatus('Searching for ECU…', 'busy');
  let r = [];
  for (let attempt = 0; attempt < 3; attempt++) {
    r = await elm.send('0100', 10000).catch(() => ['ERROR']);
    if (bytesAfter(r, '4100')) break;
    if (attempt === 1) await elm.send('ATSP6').catch(() => {}); // E9x OBD = ISO 15765-4 CAN 11-bit 500k
  }
  if (!bytesAfter(r, '4100')) throw new Error('ECU did not answer (' + r.join(' ') + '). Ignition on? Adapter fully seated?');
  $('#infoProto').textContent = (await elm.send('ATDP').catch(() => ['?'])).join(' ');
  $('#infoVolt').textContent = (await elm.send('ATRV').catch(() => ['?'])).join(' ');
  sup = new Set();
  for (const base of [0x00, 0x20, 0x40, 0x60, 0x80]) {
    if (base && !sup.has(base)) break;
    const d = bytesAfter(await elm.send('01' + hex2(base), 3000).catch(() => []), '41' + hex2(base));
    if (!d || d.length < 4) break;
    for (let i = 0; i < 32; i++) if (d[i >> 3] & (0x80 >> (i & 7))) sup.add(base + i + 1);
  }
  const want = Object.keys(PIDS).map(Number);
  const has = want.filter((p) => sup.has(p)).map((p) => hex2(p) + ' ' + PIDS[p].n);
  const miss = want.filter((p) => !sup.has(p)).map((p) => hex2(p) + ' ' + PIDS[p].n);
  $('#supportInfo').textContent = 'ECU supports: ' + (has.join(', ') || 'none') + '. Not reported: ' + (miss.join(', ') || 'none') + '.';
  log('Supported PIDs: ' + [...sup].map(hex2).join(' '));
  if (!sup.has(0x23) && !sup.has(0x59) && !customFor('rail')) toast('ECU does not report a standard rail-pressure PID. Add a BMW DME channel in Menu → BMW DME.', 7000);
  setStatus('Connected · ' + tr.name, 'on');
}

const usable = (p) => (S.force || sup.has(p)) && (fails[p] || 0) < 5;
const customFor = (target) => (S.custom || []).find((c) => c.target === target && c.request);

async function readPid(pid) {
  const h = hex2(pid);
  try {
    const r = await elm.send('01' + h, 1200);
    const d = bytesAfter(r, '41' + h);
    if (!d || !d.length) { fails[pid] = (fails[pid] || 0) + 1; return; }
    fails[pid] = 0; PIDS[pid].f(d);
  } catch (e) { fails[pid] = (fails[pid] || 0) + 1; }
}

// BMW DME custom channels: switch headers, query, restore.
let curHdr = null;
async function setHeader(c) {
  const key = [c.header, c.cea, c.cra].join('|');
  if (key === curHdr) return;
  if (c.header) await elm.send('ATSH' + c.header).catch(() => {});
  await elm.send(c.cea ? 'ATCEA' + c.cea : 'ATCEA').catch(() => {});
  await elm.send(c.cra ? 'ATCRA' + c.cra : 'ATCRA').catch(() => {});
  if (c.fcsh) { await elm.send('ATFCSH' + c.fcsh).catch(() => {}); await elm.send('ATFCSD' + (c.fcsd || '300000')).catch(() => {}); await elm.send('ATFCSM1').catch(() => {}); }
  curHdr = key;
}
const STD_HDR = { header: '7DF', cea: '', cra: '' };
const compiled = new Map();
async function readCustom(c) {
  await setHeader(c);
  const req = c.request.replace(/\s/g, '').toUpperCase();
  const expect = hex2((parseInt(req.slice(0, 2), 16) + 0x40) & 0xff) + req.slice(2);
  try {
    const r = await elm.send(req, c.timeout || 1500);
    if (r.some((l) => ELM_ERR.test(l))) { c._fail = (c._fail || 0) + 1; return; }
    const d = bytesAfter(r, expect); if (!d) { c._fail = (c._fail || 0) + 1; return; }
    let fn = compiled.get(c.formula);
    if (!fn) { fn = new Function('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'bytes', 'return (' + c.formula + ');'); compiled.set(c.formula, fn); }
    const v = fn(...d.slice(0, 8), d);
    if (!Number.isFinite(v)) return;
    c._fail = 0;
    switch (c.target) {
      case 'rpm': V.rpm = v; break;
      case 'boost': V.map = v; SRC.boost = 'DME'; break;
      case 'boostTarget': V.boostT = v; break;
      case 'rail': V.rail = v; SRC.rail = 'DME'; break;
      case 'coolant': V.cool = v; break;
      case 'wg1': V.wg1 = v; SRC.wg = 'DME'; break;
      case 'wg2': V.wg2 = v; SRC.wg = 'DME'; break;
      case 'wg1c': V.wg1c = v; break;
      case 'wg2c': V.wg2c = v; break;
    }
  } catch (e) { c._fail = (c._fail || 0) + 1; }
}

async function pollLoop() {
  let n = 0, cycles = 0, tHz = performance.now();
  curHdr = null;
  while (running && elm) {
    const custom = (S.custom || []).filter((c) => c.request && (c._fail || 0) < 8);
    const ct = new Set(custom.map((c) => c.target));
    const fast = [];
    if (!ct.has('rpm')) fast.push(0x0c);
    if (!ct.has('boost')) { if (usable(0x70)) fast.push(0x70); else if (usable(0x87)) fast.push(0x87); else fast.push(0x0b); }
    if (!ct.has('rail')) { if (usable(0x59)) fast.push(0x59); else if (usable(0x23)) fast.push(0x23); }
    if (!ct.has('wg1') && usable(0x72)) fast.push(0x72);
    const slow = [];
    if (!ct.has('coolant')) slow.push(0x05);
    if (usable(0x33)) slow.push(0x33);

    if (custom.length) await setHeader(STD_HDR);
    for (const p of fast) { if (!running) return; await readPid(p); }
    if (n % 12 === 0) for (const p of slow) { if (!running) return; await readPid(p); }
    if (custom.length) for (const c of custom) { if (!running) return; await readCustom(c); }

    sample();
    n++; cycles++;
    const now = performance.now();
    if (now - tHz > 1000) { $('#hz').textContent = (cycles * 1000 / (now - tHz)).toFixed(1); cycles = 0; tHz = now; }
  }
}

// ---------------------------------------------------------------- derived values, peaks, logging
const boostKpa = () => (V.map == null ? null : V.map - V.baro);
const boostTKpa = () => (V.boostT == null ? null : V.boostT - V.baro);
let rec = null;
function sample() {
  const b = boostKpa();
  if (V.rpm != null) PK.rpm = Math.max(PK.rpm, V.rpm);
  if (b != null) PK.boost = Math.max(PK.boost, b);
  if (V.cool != null) PK.cool = Math.max(PK.cool, V.cool);
  if (V.rail != null && V.rpm > 400) PK.railMin = Math.min(PK.railMin, V.rail);
  if (rec) rec.push([((performance.now() - rec.t0) / 1000).toFixed(3), V.rpm?.toFixed(0), b?.toFixed(1), boostTKpa()?.toFixed(1),
    V.rail?.toFixed(0), V.cool?.toFixed(0), V.wg1?.toFixed(1), V.wg2?.toFixed(1), V.wg1c?.toFixed(1), V.wg2c?.toFixed(1)].map((x) => x ?? '').join(','));
}
async function saveNative(fname, csv, n) {
  const { Filesystem, Directory, Encoding, Share } = NATIVE;
  try {
    const r = await Filesystem.writeFile({ path: fname, data: csv, directory: Directory.Cache, encoding: Encoding.UTF8 });
    await Share.share({ title: fname, files: [r.uri], dialogTitle: 'Save or send log' });
  } catch (e) { if (!/cancel/i.test(e.message)) toast('Could not share log: ' + e.message, 6000); return; }
  toast(n + ' samples saved');
}
function toggleRec() {
  if (!rec) { rec = []; rec.t0 = performance.now(); rec.start = new Date(); $('#btnRec').classList.add('rec'); $('#btnRec').textContent = '■ Stop'; return; }
  const rows = rec; rec = null;
  $('#btnRec').classList.remove('rec'); $('#btnRec').textContent = '● Rec';
  if (!rows.length) return toast('Nothing recorded');
  const csv = 'time_s,rpm,boost_kpa,boost_target_kpa,rail_kpa,coolant_c,wg1_pct,wg2_pct,wg1_cmd_pct,wg2_cmd_pct\n' + rows.join('\n');
  const fname = 'n54_log_' + rows.start.toISOString().replace(/[:.]/g, '-').slice(0, 19) + '.csv';
  if (NATIVE) { saveNative(fname, csv, rows.length); return; }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = fname;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast(rows.length + ' samples saved');
}

// ---------------------------------------------------------------- units
const U = {
  boost: (k) => (S.boostU === 'psi' ? k * 0.145038 : S.boostU === 'bar' ? k / 100 : k),
  boostDp: () => (S.boostU === 'bar' ? 2 : S.boostU === 'psi' ? 1 : 0),
  rail: (k) => (S.railU === 'bar' ? k / 100 : S.railU === 'psi' ? k * 0.145038 : k / 1000),
  railDp: () => (S.railU === 'mpa' ? 1 : 0),
  temp: (c) => (S.tempU === 'F' ? c * 9 / 5 + 32 : c),
};

// ---------------------------------------------------------------- gauges (SVG)
const A0 = -225, A1 = 45; // 270° sweep
const pt = (cx, cy, r, a) => [cx + r * Math.cos(a * Math.PI / 180), cy + r * Math.sin(a * Math.PI / 180)];
function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = pt(cx, cy, r, a0), [x1, y1] = pt(cx, cy, r, a1);
  return `M${x0.toFixed(2)} ${y0.toFixed(2)}A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
}
function buildGauge(svg, min, max, ticks, redFrom) {
  const cx = 100, cy = 78, r = 62;
  const ang = (v) => A0 + (A1 - A0) * (Math.min(max, Math.max(min, v)) - min) / (max - min);
  let h = `<path class="trk" d="${arc(cx, cy, r, A0, A1)}"/>`;
  if (redFrom != null) h += `<path class="red" d="${arc(cx, cy, r, ang(redFrom), A1)}"/>`;
  h += `<path class="val" pathLength="1000" stroke-dasharray="0 1000" d="${arc(cx, cy, r, A0, A1)}"/>`;
  h += `<line class="tgt" x1="0" y1="0" x2="0" y2="0" style="display:none"/>`;
  for (const t of ticks) { const [x, y] = pt(cx, cy, r - 18, ang(t.v)); h += `<text x="${x.toFixed(1)}" y="${(y + 3).toFixed(1)}">${t.l}</text>`; }
  svg.innerHTML = h;
  return {
    set(v, color) {
      const p = v == null ? 0 : Math.max(0, Math.min(1, (v - min) / (max - min)));
      const el = svg.querySelector('.val'); el.setAttribute('stroke-dasharray', `${(p * 1000).toFixed(1)} 1000`);
      el.style.stroke = color || '';
    },
    target(v) {
      const el = svg.querySelector('.tgt');
      if (v == null) { el.style.display = 'none'; return; }
      const a = ang(v), [x0, y0] = pt(cx, cy, r - 9, a), [x1, y1] = pt(cx, cy, r + 9, a);
      el.setAttribute('x1', x0); el.setAttribute('y1', y0); el.setAttribute('x2', x1); el.setAttribute('y2', y1); el.style.display = '';
    },
  };
}
let G = {};
function buildGauges() {
  G.rpm = buildGauge($('#gRpm'), 0, 8000, [0, 1, 2, 3, 4, 5, 6, 7, 8].map((k) => ({ v: k * 1000, l: k })), 7000);
  const bmax = { psi: 25, bar: 1.75, kpa: 175 }[S.boostU];
  const bmin = { psi: -15, bar: -1, kpa: -100 }[S.boostU];
  const bt = S.boostU === 'psi' ? [-15, -5, 0, 5, 10, 15, 20, 25] : S.boostU === 'bar' ? [-1, -0.5, 0, 0.5, 1, 1.5] : [-100, -50, 0, 50, 100, 150];
  G.boost = buildGauge($('#gBoost'), bmin, bmax, bt.map((v) => ({ v, l: v })), null);
  G.boost.min = bmin;
  const rmax = { bar: 250, psi: 3600, mpa: 25 }[S.railU];
  G.rail = buildGauge($('#gRail'), 0, rmax, [0, 0.2, 0.4, 0.6, 0.8, 1].map((f) => ({ v: f * rmax, l: Math.round(f * rmax) })), null);
  $('#uBoost').textContent = S.boostU; $('#uRail').textContent = S.railU === 'mpa' ? 'MPa' : S.railU;
  $('#uCool').textContent = '°' + S.tempU;
}

// ---------------------------------------------------------------- render loop
const fmt = (v, dp = 0) => (v == null || !Number.isFinite(v) ? '--' : v.toFixed(dp));
const smooth = {};
const sm = (k, v, a = 0.35) => (v == null ? (smooth[k] = null) : (smooth[k] = smooth[k] == null ? v : smooth[k] + (v - smooth[k]) * a));
function cls(el, state) { el.classList.toggle('warn', state === 'warn'); el.classList.toggle('alarm', state === 'alarm'); }

function render() {
  const rpm = sm('rpm', V.rpm, 0.5);
  $('#vRpm').textContent = fmt(rpm == null ? null : Math.round(rpm / 10) * 10);
  G.rpm.set(rpm, rpm > 7000 ? 'var(--bad)' : rpm > S.shift - 1000 ? 'var(--warn)' : '');
  $('#pRpm').textContent = PK.rpm ? fmt(PK.rpm) : '--';
  const sh = $('#shift'); const r = rpm || 0;
  sh.className = 'shift' + (r >= S.shift ? ' l3 flash' : r >= S.shift - 500 ? ' l2' : r >= S.shift - 1200 ? ' l1' : '');

  const bk = sm('boost', boostKpa());
  const b = bk == null ? null : U.boost(bk);
  $('#vBoost').textContent = fmt(b, U.boostDp());
  const bPsi = bk == null ? null : bk * 0.145038;
  G.boost.set(b, bPsi > S.warnBoost ? 'var(--bad)' : bPsi > 0.5 ? 'var(--ok)' : '');
  const bt = boostTKpa();
  G.boost.target(bt == null ? null : U.boost(bt));
  $('#vBoostT').textContent = fmt(bt == null ? null : U.boost(bt), U.boostDp());
  $('#pBoost').textContent = PK.boost > -99 ? fmt(U.boost(PK.boost), U.boostDp()) : '--';
  cls($('#tBoost'), bPsi != null && bPsi > S.warnBoost ? 'alarm' : '');

  const rk = sm('rail', V.rail, 0.5);
  const rv = rk == null ? null : U.rail(rk);
  $('#vRail').textContent = fmt(rv, U.railDp());
  const railLow = rk != null && (V.rpm || 0) > 400 && rk / 100 < S.warnRail;
  G.rail.set(rv, railLow ? 'var(--bad)' : '');
  $('#mRail').textContent = PK.railMin < Infinity ? fmt(U.rail(PK.railMin), U.railDp()) : '--';
  $('#sRail').textContent = SRC.rail;
  cls($('#tRail'), railLow ? 'alarm' : '');

  const c = V.cool;
  $('#vCool').textContent = fmt(c == null ? null : U.temp(c));
  const cp = c == null ? 0 : Math.max(0, Math.min(100, (c - 20) / (125 - 20) * 100));
  const ce = $('#bCool'); ce.style.width = cp + '%';
  ce.style.background = c == null ? '' : c >= S.warnCool ? 'var(--bad)' : c < 70 ? 'var(--acc)' : c > 105 ? 'var(--warn)' : 'var(--ok)';
  $('#pCool').textContent = PK.cool > -99 ? fmt(U.temp(PK.cool)) : '--';
  cls($('#tCool'), c != null && c >= S.warnCool ? 'alarm' : c != null && c > 105 ? 'warn' : '');

  for (const k of ['1', '2']) {
    const a = sm('wg' + k, V['wg' + k]), cmd = V['wg' + k + 'c'];
    $('#bWg' + k).style.width = (a == null ? 0 : Math.max(0, Math.min(100, a))) + '%';
    const t = $('#bWg' + k + 'c');
    if (cmd == null) t.style.display = 'none'; else { t.style.display = 'block'; t.style.left = `calc(${Math.max(0, Math.min(100, cmd))}% - 1px)`; }
    $('#vWg' + k).textContent = a == null ? (cmd == null ? '--' : fmt(cmd) + '%c') : fmt(a) + '%';
  }
  $('#sWg').textContent = SRC.wg;
  requestAnimationFrame(render);
}

// ---------------------------------------------------------------- UI wiring
function fillSettings() {
  $('#sBoostU').value = S.boostU; $('#sRailU').value = S.railU; $('#sTempU').value = S.tempU;
  $('#sShift').value = S.shift; $('#sWCool').value = S.warnCool; $('#sWRail').value = S.warnRail; $('#sWBoost').value = S.warnBoost;
  $('#sForce').checked = S.force;
  $('#customJson').value = JSON.stringify((S.custom || []).map(({ _fail, ...c }) => c), null, 2);
}
const TEMPLATE = [{
  name: 'Example, replace with a verified DME identifier',
  target: 'rail', header: '6F1', cea: '12', cra: '612', fcsh: '6F1', fcsd: '1230000000', request: '22XXXX', formula: 'A*256+B',
}];

$('#btnConnect').onclick = () => start(false);
$('#btnDemo').onclick = () => start(true);
$('#btnRec').onclick = toggleRec;
$('#btnPeaks').onclick = () => { resetPeaks(); toast('Peaks reset'); };
$('#btnMenu').onclick = () => {
  fillSettings(); $('#drawer').hidden = false;
  const el = $('#termLog'); el.innerHTML = '';
  for (const [m, c] of termLog) { const d = document.createElement('div'); d.className = c; d.textContent = m; el.appendChild(d); }
  el.scrollTop = el.scrollHeight;
};
$('#btnClose').onclick = () => ($('#drawer').hidden = true);
$('#drawer').onclick = (e) => { if (e.target.id === 'drawer') $('#drawer').hidden = true; };
document.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((t) => (t.hidden = t.id !== 'tab-' + b.dataset.tab));
}));
$('#btnSaveSet').onclick = () => {
  S.boostU = $('#sBoostU').value; S.railU = $('#sRailU').value; S.tempU = $('#sTempU').value;
  S.shift = +$('#sShift').value || 6500; S.warnCool = +$('#sWCool').value || 112;
  S.warnRail = +$('#sWRail').value || 0; S.warnBoost = +$('#sWBoost').value || 99; S.force = $('#sForce').checked;
  saveS(); buildGauges(); toast('Saved');
};
$('#btnTemplate').onclick = () => {
  let cur = []; try { cur = JSON.parse($('#customJson').value || '[]'); } catch {}
  $('#customJson').value = JSON.stringify([...cur, ...TEMPLATE], null, 2);
};
$('#btnSaveCustom').onclick = () => {
  try {
    const arr = JSON.parse($('#customJson').value || '[]');
    if (!Array.isArray(arr)) throw new Error('Must be a JSON array');
    for (const c of arr) {
      if (!c.target || !c.request || !c.formula) throw new Error('Each channel needs target, request and formula');
      if (!/^[0-9A-F\s]+$/i.test(c.request)) throw new Error('request must be hex: ' + c.request);
      if (/X/i.test(c.request)) throw new Error('Replace the XXXX placeholder in "' + c.request + '" with a real identifier');
      new Function('A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'bytes', 'return (' + c.formula + ');');
    }
    S.custom = arr; saveS(); curHdr = null; $('#customErr').textContent = 'Saved ' + arr.length + ' channel(s).';
  } catch (e) { $('#customErr').textContent = 'Error: ' + e.message; }
};
$('#termForm').onsubmit = async (e) => {
  e.preventDefault();
  const cmd = $('#termIn').value.trim().toUpperCase(); if (!cmd) return;
  $('#termIn').value = '';
  if (!elm) { log('Not connected', 'err'); return; }
  log('> ' + cmd, 'tx');
  try { const r = await elm.send(cmd, 5000); log(r.join('\n') || '(empty)'); } catch (err) { log(err.message, 'err'); }
  curHdr = null; // the user may have changed headers; force restore
};
document.addEventListener('visibilitychange', async () => {
  if (document.visibilityState === 'visible' && running && !wakeLock) await getWake();
});

buildGauges();
requestAnimationFrame(render);
if (!navigator.bluetooth && !NATIVE) setStatus('No Web Bluetooth in this browser (Demo only)');
if (!NATIVE && 'serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('sw.js').catch(() => {});
