import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer as createHttpServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { basename, extname, join, resolve } from 'node:path';
import { rewrite } from './htaccess';
import { fastcgi } from './fastcgi';
import { createServer as createHttpsServer, request as httpsRequest } from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { createProxyServer } from 'http-proxy-3';
import type { CertManager } from './certs';
import { words } from '@shared/platform';

/** Answered by the proxy itself; used to check that the clean-URL forward reaches us. */
export const PING_PATH = '/__mrcatz-herd/ping';

/** The app icon, inlined into the status pages (set from index.ts once the resources folder is known). */
let statusIcon = '';
export function setStatusPageIcon(file: string): void {
  try {
    statusIcon = `data:image/png;base64,${readFileSync(file).toString('base64')}`;
  } catch {
    statusIcon = '';
  }
}

export interface Route {
  domain: string;
  port: number | null;
  projectName: string;
  /** Whether the project's dev process is running. */
  running: boolean;
  /** The site's scheme; requests on the other one are redirected (GET/HEAD only). */
  secure: boolean;
  /** Pass the original Host header (object storage: S3 signatures cover it). */
  keepHost?: boolean;
  /** `/` redirects here (RustFS serves its console under /rustfs/console/). */
  rootRedirect?: string;
  /** Paths DevCatz answers itself on this domain instead of forwarding (e.g. WAHA's dashboard bootstrap). */
  pages?: Record<string, (req: IncomingMessage, res: ServerResponse) => void>;
  /** PHP sites: served by PHP-FPM over FastCGI, static files straight from the document root. */
  php?: {
    docroot: string;
    socket: string;
    /** Port of the site's Vite dev server while it runs (laravel-vite-plugin), served same-origin. */
    vitePort: number | null;
    /** Vite serves HTTPS (laravel-vite-plugin found a Herd/Valet certificate for APP_URL). */
    viteTls?: boolean;
    /** What laravel-vite-plugin wrote to public/hot before we rewrote it, e.g. https://app.test:5173. */
    viteOrigin?: string | null;
    /** .env values overridden for requests served here (old dev domain → this site's domain). */
    env?: Record<string, string>;
  };
}

/** Requests that belong to the Vite dev server behind a Laravel site. */
const VITE_PATH = /^\/(@vite\/|@id\/|@fs\/|@react-refresh|node_modules\/|resources\/|__vite|.*[?&](import|direct|t=\d+)(&|$))/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.json': 'application/json', '.map': 'application/json', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.avif': 'image/avif', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.otf': 'font/otf', '.eot': 'application/vnd.ms-fontobject', '.pdf': 'application/pdf', '.mp4': 'video/mp4',
  '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wasm': 'application/wasm', '.zip': 'application/zip', '.csv': 'text/csv; charset=utf-8',
};

/**
 * Host-based reverse proxy in front of the dev servers.
 *
 * Listens on loopback only (127.0.0.1 and ::1) on unprivileged ports. The
 * Host header is rewritten to `localhost:<port>` (changeOrigin) so Vite/Nuxt's
 * `server.allowedHosts` check passes without touching the user's config;
 * the original host goes along in X-Forwarded-Host/Proto. WebSocket upgrades
 * are proxied too, which is what Vite HMR needs.
 */
export class Proxy {
  private routes = new Map<string, Route>();
  /** Builds `https://host[:port]` / `http://host[:port]` for redirects (set by Herd). */
  urlBase: (secure: boolean, host: string) => string = (secure, host) => `${secure ? 'https' : 'http'}://${host}`;
  private servers: Server[] = [];
  /** Every accepted socket, including upgraded WebSockets that closeAllConnections() does not track. */
  private sockets = new Set<Socket>();
  private proxy = createProxyServer({ ws: true, xfwd: true, changeOrigin: true, proxyTimeout: 0 });
  error: string | null = null;
  httpsUp = false;
  httpUp = false;

  constructor(private certs: CertManager) {
    this.proxy.on('error', (err, req, res) => {
      const route = this.route(req as IncomingMessage);
      if (res && 'writeHead' in res) {
        const r = res as ServerResponse;
        if (!r.headersSent) this.page(r, route, (err as Error).message, String((req as IncomingMessage).headers.host ?? ""));
        else r.end();
      } else if (res) {
        (res as Duplex).destroy();
      }
    });
  }

  setRoutes(routes: Route[]): void {
    this.routes = new Map(routes.map((r) => [r.domain, r]));
  }

