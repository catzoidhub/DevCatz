import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DbBinary, DbEngine, DbServiceConfig, TaskProgress } from '@shared/types';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { brewBin } from './php';
import { exe, isWin, TAR } from './platform';
import { dataDir } from './store';

/**
 * Database server builds and how to run them. Each engine comes from its
 * vendor's own builds where those are self-contained (MySQL, MongoDB,
 * Elasticsearch tarballs, theseus-rs' relocatable PostgreSQL builds), is
 * compiled from the official source (Redis, small and dependency-free), or
 * installed with Homebrew (MariaDB publishes no macOS builds). SQLite is the
 * one macOS ships.
 */

/** Moves an install task on: named step plus what is being worked on. */
export type Step = (name: string, p?: Partial<TaskProgress>) => void;

export interface RemoteBuild {
  /** Full version, e.g. 8.4.11. */
  version: string;
  /** Release line shown in the picker, e.g. "8.4 LTS". */
  label: string;
  source: DbBinary['source'];
  url?: string;
  hash?: string;
  algo?: 'sha256' | 'sha512' | 'md5';
  /** Homebrew formula (MariaDB). */
  formula?: string;
  note?: string;
}

export interface RunSpec {
  command: string;
  env: Record<string, string>;
  stopSignal?: NodeJS.Signals;
}

export interface EngineDef {
  name: string;
  description: string;
  defaultPort: number;
  sourceNote: string;
  /** Message when something needed to install is missing (Homebrew, Command Line Tools). */
  requirement?: () => Promise<string | null>;
  builds(): Promise<RemoteBuild[]>;
  installSteps(b: RemoteBuild): string[];
  /** Installs into `dest` (Homebrew: elsewhere); returns the build's root folder. */
  install(b: RemoteBuild, dest: string, step: Step, signal: AbortSignal): Promise<string>;
  version(root: string): Promise<string | null>;
  /** Creates the data folder's initial contents when they are missing (idempotent, runs before every start). */
  init?(c: DbServiceConfig, root: string, data: string): Promise<void>;
  spec?(c: DbServiceConfig, root: string, data: string, socket: string | null): RunSpec;
  /** Once, after the first successful start (extra users/roles). */
  bootstrap?(c: DbServiceConfig, root: string): Promise<void>;
  /** Windows: asks the server to stop itself (console programs get no SIGTERM; taskkill /F skips the clean shutdown). */
  shutdown?(c: DbServiceConfig, root: string, data: string): Promise<void>;
}

export class Cancelled extends Error {
  constructor() {
    super('Cancelled');
  }
}
const check = (signal: AbortSignal) => {
  if (signal.aborted) throw new Cancelled();
};

// Windows: cmd.exe has no single quotes; double quotes (paths cannot hold one, a password's is escaped for the CRT).
export const q = (s: string) => (isWin ? `"${s.replace(/"/g, '\\"')}"` : `'${s.replace(/'/g, `'\\''`)}'`);
const arch = process.arch === 'arm64';
/** A build's tool: `<root>/bin/psql` (`psql.exe` on Windows). */
export const binOf = (root: string, name: string) => join(root, 'bin', exe(name));
/** Engines DevCatz cannot run on Windows yet (no usable builds there). */
const notOnWindows = (name: string) => `${name} is not available on Windows yet.`;

// ------------------------------------------------------------------ helpers

/**
 * Remote version lists, kept on disk (db-services/versions.json): the create
 * form opens instantly from the last list, which is refreshed in the background
 * once it is an hour old (GitHub allows 60 requests/hour without a token).
 */
const VERSIONS_FILE = () => dataDir('db-services', 'versions.json');
let disk: Record<string, { at: number; value: unknown }> | null = null;
const refreshing = new Map<string, Promise<unknown>>();
function loadDisk(): Record<string, { at: number; value: unknown }> {
  if (!disk) {
    try {
      disk = JSON.parse(readFileSync(VERSIONS_FILE(), 'utf8'));
    } catch {
      disk = {};
    }
  }
  return disk!;
}
function refresh<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = refreshing.get(key);
  if (running) return running as Promise<T>;
  const p = fn()
    .then((value) => {
      const d = loadDisk();
      d[key] = { at: Date.now(), value };
      try {
        mkdirSync(dirname(VERSIONS_FILE()), { recursive: true });
        writeFileSync(VERSIONS_FILE(), JSON.stringify(d));
      } catch {
        /* the memory copy still works */
      }
      return value;
    })
    .finally(() => refreshing.delete(key));
  refreshing.set(key, p);
  return p;
}
async function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = loadDisk()[key];
  if (hit) {
    if (Date.now() - hit.at > 3_600_000) refresh(key, fn).catch(() => undefined);
    return hit.value as T;
  }
  return refresh(key, fn);
}

async function json<T>(url: string, headers: Record<string, string> = {}): Promise<T> {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}${res.status === 403 && url.includes('github') ? ' (rate limit, try again later)' : ''}`);
  return (await res.json()) as T;
}

async function text(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
  return res.text();
}

const cmpVersion = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pb[i] ?? 0) - (pa[i] ?? 0);
  return 0;
};
/** Newest version per release line (`key`), newest line first. */
function latestPer<T extends { version: string }>(items: T[], key: (v: string) => string): T[] {
  const best = new Map<string, T>();
  for (const it of [...items].sort((a, b) => cmpVersion(a.version, b.version))) if (!best.has(key(it.version))) best.set(key(it.version), it);
  return [...best.values()];
}
const minor = (v: string) => v.split('.').slice(0, 2).join('.');
const major = (v: string) => v.split('.')[0];

