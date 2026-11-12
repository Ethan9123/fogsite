import assert from 'node:assert/strict';
import test from 'node:test';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { startServer } from '../server/ws.mjs';
import { Room } from '../worker/index.js';
import { createRoom, applyAction } from '../server/room.js';
import { COLORS } from '../src/rules.js';
import { generateMaze, makeRng } from '../src/maze.js';

function connect(url) {
  const ws = new WebSocket(url), messages = [], waiters = [];
  ws.on('message', (raw) => {
    const msg = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(msg));
    if (i < 0) messages.push(msg);
    else { const [w] = waiters.splice(i, 1); clearTimeout(w.timer); w.resolve(msg); }
  });
  return { ws, opened: once(ws, 'open'), send: (action) => ws.send(JSON.stringify(action)),
    next(pred) {
      const i = messages.findIndex(pred);
      if (i >= 0) return Promise.resolve(messages.splice(i, 1)[0]);
      return new Promise((resolve, reject) => {
        const w = { pred, resolve, timer: setTimeout(() => reject(new Error('message timeout')), 3000) };
        waiters.push(w);
      });
    },
  };
}

test('malformed JSON/configuration and a bad WebSocket frame do not kill the lobby', async () => {
  const server = await startServer(0);
  try {
    const base = `http://localhost:${server.port}`;
    const { code } = await (await fetch(base + '/api/rooms', { method: 'POST' })).json();
    const client = connect(`ws://localhost:${server.port}/ws?code=${code}`);
    await client.opened;
    const welcome = await client.next((m) => m.type === 'welcome');
    client.send({ type: 'join', role: 'guardian' });
    await client.next((m) => m.type === 'state' && m.state.role === 'guardian');
    client.ws.send('{');
    assert.match((await client.next((m) => m.type === 'error')).error, /malformed/);
    client.send({ type: 'configure', count: 3, maze: {}, characters: {} });
    assert.match((await client.next((m) => m.type === 'error')).error, /maze/);
    const closed = once(client.ws, 'close');
    // RFC 6455 requires masked client frames. This triggers a server-side `error`.
    client.ws._socket.write(Buffer.from([0x81, 0x01, 0x78]));
    await closed;
    assert.equal((await fetch(base + '/api/rooms/' + code)).status, 200);
    const recovered = connect(`ws://localhost:${server.port}/ws?code=${code}&token=${welcome.token}`);
    await recovered.opened;
    const restored = await recovered.next((m) => m.type === 'state');
    assert.equal(restored.state.you, welcome.you);
    assert.equal(restored.state.role, 'guardian');
    recovered.ws.close();
  } finally { await server.close(); }
});

test('replaced sockets cannot submit queued actions after reconnect', async () => {
  const server = await startServer(0);
  try {
    const { code } = await (await fetch(`http://localhost:${server.port}/api/rooms`, { method: 'POST' })).json();
    const a = connect(`ws://localhost:${server.port}/ws?code=${code}`); await a.opened;
    const first = await a.next((m) => m.type === 'welcome');
    const entry = server.rooms.get(code), oldServerSocket = entry.clients.get(first.you);
    const b = connect(`ws://localhost:${server.port}/ws?code=${code}&token=${first.token}`); await b.opened;
    await b.next((m) => m.type === 'welcome');
    oldServerSocket.emit('message', Buffer.from(JSON.stringify({ type: 'join', role: 'guardian' })));
    assert.equal(Object.keys(entry.room.players).length, 0);
    b.send({ type: 'join', role: 'guardian' });
    await b.next((m) => m.type === 'state' && m.state.role === 'guardian');
    b.ws.close();
  } finally { await server.close(); }
});

function durableState(room) {
  const data = new Map([['room', structuredClone(room)], ['seats', { tokens: {}, pidToToken: {}, nextPid: 4 }]]);
  let alarm = null;
  const sockets = [];
  return { data, sockets, getWebSockets: () => sockets,
    storage: {
      get: async (keys) => new Map(keys.map((key) => [key, structuredClone(data.get(key))])),
      put: async (value) => { for (const [key, v] of Object.entries(value)) data.set(key, structuredClone(v)); },
      getAlarm: async () => alarm, setAlarm: async (value) => { alarm = value; }, deleteAlarm: async () => { alarm = null; },
    },
  };
}
function workerSocket(pid) {
  return { messages: [], deserializeAttachment: () => ({ pid }), send(raw) { this.messages.push(JSON.parse(raw)); } };
}

test('Durable Object transport rejects malformed actions and preserves state across reload', async () => {
  const room = createRoom('TEST');
  applyAction(room, 0, { type: 'join', role: 'guardian' });
  COLORS.forEach((color, i) => applyAction(room, i + 1, { type: 'join', role: 'investigator', color }));
  const state = durableState(room), guardian = workerSocket(0), red = workerSocket(1);
  state.sockets.push(guardian, red);
  let worker = new Room(state, {});
  const send = (ws, action) => worker.webSocketMessage(ws, JSON.stringify(action));
  await send(guardian, { type: 'configure', count: 3, maze: {}, characters: {} });
  assert.equal(guardian.messages.at(-2).type, 'error');
  assert.deepEqual(state.data.get('room'), room);
  await send(guardian, { type: 'configure', count: 3, characters: { red: 'monk', green: 'doctor', blue: 'guide' }, maze: generateMaze(COLORS, makeRng(12345)) });
  await send(guardian, { type: 'start' });
  const started = structuredClone(state.data.get('room'));
  await send(red, { type: 'ability', params: {} });
  assert.equal(red.messages.at(-2).type, 'error');
  assert.deepEqual(state.data.get('room'), started);
  worker = new Room(state, {}); // model hibernation losing all in-memory state
  await send(red, { type: 'ability', params: { dir: 'N' } });
  assert.equal(state.data.get('room').game.inv.red.laidDown, true);
  const redState = red.messages.at(-1).state;
  assert.ok(!JSON.stringify(redState).includes('green'));
  assert.ok(!JSON.stringify(redState).includes('blue'));
});

test('Durable Object reconnect tokens must be own entries, not Object prototype names', async () => {
  const state = durableState(createRoom('TEST'));
  state.acceptWebSocket = (ws) => state.sockets.push(ws);
  const NativeResponse = globalThis.Response;
  const NativePair = globalThis.WebSocketPair;
  globalThis.Response = class extends NativeResponse {
    constructor(body, init) {
      if (init?.status === 101) { super(null); this.clientSocket = init.webSocket; }
      else super(body, init);
    }
  };
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = {};
      this[1] = { messages: [], send(raw) { this.messages.push(JSON.parse(raw)); },
        serializeAttachment(att) { this.att = att; }, deserializeAttachment() { return this.att; }, close() {} };
    }
  };
  try {
    const worker = new Room(state, {});
    for (const token of ['constructor', '__proto__', 'toString']) {
      await worker.fetch(new Request(`https://do/ws?token=${token}`, { headers: { Upgrade: 'websocket' } }));
      const welcome = state.sockets.at(-1).messages[0];
      assert.equal(typeof welcome.you, 'number');
      assert.equal(typeof welcome.token, 'string');
      assert.ok(welcome.token.length > 0);
    }
    const initial = state.sockets[0].messages[0];
    await worker.fetch(new Request(`https://do/ws?token=${initial.token}`, { headers: { Upgrade: 'websocket' } }));
    assert.equal(state.sockets.at(-1).messages[0].you, initial.you);
  } finally {
    globalThis.Response = NativeResponse;
    if (NativePair === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = NativePair;
  }
});
