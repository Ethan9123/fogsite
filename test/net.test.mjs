// FOGSITE thin-client reconnection test — run with: node test/net.test.mjs
// net.js is browser code (WebSocket / sessionStorage / setTimeout globals), so
// we stub those globals and drive the socket lifecycle by hand to prove the
// auto-reconnect state machine: an unexpected drop redials with the SAVED token
// and a capped exponential backoff, a successful open resets the backoff, and a
// deliberate close() never reconnects. Message routing is checked too.
import assert from 'node:assert/strict';

// ---- stub the browser globals net.js reaches for at runtime ----------------
let dialed = [];   // every FakeWS the client opened, in order
let timers = [];   // pending setTimeout callbacks (we flush them manually)
const store = new Map();

class FakeWS {
  static OPEN = 1;
  static CLOSED = 3;
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    this.listeners = { open: [], message: [], error: [], close: [] };
    dialed.push(this);
  }
  addEventListener(type, cb) { this.listeners[type].push(cb); }
  send(data) { this.sent.push(data); }
  close() { this._drop(); }                 // browser close() ends in a 'close' event
  _fire(type, ev) { for (const cb of this.listeners[type].slice()) cb(ev); }
  _open() { this.readyState = 1; this._fire('open'); }
  _message(obj) { this._fire('message', { data: JSON.stringify(obj) }); }
  _drop() { if (this.readyState === 3) return; this.readyState = 3; this._fire('close'); }
}

globalThis.WebSocket = FakeWS;
globalThis.location = { protocol: 'https:', host: 'game.example' };
globalThis.sessionStorage = {
  getItem: (k) => (store.has(k) ? store.get(k) : null),
  setItem: (k, v) => store.set(k, String(v)),
  removeItem: (k) => store.delete(k),
};
globalThis.setTimeout = (cb, delay) => { const t = { cb, delay, cleared: false }; timers.push(t); return t; };
globalThis.clearTimeout = (t) => { if (t) t.cleared = true; };
const flushTimers = () => { const pend = timers.filter((t) => !t.cleared); timers = []; pend.forEach((t) => t.cb()); };
const reset = () => { dialed = []; timers = []; store.clear(); };

const Net = await import('../src/net.js');

// ---- tiny test harness (mirrors the other test files) ----------------------
let passed = 0;
const failures = [];
function test(name, fn) {
  reset();
  try { fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push([name, e]); console.log(`FAIL  ${name}\n      ${e.message}`); }
}

// ===========================================================================
test('an unexpected drop auto-reconnects with the saved token', () => {
  const events = [];
  const conn = Net.connect('ABCD', {
    onOpen: () => events.push('open'),
    onWelcome: (m) => events.push('welcome:' + m.you),
    onReconnecting: (i) => events.push(`reconnecting:${i.attempt}:${i.delay}`),
  });
  assert.equal(dialed.length, 1, 'dials once on connect');
  const ws1 = dialed[0];
  assert.ok(!ws1.url.includes('token='), 'first dial carries no token');

  ws1._open();
  ws1._message({ type: 'welcome', you: 2, token: 'TKN', code: 'ABCD' });
  assert.equal(store.get('fogsite.token.ABCD'), 'TKN', 'welcome token is persisted');

  ws1._drop(); // wifi blip — not a user close()
  assert.deepEqual(events.filter((e) => e.startsWith('reconnecting')), ['reconnecting:1:500']);
  assert.equal(dialed.length, 1, 'no redial until the backoff timer fires');

  flushTimers();
  assert.equal(dialed.length, 2, 'redialed after backoff');
  assert.ok(dialed[1].url.includes('token=TKN'), 'reconnect presents the saved token to restore the seat');

  // a successful reopen must reset the backoff counter
  dialed[1]._open();
  dialed[1]._drop();
  const recon = events.filter((e) => e.startsWith('reconnecting'));
  assert.equal(recon[recon.length - 1], 'reconnecting:1:500', 'backoff resets after a successful open');
});

test('backoff grows on consecutive failures and caps', () => {
  const delays = [];
  Net.connect('WXYZ', { onReconnecting: (i) => delays.push(i.delay) });
  let ws = dialed[0];
  for (let n = 0; n < 6; n++) { ws._drop(); flushTimers(); ws = dialed[dialed.length - 1]; }
  assert.deepEqual(delays.slice(0, 6), [500, 1000, 2000, 4000, 8000, 10000], 'capped exponential backoff');
});

test('a deliberate close() never reconnects', () => {
  let reconnecting = 0;
  const conn = Net.connect('STOP', { onReconnecting: () => { reconnecting++; } });
  dialed[0]._open();
  conn.close();           // user left the room
  flushTimers();
  assert.equal(reconnecting, 0, 'no reconnect scheduled');
  assert.equal(dialed.length, 1, 'no new socket dialed after a deliberate close');
});

test('routes welcome / state / result / error to handlers', () => {
  const got = {};
  Net.connect('MSG', {
    onWelcome: (m) => { got.welcome = m; },
    onState: (s) => { got.state = s; },
    onResult: (r) => { got.result = r; },
    onError: (e) => { got.error = e; },
  });
  const ws = dialed[0]; ws._open();
  ws._message({ type: 'welcome', you: 1, token: 'T', code: 'MSG' });
  ws._message({ type: 'state', state: { phase: 'playing' } });
  ws._message({ type: 'result', result: { kind: 'explore', outcome: 'room' } });
  ws._message({ type: 'error', error: 'illegal' });
  assert.equal(got.welcome.you, 1);
  assert.equal(got.state.phase, 'playing');
  assert.equal(got.result.kind, 'explore');
  assert.equal(got.error.error, 'illegal');
});

test('send() only transmits while the socket is open', () => {
  const conn = Net.connect('SND', {});
  const ws = dialed[0];
  conn.send({ type: 'pass' });          // before open
  assert.equal(ws.sent.length, 0, 'nothing sent before open');
  ws._open();
  conn.send({ type: 'pass' });
  assert.equal(ws.sent.length, 1);
  assert.deepEqual(JSON.parse(ws.sent[0]), { type: 'pass' });
});

// ===========================================================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
