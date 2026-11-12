import assert from 'node:assert/strict';
import test from 'node:test';
import worker, { Room } from '../worker/index.js';
import { createRoom } from '../server/room.js';
import { COLORS, MODE } from '../src/rules.js';
import { generateMaze, makeRng } from '../src/maze.js';

function routerEnv(allow) {
  const calls = [];
  return { calls, ...(allow === undefined ? {} : { ALLOWED_ORIGINS: allow }), ROOMS: {
    idFromName(code) { calls.push(code); return code; },
    get() { return { async fetch(req) {
      return Response.json(req.url.includes('__init') ? { created: true } : { exists: true });
    } }; },
  } };
}
function request(path, origin, method = 'GET') {
  return new Request(`https://fog.example${path}`, { method, headers: {
    ...(origin === undefined ? {} : { Origin: origin }),
    ...(path.startsWith('/ws') ? { Upgrade: 'websocket' } : {}),
  } });
}

test('Worker mutations reject foreign, missing and opaque origins before contacting a room', async () => {
  for (const [path, method] of [['/api/rooms', 'POST'], ['/ws?code=TEST', 'GET']]) {
    for (const origin of [undefined, 'null', 'https://evil.example', 'https://fog.example.evil.test', 'https://fog.example/path']) {
      const env = routerEnv();
      const r = await worker.fetch(request(path, origin, method), env);
      assert.equal(r.status, 403, `${method} ${path}, origin ${origin}`);
      assert.deepEqual(env.calls, []);
    }
    const env = routerEnv();
    assert.equal((await worker.fetch(request(path, 'https://fog.example', method), env)).status, 200);
    assert.equal(env.calls.length, 1);
  }
});

test('explicit origin lists are exact and malformed configuration fails closed', async () => {
  for (const path of ['/ws?code=TEST', '/api/rooms']) {
    const method = path === '/api/rooms' ? 'POST' : 'GET';
    const env = routerEnv(' https://ui.example, http://localhost:5174 ');
    assert.equal((await worker.fetch(request(path, 'https://ui.example', method), env)).status, 200);
    assert.equal((await worker.fetch(request(path, 'http://localhost:5174', method), env)).status, 200);
    assert.equal((await worker.fetch(request(path, 'https://fog.example', method), env)).status, 403);
    for (const bad of ['*', 'null', 'https://ui.example/path', 'https://ui.example,garbage', 'https://user:pass@ui.example', 'file:///tmp', 'https://ui.example/', 123]) {
      const invalid = routerEnv(bad);
      assert.equal((await worker.fetch(request(path, 'https://fog.example', method), invalid)).status, 403, String(bad));
      assert.deepEqual(invalid.calls, []);
    }
  }
});

test('invalid room codes do not create Durable Object lookups or throw on malformed escapes', async () => {
  for (const path of ['/api/rooms/', '/api/rooms/%', '/api/rooms/%2fTEST', '/api/rooms/TOOLONG', '/api/rooms/AB01', '/ws', '/ws?code=__proto__', '/ws?code=AB01', '/ws?code=abc']) {
    const env = routerEnv();
    const r = await worker.fetch(request(path, 'https://fog.example'), env);
    assert.equal(r.status, 400, path);
    assert.deepEqual(env.calls, []);
  }
  const methodEnv = routerEnv();
  assert.equal((await worker.fetch(request('/ws?code=TEST', 'https://fog.example', 'POST'), methodEnv)).status, 405);
  assert.deepEqual(methodEnv.calls, []);
  for (const path of ['/api/rooms/test', '/ws?code=test']) {
    const env = routerEnv();
    assert.equal((await worker.fetch(request(path, 'https://fog.example'), env)).status, 200);
    assert.deepEqual(env.calls, ['TEST']);
  }
});

function durableState() {
  const data = new Map([['room', createRoom('TEST')], ['seats', { tokens: {}, pidToToken: {}, nextPid: 0 }]]);
  const sockets = [];
  let alarm = null;
  return { data, sockets, getWebSockets: () => sockets, acceptWebSocket: (ws) => sockets.push(ws),
    storage: {
      get: async (keys) => new Map(keys.map((k) => [k, structuredClone(data.get(k))])),
      put: async (value) => { for (const [k, v] of Object.entries(value)) data.set(k, structuredClone(v)); },
      getAlarm: async () => alarm, setAlarm: async (value) => { alarm = value; }, deleteAlarm: async () => { alarm = null; },
    },
  };
}
function installRuntime(t) {
  const NativeResponse = globalThis.Response, NativePair = globalThis.WebSocketPair;
  globalThis.Response = class extends NativeResponse {
    constructor(body, init) {
      if (init?.status === 101) { super(null); this.clientSocket = init.webSocket; }
      else super(body, init);
    }
  };
  globalThis.WebSocketPair = class {
    constructor() {
      this[0] = {};
      this[1] = { messages: [], closes: [],
        send(raw) { this.messages.push(JSON.parse(raw)); },
        serializeAttachment(att) { this.att = structuredClone(att); },
        deserializeAttachment() { return structuredClone(this.att); },
        close(code, reason) { this.closes.push({ code, reason }); },
      };
    }
  };
  t.after(() => {
    globalThis.Response = NativeResponse;
    if (NativePair === undefined) delete globalThis.WebSocketPair;
    else globalThis.WebSocketPair = NativePair;
  });
}
async function connect(room, state, token) {
  await room.fetch(new Request(`https://do/ws${token ? `?token=${token}` : ''}`, { headers: { Upgrade: 'websocket' } }));
  return state.sockets.at(-1);
}

