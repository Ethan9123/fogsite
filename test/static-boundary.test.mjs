import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { connect } from 'node:net';
import { mkdtemp, writeFile, symlink, unlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/ws.mjs';
import { startPreviewServer } from '../server.mjs';

function get(port, path) {
  return new Promise((resolve, reject) => {
    const req = request({ hostname: '127.0.0.1', port, path }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString() }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('Node transport serves client assets, never repository or server internals', async () => {
  const server = await startServer(0);
  try {
    for (const path of ['/', '/index.html', '/styles.css', '/src/ui.js', '/src/game.js', '/server/protocol.js']) {
      assert.equal((await get(server.port, path)).status, 200, path);
    }
    for (const path of ['/.git/HEAD', '/package.json', '/package-lock.json', '/server/ws.mjs', '/worker/index.js', '/test/engine.test.mjs', '/.env', '/src/%2e%2e/package.json', '/%2e%2e/package.json', '/%zz']) {
      assert.equal((await get(server.port, path)).status, 404, path);
    }
  } finally { await server.close(); }
});

test('allowed asset names cannot follow a symlink outside the repository', async (t) => {
  const temporary = await mkdtemp(join(tmpdir(), 'fogsite-static-test-'));
  const target = join(temporary, 'fixture.js');
  const link = fileURLToPath(new URL('../src/static-boundary-fixture.js', import.meta.url));
  let linked = false;
  let server;
  try {
    await writeFile(target, 'synthetic private fixture');
    try { await symlink(target, link); }
    catch (error) {
      if (process.platform === 'win32' && ['EPERM', 'EACCES'].includes(error.code)) {
        t.skip('Windows account does not have symlink privileges');
        return;
      }
      throw error;
    }
    linked = true;
    server = await startServer(0);
    assert.equal((await get(server.port, '/src/static-boundary-fixture.js')).status, 404);
    await unlink(link);
    linked = false;
    await symlink(fileURLToPath(new URL('../package.json', import.meta.url)), link);
    linked = true;
    assert.equal((await get(server.port, '/src/static-boundary-fixture.js')).status, 404,
      'symlinks to private files inside the checkout must also be rejected');
  } finally {
    if (server) await server.close();
    if (linked) await unlink(link);
    await rm(temporary, { recursive: true, force: true });
  }
});

test('legacy static preview shares the same client-only boundary', async () => {
  const server = await startPreviewServer(0);
  try {
    for (const path of ['/', '/src/ui.js', '/server/protocol.js']) {
      assert.equal((await get(server.address().port, path)).status, 200, path);
    }
    for (const path of ['/.git/HEAD', '/package.json', '/server.mjs', '/server/ws.mjs', '/worker/index.js', '/%zz']) {
      assert.equal((await get(server.address().port, path)).status, 404, path);
    }
  } finally { await new Promise((resolve) => server.close(resolve)); }
});

test('malformed HTTP and upgrade targets do not terminate the Node server', async () => {
  const server = await startServer(0);
  try {
    assert.equal((await get(server.port, 'http://[')).status, 400);
    await new Promise((resolve, reject) => {
      const socket = connect(server.port, '127.0.0.1');
      const timeout = setTimeout(() => { socket.destroy(); reject(new Error('invalid upgrade did not close')); }, 3000);
      socket.on('connect', () => socket.write('GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n'));
      socket.on('data', () => {});
      socket.on('error', (error) => { if (error.code !== 'ECONNRESET') reject(error); });
      socket.on('close', () => { clearTimeout(timeout); resolve(); });
    });
    assert.equal((await get(server.port, '/')).status, 200);
    const response = await fetch(`http://127.0.0.1:${server.port}/api/rooms`, { method: 'POST' });
    assert.equal(response.status, 200);
  } finally { await server.close(); }
});
