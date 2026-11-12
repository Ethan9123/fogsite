// FOGSITE — Cloudflare Workers + Durable Objects deploy adapter.
//
// This is the production transport. It is the *exact* analogue of the Node
// `server/ws.mjs` server, but written against the Workers runtime instead of
// node:http + the `ws` package:
//
//   - One Durable Object instance == one room (addressed by room code).
//   - The DO reuses the SAME authoritative core (`server/room.js`) and the SAME
//     secrecy boundary (`viewFor`) — no rules, no projection logic lives here.
//   - WebSockets use the Hibernation API, so a room with idle players costs
//     nothing: the DO is evicted from memory while sockets stay open, then woken
//     on the next message. Because hibernation wipes in-memory state, the room
//     and seat tables are persisted to DO storage and reloaded on demand.
//   - The 60s escape window is owned by a DO alarm (the durable equivalent of
//     the setTimeout in ws.mjs), so it survives hibernation.
//
// The default export is a normal Worker `fetch` handler that serves the lobby
// HTTP API, routes /ws upgrades to the right room DO (same-origin by default,
// or an explicit origin allowlist), and otherwise serves the static client via the
// Assets binding.
import { createRoom, applyAction, viewFor, ESCAPE_SECONDS } from '../server/room.js';
import { TYPES as MSG } from '../server/protocol.js';
import { MODE } from '../src/rules.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars
const token = () => crypto.randomUUID().replace(/-/g, '');
const VALID_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{4}$/;
const MAX_MESSAGE_BYTES = 64 * 1024;

// An Origin is a serialized origin, not a URL prefix, path, wildcard or opaque
// origin. An invalid configured entry must not silently enable a fallback.
function validOrigin(value) {
  if (typeof value !== 'string') return false;
  try {
    const u = new URL(value);
    return (u.protocol === 'https:' || u.protocol === 'http:') && u.origin === value;
  } catch { return false; }
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!validOrigin(origin)) return false;
  const configured = env.ALLOWED_ORIGINS;
  if (configured !== undefined && typeof configured !== 'string') return false;
  if (!configured?.trim()) return origin === new URL(request.url).origin;
  const allow = configured.split(',').map((s) => s.trim());
  return allow.every(validOrigin) && allow.includes(origin);
}

function roomCode() {
  const b = new Uint8Array(4);
  crypto.getRandomValues(b);
  let s = '';
  for (let i = 0; i < 4; i++) s += CODE_ALPHABET[b[i] % CODE_ALPHABET.length];
  return s;
}

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json; charset=utf-8' } });

function roomStub(env, code) {
  return env.ROOMS.get(env.ROOMS.idFromName(code));
}

// ---------------------------------------------------------------------------
// Worker entry — lobby API, /ws routing, static assets.
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      if (!allowedOrigin(request, env)) return new Response('forbidden origin', { status: 403 });
      // Allocate a fresh, unused code by asking candidate DOs to initialise.
      for (let i = 0; i < 6; i++) {
        const code = roomCode();
        const r = await roomStub(env, code).fetch(new Request(`https://do/__init?code=${code}`, { method: 'POST' }));
        if (r.ok && (await r.json()).created) return json({ code });
      }
      return json({ error: 'could not allocate a room code' }, 503);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/rooms/')) {
      let code;
      try { code = decodeURIComponent(url.pathname.slice('/api/rooms/'.length)).toUpperCase(); }
      catch { return json({ error: 'invalid room code' }, 400); }
      if (!VALID_CODE.test(code)) return json({ error: 'invalid room code' }, 400);
      const r = await roomStub(env, code).fetch(new Request('https://do/__exists'));
      const body = await r.json();
      return json(body, body.exists ? 200 : 404);
    }

    if (url.pathname === '/ws') {
      if (request.method !== 'GET') return new Response('method not allowed', { status: 405 });
      if (!allowedOrigin(request, env)) return new Response('forbidden origin', { status: 403 });
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!VALID_CODE.test(code)) return new Response('invalid room code', { status: 400 });
      return roomStub(env, code).fetch(request);
    }

    // Everything else is the static client (served first by the Assets binding
    // when present; this is the fallback when the Worker is invoked directly).
    if (env.ASSETS) return env.ASSETS.fetch(request);
    return new Response('not found', { status: 404 });
  },
};

