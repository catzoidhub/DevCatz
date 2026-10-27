import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { checksumFor, downloadVerified } from './download';
import type { InstalledNode, NodeInstallProgress, RemoteNode } from '@shared/types';
import { getShellEnv, run } from './env';
import { exe, isWin, pathKey, splitPath, TAR } from './platform';
import { dataDir } from './store';

/**
 * Node.js versions, managed the way Laravel Herd manages PHP/Node:
 * official builds from nodejs.org (SHA-256 verified) unpacked into
 * ~/Library/Application Support/DevCatz/node/<version>. Versions that
 * Laravel Herd's own nvm installed are picked up too (read-only).
 * On Windows the win-x64 zip is used; its binaries sit in the version
 * folder itself (no bin/).
 */
const DIST = 'https://nodejs.org/dist';
const ARCH = process.arch === 'arm64' ? 'arm64' : 'x64';
/** Build name on nodejs.org and the key index.json lists it under. */
const BUILD = isWin ? 'win-x64' : `darwin-${ARCH}`;
const INDEX_KEY = isWin ? 'win-x64-zip' : `osx-${ARCH}-tar`;
const EXT = isWin ? 'zip' : 'tar.gz';
/** Where a version's `node` lives: <version>/bin, or the version folder itself on Windows. */
const binOf = (versionDir: string) => (isWin ? versionDir : join(versionDir, 'bin'));
const HERD_NVM = join(homedir(), 'Library/Application Support/Herd/config/nvm/versions/node');

export const versionsDir = () => {
  const d = dataDir('node');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};

/** Folder whose `node`, `npm`, `npx`, `corepack` point at the default version. */
export const shimDir = () => dataDir('bin');

export function compare(a: string, b: string): number {
  const pa = a.replace(/^v/, '').split('.').map(Number);
  const pb = b.replace(/^v/, '').split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

const major = (v: string) => Number(v.replace(/^v/, '').split('.')[0]);

// ------------------------------------------------------------------ remote

let remoteCache: { at: number; list: RemoteNode[] } | null = null;

/** Latest release of every major ≥ 18, newest first, with LTS codenames. */
export async function listRemote(force = false): Promise<RemoteNode[]> {
  if (!force && remoteCache && Date.now() - remoteCache.at < 3600_000) return remoteCache.list;
  const res = await fetch(`${DIST}/index.json`);
  if (!res.ok) throw new Error(`nodejs.org: HTTP ${res.status}`);
  const all = (await res.json()) as { version: string; lts: string | false; date: string; files: string[] }[];
  const byMajor = new Map<number, RemoteNode>();
  for (const r of all) {
    const m = major(r.version);
    if (m < 18 || !r.files.includes(INDEX_KEY)) continue;
    const prev = byMajor.get(m);
    if (!prev || compare(r.version, prev.version) > 0) {
      byMajor.set(m, { version: r.version, major: m, lts: r.lts || null, date: r.date });
    }
  }
  const list = [...byMajor.values()].sort((a, b) => b.major - a.major);
  remoteCache = { at: Date.now(), list };
  return list;
}

// --------------------------------------------------------------- installed

export function listInstalled(): InstalledNode[] {
  const out: InstalledNode[] = [];
  const scan = (dir: string, source: InstalledNode['source']) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const v of entries) {
      if (/^v\d+\.\d+\.\d+$/.test(v) && existsSync(join(binOf(join(dir, v)), exe('node')))) {
        out.push({ version: v, major: major(v), source, binDir: binOf(join(dir, v)) });
      }
    }
  };
  scan(versionsDir(), 'mrcatz');
  scan(HERD_NVM, 'herd');
  // Prefer our copy when both have the same version.
  const unique = new Map<string, InstalledNode>();
  for (const n of out) if (!unique.has(n.version) || n.source === 'mrcatz') unique.set(n.version, n);
  return [...unique.values()].sort((a, b) => compare(b.version, a.version));
}

/** `node -v` of the login shell's own node (outside DevCatz). */
export async function systemNode(): Promise<string | null> {
  const { code, stdout } = await run('node', ['-v'], { timeout: 5000 });
  return code === 0 ? stdout.trim() : null;
}

// ---------------------------------------------------------------- install

