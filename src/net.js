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
// handlers: { onOpen, onClose, onWelcome(msg), onState(state), onResult(result), onError(msg) }
export function connect(code, handlers = {}) {
  const saved = sessionStorage.getItem(tokenKey(code)) || '';
  const qs = new URLSearchParams({ code });
  if (saved) qs.set('token', saved);
  const ws = new WebSocket(`${wsBase()}/ws?${qs}`);

  ws.addEventListener('open', () => handlers.onOpen && handlers.onOpen());
  ws.addEventListener('close', () => handlers.onClose && handlers.onClose());
  ws.addEventListener('error', () => handlers.onError && handlers.onError({ error: '连接错误' }));
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

  return {
    send: (action) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(action)); },
    close: () => ws.close(),
    forget: () => sessionStorage.removeItem(tokenKey(code)),
    get open() { return ws.readyState === WebSocket.OPEN; },
  };
}
