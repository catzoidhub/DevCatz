import { spawn } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { connect as netConnect } from 'node:net';
import { join } from 'node:path';
import type { CaughtSms, GwCategory, GwConfig, GwKind, GwSendInput, GwSendResult, GwState, ProjectConfig, StorageAction, TaskProgress } from '@shared/types';
import { readEnvFiles } from '../detect';
import { containerOf, defaultContainer, docatzAvailable, gatewayCompose, gatewayDocker, gatewayEngineReady, hostGateway, otherEngineName, type GwContainer } from '../docker';
import { getShellEnv, run } from '../env';
import { sendMail } from '../mail/smtp';
import { ProcessManager } from '../processes';
import type { Route } from '../proxy';
import { Cancelled, check, githubAsset, installFrom } from '../storage';
import { dataDir, store, tld } from '../store';
import { githubLatest, isNewer } from '../svcupdate';
import { jcli } from './jcli';
import { SmppCatcher } from './smpp';
import { exe, isLinux, isWin } from '../platform';
import { firewallWords, forwardFromWsl, wslReaches } from '../wslhost';
import { giveBackToUser } from '../linuxadmin';
import { words } from '@shared/platform';

/**
 * Email, push and SMS gateways for local development, next to the WhatsApp
 * ones: Stalwart (mail server, a binary), Postal (mail delivery platform),
 * ntfy and Gotify (push notifications) and Jasmin (SMS, with DevCatz's own
 * SMPP catcher as its operator), the last four as Docker Compose projects.
 *
 * Each runs on 127.0.0.1 and on https://<label>.<tld>; outgoing email goes to
 * DevCatz's mail catcher and every SMS to the SMS catcher, so nothing leaves
 * this Mac. The first start sets each one up (users, keys, tokens, routes).
 */

interface Hooks {
  projects(): ProjectConfig[];
  runtime(siteId: string): 'node' | 'go' | 'php' | 'python' | 'rust' | 'ruby' | null;
  framework(siteId: string): string | null;
  takenDomains(): string[];
  /** Ports used elsewhere (WhatsApp engines …), for the conflict check. */
  takenPorts(): number[];
  /** https://<host> with the proxy's port suffix. */
  urlOf(host: string): string;
  mailPort(): number;
  /** Starts DevCatz's mail catcher when it is off (Postal and Stalwart relay every message to it). */
  startMail(): Promise<void>;
  changed(): void;
  notify(title: string, body: string): void;
}

type Report = (p: Partial<TaskProgress>) => void;

interface EngineDef {
  name: string;
  category: GwCategory;
  description: string;
  docker: boolean;
  port: number;
  ports: Record<string, number>;
  portFields: { key: string; label: string }[];
  label: string;
  user: string;
  webPath: string | null;
}

const ENGINES: Record<GwKind, EngineDef> = {
  stalwart: {
    name: 'Stalwart',
    category: 'email',
    description: 'A complete mail server in one binary: SMTP, IMAP and JMAP with accounts and a web admin. Mail to other domains goes to the DevCatz mail catcher.',
    docker: false,
    port: 8490,
    ports: { smtp: 2530, submission: 5875, imap: 1435 },
    portFields: [
      { key: 'submission', label: 'SMTP submission (sites send here)' },
      { key: 'smtp', label: 'SMTP (inbound)' },
      { key: 'imap', label: 'IMAP' },
    ],
    label: 'stalwart',
    user: 'admin',
    webPath: '/admin',
  },
  postal: {
    name: 'Postal',
    category: 'email',
    description: 'A mail delivery platform like Mailgun or SendGrid: HTTP API, SMTP, webhooks and a web UI (Docker, with MariaDB). Delivery goes to the DevCatz mail catcher.',
    docker: true,
    port: 5010,
    ports: { smtp: 2540 },
    portFields: [{ key: 'smtp', label: 'SMTP' }],
    label: 'postal',
    user: 'admin@devcatz.test',
    webPath: '/',
  },
  ntfy: {
    name: 'ntfy',
    category: 'push',
    description: 'Push notifications over plain HTTP: publish to a topic, receive on phones (ntfy app), browsers and scripts (Docker).',
    docker: true,
    port: 8492,
    ports: {},
    portFields: [],
    label: 'ntfy',
    user: 'devcatz',
    webPath: '/',
  },
  gotify: {
    name: 'Gotify',
    category: 'push',
    description: 'Self-hosted push notifications with a REST API, per-app tokens, a web UI and an Android app (Docker).',
    docker: true,
    port: 8493,
    ports: {},
    portFields: [],
    label: 'gotify',
    user: 'devcatz',
    webPath: '/',
  },
  jasmin: {
    name: 'Jasmin',
    category: 'sms',
    description: 'An SMS gateway with an HTTP API and SMPP (Docker, with Redis and RabbitMQ). Messages go to the DevCatz SMS catcher instead of an operator.',
    docker: true,
    port: 8494,
    ports: { jcli: 8995, smpp: 2776 },
    portFields: [
      { key: 'smpp', label: `SMS catcher (SMPP, on this ${words.computer})` },
      { key: 'jcli', label: 'jCli console' },
    ],
    label: 'jasmin',
    user: 'jcliadmin',
    webPath: null,
  },
  telegram: {
    name: 'Telegram Bot API',
    category: 'telegram',
    description: `Telegram's official Bot API server (tdlib/telegram-bot-api) on this ${words.computer}: the same API as api.telegram.org, webhooks to any local URL (http, any port) and files up to 2 GB (Docker).`,
    docker: true,
    port: 8496,
    ports: {},
    portFields: [],
    label: 'telegram',
    user: 'devcatz',
    webPath: null,
  },
};
export const GW_KINDS: GwKind[] = ['telegram', 'stalwart', 'postal', 'ntfy', 'gotify', 'jasmin'];

const IMAGE: Record<Exclude<GwKind, 'stalwart'>, string> = {
  postal: 'ghcr.io/postalserver/postal',
  ntfy: 'binwiederhier/ntfy',
  gotify: 'gotify/server',
  jasmin: 'jookies/jasmin',
  telegram: 'aiogram/telegram-bot-api',
};
const MAIL_DOMAIN = 'devcatz.test';
const gwId = (kind: GwKind) => `gw:${kind}`;
const project = (kind: GwKind) => `devcatz-gw-${kind}`;
/** A Docker gateway's compose project (how DoCatz lists its containers). */
export const gwProject = project;
const host = (label: string) => `${label}.${tld()}`;
const secret = (n = 18) => randomBytes(n).toString('base64url').slice(0, n);
const q = (s: string) => `'${s.replace(/'/g, "'\\''")}'`;
const yamlStr = (s: string) => JSON.stringify(s);

interface Stored {
  configs: Partial<Record<GwKind, GwConfig>>;
}

/** Newest version tag on Docker Hub matching `re` (group 1 = version). */
async function hubLatest(repo: string, re: RegExp): Promise<string> {
  const res = await fetch(`https://hub.docker.com/v2/repositories/${repo}/tags?page_size=100&ordering=last_updated`);
  if (!res.ok) throw new Error(`Docker Hub: HTTP ${res.status}`);
  const versions = ((await res.json()) as { results: { name: string }[] }).results.map((t) => t.name.match(re)?.[1]).filter((v): v is string => Boolean(v));
  if (!versions.length) throw new Error(`No release tag in ${repo}`);
  return versions.sort((a, b) => (isNewer(a, b) ? -1 : 1))[0];
}

/** Newest x.y.z tag of a GitHub Container Registry image. */
async function ghcrLatest(repo: string): Promise<string> {
  const token = ((await (await fetch(`https://ghcr.io/token?scope=repository:${repo}:pull`)).json()) as { token: string }).token;
  const res = await fetch(`https://ghcr.io/v2/${repo}/tags/list?n=1000`, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`ghcr.io: HTTP ${res.status}`);
  const tags = ((await res.json()) as { tags: string[] }).tags.filter((t) => /^\d+\.\d+\.\d+$/.test(t));
  if (!tags.length) throw new Error(`No release tag in ${repo}`);
  return tags.sort((a, b) => (isNewer(a, b) ? -1 : 1))[0];
}

const LATEST: Record<GwKind, () => Promise<string>> = {
  stalwart: async () => (await githubLatest('stalwartlabs/stalwart')).replace(/^v/, ''),
  postal: () => ghcrLatest('postalserver/postal'),
  ntfy: () => hubLatest('binwiederhier/ntfy', /^v(\d+\.\d+\.\d+)$/),
  gotify: () => hubLatest('gotify/server', /^(\d+\.\d+\.\d+)$/),
  jasmin: () => hubLatest('jookies/jasmin', /^(\d+\.\d+\.\d+)$/),
  telegram: () => hubLatest('aiogram/telegram-bot-api', /^(\d+\.\d+(?:\.\d+)?)$/),
};
/** Image tag for a version (ntfy tags carry a v). */
const tagOf = (kind: GwKind, v: string) => (kind === 'ntfy' ? `v${v}` : v);

