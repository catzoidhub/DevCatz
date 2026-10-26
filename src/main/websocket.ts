import { spawn } from 'node:child_process';
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { connect, type AddressInfo } from 'node:net';
import { join } from 'node:path';
import type { LogLine, StorageAction, TaskProgress, WsConfig, WsKind, WsProtocol, WsState, WsStats } from '@shared/types';
import { getShellEnv, isPortOpen, portOwner, run } from './env';
import { ProcessManager } from './processes';
import type { Route } from './proxy';
import { Cancelled, check, githubAsset, installFrom, INSTALL_STEPS } from './storage';
import { isNewer, packagistLatest, UPDATE_TAIL, upgradeBinaries } from './svcupdate';
import { dataDir, store, tld } from './store';

/**
 * Real-time servers, one instance per kind, managed like Object Storage:
 * official builds (GitHub releases, SHA-256 checked) in
 * <userData>/websocket/<kind>/bin, run by their own process manager and
 * served as wss://<label>.<tld> through the proxy.
 *
 * - Sockudo: Pusher protocol (laravel-echo, pusher-js, Laravel's `pusher`
 *   broadcaster); the maintained successor of Soketi.
 * - Centrifugo: its own protocol and SDKs, channels with presence and history, admin UI.
 * - Mercure: Symfony's hub (Server-Sent Events, JWT-protected publishing).
 * - NATS: messaging with a WebSocket listener (nats.ws in browsers).
 *
 * Settings are dev-friendly: any origin, anonymous Centrifugo clients may
 * subscribe and publish, Mercure lets anonymous subscribers in.
 */
export const WS_KINDS: WsKind[] = ['reverb', 'sockudo', 'centrifugo', 'mercure', 'nats'];

/** PHP for the shared Reverb: binary, a composer command and the env (php.ini, PATH), from Herd's PHP choice. */
export interface PhpRuntime {
  php: string;
  /** Shell command prefix for Composer, e.g. `'php' 'composer.phar'` or `composer` on PATH. */
  composer: string;
  env: Record<string, string>;
}
let phpRuntime: () => PhpRuntime | null = () => null;
export const setPhpRuntime = (fn: () => PhpRuntime | null) => (phpRuntime = fn);
/** The PHP DevCatz would run shared tools on (Expose client), null when none is 8.2+. */
export const getPhpRuntime = (): PhpRuntime | null => phpRuntime();
const needPhp = (): PhpRuntime => {
  const r = phpRuntime();
  if (!r) throw new Error('Laravel Reverb needs PHP 8.2+: install PHP on the Runtimes page first');
  return r;
};
/** Pusher protocol servers (same HTTP API, auth and .env shape). */
const PUSHER = (k: WsKind) => k === 'sockudo' || k === 'reverb';

type Report = (p: Partial<TaskProgress>) => void;

interface Engine {
  name: string;
  exe: string;
  protocol: WsProtocol;
  description: string;
  fields: WsState['fields'];
  defaults: Pick<WsConfig, 'port' | 'extraPort' | 'domain' | 'appId' | 'key' | 'secret'>;
  install(dir: string, progress: Report, signal: AbortSignal): Promise<void>;
  /** Newest release, from the installer's source (update check). */
  latest(): Promise<string>;
  versionArgs: string[];
  versionRe: RegExp;
  /** Version without running a binary (Reverb: composer.lock). */
  versionOf?(dir: string): Promise<string | null>;
  /** Writes the config file and returns the command + env (`hook`: DevCatz's webhook receiver, Sockudo). */
  spec(c: WsConfig, bin: string, hook: string | null): { command: string; env: Record<string, string>; cwd?: string };
  /** Path of the admin UI below the main port, if any. */
  admin?: string;
}

const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const host = (label: string) => `${label}.${tld()}`;
const secret = (n = 24) => randomBytes(n).toString('base64url');
const origins = (c: WsConfig) => c.allowedOrigins.split(/[\s,]+/).filter(Boolean);

