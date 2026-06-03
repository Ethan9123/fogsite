// FOGSITE — WebSocket + lobby server. Wraps the authoritative room core
// (room.js) with real networking and the real escape clock. One process serves
// the static client, a tiny lobby HTTP API, and a WebSocket per player.
//
// Secrecy is enforced here by only ever sending a client `viewFor(room, pid)` —
// the projected view for that player. Raw room/game state never goes on the wire.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { randomBytes } from 'node:crypto';
import { WebSocketServer } from 'ws';
import { createRoom, applyAction, viewFor, ESCAPE_SECONDS } from './room.js';
import { TYPES as MSG } from './protocol.js';
import { MODE } from '../src/rules.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url)); // project root (parent of server/)
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

const token = () => randomBytes(16).toString('hex');
const roomCode = () => {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no easily-confused chars
  let s = '';
  for (let i = 0; i < 4; i++) s += alphabet[Math.floor(Math.random() * alphabet.length)];
  return s;
};

// ---------------------------------------------------------------------------
// startServer — boots the HTTP+WS server. Returns handles so tests can run it
// on an ephemeral port and shut it down cleanly (clearing escape timers).
// ---------------------------------------------------------------------------
export function startServer(port = Number(process.env.PORT) || 5174) {
  // code -> { room, code, clients: Map<pid, ws>, tokens: Map<token, pid>,
  //           pidToToken: Map<pid, token>, nextPid, guardianPid, escapeTimer }
  const rooms = new Map();

  const http = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');

    // ---- lobby API ----
    if (req.method === 'POST' && url.pathname === '/api/rooms') {
      const code = uniqueCode(rooms);
      rooms.set(code, freshEntry(code));
      return sendJson(res, 200, { code });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/rooms/')) {
      const code = url.pathname.slice('/api/rooms/'.length).toUpperCase();
      const entry = rooms.get(code);
      return sendJson(res, entry ? 200 : 404, entry ? { exists: true, phase: entry.room.phase } : { exists: false });
    }

    // ---- static client ----
    try {
      let p = decodeURIComponent(url.pathname);
      if (p === '/') p = '/index.html';
      const filePath = normalize(join(ROOT, p));
      if (!filePath.startsWith(ROOT)) { res.writeHead(403).end('forbidden'); return; }
      const data = await readFile(filePath);
      res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
    }
  });

  const wss = new WebSocketServer({ noServer: true });

  http.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const code = (url.searchParams.get('code') || '').toUpperCase();
    const entry = rooms.get(code);
    if (!entry) { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req, entry, url.searchParams.get('token'));
    });
  });

  wss.on('connection', (ws, _req, entry, reconnectToken) => {
    // Resolve the player id: reuse the seat on a valid reconnect token, else new.
    let pid;
    if (reconnectToken && entry.tokens.has(reconnectToken)) {
      pid = entry.tokens.get(reconnectToken);
      const old = entry.clients.get(pid);
      if (old && old !== ws && old.readyState === old.OPEN) old.close();
    } else {
      pid = entry.nextPid++;
      const t = token();
      entry.tokens.set(t, pid);
      entry.pidToToken.set(pid, t);
    }
    entry.clients.set(pid, ws);

    send(ws, { type: 'welcome', you: pid, token: entry.pidToToken.get(pid), code: entry.code });
    send(ws, { type: 'state', state: viewFor(entry.room, pid) });

    ws.on('message', (data) => {
      let action;
      try { action = JSON.parse(data.toString()); } catch { return send(ws, { type: 'error', error: 'malformed message' }); }
      const res = applyAction(entry.room, pid, action);
      if (res.error) {
        send(ws, { type: 'error', error: res.error });
        send(ws, { type: 'state', state: viewFor(entry.room, pid) }); // keep this client in sync
        return;
      }
      if (action.type === MSG.JOIN && action.role === 'guardian') entry.guardianPid = pid;
      manageEscapeTimer(entry, broadcastState);
      broadcastState(entry);
    });

    ws.on('close', () => {
      if (entry.clients.get(pid) === ws) entry.clients.delete(pid);
      // The seat persists in room.players[pid] so the player can reconnect.
    });
  });

  // ---- escape clock: server owns the 60s window ----
  function manageEscapeTimer(entry, onTimeout) {
    const g = entry.room.game;
    const inEscape = g && g.mode === MODE.ESCAPE_DECISION && entry.room.escape;
    if (inEscape && !entry.escapeTimer) {
      entry.room.escape.deadline = Date.now() + ESCAPE_SECONDS * 1000;
      entry.escapeTimer = setTimeout(() => {
        entry.escapeTimer = null;
        if (entry.guardianPid != null) {
          applyAction(entry.room, entry.guardianPid, { type: MSG.ESCAPE_TIMEOUT });
          manageEscapeTimer(entry, onTimeout);
          onTimeout(entry);
        }
      }, ESCAPE_SECONDS * 1000);
      if (entry.escapeTimer.unref) entry.escapeTimer.unref();
    } else if (!inEscape && entry.escapeTimer) {
      clearTimeout(entry.escapeTimer);
      entry.escapeTimer = null;
    }
  }

  function broadcastState(entry) {
    for (const [pid, ws] of entry.clients) {
      if (ws.readyState === ws.OPEN) send(ws, { type: 'state', state: viewFor(entry.room, pid) });
    }
  }

  return new Promise((resolve) => {
    http.listen(port, () => {
      const actualPort = http.address().port;
      resolve({
        port: actualPort,
        http,
        wss,
        rooms,
        close: () => new Promise((res) => {
          for (const entry of rooms.values()) {
            if (entry.escapeTimer) clearTimeout(entry.escapeTimer);
            for (const ws of entry.clients.values()) try { ws.terminate(); } catch {}
          }
          wss.close(() => http.close(() => res()));
        }),
      });
    });
  });
}

function freshEntry(code) {
  return {
    room: createRoom(code),
    code,
    clients: new Map(),
    tokens: new Map(),
    pidToToken: new Map(),
    nextPid: 0,
    guardianPid: null,
    escapeTimer: null,
  };
}
function uniqueCode(rooms) {
  let code = roomCode();
  while (rooms.has(code)) code = roomCode();
  return code;
}
function send(ws, obj) { try { ws.send(JSON.stringify(obj)); } catch {} }
function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

// Run directly: node server/ws.mjs
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer().then(({ port }) => console.log(`fogsite online server on http://localhost:${port}`));
}
