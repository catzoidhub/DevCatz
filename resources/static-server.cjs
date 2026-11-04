// A folder of plain HTML, CSS and JS as a site: DevCatz runs this with its own Electron as Node (nothing to install).
// The folder is the working directory, the port comes in PORT. Local development only: it listens on 127.0.0.1.
const { createReadStream, statSync } = require('node:fs');
const { createServer } = require('node:http');
const { extname, join, resolve, sep } = require('node:path');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml', '.wasm': 'application/wasm', '.pdf': 'application/pdf',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf', '.mp3': 'audio/mpeg', '.mp4': 'video/mp4', '.webm': 'video/webm',
};
const root = process.cwd();
const isFile = (file) => {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
};

const server = createServer((req, res) => {
  let path;
  try {
    path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end('Bad request\n');
    return;
  }
  const target = resolve(join(root, path));
  // Inside the folder only, and never its dotfiles (.env, .git).
  const inside = target === root || target.startsWith(root + sep);
  const hidden = target.slice(root.length).split(sep).some((p) => p.startsWith('.'));
  const file = !inside || hidden ? null : [target, join(target, 'index.html'), join(target, 'index.htm'), `${target}.html`].find(isFile);
  const missing = join(root, '404.html');
  const send = file ?? (isFile(missing) ? missing : null);
  if (!send) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('Not found\n');
    return;
  }
  res.writeHead(file ? 200 : 404, { 'content-type': TYPES[extname(send).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-cache' });
  if (req.method === 'HEAD') res.end();
  else createReadStream(send).pipe(res);
});
const port = Number(process.env.PORT) || 8080;
server.listen(port, '127.0.0.1', () => console.log(`Serving ${root} on port ${port}`));
