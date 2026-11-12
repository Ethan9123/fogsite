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
// HTTP API, routes /ws upgrades to the right room DO (behind an optional origin
// allowlist for production), and otherwise serves the static client via the
// Assets binding.
import { createRoom, applyAction, viewFor, ESCAPE_SECONDS } from '../server/room.js';
import { TYPES as MSG } from '../server/protocol.js';
import { MODE } from '../src/rules.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars
const token = () => crypto.randomUUID().replace(/-/g, '');

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
      // Allocate a fresh, unused code by asking candidate DOs to initialise.
      for (let i = 0; i < 6; i++) {
        const code = roomCode();
        const r = await roomStub(env, code).fetch(new Request(`https://do/__init?code=${code}`, { method: 'POST' }));
        if (r.ok && (await r.json()).created) return json({ code });
      }
      return json({ error: 'could not allocate a room code' }, 503);
    }

    if (request.method === 'GET' && url.pathname.startsWith('/api/rooms/')) {
      const code = decodeURIComponent(url.pathname.slice('/api/rooms/'.length)).toUpperCase();
      const r = await roomStub(env, code).fetch(new Request('https://do/__exists'));
      const body = await r.json();
      return json(body, body.exists ? 200 : 404);
    }

    if (url.pathname === '/ws') {
      // Production: only accept WebSocket upgrades from allowed origins.
      const allow = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
      if (allow.length) {
        const origin = request.headers.get('Origin') || '';
        if (!allow.includes(origin)) return new Response('forbidden origin', { status: 403 });
      }
      const code = (url.searchParams.get('code') || '').toUpperCase();
      if (!code) return new Response('missing room code', { status: 400 });
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
    this.seats = m.get('seats') ?? { tokens: {}, pidToToken: {}, nextPid: 0 };
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

  broadcast() {
    for (const ws of this.state.getWebSockets()) {
      const att = ws.deserializeAttachment();
      if (att) this.send(ws, { type: 'state', state: viewFor(this.room, att.pid) });
    }
  }

  async fetch(request) {
    const url = new URL(request.url);
    await this.load();

    if (request.method === 'POST' && url.pathname === '/__init') {
      if (this.room) return json({ created: false });
      this.room = createRoom(url.searchParams.get('code'));
      this.seats = { tokens: {}, pidToToken: {}, nextPid: 0 };
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
        await this.persist();
      }

      const pair = new WebSocketPair();
      const [client, server] = [pair[0], pair[1]];
      this.state.acceptWebSocket(server); // enables hibernation
      server.serializeAttachment({ pid, token: this.seats.pidToToken[pid] });

      this.send(server, { type: 'welcome', you: pid, token: this.seats.pidToToken[pid], code: this.room.code });
      this.send(server, { type: 'state', state: viewFor(this.room, pid) });
      return new Response(null, { status: 101, webSocket: client });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws, message) {
    await this.load();
    let action;
    try { action = JSON.parse(typeof message === 'string' ? message : new TextDecoder().decode(message)); }
    catch { return this.send(ws, { type: 'error', error: 'malformed message' }); }

    const att = ws.deserializeAttachment();
    if (!att) return;
    const pid = att.pid;

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

  async webSocketClose(ws) {
    // The seat persists in room.players[pid] so the player can reconnect; nothing to do.
  }

  async webSocketError() {}

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
