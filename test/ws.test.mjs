// FOGSITE WebSocket-server integration test — run with: node test/ws.test.mjs
// Boots the real server on an ephemeral port, creates a room over HTTP, connects
// four ws clients, plays the lobby->game handoff, and asserts: each client only
// ever receives its OWN projected view; entering the escape phase pushes a real
// server-set deadline; a token reconnect restores the same seat and view.
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { COLORS } from '../src/rules.js';
import { generateMaze, makeRng } from '../src/maze.js';
import { startServer } from '../server/ws.mjs';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok  ${name}`); }
  catch (e) { failures.push([name, e]); console.log(`FAIL  ${name}\n      ${e.message}`); }
}

const withTimeout = (p, ms, label) => Promise.race([
  p,
  new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout waiting for ${label}`)), ms)),
]);

// A small message-queue wrapper so tests can await a specific message.
function connect(url) {
  const ws = new WebSocket(url);
  const queue = [];
  const waiters = [];
  ws.on('message', (d) => {
    const msg = JSON.parse(d.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i >= 0) { const [w] = waiters.splice(i, 1); w.resolve(msg); }
    else queue.push(msg);
  });
  return {
    ws,
    opened: new Promise((res, rej) => { ws.once('open', res); ws.once('error', rej); }),
    send: (o) => ws.send(JSON.stringify(o)),
    waitFor: (pred, label = 'message') => {
      const i = queue.findIndex(pred);
      if (i >= 0) { const [m] = queue.splice(i, 1); return Promise.resolve(m); }
      return withTimeout(new Promise((resolve) => waiters.push({ pred, resolve })), 4000, label);
    },
    close: () => ws.close(),
  };
}

// ===========================================================================
await test('4 clients join, start, and each receives only its own view; reconnect restores seat', async () => {
  const srv = await startServer(0);
  const base = `http://localhost:${srv.port}`;
  const wsUrl = (qs) => `ws://localhost:${srv.port}/ws?${qs}`;
  try {
    // create a room over the lobby HTTP API
    const created = await (await fetch(`${base}/api/rooms`, { method: 'POST' })).json();
    assert.match(created.code, /^[A-Z2-9]{4}$/);
    const code = created.code;

    // connect four players
    const G = connect(wsUrl(`code=${code}`));
    const R = connect(wsUrl(`code=${code}`));
    const Gr = connect(wsUrl(`code=${code}`));
    const B = connect(wsUrl(`code=${code}`));
    await Promise.all([G.opened, R.opened, Gr.opened, B.opened]);

    const gWelcome = await G.waitFor((m) => m.type === 'welcome', 'guardian welcome');
    const rWelcome = await R.waitFor((m) => m.type === 'welcome', 'red welcome');
    await Gr.waitFor((m) => m.type === 'welcome', 'green welcome');
    await B.waitFor((m) => m.type === 'welcome', 'blue welcome');
    assert.ok(typeof gWelcome.token === 'string' && gWelcome.token.length > 0);

    // claim seats
    G.send({ type: 'join', role: 'guardian', name: 'GM' });
    R.send({ type: 'join', role: 'investigator', color: 'red' });
    Gr.send({ type: 'join', role: 'investigator', color: 'green' });
    B.send({ type: 'join', role: 'investigator', color: 'blue' });

    // joins land over four independent sockets in any order; the guardian waits
    // until every seat is filled before starting (as the real lobby UI will).
    const seatsComplete = (seats) => {
      const vals = Object.values(seats);
      const cols = new Set(vals.filter((s) => s.role === 'investigator').map((s) => s.color));
      return vals.some((s) => s.role === 'guardian') && ['red', 'green', 'blue'].every((c) => cols.has(c));
    };
    await G.waitFor((m) => m.type === 'state' && seatsComplete(m.state.seats), 'all seats filled');

    // guardian configures + starts
    const maze = generateMaze(COLORS, makeRng(12345));
    G.send({ type: 'configure', count: 3, characters: { red: 'monk', green: 'doctor', blue: 'guide' }, guardianName: 'GM', maze });
    G.send({ type: 'start' });

    // each client should receive a 'playing' state that is only its own view
    const gPlay = await G.waitFor((m) => m.type === 'state' && m.state.phase === 'playing', 'guardian playing state');
    const rPlay = await R.waitFor((m) => m.type === 'state' && m.state.phase === 'playing', 'red playing state');

    assert.equal(gPlay.state.role, 'guardian');
    assert.equal(gPlay.state.view.grid.length, 5); // guardian sees full 5x5 truth

    assert.equal(rPlay.state.role, 'investigator');
    assert.equal(rPlay.state.color, 'red');
    assert.equal(rPlay.state.view.role, 'investigator');
    const rJson = JSON.stringify(rPlay.state.view);
    assert.ok(!rJson.includes('green') && !rJson.includes('blue'), 'teammate leaked to red');
    assert.ok(!rJson.includes('chamber'), 'maze truth leaked to red');

    // ---- escape phase pushes a server-owned deadline ----
    R.send({ type: 'pass' });
    Gr.send({ type: 'pass' });
    B.send({ type: 'pass' });
    const esc = await G.waitFor((m) => m.type === 'state' && m.state.escape && m.state.escape.deadline, 'escape deadline');
    assert.ok(esc.state.escape.deadline > Date.now(), 'escape deadline should be in the future');

    // ---- token reconnect restores red's seat and view ----
    R.close();
    const R2 = connect(wsUrl(`code=${code}&token=${rWelcome.token}`));
    await R2.opened;
    const r2Welcome = await R2.waitFor((m) => m.type === 'welcome', 'red reconnect welcome');
    assert.equal(r2Welcome.you, rWelcome.you, 'reconnect should reuse the same player id');
    const r2State = await R2.waitFor((m) => m.type === 'state' && m.state.role === 'investigator', 'red reconnect state');
    assert.equal(r2State.state.color, 'red');

    G.close(); Gr.close(); B.close(); R2.close();
  } finally {
    await srv.close();
  }
});

// ===========================================================================
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
