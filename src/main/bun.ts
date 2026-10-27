import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { BunChoice, InstalledBun, RemoteBun, RuntimeInstallProgress } from '@shared/types';
import { checksumFor, downloadVerified } from './download';
import { run } from './env';
import { compare, shimDir, writeCmdShim } from './node';
import { exe, isWin, TAR } from './platform';
import { dataDir } from './store';

/**
 * Bun versions, managed like Node.js: official GitHub release builds
 * (SHA-256 verified against the release's SHASUMS256.txt) unpacked into
 * ~/Library/Application Support/DevCatz/bun/<version>/bun. A Bun the user
 * installed themselves (~/.bun/bin, Homebrew) is picked up too, read-only.
 * On Windows: bun-windows-x64.zip, bun.exe with a bunx.exe copy beside it.
 */
const RELEASES = 'https://api.github.com/repos/oven-sh/bun/releases?per_page=30';
const ASSET = isWin ? 'bun-windows-x64' : `bun-darwin-${process.arch === 'arm64' ? 'aarch64' : 'x64'}`;

export const bunDir = () => {
  const d = dataDir('bun');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};

const VERSION = /^\d+\.\d+\.\d+$/;

let remoteCache: { at: number; list: RemoteBun[] } | null = null;

/** Recent stable releases, newest first. */
export async function listRemote(force = false): Promise<RemoteBun[]> {
  if (!force && remoteCache && Date.now() - remoteCache.at < 3600_000) return remoteCache.list;
  const res = await fetch(RELEASES, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}${res.status === 403 ? ' (rate limit, try again later)' : ''}`);
  const releases = (await res.json()) as { tag_name: string; published_at: string; prerelease: boolean; draft: boolean; assets: { name: string }[] }[];
  const list = releases
    .filter((r) => !r.prerelease && !r.draft && /^bun-v\d+\.\d+\.\d+$/.test(r.tag_name) && r.assets.some((a) => a.name === `${ASSET}.zip`))
    .map((r) => ({ version: r.tag_name.slice(5), date: r.published_at.slice(0, 10) }))
    .sort((a, b) => compare(b.version, a.version));
  remoteCache = { at: Date.now(), list };
  return list;
}

/** Bun builds DevCatz installed, plus the user's own one (if any). */
export async function listInstalled(): Promise<InstalledBun[]> {
  const out: InstalledBun[] = [];
  try {
    for (const v of readdirSync(bunDir())) {
      if (VERSION.test(v) && existsSync(join(bunDir(), v, exe('bun')))) out.push({ version: v, source: 'mrcatz', binDir: join(bunDir(), v) });
    }
  } catch {
    /* none yet */
  }
  // The user's own Bun: ~/.bun/bin (official installer) or whatever the login shell finds.
  const candidates = isWin ? [join(homedir(), '.bun', 'bin', 'bun.exe')] : [join(homedir(), '.bun/bin/bun'), '/opt/homebrew/bin/bun', '/usr/local/bin/bun'];
  if (isWin) {
    // `where` lists every match; the first real bun.exe outside our shim folder.
    const { code, stdout } = await run('where', ['bun'], { timeout: 3000 });
    const found = stdout.split(/\r?\n/).map((l) => l.trim()).find((l) => /\.exe$/i.test(l) && !l.toLowerCase().startsWith(shimDir().toLowerCase()));
    if (code === 0 && found) candidates.unshift(found);
  } else {
    const { code, stdout } = await run('which', ['bun'], { timeout: 3000 });
    if (code === 0 && stdout.trim() && !stdout.trim().startsWith(shimDir())) candidates.unshift(stdout.trim());
  }
  for (const bin of candidates) {
    if (!existsSync(bin)) continue;
    const v = await run(bin, ['--version'], { timeout: 5000 });
    const version = v.stdout.trim();
    if (v.code === 0 && VERSION.test(version) && !out.some((o) => o.version === version)) {
      out.push({ version, source: 'system', binDir: isWin ? dirname(bin) : bin.replace(/\/bun$/, '') });
      break;
    }
  }
  return out.sort((a, b) => compare(b.version, a.version));
}

export async function install(version: string, progress: (p: RuntimeInstallProgress) => void): Promise<void> {
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(bunDir(), version);
  if (existsSync(join(target, exe('bun')))) return;
  const base = `https://github.com/oven-sh/bun/releases/download/bun-v${version}`;
  const tmp = join(bunDir(), `.tmp-${version}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const expected = await checksumFor(`${base}/SHASUMS256.txt`, `${ASSET}.zip`);
    const archive = join(tmp, `${ASSET}.zip`);
    let received = 0;
    let total = 0;
    await downloadVerified(`${base}/${ASSET}.zip`, archive, expected, (r, t) => {
      received = r;
      total = t;
      progress({ version, phase: 'download', received, total });
    });
    progress({ version, phase: 'extract', received, total });
    // Windows 10+ ships bsdtar as tar.exe, which unpacks zips (no ditto there).
    const { code, stderr } = isWin
      ? await run(TAR, ['-xf', archive, '-C', tmp], { timeout: 120_000 })
      : await run('/usr/bin/ditto', ['-x', '-k', archive, tmp], { timeout: 120_000 });
    if (code !== 0) throw new Error(`unzip: ${stderr.trim()}`);
    mkdirSync(target, { recursive: true });
    renameSync(join(tmp, ASSET, exe('bun')), join(target, exe('bun')));
    // `bunx` is the same binary under another name, as the official installer does (a copy on Windows: no symlinks).
    if (isWin) copyFileSync(join(target, 'bun.exe'), join(target, 'bunx.exe'));
    else symlinkSync('bun', join(target, 'bunx'));
    const check = await run(join(target, exe('bun')), ['--version'], { timeout: 10_000 });
    if (check.stdout.trim() !== version) {
      rmSync(target, { recursive: true, force: true });
      throw new Error(`Installed binary reports ${check.stdout.trim() || check.stderr.trim()}`);
    }
    progress({ version, phase: 'done', received, total });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function uninstall(version: string): void {
  if (!VERSION.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(bunDir(), version);
  if (!existsSync(target)) throw new Error(`Bun ${version} is not managed by DevCatz`);
  rmSync(target, { recursive: true, force: true });
}

/** Points the `bun`/`bunx` shims at the default version. */
export function writeShims(defaultBin: string | null): void {
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });
  if (isWin) {
    const bun = defaultBin ? join(defaultBin, 'bun.exe') : null;
    writeCmdShim(dir, 'bun', bun);
    // A bunx.exe when the folder has one (ours does), else `bun x`.
    if (defaultBin && existsSync(join(defaultBin, 'bunx.exe'))) writeCmdShim(dir, 'bunx', join(defaultBin, 'bunx.exe'));
    else writeCmdShim(dir, 'bunx', bun, 'x');
    return;
  }
  for (const name of ['bun', 'bunx']) {
    const link = join(dir, name);
    try {
      unlinkSync(link);
    } catch {
      /* not there */
    }
    if (defaultBin && existsSync(join(defaultBin, 'bun'))) symlinkSync(join(defaultBin, 'bun'), link);
  }
}

/** The project's wish: `"packageManager": "bun@1.3.3"` or `engines.bun`. */
export function readBunSpec(path: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'));
    const pm = typeof pkg.packageManager === 'string' && pkg.packageManager.startsWith('bun@') ? pkg.packageManager.slice(4).split('+')[0] : null;
    return pm ?? pkg.engines?.bun ?? null;
  } catch {
    return null;
  }
}

/**
 * Picks the Bun for a project: the exact `packageManager` version when
 * installed, else the newest installed one satisfying `>=x.y.z` / `^x.y`,
 * else the default, else the user's own.
 */
export function chooseBun(spec: string | null, installed: InstalledBun[], defaultVersion: string | null): BunChoice {
  const byVersion = (v: string | null) => installed.find((b) => b.version === v);
  if (spec) {
    const exact = byVersion(spec.replace(/^[v=]/, ''));
    if (exact) return { version: exact.version, binDir: exact.binDir, reason: 'project', spec, missing: false };
    const m = spec.match(/(>=|\^|~)?\s*v?(\d+)\.(\d+)(?:\.(\d+))?/);
    if (m) {
      const want = `${m[2]}.${m[3]}.${m[4] ?? 0}`;
      const ok = installed.find((b) => {
        if (compare(b.version, want) < 0) return false;
        if (m[1] === '^') return b.version.split('.')[0] === m[2];
        if (m[1] === '~') return b.version.startsWith(`${m[2]}.${m[3]}.`);
        return true;
      });
      if (ok && m[1]) return { version: ok.version, binDir: ok.binDir, reason: 'project', spec, missing: false };
    }
  }
  const def = byVersion(defaultVersion) ?? installed.find((b) => b.source === 'system') ?? installed[0];
  const exactWanted = Boolean(spec && /^\d+\.\d+\.\d+$/.test(spec.replace(/^[v=]/, '')));
  return def
    ? { version: def.version, binDir: def.binDir, reason: def.version === defaultVersion ? 'default' : 'system', spec, missing: exactWanted }
    : { version: null, binDir: null, reason: 'none', spec, missing: true };
}