/** Waits until a TCP port accepts connections (up to `ms`). */
async function waitPort(port: number, ms: number, alive: () => boolean): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && alive()) {
    const ok = await new Promise<boolean>((resolve) => {
      const s = netConnect({ host: '127.0.0.1', port });
      s.once('connect', () => {
        s.destroy();
        resolve(true);
      });
      s.once('error', () => resolve(false));
      s.setTimeout(1500, () => {
        s.destroy();
        resolve(false);
      });
    });
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

/**
 * Waits until the app itself answers HTTP on the port (Docker publishes a port
 * before the container listens, so an open port alone proves nothing).
 */
async function waitHttp(port: number, ms: number, alive: () => boolean, hostHeader?: string): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until && alive()) {
    const ok = await http('GET', port, '/', { host: hostHeader }).then(
      (r) => r.status > 0,
      () => false,
    );
    if (ok) return true;
    await new Promise((r) => setTimeout(r, 1500));
  }
  return false;
}

/** HTTP on 127.0.0.1 with a chosen Host header (Postal answers its own hostname only). */
function http(method: string, port: number, path: string, o: { host?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const body = o.body === undefined ? undefined : Buffer.from(o.body, 'utf8');
    const req = httpRequest(
      { host: '127.0.0.1', port, method, path, headers: { ...(o.host ? { Host: o.host } : {}), ...(body ? { 'Content-Length': String(body.length) } : {}), ...o.headers }, timeout: 30_000 },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (d: Buffer) => chunks.push(d));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
      },
    );
    req.on('timeout', () => req.destroy(new Error('No answer in 30 s')));
    req.on('error', reject);
    req.end(body);
  });
}

