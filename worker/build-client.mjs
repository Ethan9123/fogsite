// Assemble the static client into ./public for Cloudflare deployment.
//
// We deliberately copy only the files the browser actually loads — index.html,
// styles.css, every src/*.js, and server/protocol.js (imported by ui.js) —
// preserving the same relative layout the import statements expect. This keeps
// the deployed asset set to client code only, never .git / node_modules / the
// Node-only server. Run via `npm run build:client` (deploy/dev do this for you).
import { mkdir, copyFile, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..'); // fogsite-app/
const out = join(root, 'public');

await rm(out, { recursive: true, force: true });
await mkdir(join(out, 'src'), { recursive: true });
await mkdir(join(out, 'server'), { recursive: true });

await copyFile(join(root, 'index.html'), join(out, 'index.html'));
await copyFile(join(root, 'styles.css'), join(out, 'styles.css'));
for (const f of await readdir(join(root, 'src'))) {
  if (f.endsWith('.js')) await copyFile(join(root, 'src', f), join(out, 'src', f));
}
await copyFile(join(root, 'server', 'protocol.js'), join(out, 'server', 'protocol.js'));

console.log('client assembled into public/');
