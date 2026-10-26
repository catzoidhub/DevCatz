import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { RealtimeInfo, RealtimeLib, WsKind } from '@shared/types';

/**
 * Real-time libraries a site uses, from its manifests (package.json of the
 * root and its workspace apps, composer.json, go.mod, requirements /
 * pyproject / Pipfile). Server libraries run inside the site, so their
 * WebSocket is served on the site's own domain (the proxy passes upgrades);
 * client libraries talk to a server: Laravel Reverb or a DevCatz server.
 */

type Rule = [match: string | RegExp, lib: Omit<RealtimeLib, 'source'>];

const NODE: Rule[] = [
  ['socket.io', { name: 'Socket.IO', role: 'server', protocol: 'socketio' }],
  ['socket.io-client', { name: 'Socket.IO client', role: 'client', protocol: 'socketio' }],
  ['ws', { name: 'ws', role: 'server', protocol: 'ws' }],
  ['uWebSockets.js', { name: 'uWebSockets.js', role: 'server', protocol: 'ws' }],
  ['@nestjs/websockets', { name: 'NestJS gateways', role: 'server', protocol: 'ws' }],
  ['@nestjs/platform-socket.io', { name: 'NestJS + Socket.IO', role: 'server', protocol: 'socketio' }],
  ['@nestjs/platform-ws', { name: 'NestJS + ws', role: 'server', protocol: 'ws' }],
  ['@hono/node-ws', { name: 'Hono WebSocket', role: 'server', protocol: 'ws' }],
  ['crossws', { name: 'crossws (Nitro/Nuxt)', role: 'server', protocol: 'ws' }],
  ['graphql-ws', { name: 'graphql-ws', role: 'server', protocol: 'ws' }],
  ['@fastify/websocket', { name: 'Fastify WebSocket', role: 'server', protocol: 'ws' }],
  ['express-ws', { name: 'express-ws', role: 'server', protocol: 'ws' }],
  ['laravel-echo', { name: 'Laravel Echo', role: 'client', protocol: 'pusher' }],
  ['pusher-js', { name: 'pusher-js', role: 'client', protocol: 'pusher' }],
  ['pusher', { name: 'Pusher (Node server SDK)', role: 'client', protocol: 'pusher' }],
  ['centrifuge', { name: 'Centrifuge JS', role: 'client', protocol: 'centrifugo' }],
  ['nats.ws', { name: 'nats.ws', role: 'client', protocol: 'nats' }],
  ['nats', { name: 'NATS client', role: 'client', protocol: 'nats' }],
  [/^@nats-io\//, { name: 'NATS client', role: 'client', protocol: 'nats' }],
];

const PHP: Rule[] = [
  ['laravel/reverb', { name: 'Laravel Reverb', role: 'server', protocol: 'reverb' }],
  ['pusher/pusher-php-server', { name: 'Pusher PHP', role: 'client', protocol: 'pusher' }],
  ['beyondcode/laravel-websockets', { name: 'Laravel WebSockets', role: 'server', protocol: 'pusher' }],
  ['cboden/ratchet', { name: 'Ratchet', role: 'server', protocol: 'ws' }],
  ['workerman/workerman', { name: 'Workerman', role: 'server', protocol: 'ws' }],
  [/^openswoole\/|^swoole\//, { name: 'Swoole / OpenSwoole', role: 'server', protocol: 'ws' }],
  [/^symfony\/mercure/, { name: 'Symfony Mercure', role: 'client', protocol: 'mercure' }],
  ['centrifugal/phpcent', { name: 'phpcent', role: 'client', protocol: 'centrifugo' }],
  ['denis660/laravel-centrifugo', { name: 'Laravel Centrifugo', role: 'client', protocol: 'centrifugo' }],
  ['basis-company/nats', { name: 'NATS PHP', role: 'client', protocol: 'nats' }],
];

const PYTHON: Rule[] = [
  ['channels', { name: 'Django Channels', role: 'server', protocol: 'channels' }],
  ['python-socketio', { name: 'python-socketio', role: 'server', protocol: 'socketio' }],
  ['flask-socketio', { name: 'Flask-SocketIO', role: 'server', protocol: 'socketio' }],
  ['websockets', { name: 'websockets', role: 'server', protocol: 'ws' }],
  ['tornado', { name: 'Tornado', role: 'server', protocol: 'ws' }],
  ['cent', { name: 'cent (Centrifugo)', role: 'client', protocol: 'centrifugo' }],
  ['pysher', { name: 'Pysher', role: 'client', protocol: 'pusher' }],
  ['pusher', { name: 'Pusher Python', role: 'client', protocol: 'pusher' }],
  ['nats-py', { name: 'nats-py', role: 'client', protocol: 'nats' }],
];

const GO: Rule[] = [
  ['github.com/gorilla/websocket', { name: 'gorilla/websocket', role: 'server', protocol: 'ws' }],
  ['github.com/coder/websocket', { name: 'coder/websocket', role: 'server', protocol: 'ws' }],
  ['nhooyr.io/websocket', { name: 'nhooyr websocket', role: 'server', protocol: 'ws' }],
  ['github.com/gobwas/ws', { name: 'gobwas/ws', role: 'server', protocol: 'ws' }],
  ['github.com/olahol/melody', { name: 'Melody', role: 'server', protocol: 'ws' }],
  ['github.com/gofiber/contrib/websocket', { name: 'Fiber WebSocket', role: 'server', protocol: 'ws' }],
  ['github.com/zishang520/socket.io', { name: 'Socket.IO (Go)', role: 'server', protocol: 'socketio' }],
  ['github.com/centrifugal/centrifuge', { name: 'Centrifuge (Go library)', role: 'server', protocol: 'ws' }],
  ['github.com/centrifugal/gocent', { name: 'gocent', role: 'client', protocol: 'centrifugo' }],
  ['github.com/nats-io/nats.go', { name: 'nats.go', role: 'client', protocol: 'nats' }],
  ['github.com/pusher/pusher-http-go', { name: 'Pusher Go', role: 'client', protocol: 'pusher' }],
];

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};

function match(rules: Rule[], names: string[], source: string, out: RealtimeLib[]): void {
  for (const [m, lib] of rules) {
    if (names.some((n) => (typeof m === 'string' ? n === m : m.test(n))) && !out.some((o) => o.name === lib.name)) out.push({ ...lib, source });
  }
}

/** package.json files: the root plus apps/* and packages/* (monorepos). */
function packageJsons(root: string): string[] {
  const out = [join(root, 'package.json')];
  for (const dir of ['apps', 'packages', 'services']) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    try {
      for (const e of readdirSync(d)) out.push(join(d, e, 'package.json'));
    } catch {
      /* unreadable */
    }
  }
  return out.filter((f) => existsSync(f));
}

