import { safeStorage } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { request as httpsRequest, type RequestOptions } from 'node:https';
import { homedir, release } from 'node:os';
import { connect as tlsConnect } from 'node:tls';
import { connect as netConnect, type Socket } from 'node:net';
import { join } from 'node:path';
import { lookup, Resolver } from 'node:dns/promises';
import type { ExposeAccounts, ExposeOptions, ExposeProvider, ExposeRequest, ExposeShare, ExposeState, ExposeTool, ProjectConfig, TaskProgress } from '@shared/types';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { Cancelled, check, githubAsset, installFrom, INSTALL_STEPS } from './storage';
import { dataDir, store } from './store';
import { githubLatest, isNewer, UPDATE_TAIL, upgradeBinaries } from './svcupdate';
import { getPhpRuntime } from './websocket';

/**
 * Expose: a public URL for a local site. Each share runs a small gateway on
 * 127.0.0.1 that the tunnel points at: it checks basic auth, records every
 * request (the inspector, with Replay) and forwards to DevCatz's own proxy
 * with the site's Host header. Tunnels: a Cloudflare quick tunnel, a named
 * tunnel on the user's own Cloudflare domain, ngrok, or Expose (expose.dev).
 */

interface Hooks {
  /** Starts the site's dev server when it has one and waits until it listens (PHP sites return at once). */
  ensureRunning: (siteId: string, report: (detail: string) => void) => Promise<void>;
  projects(): ProjectConfig[];
  /** Domains of a site (its own and its apps'). */
  domains(siteId: string): string[];
  changed(): void;
  notify(title: string, body: string): void;
}

interface Live {
  share: ExposeShare;
  gateway: Server;
  gatewayPort: number;
  proc: ChildProcess | null;
  auth: string | null;
  requests: ExposeRequest[];
  timer: ReturnType<typeof setTimeout> | null;
  stopping: boolean;
  /** Step of share.task where tunnel() starts the tool (the next one waits for the URL). */
  toolStep: number;
}

/** Provider accounts as stored (tokens encrypted with safeStorage, base64). */
interface StoredAccounts {
  ngrok?: { token: string; domain: string };
  expose?: { token: string; server: string; domain: string };
}

type Report = (p: Partial<TaskProgress>) => void;

