// Drive the real UI event handlers and net client without a browser dependency.
// This checks dispatch and rendered output; it is not a visual/layout test.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createRoom, applyAction, viewFor } from '../server/room.js';
import { COLORS } from '../src/rules.js';
import { generateMaze, makeRng } from '../src/maze.js';
const listeners = {};
const app = { innerHTML: '', addEventListener: (type, fn) => { listeners[type] = fn; } };
const clock = { innerHTML: '' };
globalThis.document = { getElementById: (id) => id === 'app' ? app : id === 'clock' ? clock : null };
globalThis.location = { protocol: 'http:', host: 'localhost' };
const store = new Map();
globalThis.sessionStorage = { getItem: (k) => store.get(k), setItem: (k, v) => store.set(k, v) };
let sockets = [];
class FakeWS {
  static OPEN = 1;
  constructor() { this.readyState = 1; this.listeners = {}; sockets.push(this); }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  send() {}
  close() { this.readyState = 3; this.listeners.close?.(); }
  state(state) { this.listeners.message({ data: JSON.stringify({ type: 'state', state }) }); }
}
globalThis.WebSocket = FakeWS;
globalThis.fetch = async () => ({ ok: true, json: async () => ({ code: 'TEST', exists: true }) });
await import('../src/ui.js');
const click = (act, data = {}) => listeners.click({ target: { closest: () => ({ dataset: { act, ...data } }) } });
const settle = () => new Promise((resolve) => setImmediate(resolve));
function started() {
  const room = createRoom('TEST');
  applyAction(room, 0, { type: 'join', role: 'guardian' });
  COLORS.forEach((color, i) => applyAction(room, i + 1, { type: 'join', role: 'investigator', color }));
  applyAction(room, 0, { type: 'configure', count: 3, characters: { red: 'guide', green: 'monk', blue: 'doctor' }, maze: generateMaze(COLORS, makeRng(12345)) });
  applyAction(room, 0, { type: 'start' });
  return room;
}

test('late join gets an explanation and can leave, then seated clients still render', async () => {
  click('mode-online'); click('o-create'); await settle();
  const room = started(), socket = sockets.at(-1);
  assert.doesNotThrow(() => socket.state(viewFor(room, 99)));
  assert.match(app.innerHTML, /没有座位/);
  assert.match(app.innerHTML, /o-menu/);
  assert.equal(clock.innerHTML, '');
  socket.state(viewFor(room, 1));
  assert.match(app.innerHTML, /向导/);
  click('o-inv-mode', { mode: 'ability' });
  assert.match(app.innerHTML, /data-color="green"/);
  assert.match(app.innerHTML, /data-color="blue"/);
  for (const pid of [1, 2, 3]) applyAction(room, pid, { type: 'pass' });
  applyAction(room, 2, { type: 'escape_confirm' });
  socket.state(viewFor(room, 1));
  assert.match(app.innerHTML, /1\/3 人/);
  socket.state(viewFor(room, 0));
  assert.match(app.innerHTML, /遗迹役/);
  click('o-menu');
  assert.equal(socket.readyState, 3);
  assert.match(app.innerHTML, /选择游戏模式/);
  socket.state(viewFor(room, 99)); // queued event from a closed room
  assert.match(app.innerHTML, /选择游戏模式/);
});

test('leaving while create is pending cancels UI handoff; repeated create is deduplicated', async () => {
  let finish, calls = 0;
  globalThis.fetch = () => { calls++; return new Promise((resolve) => { finish = resolve; }); };
  const before = sockets.length;
  click('mode-online'); click('o-create'); click('o-create');
  assert.equal(calls, 1);
  click('o-menu');
  finish({ ok: true, json: async () => ({ code: 'LATE' }) });
  await settle();
  assert.equal(sockets.length, before);
  assert.match(app.innerHTML, /选择游戏模式/);
});
