// FOGSITE — thin browser WebSocket client for online play. No rules, no DOM:
// it only talks to the authoritative server (server/ws.mjs), hands raw messages
// to callbacks, and persists the reconnect token so a tab reload restores its
// seat. All secrecy lives on the server; this client just renders whatever
// projected `state` it is pushed.
//
// The token is kept in sessionStorage (per-tab), NOT localStorage, so several
// tabs in the SAME browser can each hold a DIFFERENT seat — that is what makes
// it possible to test a 4-player game locally — while a reload of any one tab
// still reconnects to that tab's seat.

const tokenKey = (code) => `fogsite.token.${code}`;
const wsBase = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

// ---- lobby HTTP API -------------------------------------------------------
export async function createRoom() {
  const res = await fetch('/api/rooms', { method: 'POST' });
  if (!res.ok) throw new Error('创建房间失败');
  const { code } = await res.json();
  return code;
}

export async function lookupRoom(code) {
  const res = await fetch(`/api/rooms/${encodeURIComponent(code)}`);
  if (!res.ok) return { exists: false };
  return res.json();
}

// ---- the WebSocket connection ---------------------------------------------
// handlers: { onOpen, onClose, onReconnecting({attempt,delay}), onWelcome(msg),
//             onState(state), onResult(result), onError(msg) }
//
// The socket auto-reconnects: if it drops for any reason other than a deliberate
// close() (tab still open — wifi blip, sleep, server restart), it redials with a
// capped exponential backoff, presenting the saved token so the server restores
// the SAME seat (room.players[pid] persists). The caller's render just keeps
// showing the last pushed view until the fresh `state` arrives on reconnect.
const RETRY_BASE_MS = 500;
const RETRY_CAP_MS = 10000;

export function connect(code, handlers = {}) {
  let ws = null;
  let closedByUser = false;
  let retry = 0;
  let retryTimer = null;

  const dialUrl = () => {
    const saved = sessionStorage.getItem(tokenKey(code)) || '';
    const qs = new URLSearchParams({ code });
    if (saved) qs.set('token', saved); // restore the same seat on reconnect
    return `${wsBase()}/ws?${qs}`;
  };

  function dial() {
    ws = new WebSocket(dialUrl());

    ws.addEventListener('open', () => { retry = 0; handlers.onOpen && handlers.onOpen(); });

    ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      switch (msg.type) {
        case 'welcome':
          if (msg.token) sessionStorage.setItem(tokenKey(code), msg.token);
          handlers.onWelcome && handlers.onWelcome(msg);
          break;
        case 'state': handlers.onState && handlers.onState(msg.state); break;
        case 'result': handlers.onResult && handlers.onResult(msg.result); break;
        case 'error': handlers.onError && handlers.onError(msg); break;
      }
    });

    // A transport error is always followed by 'close'; let close own the retry
    // so we don't surface a scary "connection error" toast on every blip.
    ws.addEventListener('error', () => {});

    ws.addEventListener('close', () => {
      handlers.onClose && handlers.onClose();
      if (closedByUser) return;
      const delay = Math.min(RETRY_BASE_MS * 2 ** retry, RETRY_CAP_MS);
      retry++;
      handlers.onReconnecting && handlers.onReconnecting({ attempt: retry, delay });
      retryTimer = setTimeout(dial, delay);
    });
  }
  dial();

  return {
    send: (action) => { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action)); },
    close: () => { closedByUser = true; if (retryTimer) clearTimeout(retryTimer); if (ws) ws.close(); },
    forget: () => sessionStorage.removeItem(tokenKey(code)),
    get open() { return !!ws && ws.readyState === WebSocket.OPEN; },
  };
}
