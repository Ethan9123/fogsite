// Minimal static file server for local preview (no dependencies).
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { readClientAsset } from './server/client-assets.mjs';

export function startPreviewServer(port = Number(process.env.PORT) || 5173) {
  const server = createServer(async (req, res) => {
    const asset = await readClientAsset(req.url.split('?')[0], req.method);
    if (!asset) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404'); return; }
    res.writeHead(200, { 'Content-Type': asset.contentType });
    res.end(asset.data);
  });
  return new Promise((resolve) => server.listen(port, () => resolve(server)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startPreviewServer().then((server) => console.log(`fogsite preview on http://localhost:${server.address().port}`));
}