export class GatewayManager {
  readonly processes = new ProcessManager('gw-pids.json');
  private tasks = new Map<GwKind, TaskProgress>();
  private aborts = new Map<GwKind, AbortController>();
  private errors = new Map<GwKind, string>();
  private updates = new Map<GwKind, string>();
  private setupRunning = new Set<GwKind>();
  private smpp: SmppCatcher | null = null;
  private sms: CaughtSms[] = [];
  private smsTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private h: Hooks) {
    mkdirSync(this.dir, { recursive: true });
    try {
      this.sms = JSON.parse(readFileSync(join(this.dir, 'sms.json'), 'utf8')) as CaughtSms[];
    } catch {
      this.sms = [];
    }
    this.processes.on('status', () => this.h.changed());
    setTimeout(() => void this.checkUpdates(), 50_000);
    setInterval(() => void this.checkUpdates(), 6 * 3600_000);
  }

  private get dir() {
    return dataDir('gateways');
  }
  binDir(kind: GwKind) {
    return join(this.dir, kind, 'bin');
  }
  private stored(): Stored {
    return store.extra<Stored>('gateways') ?? { configs: {} };
  }
  private saveConfig(kind: GwKind, c: GwConfig | null) {
    const configs = { ...this.stored().configs };
    if (c) configs[kind] = c;
    else delete configs[kind];
    store.setExtra('gateways', { configs });
  }
  config(kind: GwKind): GwConfig | null {
    return this.stored().configs[kind] ?? null;
  }
  /** The engine a Docker gateway runs on (its config; during an install, the one chosen in the form). */
  private installingIn = new Map<GwKind, GwContainer>();
  private where(kind: GwKind): GwContainer {
    return this.installingIn.get(kind) ?? containerOf(this.config(kind));
  }
  isActive(kind: GwKind) {
    return this.processes.isActive(gwId(kind));
  }

  // ---------------------------------------------------------------- state

  defaults(kind: GwKind): GwConfig {
    const e = ENGINES[kind];
    return { kind, port: e.port, ports: { ...e.ports }, domain: e.label, user: e.user, password: secret(16), version: '', autoStart: false, dataDir: join(this.dir, kind, 'data'), secrets: {}, setupDone: false, ...(e.docker ? { container: defaultContainer() } : {}) };
  }

  private connection(kind: GwKind, c: GwConfig): { label: string; value: string; secret?: boolean }[] {
    const web = this.h.urlOf(host(c.domain));
    const s = c.secrets;
    switch (kind) {
      case 'stalwart':
        return [
          { label: 'Web admin', value: `${web}/admin` },
          { label: 'Admin login', value: `${c.user} / ${c.password}`, secret: true },
          { label: 'SMTP submission (sites)', value: `127.0.0.1:${c.ports.submission}` },
          { label: 'IMAP', value: `127.0.0.1:${c.ports.imap}` },
          { label: 'Mailbox', value: `devcatz@${MAIL_DOMAIN}` },
          { label: 'Mailbox password', value: c.password, secret: true },
        ];
      case 'postal':
        return [
          { label: 'Web UI', value: web },
          { label: 'Login', value: `${c.user} / ${c.password}`, secret: true },
          { label: 'HTTP API', value: `${web}/api/v1/send/message` },
          { label: 'API key (X-Server-API-Key)', value: s.apiKey ?? '(set up on first start)', secret: true },
          { label: 'SMTP', value: `127.0.0.1:${c.ports.smtp}` },
          { label: 'SMTP password', value: s.smtpKey ?? '(set up on first start)', secret: true },
        ];
      case 'ntfy':
        return [
          { label: 'Server', value: web },
          { label: 'Login', value: `${c.user} / ${c.password}`, secret: true },
          { label: 'Access token', value: s.token ?? '(set up on first start)', secret: true },
          { label: 'Publish', value: `POST ${web}/<topic>` },
        ];
      case 'gotify':
        return [
          { label: 'Server', value: web },
          { label: 'Login', value: `${c.user} / ${c.password}`, secret: true },
          { label: 'App token (send)', value: s.appToken ?? '(set up on first start)', secret: true },
          { label: 'Send', value: `POST ${web}/message?token=…` },
        ];
      case 'telegram':
        return [
          { label: 'Bot API (sites)', value: `http://127.0.0.1:${c.port}/bot<token>/<method>` },
          { label: 'Over HTTPS', value: `${web}/bot<token>/<method>` },
          { label: 'api_id', value: s.apiId ?? '' },
          { label: 'api_hash', value: s.apiHash ?? '', secret: true },
          { label: 'Bot token', value: s.botToken || '(not set: add it in Settings…)', secret: Boolean(s.botToken) },
        ];
      case 'jasmin':
        return [
          { label: 'HTTP API', value: `http://127.0.0.1:${c.port}/send` },
          { label: 'API user', value: `${s.smsUser ?? 'devcatz'} / ${s.smsPassword ?? '(set up on first start)'}`, secret: true },
          { label: 'SMS catcher (SMPP)', value: `127.0.0.1:${c.ports.smpp}` },
          { label: 'jCli console', value: `telnet 127.0.0.1 ${c.ports.jcli} (jcliadmin / jclipwd)` },
        ];
    }
  }

  state(): GwState[] {
    return GW_KINDS.map((kind) => {
      const e = ENGINES[kind];
      const c = this.config(kind);
      return {
        kind,
        name: e.name,
        category: e.category,
        description: e.description,
        docker: e.docker,
        installed: Boolean(c),
        config: c,
        defaults: this.defaults(kind),
        portFields: e.portFields,
        status: c ? this.processes.getStatus(gwId(kind)).status : 'stopped',
        error: this.errors.get(kind) ?? null,
        task: this.tasks.get(kind) ?? null,
        url: c ? this.h.urlOf(host(c.domain)) : null,
        apiLocal: c ? `http://127.0.0.1:${c.port}` : null,
        webPath: e.webPath,
        update: c ? (this.updates.get(kind) ?? null) : null,
        connection: c ? this.connection(kind, c) : [],
      };
    });
  }

  routes(): Route[] {
    return GW_KINDS.flatMap((kind) => {
      const c = this.config(kind);
      // Postal answers its own hostname only: the Host header is passed on.
      return c ? [{ domain: host(c.domain), port: c.port, projectName: ENGINES[kind].name, running: this.isActive(kind), secure: true, keepHost: true }] : [];
    });
  }

  domains(): string[] {
    return GW_KINDS.map((k) => this.config(k)).filter((c): c is GwConfig => Boolean(c)).map((c) => host(c.domain));
  }

  /** Every port the installed gateways use (for other services' conflict checks). */
  ports(): number[] {
    return GW_KINDS.flatMap((k) => {
      const c = this.config(k);
      return c ? [c.port, ...Object.values(c.ports)] : [];
    });
  }

  // ---------------------------------------------------------------- tasks

  private task(kind: GwKind, t: TaskProgress) {
    this.tasks.set(kind, t);
    this.h.changed();
    const report: Report = (p) => {
      this.tasks.set(kind, { ...this.tasks.get(kind)!, ...p });
      this.h.changed();
    };
    return {
      report,
      finish: () => {
        report({ step: this.tasks.get(kind)!.steps.length, done: true });
        setTimeout(() => {
          if (this.tasks.get(kind)?.done) {
            this.tasks.delete(kind);
            this.h.changed();
          }
        }, 4000);
      },
    };
  }

  dismissTask(kind: GwKind): void {
    const t = this.tasks.get(kind);
    if (t && (t.done || t.error)) {
      this.tasks.delete(kind);
      this.h.changed();
    }
  }

  private validate(c: GwConfig, current: GwConfig | null) {
    const all = [c.port, ...Object.values(c.ports)];
    for (const p of all) if (!Number.isInteger(p) || p < 1024 || p > 65535) throw new Error('Ports: 1024–65535');
    if (new Set(all).size !== all.length) throw new Error('Each port must be different');
    if (!/^[a-z0-9-]+$/.test(c.domain)) throw new Error('Domain label: letters, digits and dashes');
    if (c.kind === 'telegram') {
      if (!/^\d{3,12}$/.test(c.secrets.apiId ?? '')) throw new Error('api_id: the number from my.telegram.org → API development tools');
      if (!/^[0-9a-f]{32}$/i.test(c.secrets.apiHash ?? '')) throw new Error('api_hash: the 32-character key from my.telegram.org');
      if (c.secrets.botToken && !/^\d+:[\w-]{30,}$/.test(c.secrets.botToken)) throw new Error('Bot token: like 123456:ABC… from @BotFather');
    } else {
      if (!c.user.trim()) throw new Error('User: required');
      if (c.password.length < 8) throw new Error('Password: at least 8 characters');
    }
    const others = GW_KINDS.filter((k) => k !== c.kind).map((k) => this.config(k)).filter((x): x is GwConfig => Boolean(x));
    const used = new Set([...others.flatMap((o) => [o.port, ...Object.values(o.ports)]), ...this.h.takenPorts(), this.h.mailPort()]);
    const clash = all.find((p) => used.has(p));
    if (clash) throw new Error(`Port ${clash} is used by another DevCatz service`);
    if (current?.domain !== c.domain && [...this.h.takenDomains(), ...others.map((o) => host(o.domain))].includes(host(c.domain))) throw new Error(`${host(c.domain)} is already used`);
  }

  // ---------------------------------------------------------------- files

  private composeFile(kind: GwKind) {
    return join(this.dir, kind, 'compose.yml');
  }

  /** Compose project (and Postal's config) for a Docker engine; rewritten on every start so settings changes apply. */
  private writeCompose(kind: GwKind, c: GwConfig): void {
    mkdirSync(c.dataDir, { recursive: true });
    const img = `${IMAGE[kind as Exclude<GwKind, 'stalwart'>]}:${tagOf(kind, c.version)}`;
    let y = '';
    const xh = hostGateway(this.where(kind)) ? '    extra_hosts: [ "host.docker.internal:host-gateway" ]\n' : '';
    if (kind === 'ntfy') {
      mkdirSync(join(c.dataDir, 'ntfy'), { recursive: true });
      y = `services:
  ntfy:
    image: ${img}
    command: serve
    environment:
      NTFY_BASE_URL: ${yamlStr(this.h.urlOf(host(c.domain)))}
      NTFY_CACHE_FILE: /var/lib/ntfy/cache.db
      NTFY_AUTH_FILE: /var/lib/ntfy/auth.db
      NTFY_ATTACHMENT_CACHE_DIR: /var/lib/ntfy/attachments
      NTFY_AUTH_DEFAULT_ACCESS: deny-all
      NTFY_BEHIND_PROXY: "true"
      NTFY_ENABLE_LOGIN: "true"
    volumes: [ ${JSON.stringify(`${join(c.dataDir, 'ntfy')}:/var/lib/ntfy`)} ]
    ports: [ "127.0.0.1:${c.port}:80" ]
`;
    } else if (kind === 'gotify') {
      mkdirSync(join(c.dataDir, 'gotify'), { recursive: true });
      y = `services:
  gotify:
    image: ${img}
    environment:
      GOTIFY_DEFAULTUSER_NAME: ${yamlStr(c.user)}
      GOTIFY_DEFAULTUSER_PASS: ${yamlStr(c.password)}
    volumes: [ ${JSON.stringify(`${join(c.dataDir, 'gotify')}:/app/data`)} ]
    ports: [ "127.0.0.1:${c.port}:80" ]
`;
    } else if (kind === 'telegram') {
      mkdirSync(join(c.dataDir, 'bot-api'), { recursive: true });
      y = `services:
  telegram-bot-api:
    image: ${img}
    environment:
      TELEGRAM_API_ID: ${yamlStr(c.secrets.apiId ?? '')}
      TELEGRAM_API_HASH: ${yamlStr(c.secrets.apiHash ?? '')}
      TELEGRAM_LOCAL: "1"
    volumes: [ ${JSON.stringify(`${join(c.dataDir, 'bot-api')}:/var/lib/telegram-bot-api`)} ]
    ports: [ "127.0.0.1:${c.port}:8081" ]
${xh}`;
    } else if (kind === 'jasmin') {
      mkdirSync(join(c.dataDir, 'store'), { recursive: true });
      y = `services:
  redis:
    image: redis:7-alpine
    healthcheck: { test: ["CMD", "redis-cli", "ping"], interval: 3s, retries: 30 }
  rabbitmq:
    image: rabbitmq:3.13-alpine
    healthcheck: { test: ["CMD", "rabbitmq-diagnostics", "-q", "ping"], interval: 5s, retries: 40 }
  jasmin:
    image: ${img}
    platform: linux/amd64
    environment: { REDIS_CLIENT_HOST: redis, AMQP_BROKER_HOST: rabbitmq }
    volumes: [ ${JSON.stringify(`${join(c.dataDir, 'store')}:/etc/jasmin/store`)} ]
    ports: [ "127.0.0.1:${c.port}:1401", "127.0.0.1:${c.ports.jcli}:8990" ]
${xh}    depends_on: { redis: { condition: service_healthy }, rabbitmq: { condition: service_healthy } }
`;
    } else if (kind === 'postal') {
      const cfg = join(c.dataDir, 'config');
      mkdirSync(cfg, { recursive: true });
      mkdirSync(join(c.dataDir, 'mysql'), { recursive: true });
      const s = c.secrets;
      s.dbPassword ??= secret(20);
      s.railsSecret ??= randomBytes(32).toString('hex');
      if (!existsSync(join(cfg, 'signing.key'))) {
        const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
        writeFileSync(join(cfg, 'signing.key'), privateKey.export({ type: 'pkcs1', format: 'pem' }));
      }
      const web = host(c.domain);
      // Postal looks its relay up with DNS A / AAAA queries to Docker's resolver (127.0.0.11), which knows the compose
      // services but not /etc/hosts (host.docker.internal from extra_hosts) nor an IP literal: every message soft-failed
      // with "No hosts to try" (Windows, DoCatz's engine, 2026-11-10). So the relay is the service `catcher`, a few lines
      // of Ruby in Postal's own image that pass each connection on to DevCatz's mail catcher.
      writeFileSync(join(cfg, 'devcatz-relay.rb'), POSTAL_RELAY);
      const postalYml = `version: 2
postal:
  web_hostname: ${web}
  web_protocol: https
  smtp_hostname: ${web}
  smtp_relays:
    - smtp://catcher:2525
main_db:
  host: mariadb
  username: root
  password: ${yamlStr(s.dbPassword)}
  database: postal
message_db:
  host: mariadb
  username: root
  password: ${yamlStr(s.dbPassword)}
  database_name_prefix: postal
rails:
  secret_key: ${s.railsSecret}
dns:
  return_path_domain: rp.${web}
  route_domain: routes.${web}
  track_domain: track.${web}
  helo_hostname: ${web}
smtp_server:
  default_port: 25
web_server:
  default_bind_address: 0.0.0.0
  default_port: 5000
logging:
  rails_log_enabled: false
`;
      writeFileSync(join(cfg, 'postal.yml'), postalYml);
      writeFileSync(join(cfg, 'devcatz-setup.rb'), POSTAL_SETUP);
      // Postal reads postal.yml once, at its start: the file's digest in each service's environment makes compose
      // recreate them when it changed (they kept the old relay after a DevCatz that ended without stopping them).
      const digest = createHash('sha256').update(postalYml).update(POSTAL_RELAY).digest('hex').slice(0, 16);
      const svc = (cmd: string, ports: string) => `    image: ${img}
    platform: linux/amd64
    command: ${cmd}
    environment: { DEVCATZ_CONFIG: "${digest}" }
    volumes: [ ${JSON.stringify(`${cfg}:/config`)} ]${ports}
${xh}    depends_on: { mariadb: { condition: service_healthy } }
`;
      // Windows: a folder of the PC reaches DoCatz's engine through WSL's /mnt/<drive>, where every file is world-writable:
      // MariaDB then ignores its healthcheck's .my-healthcheck.cnf (access denied, "unhealthy" for ever) and is slow on it.
      // macOS: DoCatz's engine runs in a VM that sees the Mac's folders through a share where MariaDB's first start dies
      // renaming its system tables ("Error on rename of './sys/…frm~'", Errcode 13; 2026-11-10).
      // Its data lives in a volume of the engine instead (removed with the data on Uninstall).
      const dbVolume = isWin || (!isLinux && this.where(kind) === 'docatz');
      y = `services:
  mariadb:
    image: mariadb:11.4
    environment: { MARIADB_ROOT_PASSWORD: ${yamlStr(s.dbPassword)}, MARIADB_DATABASE: postal }
    volumes: [ ${dbVolume ? '"mysql:/var/lib/mysql"' : JSON.stringify(`${join(c.dataDir, 'mysql')}:/var/lib/mysql`)} ]
    healthcheck: { test: ["CMD", "healthcheck.sh", "--connect", "--innodb_initialized"], interval: 3s, timeout: 5s, retries: 60 }
  web:
${svc('postal web-server', `\n    ports: [ "127.0.0.1:${c.port}:5000" ]`)}  smtp:
${svc('postal smtp-server', `\n    ports: [ "127.0.0.1:${c.ports.smtp}:25" ]`)}  worker:
${svc('postal worker', '')}  catcher:
    image: ${img}
    platform: linux/amd64
    command: [ "ruby", "/config/devcatz-relay.rb", "host.docker.internal", "${this.h.mailPort()}" ]
    environment: { DEVCATZ_CONFIG: "${digest}" }
    volumes: [ ${JSON.stringify(`${cfg}:/config`)} ]
${xh}${dbVolume ? 'volumes:\n  mysql: {}\n' : ''}`;
    }
    mkdirSync(join(this.dir, kind), { recursive: true });
    writeFileSync(this.composeFile(kind), `# Written by DevCatz; rewritten on every start.\nname: ${project(kind)}\n${y}`);
  }

  private compose(kind: GwKind, args: string[], timeout = 600_000) {
    const [bin, ...pre] = gatewayCompose(this.where(kind));
    return run(bin, [...pre, '-f', this.composeFile(kind), '-p', project(kind), ...args], { timeout, cwd: join(this.dir, kind) });
  }

  /** `docker compose pull` with its progress lines in the task. */
  private pull(kind: GwKind, report: Report, signal: AbortSignal, step: number): Promise<void> {
    const [bin, ...pre] = gatewayCompose(this.where(kind));
    return new Promise((resolve, reject) => {
      const proc = spawn(bin, [...pre, '-f', this.composeFile(kind), '-p', project(kind), 'pull'], { stdio: ['ignore', 'pipe', 'pipe'], cwd: join(this.dir, kind), env: getShellEnv() as NodeJS.ProcessEnv });
      let last = '';
      const feed = (d: Buffer) => {
        const line = d.toString().trim().split('\n').pop() ?? '';
        if (line) {
          last = line;
          report({ step, detail: line.slice(0, 120) });
        }
      };
      proc.stdout?.on('data', feed);
      proc.stderr?.on('data', feed);
      const onAbort = () => proc.kill('SIGTERM');
      signal.addEventListener('abort', onAbort, { once: true });
      proc.on('exit', (code) => {
        signal.removeEventListener('abort', onAbort);
        if (signal.aborted) reject(new Cancelled());
        else if (code === 0) resolve();
        else reject(new Error(`docker compose pull failed: ${last}`));
      });
      proc.on('error', reject);
    });
  }

  // ---------------------------------------------------------------- install / update / uninstall

  /** Stalwart and its CLI from GitHub releases (SHA-256 checked); returns the version. */
  private async fetchStalwart(dir: string, report: Report, signal: AbortSignal): Promise<string> {
    // Windows: x86_64-pc-windows-msvc zips; macOS: apple-darwin tarballs.
    const triple = isWin ? 'x86_64-pc-windows-msvc' : `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-${isLinux ? 'unknown-linux-gnu' : 'apple-darwin'}`;
    report({ step: 0, detail: 'github.com/stalwartlabs/stalwart releases' });
    const a = await githubAsset('stalwartlabs/stalwart', new RegExp(`^stalwart-${triple}\\.${isWin ? 'zip' : 'tar\\.gz'}$`));
    check(signal);
    mkdirSync(dir, { recursive: true });
    await installFrom(a.url, a.sha256, dir, 'stalwart', `Stalwart ${a.tag}`, report, signal);
    const cli = await githubAsset('stalwartlabs/cli', new RegExp(`^stalwart-cli-${triple}\\.${isWin ? 'zip' : 'tar\\.xz'}$`));
    check(signal);
    await installFrom(cli.url, cli.sha256, dir, 'stalwart-cli', `stalwart-cli ${cli.tag}`, report, signal);
    return a.tag.replace(/^v/, '');
  }

  async install(kind: GwKind, input: GwConfig): Promise<void> {
    if (this.config(kind)) throw new Error(`${ENGINES[kind].name} is already installed`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is busy`);
    const e = ENGINES[kind];
    const c: GwConfig = { ...this.defaults(kind), ...input, kind, ports: { ...e.ports, ...input.ports }, domain: input.domain.trim().toLowerCase(), user: input.user.trim(), secrets: kind === 'telegram' ? telegramSecrets(input.secrets) : {}, setupDone: false };
    this.validate(c, null);
    const steps = e.docker ? ['Checking the container engine', 'Finding the newest release', 'Pulling the images', 'Preparing the data folder'] : ['Finding the latest release', 'Downloading', 'Verifying the checksum', 'Unpacking', 'Placing the binary', 'Preparing the data folder'];
    const t = this.task(kind, { kind: 'install', title: `Installing ${e.name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    try {
      if (e.docker) {
        // A choice the platform does not have (DoCatz on Linux) falls back to the system's engine.
        c.container = c.container === 'docatz' && docatzAvailable() ? 'docatz' : c.container === 'system' ? 'system' : defaultContainer();
        this.installingIn.set(kind, c.container);
        await gatewayEngineReady(c.container, (detail) => t.report({ detail }), abort.signal);
        t.report({ step: 1, detail: IMAGE[kind as Exclude<GwKind, 'stalwart'>] });
        c.version = c.version || (await LATEST[kind]());
        check(abort.signal);
        this.writeCompose(kind, c);
        await this.pull(kind, t.report, abort.signal, 2);
      } else c.version = await this.fetchStalwart(this.binDir(kind), t.report, abort.signal);
      t.report({ step: steps.length - 1, detail: c.dataDir, received: undefined, total: undefined });
      mkdirSync(c.dataDir, { recursive: true });
      this.saveConfig(kind, c);
      t.report({ title: `Installed ${e.name} ${c.version}` });
      t.finish();
    } catch (err) {
      const cancelled = abort.signal.aborted || err instanceof Cancelled;
      if (!e.docker) await rm(join(this.dir, kind), { recursive: true, force: true }).catch(() => undefined);
      t.report({ error: cancelled ? 'Install cancelled; nothing was kept.' : (err as Error).message, cancelled });
      throw cancelled ? new Error('Install cancelled') : err;
    } finally {
      this.aborts.delete(kind);
      this.installingIn.delete(kind);
      this.h.changed();
    }
  }

  cancelInstall(kind: GwKind) {
    this.aborts.get(kind)?.abort();
  }

  /** Ports, domain, credentials, autostart; setup runs again on the next start, which happens now when it runs. */
  async update(kind: GwKind, input: GwConfig): Promise<void> {
    const cur = this.config(kind);
    if (!cur) throw new Error(`${ENGINES[kind].name} is not installed`);
    const c: GwConfig = { ...cur, port: input.port, ports: { ...cur.ports, ...input.ports }, domain: input.domain.trim().toLowerCase(), user: input.user.trim(), password: input.password, autoStart: input.autoStart, secrets: kind === 'telegram' ? { ...cur.secrets, ...telegramSecrets(input.secrets) } : cur.secrets };
    this.validate(c, cur);
    const changed =
      c.port !== cur.port || JSON.stringify(c.ports) !== JSON.stringify(cur.ports) || c.domain !== cur.domain || c.user !== cur.user || c.password !== cur.password || (kind === 'telegram' && (c.secrets.apiId !== cur.secrets.apiId || c.secrets.apiHash !== cur.secrets.apiHash));
    // Gotify keeps its first user in its database: a new password there is changed through its API on setup.
    if (changed) c.setupDone = false;
    if (kind === 'gotify' && c.user !== cur.user) c.secrets = { ...c.secrets, oldUser: cur.user, oldPassword: cur.password };
    else if (kind === 'gotify' && c.password !== cur.password) c.secrets = { ...c.secrets, oldUser: cur.user, oldPassword: cur.password };
    this.saveConfig(kind, c);
    if (changed && this.isActive(kind)) {
      await this.stop(kind);
      await this.start(kind);
    }
    this.h.changed();
  }

  setAutoStart(kind: GwKind, on: boolean): void {
    const c = this.config(kind);
    if (!c) throw new Error('Not installed');
    this.saveConfig(kind, { ...c, autoStart: on });
    this.h.changed();
  }

  async uninstall(kind: GwKind, deleteData: boolean, confirmHost: string): Promise<void> {
    const c = this.config(kind);
    if (!c) return;
    if (confirmHost.trim().toLowerCase() !== host(c.domain)) throw new Error(`Type ${host(c.domain)} to confirm`);
    const e = ENGINES[kind];
    const steps = ['Stopping', e.docker ? 'Removing the containers and image' : 'Removing the binaries', ...(deleteData ? ['Deleting the data folder'] : [])];
    const t = this.task(kind, { kind: 'uninstall', title: `Removing ${e.name}`, steps, step: 0 });
    try {
      await this.stop(kind);
      t.report({ step: 1 });
      if (e.docker) {
        // -v with the data: Postal's database is a volume of the engine on Windows and in DoCatz on macOS.
        if (existsSync(this.composeFile(kind))) await this.compose(kind, ['down', '--remove-orphans', ...(deleteData ? ['-v'] : [])], 120_000);
        await run(gatewayDocker(this.where(kind))[0], [...gatewayDocker(this.where(kind)).slice(1), 'rmi', `${IMAGE[kind as Exclude<GwKind, 'stalwart'>]}:${tagOf(kind, c.version)}`], { timeout: 120_000 });
        rmSync(this.composeFile(kind), { force: true });
      } else rmSync(this.binDir(kind), { recursive: true, force: true });
      if (deleteData) {
        t.report({ step: 2, detail: c.dataDir });
        // Linux: the container wrote root-owned files there (ntfy's attachments): handed back first, or rm stops at them.
        if (isLinux && existsSync(c.dataDir)) await giveBackToUser(c.dataDir);
        rmSync(c.dataDir, { recursive: true, force: true });
      }
      this.saveConfig(kind, null);
      this.updates.delete(kind);
      this.errors.delete(kind);
      t.finish();
    } catch (err) {
      t.report({ error: (err as Error).message });
      throw err;
    } finally {
      this.h.changed();
    }
  }

  async checkUpdates(): Promise<string[]> {
    const failed: string[] = [];
    await Promise.all(
      GW_KINDS.map(async (kind) => {
        const c = this.config(kind);
        if (!c) return void this.updates.delete(kind);
        const v = await LATEST[kind]().catch(() => null);
        if (!v) failed.push(ENGINES[kind].name);
        else if (isNewer(v, c.version)) this.updates.set(kind, v);
        else this.updates.delete(kind);
      }),
    );
    this.h.changed();
    return failed;
  }

  /** Newer release: images pulled (or the binary downloaded) first, then a restart; data and settings stay. */
  async upgrade(kind: GwKind): Promise<void> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (this.aborts.has(kind)) throw new Error(`${ENGINES[kind].name} is busy`);
    const e = ENGINES[kind];
    const steps = e.docker ? ['Finding the newest release', 'Pulling the images', 'Restarting'] : ['Finding the latest release', 'Downloading', 'Verifying the checksum', 'Unpacking', 'Placing the binary', 'Restarting'];
    const t = this.task(kind, { kind: 'update', title: `Updating ${e.name}`, steps, step: 0 });
    const abort = new AbortController();
    this.aborts.set(kind, abort);
    const wasActive = this.isActive(kind);
    try {
      let v: string;
      if (e.docker) {
        v = this.updates.get(kind) ?? (await LATEST[kind]());
        const next = { ...c, version: v };
        this.writeCompose(kind, next);
        await this.pull(kind, t.report, abort.signal, 1);
        if (wasActive) await this.stop(kind);
        if (c.version !== v) await run(gatewayDocker(this.where(kind))[0], [...gatewayDocker(this.where(kind)).slice(1), 'rmi', `${IMAGE[kind as Exclude<GwKind, 'stalwart'>]}:${tagOf(kind, c.version)}`], { timeout: 120_000 });
        this.saveConfig(kind, next);
      } else {
        const fresh = `${this.binDir(kind)}.update`;
        rmSync(fresh, { recursive: true, force: true });
        v = await this.fetchStalwart(fresh, t.report, abort.signal);
        if (wasActive) await this.stop(kind);
        rmSync(this.binDir(kind), { recursive: true, force: true });
        renameSync(fresh, this.binDir(kind));
        this.saveConfig(kind, { ...c, version: v });
      }
      t.report({ step: steps.length - 1, received: undefined, total: undefined, detail: undefined });
      if (wasActive) await this.start(kind);
      this.updates.delete(kind);
      this.processes.log(gwId(kind), 'sys', `Updated ${c.version} → ${v}`);
      t.report({ title: `Updated ${e.name} to ${v}` });
      t.finish();
    } catch (err) {
      const cancelled = abort.signal.aborted || err instanceof Cancelled;
      t.report({ error: cancelled ? 'Update cancelled; the current version was kept' : (err as Error).message, cancelled });
      throw err;
    } finally {
      this.aborts.delete(kind);
      this.h.changed();
    }
  }

  // ---------------------------------------------------------------- run

  /**
   * A start already on its way is joined, not run twice: Postal's first start (database, schema, setup) takes minutes
   * before its process counts as active, and a second Start then raced it (compose: "container name … already in use").
   */
  private starting = new Map<GwKind, Promise<void>>();
  start(kind: GwKind): Promise<void> {
    const running = this.starting.get(kind);
    if (running) return running;
    const p = this.startOnce(kind).finally(() => this.starting.delete(kind));
    this.starting.set(kind, p);
    return p;
  }

  private async startOnce(kind: GwKind): Promise<void> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (this.isActive(kind)) return;
    this.errors.delete(kind);
    mkdirSync(c.dataDir, { recursive: true });
    const id = gwId(kind);
    try {
      // Postal / Stalwart deliver into the mail catcher: off, every message waited in their queue (Mac, 2026-11-10).
      if (kind === 'postal' || kind === 'stalwart') await this.h.startMail();
      if (kind === 'stalwart') await this.startStalwart(c);
      else {
        await gatewayEngineReady(this.where(kind), (detail) => this.processes.log(id, 'sys', detail));
        if (kind === 'jasmin') await this.startSmsCatcher(c);
        await this.wslCallbacks(kind, c);
        this.writeCompose(kind, c);
        this.saveConfig(kind, c);
        if (kind === 'postal' && !c.setupDone) await this.setupPostal(c);
        const [bin, ...pre] = gatewayCompose(this.where(kind));
        this.processes.startMany(id, [{ label: '', cwd: join(this.dir, kind), command: [bin, ...pre, '-f', this.composeFile(kind), '-p', project(kind), 'up', '--remove-orphans'].map(q).join(' '), env: {} }]);
      }
      this.h.changed();
      // Running once the web UI / API answers (Postal and Jasmin boot slowly under emulation).
      const wait = kind === 'postal' || kind === 'jasmin' ? 300_000 : 120_000;
      const ready = kind === 'stalwart' ? await waitPort(c.port, wait, () => this.isActive(kind)) : await waitHttp(c.port, wait, () => this.isActive(kind), kind === 'postal' ? host(c.domain) : undefined);
      if (!ready) {
        if (this.isActive(kind)) throw new Error(`${ENGINES[kind].name} did not open port ${c.port} in time; see Logs`);
        return;
      }
      if (kind !== 'stalwart' && kind !== 'postal' && !this.config(kind)?.setupDone) await this.setup(kind);
      this.processes.markRunning(id);
    } catch (err) {
      this.errors.set(kind, (err as Error).message);
      this.processes.log(id, 'sys', `Start failed: ${(err as Error).message}`);
      this.h.changed();
      throw err;
    }
  }

  /**
   * Windows: the DevCatz ports a gateway container calls back (Postal → the mail catcher, Jasmin → the SMS catcher)
   * opened on WSL's network too (wslhost.ts), and plain words in the gateway's error when Windows Firewall blocks them.
   */
  private async wslCallbacks(kind: GwKind, c: GwConfig): Promise<void> {
    if (!isWin || this.where(kind) !== 'docatz') return;
    const back = kind === 'postal' ? { what: 'mail catcher', port: this.h.mailPort() } : kind === 'jasmin' ? { what: 'SMS catcher', port: c.ports.smpp } : null;
    if (!back) return;
    await forwardFromWsl(back.port);
    if ((await wslReaches(back.port)) === false) {
      const msg = firewallWords(back.what, back.port);
      this.errors.set(kind, msg);
      this.processes.log(gwId(kind), 'sys', msg);
    }
  }

  /**
   * Moves an installed Docker gateway to another engine (user, 2026-11-09: "Move to DoCatz"): stopped, its containers
   * removed there, its images pulled on the other engine, its old image removed, started again if it ran. Its data
   * stays: every gateway keeps it in a host folder (dataDir) that the containers mount.
   */
  async move(kind: GwKind, to: GwContainer): Promise<void> {
    const e = ENGINES[kind];
    const c = this.config(kind);
    if (!c || !e.docker) throw new Error(`${e.name} is not an installed Docker gateway`);
    const from = containerOf(c);
    if (from === to) return;
    if (to === 'docatz' && !docatzAvailable()) throw new Error('DoCatz is not on this system');
    const label = (w: GwContainer) => (w === 'docatz' ? 'DoCatz' : (otherEngineName() ?? 'the container engine'));
    const wasActive = this.isActive(kind);
    const steps = ['Stopping', `Checking ${label(to)}`, 'Pulling the images', `Removing it from ${label(from)}`, ...(wasActive ? ['Starting'] : [])];
    const t = this.task(kind, { kind: 'install', title: `Moving ${e.name} to ${label(to)}`, steps, step: 0 });
    try {
      await this.stop(kind);
      if (existsSync(this.composeFile(kind))) await this.compose(kind, ['down', '--remove-orphans'], 120_000).catch(() => undefined);
      this.installingIn.set(kind, to);
      t.report({ step: 1 });
      const abort = new AbortController();
      await gatewayEngineReady(to, (detail) => t.report({ detail }), abort.signal);
      this.writeCompose(kind, c);
      await this.pull(kind, t.report, abort.signal, 2);
      t.report({ step: 3, detail: '' });
      await run(gatewayDocker(from)[0], [...gatewayDocker(from).slice(1), 'rmi', `${IMAGE[kind as Exclude<GwKind, 'stalwart'>]}:${tagOf(kind, c.version)}`], { timeout: 120_000 }).catch(() => undefined);
      this.saveConfig(kind, { ...c, container: to });
      this.installingIn.delete(kind);
      if (wasActive) {
        t.report({ step: 4 });
        await this.start(kind);
      }
      t.report({ title: `${e.name} runs in ${label(to)}` });
      t.finish();
    } catch (err) {
      this.installingIn.delete(kind);
      t.report({ error: (err as Error).message });
      throw err;
    } finally {
      this.h.changed();
    }
  }

  async stop(kind: GwKind): Promise<void> {
    await this.processes.stop(gwId(kind));
    if (ENGINES[kind].docker && existsSync(this.composeFile(kind))) await this.compose(kind, ['stop'], 120_000).catch(() => undefined);
    if (kind === 'jasmin') {
      await this.smpp?.close();
      this.smpp = null;
    }
    this.h.changed();
  }

  async action(kind: GwKind, action: StorageAction): Promise<void> {
    if (action === 'stop') return this.stop(kind);
    if (action === 'restart') await this.stop(kind);
    await this.start(kind);
  }

  autoStart(): void {
    for (const k of GW_KINDS) if (this.config(k)?.autoStart) void this.start(k).catch(() => undefined);
  }

  async stopAll(): Promise<void> {
    await Promise.all(GW_KINDS.map((k) => (this.isActive(k) ? this.stop(k) : Promise.resolve())));
    await this.smpp?.close();
  }

  openData(kind: GwKind): string {
    return this.config(kind)?.dataDir ?? this.dir;
  }

  // ---------------------------------------------------------------- per-engine setup

  /**
   * Stalwart: config.json holds the data store only; the first start runs in
   * recovery mode on the HTTP port, where stalwart-cli applies the listeners
   * (127.0.0.1, DevCatz's ports), the devcatz.test domain and mailbox, the
   * relay to the mail catcher and plain-text auth for local clients. Later
   * starts run normally with the same administrator.
   */
  private async startStalwart(c: GwConfig): Promise<void> {
    const bin = join(this.binDir('stalwart'), exe('stalwart'));
    if (!existsSync(bin)) throw new Error('The Stalwart binary is missing: remove and install again');
    const cfg = join(c.dataDir, 'config.json');
    mkdirSync(join(c.dataDir, 'db'), { recursive: true });
    writeFileSync(cfg, JSON.stringify({ '@type': 'RocksDb', path: join(c.dataDir, 'db') }));
    const id = gwId('stalwart');
    const env = { STALWART_RECOVERY_ADMIN: `${c.user}:${c.password}`, STALWART_PUBLIC_URL: this.h.urlOf(host(c.domain)), STALWART_HOSTNAME: host(c.domain) };
    if (!c.setupDone) {
      this.processes.log(id, 'sys', 'First start: configuring Stalwart (listeners, domain, mailbox, relay to the mail catcher)');
      this.processes.startMany(id, [{ label: 'setup', cwd: c.dataDir, command: `${q(bin)} --config ${q(cfg)}`, env: { ...env, STALWART_RECOVERY_MODE: '1', STALWART_RECOVERY_MODE_PORT: String(c.port) } }]);
      if (!(await waitPort(c.port, 60_000, () => this.isActive('stalwart')))) throw new Error('Stalwart did not start in recovery mode; see Logs');
      const plan = this.stalwartPlan(c);
      const planFile = join(c.dataDir, 'devcatz-plan.ndjson');
      writeFileSync(planFile, plan);
      const r = await run(join(this.binDir('stalwart'), exe('stalwart-cli')), ['apply', '--file', planFile, '--no-color'], {
        timeout: 120_000,
        env: { STALWART_URL: `http://127.0.0.1:${c.port}`, STALWART_USER: c.user, STALWART_PASSWORD: c.password },
      });
      this.processes.log(id, 'sys', `${r.stdout}${r.stderr}`.trim());
      await this.processes.stop(id);
      if (r.code !== 0) throw new Error(`stalwart-cli apply failed: ${`${r.stderr || r.stdout}`.trim().split('\n').pop()}`);
      this.saveConfig('stalwart', { ...c, setupDone: true, secrets: { ...c.secrets, tracer: '1' } });
    }
    this.processes.startMany(id, [{ label: '', cwd: c.dataDir, command: `${q(bin)} --config ${q(cfg)}`, env }]);
  }

  private stalwartPlan(c: GwConfig): string {
    const p = c.ports;
    const lines: unknown[] = [
      {
        '@type': 'upsert',
        object: 'NetworkListener',
        matchOn: ['name'],
        value: {
          'l-smtp': { name: 'smtp', bind: { [`127.0.0.1:${p.smtp}`]: true }, protocol: 'smtp' },
          'l-submission': { name: 'submission', bind: { [`127.0.0.1:${p.submission}`]: true }, protocol: 'smtp' },
          'l-imap': { name: 'imap', bind: { [`127.0.0.1:${p.imap}`]: true }, protocol: 'imap' },
          'l-http': { name: 'http', bind: { [`127.0.0.1:${c.port}`]: true }, protocol: 'http' },
        },
      },
      { '@type': 'upsert', object: 'Domain', matchOn: ['name'], value: { dom: { name: MAIL_DOMAIN } } },
      { '@type': 'upsert', object: 'Account', matchOn: ['name'], value: { acc: { '@type': 'User', name: 'devcatz', domainId: '#dom', credentials: { '0': { '@type': 'Password', secret: c.password } } } } },
      {
        '@type': 'upsert',
        object: 'MtaRoute',
        matchOn: ['name'],
        // `host` (Stalwart 1.0 renamed the relay's `address`).
        value: { catcher: { '@type': 'Relay', name: 'devcatz-catcher', host: '127.0.0.1', port: this.h.mailPort(), protocol: 'smtp', implicitTls: false, allowInvalidCerts: true } },
      },
      { '@type': 'update', object: 'SystemSettings', value: { defaultHostname: host(c.domain), defaultDomainId: '#dom' } },
      { '@type': 'update', object: 'MtaOutboundStrategy', value: { route: { match: { '0': { if: 'is_local_domain(rcpt_domain)', then: "'local'" } }, else: "'devcatz-catcher'" } } },
      // Local clients authenticate without TLS on submission (as with the mail catcher); port 25 stays unauthenticated inbound.
      {
        '@type': 'update',
        object: 'MtaStageAuth',
        value: { require: { else: `local_port != ${p.smtp}`, match: {} }, mustMatchSender: { else: 'false', match: {} }, saslMechanisms: { else: 'false', match: { '0': { if: `local_port != ${p.smtp}`, then: '[plain, login]' } } } },
      },
      { '@type': 'update', object: 'Imap', value: { allowPlainTextAuth: true } },
    ];
    if (!c.secrets.tracer) lines.push({ '@type': 'create', object: 'Tracer', value: { stdout: { '@type': 'Stdout', enable: true, ansi: false, level: 'info' } } });
    return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
  }

  /** Postal: database, schema, then the admin user, an organisation, a server, API + SMTP credentials and verified domains. */
  private async setupPostal(c: GwConfig): Promise<void> {
    const id = gwId('postal');
    this.processes.log(id, 'sys', 'First start: preparing the database (MariaDB) and Postal; this takes a minute or two under emulation');
    const up = await this.compose('postal', ['up', '-d', '--wait', 'mariadb'], 300_000);
    if (up.code !== 0) throw new Error(`MariaDB did not start: ${`${up.stderr || up.stdout}`.trim().split('\n').pop()}`);
    const init = await this.compose('postal', ['run', '--rm', '-T', 'web', 'postal', 'initialize'], 600_000);
    this.processes.log(id, 'sys', `${init.stdout}${init.stderr}`.trim().split('\n').slice(-4).join('\n'));
    if (init.code !== 0) throw new Error(`postal initialize failed: ${`${init.stderr || init.stdout}`.trim().split('\n').pop()}`);
    await this.postalRunner(c, this.siteDomains());
  }

  /** Runs DevCatz's setup script in Postal (idempotent); stores the keys it prints. */
  private async postalRunner(c: GwConfig, domains: string[]): Promise<void> {
    const r = await this.compose(
      'postal',
      ['run', '--rm', '-T', '-e', `DEVCATZ_EMAIL=${c.user}`, '-e', `DEVCATZ_PASSWORD=${c.password}`, '-e', `DEVCATZ_DOMAINS=${[MAIL_DOMAIN, ...domains].join(',')}`, 'web', 'bundle', 'exec', 'rails', 'runner', '/config/devcatz-setup.rb'],
      600_000,
    );
    const out = `${r.stdout}\n${r.stderr}`;
    const apiKey = out.match(/DEVCATZ_API_KEY=(\S+)/)?.[1];
    const smtpKey = out.match(/DEVCATZ_SMTP_KEY=(\S+)/)?.[1];
    if (r.code !== 0 || !apiKey || !smtpKey) throw new Error(`Postal setup failed: ${out.trim().split('\n').slice(-2).join(' ')}`);
    const cur = this.config('postal') ?? c;
    this.saveConfig('postal', { ...cur, setupDone: true, secrets: { ...cur.secrets, apiKey, smtpKey, domains: [...new Set([...(cur.secrets.domains ?? '').split(',').filter(Boolean), ...domains])].join(',') } });
    this.processes.log(gwId('postal'), 'sys', `Postal is set up: organisation devcatz, server dev, domains ${[MAIL_DOMAIN, ...domains].join(', ')}`);
  }

  private siteDomains(): string[] {
    return this.h.projects().map((p) => p.domain);
  }

  /** ntfy / Gotify / Jasmin, once they answer. */
  private async setup(kind: GwKind): Promise<void> {
    if (this.setupRunning.has(kind)) return;
    this.setupRunning.add(kind);
    const c = this.config(kind)!;
    const id = gwId(kind);
    try {
      if (kind === 'telegram') {
        this.saveConfig(kind, { ...c, setupDone: true });
      } else if (kind === 'ntfy') {
        const add = await this.compose('ntfy', ['exec', '-T', '-e', `NTFY_PASSWORD=${c.password}`, 'ntfy', 'ntfy', 'user', 'add', '--role=admin', c.user], 60_000);
        if (add.code !== 0 && !/already exists/i.test(`${add.stderr}${add.stdout}`)) throw new Error(`ntfy user: ${`${add.stderr || add.stdout}`.trim()}`);
        // An existing user gets the (possibly new) password.
        await this.compose('ntfy', ['exec', '-T', '-e', `NTFY_PASSWORD=${c.password}`, 'ntfy', 'ntfy', 'user', 'change-pass', c.user], 60_000);
        let token: string | undefined = c.secrets.token;
        if (!token) {
          const t = await this.compose('ntfy', ['exec', '-T', 'ntfy', 'ntfy', 'token', 'add', c.user], 60_000);
          token = `${t.stdout}${t.stderr}`.match(/\btk_[a-z0-9]+/i)?.[0];
          if (!token) throw new Error(`ntfy token: ${`${t.stderr || t.stdout}`.trim()}`);
        }
        this.saveConfig(kind, { ...c, setupDone: true, secrets: { ...c.secrets, token: token! } });
      } else if (kind === 'gotify') {
        const auth = (u: string, p: string) => ({ Authorization: `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`, 'Content-Type': 'application/json' });
        let headers = auth(c.user, c.password);
        // Password changed in DevCatz: set it in Gotify with the previous one.
        if (c.secrets.oldUser) {
          const old = auth(c.secrets.oldUser, c.secrets.oldPassword ?? '');
          const me = await http('GET', c.port, '/current/user', { headers: old });
          if (me.status === 200) await http('POST', c.port, '/current/user/password', { headers: old, body: JSON.stringify({ pass: c.password }) });
          headers = auth(c.secrets.oldUser, c.password);
        }
        let appToken = c.secrets.appToken;
        if (!appToken) {
          const r = await http('POST', c.port, '/application', { headers, body: JSON.stringify({ name: 'DevCatz', description: 'Test sender and sites (DevCatz)' }) });
          if (r.status !== 200) throw new Error(`Gotify application: HTTP ${r.status} ${r.text.slice(0, 160)}`);
          appToken = (JSON.parse(r.text) as { token: string }).token;
        }
        const { oldUser: _u, oldPassword: _p, ...rest } = c.secrets;
        this.saveConfig(kind, { ...c, setupDone: true, secrets: { ...rest, appToken } });
      } else if (kind === 'jasmin') {
        const smsUser = 'devcatz';
        // Jasmin passwords are 8 characters at most.
        const smsPassword = c.secrets.smsPassword ?? secret(8);
        // jCli opens a while after the HTTP API: retry until it logs in.
        const until = Date.now() + 180_000;
        let out = '';
        for (;;) {
          try {
            out = await this.jasminConsole(c, smsUser, smsPassword);
            break;
          } catch (e) {
            if (Date.now() > until || !this.isActive(kind)) throw new Error(`Jasmin jCli: ${(e as Error).message}`);
            await new Promise((r) => setTimeout(r, 3000));
          }
        }
        if (!/Successfully added User/i.test(out)) throw new Error(`Jasmin setup did not add the API user: ${out.trim().split(/\r*\n/).slice(-3).join(' ')}`);
        this.processes.log(id, 'sys', out.split(/\r*\n/).filter((l) => /Successfully|Error|error/.test(l)).join('\n'));
        this.saveConfig(kind, { ...c, setupDone: true, secrets: { ...c.secrets, smsUser, smsPassword } });
      }
      this.processes.log(id, 'sys', `${ENGINES[kind].name} is set up`);
    } finally {
      this.setupRunning.delete(kind);
      this.h.changed();
    }
  }

  /** Jasmin's user, connector to the SMS catcher and default route, through jCli (removed first, so a re-run converges). */
  private jasminConsole(c: GwConfig, smsUser: string, smsPassword: string): Promise<string> {
    return jcli('127.0.0.1', c.ports.jcli, 'jcliadmin', 'jclipwd', [
          'mtrouter -r 0',
          'smppccm -0 devcatz',
          'smppccm -r devcatz',
          'user -r devcatz',
          'group -r devcatz',
          'group -a', 'gid devcatz', 'ok',
          'user -a', `username ${smsUser}`, `password ${smsPassword}`, 'gid devcatz', 'uid devcatz', 'ok',
          'smppccm -a', 'cid devcatz', 'host host.docker.internal', `port ${c.ports.smpp}`, 'username devcatz', 'password devcatz', 'submit_throughput 50', 'ok',
          'smppccm -1 devcatz',
          'mtrouter -a', 'type defaultroute', 'connector smppc(devcatz)', 'rate 0.00', 'ok',
      'persist',
    ]);
  }

  // ---------------------------------------------------------------- SMS catcher

  private async startSmsCatcher(c: GwConfig): Promise<void> {
    if (this.smpp?.listening) return;
    const catcher = new SmppCatcher((m) => {
      this.sms.unshift(m);
      if (this.sms.length > 500) this.sms.length = 500;
      this.smsTimer ??= setTimeout(() => {
        this.smsTimer = null;
        writeFileSync(join(this.dir, 'sms.json'), JSON.stringify(this.sms));
      }, 500);
      this.h.notify(`SMS to ${m.to}`, m.text.slice(0, 140));
      this.h.changed();
    });
    try {
      await catcher.listen(c.ports.smpp, '127.0.0.1');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      throw new Error(err.code === 'EADDRINUSE' ? `SMS catcher port ${c.ports.smpp} is already in use` : err.message);
    }
    this.smpp = catcher;
  }

  smsList(limit: number): CaughtSms[] {
    return this.sms.slice(0, limit);
  }

  clearSms(): void {
    this.sms = [];
    writeFileSync(join(this.dir, 'sms.json'), '[]');
    this.h.changed();
  }

  smsCount(): number {
    return this.sms.length;
  }

  // ---------------------------------------------------------------- test sender

  async send(kind: GwKind, input: GwSendInput): Promise<GwSendResult> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    if (!this.isActive(kind)) throw new Error(`${ENGINES[kind].name} is not running`);
    const s = c.secrets;
    const to = input.to.trim();
    if (!to) throw new Error('Fill in the recipient');
    if (kind === 'stalwart') {
      const from = input.from?.trim() || `devcatz@${MAIL_DOMAIN}`;
      const raw = Buffer.from(
        [`From: ${from}`, `To: ${to}`, `Subject: ${input.subject}`, `Date: ${new Date().toUTCString()}`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', '', input.text, ''].join('\r\n'),
      );
      const reply = await sendMail({ host: '127.0.0.1', port: c.ports.submission, security: 'none', username: 'devcatz', password: c.password, from, to: [to], raw });
      return { request: { method: 'SMTP', url: `smtp://127.0.0.1:${c.ports.submission} (AUTH devcatz)`, body: `MAIL FROM:<${from}>\nRCPT TO:<${to}>\n\n${raw.toString()}` }, status: 250, response: reply };
    }
    if (kind === 'postal') {
      if (!s.apiKey) throw new Error('Postal is still being set up');
      const from = input.from?.trim() || `hello@${MAIL_DOMAIN}`;
      const body = JSON.stringify({ to: [to], from, subject: input.subject, plain_body: input.text }, null, 2);
      const r = await http('POST', c.port, '/api/v1/send/message', { host: host(c.domain), headers: { 'X-Server-API-Key': s.apiKey, 'Content-Type': 'application/json' }, body });
      return { request: { method: 'POST', url: `${this.h.urlOf(host(c.domain))}/api/v1/send/message`, body }, status: r.status, response: r.text };
    }
    if (kind === 'ntfy') {
      if (!s.token) throw new Error('ntfy is still being set up');
      const topic = to.replace(/^\//, '');
      const r = await http('POST', c.port, `/${encodeURIComponent(topic)}`, { headers: { Authorization: `Bearer ${s.token}`, Title: input.subject, 'Content-Type': 'text/plain; charset=utf-8' }, body: input.text });
      return { request: { method: 'POST', url: `${this.h.urlOf(host(c.domain))}/${topic}`, body: `Authorization: Bearer tk_…\nTitle: ${input.subject}\n\n${input.text}` }, status: r.status, response: r.text };
    }
    if (kind === 'gotify') {
      if (!s.appToken) throw new Error('Gotify is still being set up');
      const body = JSON.stringify({ title: input.subject, message: input.text, priority: Number(to) || 5 }, null, 2);
      const r = await http('POST', c.port, `/message?token=${encodeURIComponent(s.appToken)}`, { headers: { 'Content-Type': 'application/json' }, body });
      return { request: { method: 'POST', url: `${this.h.urlOf(host(c.domain))}/message?token=…`, body }, status: r.status, response: r.text };
    }
    if (kind === 'telegram') {
      if (!s.botToken) throw new Error('Add the bot token (from @BotFather) in Settings… first');
      const body = JSON.stringify({ chat_id: /^-?\d+$/.test(to) ? Number(to) : to, text: input.subject ? `${input.subject}\n\n${input.text}` : input.text }, null, 2);
      const r = await http('POST', c.port, `/bot${s.botToken}/sendMessage`, { headers: { 'Content-Type': 'application/json' }, body });
      return { request: { method: 'POST', url: `http://127.0.0.1:${c.port}/bot<token>/sendMessage`, body }, status: r.status, response: r.text };
    }
    // jasmin
    if (!s.smsPassword) throw new Error('Jasmin is still being set up');
    const params = new URLSearchParams({ username: s.smsUser ?? 'devcatz', password: s.smsPassword, to: to.replace(/[^\d+]/g, ''), content: input.text, ...(input.from ? { from: input.from } : {}), coding: /[^\x00-\x7f]/.test(input.text) ? '8' : '0' });
    const r = await http('GET', c.port, `/send?${params}`);
    return { request: { method: 'GET', url: `http://127.0.0.1:${c.port}/send?${params.toString().replace(/password=[^&]+/, 'password=…')}`, body: '' }, status: r.status, response: r.text };
  }

  // ---------------------------------------------------------------- sites

  /** .env lines for a site; Postal also gets the site's domain verified so it may send from it. */
  async env(kind: GwKind, siteId: string): Promise<Record<string, string>> {
    const c = this.config(kind);
    if (!c) throw new Error(`${ENGINES[kind].name} is not installed`);
    const p = this.h.projects().find((x) => x.id === siteId);
    if (!p) throw new Error('Unknown site');
    const s = c.secrets;
    const laravel = this.h.runtime(siteId) === 'php' && this.h.framework(siteId) === 'laravel';
    const mail = (port: number, user: string, pass: string): Record<string, string> =>
      laravel
        ? { MAIL_MAILER: 'smtp', MAIL_SCHEME: 'smtp', MAIL_HOST: '127.0.0.1', MAIL_PORT: String(port), MAIL_USERNAME: user, MAIL_PASSWORD: pass, MAIL_ENCRYPTION: 'null', MAIL_FROM_ADDRESS: `hello@${p.domain}` }
        : { SMTP_HOST: '127.0.0.1', SMTP_PORT: String(port), SMTP_USER: user, SMTP_PASS: pass, SMTP_SECURE: 'false', MAIL_FROM: `hello@${p.domain}` };
    const slug = p.domain.split('.')[0];
    switch (kind) {
      case 'stalwart':
        return { ...mail(c.ports.submission, 'devcatz', c.password), IMAP_HOST: '127.0.0.1', IMAP_PORT: String(c.ports.imap), IMAP_USERNAME: 'devcatz', IMAP_PASSWORD: c.password, IMAP_ENCRYPTION: 'false' };
      case 'postal': {
        if (this.isActive('postal') && !(s.domains ?? '').split(',').includes(p.domain)) await this.postalRunner(c, [p.domain]).catch(() => undefined);
        const fresh = this.config('postal')!.secrets;
        return { ...mail(c.ports.smtp, 'devcatz', fresh.smtpKey ?? ''), POSTAL_URL: this.h.urlOf(host(c.domain)), POSTAL_API_KEY: fresh.apiKey ?? '' };
      }
      case 'ntfy':
        return { NTFY_URL: this.h.urlOf(host(c.domain)), NTFY_URL_LOCAL: `http://127.0.0.1:${c.port}`, NTFY_TOKEN: s.token ?? '', NTFY_TOPIC: slug };
      case 'gotify':
        return { GOTIFY_URL: this.h.urlOf(host(c.domain)), GOTIFY_URL_LOCAL: `http://127.0.0.1:${c.port}`, GOTIFY_APP_TOKEN: s.appToken ?? '' };
      case 'telegram':
        return { TELEGRAM_API_URL: `http://127.0.0.1:${c.port}`, TELEGRAM_BOT_TOKEN: s.botToken ?? '', TELEGRAM_BOT_API_SERVER: 'local' };
      case 'jasmin':
        return { SMS_GATEWAY: 'jasmin', JASMIN_HTTP_URL: `http://127.0.0.1:${c.port}`, JASMIN_USERNAME: s.smsUser ?? 'devcatz', JASMIN_PASSWORD: s.smsPassword ?? '', SMS_FROM: p.name.slice(0, 11) };
    }
  }

  /** Gateway keys in a site's .env and the installed gateways they point at. */
  siteInfo(p: ProjectConfig): { keys: string[]; kinds: GwKind[] } | null {
    const env = readEnvFiles(join(p.path, '.env'));
    const keys = Object.keys(env).filter((k) => /^(STALWART_|POSTAL_|NTFY_|GOTIFY_|JASMIN_|SMS_GATEWAY|IMAP_HOST|TELEGRAM_)/.test(k));
    const kinds = new Set<GwKind>();
    const mailHost = (env.MAIL_HOST ?? env.SMTP_HOST ?? '').toLowerCase();
    const mailPort = Number(env.MAIL_PORT ?? env.SMTP_PORT ?? 0);
    for (const kind of GW_KINDS) {
      const c = this.config(kind);
      if (!c) continue;
      const own = [c.port, ...Object.values(c.ports)];
      const domain = host(c.domain);
      const urls = Object.entries(env).filter(([k]) => /URL|HOST/.test(k)).map(([, v]) => v.toLowerCase());
      if (urls.some((u) => u.includes(domain) || own.some((port) => u.includes(`127.0.0.1:${port}`) || u.includes(`localhost:${port}`)))) kinds.add(kind);
      if (['127.0.0.1', 'localhost'].includes(mailHost) && (kind === 'stalwart' ? mailPort === c.ports.submission : kind === 'postal' ? mailPort === c.ports.smtp : false)) kinds.add(kind);
    }
    if (keys.some((k) => k.startsWith('NTFY_'))) kinds.add('ntfy');
    if (keys.some((k) => k.startsWith('GOTIFY_'))) kinds.add('gotify');
    if (keys.some((k) => k.startsWith('JASMIN_') || k === 'SMS_GATEWAY')) kinds.add('jasmin');
    if (keys.some((k) => k.startsWith('POSTAL_'))) kinds.add('postal');
    if (keys.some((k) => k.startsWith('TELEGRAM_')) && this.config('telegram')) kinds.add('telegram');
    if (!keys.length && !kinds.size) return null;
    return { keys, kinds: GW_KINDS.filter((k) => kinds.has(k)) };
  }
}