export async function install(version: string, progress: (p: NodeInstallProgress) => void): Promise<void> {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(versionsDir(), version);
  if (existsSync(join(binOf(target), exe('node')))) return;
  const name = `node-${version}-${BUILD}`;
  const tmp = join(versionsDir(), `.tmp-${version}-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    // Checksum first, so a tampered or truncated download is never unpacked.
    const expected = await checksumFor(`${DIST}/${version}/SHASUMS256.txt`, `${name}.${EXT}`);
    const archive = join(tmp, `${name}.${EXT}`);
    let received = 0;
    let total = 0;
    await downloadVerified(`${DIST}/${version}/${name}.${EXT}`, archive, expected, (r, t) => {
      received = r;
      total = t;
      progress({ version, phase: 'download', received, total });
    });

    progress({ version, phase: 'extract', received, total });
    // Windows 10+ ships bsdtar as tar.exe, which unpacks the .zip too.
    const { code, stderr } = await run(TAR, [isWin ? '-xf' : '-xzf', archive, '-C', tmp], { timeout: 180_000 });
    if (code !== 0) throw new Error(`tar: ${stderr.trim()}`);
    renameSync(join(tmp, name), target);
    progress({ version, phase: 'done', received, total });
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function uninstall(version: string): void {
  if (!/^v\d+\.\d+\.\d+$/.test(version)) throw new Error(`Invalid version ${version}`);
  const target = join(versionsDir(), version);
  if (!existsSync(target)) throw new Error(`${version} is not managed by DevCatz`);
  rmSync(target, { recursive: true, force: true });
}

// -------------------------------------------------------------- resolution

/**
 * Picks an installed version for a project's `.nvmrc` / `engines.node` spec:
 * `20`, `v20.19.0`, `20.19`, `lts/*`, `lts/iron`, `node`, `>=20.19`, `^22`.
 * Returns null when nothing installed matches.
 */
export function resolveSpec(spec: string | null, installed: InstalledNode[], ltsNames: Map<number, string>): InstalledNode | null {
  if (!spec || !installed.length) return null;
  const s = spec.trim().toLowerCase();
  if (s === 'node' || s === 'latest' || s === 'current') return installed[0];
  if (s.startsWith('lts/')) {
    const codename = s.slice(4);
    return (
      installed.find((n) => {
        const name = ltsNames.get(n.major)?.toLowerCase();
        return name && (codename === '*' || name === codename);
      }) ?? null
    );
  }
  // Ranges: use the first comparator / version-ish token.
  const m = s.match(/(>=|\^|~|>)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  if (!m) return null;
  const [, op, maj, min, pat] = m;
  const want = `${maj}.${min ?? 0}.${pat ?? 0}`;
  const ok = (v: string) => {
    if (op === '>=') return compare(v, want) >= 0;
    if (op === '>') return compare(v, want) > 0;
    if (op === '^' || !min) return major(v) === Number(maj) && compare(v, want) >= 0;
    if (op === '~' || !pat) return v.replace(/^v/, '').startsWith(`${maj}.${min}.`) && compare(v, want) >= 0;
    return v === `v${maj}.${min}.${pat}`;
  };
  return installed.find((n) => ok(n.version)) ?? null;
}

// ------------------------------------------------------------------ shims

/** Points the shim folder at the default version (for terminals that add it to PATH). */
export function writeShims(defaultVersion: string | null): void {
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });
  const node = listInstalled().find((n) => n.version === defaultVersion);
  if (isWin) {
    // node.exe, and npm / npx / corepack as the .cmd files the zip ships.
    writeCmdShim(dir, 'node', node ? join(node.binDir, 'node.exe') : null);
    for (const bin of ['npm', 'npx', 'corepack']) writeCmdShim(dir, bin, node ? join(node.binDir, `${bin}.cmd`) : null);
    return;
  }
  for (const bin of ['node', 'npm', 'npx', 'corepack']) {
    const link = join(dir, bin);
    try {
      unlinkSync(link);
    } catch {
      /* not there */
    }
    if (node && existsSync(join(node.binDir, bin))) symlinkSync(join(node.binDir, bin), link);
  }
}

/** True when the user's interactive shell finds our shim `node` first. */
export function shimOnPath(): boolean {
  if (isWin) {
    const env = getShellEnv();
    const first = splitPath(env[pathKey(env)]).find((p) => existsSync(join(p, 'node.exe')) || existsSync(join(p, 'node.cmd')));
    return first !== undefined && first.replace(/[\\/]+$/, '').toLowerCase() === shimDir().toLowerCase();
  }
  const path = getShellEnv().PATH ?? '';
  const first = path.split(':').find((p) => existsSync(join(p, 'node')));
  return first !== undefined && first.replace(/\/$/, '') === shimDir();
}

/**
 * Windows shim: `<name>.cmd` in the shim folder that runs `target` with the
 * same arguments (symlinks need developer mode there). A `.cmd` target is
 * `call`ed so control comes back. Removed when `target` is null or missing.
 */
export function writeCmdShim(dir: string, name: string, target: string | null, extraArgs = ''): void {
  const file = join(dir, `${name}.cmd`);
  rmSync(file, { force: true });
  if (!target || !existsSync(target)) return;
  const call = target.toLowerCase().endsWith('.cmd') ? '@call ' : '@';
  writeFileSync(file, `${call}"${target}"${extraArgs ? ` ${extraArgs}` : ''} %*\r\n`);
}

/** Reads a project's requested Node version (`.nvmrc`, `.node-version`, `engines.node`). */
export function readNodeSpec(path: string): string | null {
  for (const f of ['.nvmrc', '.node-version']) {
    try {
      const v = readFileSync(join(path, f), 'utf8').trim();
      if (v) return v;
    } catch {
      /* none */
    }
  }
  try {
    return (JSON.parse(readFileSync(join(path, 'package.json'), 'utf8')).engines?.node as string) ?? null;
  } catch {
    return null;
  }
}
