import { spawn } from 'node:child_process';
import { app } from 'electron';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, watch, writeFileSync, type FSWatcher } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AiProvider, GitAccount, ThemeMode } from '@shared/types';
import { run } from './env';
import { isWin } from './platform';

/**
 * Settings shared by the Catzoid apps (DevCatz, DBCatz, DialCatz): the theme, the AI connection (provider, models,
 * addresses) and the Git hosting accounts. One owner-only JSON file every app reads, writes and watches, so a change in
 * one app shows up in the others; API keys sit in one Keychain item ("Catzoid AI", an account per provider)
 * read through macOS's `security` tool — the way git's and gh's credential helpers keep tokens.
 *
 * Contract (keep it the same in every app):
 *   ~/Library/Application Support/Catzoid/shared.json  (folder 0700, file 0600)
 *   { "version": 1, "theme": "system" | "light" | "dark",
 *     "ai": { "provider": "anthropic", "models": { "<provider>": "<model>" }, "baseUrls": { … }, "keys": ["<provider>", …] },
 *     "updatedBy": "devcatz" | "dbcatz" | "dialcatz", "updatedAt": "<ISO time>" }
 *   Keychain: generic password, service "Catzoid AI", account = provider id, password = the API key.
 *   On / off switches (AI enabled, features) stay in each app.
 *   Git hosting accounts (connected once, used by every Catzoid app; same as DialCatz's shared.ts):
 *     "git": { "accounts": [ { "id", "kind": "github"|"gitlab"|"gitea"|"bitbucket", "baseUrl", "username", "name",
 *              "avatarUrl" (the remote URL), "addedAt" } ] }
 *   Keychain: generic password, service "Catzoid Git", account = the account id, password = its token.
 *   Windows: the tokens DPAPI-encrypted in Catzoid/git/<account id>.dpapi (the AI keys in Catzoid/keys/).
 * CATZOID_SHARED_DIR and CATZOID_KEYCHAIN (a keychain file) point both elsewhere, for tests (same as DBCatz's copy).
 */

export const SHARED_DIR = process.env.CATZOID_SHARED_DIR || (isWin ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'Catzoid') : join(homedir(), 'Library', 'Application Support', 'Catzoid'));
const FILE = join(SHARED_DIR, 'shared.json');
const SERVICE = 'Catzoid AI';
const GIT_SERVICE = 'Catzoid Git';
const ME = 'devcatz';
/** A keychain file instead of the login keychain (tests only). */
const KEYCHAIN = process.env.CATZOID_KEYCHAIN ? [process.env.CATZOID_KEYCHAIN] : [];

export interface SharedAi {
  provider?: AiProvider;
  models?: Partial<Record<AiProvider, string>>;
  baseUrls?: Partial<Record<AiProvider, string>>;
  /** Providers with a key in the Keychain (names only). */
  keys?: AiProvider[];
}
export interface Shared {
  version: 1;
  theme?: ThemeMode;
  ai?: SharedAi;
  /** Git hosting accounts, shared by the Catzoid apps (tokens in the Keychain item "Catzoid Git"). */
  git?: { accounts?: GitAccount[] };
  /** The Catzoid site address the apps build their links from (Catzoid TODO #50); DEFAULT_SITE when unset. */
  site?: string;
  updatedBy?: string;
  updatedAt?: string;
}

let cache: Shared | null = null;

/**
 * The default site address (production). While testing against dev.catzoid.tech, Catzoid/shared.json carries
 * `"site": "https://dev.catzoid.tech"` (Catzoid #64 puts it back).
 */
export const DEFAULT_SITE = 'https://catzoid.com';

/**
 * The shared site address: https on catzoid.com or *.catzoid.tech only (anything else falls back to the default).
 * A development build also takes CATZOID_SITE (the local site at https://catzoid.localhost, or a mock on http) for tests.
 */
export function siteBase(): string {
  const dev = !app.isPackaged && process.env.CATZOID_SITE;
  try {
    const u = new URL(dev || readShared().site || DEFAULT_SITE);
    if (dev && /^https?:$/.test(u.protocol)) return u.origin;
    if (u.protocol === 'https:' && /^(catzoid\.com|([\w-]+\.)*catzoid\.tech)$/.test(u.hostname)) return u.origin;
  } catch {
    /* not a URL */
  }
  return DEFAULT_SITE;
}