/** The Telegram fields the form edits (empty bot token = keep none). */
function telegramSecrets(s: Record<string, string> | undefined): Record<string, string> {
  return { apiId: (s?.apiId ?? '').trim(), apiHash: (s?.apiHash ?? '').trim(), botToken: (s?.botToken ?? '').trim() };
}

/** Postal's relay (service `catcher`): listens on 2525 and passes each connection on to DevCatz's mail catcher. */
const POSTAL_RELAY = `# Written by DevCatz: Postal's SMTP relay, passed on to DevCatz's mail catcher (host, port as arguments).
require 'socket'
host, port = ARGV[0], Integer(ARGV[1])
server = TCPServer.new('0.0.0.0', 2525)
$stdout.sync = true
puts "relay: 2525 -> #{host}:#{port}"
loop do
  Thread.new(server.accept) do |client|
    upstream = nil
    begin
      upstream = TCPSocket.new(host, port)
      up = Thread.new do
        IO.copy_stream(client, upstream)
      rescue StandardError
        nil
      ensure
        upstream.close_write rescue nil
      end
      IO.copy_stream(upstream, client)
      up.join
    rescue StandardError => e
      warn "relay: #{e.message}"
    ensure
      client.close rescue nil
      upstream&.close rescue nil
    end
  end
end
`;