const BODY_LIMIT = 64 * 1024;
/** Response types whose local domain is rewritten to the public host (see rewriteHosts). */
const REWRITE_TYPES = /^(text\/(html|css|javascript)|application\/(javascript|json|manifest\+json|xml)|image\/svg\+xml)/i;
const escapeRe = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `https://app.localhost(:port)` → `https://<public host>` (also `http`, `ws(s)`, JSON-escaped slashes and bare
 * `app.localhost` as in Vite's client), so a page served through the tunnel only points at the tunnel.
 */
export function rewriteHosts(text: string, domain: string, publicHost: string): string {
  const d = escapeRe(domain);
  return text
    .replace(new RegExp(`\\b(https?|wss?)(:(?:\\\\?/){2})${d}(?::\\d+)?(?![\\w-])`, 'gi'), (_m, scheme: string, sep: string) => `${/^ws/i.test(scheme) ? 'wss' : 'https'}${sep}${publicHost}`)
    .replace(new RegExp(`(?<![\\w.-])${d}(?::\\d+)?(?![\\w-])`, 'gi'), publicHost);
}
const REQUESTS_KEPT = 300;
const TEXT_TYPES = /^(text\/|application\/(json|xml|x-www-form-urlencoded|javascript|graphql))/;
const TOOLS: ExposeTool[] = ['cloudflared', 'ngrok', 'expose'];
const TOOL_NAME: Record<ExposeTool, string> = { cloudflared: 'cloudflared', ngrok: 'ngrok', expose: 'Expose' };
const TOOL_OF: Record<ExposeProvider, ExposeTool> = { cloudflare: 'cloudflared', 'cloudflare-domain': 'cloudflared', ngrok: 'ngrok', expose: 'expose' };
const CF_DIR = join(homedir(), '.cloudflared');
const CF_CERT = join(CF_DIR, 'cert.pem');
const EXPOSE_PHAR = 'https://github.com/exposedev/expose/raw/HEAD/builds/expose';
const NGROK_CASK = 'https://formulae.brew.sh/api/cask/ngrok.json';

interface NgrokCask {
  version: string;
  url: string;
  sha256: string;
  variations?: Record<string, { url?: string; sha256?: string }>;
}

/** ngrok's cask: the arm64 build at the top, Intel builds under the macOS names. */
async function ngrokCask(): Promise<{ version: string; url: string; sha256: string }> {
  const res = await fetch(NGROK_CASK);
  if (!res.ok) throw new Error(`formulae.brew.sh: HTTP ${res.status}`);
  const cask = (await res.json()) as NgrokCask;
  let { url, sha256 } = cask;
  if (process.arch !== 'arm64') {
    const names = ['golden_gate', 'tahoe', 'sequoia', 'sonoma', 'ventura'];
    const mine = names[Math.max(0, Math.min(names.length - 1, 26 - Number(release().split('.')[0])))];
    const v = cask.variations?.[mine] ?? Object.values(cask.variations ?? {}).find((x) => x.url?.includes('amd64'));
    if (v?.url && v.sha256) ({ url, sha256 } = v as { url: string; sha256: string });
  }
  return { version: cask.version.split(',')[0], url, sha256 };
}

export class ExposeManager {
  private live = new Map<string, Live>();
  private installing: ExposeState['installing'] = null;
  private abort: AbortController | null = null;
  private versions: Record<ExposeTool, string | null> = { cloudflared: null, ngrok: null, expose: null };
  private updates = new Map<ExposeTool, string>();
  private login: ChildProcess | null = null;

  constructor(private h: Hooks) {
    void this.readVersions().then(() => {
      setTimeout(() => void this.checkUpdates(), 40_000);
      setInterval(() => void this.checkUpdates(), 6 * 3600_000);
    });
  }

  private get binDir() {
    return dataDir('expose', 'bin');
  }
  private bin(tool: ExposeTool): string {
    return join(this.binDir, tool);
  }

  private async version(tool: ExposeTool, dir = this.binDir): Promise<string | null> {
    const bin = join(dir, tool);
    if (!existsSync(bin)) return null;
    let r: { code: number; stdout: string; stderr: string };
    if (tool === 'expose') {
      const php = getPhpRuntime();
      if (!php) return null;
      r = await run(php.php, [bin, '--version'], { timeout: 20_000, env: php.env });
    } else r = await run(bin, [tool === 'cloudflared' ? '--version' : 'version'], { timeout: 10_000 });
    return `${r.stdout}${r.stderr}`.match(/(\d+\.\d+\.\d+)/)?.[1] ?? (r.code === 0 ? 'unknown' : null);
  }

  private async readVersions(): Promise<void> {
    for (const tool of TOOLS) this.versions[tool] = await this.version(tool);
    this.h.changed();
  }

  state(): ExposeState {
    return {
      tools: { ...this.versions },
      installing: this.installing,
      updates: Object.fromEntries(this.updates),
      accounts: this.accounts(),
      shares: [...this.live.values()].map((l) => ({ ...l.share, requests: l.requests.length })),
    };
  }

  // ---------------------------------------------------------------- accounts

  private stored(): StoredAccounts {
    return store.extra<StoredAccounts>('exposeAccounts') ?? {};
  }

  private decrypt(token: string): string {
    try {
      return safeStorage.decryptString(Buffer.from(token, 'base64'));
    } catch {
      throw new Error('The stored token can no longer be read (Keychain changed): enter it again in Settings → Expose');
    }
  }

  accounts(): ExposeAccounts {
    const s = this.stored();
    return {
      ngrok: { token: Boolean(s.ngrok?.token), domain: s.ngrok?.domain ?? '' },
      expose: { token: Boolean(s.expose?.token), server: s.expose?.server ?? '', domain: s.expose?.domain ?? '' },
      cloudflare: existsSync(CF_CERT),
    };
  }

  /** Saves a provider token (encrypted) and its defaults; `token: null` forgets the account, `''` keeps the stored token. */
  setAccount(provider: 'ngrok' | 'expose', input: { token: string | null; domain?: string; server?: string }): void {
    const s = this.stored();
    if (input.token === null) delete s[provider];
    else {
      if (input.token && !safeStorage.isEncryptionAvailable()) throw new Error('macOS Keychain encryption is not available');
      const token = input.token.trim() ? safeStorage.encryptString(input.token.trim()).toString('base64') : (s[provider]?.token ?? '');
      if (!token) throw new Error('Enter the token');
      if (provider === 'ngrok') s.ngrok = { token, domain: (input.domain ?? s.ngrok?.domain ?? '').trim() };
      else s.expose = { token, server: (input.server ?? s.expose?.server ?? '').trim(), domain: (input.domain ?? s.expose?.domain ?? '').trim() };
    }
    store.setExtra('exposeAccounts', s);
    this.h.changed();
  }

  // ---------------------------------------------------------------- tools

  /** Downloads a tool into `dir` (the installer, also used for updates into a fresh folder). */
  private async fetchTool(tool: ExposeTool, dir: string, report: Report, signal: AbortSignal): Promise<void> {
    mkdirSync(dir, { recursive: true });
    if (tool === 'cloudflared') {
      report({ step: 0, detail: 'github.com/cloudflare/cloudflared releases' });
      const a = await githubAsset('cloudflare/cloudflared', process.arch === 'arm64' ? /^cloudflared-darwin-arm64\.tgz$/ : /^cloudflared-darwin-amd64\.tgz$/);
      check(signal);
      await installFrom(a.url, a.sha256, dir, 'cloudflared', `cloudflared ${a.tag}`, report, signal);
    } else if (tool === 'ngrok') {
      // ngrok publishes no checksums of its own; Homebrew's cask carries URL and SHA-256 per architecture.
      report({ step: 0, detail: 'formulae.brew.sh (ngrok cask)' });
      const c = await ngrokCask();
      check(signal);
      await installFrom(c.url, c.sha256, dir, 'ngrok', `ngrok ${c.version}`, report, signal);
    } else {
      // Expose's phar (no published checksum: HTTPS from GitHub); it runs on the PHP DevCatz uses.
      if (!getPhpRuntime()) throw new Error('Expose needs PHP 8.2+: install PHP on the Runtimes page first');
      report({ step: 0, detail: 'github.com/exposedev/expose (builds/expose)' });
      const tmp = join(dir, 'expose.download');
      const digest = await downloadVerified(EXPOSE_PHAR, tmp, '', (received, total) => report({ step: 1, received, total, detail: 'expose (phar)' }), undefined, signal).catch((e) => {
        throw signal.aborted ? new Cancelled() : e;
      });
      check(signal);
      report({ step: 2, received: undefined, total: undefined, detail: `SHA-256 ${digest.slice(0, 16)}… (HTTPS, no published checksum)` });
      renameSync(tmp, join(dir, 'expose'));
    }
  }

  private steps(tool: ExposeTool): string[] {
    return tool === 'expose' ? ['Finding the latest release', 'Downloading', 'Placing the file'] : INSTALL_STEPS.slice(0, 5);
  }

  private report(tool: ExposeTool, p: Partial<TaskProgress>): void {
    this.installing = { tool, task: { ...this.installing!.task, ...p } };
    this.h.changed();
  }

  async install(tool: ExposeTool): Promise<void> {
    if (this.abort) throw new Error(`${TOOL_NAME[this.installing?.tool ?? tool]} is busy`);
    const steps = [...this.steps(tool), 'Checking the version'];
    this.installing = { tool, task: { kind: 'install', title: `Installing ${TOOL_NAME[tool]}`, steps, step: 0 } };
    const abort = new AbortController();
    this.abort = abort;
    const report: Report = (p) => this.report(tool, p);
    try {
      await this.fetchTool(tool, this.binDir, report, abort.signal);
      report({ step: steps.length - 1, detail: this.bin(tool), received: undefined, total: undefined });
      await this.readVersions();
      if (!this.versions[tool]) throw new Error(`${TOOL_NAME[tool]} does not run on this Mac`);
      report({ step: steps.length, done: true, title: `Installed ${TOOL_NAME[tool]} ${this.versions[tool]}` });
      this.clearTaskLater();
    } catch (err) {
      if (err instanceof Cancelled || abort.signal.aborted) {
        await rm(this.bin(tool), { force: true }).catch(() => undefined);
        report({ cancelled: true, error: 'Install cancelled' });
      } else report({ error: (err as Error).message });
      throw err;
    } finally {
      this.abort = null;
    }
  }

  private clearTaskLater() {
    setTimeout(() => {
      if (this.installing?.task.done) {
        this.installing = null;
        this.h.changed();
      }
    }, 4000);
  }

  /** Deletes the tool's binary. Refused while a share runs on it; the ngrok / Expose tokens and the Cloudflare login stay. */
  async uninstall(tool: ExposeTool, confirmName: string): Promise<void> {
    if (!this.versions[tool]) throw new Error(`${TOOL_NAME[tool]} is not installed`);
    if (confirmName.trim().toLowerCase() !== TOOL_NAME[tool].toLowerCase()) throw new Error(`Type ${TOOL_NAME[tool]} to confirm`);
    if (this.abort) throw new Error(`${TOOL_NAME[this.installing?.tool ?? tool]} is busy`);
    const using = [...this.live.values()].filter((l) => TOOL_OF[l.share.provider] === tool && l.share.status !== 'crashed');
    if (using.length) throw new Error(`${TOOL_NAME[tool]} is sharing ${using.map((l) => l.share.siteName).join(', ')}: stop ${using.length === 1 ? 'that share' : 'those shares'} first`);
    this.installing = { tool, task: { kind: 'uninstall', title: `Removing ${TOOL_NAME[tool]}`, steps: ['Removing the binary'], step: 0, detail: this.bin(tool) } };
    const report: Report = (p) => this.report(tool, p);
    try {
      await rm(this.bin(tool), { force: true });
      this.versions[tool] = null;
      this.updates.delete(tool);
      report({ step: 1, done: true, title: `Removed ${TOOL_NAME[tool]}` });
      this.clearTaskLater();
    } catch (err) {
      report({ error: (err as Error).message });
      throw err;
    } finally {
      this.h.changed();
    }
  }

  cancelInstall(): void {
    this.abort?.abort();
  }

  dismissTask(): void {
    if (this.installing && (this.installing.task.done || this.installing.task.error)) {
      this.installing = null;
      this.h.changed();
    }
  }

  /** Returns the names of the tools that could not be checked (offline, GitHub rate limit …). */
  async checkUpdates(): Promise<string[]> {
    const failed: string[] = [];
    const latest: Record<ExposeTool, () => Promise<string>> = {
      cloudflared: () => githubLatest('cloudflare/cloudflared'),
      ngrok: async () => (await ngrokCask()).version,
      expose: () => githubLatest('exposedev/expose'),
    };
    await Promise.all(
      TOOLS.map(async (tool) => {
        const current = this.versions[tool];
        if (!current) return void this.updates.delete(tool);
        const v = await latest[tool]().catch(() => null);
        if (!v) failed.push(TOOL_NAME[tool]);
        else if (isNewer(v, current)) this.updates.set(tool, v);
        else this.updates.delete(tool);
      }),
    );
    this.h.changed();
    return failed;
  }

  /** Newer release in place of the tool; shares running on it are stopped first. */
  async upgrade(tool: ExposeTool): Promise<void> {
    if (!this.versions[tool]) throw new Error(`${TOOL_NAME[tool]} is not installed`);
    if (this.abort) throw new Error(`${TOOL_NAME[this.installing?.tool ?? tool]} is busy`);
    const head = this.steps(tool);
    const steps = [...head, ...UPDATE_TAIL];
    this.installing = { tool, task: { kind: 'update', title: `Updating ${TOOL_NAME[tool]}`, steps, step: 0 } };
    const abort = new AbortController();
    this.abort = abort;
    const report: Report = (p) => this.report(tool, p);
    const from = this.versions[tool];
    try {
      const v = await upgradeBinaries({
        binDir: this.binDir,
        install: (d, r, s) => this.fetchTool(tool, d, r, s),
        stop: async () => {
          for (const l of this.live.values()) if (TOOL_OF[l.share.provider] === tool) await this.stop(l.share.id);
        },
        start: async () => undefined,
        wasActive: false,
        version: () => this.version(tool),
        report,
        signal: abort.signal,
        tailAt: head.length,
      });
      this.versions[tool] = v;
      this.updates.delete(tool);
      report({ step: steps.length, done: true, title: `Updated ${TOOL_NAME[tool]} ${from} → ${v}` });
      this.clearTaskLater();
    } catch (err) {
      const e = abort.signal.aborted || err instanceof Cancelled ? new Error('Update cancelled; the current version was kept') : (err as Error);
      report({ error: e.message, cancelled: abort.signal.aborted });
      throw e;
    } finally {
      this.abort = null;
      this.h.changed();
    }
  }

  /** `cloudflared tunnel login`: opens the browser; done when cert.pem lands in ~/.cloudflared. */
  async cloudflareLogin(): Promise<void> {
    if (!this.versions.cloudflared) throw new Error('Install cloudflared first');
    if (existsSync(CF_CERT)) return;
    if (this.login) throw new Error('A Cloudflare login is already open in the browser');
    const proc = spawn(this.bin('cloudflared'), ['tunnel', 'login'], { env: getShellEnv() as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    this.login = proc;
    let output = '';
    proc.stdout?.on('data', (d: Buffer) => (output += d.toString()));
    proc.stderr?.on('data', (d: Buffer) => (output += d.toString()));
    try {
      await new Promise<void>((resolve, reject) => {
        let done = false;
        const finish = (e?: Error) => {
          if (done) return;
          done = true;
          clearInterval(poll);
          clearTimeout(timer);
          if (!proc.killed) proc.kill('SIGTERM');
          if (e) reject(e);
          else resolve();
        };
        const poll = setInterval(() => existsSync(CF_CERT) && finish(), 1000);
        const timer = setTimeout(() => finish(new Error('No login within 5 minutes')), 5 * 60_000);
        proc.on('exit', (code) => (existsSync(CF_CERT) ? finish() : finish(new Error(`cloudflared login ended (${code}): ${output.trim().split('\n').slice(-2).join(' ')}`))));
        proc.on('error', (e) => finish(e));
      });
    } finally {
      this.login = null;
      this.h.changed();
    }
  }

  cloudflareLogout(): void {
    rmSync(CF_CERT, { force: true });
    this.h.changed();
  }

  // ---------------------------------------------------------------- shares

  shareOf(siteId: string): ExposeShare | null {
    return [...this.live.values()].find((l) => l.share.siteId === siteId)?.share ?? null;
  }

  async start(o: ExposeOptions): Promise<ExposeShare> {
    const provider: ExposeProvider = o.provider ?? 'cloudflare';
    const tool = TOOL_OF[provider];
    if (!this.versions[tool]) throw new Error(`Install ${TOOL_NAME[tool]} first (Expose page)`);
    const p = this.h.projects().find((x) => x.id === o.siteId);
    if (!p) throw new Error('Unknown site');
    const domains = this.h.domains(p.id);
    const domain = o.domain && domains.includes(o.domain) ? o.domain : p.domain;
    const shares = [...this.live.values()];
    if (shares.some((l) => l.share.domain === domain && l.share.status !== 'stopped' && l.share.status !== 'crashed')) throw new Error(`${domain} is already shared`);
    const auth = o.auth?.trim() || null;
    if (auth && !/^[^:\s]+:.+$/.test(auth)) throw new Error('Basic auth: user:password');
    const minutes = o.expiryMinutes ?? store.settings.exposeExpiryMinutes;
    const acc = this.stored();
    const hostname = o.hostname?.trim().toLowerCase() ?? '';
    const subdomain = o.subdomain?.trim().toLowerCase() ?? '';
    if (provider === 'ngrok' && !acc.ngrok?.token) throw new Error('Add your ngrok authtoken in Settings → Expose first');
    if (provider === 'ngrok' && shares.some((l) => l.share.provider === 'ngrok')) throw new Error('ngrok runs one agent per free account: stop the other ngrok share first');
    if (provider === 'expose' && !acc.expose?.token) throw new Error('Add your Expose token in Settings → Expose first');
    if (provider === 'cloudflare-domain') {
      if (!existsSync(CF_CERT)) throw new Error('Log in to Cloudflare first (Expose page → Your Cloudflare domain)');
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(hostname)) throw new Error('Hostname: a name on your Cloudflare zone, e.g. demo.example.com');
    }
    const id = `share-${Date.now().toString(36)}`;
    const share: ExposeShare = {
      id,
      siteId: p.id,
      siteName: p.name,
      domain,
      provider,
      status: 'starting',
      url: provider === 'cloudflare-domain' ? `https://${hostname}` : null,
      startedAt: new Date().toISOString(),
      expiresAt: minutes > 0 ? new Date(Date.now() + minutes * 60_000).toISOString() : null,
      auth: auth ? auth.split(':')[0] : null,
      requests: 0,
      error: null,
      task: null,
    };
    const toolName = TOOL_NAME[tool];
    const steps =
      provider === 'cloudflare-domain'
        ? [`Making sure ${p.name} is running`, 'Starting the local gateway', 'Finding or creating the named tunnel', `Routing ${hostname} to it`, 'Starting cloudflared', 'Connecting to Cloudflare']
        : provider === 'cloudflare'
          ? [`Making sure ${p.name} is running`, 'Starting the local gateway', `Starting ${toolName}`, 'Waiting for the public URL', 'Checking that the URL resolves and answers']
          : [`Making sure ${p.name} is running`, 'Starting the local gateway', `Starting ${toolName}`, 'Waiting for the public URL'];
    share.task = { kind: 'share', title: `Sharing ${domain}`, steps, step: 0, detail: `https://${domain} → 127.0.0.1` };
    const secure = p.secure !== false;
    const live: Live = { share, gateway: this.gateway(id, domain, secure), gatewayPort: 0, proc: null, auth, requests: [], timer: null, stopping: false, toolStep: provider === 'cloudflare-domain' ? 4 : 2 };
    this.live.set(id, live);
    this.h.changed();
    try {
      // A site with a dev server (JS, Python …) must be up, or the tunnel only ever shows the "stopped" page.
      await this.h.ensureRunning(p.id, (detail) => {
        share.task!.detail = detail;
        this.h.changed();
      });
      if (live.stopping) throw new Error('cancelled');
      this.step(live, 1, 'running');
      await new Promise<void>((resolve) => live.gateway.listen(0, '127.0.0.1', resolve));
      live.gatewayPort = (live.gateway.address() as { port: number }).port;
      this.step(live, 2, `gateway on 127.0.0.1:${live.gatewayPort}`);
      if (provider === 'cloudflare') await this.quickTunnel(live);
      else if (provider === 'cloudflare-domain') await this.namedTunnel(live, hostname);
      else if (provider === 'ngrok') await this.ngrok(live, acc.ngrok!, subdomain || acc.ngrok!.domain);
      else await this.expose(live, acc.expose!, subdomain || acc.expose!.domain);
    } catch (e) {
      const cancelled = live.stopping;
      share.status = 'crashed';
      share.error = cancelled ? 'Cancelled' : (e as Error).message;
      if (share.task) share.task = { ...share.task, error: share.error, cancelled };
      live.gateway.close();
      this.h.changed();
      throw cancelled ? new Error('Sharing cancelled') : e;
    }
    share.task = { ...share.task!, step: share.task!.steps.length, done: true, detail: share.url ?? undefined };
    this.h.changed();
    setTimeout(() => {
      if (share.task?.done) {
        share.task = null;
        this.h.changed();
      }
    }, 3000);
    if (share.expiresAt) live.timer = setTimeout(() => void this.stop(id, 'expired'), minutes * 60_000);
    return { ...share };
  }

  /**
   * A Cloudflare quick tunnel (*.trycloudflare.com). cloudflared prints the
   * hostname before it is ready everywhere, and a device that asks too early
   * shows ERR_NAME_NOT_RESOLVED: the share only goes live once the name
   * resolves (system resolver and public DNS) and the URL answers. A hostname
   * that never does is dropped for a new one (twice at most).
   */
  private async quickTunnel(live: Live): Promise<void> {
    const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${live.gatewayPort}`];
    for (let attempt = 1; ; attempt++) {
      await this.tunnel(live, this.bin('cloudflared'), args, {}, /https:\/\/[a-z0-9-]+\.trycloudflare\.com/, undefined, undefined, true);
      const url = live.share.url!;
      this.step(live, 4, `${new URL(url).host}${attempt > 1 ? ` (try ${attempt})` : ''}`);
      const problem = await this.waitPublic(live, url, 40_000);
      if (live.stopping) throw new Error('Sharing cancelled');
      if (!problem) {
        live.share.status = 'running';
        this.h.changed();
        return;
      }
      // Drop this hostname and ask for a new one.
      live.stopping = true;
      live.proc?.kill('SIGTERM');
      await new Promise((r) => setTimeout(r, 800));
      live.stopping = false;
      live.share.url = null;
      if (attempt >= 3) throw new Error(`The quick tunnel URL never became reachable (${problem}). Try again, or share with your own Cloudflare domain.`);
      this.step(live, 2, `${problem}; getting a new URL`);
    }
  }

  /** Waits until a public URL resolves (system + 1.1.1.1 + 8.8.8.8) and answers (any status but Cloudflare's 530 / 502); returns the last problem, or null. */
  private async waitPublic(live: Live, url: string, ms: number): Promise<string | null> {
    const host = new URL(url).host;
    const pub = new Resolver({ timeout: 3000, tries: 1 });
    pub.setServers(['1.1.1.1', '8.8.8.8']);
    const deadline = Date.now() + ms;
    let problem = 'not checked';
    while (Date.now() < deadline && !live.stopping) {
      try {
        await pub.resolve4(host);
        await lookup(host);
        const status = await new Promise<number>((resolve, reject) => {
          const req = httpsRequest(url, { method: 'HEAD', timeout: 6000, headers: { 'user-agent': 'DevCatz share check' } }, (r) => {
            r.resume();
            resolve(r.statusCode ?? 0);
          });
          req.on('timeout', () => req.destroy(new Error('timed out')));
          req.on('error', reject);
          req.end();
        });
        if (status && status !== 530 && status !== 502 && status !== 1033) return null;
        problem = `Cloudflare answered ${status}`;
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        problem = code === 'ENOTFOUND' || code === 'ENODATA' ? `${host} does not resolve yet` : (e as Error).message;
      }
      live.share.task && this.step(live, 4, problem);
      await new Promise((r) => setTimeout(r, 1500));
    }
    return problem;
  }

  /** Moves the share's start progress to step `i`. */
  private step(live: Live, i: number, detail?: string): void {
    if (!live.share.task) return;
    live.share.task = { ...live.share.task, step: i, detail };
    this.h.changed();
  }

  /**
   * Starts a tunnel process on the gateway and waits for the public URL in its
   * output (`urlRe`), or for `readyRe` when the URL is known beforehand.
   * `errRe` turns a known error line into the failure message.
   */
  private tunnel(live: Live, bin: string, args: string[], env: Record<string, string>, urlRe: RegExp | null, readyRe?: RegExp, errRe?: RegExp, hold = false): Promise<void> {
    const { share } = live;
    const name = TOOL_NAME[TOOL_OF[share.provider]];
    const tail = (s: string) => s.trim().split('\n').slice(-2).join(' ').slice(0, 300);
    return new Promise((resolve, reject) => {
      // Cancelled while an earlier step ran (named tunnels): start nothing.
      if (live.stopping) return reject(new Error('Sharing cancelled'));
      const proc = spawn(bin, args, { env: { ...getShellEnv(), NO_COLOR: '1', ...env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'], cwd: dataDir('expose') });
      live.proc = proc;
      this.step(live, live.toolStep, `${name}${proc.pid ? ` (pid ${proc.pid})` : ''}`);
      let waiting = false;
      let settled = false;
      let output = '';
      const fail = (msg: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        proc.kill('SIGTERM');
        reject(new Error(msg));
      };
      const timer = setTimeout(() => fail(`${name} gave no public URL in 45 s: ${tail(output)}`), 45_000);
      const feed = (d: Buffer) => {
        const text = d.toString();
        output = (output + text).slice(-6000);
        if (settled) return;
        if (!waiting) {
          waiting = true;
          this.step(live, live.toolStep + 1, text.trim().split('\n').pop()?.slice(0, 120));
        }
        const err = errRe && text.match(errRe)?.[0];
        if (err) return fail(`${name}: ${err.slice(0, 300)}`);
        const m = urlRe ? text.match(urlRe)?.[0] : readyRe?.test(text) ? share.url : null;
        if (m) {
          settled = true;
          clearTimeout(timer);
          share.url = m;
          // `hold`: the caller checks the URL first and marks the share running.
          if (!hold) share.status = 'running';
          this.h.changed();
          resolve();
        }
      };
      proc.stdout?.on('data', feed);
      proc.stderr?.on('data', feed);
      proc.on('error', (e) => fail(e.message));
      proc.on('exit', (code) => {
        live.proc = null;
        if (!settled) return fail(`${name} exited (${code}): ${tail(output)}`);
        if (live.stopping) return;
        // Dropped on its own: keep the share visible as crashed, tell the user.
        share.status = 'crashed';
        share.error = `${name} exited (${code ?? 'signal'})`;
        live.gateway.close();
        if (live.timer) clearTimeout(live.timer);
        this.h.changed();
        this.h.notify(`${share.siteName}: tunnel dropped`, `${share.url ?? share.domain} is no longer reachable. Share it again from the Expose page.`);
      });
    });
  }

  /** A named tunnel on the user's zone: created once per hostname, DNS routed, run with an ingress config. */
  private async namedTunnel(live: Live, hostname: string): Promise<void> {
    const bin = this.bin('cloudflared');
    const name = `devcatz-${hostname.replace(/[^a-z0-9]+/g, '-')}`;
    const env = getShellEnv() as Record<string, string>;
    this.step(live, 2, name);
    const list = await run(bin, ['tunnel', 'list', '-o', 'json'], { timeout: 30_000, env });
    if (list.code !== 0) throw new Error(`cloudflared tunnel list: ${(list.stderr || list.stdout).trim().split('\n').pop() || `exit ${list.code}`}`);
    // An account without tunnels prints `null`, not `[]`.
    let tunnels: { id: string; name: string; deleted_at?: string | null }[] = [];
    try {
      const parsed = JSON.parse(list.stdout || 'null') as unknown;
      if (Array.isArray(parsed)) tunnels = parsed;
    } catch {
      /* no JSON: created below */
    }
    // A live tunnel carries Go's zero time as deleted_at ("0001-01-01T00:00:00Z").
    const alive = (t: { deleted_at?: string | null }) => !t.deleted_at || t.deleted_at.startsWith('0001-');
    let id = tunnels.find((t) => t?.name === name && alive(t))?.id;
    if (!id) {
      const c = await run(bin, ['tunnel', 'create', '-o', 'json', name], { timeout: 60_000, env });
      if (c.code !== 0 && /already exists/i.test(`${c.stderr}${c.stdout}`)) {
        // Made earlier (another share of this hostname): use it.
        const info = await run(bin, ['tunnel', 'info', '-o', 'json', name], { timeout: 30_000, env });
        id = `${info.stdout}`.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      } else if (c.code !== 0) throw new Error(`cloudflared tunnel create: ${(c.stderr || c.stdout).trim().split('\n').pop()}`);
      if (!id) {
        try {
          id = (JSON.parse(c.stdout) as { id?: string } | null)?.id;
        } catch {
          /* older cloudflared: plain text */
        }
      }
      // Fallback: "Created tunnel <name> with id <uuid>" in the text output.
      id ??= `${c.stdout}\n${c.stderr}`.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0];
      if (!id) throw new Error(`cloudflared tunnel create gave no tunnel id: ${(c.stdout || c.stderr).trim().slice(0, 200)}`);
    }
    this.step(live, 3, `${hostname} → ${name}`);
    const route = await run(bin, ['tunnel', 'route', 'dns', '--overwrite-dns', name, hostname], { timeout: 60_000, env });
    if (route.code !== 0 && !/already (exists|configured)/i.test(route.stderr)) throw new Error(`DNS route for ${hostname}: ${route.stderr.trim().split('\n').pop()}`);
    const creds = join(CF_DIR, `${id}.json`);
    if (!existsSync(creds)) throw new Error(`Tunnel credentials missing (${creds}): delete tunnel ${name} in Cloudflare Zero Trust and share again`);
    mkdirSync(dataDir('expose'), { recursive: true });
    const cfg = join(dataDir('expose'), `tunnel-${live.share.id}.yml`);
    writeFileSync(cfg, [`tunnel: ${id}`, `credentials-file: ${JSON.stringify(creds)}`, 'ingress:', `  - hostname: ${hostname}`, `    service: http://127.0.0.1:${live.gatewayPort}`, '  - service: http_status:404', ''].join('\n'));
    try {
      await this.tunnel(live, bin, ['tunnel', '--no-autoupdate', '--config', cfg, 'run', name], {}, null, /Registered tunnel connection|Connection [0-9a-f-]+ registered/);
    } finally {
      rmSync(cfg, { force: true });
    }
  }

  /** ngrok with the account's authtoken (one agent per free account); a reserved domain when given. */
  private async ngrok(live: Live, acc: { token: string; domain: string }, domain: string): Promise<void> {
    mkdirSync(dataDir('expose'), { recursive: true });
    const cfg = join(dataDir('expose'), `ngrok-${live.share.id}.yml`);
    writeFileSync(cfg, `version: "2"\nauthtoken: ${this.decrypt(acc.token)}\nweb_addr: false\n`, { mode: 0o600 });
    try {
      await this.tunnel(
        live,
        this.bin('ngrok'),
        ['http', '--config', cfg, '--log', 'stdout', '--log-format', 'json', ...(domain ? ['--domain', domain] : []), `127.0.0.1:${live.gatewayPort}`],
        {},
        /"url":"(https:\/\/[^"]+)"/,
        undefined,
        /ERR_NGROK_\d+[^"\n]*|"lvl":"error"[^\n]*/,
      );
      // The URL was matched with its JSON key: keep the address alone.
      live.share.url = live.share.url?.match(/https:\/\/[^"\s]+/)?.[0] ?? live.share.url;
    } finally {
      rmSync(cfg, { force: true });
    }
  }

  /** Expose's client (PHP) with the account's token; a subdomain or custom domain when given. */
  private async expose(live: Live, acc: { token: string; server: string; domain: string }, subdomain: string): Promise<void> {
    const php = getPhpRuntime();
    if (!php) throw new Error('Expose needs PHP 8.2+ (Runtimes page)');
    const args = [this.bin('expose'), 'share', `http://127.0.0.1:${live.gatewayPort}`, `--auth=${this.decrypt(acc.token)}`, '--no-vite-detection', '--no-interaction'];
    if (acc.server) args.push(`--server=${acc.server}`);
    if (subdomain) args.push(subdomain.includes('.') ? `--domain=${subdomain}` : `--subdomain=${subdomain}`);
    await this.tunnel(live, php.php, args, { ...php.env, TERM: 'dumb' }, /https:\/\/(?!127\.0\.0\.1|localhost)[a-z0-9-]+(\.[a-z0-9-]+)+(?=[\s/|"'`]|$)/i, undefined, /(Invalid|Unauthorized|authentication failed|Could not connect|subdomain .* (taken|in use))[^\n]*/i);
  }

  async stop(id: string, reason = 'stopped'): Promise<void> {
    const live = this.live.get(id);
    if (!live) return;
    live.stopping = true;
    live.share.status = 'stopping';
    this.h.changed();
    if (live.timer) clearTimeout(live.timer);
    const proc = live.proc;
    if (proc) {
      await new Promise<void>((resolve) => {
        const t = setTimeout(() => {
          proc.kill('SIGKILL');
          resolve();
        }, 4000);
        proc.once('exit', () => {
          clearTimeout(t);
          resolve();
        });
        proc.kill('SIGTERM');
      });
    }
    live.gateway.close();
    this.live.delete(id);
    this.h.changed();
    if (reason === 'expired') this.h.notify(`${live.share.siteName}: share expired`, `${live.share.url ?? live.share.domain} was stopped after its time ran out.`);
  }

  async stopAll(): Promise<void> {
    this.login?.kill('SIGTERM');
    await Promise.all([...this.live.keys()].map((id) => this.stop(id)));
  }

  // ---------------------------------------------------------------- gateway

  private proxyTarget(secure: boolean) {
    return { host: '127.0.0.1', port: secure ? store.settings.httpsPort : store.settings.httpPort, tls: secure };
  }

  private unauthorized(res: ServerResponse, domain: string) {
    res.writeHead(401, { 'WWW-Authenticate': `Basic realm="${domain}"`, 'Content-Type': 'text/plain' });
    res.end('Authentication required');
  }

  private authOk(live: Live, header: string | undefined): boolean {
    if (!live.auth) return true;
    if (!header?.startsWith('Basic ')) return false;
    return Buffer.from(header.slice(6), 'base64').toString('utf8') === live.auth;
  }

  private gateway(id: string, domain: string, secure: boolean): Server {
    const target = this.proxyTarget(secure);
    const server = createServer((req, res) => {
      const live = this.live.get(id);
      if (!live) return res.destroy();
      if (!this.authOk(live, req.headers.authorization)) return this.unauthorized(res, domain);
      void this.forward(live, domain, target, req, res, false);
    });
    server.on('upgrade', (req: IncomingMessage, socket: Socket, head: Buffer) => {
      const live = this.live.get(id);
      if (!live || !this.authOk(live, req.headers.authorization)) return socket.destroy();
      const up = target.tls ? tlsConnect({ host: target.host, port: target.port, rejectUnauthorized: false, servername: domain }) : netConnect({ host: target.host, port: target.port });
      const headers = { ...req.headers, host: domain, 'x-forwarded-host': domain, 'x-forwarded-proto': 'https' };
      delete headers.authorization;
      const lines = [`${req.method} ${req.url} HTTP/1.1`, ...Object.entries(headers).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : v}`), '', ''];
      up.on('connect', () => undefined);
      up.once(target.tls ? 'secureConnect' : 'connect', () => {
        up.write(lines.join('\r\n'));
        if (head.length) up.write(head);
        socket.pipe(up).pipe(socket);
      });
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
      this.record(live, { method: req.method ?? 'GET', path: req.url ?? '/', status: 101, ms: 0, ip: req.headers['cf-connecting-ip'] as string, requestHeaders: this.flat(req.headers), responseHeaders: {}, requestBody: null, responseBody: null, replay: false });
    });
    return server;
  }

  private flat(h: IncomingMessage['headers'] | Record<string, string | string[] | number | undefined>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
    return out;
  }

  private bodyText(chunks: Buffer[], type: string | undefined, total: number): string | null {
    if (!total) return null;
    if (!TEXT_TYPES.test(type ?? '')) return `(${type ?? 'binary'}, ${total} bytes)`;
    const text = Buffer.concat(chunks).toString('utf8');
    return total > BODY_LIMIT ? `${text}\n… (${total} bytes, first ${BODY_LIMIT / 1024} KB shown)` : text;
  }

  private record(live: Live, r: Omit<ExposeRequest, 'id' | 'at'>): ExposeRequest {
    const entry: ExposeRequest = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: new Date().toISOString(), ...r };
    live.requests.unshift(entry);
    if (live.requests.length > REQUESTS_KEPT) live.requests.length = REQUESTS_KEPT;
    live.share.requests = live.requests.length;
    this.h.changed();
    return entry;
  }

  /** One HTTP request through to the proxy, recorded on the way. */
  /** Redirects and cookies of the site, pointed at the public host instead of the local domain. */
  private publicHeaders(h: IncomingMessage['headers'], domain: string, publicHost: string): IncomingMessage['headers'] {
    const out = { ...h };
    if (typeof out.location === 'string') out.location = rewriteHosts(out.location, domain, publicHost);
    if (out['set-cookie']) {
      const local = new RegExp(`;\\s*domain=\\.?${escapeRe(domain)}(?=;|$)`, 'gi');
      out['set-cookie'] = out['set-cookie'].map((c) => c.replace(local, ''));
    }
    return out;
  }

  private forward(live: Live, domain: string, target: { host: string; port: number; tls: boolean }, req: IncomingMessage, res: ServerResponse, replay: boolean, bodyOverride?: Buffer): Promise<ExposeRequest> {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const reqChunks: Buffer[] = [];
      let reqSize = 0;
      const headers = { ...req.headers, host: domain, 'x-forwarded-host': domain, 'x-forwarded-proto': 'https', 'accept-encoding': 'identity' };
      delete headers.authorization;
      delete headers['content-length'];
      if (!bodyOverride) delete headers['transfer-encoding'];
      const finish = (status: number | null, resHeaders: Record<string, string>, resChunks: Buffer[], resSize: number, resType?: string) => {
        const entry = this.record(live, {
          method: req.method ?? 'GET',
          path: req.url ?? '/',
          status,
          ms: Date.now() - t0,
          ip: (req.headers['cf-connecting-ip'] as string) ?? null,
          requestHeaders: this.flat(req.headers),
          responseHeaders: resHeaders,
          requestBody: this.bodyText(reqChunks, req.headers['content-type'], reqSize),
          responseBody: this.bodyText(resChunks, resType, resSize),
          replay,
        });
        resolve(entry);
      };
      const options: RequestOptions = { host: target.host, port: target.port, method: req.method, path: req.url, headers, rejectUnauthorized: false, servername: domain };
      const up = (target.tls ? httpsRequest : httpRequest)(options, (r) => {
          // Cloudflare swaps an origin's 502 / 504 for its own "Host Error" page; 503 goes through with the site's page.
          const status = r.statusCode === 502 || r.statusCode === 504 ? 503 : (r.statusCode ?? 503);
          const resChunks: Buffer[] = [];
          let resSize = 0;
          const publicHost = live.share.url ? new URL(live.share.url).host : null;
          const outHeaders = publicHost ? this.publicHeaders(r.headers, domain, publicHost) : r.headers;
          // Pages, scripts and styles name the local domain (APP_URL, Vite's public/hot): rewritten to the public URL so
          // other devices load the assets through the tunnel too. Other bodies stream through untouched.
          if (publicHost && REWRITE_TYPES.test(String(r.headers['content-type'] ?? '')) && !r.headers['content-encoding']) {
            const body: Buffer[] = [];
            r.on('data', (d: Buffer) => body.push(d));
            r.on('end', () => {
              const out = Buffer.from(rewriteHosts(Buffer.concat(body).toString('utf8'), domain, publicHost), 'utf8');
              delete outHeaders['content-length'];
              delete outHeaders['transfer-encoding'];
              res.writeHead(status, { ...outHeaders, 'content-length': String(out.length) });
              res.end(out);
              finish(r.statusCode ?? null, this.flat(r.headers), [out.subarray(0, BODY_LIMIT)], out.length, r.headers['content-type']);
            });
            r.on('error', () => {
              res.destroy();
              finish(r.statusCode ?? null, this.flat(r.headers), [], 0, r.headers['content-type']);
            });
            return;
          }
          res.writeHead(status, outHeaders);
          r.on('data', (d: Buffer) => {
            resSize += d.length;
            if (resSize <= BODY_LIMIT) resChunks.push(d);
            res.write(d);
          });
          r.on('end', () => {
            res.end();
            finish(r.statusCode ?? null, this.flat(r.headers), resChunks, resSize, r.headers['content-type']);
          });
          r.on('error', () => {
            res.destroy();
            finish(r.statusCode ?? null, this.flat(r.headers), resChunks, resSize, r.headers['content-type']);
          });
        },
      );
      up.on('error', (e) => {
        res.writeHead(502, { 'Content-Type': 'text/plain' });
        res.end(`DevCatz: the site did not answer (${e.message})`);
        finish(502, {}, [Buffer.from(e.message)], e.message.length, 'text/plain');
      });
      if (bodyOverride) {
        reqChunks.push(bodyOverride.subarray(0, BODY_LIMIT));
        reqSize = bodyOverride.length;
        up.end(bodyOverride);
      } else {
        req.on('data', (d: Buffer) => {
          reqSize += d.length;
          if (reqSize <= BODY_LIMIT) reqChunks.push(d);
          up.write(d);
        });
        req.on('end', () => up.end());
        req.on('error', () => up.destroy());
      }
    });
  }

  requests(shareId: string, limit: number): ExposeRequest[] {
    return (this.live.get(shareId)?.requests ?? []).slice(0, limit);
  }

  clearRequests(shareId: string): void {
    const live = this.live.get(shareId);
    if (!live) return;
    live.requests = [];
    live.share.requests = 0;
    this.h.changed();
  }

  /** Sends a recorded request again (webhooks), through the same gateway so it is recorded too. */
  async replay(shareId: string, requestId: string): Promise<ExposeRequest> {
    const live = this.live.get(shareId);
    if (!live) throw new Error('Share not found');
    const r = live.requests.find((x) => x.id === requestId);
    if (!r) throw new Error('Request not found');
    if (r.status === 101) throw new Error('WebSocket upgrades cannot be replayed');
    const headers: Record<string, string> = { ...r.requestHeaders };
    for (const k of ['content-length', 'transfer-encoding', 'host', 'connection', 'cf-ray', 'cf-connecting-ip', 'cf-visitor', 'cdn-loop']) delete headers[k];
    headers['x-devcatz-replay'] = r.id;
    if (live.auth) headers.authorization = `Basic ${Buffer.from(live.auth).toString('base64')}`;
    const body = r.requestBody && !r.requestBody.startsWith('(') ? Buffer.from(r.requestBody.replace(/\n… \(\d+ bytes.*$/, ''), 'utf8') : undefined;
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port: live.gatewayPort, method: r.method, path: r.path, headers: { ...headers, ...(body ? { 'content-length': String(body.length) } : {}) } }, (res) => {
        res.resume();
        res.on('end', () => {
          // The gateway recorded it; the newest entry with the replay marker is ours.
          const entry = live.requests.find((x) => x.requestHeaders['x-devcatz-replay'] === r.id);
          if (entry) {
            entry.replay = true;
            resolve(entry);
          } else reject(new Error('Replay was not recorded'));
        });
      });
      req.on('error', reject);
      req.end(body);
    });
  }
}