test('replaced Durable Object sockets cannot act or receive state, including after hibernation', async (t) => {
  installRuntime(t);
  const state = durableState();
  let room = new Room(state, {});
  const old = await connect(room, state);
  const welcome = old.messages[0];
  const current = await connect(room, state, welcome.token);
  assert.equal(current.messages[0].you, welcome.you);
  assert.ok(old.closes.length > 0);
  const before = structuredClone(state.data.get('room'));
  const oldMessageCount = old.messages.length;
  room = new Room(state, {});
  await room.webSocketMessage(old, JSON.stringify({ type: 'join', role: 'guardian' }));
  assert.deepEqual(state.data.get('room'), before);
  await room.webSocketClose(old);
  await room.webSocketError(old);
  await room.webSocketMessage(current, JSON.stringify({ type: 'join', role: 'guardian' }));
  assert.equal(state.data.get('room').players[welcome.you].role, 'guardian');
  assert.equal(old.messages.length, oldMessageCount, 'old socket must receive neither state nor errors');
  assert.equal(current.messages.at(-1).state.role, 'guardian');
  assert.ok(!JSON.stringify(current.messages.at(-1)).includes(welcome.token));
  await room.webSocketClose(current, 1006);
  assert.equal(current.closes.at(-1)?.code, 1000);
  await room.webSocketMessage(current, JSON.stringify({ type: 'join', role: 'investigator', color: 'red' }));
  assert.equal(state.data.get('room').players[welcome.you].role, 'guardian');
  const reconnect = await connect(room, state, welcome.token);
  assert.equal(reconnect.messages[0].you, welcome.you, 'closing a connection preserves reconnect credentials');
});

test('Durable Object payload limit measures UTF-8 bytes and rejects binary corruption without mutation', async (t) => {
  installRuntime(t);
  const state = durableState(), room = new Room(state, {});
  const ws = await connect(room, state);
  const before = structuredClone(state.data.get('room'));
  await room.webSocketMessage(ws, '{');
  assert.match(ws.messages.at(-1).error, /malformed/);
  const invalidUtf8 = new TextEncoder().encode(JSON.stringify({ type: 'join', role: 'guardian', name: 'X' }));
  invalidUtf8[invalidUtf8.indexOf(88)] = 0xff; // valid JSON framing but invalid UTF-8 in a string
  await room.webSocketMessage(ws, invalidUtf8.buffer);
  assert.match(ws.messages.at(-1).error, /malformed/);
  assert.deepEqual(state.data.get('room'), before);
  await room.webSocketMessage(ws, JSON.stringify({ type: 'join', role: 'guardian', ignored: '中'.repeat(22000) }));
  assert.deepEqual(state.data.get('room'), before);
  assert.equal(ws.closes.at(-1)?.code, 1009);
  const fresh = await connect(room, state, ws.messages[0].token);
  await room.webSocketMessage(fresh, new Uint8Array(65537).buffer);
  assert.equal(fresh.closes.at(-1)?.code, 1009);
  assert.deepEqual(state.data.get('room'), before);
  const valid = await connect(room, state, ws.messages[0].token);
  const plain = JSON.stringify({ type: 'join', role: 'guardian', padding: '' });
  const message = JSON.stringify({ type: 'join', role: 'guardian', padding: ' '.repeat(65536 - new TextEncoder().encode(plain).byteLength) });
  assert.equal(new TextEncoder().encode(message).byteLength, 65536);
  await room.webSocketMessage(valid, new TextEncoder().encode(message).buffer);
  assert.equal(state.data.get('room').players[valid.messages[0].you].role, 'guardian');
});


test('guardian clients cannot trigger server-owned escape timeout, but the durable alarm can', async (t) => {
  installRuntime(t);
  const state = durableState();
  let room = new Room(state, {});
  const guardian = await connect(room, state);
  const investigators = [];
  const send = (ws, action) => room.webSocketMessage(ws, JSON.stringify(action));
  await send(guardian, { type: 'join', role: 'guardian' });
  for (const color of COLORS) {
    const ws = await connect(room, state);
    investigators.push(ws);
    await send(ws, { type: 'join', role: 'investigator', color });
  }
  await send(guardian, { type: 'configure', count: 3,
    characters: { red: 'monk', green: 'doctor', blue: 'guide' },
    maze: generateMaze(COLORS, makeRng(12345)),
  });
  await send(guardian, { type: 'start' });
  for (const ws of investigators) await send(ws, { type: 'pass' });
  const before = structuredClone(state.data.get('room'));
  assert.equal(before.game.mode, MODE.ESCAPE_DECISION);
  const deadline = await state.storage.getAlarm();
  assert.ok(deadline > Date.now() + 59000);
  room = new Room(state, {}); // authorization also holds after hibernation
  await send(guardian, { type: 'escape_timeout' });
  assert.equal(state.data.get('room').game.mode, MODE.ESCAPE_DECISION, 'client must not shorten the server countdown');
  assert.match(guardian.messages.at(-1).error, /server-only/);
  assert.deepEqual(state.data.get('room'), before);
  assert.equal(await state.storage.getAlarm(), deadline);
  const nativeNow = Date.now;
  Date.now = () => deadline;
  try { await room.alarm(); } finally { Date.now = nativeNow; }
  assert.equal(state.data.get('room').game.mode, MODE.PREDICTION);
  assert.equal(state.data.get('room').escape, null);
  assert.equal(await state.storage.getAlarm(), null);
  assert.equal(guardian.messages.at(-1).state.view.mode, MODE.PREDICTION);
});
