import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { GoChoice, InstalledGo, RemoteGo, RuntimeInstallProgress } from '@shared/types';
import { downloadVerified } from './download';
import { run } from './env';
import { compare, shimDir, writeCmdShim } from './node';
import { exe, isWin, TAR } from './platform';
import { dataDir } from './store';

/**
 * Go toolchains, managed like Node.js and Bun: official builds from go.dev
 * (the release feed carries the SHA-256 of every archive) unpacked into
 * ~/Library/Application Support/DevCatz/go/<version>/go. A Go the user
 * installed themselves (Homebrew, /usr/local/go) is picked up too, read-only.
 * On Windows the windows-amd64 .zip, with go.exe in <version>/go/bin.
 */
const FEED = 'https://go.dev/dl/?mode=json&include=all';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'amd64';
const OS = isWin ? 'windows' : 'darwin';
const VERSION = /^\d+\.\d+(\.\d+)?$/;

export const goDir = () => {
  const d = dataDir('go');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};

interface FeedFile {
  filename: string;
  os: string;
  arch: string;
  sha256: string;
  size: number;
  kind: string;
}
let feedCache: { at: number; releases: { version: string; stable: boolean; files: FeedFile[] }[] } | null = null;

async function feed() {
  if (feedCache && Date.now() - feedCache.at < 3600_000) return feedCache.releases;
  const res = await fetch(FEED);
  if (!res.ok) throw new Error(`go.dev: HTTP ${res.status}`);
  feedCache = { at: Date.now(), releases: await res.json() };
  return feedCache.releases;
}

/** Newest patch of each of the last minor versions, newest first. */
export async function listRemote(force = false): Promise<RemoteGo[]> {
  if (force) feedCache = null;
  const byMinor = new Map<string, RemoteGo>();
  for (const r of await feed()) {
    if (!r.stable) continue;
    const version = r.version.replace(/^go/, '');
    if (!r.files.some((f) => f.os === OS && f.arch === ARCH && f.kind === 'archive')) continue;
    const minor = version.split('.').slice(0, 2).join('.');
    const prev = byMinor.get(minor);
    if (!prev || compare(version, prev.version) > 0) byMinor.set(minor, { version, minor });
  }
  return [...byMinor.values()].sort((a, b) => compare(b.version, a.version)).slice(0, 8);
}

/** Toolchains DevCatz installed, plus the user's own one (if any). */
export async function listInstalled(): Promise<InstalledGo[]> {
  const out: InstalledGo[] = [];
  try {
    for (const v of readdirSync(goDir())) {
      if (VERSION.test(v) && existsSync(join(goDir(), v, 'go', 'bin', exe('go')))) out.push({ version: v, source: 'mrcatz', binDir: join(goDir(), v, 'go/bin') });
    }
  } catch {
    /* none yet */
  }
  const candidates = isWin
    ? [join(process.env.ProgramFiles || 'C:\\Program Files', 'Go', 'bin', 'go.exe')]
    : ['/opt/homebrew/bin/go', '/usr/local/go/bin/go', '/usr/local/bin/go'];
  if (isWin) {
    // `where` lists every match; the first real go.exe outside our shim folder.
    const { code, stdout } = await run('where', ['go'], { timeout: 3000 });
    const found = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l) && !l.toLowerCase().startsWith(shimDir().toLowerCase()));
    if (code === 0 && found) candidates.unshift(found);
  } else {
    const { code, stdout } = await run('which', ['go'], { timeout: 3000 });
    if (code === 0 && stdout.trim() && !stdout.trim().startsWith(shimDir())) candidates.unshift(stdout.trim());
  }
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    const v = await run(bin, ['env', 'GOVERSION'], { timeout: 5000 });
    const version = v.stdout.trim().replace(/^go/, '');
    if (v.code === 0 && VERSION.test(version) && !out.some((o) => o.version === version)) {
      out.push({ version, source: 'system', binDir: isWin ? dirname(bin) : bin.replace(/\/go$/, '') });
      break;
    }
  }
  return out.sort((a, b) => compare(b.version, a.version));
}

export async function install(version: string, progress: (p: RuntimeInstallProgress) => void): Promise<void> {
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(goDir(), version);
  if (existsSync(join(target, 'go', 'bin', exe('go')))) return;
  const release = (await feed()).find((r) => r.version === `go${version}`);
  const file = release?.files.find((f) => f.os === OS && f.arch === ARCH && f.kind === 'archive');
  if (!file) throw new Error(`No ${isWin ? 'Windows' : 'macOS'} ${ARCH} build of Go ${version}`);
  const tmp = join(goDir(), `.tmp-${version}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, file.filename);
    let received = 0;
    let total = file.size;
    await downloadVerified(`https://go.dev/dl/${file.filename}`, archive, file.sha256, (r, t) => {
      received = r;
      total = t || file.size;
      progress({ version, phase: 'download', received, total });
    });
    progress({ version, phase: 'extract', received, total });
    // Windows 10+ ships bsdtar as tar.exe, which unpacks the .zip too.
    const { code, stderr } = await run(TAR, [isWin ? '-xf' : '-xzf', archive, '-C', tmp], { timeout: 300_000 });
    if (code !== 0) throw new Error(`tar: ${stderr.trim()}`);
    mkdirSync(target, { recursive: true });
    renameSync(join(tmp, 'go'), join(target, 'go'));
    progress({ version, phase: 'done', received, total });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function uninstall(version: string): void {
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(goDir(), version);
  if (!existsSync(target)) throw new Error(`Go ${version} is not managed by DevCatz`);
  rmSync(target, { recursive: true, force: true });
}

/** Points the `go`/`gofmt` shims at the default toolchain. */
export function writeShims(defaultBin: string | null): void {
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });
  if (isWin) {
    for (const name of ['go', 'gofmt']) writeCmdShim(dir, name, defaultBin ? join(defaultBin, `${name}.exe`) : null);
    return;
  }
  for (const name of ['go', 'gofmt']) {
    const link = join(dir, name);
    try {
      unlinkSync(link);
    } catch {
      /* not there */
    }
    if (defaultBin && existsSync(join(defaultBin, name))) symlinkSync(join(defaultBin, name), link);
  }
}

/** `go 1.24` / `toolchain go1.24.3` from a go.mod. */
export function readGoSpec(goModDir: string): string | null {
  try {
    const mod = readFileSync(join(goModDir, 'go.mod'), 'utf8');
    return mod.match(/^toolchain\s+go(\S+)/m)?.[1] ?? mod.match(/^go\s+(\S+)/m)?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Picks the toolchain for a module: the newest installed one that is at
 * least the go.mod version (Go is backwards compatible), else the default.
 */
export function chooseGo(spec: string | null, installed: InstalledGo[], defaultVersion: string | null): GoChoice {
  const want = spec ? (spec.split('.').length === 2 ? `${spec}.0` : spec) : null;
  const ok = (v: string) => !want || compare(v, want) >= 0;
  const def = installed.find((g) => g.version === defaultVersion && ok(g.version));
  const pick = def ?? installed.find((g) => ok(g.version));
  if (pick) return { version: pick.version, binDir: pick.binDir, reason: pick === def ? 'default' : spec ? 'project' : pick.source === 'system' ? 'system' : 'default', spec, missing: false };
  const fallback = installed[0];
  return fallback
    ? { version: fallback.version, binDir: fallback.binDir, reason: 'system', spec, missing: true }
    : { version: null, binDir: null, reason: 'none', spec, missing: true };
}