/** Downloads, verifies and unpacks a tarball into `dest` (its single top folder stripped). */
async function fetchTarball(b: RemoteBuild, dest: string, step: Step, signal: AbortSignal): Promise<void> {
  const tmp = `${dest}.partial`;
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
  const archive = join(dirname(dest), `.download-${Date.now()}${b.url!.endsWith('.zip') ? '.zip' : '.tar.gz'}`);
  try {
    step('Downloading', { detail: b.url!.split('/').pop(), received: 0, total: 0 });
    const digest = await downloadVerified(b.url!, archive, '', (received, total) => step('Downloading', { received, total }), undefined, signal, b.algo ?? 'sha256').catch(
      (e) => {
        throw signal.aborted ? new Cancelled() : e;
      },
    );
    check(signal);
    step('Verifying the checksum', { received: undefined, total: undefined, detail: b.hash ? `${(b.algo ?? 'sha256').toUpperCase()} ${digest.slice(0, 16)}…` : 'no checksum published' });
    if (b.hash && digest !== b.hash.toLowerCase()) throw new Error(`Checksum mismatch (expected ${b.hash.slice(0, 12)}…, got ${digest.slice(0, 12)}…); download discarded`);
    step('Unpacking', { detail: dest });
    // Windows' bsdtar reads the .zip builds too.
    const r = await run(TAR, [isWin ? '-xf' : '-xzf', archive, '-C', tmp, '--strip-components=1'], { timeout: 600_000 });
    if (r.code !== 0) throw new Error(`Unpacking failed: ${r.stderr.trim()}`);
    check(signal);
    if (!isWin) await run('xattr', ['-dr', 'com.apple.quarantine', tmp]);
    rmSync(dest, { recursive: true, force: true });
    renameSync(tmp, dest);
  } finally {
    rmSync(archive, { force: true });
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Runs a command, streaming its last output line as the step detail; killed on cancel. */
function stream(cmd: string, args: string[], cwd: string, onLine: (l: string) => void, signal: AbortSignal, env: Record<string, string> = {}): Promise<string[]> {
  return new Promise((resolve, reject) => {
    const tail: string[] = [];
    const child = spawn(cmd, args, { cwd, env: { ...getShellEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const kill = () => child.kill('SIGTERM');
    signal.addEventListener('abort', kill, { once: true });
    const onData = (d: Buffer) => {
      for (const line of d.toString().split('\n').map((l) => l.trim()).filter(Boolean)) {
        tail.push(line);
        if (tail.length > 30) tail.shift();
        onLine(line.slice(0, 160));
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('close', (code) => {
      signal.removeEventListener('abort', kill);
      if (signal.aborted) return reject(new Cancelled());
      if (code !== 0) return reject(new Error(`${cmd.split('/').pop()} ${args[0] ?? ''} failed:\n${tail.slice(-8).join('\n')}`));
      resolve(tail);
    });
  });
}

/** stdout of a client command (mysql / psql), throwing with its stderr. */
export async function client(cmd: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await run(cmd, args, { timeout: 30_000, env });
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split('\n').slice(-3).join('\n') || `${cmd} failed`);
  return r.stdout;
}

const DOWNLOAD_STEPS = ['Downloading', 'Verifying the checksum', 'Unpacking', 'Checking the version'];
const firstExisting = (...paths: string[]) => paths.find((p) => existsSync(p)) ?? paths[0];

// ------------------------------------------------------------------ MySQL / MariaDB

async function brewVersion(formula: string): Promise<string | null> {
  const res = await fetch(`https://formulae.brew.sh/api/formula/${formula}.json`);
  if (!res.ok) return null;
  return ((await res.json()) as { versions: { stable: string } }).versions.stable;
}

/** Options shared by mysqld and mariadbd: the config file (or none, so never /etc/my.cnf) and folders. */
function mysqlArgList(c: DbServiceConfig, root: string, data: string): string[] {
  return [c.configFile ? `--defaults-file=${c.configFile}` : '--no-defaults', `--basedir=${root}`, `--datadir=${data}`];
}
/** The same for a shell command line (values quoted). */
const mysqlArgs = (c: DbServiceConfig, root: string, data: string) =>
  mysqlArgList(c, root, data)
    .map((a) => a.replace(/^(--[\w-]+=)(.*)$/, (_m, k: string, v: string) => k + q(v)))
    .join(' ');

/** root@'%' next to root@localhost, so containers (host.docker.internal) and 127.0.0.1 clients get in too. */
const MYSQL_BOOTSTRAP = (pw: string) => {
  const p = pw.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
  return `CREATE USER IF NOT EXISTS 'root'@'%' IDENTIFIED BY '${p}'; GRANT ALL PRIVILEGES ON *.* TO 'root'@'%' WITH GRANT OPTION; FLUSH PRIVILEGES;`;
};
export const mysqlClient = (root: string) => firstExisting(binOf(root, 'mariadb'), binOf(root, 'mysql'));
export const mysqlClientArgs = (c: DbServiceConfig) => ['--no-defaults', '--protocol=TCP', '-h127.0.0.1', `-P${c.port}`, `-u${c.user || 'root'}`];
/** Windows: SHUTDOWN over TCP (MySQL 5.7.9+, MariaDB 10.0.4+), the clean stop a signal gives on macOS. */
const mysqlShutdown = async (c: DbServiceConfig, root: string) => {
  await client(mysqlClient(root), [...mysqlClientArgs(c), '-e', 'SHUTDOWN'], { MYSQL_PWD: c.password });
};

const mysql: EngineDef = {
  name: 'MySQL',
  description: `Oracle’s MySQL Community Server; official ${isWin ? 'Windows' : 'macOS'} builds.`,
  defaultPort: 3306,
  sourceNote: isWin ? 'Official Windows x64 ZIP from cdn.mysql.com (MD5 from the CDN)' : 'Official macOS tarball from cdn.mysql.com (MD5 from the CDN)',
  async builds() {
    return cached('mysql', async () => {
      const lines: [string, string][] = [
        ['mysql', ''],
        ['mysql@8.4', 'LTS'],
        ['mysql@8.0', ''],
      ];
      const out: RemoteBuild[] = [];
      for (const [formula, tag] of lines) {
        const v = await brewVersion(formula).catch(() => null);
        if (v && !out.some((o) => o.version === v)) out.push({ version: v, label: `${minor(v)}${tag ? ` ${tag}` : ''}`, source: 'download' });
      }
      if (!out.length) throw new Error('Could not read MySQL versions (formulae.brew.sh)');
      return out;
    });
  },
  installSteps: () => ['Finding the build', ...DOWNLOAD_STEPS],
  async install(b, dest, step, signal) {
    if (isWin) {
      // The "Windows (x86, 64-bit), ZIP Archive"; older releases move to /archives.
      step('Finding the build', { detail: `MySQL ${b.version} for Windows x64` });
      const file = `mysql-${b.version}-winx64.zip`;
      for (const url of [`https://cdn.mysql.com/Downloads/MySQL-${minor(b.version)}/${file}`, `https://cdn.mysql.com/archives/mysql-${minor(b.version)}/${file}`]) {
        const res = await fetch(url, { method: 'HEAD', signal }).catch(() => null);
        if (!res?.ok) continue;
        const md5 = res.headers.get('etag')?.match(/^"?([a-f0-9]{32})/)?.[1];
        await fetchTarball({ ...b, url, hash: md5, algo: 'md5' }, dest, step, signal);
        return dest;
      }
      throw new Error(`No Windows build of MySQL ${b.version} on cdn.mysql.com`);
    }
    step('Finding the build', { detail: `MySQL ${b.version} for macOS ${arch ? 'arm64' : 'x86_64'}` });
    // The tarball is named after the macOS it was built on.
    let found: { url: string; md5: string | null } | null = null;
    for (const os of ['macos26', 'macos15', 'macos14', 'macos13']) {
      const url = `https://cdn.mysql.com/Downloads/MySQL-${minor(b.version)}/mysql-${b.version}-${os}-${arch ? 'arm64' : 'x86_64'}.tar.gz`;
      const res = await fetch(url, { method: 'HEAD', signal }).catch(() => null);
      if (res?.ok) {
        found = { url, md5: res.headers.get('etag')?.match(/^"?([a-f0-9]{32})/)?.[1] ?? null };
        break;
      }
    }
    if (!found) throw new Error(`No macOS build of MySQL ${b.version} on cdn.mysql.com`);
    await fetchTarball({ ...b, url: found.url, hash: found.md5 ?? undefined, algo: 'md5' }, dest, step, signal);
    return dest;
  },
  async version(root) {
    const r = await run(binOf(root, 'mysqld'), ['--version'], { timeout: 15_000 });
    return r.stdout.match(/Ver\s+([\d.]+)/)?.[1] ?? null;
  },
  async init(c, root, data) {
    if (existsSync(join(data, 'mysql'))) return;
    mkdirSync(data, { recursive: true });
    if (readdirSync(data).filter((f) => !f.startsWith('.')).length) throw new Error(`${data} is not empty and holds no MySQL data`);
    // Windows: --console, or the errors go to an .err file in the data folder instead of stderr.
    const r = await run(binOf(root, 'mysqld'), [...mysqlArgList(c, root, data), '--initialize-insecure', ...(isWin ? ['--console'] : [])], { timeout: 300_000 });
    if (r.code !== 0) throw new Error(`mysqld --initialize failed:\n${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')}`);
  },
  spec(c, root, data, socket) {
    return {
      command:
        // Both loopbacks: *.localhost resolves to ::1 first (service domains). Windows: TCP only (--socket names a pipe there).
        `${q(binOf(root, 'mysqld'))} ${mysqlArgs(c, root, data)} --port=${c.port} --bind-address=127.0.0.1,::1${socket ? ` --socket=${q(socket)}` : ''} ` +
        `--mysqlx=OFF --console --pid-file=${q(join(data, 'devcatz.pid'))}${c.disableBinLog ? ' --disable-log-bin' : ''}`,
      env: {},
    };
  },
  async bootstrap(c, root) {
    await client(mysqlClient(root), [...mysqlClientArgs(c), '-e', MYSQL_BOOTSTRAP(c.password)], { MYSQL_PWD: c.password });
  },
  shutdown: mysqlShutdown,
};


const MARIADB_FORMULAS: [string, string][] = [
  ['mariadb', ''],
  ['mariadb@11.8', 'LTS'],
  ['mariadb@11.4', 'LTS'],
  ['mariadb@10.11', 'LTS'],
  ['mariadb@10.6', 'LTS'],
];
const brewPrefix = () => {
  const b = brewBin();
  return b ? dirname(dirname(b)) : null;
};

interface MariaRelease {
  release_id: string;
  release_status: string;
  release_support_type: string | null;
  release_eol_date: string | null;
}
interface MariaFile {
  file_name: string;
  file_download_url: string;
  checksum: { sha256sum?: string };
}

/** Windows: the official winx64 ZIPs, newest stable release of each supported line (MariaDB's REST API, SHA-256). */
async function mariadbWindowsBuilds(): Promise<RemoteBuild[]> {
  const api = 'https://downloads.mariadb.org/rest-api/mariadb';
  const { major_releases } = await json<{ major_releases: MariaRelease[] }>(`${api}/`);
  const today = new Date().toISOString().slice(0, 10);
  const lines = major_releases.filter((r) => r.release_status === 'Stable' && (!r.release_eol_date || r.release_eol_date >= today));
  // The newest rolling line plus every LTS one, like the Homebrew list on macOS.
  const pick = lines.filter((r, i) => i === 0 || /long term/i.test(r.release_support_type ?? ''));
  const out: RemoteBuild[] = [];
  for (const line of pick) {
    const d = await json<{ releases: Record<string, { files: MariaFile[] }> }>(`${api}/${line.release_id}/latest/`).catch(() => null);
    for (const [version, rel] of Object.entries(d?.releases ?? {})) {
      const zip = rel.files.find((f) => f.file_name === `mariadb-${version}-winx64.zip`);
      if (!zip) continue;
      const lts = /long term/i.test(line.release_support_type ?? '');
      out.push({ version, label: `${line.release_id}${lts ? ' LTS' : ''}`, source: 'download', url: zip.file_download_url.replace(/^http:/, 'https:'), hash: zip.checksum.sha256sum, algo: 'sha256' });
    }
  }
  if (!out.length) throw new Error('Could not read MariaDB versions (downloads.mariadb.org)');
  return out;
}

const mariadb: EngineDef = {
  name: 'MariaDB',
  description: 'Community fork of MySQL, drop-in for most apps.',
  defaultPort: 3306,
  sourceNote: isWin
    ? 'Official Windows x64 ZIP from downloads.mariadb.org (SHA-256)'
    : 'Homebrew (MariaDB publishes no macOS builds); runs with DevCatz’s own data folder and port',
  async requirement() {
    if (isWin) return null;
    return brewBin() ? null : 'MariaDB comes from Homebrew. Install Homebrew from https://brew.sh first.';
  },
  async builds() {
    if (isWin) return cached('mariadb-win', mariadbWindowsBuilds);
    return cached('mariadb', async () => {
      const out: RemoteBuild[] = [];
      for (const [formula, tag] of MARIADB_FORMULAS) {
        const v = await brewVersion(formula).catch(() => null);
        if (v && !out.some((o) => minor(o.version) === minor(v))) out.push({ version: v, label: `${minor(v)}${tag ? ` ${tag}` : ''}`, source: 'homebrew', formula, note: `brew install ${formula}` });
      }
      if (!out.length) throw new Error('Could not read MariaDB versions (formulae.brew.sh)');
      return out;
    });
  },
  installSteps: () => (isWin ? DOWNLOAD_STEPS : ['Installing with Homebrew', 'Checking the version']),
  async install(b, dest, step, signal) {
    if (isWin) {
      await fetchTarball(b, dest, step, signal);
      return dest;
    }
    const brew = brewBin();
    const prefix = brewPrefix();
    if (!brew || !prefix) throw new Error('Install Homebrew from https://brew.sh first');
    const root = join(prefix, 'opt', b.formula!);
    step('Installing with Homebrew', { detail: `brew install ${b.formula}` });
    if (!existsSync(join(root, 'bin'))) {
      await stream(brew, ['install', b.formula!], prefix, (l) => step('Installing with Homebrew', { detail: l }), signal, {
        HOMEBREW_NO_ENV_HINTS: '1',
        NONINTERACTIVE: '1',
        HOMEBREW_NO_INSTALLED_DEPENDENTS_CHECK: '1',
      });
    }
    return root;
  },
  async version(root) {
    const bin = firstExisting(binOf(root, 'mariadbd'), binOf(root, 'mysqld'));
    const r = await run(bin, ['--version'], { timeout: 15_000 });
    return r.stdout.match(/Ver\s+([\d.]+)/)?.[1] ?? null;
  },
  async init(c, root, data) {
    if (existsSync(join(data, 'mysql'))) return;
    mkdirSync(data, { recursive: true });
    if (readdirSync(data).filter((f) => !f.startsWith('.')).length) throw new Error(`${data} is not empty and holds no MariaDB data`);
    if (isWin) {
      // Windows' mariadb-install-db.exe is its own program: only --datadir (root without a password, no test db).
      const installDb = firstExisting(binOf(root, 'mariadb-install-db'), binOf(root, 'mysql_install_db'));
      const r = await run(installDb, [`--datadir=${data}`], { timeout: 300_000 });
      if (r.code !== 0) throw new Error(`mariadb-install-db failed:\n${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')}`);
      return;
    }
    const installDb = firstExisting(join(root, 'bin/mariadb-install-db'), join(root, 'scripts/mariadb-install-db'), join(root, 'bin/mysql_install_db'));
    const r = await run(
      installDb,
      // No --user: it is only for root, and makes the script chown an unquoted path (breaks on "Application Support").
      [...mysqlArgList(c, root, data), '--auth-root-authentication-method=normal', '--skip-test-db'],
      { timeout: 300_000 },
    );
    if (r.code !== 0) throw new Error(`mariadb-install-db failed:\n${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')}`);
  },
  spec(c, root, data, socket) {
    const bin = firstExisting(binOf(root, 'mariadbd'), binOf(root, 'mysqld'));
    // A list of addresses needs MariaDB 10.11+; older ones stay on IPv4.
    const [ma, mi] = c.version.split('.').map(Number);
    const bind = ma > 10 || (ma === 10 && mi >= 11) ? '127.0.0.1,::1' : '127.0.0.1';
    return {
      command:
        // Windows: TCP only, and --console (the log goes to a file in the data folder otherwise).
        `${q(bin)} ${mysqlArgs(c, root, data)} --port=${c.port} --bind-address=${bind}${socket ? ` --socket=${q(socket)}` : ''}${isWin ? ' --console' : ''} ` +
        `--pid-file=${q(join(data, 'devcatz.pid'))} ${c.disableBinLog ? '--skip-log-bin' : '--log-bin=mysql-bin'}`,
      env: {},
    };
  },
  async bootstrap(c, root) {
    await client(mysqlClient(root), [...mysqlClientArgs(c), '-e', MYSQL_BOOTSTRAP(c.password)], { MYSQL_PWD: c.password });
  },
  shutdown: mysqlShutdown,
};

// ------------------------------------------------------------------ PostgreSQL

const PG_TRIPLE = isWin ? 'x86_64-pc-windows-msvc' : `${arch ? 'aarch64' : 'x86_64'}-apple-darwin`;
export const psqlArgs = (c: DbServiceConfig, db = 'postgres') => ['-h', '127.0.0.1', '-p', String(c.port), '-U', c.user || 'root', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X'];

const postgresql: EngineDef = {
  name: 'PostgreSQL',
  description: 'The advanced open-source SQL database.',
  defaultPort: 5432,
  sourceNote: 'Relocatable builds from github.com/theseus-rs/postgresql-binaries (SHA-256)',
  async builds() {
    return cached('postgresql', async () => {
      const tags: string[] = [];
      // The three pages in parallel (each takes a few seconds: releases carry many assets).
      const pages = await Promise.all(
        [1, 2, 3].map((page) =>
          json<{ tag_name: string; prerelease: boolean; assets: { name: string }[] }[]>(
            `https://api.github.com/repos/theseus-rs/postgresql-binaries/releases?per_page=100&page=${page}`,
            { Accept: 'application/vnd.github+json' },
          ).catch((e) => (page === 1 ? Promise.reject(e) : [])),
        ),
      );
      for (const rel of pages) for (const r of rel) if (!r.prerelease && r.assets.some((a) => a.name === `postgresql-${r.tag_name}-${PG_TRIPLE}.tar.gz`)) tags.push(r.tag_name);
      // Tags are <pg version>.<build>; keep the newest build of the newest minor per major.
      const builds = tags
        .filter((t) => /^\d+\.\d+\.\d+$/.test(t))
        .map((t) => ({ tag: t, version: t }))
        .filter((t) => Number(major(t.version)) >= 13);
      return latestPer(builds, major).map((t) => {
        const url = `https://github.com/theseus-rs/postgresql-binaries/releases/download/${t.tag}/postgresql-${t.tag}-${PG_TRIPLE}.tar.gz`;
        return { version: minor(t.version), label: major(t.version), source: 'download' as const, url };
      });
    });
  },
  installSteps: () => ['Finding the build', ...DOWNLOAD_STEPS],
  async install(b, dest, step, signal) {
    step('Finding the build', { detail: 'theseus-rs/postgresql-binaries' });
    const sha = (await text(`${b.url}.sha256`)).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new Error('No SHA-256 published for this build');
    await fetchTarball({ ...b, hash: sha, algo: 'sha256' }, dest, step, signal);
    return dest;
  },
  async version(root) {
    const r = await run(binOf(root, 'postgres'), ['--version'], { timeout: 15_000 });
    return r.stdout.match(/(\d+\.\d+)/)?.[1] ?? null;
  },
  async init(c, root, data) {
    if (existsSync(join(data, 'PG_VERSION'))) return;
    mkdirSync(data, { recursive: true });
    if (readdirSync(data).filter((f) => !f.startsWith('.')).length) throw new Error(`${data} is not empty and holds no PostgreSQL data`);
    // Superuser root, no password (trust on localhost), like the other engines.
    const r = await run(binOf(root, 'initdb'), ['-D', data, '-U', c.user || 'root', '--auth=trust', '-E', 'UTF8', '--locale=C'], { timeout: 300_000 });
    if (r.code !== 0) throw new Error(`initdb failed:\n${(r.stderr || r.stdout).trim().split('\n').slice(-6).join('\n')}`);
  },
  spec(c, root, data) {
    const conf = c.configFile ? ` -c config_file=${q(c.configFile)}` : '';
    // Windows: TCP only (unix_socket_directories is empty there by default).
    return {
      command: `${q(binOf(root, 'postgres'))} -D ${q(data)} -p ${c.port} -c listen_addresses=${q('127.0.0.1,::1')}${isWin ? '' : ' -c unix_socket_directories=/tmp'}${conf}`,
      env: { LC_ALL: 'C' },
      // SIGINT = fast shutdown (SIGTERM waits for every client to disconnect).
      stopSignal: 'SIGINT',
    };
  },
  async bootstrap(c, root) {
    const psql = binOf(root, 'psql');
    const env = { PGPASSWORD: c.password };
    // A `postgres` role too (what many tools and .env examples expect), and a database named after the user.
    await client(psql, [...psqlArgs(c), '-c', `DO $$BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'postgres') THEN CREATE ROLE postgres SUPERUSER LOGIN; END IF; END$$;`], env);
    const user = c.user || 'root';
    const has = await client(psql, [...psqlArgs(c), '-tAc', `SELECT 1 FROM pg_database WHERE datname = '${user}'`], env);
    if (!has.trim()) await client(psql, [...psqlArgs(c), '-c', `CREATE DATABASE "${user}"`], env);
  },
  async shutdown(_c, root, data) {
    // Fast shutdown, like SIGINT on macOS; pg_ctl signals the postmaster through its named pipe.
    await client(binOf(root, 'pg_ctl'), ['stop', '-D', data, '-m', 'fast', '-w', '-t', '30']);
  },
};

// ------------------------------------------------------------------ Redis / Valkey

let cltOk: boolean | null = null;

/**
 * Windows: Redis has no official build; github.com/redis-windows/redis-windows publishes the official source
 * compiled with MSYS2 (redis-server.exe, redis-cli.exe and their DLLs in one folder; SHA-256 from GitHub's asset digest).
 */
async function redisWindowsBuilds(minMajor: number): Promise<RemoteBuild[]> {
  const rels = await json<{ tag_name: string; prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; digest?: string | null }[] }[]>(
    'https://api.github.com/repos/redis-windows/redis-windows/releases?per_page=100',
    { Accept: 'application/vnd.github+json' },
  );
  const all: RemoteBuild[] = [];
  for (const r of rels) {
    if (r.prerelease || r.draft || !/^\d+\.\d+\.\d+$/.test(r.tag_name) || Number(major(r.tag_name)) < minMajor) continue;
    const a = r.assets.find((x) => x.name === `Redis-${r.tag_name}-Windows-x64-msys2.zip`);
    if (a) all.push({ version: r.tag_name, label: minor(r.tag_name), source: 'download', url: a.browser_download_url, hash: a.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1], algo: 'sha256' });
  }
  return latestPer(all, minor);
}

/**
 * Redis and its BSD fork Valkey: same build (plain `make`, no dependencies),
 * same flags; each publishes SHA-256s of its source tarballs in a *-hashes repo.
 */
function keyValue(o: { exe: 'redis' | 'valkey'; name: string; description: string; sourceNote: string; hashes: string; minMajor: number }): EngineDef {
  const server = `bin/${exe(`${o.exe}-server`)}`;
  // Windows: only Redis has builds (the community MSYS2 ones); Valkey publishes none.
  const winBuilds = o.exe === 'redis';
  const def: EngineDef = {
    name: o.name,
    description: o.description,
    defaultPort: 6379,
    sourceNote: isWin ? (winBuilds ? 'Community Windows build from github.com/redis-windows/redis-windows (MSYS2, SHA-256 from GitHub)' : 'No Windows builds yet') : o.sourceNote,
    async requirement() {
      if (isWin) return winBuilds ? null : `${notOnWindows(o.name)} Use Redis instead: Valkey speaks the same protocol.`;
      if (cltOk === null) cltOk = (await run('xcode-select', ['-p'])).code === 0;
      return cltOk ? null : `${o.name} is compiled from source and needs the Xcode Command Line Tools: run \`xcode-select --install\` in Terminal.`;
    },
    async builds() {
      if (isWin) {
        if (!winBuilds) throw new Error(notOnWindows(o.name));
        return cached(`${o.exe}-win`, () => redisWindowsBuilds(o.minMajor));
      }
      return cached(o.exe, async () => {
        const readme = await text(o.hashes);
        const all: RemoteBuild[] = [];
        // Release tarballs only (no -rc).
        for (const m of readme.matchAll(new RegExp(`^hash ${o.exe}-(\\d+\\.\\d+\\.\\d+)\\.tar\\.gz sha256 ([a-f0-9]{64}) (\\S+)`, 'gm'))) {
          all.push({ version: m[1], label: minor(m[1]), source: 'source', url: m[3].replace(/^http:/, 'https:'), hash: m[2], algo: 'sha256' });
        }
        return latestPer(all.filter((b) => Number(major(b.version)) >= o.minMajor), minor);
      });
    },
    installSteps: () => (isWin ? DOWNLOAD_STEPS : ['Downloading', 'Verifying the checksum', 'Unpacking', 'Compiling', 'Installing', 'Checking the version']),
    async install(b, dest, step, signal) {
      if (isWin) {
        // The zip holds the .exe files and DLLs in one folder: unpacked as bin/.
        if (!winBuilds) throw new Error(notOnWindows(o.name));
        mkdirSync(dest, { recursive: true });
        await fetchTarball(b, join(dest, 'bin'), step, signal);
        if (!existsSync(join(dest, server))) throw new Error(`The download holds no ${exe(`${o.exe}-server`)}`);
        return dest;
      }
      // Compiled in the system temp folder: Valkey's Makefile breaks on paths with spaces ("Application Support").
      const src = join(mkdtempSync(join(tmpdir(), `devcatz-${o.exe}-`)), 'src');
      try {
        await fetchTarball(b, src, step, signal);
        // Only the server (src/): Redis 8.10+'s top-level `make` also builds the bundled modules (RediSearch, RedisJSON …),
        // which need extra toolchains and fail on a plain Mac.
        step('Compiling', { detail: `make -C src -j${cpus().length}` });
        await stream('make', ['-C', 'src', `-j${cpus().length}`, 'BUILD_TLS=no', 'MALLOC=libc'], src, (l) => step('Compiling', { detail: l }), signal);
        step('Installing', { detail: dest });
        // Copied by hand: `make install` breaks on a PREFIX with spaces ("Application Support").
        mkdirSync(join(dest, 'bin'), { recursive: true });
        for (const tool of ['server', 'cli', 'benchmark', 'check-aof', 'check-rdb']) {
          const exe = `${o.exe}-${tool}`;
          if (existsSync(join(src, 'src', exe))) cpSync(join(src, 'src', exe), join(dest, 'bin', exe));
        }
        if (!existsSync(join(dest, server))) throw new Error(`The build produced no ${o.exe}-server`);
      } finally {
        rmSync(dirname(src), { recursive: true, force: true });
      }
      return dest;
    },
    async version(root) {
      const r = await run(join(root, server), ['--version'], { timeout: 15_000 });
      return r.stdout.match(/v=([\d.]+)/)?.[1] ?? null;
    },
    async init(_c, _root, data) {
      mkdirSync(data, { recursive: true });
    },
    spec(c, root, data) {
      const conf = c.configFile ? `${q(c.configFile)} ` : '';
      const pw = c.password ? ` --requirepass ${q(c.password)}` : '';
      // Windows: ::1 optional (`-`, Redis 7+), in case the MSYS2 build cannot bind IPv6.
      const bind = isWin ? (Number(major(c.version)) >= 7 ? '127.0.0.1 -::1' : '127.0.0.1') : '127.0.0.1 ::1';
      return { command: `${q(join(root, server))} ${conf}--port ${c.port} --bind ${bind} --dir ${q(data)} --daemonize no${pw}`, env: {} };
    },
    async shutdown(c, root) {
      // SHUTDOWN saves the dataset first when snapshots are configured (the default).
      await client(binOf(root, `${o.exe}-cli`), ['-h', '127.0.0.1', '-p', String(c.port), 'shutdown'], c.password ? { REDISCLI_AUTH: c.password } : {});
    },
  };
  return def;
}

const redis = keyValue({
  exe: 'redis',
  name: 'Redis',
  description: 'In-memory key-value store for cache, queues and sessions.',
  sourceNote: 'Official source from download.redis.io (SHA-256 from redis-hashes), compiled on this Mac',
  hashes: 'https://raw.githubusercontent.com/redis/redis-hashes/master/README',
  minMajor: 5,
});

const valkey = keyValue({
  exe: 'valkey',
  name: 'Valkey',
  description: 'Open-source (BSD) fork of Redis by the Linux Foundation; drop-in for Redis clients.',
  sourceNote: 'Official source from github.com/valkey-io/valkey (SHA-256 from valkey-hashes), compiled on this Mac',
  hashes: 'https://raw.githubusercontent.com/valkey-io/valkey-hashes/main/README',
  minMajor: 7,
});

// ------------------------------------------------------------------ MongoDB

interface MongoRelease {
  version: string;
  production_release: boolean;
  downloads: { target?: string; arch?: string; edition?: string; archive: { url: string; sha256?: string } }[];
}

const mongodb: EngineDef = {
  name: 'MongoDB',
  description: 'Document database (Community Server).',
  defaultPort: 27017,
  sourceNote: 'Official Community Server builds from fastdl.mongodb.org (SHA-256)',
  async requirement() {
    return isWin ? notOnWindows('MongoDB') : null;
  },
  async builds() {
    if (isWin) throw new Error(notOnWindows('MongoDB'));
    return cached('mongodb', async () => {
      const d = await json<{ versions: MongoRelease[] }>('https://downloads.mongodb.org/full.json');
      const all: RemoteBuild[] = [];
      for (const v of d.versions) {
        if (!v.production_release || Number(major(v.version)) < 6) continue;
        const dl = v.downloads.find((x) => x.target === 'macos' && x.arch === (arch ? 'arm64' : 'x86_64') && (x.edition === 'base' || x.edition === 'targeted'));
        if (dl?.archive.sha256) all.push({ version: v.version, label: minor(v.version), source: 'download', url: dl.archive.url, hash: dl.archive.sha256, algo: 'sha256' });
      }
      return latestPer(all, minor);
    });
  },
  installSteps: () => DOWNLOAD_STEPS,
  async install(b, dest, step, signal) {
    await fetchTarball(b, dest, step, signal);
    return dest;
  },
  async version(root) {
    const r = await run(join(root, 'bin/mongod'), ['--version'], { timeout: 15_000 });
    return r.stdout.match(/db version v([\d.]+)/)?.[1] ?? null;
  },
  async init(_c, _root, data) {
    mkdirSync(data, { recursive: true });
  },
  spec(c, root, data) {
    const conf = c.configFile ? `--config ${q(c.configFile)} ` : '';
    return { command: `${q(join(root, 'bin/mongod'))} ${conf}--dbpath ${q(data)} --port ${c.port} --bind_ip 127.0.0.1,::1 --ipv6`, env: {} };
  },
};

// ------------------------------------------------------------------ Elasticsearch

const ES_ARCH = arch ? 'aarch64' : 'x86_64';
/** Per-instance ES_PATH_CONF, outside the data folder (Elasticsearch 9 refuses a config folder inside path.data). */
const esConf = (c: DbServiceConfig) => dataDir('db-services', 'config', c.id);
const elasticsearch: EngineDef = {
  name: 'Elasticsearch',
  description: 'Search and analytics engine (security off for local use).',
  defaultPort: 9200,
  sourceNote: 'Official builds from artifacts.elastic.co with the bundled JDK (SHA-512)',
  async requirement() {
    return isWin ? notOnWindows('Elasticsearch') : null;
  },
  async builds() {
    if (isWin) throw new Error(notOnWindows('Elasticsearch'));
    return cached('elasticsearch', async () => {
      const tags: string[] = [];
      const pages = await Promise.all(
        [1, 2].map((page) =>
          json<{ tag_name: string; prerelease: boolean; draft: boolean }[]>(`https://api.github.com/repos/elastic/elasticsearch/releases?per_page=100&page=${page}`, {
            Accept: 'application/vnd.github+json',
          }).catch((e) => (page === 1 ? Promise.reject(e) : [])),
        ),
      );
      for (const rel of pages) for (const r of rel) if (!r.prerelease && !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name)) tags.push(r.tag_name.slice(1));
      // 7.17 is the last 7.x line with Apple silicon builds.
      const all = tags.filter((v) => Number(major(v)) >= 8 || minor(v) === '7.17').map((v) => ({ version: v }));
      return latestPer(all, major).map(({ version }) => ({
        version,
        label: major(version),
        source: 'download' as const,
        url: `https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-${version}-darwin-${ES_ARCH}.tar.gz`,
        algo: 'sha512' as const,
      }));
    });
  },
  installSteps: () => ['Finding the build', ...DOWNLOAD_STEPS],
  async install(b, dest, step, signal) {
    step('Finding the build', { detail: 'artifacts.elastic.co' });
    const sha = (await text(`${b.url}.sha512`)).trim().split(/\s+/)[0];
    if (!/^[a-f0-9]{128}$/.test(sha)) throw new Error('No SHA-512 published for this build');
    await fetchTarball({ ...b, hash: sha }, dest, step, signal);
    return dest;
  },
  async version(root) {
    // Starting the JVM for --version is slow; the core jar carries it.
    const jar = existsSync(join(root, 'lib')) ? readdirSync(join(root, 'lib')).find((f) => /^elasticsearch-\d+\.\d+\.\d+\.jar$/.test(f)) : undefined;
    return jar?.match(/(\d+\.\d+\.\d+)/)?.[1] ?? null;
  },
  async init(c, root, data) {
    mkdirSync(join(data, 'logs'), { recursive: true });
    // Own config folder per instance (ES_PATH_CONF), copied from the build; a chosen file becomes its elasticsearch.yml.
    const conf = esConf(c);
    if (!existsSync(conf)) cpSync(join(root, 'config'), conf, { recursive: true });
    if (c.configFile) cpSync(c.configFile, join(conf, 'elasticsearch.yml'));
    else if (!existsSync(join(conf, 'elasticsearch.yml'))) writeFileSync(join(conf, 'elasticsearch.yml'), '');
  },
  spec(c, root, data) {
    const e = (k: string, v: string | number) => ` -E ${k}=${q(String(v))}`;
    return {
      command:
        q(join(root, 'bin/elasticsearch')) +
        e('path.data', data) +
        e('path.logs', join(data, 'logs')) +
        e('http.port', c.port) +
        e('transport.port', c.port + 100) +
        e('network.host', '_local_') +
        e('discovery.type', 'single-node') +
        e('xpack.security.enabled', 'false') +
        e('cluster.name', `devcatz-${c.id}`),
      env: { ES_PATH_CONF: esConf(c), ES_JAVA_OPTS: '-Xms512m -Xmx512m' },
    };
  },
};

// ------------------------------------------------------------------ SQLite

/** Where SQLite's "build" lives: macOS' /usr; Windows has no sqlite3, DevCatz's own (node:sqlite) does the work. */
export const SQLITE_ROOT = isWin ? '' : '/usr';

const sqlite: EngineDef = {
  name: 'SQLite',
  description: 'File databases in a folder; no server to run.',
  defaultPort: 0,
  sourceNote: isWin ? 'Built into DevCatz; nothing to install' : 'The sqlite3 that ships with macOS',
  async builds() {
    const v = await sqlite.version(SQLITE_ROOT);
    return [{ version: v ?? 'system', label: isWin ? 'Built in' : 'macOS built-in', source: 'system' }];
  },
  installSteps: () => [],
  async install() {
    return SQLITE_ROOT;
  },
  async version(root) {
    if (isWin) {
      const db = new DatabaseSync(':memory:');
      try {
        return (db.prepare('SELECT sqlite_version() AS v').get() as { v: string }).v;
      } finally {
        db.close();
      }
    }
    const r = await run(join(root, 'bin/sqlite3'), ['--version'], { timeout: 10_000 });
    return r.stdout.match(/^([\d.]+)/)?.[1] ?? null;
  },
  async init(_c, _root, data) {
    mkdirSync(data, { recursive: true });
  },
};

export const DB_ENGINES: Record<DbEngine, EngineDef> = { mysql, mariadb, postgresql, redis, valkey, mongodb, elasticsearch, sqlite };
export const DB_ENGINE_ORDER: DbEngine[] = ['mysql', 'mariadb', 'postgresql', 'redis', 'valkey', 'mongodb', 'elasticsearch', 'sqlite'];