const MANIFESTS = ['package.json', 'composer.json', 'go.mod', 'requirements.txt', 'pyproject.toml', 'Pipfile'];
const cache = new Map<string, { sig: string; info: RealtimeInfo }>();

export function detectRealtime(root: string): RealtimeInfo {
  const files = [...new Set([...MANIFESTS.map((m) => join(root, m)), ...packageJsons(root)])].filter((f) => existsSync(f));
  const sig = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
  const hit = cache.get(root);
  if (hit && hit.sig === sig) return hit.info;

  const libs: RealtimeLib[] = [];
  for (const f of packageJsons(root)) {
    try {
      const pkg = JSON.parse(read(f) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      match(NODE, Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), f.slice(root.length + 1), libs);
    } catch {
      /* invalid JSON */
    }
  }
  const composer = read(join(root, 'composer.json'));
  if (composer) {
    try {
      const c = JSON.parse(composer) as { require?: Record<string, string>; 'require-dev'?: Record<string, string> };
      match(PHP, Object.keys({ ...c.require, ...c['require-dev'] }), 'composer.json', libs);
    } catch {
      /* invalid JSON */
    }
  }
  const goMod = read(join(root, 'go.mod'));
  if (goMod) match(GO, [...goMod.matchAll(/^\s*(?:require\s+)?([\w./-]+)\s+v[\d]/gm)].map((m) => m[1]), 'go.mod', libs);
  for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    const text = read(join(root, f));
    if (!text) continue;
    // Package names at the start of a requirement ("channels[daphne]>=4", "  \"python-socketio>=5\",", "channels = \"*\"").
    const names = [...text.matchAll(/^[\s"']*([A-Za-z][\w.-]*)(?=[\s\[<>=~!;,"']|$)/gm)].map((m) => m[1].toLowerCase());
    match(PYTHON, names, f, libs);
  }

  const clients = libs.filter((l) => l.role === 'client').map((l) => l.protocol);
  const reverb = libs.some((l) => l.protocol === 'reverb');
  const suggested: WsKind | null = clients.includes('pusher') || reverb ? (reverb ? 'reverb' : 'sockudo') : clients.includes('centrifugo') ? 'centrifugo' : clients.includes('mercure') ? 'mercure' : clients.includes('nats') ? 'nats' : null;
  const info: RealtimeInfo = { libs, reverb, suggested };
  cache.set(root, { sig, info });
  return info;
}