  /**
   * Exact host first, then the nearest parent domain: like Valet/Herd, any
   * subdomain of a site (portal.shop.localhost, a.b.shop.localhost) reaches it.
   */
  private route(req: IncomingMessage): Route | undefined {
    const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase();
    const exact = this.routes.get(host);
    if (exact) return exact;
    const labels = host.split('.');
    // Stop before the bare TLD (and before a 1-label "site").
    for (let i = 1; i < labels.length - 1; i++) {
      const r = this.routes.get(labels.slice(i).join('.'));
      if (r) return r;
    }
    return undefined;
  }

  private handle = (req: IncomingMessage, res: ServerResponse, secure: boolean) => {
    if (req.url === PING_PATH) {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-mrcatz-herd': '1' });
      return res.end('ok');
    }
    const route = this.route(req);
    // Send browsers to the scheme the site is configured for, on the host they asked for (a subdomain stays a subdomain).
    if (route && route.secure !== secure && (req.method === 'GET' || req.method === 'HEAD')) {
      const host = (req.headers.host ?? '').replace(/:\d+$/, '').replace(/\.$/, '').toLowerCase() || route.domain;
      res.writeHead(302, { location: this.urlBase(route.secure, host) + (req.url ?? '/'), 'cache-control': 'no-store' });
      return res.end();
    }
    // Only a browser opening the page: the RustFS console signs in with POST / (STS AssumeRole), and S3 clients list buckets with GET /.
    const wantsPage = (req.method === 'GET' || req.method === 'HEAD') && String(req.headers.accept ?? '').includes('text/html');
    if (route?.rootRedirect && (req.url === '/' || req.url === '') && route.running && wantsPage) {
      res.writeHead(302, { location: route.rootRedirect });
      return res.end();
    }
    const own = route?.pages?.[(req.url ?? '/').split('?')[0]];
    if (own) return own(req, res);
    if (route?.php) return this.servePhp(req, res, route, secure);
    if (!route || !route.port) return this.page(res, route, undefined, String(req.headers.host ?? ''));
    this.proxy.web(req, res, {
      target: `http://localhost:${route.port}`,
      headers: { 'x-forwarded-proto': secure ? 'https' : 'http' },
      ...(route.keepHost ? { changeOrigin: false } : {}),
    });
  };

