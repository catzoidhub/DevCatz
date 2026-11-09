import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { DbBinary, DbEngine, DbServiceConfig, TaskProgress } from '@shared/types';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { brewBin } from './php';
import { exe, isLinux, isWin, moveDir, removeTemp, TAR } from './platform';
import { runAsRootLinux } from './linuxadmin';
import { dataDir } from './store';
import { githubJson } from './github';

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
  /** More files that make up the build, unpacked with the first (MariaDB's .deb packages: server and client). */
  parts?: { url: string; hash: string }[];
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
  /** The page the builds come from (repository or download page), linked next to the note. */
  sourceUrl?: string;
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
  if (!res.ok) throw new Error(`${new URL(url).host}: HTTP ${res.status}`);
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

/** Downloads, verifies and unpacks a tarball into `dest` (its single top folder stripped; `exclude`: tar patterns left out). */
async function fetchTarball(b: RemoteBuild, dest: string, step: Step, signal: AbortSignal, exclude: string[] = []): Promise<void> {
  const tmp = `${dest}.partial`;
  removeTemp(tmp);
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
    const r = await run(TAR, ['-xf', archive, '-C', tmp, '--strip-components=1', ...exclude.flatMap((x) => ['--exclude', x])], { timeout: 600_000 });
    if (r.code !== 0) throw new Error(`Unpacking failed: ${r.stderr.trim()}`);
    check(signal);
    if (!isWin && !isLinux) await run('xattr', ['-dr', 'com.apple.quarantine', tmp]);
    rmSync(dest, { recursive: true, force: true });
    await moveDir(tmp, dest);
  } finally {
    rmSync(archive, { force: true });
    removeTemp(tmp);
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

/**
 * Linux: MySQL's generic build needs libaio and libnuma from the system. Ubuntu 24.04 renamed libaio to libaio1t64
 * (libaio.so.1t64), which mysqld does not look for: the package comes through the password dialog, and a
 * libaio.so.1 link goes into the build's own lib/private (on its RUNPATH), so nothing in the system changes.
 */
async function mysqlLinuxLibraries(root: string, step: Step): Promise<void> {
  return linuxLibraries('MySQL', binOf(root, 'mysqld'), root, step);
}

/**
 * Linux: the shared libraries a server binary lacks (`ldd` … not found), installed from the distribution's packages
 * behind the password dialog — libaio / libnuma (MySQL), liburing / libpcre2 … (MariaDB's .deb builds).
 */
async function linuxLibraries(name: string, bin: string, root: string, step: Step): Promise<void> {
  const missing = async () => {
    const r = await run('ldd', [bin], { timeout: 20_000 });
    return [...r.stdout.matchAll(/^\s*(\S+) => not found/gm)].map((m) => m[1]);
  };
  let libs = await missing();
  if (!libs.length) return;
  const triplet = `${arch ? 'aarch64' : 'x86_64'}-linux-gnu`;
  const libDir = [`/usr/lib/${triplet}`, `/lib/${triplet}`, '/usr/lib64', '/usr/lib'].find((d) => existsSync(d)) ?? '/usr/lib';
  const pkgs = new Set<string>();
  const APT: [RegExp, string][] = [
    [/^libaio/, 'libaio1t64 libaio1'],
    [/^libnuma/, 'libnuma1'],
    [/^liburing/, 'liburing2'],
    [/^libpcre2-8/, 'libpcre2-8-0'],
    [/^libsnappy/, 'libsnappy1v5'],
    [/^liblz4/, 'liblz4-1'],
    [/^libzstd/, 'libzstd1'],
    [/^libssl|^libcrypto/, 'libssl3t64 libssl3'],
    [/^libcrypt\./, 'libcrypt1'],
    [/^libsystemd/, 'libsystemd0'],
  ];
  for (const l of libs) for (const [re, p] of APT) if (re.test(l)) pkgs.add(p);
  if (pkgs.size && !(libs.every((l) => l.startsWith('libaio')) && existsSync(join(libDir, 'libaio.so.1t64')))) {
    step('Unpacking', { detail: `Installing ${[...pkgs].join(', ')} (password)` });
    // apt: whichever libaio the release has (t64 on Ubuntu 24.04+ / Debian 13, plain before); dnf: libaio / numactl-libs.
    await runAsRootLinux(
      `if command -v apt-get >/dev/null 2>&1; then for p in ${[...pkgs].join(' ')}; do DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "$p" >/dev/null 2>&1 || true; done; elif command -v dnf >/dev/null 2>&1; then dnf install -y -q libaio numactl-libs >/dev/null; fi`,
    );
  }
  if (libs.some((l) => l === 'libaio.so.1') && existsSync(join(libDir, 'libaio.so.1t64'))) {
    const priv = join(root, 'lib', 'private');
    mkdirSync(priv, { recursive: true });
    rmSync(join(priv, 'libaio.so.1'), { force: true });
    symlinkSync(join(libDir, 'libaio.so.1t64'), join(priv, 'libaio.so.1'));
  }
  libs = await missing();
  if (libs.length) throw new Error(`${name} needs ${libs.join(', ')} from your package manager (e.g. sudo apt install ${[...pkgs].map((p) => p.split(' ')[0]).join(' ') || 'the matching packages'})`);
}

const mysql: EngineDef = {
  name: 'MySQL',
  description: `Oracle’s MySQL Community Server; official ${isWin ? 'Windows' : isLinux ? 'Linux (glibc)' : 'macOS'} builds.`,
  defaultPort: 3306,
  sourceNote: isWin
    ? 'Official Windows x64 ZIP from cdn.mysql.com (MD5 from the CDN)'
    : isLinux
      ? 'Official Linux generic tarball (glibc 2.28) from cdn.mysql.com (MD5 from the CDN)'
      : 'Official macOS tarball from cdn.mysql.com (MD5 from the CDN)',
  sourceUrl: 'https://dev.mysql.com/downloads/mysql/',
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
    if (isLinux) {
      // The generic glibc 2.28 tarballs (.tar.xz): x86_64 has a -minimal one (~80 MB, no debug binaries); aarch64 only
      // the full one (~800 MB), whose test suite and debug build are left out when unpacking.
      const cpu = arch ? 'aarch64' : 'x86_64';
      step('Finding the build', { detail: `MySQL ${b.version} for Linux ${cpu}` });
      for (const file of [`mysql-${b.version}-linux-glibc2.28-${cpu}-minimal.tar.xz`, `mysql-${b.version}-linux-glibc2.28-${cpu}.tar.xz`]) {
        for (const url of [`https://cdn.mysql.com/Downloads/MySQL-${minor(b.version)}/${file}`, `https://cdn.mysql.com/archives/mysql-${minor(b.version)}/${file}`]) {
          const res = await fetch(url, { method: 'HEAD', signal }).catch(() => null);
          if (!res?.ok) continue;
          const md5 = res.headers.get('etag')?.match(/^"?([a-f0-9]{32})/)?.[1];
          await fetchTarball({ ...b, url, hash: md5, algo: 'md5' }, dest, step, signal, ['*/mysql-test', '*/bin/mysqld-debug', '*/lib/plugin/debug']);
          await mysqlLinuxLibraries(dest, step);
          return dest;
        }
      }
      throw new Error(`No Linux ${cpu} build of MySQL ${b.version} on cdn.mysql.com`);
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
/** MariaDB's own downloads: Windows x64 ZIPs, or the Linux x86_64 "systemd" bintars (no aarch64 bintar is published). */
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
      const zip = rel.files.find((f) => f.file_name === (isLinux ? `mariadb-${version}-linux-systemd-x86_64.tar.gz` : `mariadb-${version}-winx64.zip`));
      if (!zip) continue;
      const lts = /long term/i.test(line.release_support_type ?? '');
      out.push({ version, label: `${line.release_id}${lts ? ' LTS' : ''}`, source: 'download', url: zip.file_download_url.replace(/^http:/, 'https:'), hash: zip.checksum.sha256sum, algo: 'sha256' });
    }
  }
  if (!out.length) throw new Error('Could not read MariaDB versions (downloads.mariadb.org)');
  return out;
}

/**
 * Linux ARM64: MariaDB publishes no generic tarball, only packages in its own apt repository (mirror.mariadb.org) for
 * Ubuntu and Debian. DevCatz takes `mariadb-server-core` and `mariadb-client-core` from there (SHA-256 from the
 * repository's Packages index), unpacks them with dpkg-deb into its own folder and runs them from there like the
 * other builds: nothing is installed into the system, and a MariaDB of the distribution is left alone.
 */
const MARIADB_REPO = 'https://mirror.mariadb.org/repo';
const DEB_ARCH = arch ? 'arm64' : 'amd64';
function debDistro(): { os: 'ubuntu' | 'debian'; codename: string } | null {
  let txt = '';
  try {
    txt = readFileSync('/etc/os-release', 'utf8');
  } catch {
    return null;
  }
  const v = (k: string) => txt.match(new RegExp(`^${k}=["']?([^"'\n]*)`, 'm'))?.[1] ?? '';
  // Ubuntu and its derivatives (Mint, Pop!_OS …) name the Ubuntu release they follow.
  const ubuntu = v('UBUNTU_CODENAME') || (v('ID') === 'ubuntu' ? v('VERSION_CODENAME') : '');
  if (ubuntu) return { os: 'ubuntu', codename: ubuntu };
  if ((v('ID') === 'debian' || /\bdebian\b/.test(v('ID_LIKE'))) && v('VERSION_CODENAME')) return { os: 'debian', codename: v('VERSION_CODENAME') };
  return null;
}
/** `1:11.4.13+maria~ubu2404` → 11.4.13 */
const debUpstream = (v: string) => v.replace(/^\d+:/, '').replace(/[+~-].*$/, '');

async function mariadbDebBuilds(): Promise<RemoteBuild[]> {
  const d = debDistro();
  if (!d) throw new Error('MariaDB for this system comes from its apt repository, for Ubuntu and Debian only');
  const api = 'https://downloads.mariadb.org/rest-api/mariadb';
  const { major_releases } = await json<{ major_releases: MariaRelease[] }>(`${api}/`);
  const today = new Date().toISOString().slice(0, 10);
  const lines = major_releases.filter((r) => r.release_status === 'Stable' && (!r.release_eol_date || r.release_eol_date >= today));
  const pick = lines.filter((r, i) => i === 0 || /long term/i.test(r.release_support_type ?? ''));
  const out: RemoteBuild[] = [];
  for (const line of pick) {
    const base = `${MARIADB_REPO}/${line.release_id}/${d.os}`;
    const index = await text(`${base}/dists/${d.codename}/main/binary-${DEB_ARCH}/Packages`).catch(() => null);
    if (!index) continue; // this line has no packages for this release
    const newest = (pkg: string) =>
      index
        .split(/\n\n+/)
        .map((st) => ({
          name: st.match(/^Package: (.+)$/m)?.[1],
          version: debUpstream(st.match(/^Version: (.+)$/m)?.[1] ?? ''),
          file: st.match(/^Filename: (.+)$/m)?.[1],
          hash: st.match(/^SHA256: (.+)$/m)?.[1],
        }))
        .filter((p) => p.name === pkg && p.file && p.hash && /^\d+\.\d+\.\d+$/.test(p.version))
        .sort((a, b) => cmpVersion(a.version, b.version))[0];
    const server = newest('mariadb-server-core');
    const client = newest('mariadb-client-core');
    if (!server || !client || client.version !== server.version) continue;
    const lts = /long term/i.test(line.release_support_type ?? '');
    out.push({
      version: server.version,
      label: `${line.release_id}${lts ? ' LTS' : ''}`,
      source: 'download',
      url: `${base}/${server.file}`,
      hash: server.hash,
      algo: 'sha256',
      parts: [{ url: `${base}/${client.file}`, hash: client.hash! }],
    });
  }
  if (!out.length) throw new Error(`MariaDB's repository has no ${DEB_ARCH} packages for ${d.os} ${d.codename}`);
  return out;
}

/** Downloads the .deb files of a build, checks each SHA-256, unpacks their /usr into `dest` (bin, sbin, share). */
async function fetchDebs(b: RemoteBuild, dest: string, step: Step, signal: AbortSignal): Promise<void> {
  const tmp = `${dest}.partial`;
  removeTemp(tmp);
  mkdirSync(tmp, { recursive: true });
  try {
    const files = [{ url: b.url!, hash: b.hash! }, ...(b.parts ?? [])];
    for (const [i, f] of files.entries()) {
      const deb = join(tmp, `${i}.deb`);
      step('Downloading', { detail: f.url.split('/').pop(), received: 0, total: 0 });
      const digest = await downloadVerified(f.url, deb, '', (received, total) => step('Downloading', { received, total }), undefined, signal).catch((e) => {
        throw signal.aborted ? new Cancelled() : e;
      });
      check(signal);
      step('Verifying the checksum', { received: undefined, total: undefined, detail: `SHA-256 ${digest.slice(0, 16)}…` });
      if (digest !== f.hash.toLowerCase()) throw new Error(`Checksum mismatch for ${f.url.split('/').pop()}; download discarded`);
      step('Unpacking', { detail: f.url.split('/').pop() });
      const r = await run('dpkg-deb', ['-x', deb, join(tmp, 'root')], { timeout: 300_000 });
      if (r.code !== 0) throw new Error(`Unpacking ${f.url.split('/').pop()} failed: ${(r.stderr || r.stdout).trim() || 'dpkg-deb is missing'}`);
    }
    const usr = join(tmp, 'root', 'usr');
    if (!existsSync(join(usr, 'sbin', 'mariadbd'))) throw new Error('mariadbd was not found in the packages');
    // The server is in sbin; DevCatz looks for every program in bin.
    symlinkSync('../sbin/mariadbd', join(usr, 'bin', 'mariadbd'));
    rmSync(dest, { recursive: true, force: true });
    await moveDir(usr, dest);
  } finally {
    removeTemp(tmp);
  }
}

const mariadb: EngineDef = {
  name: 'MariaDB',
  description: 'Community fork of MySQL, drop-in for most apps.',
  defaultPort: 3306,
  sourceNote: isWin
    ? 'Official Windows x64 ZIP from downloads.mariadb.org (SHA-256)'
    : isLinux
      ? arch
        ? 'Official packages from MariaDB’s apt repository (mirror.mariadb.org, SHA-256), unpacked into DevCatz’s folder: nothing is installed into the system'
        : 'Official Linux x86_64 tarball from downloads.mariadb.org (SHA-256)'
      : 'Homebrew (MariaDB publishes no macOS builds); runs with DevCatz’s own data folder and port',
  sourceUrl: isWin || isLinux ? 'https://mariadb.org/download/' : 'https://formulae.brew.sh/formula/mariadb',
  async requirement() {
    if (isWin) return null;
    if (isLinux && arch) {
      if (!debDistro()) return 'MariaDB publishes no generic Linux ARM64 build, only packages for Ubuntu and Debian: install mariadb-server with your package manager, or use MySQL here.';
      if ((await run('/bin/sh', ['-c', 'command -v dpkg-deb'])).code !== 0) return 'Unpacking MariaDB’s packages needs dpkg-deb (the dpkg package).';
    }
    if (isLinux) return null;
    return brewBin() ? null : 'MariaDB comes from Homebrew. Install Homebrew from https://brew.sh first.';
  },
  async builds() {
    if (isWin) return cached('mariadb-win', mariadbWindowsBuilds);
    if (isLinux) return arch ? cached('mariadb-deb', mariadbDebBuilds) : cached('mariadb-linux', mariadbWindowsBuilds);
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
  installSteps: () => (isWin || isLinux ? DOWNLOAD_STEPS : ['Installing with Homebrew', 'Checking the version']),
  async install(b, dest, step, signal) {
    if (isLinux && b.parts) {
      await fetchDebs(b, dest, step, signal);
      await linuxLibraries('MariaDB', join(dest, 'sbin', 'mariadbd'), dest, step);
      return dest;
    }
    if (isWin || isLinux) {
      await fetchTarball(b, dest, step, signal);
      if (isLinux) await linuxLibraries('MariaDB', binOf(dest, 'mariadbd'), dest, step);
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
        // Windows: TCP only, and --console (the log goes to a file in the data folder otherwise); --skip-ssl because
        // MariaDB 11.4+ makes its own TLS certificate at start, which fails there (and 127.0.0.1 needs none).
        `${q(bin)} ${mysqlArgs(c, root, data)} --port=${c.port} --bind-address=${bind}${socket ? ` --socket=${q(socket)}` : ''}${isWin ? ' --console --skip-ssl' : ''} ` +
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

const PG_TRIPLE = isWin ? 'x86_64-pc-windows-msvc' : `${arch ? 'aarch64' : 'x86_64'}-${isLinux ? 'unknown-linux-gnu' : 'apple-darwin'}`;
export const psqlArgs = (c: DbServiceConfig, db = 'postgres') => ['-h', '127.0.0.1', '-p', String(c.port), '-U', c.user || 'root', '-d', db, '-v', 'ON_ERROR_STOP=1', '-X'];

/**
 * Windows: postgres.exe refuses to run with administrator rights (UAC off, or DevCatz run as administrator), and
 * `pg_ctl` is what drops them (a restricted token). So the managed process is a small PowerShell loop: `pg_ctl start`
 * (detached postgres, log to a file), then the log's new lines go to DevCatz's Logs until postmaster.pid is gone —
 * `pg_ctl stop` (the engine's shutdown) ends both. -EncodedCommand keeps cmd.exe's quoting out of it.
 */
function pgWindowsCommand(c: DbServiceConfig, root: string, data: string): string {
  const ps = (s: string) => `'${s.replace(/'/g, "''")}'`;
  const log = join(data, 'devcatz-postgres.log');
  const pid = join(data, 'postmaster.pid');
  const opts = `-p ${c.port} -c listen_addresses=127.0.0.1,::1${c.configFile ? ` -c config_file="${c.configFile}"` : ''}`;
  const script = [
    `$log = ${ps(log)}; $pidFile = ${ps(pid)}`,
    `$pos = if (Test-Path $log) { (Get-Item $log).Length } else { 0 }`,
    `& ${ps(binOf(root, 'pg_ctl'))} start -w -t 60 -D ${ps(data)} -l $log -o ${ps(opts)}`,
    `if ($LASTEXITCODE -ne 0) { if (Test-Path $log) { Get-Content $log -Tail 20 }; exit $LASTEXITCODE }`,
    `while ($true) {`,
    `  $fs = [IO.File]::Open($log, 'Open', 'Read', 'ReadWrite'); [void]$fs.Seek($pos, 'Begin'); $sr = New-Object IO.StreamReader($fs)`,
    `  $t = $sr.ReadToEnd(); $pos = $fs.Position; $sr.Close(); if ($t) { [Console]::Out.Write($t) }`,
    `  if (-not (Test-Path $pidFile)) { break }; Start-Sleep -Milliseconds 700`,
    `}`,
  ].join('\n');
  return `powershell.exe -NoProfile -NonInteractive -EncodedCommand ${Buffer.from(script, 'utf16le').toString('base64')}`;
}

const postgresql: EngineDef = {
  name: 'PostgreSQL',
  description: 'The advanced open-source SQL database.',
  defaultPort: 5432,
  sourceNote: 'Relocatable builds from github.com/theseus-rs/postgresql-binaries (SHA-256)',
  sourceUrl: 'https://github.com/theseus-rs/postgresql-binaries',
  async builds() {
    return cached('postgresql', async () => {
      const tags: string[] = [];
      // The three pages in parallel (each takes a few seconds: releases carry many assets).
      const pages = await Promise.all(
        [1, 2, 3].map((page) =>
          githubJson<{ tag_name: string; prerelease: boolean; assets: { name: string }[] }[]>(`/repos/theseus-rs/postgresql-binaries/releases?per_page=100&page=${page}`).catch((e) => (page === 1 ? Promise.reject(e) : [])),
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
    if (isWin) return { command: pgWindowsCommand(c, root, data), env: { LC_ALL: 'C' } };
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
  const rels = await githubJson<{ tag_name: string; prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; digest?: string | null }[] }[]>('/repos/redis-windows/redis-windows/releases?per_page=100');
  const all: RemoteBuild[] = [];
  for (const r of rels) {
    if (r.prerelease || r.draft || !/^\d+\.\d+\.\d+$/.test(r.tag_name) || Number(major(r.tag_name)) < minMajor) continue;
    const a = r.assets.find((x) => x.name === `Redis-${r.tag_name}-Windows-x64-msys2.zip`);
    if (a) all.push({ version: r.tag_name, label: minor(r.tag_name), source: 'download', url: a.browser_download_url, hash: a.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1], algo: 'sha256' });
  }
  return latestPer(all, minor);
}

/**
 * Windows: Valkey has no official build either (upstream turned native Windows support down);
 * github.com/SamuelMarks/valkey-windows compiles each official release with MSVC (Valkey-<v>-win64.zip with bin/,
 * SHA-256 from GitHub's asset digest). A community build — the install says so.
 */
async function valkeyWindowsBuilds(minMajor: number): Promise<RemoteBuild[]> {
  const rels = await githubJson<{ tag_name: string; prerelease: boolean; draft: boolean; assets: { name: string; browser_download_url: string; digest?: string | null }[] }[]>('/repos/SamuelMarks/valkey-windows/releases?per_page=100');
  const all: RemoteBuild[] = [];
  for (const r of rels) {
    if (r.prerelease || r.draft || !/^\d+\.\d+\.\d+$/.test(r.tag_name) || Number(major(r.tag_name)) < minMajor) continue;
    const a = r.assets.find((x) => x.name === `Valkey-${r.tag_name}-win64.zip`);
    const hash = a?.digest?.match(/^sha256:([a-f0-9]{64})$/)?.[1];
    // Only with a checksum: nothing unverified is unpacked.
    if (a && hash) all.push({ version: r.tag_name, label: minor(r.tag_name), source: 'download', url: a.browser_download_url, hash, algo: 'sha256' });
  }
  return latestPer(all, minor);
}

/**
 * Redis and its BSD fork Valkey: same build (plain `make`, no dependencies),
 * same flags; each publishes SHA-256s of its source tarballs in a *-hashes repo.
 */
function keyValue(o: { exe: 'redis' | 'valkey'; name: string; description: string; sourceNote: string; sourceUrl: string; hashes: string; minMajor: number }): EngineDef {
  const server = `bin/${exe(`${o.exe}-server`)}`;
  // Windows: neither publishes builds; both come from community projects (Redis: MSYS2, Valkey: MSVC).
  const winBuilds = true;
  const winSource =
    o.exe === 'redis'
      ? 'Community Windows build from github.com/redis-windows/redis-windows (MSYS2, SHA-256 from GitHub)'
      : 'Community Windows build from github.com/SamuelMarks/valkey-windows (the official source compiled with MSVC, SHA-256 from GitHub) — not published by the Valkey project';
  const def: EngineDef = {
    name: o.name,
    description: o.description,
    defaultPort: 6379,
    sourceNote: isWin ? winSource : o.sourceNote,
    sourceUrl: isWin ? (o.exe === 'redis' ? 'https://github.com/redis-windows/redis-windows' : 'https://github.com/SamuelMarks/valkey-windows') : o.sourceUrl,
    async requirement() {
      if (isWin) return winBuilds ? null : `${notOnWindows(o.name)} Use Redis instead: Valkey speaks the same protocol.`;
      // Linux: a C compiler and make (build-essential); macOS: the Xcode Command Line Tools.
      if (cltOk === null) cltOk = isLinux ? (await run('which', ['cc'])).code === 0 && (await run('which', ['make'])).code === 0 : (await run('xcode-select', ['-p'])).code === 0;
      if (cltOk) return null;
      return isLinux
        ? `${o.name} is compiled from source and needs a C compiler and make: run \`sudo apt install build-essential\` (Fedora: \`sudo dnf install gcc make\`) in a terminal.`
        : `${o.name} is compiled from source and needs the Xcode Command Line Tools: run \`xcode-select --install\` in Terminal.`;
    },
    async builds() {
      if (isWin) {
        if (!winBuilds) throw new Error(notOnWindows(o.name));
        return cached(`${o.exe}-win`, () => (o.exe === 'redis' ? redisWindowsBuilds(o.minMajor) : valkeyWindowsBuilds(o.minMajor)));
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
        // Redis' zip holds the .exe files and DLLs in one folder (unpacked as bin/); Valkey's has its own bin/ inside.
        if (!winBuilds) throw new Error(notOnWindows(o.name));
        mkdirSync(dest, { recursive: true });
        await fetchTarball(b, o.exe === 'redis' ? join(dest, 'bin') : dest, step, signal);
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

  sourceUrl: 'https://github.com/redis/redis',
  hashes: 'https://raw.githubusercontent.com/redis/redis-hashes/master/README',
  minMajor: 5,
});

const valkey = keyValue({
  exe: 'valkey',
  name: 'Valkey',
  description: 'Open-source (BSD) fork of Redis by the Linux Foundation; drop-in for Redis clients.',
  sourceNote: 'Official source from github.com/valkey-io/valkey (SHA-256 from valkey-hashes), compiled on this Mac',

  sourceUrl: 'https://github.com/valkey-io/valkey',
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
  sourceNote: isWin ? 'Official Community Server Windows x64 ZIP from fastdl.mongodb.org (SHA-256)' : 'Official Community Server builds from fastdl.mongodb.org (SHA-256)',
  sourceUrl: 'https://www.mongodb.com/try/download/community',
  async builds() {
    // Windows: the same release list; its `windows` x86_64 ZIPs (mongodb-win32-x86_64-windows-<v>/bin/mongod.exe).
    return cached(isWin ? 'mongodb-win' : isLinux ? 'mongodb-linux' : 'mongodb', async () => {
      const d = await json<{ versions: MongoRelease[] }>('https://downloads.mongodb.org/full.json');
      const all: RemoteBuild[] = [];
      // Linux builds are per distribution: ubuntu2404, debian12 … (from /etc/os-release), Ubuntu 22.04's as the fallback.
      const target = isWin ? 'windows' : isLinux ? linuxDistroTarget() : 'macos';
      const cpu = isWin ? 'x86_64' : arch ? (isLinux ? 'aarch64' : 'arm64') : 'x86_64';
      for (const v of d.versions) {
        if (!v.production_release || Number(major(v.version)) < 6) continue;
        const dl = v.downloads.find((x) => x.target === target && x.arch === cpu && (x.edition === 'base' || x.edition === 'targeted'));
        if (dl?.archive.sha256) all.push({ version: v.version, label: minor(v.version), source: 'download', url: dl.archive.url, hash: dl.archive.sha256, algo: 'sha256' });
      }
      return latestPer(all, minor);
    });
  },
  installSteps: () => DOWNLOAD_STEPS,
  async install(b, dest, step, signal) {
    // Windows: the debug symbols (*.pdb) are most of the ZIP and never needed.
    await fetchTarball(b, dest, step, signal, isWin ? ['*.pdb'] : []);
    return dest;
  },
  async version(root) {
    const r = await run(binOf(root, 'mongod'), ['--version'], { timeout: 15_000 });
    return r.stdout.match(/db version v([\d.]+)/)?.[1] ?? null;
  },
  async init(_c, _root, data) {
    mkdirSync(data, { recursive: true });
  },
  spec(c, root, data) {
    const conf = c.configFile ? `--config ${q(c.configFile)} ` : '';
    // Windows: TCP only (mongod there has no Unix socket to turn off).
    return { command: `${q(binOf(root, 'mongod'))} ${conf}--dbpath ${q(data)} --port ${c.port} --bind_ip 127.0.0.1,::1 --ipv6`, env: {} };
  },
  // Windows: no `mongod --shutdown` there and no mongosh downloaded (macOS has none either), so no shutdown():
  // DevCatz ends the process tree; the WiredTiger journal recovers on the next start.
};

/** MongoDB's Linux build target for this distribution (`ubuntu2404`, `debian12` …). */
function linuxDistroTarget(): string {
  const os = readFileSync('/etc/os-release', 'utf8');
  const id = os.match(/^ID=["']?([\w.-]+)/m)?.[1] ?? '';
  const ver = os.match(/^VERSION_ID=["']?([\d.]+)/m)?.[1] ?? '';
  if (id === 'ubuntu' && ver) return `ubuntu${ver.replace('.', '')}`;
  if (id === 'debian' && ver) return `debian${ver.split('.')[0]}`;
  return 'ubuntu2204';
}

// ------------------------------------------------------------------ Elasticsearch

/** The build's platform suffix: `darwin-aarch64.tar.gz`, `windows-x86_64.zip`. */
const ES_TARGET = isWin ? 'windows-x86_64.zip' : `${isLinux ? 'linux' : 'darwin'}-${arch ? 'aarch64' : 'x86_64'}.tar.gz`;
/** Per-instance ES_PATH_CONF, outside the data folder (Elasticsearch 9 refuses a config folder inside path.data). */
const esConf = (c: DbServiceConfig) => dataDir('db-services', 'config', c.id);
const elasticsearch: EngineDef = {
  name: 'Elasticsearch',
  description: 'Search and analytics engine (security off for local use).',
  defaultPort: 9200,
  sourceNote: isWin
    ? 'Official Windows x64 ZIP from artifacts.elastic.co with the bundled JDK (SHA-512)'
    : 'Official builds from artifacts.elastic.co with the bundled JDK (SHA-512)',
  sourceUrl: 'https://www.elastic.co/downloads/elasticsearch',
  async builds() {
    return cached(isWin ? 'elasticsearch-win' : isLinux ? 'elasticsearch-linux' : 'elasticsearch', async () => {
      const tags: string[] = [];
      const pages = await Promise.all(
        [1, 2].map((page) =>
          githubJson<{ tag_name: string; prerelease: boolean; draft: boolean }[]>(`/repos/elastic/elasticsearch/releases?per_page=100&page=${page}`).catch((e) => (page === 1 ? Promise.reject(e) : [])),
        ),
      );
      for (const rel of pages) for (const r of rel) if (!r.prerelease && !r.draft && /^v\d+\.\d+\.\d+$/.test(r.tag_name)) tags.push(r.tag_name.slice(1));
      // 7.17 is the last 7.x line with Apple silicon builds (kept on Windows too: same list everywhere).
      const all = tags.filter((v) => Number(major(v)) >= 8 || minor(v) === '7.17').map((v) => ({ version: v }));
      return latestPer(all, major).map(({ version }) => ({
        version,
        label: major(version),
        source: 'download' as const,
        url: `https://artifacts.elastic.co/downloads/elasticsearch/elasticsearch-${version}-${ES_TARGET}`,
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
      // Windows: bin\elasticsearch.bat, run through cmd.exe like every service command line.
      command:
        q(join(root, 'bin', isWin ? 'elasticsearch.bat' : 'elasticsearch')) +
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
  // Windows: no clean stop command; ending the tree (taskkill /T) takes the launcher's java child with it.
};

// ------------------------------------------------------------------ SQLite

/** Where SQLite's "build" lives: macOS' /usr; Windows has no sqlite3, DevCatz's own (node:sqlite) does the work. */
export const SQLITE_ROOT = isWin ? '' : '/usr';

const sqlite: EngineDef = {
  name: 'SQLite',
  description: 'File databases in a folder; no server to run.',
  defaultPort: 0,
  // Windows / Linux: Node's own SQLite inside DevCatz (a fresh Ubuntu has no sqlite3 program).
  sourceNote: isWin || isLinux ? 'Built into DevCatz; nothing to install' : 'The sqlite3 that ships with macOS',
  async builds() {
    const v = await sqlite.version(SQLITE_ROOT);
    return [{ version: v ?? 'system', label: isWin || isLinux ? 'Built in' : 'macOS built-in', source: 'system' }];
  },
  installSteps: () => [],
  async install() {
    return SQLITE_ROOT;
  },
  async version(root) {
    if (isWin || isLinux) {
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
