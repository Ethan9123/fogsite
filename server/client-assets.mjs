// The only files both local HTTP servers may publish. Keep this surface aligned
// with worker/build-client.mjs; never serve the checkout root indiscriminately.
import { readFile, realpath } from 'node:fs/promises';
import { extname, join, sep, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };
const allowedPath = (path) => path === '/index.html' || path === '/styles.css' ||
  path === '/server/protocol.js' || /^\/src\/[A-Za-z0-9_-]+\.js$/.test(path);

export async function readClientAsset(pathname, method = 'GET') {
  try {
    let path = decodeURIComponent(pathname);
    if (path === '/') path = '/index.html';
    if (!allowedPath(path) || (method !== 'GET' && method !== 'HEAD')) return null;
    const root = await realpath(ROOT);
    const file = await realpath(join(ROOT, path));
    if (!file.startsWith(root + sep)) return null;
    // Also reject links to private files inside the checkout, not just escapes.
    if (!allowedPath('/' + relative(root, file).split(sep).join('/'))) return null;
    return { data: await readFile(file), contentType: MIME[extname(file)] };
  } catch { return null; }
}
