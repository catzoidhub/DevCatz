import { connect } from 'node:net';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RedisDetails, RedisInfo } from '@shared/types';
import { readEnvFiles } from './detect';

const REDIS_DEPS = [
  'ioredis',
  'redis',
  'iovalkey',
  '@valkey/valkey-glide',
  'bullmq',
  'bull',
  '@nestjs/bullmq',
  '@nestjs/bull',
  '@keyv/redis',
  '@keyv/valkey',
  'cache-manager-redis-yet',
  'cache-manager-ioredis-yet',
  'connect-redis',
  'nuxt-redis',
];
/** Clients that only talk to Valkey (the others work with both). */
const VALKEY_CLIENTS = /valkey/i;
const COMPOSE_FILES = ['compose.yaml', 'compose.yml', 'docker-compose.yml', 'docker-compose.yaml'];

interface ComposeRedis {
  file: string;
  service: string;
  image: string | null;
  hostPort: number | null;
}

/** The redis service of the project's compose file (image redis/valkey/keydb/dragonfly). */
function composeRedis(root: string): ComposeRedis | null {
  const file = COMPOSE_FILES.find((f) => existsSync(join(root, f)));
  if (!file) return null;
  const text = readFileSync(join(root, file), 'utf8');
  const section = text.split(/^services:\s*$/m)[1];
  if (!section) return null;
  let current: { name: string; body: string } | null = null;
  const services: { name: string; body: string }[] = [];
  for (const line of section.split('\n')) {
    if (/^\S/.test(line)) break;
    const m = line.match(/^ {2}([A-Za-z0-9._-]+):\s*$/);
    if (m) services.push((current = { name: m[1], body: '' }));
    else if (current) current.body += line + '\n';
  }
  const svc = services.find((s) => /image:\s*['"]?[^\s'"]*(redis|valkey|keydb|dragonfly)/i.test(s.body));
  if (!svc) return null;
  const port = svc.body.match(/['"]?(?:[\d.]+:)?(\d+):6379['"]?/)?.[1];
  return { file, service: svc.name, image: svc.body.match(/image:\s*['"]?([^'"\s]+)/)?.[1] ?? null, hostPort: port ? Number(port) : null };
}

/**
 * Whether and where a project uses Redis: REDIS_URL / REDIS_HOST+PORT from
 * .env, a compose service, or just a Redis client in its dependencies
 * (then the default localhost:6379).
 */
/**
 * Laravel: Redis connections in config/database.php beyond `default` / `cache`
 * whose index comes from an env var, e.g. laravel-visits →
 * `'database' => env('REDIS_VISIT_DB', '3')`. Works the same for Valkey.
 */
export function laravelRedisConnections(root: string, env: Record<string, string>): RedisInfo['connections'] {
  let src = '';
  try {
    src = readFileSync(join(root, 'config', 'database.php'), 'utf8');
  } catch {
    return [];
  }
  const start = src.search(/['"]redis['"]\s*=>\s*\[/);
  if (start < 0) return [];
  // The redis array: up to its matching bracket.
  let depth = 0;
  let end = src.length;
  for (let i = src.indexOf('[', start); i < src.length; i++) {
    if (src[i] === '[') depth++;
    else if (src[i] === ']' && --depth === 0) {
      end = i;
      break;
    }
  }
  const block = src.slice(start, end);
  const out: RedisInfo['connections'] = [];
  for (const m of block.matchAll(/['"]([\w.-]+)['"]\s*=>\s*\[[^\]]*?['"]database['"]\s*=>\s*env\(\s*['"](\w+)['"]\s*(?:,\s*['"]?(\d+)['"]?)?\s*\)/g)) {
    const [, name, envKey, def] = m;
    // default (REDIS_DB) and cache (REDIS_CACHE_DB) have their own settings.
    if (envKey === 'REDIS_DB' || envKey === 'REDIS_CACHE_DB' || out.some((c) => c.envKey === envKey)) continue;
    const raw = env[envKey]?.trim();
    const fromEnv = Boolean(raw && /^\d+$/.test(raw));
    out.push({ name, envKey, db: fromEnv ? Number(raw) : Number(def ?? 0), fromEnv });
  }
  return out;
}

export function detectRedis(root: string, dirs: string[]): RedisInfo | null {
  const pkgDeps = new Set<string>();
  for (const d of [root, ...dirs]) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'));
      for (const k of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) pkgDeps.add(k);
    } catch {
      /* no package.json */
    }
  }
  // Go modules (root, sub-folders, apps/*): go-redis / redigo in go.mod.
  let goClient: string | null = null;
  const goMods = [root, ...dirs];
  for (const base of [root, join(root, 'apps'), join(root, 'services')]) {
    try {
      for (const e of readdirSync(base)) goMods.push(join(base, e));
    } catch {
      /* no such folder */
    }
  }
  for (const d of goMods) {
    try {
      const mod = readFileSync(join(d, 'go.mod'), 'utf8');
      const m = mod.match(/github\.com\/(redis\/go-redis|go-redis\/redis|gomodule\/redigo|valkey-io\/valkey-go)/);
      if (m) {
        goClient = m[1].includes('redigo') ? 'redigo' : m[1].includes('valkey') ? 'valkey-go' : 'go-redis';
        break;
      }
    } catch {
      /* no go.mod */
    }
  }
  const client = REDIS_DEPS.find((d) => pkgDeps.has(d)) ?? goClient;
  const env = readEnvFiles(...[root, ...dirs].flatMap((d) => [join(d, '.env'), join(d, '.env.local')]));
  const compose = composeRedis(root);

  let host: string | null = null;
  let port: number | null = null;
  let db = 0;
  let password = false;
  let from: RedisInfo['configuredBy'] = 'default';
  const url = env.REDIS_URL || env.REDIS_URI || env.KV_URL || '';
  if (url) {
    try {
      const u = new URL(url);
      host = u.hostname;
      port = u.port ? Number(u.port) : 6379;
      db = Number(u.pathname.replace('/', '')) || 0;
      password = Boolean(u.password);
      from = 'REDIS_URL';
    } catch {
      /* not a URL */
    }
  } else if (env.REDIS_HOST || env.REDIS_PORT) {
    host = env.REDIS_HOST || 'localhost';
    port = Number(env.REDIS_PORT) || 6379;
    db = Number(env.REDIS_DB) || 0;
    password = Boolean(laravelValue(env.REDIS_PASSWORD));
    from = 'REDIS_HOST';
  }
  if (!client && !compose && !host) return null;

  const local = !host || /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(host);
  // A local URL on a port the compose service does not publish means "not Docker".
  const useCompose = compose && (!host || (!local && !host.includes('.')) || (local && compose.hostPort === (port ?? 6379)));
  return {
    client,
    configuredBy: from,
    host: host ?? 'localhost',
    port: port ?? compose?.hostPort ?? 6379,
    db,
    // Valkey when the compose image or the client says so (the server itself is asked in redisDetails).
    flavor: (useCompose && /valkey/i.test(compose.image ?? '')) || (client && VALKEY_CLIENTS.test(client)) || /valkey/i.test(url) ? 'valkey' : 'redis',
    cacheDb: env.REDIS_CACHE_DB && /^\d+$/.test(env.REDIS_CACHE_DB.trim()) ? Number(env.REDIS_CACHE_DB) : null,
    connections: laravelRedisConnections(root, env),
    hasPassword: password,
    composeFile: useCompose ? compose.file : null,
    service: useCompose ? compose.service : null,
    image: useCompose ? compose.image : null,
    reachable: local || Boolean(useCompose && compose.hostPort),
  };
}

/** The Redis password from .env; read in the main process only (for AUTH), never sent to the UI. */
export function redisPassword(root: string, dirs: string[]): string | null {
  const env = readEnvFiles(...[root, ...dirs].flatMap((d) => [join(d, '.env'), join(d, '.env.local')]));
  const url = env.REDIS_URL || env.REDIS_URI || env.KV_URL || '';
  if (url) {
    try {
      return decodeURIComponent(new URL(url).password) || null;
    } catch {
      /* not a URL */
    }
    return null;
  }
  return laravelValue(env.REDIS_PASSWORD);
}

/** Sends one RESP command list per call and returns the raw replies (tiny client, no dependency). */
function redisCommands(host: string, port: number, commands: string[][], timeout = 1500): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: host === 'localhost' ? '127.0.0.1' : host, port });
    let buf = '';
    const replies: string[] = [];
    const done = (err?: Error) => {
      socket.destroy();
      if (err) reject(err);
      else resolve(replies);
    };
    socket.setTimeout(timeout, () => done(new Error('timeout')));
    socket.on('error', (e) => done(e));
    socket.on('connect', () => {
      socket.write(commands.map((c) => `*${c.length}\r\n${c.map((a) => `$${Buffer.byteLength(a)}\r\n${a}\r\n`).join('')}`).join(''));
    });
    socket.on('data', (d) => {
      buf += d.toString('utf8');
      // Parse as many complete replies as are buffered: +simple, -error, :int, $bulk.
      for (;;) {
        if (!buf.length) break;
        const nl = buf.indexOf('\r\n');
        if (nl < 0) break;
        const type = buf[0];
        if (type === '$') {
          const len = Number(buf.slice(1, nl));
          if (len < 0) {
            replies.push('');
            buf = buf.slice(nl + 2);
          } else {
            if (Buffer.byteLength(buf) < nl + 2 + len + 2) break;
            const body = Buffer.from(buf.slice(nl + 2)).subarray(0, len).toString('utf8');
            replies.push(body);
            buf = Buffer.from(buf.slice(nl + 2)).subarray(len + 2).toString('utf8');
          }
        } else {
          replies.push(buf.slice(0, nl));
          buf = buf.slice(nl + 2);
        }
      }
      if (replies.length >= commands.length) done();
    });
  });
}

/** Live details: version, memory, clients, key counts per database. */
export async function redisDetails(info: RedisInfo, password: string | null): Promise<RedisDetails> {
  const cmds: string[][] = [];
  if (password) cmds.push(['AUTH', password]);
  cmds.push(['INFO']);
  try {
    const replies = await redisCommands(info.host, info.port, cmds);
    const auth = password ? replies[0] : '+OK';
    if (auth.startsWith('-')) return { status: 'running', error: `AUTH failed: ${auth.slice(1)}` };
    const text = replies.at(-1) ?? '';
    if (text.startsWith('-')) return { status: 'running', error: text.slice(1) };
    const field = (k: string) => text.match(new RegExp(`^${k}:(.*)$`, 'm'))?.[1]?.trim() ?? null;
    const keyspace = [...text.matchAll(/^db(\d+):keys=(\d+),expires=(\d+)/gm)].map((m) => ({ db: Number(m[1]), keys: Number(m[2]), expires: Number(m[3]) }));
    return {
      status: 'running',
      // Valkey reports server_name:valkey (8+) and valkey_version next to a redis_version kept for clients.
      server: field('server_name') === 'valkey' || field('valkey_version') ? 'valkey' : 'redis',
      version: field('valkey_version') ?? field('redis_version'),
      memory: field('used_memory_human'),
      clients: Number(field('connected_clients')) || 0,
      uptimeDays: Number(field('uptime_in_days')) || 0,
      keyspace,
    };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { status: code === 'ECONNREFUSED' || code === 'EHOSTUNREACH' ? 'stopped' : 'unknown', error: (err as Error).message };
  }
}

/** Laravel's .env spells "no value" as `null` (also `(null)`); treat it like an empty value. */
function laravelValue(v: string | undefined): string | null {
  return !v || v === 'null' || v === '(null)' ? null : v;
}