/** Ruby run inside Postal (rails runner): admin user, organisation, server, credentials and verified domains; idempotent. */
const POSTAL_SETUP = `# Written by DevCatz.
email = ENV.fetch("DEVCATZ_EMAIL"); password = ENV.fetch("DEVCATZ_PASSWORD")
user = User.find_by(email_address: email) || User.new(email_address: email)
user.first_name ||= "DevCatz"; user.last_name ||= "Admin"; user.password = password; user.admin = true
user.save!
org = Organization.find_by(permalink: "devcatz") || Organization.create!(name: "DevCatz", permalink: "devcatz", owner: user)
server = org.servers.find_by(permalink: "dev") || org.servers.create!(name: "Dev", permalink: "dev", mode: "Live")
api = server.credentials.find_by(name: "devcatz-api") || server.credentials.create!(name: "devcatz-api", type: "API")
smtp = server.credentials.find_by(name: "devcatz-smtp") || server.credentials.create!(name: "devcatz-smtp", type: "SMTP")
ENV.fetch("DEVCATZ_DOMAINS", "").split(",").map(&:strip).reject(&:empty?).uniq.each do |name|
  d = server.domains.find_by(name: name) || server.domains.new(name: name, verification_method: "DNS")
  d.verified_at ||= Time.now
  d.save!
end
puts "DEVCATZ_API_KEY=#{api.key}"
puts "DEVCATZ_SMTP_KEY=#{smtp.key}"
`;