// ---------------------------------------------------------------------------
// Room — one Durable Object per room code. Mirrors the per-room `entry` in
// ws.mjs (room + token/seat tables) but persists it so it survives hibernation.
// ---------------------------------------------------------------------------
export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.room = null;  // authoritative room (server/room.js)
    this.seats = null; // { tokens: {token: pid}, pidToToken: {pid: token}, nextPid }
  }

  async load() {
    if (this.room && this.seats) return;
    const m = await this.state.storage.get(['room', 'seats']);
    this.room = m.get('room') ?? null;
    this.seats = m.get('seats') ?? { tokens: {}, pidToToken: {}, connectionIds: {}, nextPid: 0 };
    this.seats.connectionIds ??= {};
  }

  async persist() {
    await this.state.storage.put({ room: this.room, seats: this.seats });
  }

  guardianPid() {
    if (!this.room) return null;
    for (const [id, p] of Object.entries(this.room.players)) if (p.role === 'guardian') return Number(id);
    return null;
  }

  send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }

  currentConnection(ws) {
    const att = ws.deserializeAttachment();
    return att && Number.isSafeInteger(att.pid) && att.pid >= 0 &&
      typeof att.connectionId === 'string' &&
      Object.hasOwn(this.seats.connectionIds, att.pid) &&
      this.seats.connectionIds[att.pid] === att.connectionId ? att : null;
  }

  async retireConnection(ws, code, reason) {
    const att = this.currentConnection(ws);
    if (att) {
      delete this.seats.connectionIds[att.pid];
      await this.persist();
    }
    if (code !== undefined) try { ws.close(code, reason); } catch {}
  }

  broadcast() {
    for (const ws of this.state.getWebSockets()) {
      const att = this.currentConnection(ws);
      if (att) this.send(ws, { type: 'state', state: viewFor(this.room, att.pid) });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();

    if (request.method === 'POST' && url.pathname === '/__init') {
      if (this.room) return json({ created: false });
      this.room = createRoom(url.searchParams.get('code'));
      this.seats = { tokens: {}, pidToToken: {}, connectionIds: {}, nextPid: 0 };
      await this.persist();
      return json({ created: true });
    }

    if (url.pathname === '/__exists') {
      return json(this.room ? { exists: true, phase: this.room.phase } : { exists: false });
    }

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
      if (!this.room) return new Response('no such room', { status: 404 });

      // Resolve the seat: reuse it on a valid reconnect token, else assign a new one.
      const reconnectToken = url.searchParams.get('token');
      let pid;
      if (reconnectToken && Object.hasOwn(this.seats.tokens, reconnectToken)) {
        pid = this.seats.tokens[reconnectToken];
        for (const old of this.state.getWebSockets()) {
          const a = old.deserializeAttachment();
          if (a && a.pid === pid) try { old.close(1000, 'reconnected'); } catch {}
        }
      } else {
        pid = this.seats.nextPid++;
        const t = token();
        this.seats.tokens[t] = pid;
        this.seats.pidToToken[pid] = t;
      }

      // A reconnect keeps the seat credential but replaces its active connection.
      // Persist before returning the upgrade so hibernation cannot resurrect the
      // old socket. Closing a socket alone does not discard already queued events.
      const connectionId = token();
      this.seats.connectionIds[pid] = connectionId;
      await this.persist();

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server); // enables hibernation
      server.serializeAttachment({ pid, connectionId });

      this.send(server, { type: 'welcome', you: pid, token: this.seats.pidToToken[pid], code: this.room.code });
      this.send(server, { type: 'state', state: viewFor(this.room, pid) });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {
    await this.load();
    const att = this.currentConnection(ws);
    if (!this.room || !att) {
      try { ws.close(1008, 'reconnect required'); } catch {}
      return;
    }
    const pid = att.pid;
    const byteLength = typeof message === 'string'
      ? (message.length > MAX_MESSAGE_BYTES ? message.length : new TextEncoder().encode(message).byteLength)
      : message.byteLength;
    if (byteLength > MAX_MESSAGE_BYTES) {
      await this.retireConnection(ws, 1009, 'message too large');
      return;
    }
    let action;
    try {
      const text = typeof message === 'string' ? message : new TextDecoder('utf-8', { fatal: true }).decode(message);
      action = JSON.parse(text);
    } catch { return this.send(ws, { type: 'error', error: 'malformed message' }); }

    // This message belongs only to the trusted Durable Object alarm. The core
    // accepts the guardian pid for timer callbacks, not as client permission to
    // shorten the investigators' server-owned escape countdown.
    if (action?.type === MSG.ESCAPE_TIMEOUT) {
      return this.send(ws, { type: 'error', error: 'server-only action' });
    }

    const res = applyAction(this.room, pid, action);
    if (res.error) {
      this.send(ws, { type: 'error', error: res.error });
      this.send(ws, { type: 'state', state: viewFor(this.room, pid) }); // keep this client in sync
      return;
    }
    if (res.result) this.send(ws, { type: 'result', result: res.result }); // private to the actor
    await this.manageEscapeAlarm();
    await this.persist();
    this.broadcast();
  }

  async webSocketClose(ws, code = 1000) {
    await this.load();
    // Revoke this connection only; an older socket's close must not revoke the
    // replacement, and the seat credential remains available for reconnect.
    // Older compatibility dates require the application to finish the close
    // handshake. Reserved synthetic codes cannot be sent on the wire.
    const closeCode = (code === 1000 || (code >= 1001 && code <= 1014 && ![1004, 1005, 1006].includes(code)) ||
      (code >= 3000 && code <= 4999)) ? code : 1000;
    await this.retireConnection(ws, closeCode, 'connection closed');
  }

  async webSocketError(ws) {
    await this.load();
    await this.retireConnection(ws, 1011, 'connection error');
  }

  // The escape window: the DO alarm is the durable analogue of ws.mjs's setTimeout.
  async manageEscapeAlarm() {
    const g = this.room.game;
    const inEscape = !!(g && g.mode === MODE.ESCAPE_DECISION && this.room.escape);
    const current = await this.state.storage.getAlarm();
    if (inEscape && current === null) {
      this.room.escape.deadline = Date.now() + ESCAPE_SECONDS * 1000;
      await this.state.storage.setAlarm(this.room.escape.deadline);
    } else if (!inEscape && current !== null) {
      await this.state.storage.deleteAlarm();
    }
  }

  async alarm() {
    await this.load();
    const g = this.room.game;
    if (!g || g.mode !== MODE.ESCAPE_DECISION) return;
    const gpid = this.guardianPid();
    if (gpid == null) return;
    applyAction(this.room, gpid, { type: MSG.ESCAPE_TIMEOUT }); // window elapsed without unanimity
    await this.manageEscapeAlarm();
    await this.persist();
    this.broadcast();
  }
}