export function readShared(): Shared {
  if (cache) return cache;
  try {
    const v = JSON.parse(readFileSync(FILE, 'utf8')) as Shared;
    cache = v && typeof v === 'object' ? { ...v, version: 1 } : { version: 1 };
  } catch {
    cache = { version: 1 };
  }
  return cache;
}

/** Merges `patch` (ai merged one level deep) and writes the file atomically. */
export function writeShared(patch: Partial<Omit<Shared, 'version' | 'ai' | 'git'>> & { ai?: SharedAi; git?: Shared['git'] }): Shared {
  const cur = readShared();
  const next: Shared = {
    ...cur,
    ...patch,
    ai: patch.ai ? { ...(cur.ai ?? {}), ...patch.ai } : cur.ai,
    git: patch.git ? { ...(cur.git ?? {}), ...patch.git } : cur.git,
    version: 1,
    updatedBy: ME,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
  chmodSync(SHARED_DIR, 0o700);
  const tmp = `${FILE}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, FILE);
  cache = next;
  lastOwnWrite = next.updatedAt!;
  return next;
}

let lastOwnWrite = '';
let watcher: FSWatcher | null = null;
const listeners: ((s: Shared) => void)[] = [];
/** One more listener for another app's changes (Git accounts …), next to the settings one. */
export const onSharedChange = (fn: (s: Shared) => void) => listeners.push(fn);

/** Calls `onChange` when another app changed the file (own writes are ignored). */
export function watchShared(onChange: (s: Shared) => void): void {
  watcher?.close();
  mkdirSync(SHARED_DIR, { recursive: true, mode: 0o700 });
  let timer: NodeJS.Timeout | null = null;
  try {
    watcher = watch(SHARED_DIR, (_e, name) => {
      if (name && name !== 'shared.json') return;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        cache = null;
        keyCache.clear();
        gitTokens.clear();
        const s = readShared();
        if (s.updatedAt && s.updatedAt === lastOwnWrite) return;
        onChange(s);
        for (const fn of listeners) fn(s);
      }, 250);
    });
  } catch {
    /* folder vanished: no live updates, the next read still sees changes */
  }
}

export const sharedExists = () => existsSync(FILE);

// ---------------------------------------------------------------- Keychain

const keyCache = new Map<AiProvider, { at: number; key: string }>();

/**
 * Windows (Catzoid #57, stage 1): the key encrypted with DPAPI for the current user (PowerShell's
 * ConvertFrom-SecureString) in Catzoid/keys/<provider>.dpapi, so every Catzoid app of the same user can read it, as
 * the Keychain item on macOS. The key goes in through stdin, never the command line.
 */
const keyFile = (provider: AiProvider) => join(SHARED_DIR, 'keys', `${provider}.dpapi`);
const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
function powershell(script: string, input = ''): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const p = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    p.on('error', () => resolve({ code: 1, out: '' }));
    p.on('close', (c) => resolve({ code: c ?? 1, out }));
    p.stdin.end(input);
  });
}
async function winKey(provider: AiProvider): Promise<string> {
  return winSecret(keyFile(provider));
}
async function winSecret(file: string): Promise<string> {
  if (!existsSync(file)) return '';
  const r = await powershell(
    `$s = ConvertTo-SecureString (Get-Content -Raw -Path ${psQuote(file)}).Trim(); ` +
      '[Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($s))',
  );
  return r.code === 0 ? r.out.trim() : '';
}
async function setWinKey(provider: AiProvider, key: string): Promise<void> {
  return setWinSecret(keyFile(provider), key);
}
async function setWinSecret(file: string, key: string): Promise<void> {
  if (!key) {
    rmSync(file, { force: true });
    return;
  }
  mkdirSync(join(file, '..'), { recursive: true });
  const r = await powershell(
    `$k = [Console]::In.ReadToEnd().Trim(); ConvertTo-SecureString $k -AsPlainText -Force | ConvertFrom-SecureString | Set-Content -NoNewline -Path ${psQuote(file)}`,
    key,
  );
  if (r.code !== 0) throw new Error('Windows could not store the key');
}

/** `security -i` with one add command on stdin, so the secret never appears in a process list. */
function keychainAdd(service: string, account: string, secret: string): Promise<void> {
  // `security -i` exits 0 even when a command failed: anything on stderr counts as a failed save.
  return new Promise<void>((resolve, reject) => {
    const p = spawn('/usr/bin/security', ['-i'], { stdio: ['pipe', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('close', (c) => (c === 0 && !err.trim() ? resolve() : reject(new Error(`Keychain: ${err.trim() || `exit ${c}`}`))));
    p.stdin.end(`add-generic-password -U -s "${service}" -a "${account}" -l "${service} (${account})" -w "${secret}"${KEYCHAIN.length ? ` "${KEYCHAIN[0]}"` : ''}\n`);
  });
}

/** The provider's API key from the shared Keychain item ('' when there is none). Cached for a minute. */
export async function sharedKey(provider: AiProvider): Promise<string> {
  const hit = keyCache.get(provider);
  if (hit && Date.now() - hit.at < 60_000) return hit.key;
  if (isWin) {
    const key = await winKey(provider);
    keyCache.set(provider, { at: Date.now(), key });
    return key;
  }
  const r = await run('/usr/bin/security', ['find-generic-password', '-s', SERVICE, '-a', provider, '-w', ...KEYCHAIN], { timeout: 15_000 });
  const key = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  keyCache.set(provider, { at: Date.now(), key });
  return key;
}

/** Saves (or with '' removes) a provider's key in the shared Keychain item and lists it in shared.json. */
export async function setSharedKey(provider: AiProvider, key: string): Promise<void> {
  const k = key.trim();
  if (isWin) {
    if (/["\\\n\r]/.test(k)) throw new Error('That key has characters an API key does not have');
    await setWinKey(provider, k);
  } else if (!k) {
    await run('/usr/bin/security', ['delete-generic-password', '-s', SERVICE, '-a', provider, ...KEYCHAIN], { timeout: 15_000 });
  } else {
    if (/["\\\n\r]/.test(k)) throw new Error('That key has characters an API key does not have');
    await keychainAdd(SERVICE, provider, k);
  }
  keyCache.delete(provider);
  const keys = new Set(readShared().ai?.keys ?? []);
  if (k) keys.add(provider);
  else keys.delete(provider);
  writeShared({ ai: { keys: [...keys] } });
}

// ---------------------------------------------------------------- Git accounts (shared with the Catzoid apps)

/** Connected Git hosting accounts (no tokens). */
export const sharedGitAccounts = (): GitAccount[] => (readShared().git?.accounts ?? []).filter((a) => a && a.id && a.kind && a.baseUrl);

export function setSharedGitAccounts(accounts: GitAccount[]): void {
  writeShared({ git: { accounts } });
}

const gitTokens = new Map<string, { at: number; token: string }>();
const gitTokenFile = (id: string) => join(SHARED_DIR, 'git', `${id.replace(/[^\w.-]/g, '_')}.dpapi`);

/** An account's token from the shared Keychain item ('' when there is none). Cached for a minute. */
export async function sharedGitToken(id: string): Promise<string> {
  const hit = gitTokens.get(id);
  if (hit && Date.now() - hit.at < 60_000) return hit.token;
  let token = '';
  if (isWin) token = await winSecret(gitTokenFile(id));
  else {
    const r = await run('/usr/bin/security', ['find-generic-password', '-s', GIT_SERVICE, '-a', id, '-w', ...KEYCHAIN], { timeout: 15_000 });
    token = r.code === 0 ? r.stdout.replace(/\n$/, '') : '';
  }
  gitTokens.set(id, { at: Date.now(), token });
  return token;
}

/** Saves (or with '' removes) an account's token in the shared Keychain item (never in a process list). */
export async function setSharedGitToken(id: string, token: string): Promise<void> {
  const t = token.trim();
  if (/["\\\n\r]/.test(t)) throw new Error('That token has characters a token does not have');
  if (isWin) await setWinSecret(gitTokenFile(id), t);
  else if (!t) await run('/usr/bin/security', ['delete-generic-password', '-s', GIT_SERVICE, '-a', id, ...KEYCHAIN], { timeout: 15_000 });
  else await keychainAdd(GIT_SERVICE, id, t);
  gitTokens.delete(id);
}