  private upgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const route = this.route(req);
    // Laravel + Vite: the HMR socket goes to Vite (same origin as the page).
    if (route?.php?.vitePort) {
      const scheme = route.php.viteTls ? 'https' : 'http';
      return this.proxy.ws(req, socket, head, { target: `${scheme}://localhost:${route.php.vitePort}`, secure: false });
    }
    if (!route?.port) return socket.destroy();
    this.proxy.ws(req, socket, head, { target: `http://localhost:${route.port}`, ...(route.keepHost ? { changeOrigin: false } : {}) });
  };

  /**
   * PHP sites, nginx-style: Vite paths → the Vite dev server; existing files in
   * the document root → served as-is; *.php files that exist → that script;
   * everything else → index.php (Laravel's front controller) via FastCGI.
   */
  private servePhp(req: IncomingMessage, res: ServerResponse, route: Route, secure: boolean): void {
    const php = route.php!;
    const rawPath = (req.url ?? '/').split('?')[0];
    if (php.vitePort && VITE_PATH.test(req.url ?? '')) return this.serveVite(req, res, route, secure);
    let path = '/';
    try {
      path = decodeURIComponent(rawPath);
    } catch {
      /* keep '/' */
    }
    // .htaccess RewriteRules (pretty URLs written for Apache): redirect, forbid, or rewrite the path and query.
    let queryString = new URL(req.url ?? '/', 'http://x').search.slice(1);
    const rw = rewrite({
      path,
      query: queryString,
      docroot: php.docroot,
      host: (req.headers.host ?? route.domain).split(':')[0],
      method: req.method ?? 'GET',
      https: secure,
      headers: req.headers,
    });
    if (rw.kind === 'redirect') {
      res.writeHead(rw.status, { location: rw.location, 'cache-control': 'no-store' });
      return void res.end();
    }
    if (rw.kind === 'forbidden' || rw.kind === 'gone') {
      res.writeHead(rw.kind === 'forbidden' ? 403 : 410, { 'content-type': 'text/plain' });
      return void res.end(rw.kind === 'forbidden' ? 'Forbidden' : 'Gone');
    }
    if (rw.kind === 'rewrite') {
      path = rw.path;
      queryString = rw.query;
    }
    const file = resolve(php.docroot, '.' + path);
    if (!file.startsWith(php.docroot)) {
      res.writeHead(400);
      return void res.end('Bad path');
    }
    let script = join(php.docroot, 'index.php');
    let scriptName = '/index.php';
    let pathInfo = '';
    // /index.php/controller/method (CodeIgniter 3 and other PATH_INFO routers): the script plus the rest.
    const viaScript = path.match(/^(.*?\.php)(\/.*)$/);
    if (viaScript) {
      const f = resolve(php.docroot, '.' + viaScript[1]);
      if (f.startsWith(php.docroot) && existsSync(f)) {
        script = f;
        scriptName = viaScript[1];
        pathInfo = viaScript[2];
      }
    }
    try {
      let st = statSync(file);
      // Folders (WordPress /wp-admin/, plain PHP sub-pages): like Apache's DirectorySlash + DirectoryIndex.
      if (st.isDirectory() && !viaScript) {
        if (rw.kind !== 'rewrite' && !rawPath.endsWith('/') && (req.method === 'GET' || req.method === 'HEAD')) {
          const q = (req.url ?? '').slice(rawPath.length);
          res.writeHead(301, { location: `${rawPath}/${q}` });
          return void res.end();
        }
        const index = ['index.php', 'index.html', 'index.htm'].map((n) => join(file, n)).find((f) => existsSync(f));
        if (index) {
          st = statSync(index);
          if (extname(index) === '.php') {
            script = index;
            scriptName = `${path.replace(/\/$/, '')}/${basename(index)}`;
          } else {
            res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': st.size, 'cache-control': 'no-cache' });
            if (req.method === 'HEAD') return void res.end();
            return void createReadStream(index).pipe(res);
          }
        }
      } else if (st.isFile() && extname(file) !== '.php') {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          return void res.end();
        }
        res.writeHead(200, {
          'content-type': MIME[extname(file).toLowerCase()] ?? 'application/octet-stream',
          'content-length': st.size,
          'last-modified': st.mtime.toUTCString(),
          'cache-control': 'no-cache',
        });
        if (req.method === 'HEAD') return void res.end();
        return void createReadStream(file).pipe(res);
      }
      if (st.isFile() && extname(file) === '.php' && !viaScript) {
        script = file;
        scriptName = path;
      }
    } catch {
      /* not a file: front controller */
    }
    const host = req.headers.host ?? route.domain;
    const [serverName, serverPort] = host.split(':');
    const params: Record<string, string> = {
      GATEWAY_INTERFACE: 'CGI/1.1',
      SERVER_SOFTWARE: 'MrCatzHerd',
      SERVER_PROTOCOL: `HTTP/${req.httpVersion}`,
      SERVER_NAME: serverName,
      SERVER_ADDR: '127.0.0.1',
      SERVER_PORT: serverPort ?? (secure ? '443' : '80'),
      REMOTE_ADDR: (req.socket.remoteAddress ?? '127.0.0.1').replace(/^::ffff:/, ''),
      REMOTE_PORT: String(req.socket.remotePort ?? 0),
      REQUEST_METHOD: req.method ?? 'GET',
      REQUEST_URI: req.url ?? '/',
      QUERY_STRING: queryString,
      DOCUMENT_ROOT: php.docroot,
      DOCUMENT_URI: scriptName,
      SCRIPT_FILENAME: script,
      SCRIPT_NAME: scriptName,
      PHP_SELF: scriptName + pathInfo,
      ...(pathInfo ? { PATH_INFO: pathInfo, PATH_TRANSLATED: join(php.docroot, pathInfo) } : {}),
      REQUEST_SCHEME: secure ? 'https' : 'http',
      REDIRECT_STATUS: '200',
      CONTENT_TYPE: String(req.headers['content-type'] ?? ''),
      CONTENT_LENGTH: String(req.headers['content-length'] ?? ''),
    };
    if (secure) params.HTTPS = 'on';
    // Laravel's Dotenv is immutable: server variables win over .env, so these replace the .env values.
    Object.assign(params, php.env ?? {});
    for (const [k, v] of Object.entries(req.headers)) {
      if (v !== undefined) params[`HTTP_${k.toUpperCase().replace(/-/g, '_')}`] = Array.isArray(v) ? v.join(', ') : v;
    }
    fastcgi({ socketPath: php.socket, params, req, res, onStderr: (t) => console.warn(`php ${route.domain}:`, t.trim()) }).catch((err) =>
      this.page(res, { ...route, running: true }, `${words.phpServer}: ${(err as Error).message}`, String(req.headers.host ?? '')),
    );
  }

  /** Proxies to Vite, rewriting the dev-server URL laravel-vite-plugin bakes into JS/CSS to the site's origin. */
  private serveVite(req: IncomingMessage, res: ServerResponse, route: Route, secure: boolean): void {
    const port = route.php!.vitePort!;
    const origin = this.urlBase(secure, route.domain);
    const doRequest = route.php!.viteTls ? httpsRequest : httpRequest;
    const upstream = doRequest(
      {
        host: 'localhost',
        port,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, host: `localhost:${port}`, 'accept-encoding': 'identity' },
        // Vite may use Laravel Herd's certificate for <app>.test; this is a loopback hop.
        rejectUnauthorized: false,
      },
      (up) => {
        const type = String(up.headers['content-type'] ?? '');
        const headers = { ...up.headers };
        // Pages on a subdomain (portal.shop.localhost) load Vite assets from the site's origin: allow them.
        const reqOrigin = String(req.headers.origin ?? '');
        try {
          const h = reqOrigin ? new URL(reqOrigin).hostname : '';
          if (h && (h === route.domain || h.endsWith(`.${route.domain}`))) {
            headers['access-control-allow-origin'] = reqOrigin;
            headers.vary = 'Origin';
          }
        } catch {
          /* not a URL */
        }
        if (!/javascript|css|html/.test(type)) {
          res.writeHead(up.statusCode ?? 502, headers);
          return void up.pipe(res);
        }
        const chunks: Buffer[] = [];
        up.on('data', (c: Buffer) => chunks.push(c));
        up.on('end', () => {
          let body = Buffer.concat(chunks)
            .toString('utf8')
            .replace(new RegExp(`https?://(?:\\[::1\\]|localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0):${port}`, 'g'), origin);
          // laravel-vite-plugin with a Herd/Valet certificate points URLs and the HMR host at <app>.test.
          const orig = route.php!.viteOrigin;
          if (orig) {
            const u = new URL(orig);
            body = body.split(orig).join(origin);
            if ((req.url ?? '').startsWith('/@vite/client')) body = body.split(`"${u.hostname}"`).join(`"${route.domain}"`);
          }
          delete headers['content-length'];
          delete headers['transfer-encoding'];
          res.writeHead(up.statusCode ?? 200, { ...headers, 'content-length': Buffer.byteLength(body) });
          res.end(body);
        });
      },
    );
    upstream.on('error', (e) => this.page(res, { ...route, running: true }, `Vite: ${e.message}`, String(req.headers.host ?? '')));
    req.pipe(upstream);
  }

  /** Friendly page for unknown hosts, stopped sites and sites still booting (DevCatz look, light + dark). */
  private page(res: ServerResponse, route?: Route, detail?: string, host = ''): void {
    const state = !route ? 'unknown' : route.running ? 'starting' : 'stopped';
    const title = state === 'unknown' ? 'Unknown site' : state === 'starting' ? `${route!.projectName} is starting` : `${route!.projectName} is stopped`;
    const body =
      state === 'unknown'
        ? 'No site in DevCatz answers to this domain. Link the project (Create New Site) or check the spelling.'
        : state === 'starting'
          ? 'The dev server is not accepting connections yet. This page refreshes on its own.'
          : `Start it from the DevCatz window or the ${words.tray}. This page refreshes on its own.`;
    const pill = state === 'unknown' ? ['Not linked', '#f59e0b'] : state === 'starting' ? ['Starting', '#8b5cf6'] : ['Stopped', '#94a3b8'];
    const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;');
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · DevCatz</title>${route ? '<meta http-equiv="refresh" content="2">' : ''}
<style>
:root{--bg:#f4f4f8;--card:#ffffff;--fg:#2a2740;--muted:#6b6a80;--line:rgba(30,27,75,.08);--chip:rgba(30,27,75,.05);--a:#6d5df6;--b:#8b5cf6}
@media(prefers-color-scheme:dark){:root{--bg:#15142a;--card:#1f1d36;--fg:#ebe9ff;--muted:#9c99b8;--line:rgba(255,255,255,.08);--chip:rgba(255,255,255,.06)}}
*{box-sizing:border-box}html,body{height:100%}
body{margin:0;font:15px/1.55 -apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;color:var(--fg);background:var(--bg);display:grid;place-items:center;
background-image:radial-gradient(60rem 32rem at 50% -10%,rgba(109,93,246,.18),transparent 60%),radial-gradient(40rem 24rem at 90% 110%,rgba(47,211,188,.12),transparent 60%)}
main{width:min(30rem,calc(100% - 2rem));background:var(--card);border:1px solid var(--line);border-radius:22px;padding:2.25rem 2rem 1.75rem;text-align:center;
box-shadow:0 1px 2px rgba(0,0,0,.05),0 24px 60px -30px rgba(42,31,122,.35)}
.mark{display:block;width:96px;height:96px;margin:0 auto .6rem}
.pill{display:inline-flex;align-items:center;gap:.4rem;font-size:12px;font-weight:600;letter-spacing:.02em;padding:.2rem .65rem;border-radius:999px;background:var(--chip);color:var(--muted);margin-bottom:.9rem}
.pill i{width:7px;height:7px;border-radius:50%;background:var(--dot);box-shadow:0 0 0 3px color-mix(in srgb,var(--dot) 25%,transparent)}
.starting .pill i{animation:pulse 1.2s ease-in-out infinite}@keyframes pulse{50%{opacity:.35}}
h1{font-size:1.35rem;letter-spacing:-.01em;margin:0 0 .35rem;font-weight:650}
p{margin:0;color:var(--muted)}
.host{display:inline-block;margin:1rem 0 0;padding:.3rem .7rem;border-radius:999px;background:var(--chip);font:12.5px ui-monospace,"SF Mono",Menlo,monospace;color:var(--fg);max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
code.detail{display:block;margin-top:1rem;padding:.6rem .8rem;border-radius:12px;background:var(--chip);font:12px/1.5 ui-monospace,"SF Mono",Menlo,monospace;color:var(--muted);text-align:left;white-space:pre-wrap;word-break:break-word}
footer{margin-top:1.4rem;padding-top:1rem;border-top:1px solid var(--line);font-size:12px;color:var(--muted)}
footer b{color:var(--fg);font-weight:600;background:linear-gradient(135deg,var(--a),var(--b));-webkit-background-clip:text;background-clip:text;color:transparent}
</style></head>
<body class="${state}"><main>
${statusIcon ? `<img class="mark" src="${statusIcon}" alt="DevCatz" draggable="false">` : ''}
<span class="pill" style="--dot:${pill[1]}"><i></i>${pill[0]}</span>
<h1>${esc(title)}</h1><p>${esc(body)}</p>
${host ? `<span class="host">${esc(host)}</span>` : ''}
${detail ? `<code class="detail">${esc(detail)}</code>` : ''}
<footer>Served by <b>DevCatz</b> · local development environment</footer>
</main></body></html>`;
    // 503, not 502: Cloudflare (and other tunnels) replace an origin's 502 / 504 with their own "Host Error" page.
    res.writeHead(route ? 503 : 404, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  async listen(httpsPort: number, httpPort: number): Promise<void> {
    await this.close();
    this.error = null;
    this.certs.ensureCa();
    const fallback = this.certs.defaultPem();
    const errors: string[] = [];

    const bind = (server: Server, port: number, host: string) =>
      new Promise<boolean>((resolve) => {
        server.once('error', (err: NodeJS.ErrnoException) => {
          errors.push(`${host}:${port} ${err.code ?? err.message}`);
          resolve(false);
        });
        server.listen(port, host, () => resolve(true));
      });

    const results: boolean[][] = [[], []];
    for (const host of ['127.0.0.1', '::1']) {
      const https = createHttpsServer(
        {
          cert: fallback.cert,
          key: fallback.key,
          SNICallback: (name, cb) => {
            try {
              // Only mint certificates for linked domains.
              const host = name.toLowerCase();
              cb(null, this.certs.contextFor(this.routes.has(host) ? host : 'localhost'));
            } catch (err) {
              cb(err as Error);
            }
          },
        },
        (req, res) => this.handle(req, res, true),
      );
      https.on('upgrade', this.upgrade);
      const http = createHttpServer((req, res) => this.handle(req, res, false));
      http.on('upgrade', this.upgrade);
      results[0].push(await bind(https, httpsPort, host));
      results[1].push(await bind(http, httpPort, host));
      for (const server of [https, http]) {
        server.on('connection', (socket: Socket) => {
          this.sockets.add(socket);
          socket.once('close', () => this.sockets.delete(socket));
        });
      }
      this.servers.push(https, http);
    }
    this.httpsUp = results[0].every(Boolean);
    this.httpUp = results[1].every(Boolean);
    if (errors.length) this.error = `Could not listen on ${errors.join(', ')}`;
  }

  async close(): Promise<void> {
    const closing = this.servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve())));
    // Stop listening first, then drop keep-alive and WebSocket connections so close() can finish.
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    await Promise.all(closing);
    this.servers = [];
    this.httpsUp = this.httpUp = false;
  }
}