const ENGINES: Record<WsKind, Engine> = {
  reverb: {
    name: 'Laravel Reverb',
    exe: 'app/artisan',
    protocol: 'pusher',
    description: 'Laravel’s own WebSocket server (Pusher protocol), one instance shared by every site: Laravel Echo / pusher-js, BROADCAST_CONNECTION=reverb.',
    fields: { appId: 'App ID', key: 'App key', secret: 'App secret', extraPort: null },
    defaults: { port: 8080, extraPort: 0, domain: 'reverb', appId: 'devcatz', key: 'devcatz-reverb', secret: '' },
    async install(dir, progress, signal) {
      // A tiny Laravel app that only runs Reverb (sites keep their own code; they connect with the app key).
      // -W: the newest skeleton can pin packages (guzzlehttp/psr7) newer than Reverb accepts.
      const r = needPhp();
      const app = join(dir, 'app');
      // Composer runs in its own process group so Cancel can kill it (and whatever it spawned); its last line is the progress detail.
      const sh = (cmd: string, cwd: string) =>
        new Promise<{ code: number; out: string }>((resolve) => {
          const child = spawn('/bin/sh', ['-c', cmd], { cwd, env: { ...getShellEnv(), ...r.env, COMPOSER_NO_INTERACTION: '1', COMPOSER_NO_AUDIT: '1' } as NodeJS.ProcessEnv, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
          let out = '';
          const feed = (d: Buffer) => {
            out = (out + d.toString()).slice(-8000);
            const line = out.trim().split(/\r?\n/).pop()?.replace(/^\s*-\s*/, '').trim();
            if (line) progress({ detail: line.slice(0, 120) });
          };
          child.stdout?.on('data', feed);
          child.stderr?.on('data', feed);
          const kill = () => {
            try {
              process.kill(-child.pid!, 'SIGTERM');
            } catch {
              child.kill('SIGTERM');
            }
          };
          signal.addEventListener('abort', kill, { once: true });
          const timer = setTimeout(kill, 900_000);
          child.on('error', (e) => {
            clearTimeout(timer);
            resolve({ code: 127, out: e.message });
          });
          child.on('close', (code) => {
            clearTimeout(timer);
            signal.removeEventListener('abort', kill);
            resolve({ code: code ?? 1, out });
          });
        });
      mkdirSync(dir, { recursive: true });
      progress({ step: 0, detail: 'composer create-project laravel/laravel (packagist.org)' });
      if (!existsSync(join(app, 'artisan'))) {
        rmSync(app, { recursive: true, force: true });
        progress({ step: 1, detail: 'composer create-project laravel/laravel app' });
        const c1 = await sh(`${r.composer} create-project laravel/laravel app --prefer-dist --no-interaction`, dir);
        check(signal);
        if (c1.code !== 0) throw new Error(`composer create-project failed: ${c1.out.trim().split('\n').slice(-3).join(' ')}`);
      }
      check(signal);
      progress({ step: 1, detail: 'composer require laravel/reverb' });
      const c2 = await sh(`${r.composer} require laravel/reverb --with-all-dependencies --no-interaction`, app);
      check(signal);
      if (c2.code !== 0) throw new Error(`composer require laravel/reverb failed: ${c2.out.trim().split('\n').slice(-3).join(' ')}`);
      progress({ step: 4, detail: join(app, 'artisan') });
    },
    latest: () => packagistLatest('laravel/reverb'),
    versionArgs: [],
    versionRe: /$^/,
    async versionOf(dir) {
      try {
        const lock = JSON.parse(readFileSync(join(dir, 'app', 'composer.lock'), 'utf8')) as { packages: { name: string; version: string }[] };
        return lock.packages.find((p) => p.name === 'laravel/reverb')?.version.replace(/^v/, '') ?? null;
      } catch {
        return null;
      }
    },
    spec(c, bin) {
      const r = needPhp();
      return {
        command: `${q(r.php)} artisan reverb:start --host=127.0.0.1 --port=${c.port}`,
        cwd: join(bin, '..'),
        env: {
          ...r.env,
          APP_ENV: 'local',
          APP_DEBUG: 'false',
          REVERB_APP_ID: c.appId,
          REVERB_APP_KEY: c.key,
          REVERB_APP_SECRET: c.secret,
          REVERB_SERVER_HOST: '127.0.0.1',
          REVERB_SERVER_PORT: String(c.port),
          REVERB_HOST: host(c.domain),
          // Nothing else of the app is used: no database, no cache server.
          DB_CONNECTION: 'sqlite',
          CACHE_STORE: 'array',
          SESSION_DRIVER: 'array',
          QUEUE_CONNECTION: 'sync',
          BROADCAST_CONNECTION: 'log',
          LOG_CHANNEL: 'stderr',
        },
      };
    },
  },
  sockudo: {
    name: 'Sockudo',
    exe: 'sockudo',
    protocol: 'pusher',
    description: 'Pusher-compatible server in Rust (successor of Soketi): laravel-echo, pusher-js and Laravel’s pusher broadcaster.',
    fields: { appId: 'App ID', key: 'App key', secret: 'App secret', extraPort: 'Metrics port' },
    defaults: { port: 6001, extraPort: 9601, domain: 'ws', appId: 'devcatz', key: 'devcatz-key', secret: '' },
    async install(dir, progress, signal) {
      progress({ step: 0, detail: 'github.com/sockudo/sockudo releases' });
      const a = await githubAsset('sockudo/sockudo', process.arch === 'arm64' ? /^sockudo-v[\d.]+-aarch64-apple-darwin\.tgz$/ : /^sockudo-v[\d.]+-x86_64-apple-darwin\.tgz$/);
      check(signal);
      await installFrom(a.url, a.sha256, dir, 'sockudo', `Sockudo ${a.tag}`, progress, signal);
    },
    latest: async () => (await githubAsset('sockudo/sockudo', process.arch === 'arm64' ? /^sockudo-v[\d.]+-aarch64-apple-darwin\.tgz$/ : /^sockudo-v[\d.]+-x86_64-apple-darwin\.tgz$/)).tag.replace(/^v/, ''),
    versionArgs: ['--version'],
    versionRe: /sockudo\s+([\w.-]+)/,
    spec(c, bin, hook) {
      const file = join(c.dataDir, 'sockudo.json');
      const conf = {
        host: '127.0.0.1',
        port: c.port,
        debug: false,
        metrics: { enabled: true, host: '127.0.0.1', port: c.extraPort },
        cors: { origin: origins(c), credentials: false },
        app_manager: {
          driver: 'memory',
          array: {
            apps: [
              {
                id: c.appId,
                key: c.key,
                secret: c.secret,
                enabled: true,
                enable_client_messages: true,
                max_connections: '10000',
                max_client_events_per_second: '1000',
                allowed_origins: origins(c),
                // Channel occupied / vacated → DevCatz's inspector (the HTTP API's channel list is unreliable in 4.x).
                ...(hook ? { webhooks: [{ url: hook, event_types: ['channel_occupied', 'channel_vacated'] }] } : {}),
              },
            ],
          },
        },
      };
      writeFileSync(file, JSON.stringify(conf, null, 2));
      return { command: `${q(bin)} --config ${q(file)}`, env: {} };
    },
  },
  centrifugo: {
    name: 'Centrifugo',
    exe: 'centrifugo',
    protocol: 'centrifugo',
    description: 'Language-agnostic real-time server: channels with presence and history, HTTP API, admin web UI.',
    fields: { appId: 'Admin password', key: 'HTTP API key', secret: 'Token HMAC secret', extraPort: null },
    defaults: { port: 8100, extraPort: 0, domain: 'centrifugo', appId: 'devcatz', key: '', secret: '' },
    async install(dir, progress, signal) {
      progress({ step: 0, detail: 'github.com/centrifugal/centrifugo releases' });
      const a = await githubAsset('centrifugal/centrifugo', process.arch === 'arm64' ? /^centrifugo_[\d.]+_darwin_arm64\.tar\.gz$/ : /^centrifugo_[\d.]+_darwin_amd64\.tar\.gz$/);
      check(signal);
      await installFrom(a.url, a.sha256, dir, 'centrifugo', `Centrifugo ${a.tag}`, progress, signal);
    },
    latest: async () => (await githubAsset('centrifugal/centrifugo', process.arch === 'arm64' ? /^centrifugo_[\d.]+_darwin_arm64\.tar\.gz$/ : /^centrifugo_[\d.]+_darwin_amd64\.tar\.gz$/)).tag.replace(/^v/, ''),
    versionArgs: ['version'],
    versionRe: /Centrifugo v([\w.-]+)/,
    admin: '/',
    spec(c, bin) {
      const file = join(c.dataDir, 'config.json');
      const open = {
        presence: true,
        join_leave: true,
        history_size: 100,
        history_ttl: '600s',
        allow_subscribe_for_client: true,
        allow_subscribe_for_anonymous: true,
        allow_publish_for_client: true,
        allow_publish_for_anonymous: true,
        allow_presence_for_client: true,
        allow_presence_for_anonymous: true,
        allow_history_for_client: true,
        allow_history_for_anonymous: true,
      };
      const conf = {
        http_server: { address: '127.0.0.1', port: c.port },
        client: { token: { hmac_secret_key: c.secret }, allowed_origins: origins(c), allow_anonymous_connect_without_token: true },
        channel: { without_namespace: open },
        admin: { enabled: true, password: c.appId, secret: createHash('sha256').update(`admin:${c.secret}`).digest('base64url') },
        http_api: { key: c.key },
        prometheus: { enabled: true },
        health: { enabled: true },
      };
      writeFileSync(file, JSON.stringify(conf, null, 2));
      return { command: `${q(bin)} --config ${q(file)}`, env: {} };
    },
  },
  mercure: {
    name: 'Mercure',
    exe: 'mercure',
    protocol: 'mercure',
    description: 'Symfony’s real-time hub (Server-Sent Events): publish with a JWT, subscribe from any browser.',
    fields: { appId: null, key: 'Publisher JWT key', secret: 'Subscriber JWT key', extraPort: null },
    defaults: { port: 8200, extraPort: 0, domain: 'mercure', appId: '', key: '', secret: '' },
    async install(dir, progress, signal) {
      progress({ step: 0, detail: 'github.com/dunglas/mercure releases' });
      const a = await githubAsset('dunglas/mercure', process.arch === 'arm64' ? /^mercure_Darwin_arm64\.tar\.gz$/ : /^mercure_Darwin_x86_64\.tar\.gz$/);
      check(signal);
      await installFrom(a.url, a.sha256, dir, 'mercure', `Mercure ${a.tag}`, progress, signal);
    },
    latest: async () => (await githubAsset('dunglas/mercure', process.arch === 'arm64' ? /^mercure_Darwin_arm64\.tar\.gz$/ : /^mercure_Darwin_x86_64\.tar\.gz$/)).tag.replace(/^v/, ''),
    versionArgs: ['version'],
    versionRe: /Mercure\.rocks\s+([\w.-]+)/,
    spec(c, bin) {
      const file = join(c.dataDir, 'Caddyfile');
      // Compatibility mode: tokens with just the `mercure` claim (Symfony / Laravel libraries) are accepted.
      writeFileSync(
        file,
        [
          '{',
          '\tauto_https off',
          '\tadmin off',
          '\tpersist_config off',
          // Caddyfile quotes with "…" (paths may contain spaces).
          `\tstorage file_system ${JSON.stringify(join(c.dataDir, 'caddy'))}`,
          '}',
          `:${c.port} {`,
          '\tbind 127.0.0.1',
          '\tmercure {',
          '\t\tpublisher_jwt {env.MERCURE_PUBLISHER_JWT_KEY} HS256',
          '\t\tsubscriber_jwt {env.MERCURE_SUBSCRIBER_JWT_KEY} HS256',
          '\t\tprotocol_version_compatibility 8',
          '\t\tanonymous',
          '\t\tsubscriptions',
          `\t\tcors_origins ${origins(c).join(' ')}`,
          `\t\tpublish_origins ${origins(c).join(' ')}`,
          '\t}',
          '\trespond / "Mercure hub (DevCatz). The hub URL is /.well-known/mercure"',
          '}',
          '',
        ].join('\n'),
      );
      return {
        command: `${q(bin)} run --config ${q(file)} --adapter caddyfile`,
        env: { MERCURE_PUBLISHER_JWT_KEY: c.key, MERCURE_SUBSCRIBER_JWT_KEY: c.secret, XDG_DATA_HOME: join(c.dataDir, 'caddy'), XDG_CONFIG_HOME: join(c.dataDir, 'caddy') },
      };
    },
  },
  nats: {
    name: 'NATS',
    exe: 'nats-server',
    protocol: 'nats',
    description: 'Messaging server with a WebSocket listener (nats.ws in the browser) next to its TCP port.',
    fields: { appId: null, key: 'Token (optional)', secret: null, extraPort: 'Client (TCP) port' },
    defaults: { port: 9222, extraPort: 4222, domain: 'nats', appId: '', key: '', secret: '' },
    async install(dir, progress, signal) {
      progress({ step: 0, detail: 'github.com/nats-io/nats-server releases' });
      const a = await githubAsset('nats-io/nats-server', process.arch === 'arm64' ? /^nats-server-v[\d.]+-darwin-arm64\.tar\.gz$/ : /^nats-server-v[\d.]+-darwin-amd64\.tar\.gz$/);
      check(signal);
      await installFrom(a.url, a.sha256, dir, 'nats-server', `NATS ${a.tag}`, progress, signal);
    },
    latest: async () => (await githubAsset('nats-io/nats-server', process.arch === 'arm64' ? /^nats-server-v[\d.]+-darwin-arm64\.tar\.gz$/ : /^nats-server-v[\d.]+-darwin-amd64\.tar\.gz$/)).tag.replace(/^v/, ''),
    versionArgs: ['--version'],
    versionRe: /nats-server:\s*v?([\w.-]+)/,
    spec(c, bin) {
      const file = join(c.dataDir, 'nats.conf');
      const lines = [
        'host: 127.0.0.1',
        `port: ${c.extraPort}`,
        `http: 127.0.0.1:${natsMonitorPort(c)}`,
        `websocket { host: 127.0.0.1, port: ${c.port}, no_tls: true${origins(c).includes('*') ? '' : `, allowed_origins: ${JSON.stringify(origins(c))}`} }`,
        ...(c.key ? [`authorization { token: ${JSON.stringify(c.key)} }`] : []),
        `jetstream { store_dir: ${JSON.stringify(join(c.dataDir, 'jetstream'))} }`,
      ];
      writeFileSync(file, `${lines.join('\n')}\n`);
      return { command: `${q(bin)} -c ${q(file)}`, env: {} };
    },
  },
};

/** NATS monitoring (HTTP) port: the WebSocket port + 1. */
export const natsMonitorPort = (c: WsConfig) => c.port + 1;
const portsOf = (c: WsConfig) => [c.port, ...(c.extraPort ? [c.extraPort] : []), ...(c.kind === 'nats' ? [natsMonitorPort(c)] : [])];

export const wsId = (kind: WsKind) => `ws:${kind}`;
const managedDir = (kind: WsKind) => dataDir('websocket', kind);
export const binaryDirOf = (c: Pick<WsConfig, 'kind' | 'binaryDir'>) => c.binaryDir || join(managedDir(c.kind), 'bin');
const binaryOf = (c: WsConfig) => join(binaryDirOf(c), ENGINES[c.kind].exe);

export function defaultsFor(kind: WsKind): WsConfig {
  const d = ENGINES[kind].defaults;
  return {
    kind,
    ...d,
    // Fresh keys per install; Pusher keys stay readable; NATS runs without a token unless one is set.
    key: d.key || (kind === 'nats' ? '' : secret()),
    secret: d.secret || secret(),
    appId: kind === 'centrifugo' ? secret(9) : d.appId,
    allowedOrigins: store.settings.wsAllowedOrigins || '*',
    dataDir: join(managedDir(kind), 'data'),
    binaryDir: join(managedDir(kind), 'bin'),
    autoStart: true,
  };
}

const LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;

// ------------------------------------------------------------------ protocol helpers

const b64url = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
/** HS256 JSON Web Token. */
export function jwt(payload: Record<string, unknown>, key: string): string {
  const head = b64url({ alg: 'HS256', typ: 'JWT' });
  const body = b64url(payload);
  return `${head}.${body}.${createHmac('sha256', key).update(`${head}.${body}`).digest('base64url')}`;
}

/** Signed query string for Pusher's HTTP API (auth_key, auth_timestamp, auth_version, body_md5, auth_signature). */
function pusherQuery(c: WsConfig, method: string, path: string, body: string | null, extra: Record<string, string> = {}): string {
  const params: Record<string, string> = { ...extra, auth_key: c.key, auth_timestamp: String(Math.floor(Date.now() / 1000)), auth_version: '1.0' };
  if (body !== null) params.body_md5 = createHash('md5').update(body).digest('hex');
  const qs = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`)
    .join('&');
  const sig = createHmac('sha256', c.secret).update(`${method}\n${path}\n${qs}`).digest('hex');
  return `${qs}&auth_signature=${sig}`;
}

async function getJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(4000) });
  const text = await res.text();
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return (text ? JSON.parse(text) : {}) as T;
}

/** Sum of Prometheus counters whose name matches `re`. */
function promSum(text: string, re: RegExp): number | null {
  let sum = 0;
  let found = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('#')) continue;
    const m = line.match(/^([a-zA-Z_:][\w:]*)(\{[^}]*\})?\s+([\d.eE+-]+)/);
    if (m && re.test(m[1])) {
      sum += Number(m[3]);
      found = true;
    }
  }
  return found ? sum : null;
}

// ------------------------------------------------------------------ manager

export class WsManager {
  readonly processes = new ProcessManager('ws-pids.json');
  private tasks = new Map<WsKind, TaskProgress>();
  private aborts = new Map<WsKind, AbortController>();
  private errors = new Map<WsKind, string>();
  /** Newer releases found by checkUpdates (kind → version). */
  private updates = new Map<WsKind, string>();
  /** Last message counter per kind, for messages per second. */
  private counters = new Map<WsKind, { at: number; total: number }>();
  /** Pusher channels seen lately (Sockudo's list endpoint is flaky): from its webhooks and the list. */
  private knownChannels = new Map<WsKind, Set<string>>();
  private hook: Promise<string> | null = null;

  /** A local receiver for Sockudo's channel webhooks, started on first use. */
  private hookUrl(): Promise<string> {
    this.hook ??= new Promise((resolve) => {
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (d) => (body += d));
        req.on('end', () => {
          try {
            const { events } = JSON.parse(body) as { events?: { name: string; channel: string }[] };
            const set = this.knownChannels.get('sockudo') ?? new Set<string>();
            for (const e of events ?? []) {
              if (e.name === 'channel_occupied') set.add(e.channel);
              else if (e.name === 'channel_vacated') set.delete(e.channel);
            }
            this.knownChannels.set('sockudo', set);
          } catch {
            /* not ours */
          }
          res.writeHead(200).end('ok');
        });
      });
      server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}/sockudo`));
      server.unref();
    });
    return this.hook;
  }
  /** Latest client count per kind (Monitoring reads it). */
  readonly lastClients = new Map<WsKind, number>();
  onChange: () => void = () => undefined;
  /** Every domain DevCatz already serves (sites, storage), to refuse clashes. */
  takenDomains: () => string[] = () => [];

  constructor() {
    this.processes.on('status', () => this.onChange());
    this.processes.on('log', (lines: LogLine[]) => {
      for (const l of lines) {
        const kind = l.projectId.replace(/^ws:/, '');
        try {
          appendFileSync(join(dataDir('logs'), `websocket-${kind}.log`), `${new Date(l.time).toISOString()} ${l.stream} ${l.text}\n`);
        } catch {
          /* best effort */
        }
      }
    });
    setInterval(() => void this.poll(), 1500);
    // Update check shortly after launch, then every 6 hours.
    setTimeout(() => void this.checkUpdates(), 35_000);
    setInterval(() => void this.checkUpdates(), 6 * 3600_000);
    // Client counts for Monitoring, also while the WebSocket page is closed.
    setInterval(() => {
      for (const kind of WS_KINDS) if (this.config(kind) && this.processes.getStatus(wsId(kind)).status === 'running') void this.stats(kind);
    }, 10_000);
  }

  /** "Starts with DevCatz" only: saved without restarting a running service. */
  setAutoStart(kind: WsKind, on: boolean): void {
    const c = this.config(kind);
    if (!c) throw new Error('Not installed');
    store.setWebsocket(kind, { ...c, autoStart: on });
    this.onChange();
  }

  config(kind: WsKind): WsConfig | null {
    return store.websockets[kind] ?? null;
  }

  private async poll(): Promise<void> {
    for (const kind of WS_KINDS) {
      const c = this.config(kind);
      if (!c || this.processes.getStatus(wsId(kind)).status !== 'starting') continue;
      if (await isPortOpen(c.port)) {
        this.processes.markRunning(wsId(kind));
        this.processes.log(wsId(kind), 'sys', `Ready → ${this.urls(c).ws}`);
      }
    }
  }

  /** Hides a task that ended (done, failed or cancelled). */
  dismissTask(kind: WsKind): void {
    const t = this.tasks.get(kind);
    if (t && (t.done || t.error)) {
      this.tasks.delete(kind);
      this.onChange();
    }
  }

  private task(kind: WsKind, init: TaskProgress) {
    this.tasks.set(kind, init);
    this.onChange();
    const report: Report = (p) => {
      const cur = this.tasks.get(kind);
      if (!cur) return;
      this.tasks.set(kind, { ...cur, ...p });
      this.onChange();
    };
    return {
      report,
      fail: (err: unknown): never => {
        report({ error: (err as Error).message });
        throw err;
      },
      finish: () => {
        report({ step: this.tasks.get(kind)?.steps.length ?? 0, done: true, detail: undefined, received: undefined, total: undefined });
        setTimeout(() => {
          if (this.tasks.get(kind)?.done) {
            this.tasks.delete(kind);
            this.onChange();
          }
        }, 4000);
      },
    };
  }

  validate(c: WsConfig): void {
    for (const p of portsOf(c)) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error(`Port ${p}: 1024–65535`);
    if (new Set(portsOf(c)).size !== portsOf(c).length) throw new Error('Ports must differ');
    if (!LABEL.test(c.domain)) throw new Error(`Domain "${c.domain}": lowercase letters, digits, hyphens and dots`);
    if (this.takenDomains().includes(host(c.domain))) throw new Error(`${host(c.domain)} is already used`);
    for (const kind of WS_KINDS) {
      const o = this.config(kind);
      if (!o || kind === c.kind) continue;
      const clash = portsOf(c).find((p) => portsOf(o).includes(p));
      if (clash) throw new Error(`Port ${clash} is used by ${ENGINES[kind].name}`);
      if (o.domain === c.domain) throw new Error(`${host(c.domain)} is used by ${ENGINES[kind].name}`);
    }
    const f = ENGINES[c.kind].fields;
    if (f.appId && !c.appId) throw new Error(`${f.appId} is required`);
    if (f.key && c.kind !== 'nats' && (!c.key || c.key.length < 4)) throw new Error(`${f.key}: at least 4 characters`);
    if (f.secret && (!c.secret || c.secret.length < 8)) throw new Error(`${f.secret}: at least 8 characters`);
    if (c.kind === 'mercure' && (c.key.length < 32 || c.secret.length < 32)) throw new Error('Mercure JWT keys: at least 32 characters (HS256)');
  }

  async install(kind: WsKind, input: WsConfig): Promise<void> {
    if (this.config(kind)) throw new Error(`${ENGINES[kind].name} is already installed`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is already being installed`);
    const c = { ...input, kind };
    this.validate(c);
    const steps = [...INSTALL_STEPS, ...(c.autoStart ? ['Starting'] : [])];
    const at = (name: string) => steps.indexOf(name);
    const t = this.task(kind, { kind: 'install', title: `Installing ${ENGINES[kind].name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    const placed = !existsSync(binaryOf(c));
    const dataExisted = existsSync(c.dataDir);
    try {
      await ENGINES[kind].install(binaryDirOf(c), t.report, abort.signal);
      check(abort.signal);
      t.report({ step: at('Checking the version'), detail: binaryOf(c), received: undefined, total: undefined });
      c.version = await this.version(c);
      if (!c.version) throw new Error(`${binaryOf(c)} does not run (wrong file or architecture?)`);
      t.report({ title: `Installing ${ENGINES[kind].name} ${c.version}`, step: at('Preparing the data folder'), detail: c.dataDir });
      mkdirSync(c.dataDir, { recursive: true });
      check(abort.signal);
      this.aborts.delete(kind);
      t.report({ step: at('Saving settings'), detail: `wss://${host(c.domain)}` });
      store.setWebsocket(kind, c);
      this.onChange();
      if (c.autoStart) {
        t.report({ step: at('Starting'), detail: `127.0.0.1:${c.port}` });
        await this.action(kind, 'start');
      }
      t.finish();
    } catch (err) {
      if (err instanceof Cancelled || abort.signal.aborted) {
        if (placed) await rm(c.kind === 'reverb' ? join(binaryDirOf(c), 'app') : binaryOf(c), { recursive: true, force: true }).catch(() => undefined);
        if (!dataExisted) await rm(c.dataDir, { recursive: true, force: true }).catch(() => undefined);
        t.report({ cancelled: true, error: 'Install cancelled; nothing was kept.', received: undefined, total: undefined });
        throw new Error('Install cancelled');
      }
      t.fail(err);
    } finally {
      this.aborts.delete(kind);
    }
  }

  /** Returns the names of the services that could not be checked (offline, GitHub rate limit …). */
  async checkUpdates(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      WS_KINDS.map(async (kind) => {
        const c = this.config(kind);
        if (!c) return void this.updates.delete(kind);
        const v = await ENGINES[kind].latest().catch(() => null);
        if (!v) failed.push(ENGINES[kind].name);
        else if (isNewer(v, c.version)) this.updates.set(kind, v);
        else this.updates.delete(kind);
      }),
    );
    this.onChange();
    return failed;
  }

  /** Newer release in place of the current binary (data folder and settings stay). */
  async upgrade(kind: WsKind): Promise<void> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is busy`);
    const steps = [...INSTALL_STEPS.slice(0, 5), ...UPDATE_TAIL];
    const t = this.task(kind, { kind: 'update', title: `Updating ${ENGINES[kind].name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    try {
      const v = await upgradeBinaries({
        binDir: binaryDirOf(c),
        install: (d, report, signal) => ENGINES[kind].install(d, report, signal),
        inPlace: kind === 'reverb',
        stop: () => this.processes.stop(wsId(kind)),
        start: () => this.action(kind, 'start'),
        wasActive: this.isActive(kind),
        version: () => this.version(c),
        report: t.report,
        signal: abort.signal,
        tailAt: 5,
      });
      store.setWebsocket(kind, { ...this.config(kind)!, version: v });
      this.updates.delete(kind);
      this.processes.log(wsId(kind), 'sys', `Updated ${c.version ?? ''} → ${v}`);
      t.report({ title: `Updated ${ENGINES[kind].name} to ${v}` });
      t.finish();
    } catch (err) {
      t.fail(abort.signal.aborted ? new Error('Update cancelled; the current version was kept') : err);
    } finally {
      this.aborts.delete(kind);
      this.onChange();
    }
  }

  cancelInstall(kind: WsKind): void {
    this.aborts.get(kind)?.abort();
  }

  private async version(c: WsConfig): Promise<string | null> {
    const bin = binaryOf(c);
    if (!existsSync(bin)) return null;
    const own = ENGINES[c.kind].versionOf;
    if (own) return own(binaryDirOf(c));
    const r = await run(bin, ENGINES[c.kind].versionArgs, { timeout: 15_000 });
    const v = `${r.stdout}\n${r.stderr}`.match(ENGINES[c.kind].versionRe)?.[1];
    return r.code === 0 || v ? (v ?? 'unknown') : null;
  }

  async update(kind: WsKind, input: WsConfig): Promise<void> {
    const old = this.config(kind);
    if (!old) throw new Error('Not installed');
    const c = { ...old, ...input, kind, version: old.version, binaryDir: old.binaryDir };
    this.validate(c);
    mkdirSync(c.dataDir, { recursive: true });
    store.setWebsocket(kind, c);
    if (this.isActive(kind)) await this.action(kind, 'restart');
    this.onChange();
  }

  async uninstall(kind: WsKind, deleteData: boolean): Promise<void> {
    const c = this.config(kind);
    if (!c) return;
    const steps = ['Stopping the server', 'Removing the binary', ...(deleteData ? ['Deleting the data folder'] : []), 'Removing settings'];
    const t = this.task(kind, { kind: 'uninstall', title: `Uninstalling ${ENGINES[kind].name}`, steps, step: 0 });
    try {
      await this.processes.stop(wsId(kind));
      t.report({ step: 1, detail: binaryOf(c) });
      await rm(c.kind === 'reverb' ? join(binaryDirOf(c), 'app') : binaryOf(c), { recursive: true, force: true });
      if (deleteData) {
        t.report({ step: steps.indexOf('Deleting the data folder'), detail: c.dataDir });
        await rm(c.dataDir, { recursive: true, force: true });
      }
      t.report({ step: steps.indexOf('Removing settings') });
      store.setWebsocket(kind, null);
      this.processes.clearLogs(wsId(kind));
      t.finish();
    } catch (err) {
      t.fail(err);
    }
  }

  isActive(kind: WsKind): boolean {
    return this.processes.isActive(wsId(kind));
  }

  async action(kind: WsKind, action: StorageAction): Promise<void> {
    const id = wsId(kind);
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (action === 'stop' || action === 'restart') await this.processes.stop(id);
    if (action === 'stop') return;
    for (let i = 0; i < 10 && (await isPortOpen(c.port)); i++) await new Promise((r) => setTimeout(r, 300));
    for (const port of portsOf(c)) {
      if (await isPortOpen(port)) {
        const owner = await portOwner(port);
        const msg = `Port ${port} is already in use${owner ? ` by ${owner}` : ''}; change it in ${ENGINES[kind].name}'s settings.`;
        this.processes.log(id, 'sys', msg);
        this.errors.set(kind, msg);
        this.onChange();
        throw new Error(msg);
      }
    }
    this.errors.delete(kind);
    const bin = binaryOf(c);
    if (!existsSync(bin)) throw new Error(`${bin} is missing; reinstall ${ENGINES[kind].name}`);
    mkdirSync(c.dataDir, { recursive: true });
    const s = ENGINES[kind].spec(c, bin, kind === 'sockudo' ? await this.hookUrl() : null);
    this.processes.startMany(id, [{ label: '', command: s.command, env: s.env, cwd: s.cwd ?? c.dataDir }]);
  }

  autoStart(): void {
    for (const kind of WS_KINDS) if (this.config(kind)?.autoStart) this.action(kind, 'start').catch((e) => console.error(`${kind}:`, e.message));
  }

  stopAll(): Promise<void> {
    return this.processes.stopAll();
  }

  urls(c: WsConfig): NonNullable<WsState['urls']> {
    const d = host(c.domain);
    const path = c.kind === 'centrifugo' ? '/connection/websocket' : PUSHER(c.kind) ? `/app/${c.key}` : c.kind === 'mercure' ? '/.well-known/mercure' : '';
    const wsScheme = c.kind === 'mercure' ? 'https' : 'wss';
    return {
      ws: `${wsScheme}://${d}${path}`,
      wsLocal: `${c.kind === 'mercure' ? 'http' : 'ws'}://127.0.0.1:${c.port}${path}`,
      http: `https://${d}`,
      httpLocal: `http://127.0.0.1:${c.kind === 'nats' ? natsMonitorPort(c) : c.port}`,
      admin: ENGINES[c.kind].admin ? `https://${d}${ENGINES[c.kind].admin}` : c.kind === 'nats' ? `http://127.0.0.1:${natsMonitorPort(c)}` : null,
    };
  }

  routes(): Route[] {
    const out: Route[] = [];
    for (const kind of WS_KINDS) {
      const c = this.config(kind);
      if (!c) continue;
      // Mercure derives topic URLs from the Host; Pusher/Centrifugo check Origin, not Host.
      out.push({ domain: host(c.domain), port: c.port, projectName: ENGINES[kind].name, running: this.isActive(kind), secure: true, keepHost: kind === 'mercure' });
    }
    return out;
  }

  state(): WsState[] {
    return WS_KINDS.map((kind) => {
      const c = this.config(kind);
      const e = ENGINES[kind];
      return {
        kind,
        name: e.name,
        protocol: e.protocol,
        description: e.description,
        fields: e.fields,
        installed: Boolean(c),
        config: c,
        defaults: defaultsFor(kind),
        binary: c ? binaryOf(c) : null,
        status: this.processes.getStatus(wsId(kind)).status,
        error: this.errors.get(kind) ?? null,
        task: this.tasks.get(kind) ?? null,
        update: c ? (this.updates.get(kind) ?? null) : null,
        urls: c ? this.urls(c) : null,
      };
    });
  }

  // ------------------------------------------------------------------ live numbers, publishing, test clients

  private rate(kind: WsKind, total: number | null): number | null {
    if (total === null) return null;
    const now = Date.now();
    const prev = this.counters.get(kind);
    this.counters.set(kind, { at: now, total });
    if (!prev || total < prev.total || now - prev.at < 200) return null;
    return (total - prev.total) / ((now - prev.at) / 1000);
  }

  async stats(kind: WsKind): Promise<WsStats> {
    const c = this.config(kind);
    if (!c) throw new Error('Not installed');
    const at = Date.now();
    if (!this.isActive(kind)) return { at, clients: 0, channels: [], messagesPerSec: null };
    try {
      const out = await this.read(c);
      this.lastClients.set(kind, out.clients);
      return { at, ...out };
    } catch (err) {
      return { at, clients: 0, channels: [], messagesPerSec: null, error: (err as Error).message };
    }
  }

  private async read(c: WsConfig): Promise<Omit<WsStats, 'at'>> {
    const base = `http://127.0.0.1:${c.port}`;
    if (c.kind === 'reverb') {
      // Reverb's Pusher API: the channel list with counts, and the open connections.
      const path = `/apps/${c.appId}/channels`;
      const r = await getJson<{ channels: Record<string, { subscription_count?: number; user_count?: number }> }>(`${base}${path}?${pusherQuery(c, 'GET', path, null, { info: 'subscription_count' })}`);
      const channels = await Promise.all(
        Object.entries(r.channels ?? {}).map(async ([name, v]) => {
          // Presence channels: the list leaves the count out; the channel's own info has the members.
          if (!name.startsWith('presence-')) return { name, clients: v.subscription_count ?? 0, members: v.user_count };
          const p = `/apps/${c.appId}/channels/${encodeURIComponent(name)}`;
          const d = await getJson<{ subscription_count?: number; user_count?: number }>(`${base}${p}?${pusherQuery(c, 'GET', p, null, { info: 'user_count' })}`).catch(() => ({}) as { subscription_count?: number; user_count?: number });
          return { name, clients: d.subscription_count ?? d.user_count ?? 0, members: d.user_count };
        }),
      );
      const cp = `/apps/${c.appId}/connections`;
      const conns = await getJson<{ connections?: number }>(`${base}${cp}?${pusherQuery(c, 'GET', cp, null)}`).catch(() => ({ connections: undefined }));
      return { clients: conns.connections ?? channels.reduce((n, x) => n + x.clients, 0), channels, messagesPerSec: null };
    }
    if (c.kind === 'sockudo') {
      // Sockudo's channel list is not reliable from one request to the next (it alternates between full and empty),
      // so names seen in either form of the list are remembered and each one is asked for directly (always exact).
      const path = `/apps/${c.appId}/channels`;
      const known = this.knownChannels.get(c.kind) ?? new Set<string>();
      for (const extra of [{}, { info: 'subscription_count' }] as Record<string, string>[]) {
        const r = await getJson<{ channels: Record<string, unknown> }>(`${base}${path}?${pusherQuery(c, 'GET', path, null, extra)}`).catch(() => ({ channels: {} }));
        for (const name of Object.keys(r.channels ?? {})) known.add(name);
      }
      const all = await Promise.all(
        [...known].slice(0, 100).map(async (name) => {
          const p = `/apps/${c.appId}/channels/${encodeURIComponent(name)}`;
          const info = name.startsWith('presence-') ? 'subscription_count,user_count' : 'subscription_count';
          const d = await getJson<{ occupied?: boolean; subscription_count?: number; user_count?: number }>(`${base}${p}?${pusherQuery(c, 'GET', p, null, { info })}`).catch(() => null);
          return d ? { name, occupied: d.occupied !== false && (d.subscription_count ?? 1) > 0, clients: d.subscription_count ?? 0, members: d.user_count } : null;
        }),
      );
      const channels = all.filter((x): x is NonNullable<typeof x> => Boolean(x?.occupied)).map(({ name, clients, members }) => ({ name, clients, members }));
      this.knownChannels.set(c.kind, new Set(channels.map((x) => x.name)));
      const metrics = await fetch(`http://127.0.0.1:${c.extraPort}/metrics`, { signal: AbortSignal.timeout(3000) })
        .then((x) => x.text())
        .catch(() => '');
      const connected = promSum(metrics, /connected/);
      const msgs = promSum(metrics, /(ws_messages_(sent|received)|messages?_(sent|received))(_total)?$/);
      return { clients: connected ?? channels.reduce((n, ch) => n + ch.clients, 0), channels, messagesPerSec: this.rate(c.kind, msgs) };
    }
    if (c.kind === 'centrifugo') {
      const api = (method: string) => getJson<{ result: Record<string, unknown> }>(`${base}/api/${method}`, { method: 'POST', headers: { 'X-API-Key': c.key }, body: '{}' });
      const ch = (await api('channels')).result as { channels?: Record<string, { num_clients: number }> };
      const channels = Object.entries(ch.channels ?? {}).map(([name, v]) => ({ name, clients: v.num_clients }));
      const metrics = await fetch(`${base}/metrics`, { signal: AbortSignal.timeout(3000) })
        .then((x) => x.text())
        .catch(() => '');
      const clients = promSum(metrics, /^centrifugo_node_num_clients$/);
      const msgs = promSum(metrics, /^centrifugo_node_messages_(sent|received)_count$/);
      // node_num_clients is refreshed once a minute: never show fewer than the channels have.
      return { clients: Math.max(clients ?? 0, ...channels.map((x) => x.clients)), channels, messagesPerSec: this.rate(c.kind, msgs) };
    }
    if (c.kind === 'mercure') {
      const token = jwt({ mercure: { subscribe: ['*'], publish: [] } }, c.secret);
      const r = await getJson<{ subscriptions: { topic: string; subscriber: string; active: boolean }[] }>(`${base}/.well-known/mercure/subscriptions`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const by = new Map<string, number>();
      const subs = new Set<string>();
      for (const s of r.subscriptions ?? []) {
        if (!s.active || s.topic.startsWith('/.well-known/mercure/subscriptions')) continue;
        by.set(s.topic, (by.get(s.topic) ?? 0) + 1);
        subs.add(s.subscriber);
      }
      return { clients: subs.size, channels: [...by].map(([name, clients]) => ({ name, clients })), messagesPerSec: null };
    }
    // NATS: monitoring endpoints.
    const mon = `http://127.0.0.1:${natsMonitorPort(c)}`;
    const [varz, connz] = await Promise.all([
      getJson<{ connections: number; in_msgs: number; out_msgs: number }>(`${mon}/varz`),
      getJson<{ connections?: { subscriptions_list?: string[] }[] }>(`${mon}/connz?subs=1`),
    ]);
    const by = new Map<string, number>();
    for (const conn of connz.connections ?? []) for (const s of conn.subscriptions_list ?? []) if (!s.startsWith('_INBOX')) by.set(s, (by.get(s) ?? 0) + 1);
    return { clients: varz.connections, channels: [...by].map(([name, clients]) => ({ name, clients })), messagesPerSec: this.rate(c.kind, varz.in_msgs + varz.out_msgs) };
  }

  async publish(kind: WsKind, channel: string, event: string, data: string): Promise<void> {
    const c = this.config(kind);
    if (!c) throw new Error('Not installed');
    if (!this.isActive(kind)) throw new Error(`${ENGINES[kind].name} is not running`);
    if (!channel.trim()) throw new Error('Channel is required');
    const base = `http://127.0.0.1:${c.port}`;
    let parsed: unknown = data;
    try {
      parsed = JSON.parse(data);
    } catch {
      /* plain text */
    }
    if (PUSHER(kind)) {
      const path = `/apps/${c.appId}/events`;
      const body = JSON.stringify({ name: event || 'test-event', channel, data: typeof parsed === 'string' ? parsed : JSON.stringify(parsed) });
      await getJson(`${base}${path}?${pusherQuery(c, 'POST', path, body)}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
    } else if (kind === 'centrifugo') {
      await getJson(`${base}/api/publish`, { method: 'POST', headers: { 'X-API-Key': c.key }, body: JSON.stringify({ channel, data: typeof parsed === 'object' ? parsed : { text: parsed } }) });
    } else if (kind === 'mercure') {
      const token = jwt({ mercure: { publish: ['*'] } }, c.key);
      const res = await fetch(`${base}/.well-known/mercure`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ topic: channel, data, ...(event ? { type: event } : {}) }).toString(),
        signal: AbortSignal.timeout(4000),
      });
      if (!res.ok) throw new Error(`Mercure: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    } else {
      await natsPublish(c, channel, data);
    }
  }

  /** Credentials for DevCatz's test client. */
  clientAuth(kind: WsKind, socketId: string, channel: string): string {
    const c = this.config(kind);
    if (!c) throw new Error('Not installed');
    if (PUSHER(kind)) {
      if (channel.startsWith('presence-')) {
        const data = JSON.stringify({ user_id: 'devcatz-test', user_info: { name: 'DevCatz test client' } });
        const sig = createHmac('sha256', c.secret).update(`${socketId}:${channel}:${data}`).digest('hex');
        return JSON.stringify({ auth: `${c.key}:${sig}`, channel_data: data });
      }
      return JSON.stringify({ auth: `${c.key}:${createHmac('sha256', c.secret).update(`${socketId}:${channel}`).digest('hex')}` });
    }
    if (kind === 'centrifugo') return jwt({ sub: 'devcatz-test', exp: Math.floor(Date.now() / 1000) + 3600 }, c.secret);
    if (kind === 'mercure') return jwt({ mercure: { subscribe: ['*'] } }, c.secret);
    return c.key;
  }

  /** .env lines for a site that uses this server. */
  /** `publicPort`: the HTTPS port browsers reach the proxy on (443 with clean URLs). */
  env(kind: WsKind, runtime: string, publicPort = 443): Record<string, string> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    const d = host(c.domain);
    /** host[:port] for browser URLs. */
    const pub = publicPort === 443 ? d : `${d}:${publicPort}`;
    if (kind === 'reverb' && runtime === 'php') {
      // Laravel's reverb broadcaster publishes to 127.0.0.1 (no TLS); Echo connects to wss://<domain> through the proxy.
      return {
        BROADCAST_CONNECTION: 'reverb',
        REVERB_APP_ID: c.appId,
        REVERB_APP_KEY: c.key,
        REVERB_APP_SECRET: c.secret,
        REVERB_HOST: '127.0.0.1',
        REVERB_PORT: String(c.port),
        REVERB_SCHEME: 'http',
        VITE_REVERB_APP_KEY: '${REVERB_APP_KEY}',
        VITE_REVERB_HOST: d,
        VITE_REVERB_PORT: String(publicPort),
        VITE_REVERB_SCHEME: 'https',
      };
    }
    if (PUSHER(kind)) {
      // Backends publish to 127.0.0.1 (no TLS: any PHP / Node works); browsers use wss://<domain> through the proxy.
      const lines: Record<string, string> = {
        PUSHER_APP_ID: c.appId,
        PUSHER_APP_KEY: c.key,
        PUSHER_APP_SECRET: c.secret,
        PUSHER_HOST: '127.0.0.1',
        PUSHER_PORT: String(c.port),
        PUSHER_SCHEME: 'http',
        PUSHER_APP_CLUSTER: 'mt1',
      };
      const browser = { VITE_PUSHER_APP_KEY: c.key, VITE_PUSHER_HOST: d, VITE_PUSHER_PORT: String(publicPort), VITE_PUSHER_SCHEME: 'https', VITE_PUSHER_APP_CLUSTER: 'mt1' };
      if (runtime === 'php') return { BROADCAST_CONNECTION: 'pusher', ...lines, ...browser };
      return { ...lines, ...browser, NUXT_PUBLIC_PUSHER_KEY: c.key, NUXT_PUBLIC_PUSHER_HOST: d, NUXT_PUBLIC_PUSHER_PORT: String(publicPort) };
    }
    if (kind === 'centrifugo') {
      return {
        CENTRIFUGO_URL: `https://${pub}`,
        CENTRIFUGO_API_URL: `http://127.0.0.1:${c.port}/api`,
        CENTRIFUGO_API_KEY: c.key,
        CENTRIFUGO_TOKEN_HMAC_SECRET_KEY: c.secret,
        VITE_CENTRIFUGO_WS: `wss://${pub}/connection/websocket`,
        ...(runtime === 'php' ? { BROADCAST_CONNECTION: 'centrifugo' } : {}),
      };
    }
    if (kind === 'mercure') {
      return {
        MERCURE_URL: `http://127.0.0.1:${c.port}/.well-known/mercure`,
        MERCURE_PUBLIC_URL: `https://${pub}/.well-known/mercure`,
        MERCURE_JWT_SECRET: c.key,
        MERCURE_PUBLISHER_JWT_KEY: c.key,
        MERCURE_SUBSCRIBER_JWT_KEY: c.secret,
      };
    }
    return {
      NATS_URL: `nats://127.0.0.1:${c.extraPort}`,
      NATS_WS_URL: `wss://${pub}`,
      VITE_NATS_WS_URL: `wss://${pub}`,
      ...(c.key ? { NATS_TOKEN: c.key } : {}),
    };
  }
}

/** Publishes over NATS' TCP protocol (CONNECT, PUB, PING → PONG). */
function natsPublish(c: WsConfig, subject: string, data: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(c.extraPort, '127.0.0.1');
    const payload = Buffer.from(data);
    let buf = '';
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new Error('NATS: no answer'));
    }, 4000);
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      if (buf.startsWith('INFO') && !buf.includes('PONG') && !sock.writableEnded && buf.includes('\r\n') && !(sock as unknown as { sent?: boolean }).sent) {
        (sock as unknown as { sent?: boolean }).sent = true;
        sock.write(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, ...(c.key ? { auth_token: c.key } : {}) })}\r\nPUB ${subject} ${payload.length}\r\n`);
        sock.write(payload);
        sock.write('\r\nPING\r\n');
      }
      if (buf.includes('-ERR')) {
        clearTimeout(timer);
        sock.destroy();
        reject(new Error(`NATS: ${buf.slice(buf.indexOf('-ERR')).split('\r\n')[0]}`));
      } else if (buf.includes('PONG')) {
        clearTimeout(timer);
        sock.end();
        resolve();
      }
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}
