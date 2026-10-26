import { chmodSync, existsSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { InstalledPython, PythonChoice, RemotePython, RuntimeInstallProgress } from '@shared/types';
import { downloadVerified } from './download';
import { getShellEnv, run } from './env';
import { compare } from './node';
import { dataDir } from './store';

/**
 * Python, through Astral's **uv**: DevCatz downloads uv itself (GitHub
 * release, SHA-256 checked), and uv installs CPython builds
 * (python-build-standalone) into DevCatz's data folder, creates each site's
 * `.venv` and installs its dependencies. Pythons the user has (Homebrew,
 * python.org, pyenv) are listed read-only, like Go and Node.
 */
export const pythonDir = () => {
  const d = dataDir('python');
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  return d;
};
const uvDir = () => join(pythonDir(), 'bin');
const versionsDir = () => join(pythonDir(), 'versions');

/** uv on PATH, DevCatz's copy first. */
export function uvPath(): string | null {
  const own = join(uvDir(), 'uv');
  if (existsSync(own)) return own;
  return null;
}

/** Environment for uv: Pythons go to DevCatz's folder, never a global one. */
export function uvEnv(): Record<string, string> {
  return {
    UV_PYTHON_INSTALL_DIR: versionsDir(),
    UV_PYTHON_PREFERENCE: 'managed',
    // Pythons uv installed are not put on PATH as python3.x shims.
    UV_PYTHON_INSTALL_BIN: '0',
    PATH: `${uvDir()}:${getShellEnv().PATH ?? ''}`,
  };
}

async function uv(args: string[], timeout = 120_000) {
  const bin = uvPath();
  if (!bin) throw new Error('uv is not installed: install it on the Python page (sidebar)');
  return run(bin, args, { timeout, env: uvEnv() });
}

export async function uvVersion(): Promise<string | null> {
  if (!uvPath()) return null;
  const r = await uv(['--version'], 10_000).catch(() => null);
  return r?.stdout.match(/uv ([\d.]+)/)?.[1] ?? null;
}

/** Downloads uv (and uvx) from its latest GitHub release, checksum-verified. */
export async function installUv(progress: (p: RuntimeInstallProgress) => void): Promise<string> {
  const triple = process.arch === 'arm64' ? 'aarch64-apple-darwin' : 'x86_64-apple-darwin';
  const res = await fetch('https://api.github.com/repos/astral-sh/uv/releases/latest', { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const rel = (await res.json()) as { tag_name: string; assets: { name: string; browser_download_url: string; digest?: string }[] };
  const asset = rel.assets.find((a) => a.name === `uv-${triple}.tar.gz`);
  if (!asset?.digest?.startsWith('sha256:')) throw new Error('No uv build with a checksum for this Mac');
  const tmp = join(pythonDir(), `.uv-${Date.now()}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, 'uv.tar.gz');
    progress({ version: `uv ${rel.tag_name}`, phase: 'download', received: 0, total: 0 });
    await downloadVerified(asset.browser_download_url, archive, asset.digest.slice(7), (received, total) =>
      progress({ version: `uv ${rel.tag_name}`, phase: 'download', received, total }),
    );
    progress({ version: `uv ${rel.tag_name}`, phase: 'extract', received: 0, total: 0 });
    const r = await run('tar', ['-xzf', archive, '-C', tmp, '--strip-components=1']);
    if (r.code !== 0) throw new Error(`Unpacking uv failed: ${r.stderr.trim()}`);
    mkdirSync(uvDir(), { recursive: true });
    for (const exe of ['uv', 'uvx']) {
      if (!existsSync(join(tmp, exe))) continue;
      rmSync(join(uvDir(), exe), { force: true });
      renameSync(join(tmp, exe), join(uvDir(), exe));
      chmodSync(join(uvDir(), exe), 0o755);
    }
    await run('xattr', ['-dr', 'com.apple.quarantine', uvDir()]);
    progress({ version: `uv ${rel.tag_name}`, phase: 'done', received: 0, total: 0 });
    return rel.tag_name;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface UvPython {
  key: string;
  version: string;
  path: string | null;
  implementation: string;
  variant?: string;
}

async function uvList(args: string[]): Promise<UvPython[]> {
  const r = await uv(['python', 'list', '--output-format', 'json', ...args], 60_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || 'uv python list failed');
  return (JSON.parse(r.stdout) as UvPython[]).filter((p) => p.implementation === 'cpython' && (!p.variant || p.variant === 'default'));
}

/** Installed Pythons: DevCatz's (uv-managed, in its folder) and the user's own (read-only). */
export async function listInstalled(): Promise<InstalledPython[]> {
  if (!uvPath()) return [];
  const out: InstalledPython[] = [];
  for (const p of await uvList(['--only-installed']).catch(() => [])) {
    if (!p.path) continue;
    const managed = p.path.startsWith(versionsDir());
    if (out.some((o) => o.version === p.version)) continue;
    out.push({ version: p.version, source: managed ? 'mrcatz' : 'system', binDir: join(p.path, '..'), path: p.path });
  }
  return out.sort((a, b) => compare(b.version, a.version));
}

/** Newest patch per minor that uv can download (3.9 and up). */
export async function listRemote(): Promise<RemotePython[]> {
  const list = await uvList(['--only-downloads']);
  const byMinor = new Map<string, RemotePython>();
  for (const p of list) {
    if (!/^\d+\.\d+\.\d+$/.test(p.version)) continue;
    const minor = p.version.split('.').slice(0, 2).join('.');
    if (Number(minor.split('.')[1]) < 9 && minor.startsWith('3.')) continue;
    const prev = byMinor.get(minor);
    if (!prev || compare(p.version, prev.version) > 0) byMinor.set(minor, { version: p.version, minor });
  }
  return [...byMinor.values()].sort((a, b) => compare(b.version, a.version)).slice(0, 8);
}

export async function install(version: string, progress: (p: RuntimeInstallProgress) => void): Promise<void> {
  progress({ version, phase: 'download', received: 0, total: 0, detail: `uv python install ${version}` });
  const r = await uv(['python', 'install', version], 600_000);
  if (r.code !== 0) throw new Error(`uv python install ${version} failed: ${(r.stderr || r.stdout).trim().split('\n').slice(-3).join(' ')}`);
  progress({ version, phase: 'done', received: 0, total: 0 });
}

export async function uninstall(version: string): Promise<void> {
  const r = await uv(['python', 'uninstall', version], 120_000);
  if (r.code !== 0) throw new Error(`uv python uninstall ${version} failed: ${r.stderr.trim()}`);
}

/**
 * The Python a site's venv is created with: the site's choice, else what the
 * project asks for (.python-version / requires-python) when installed, else
 * the default, else the newest installed.
 */
export function choosePython(spec: string | null, pinned: string | undefined, all: InstalledPython[], def: string | null): PythonChoice {
  // DevCatz's own Pythons first: a Homebrew upgrade would break a venv made from the system one.
  const installed = [...all.filter((i) => i.source === 'mrcatz'), ...all.filter((i) => i.source !== 'mrcatz')];
  if (pinned) return { version: pinned, reason: 'site', spec, missing: !installed.some((i) => i.version === pinned) };
  if (spec) {
    const match = installed.find((i) => satisfies(i.version, spec));
    if (match) return { version: match.version, reason: 'project', spec, missing: false };
  }
  if (def && installed.some((i) => i.version === def)) return { version: def, reason: 'default', spec, missing: Boolean(spec) };
  if (installed[0]) return { version: installed[0].version, reason: 'newest', spec, missing: Boolean(spec) };
  return { version: null, reason: 'none', spec, missing: true };
}

/** `3.12`, `3.12.4`, `>=3.10`, `>=3.10,<3.13`, `~=3.11`, `^3.11` (Poetry). */
export function satisfies(version: string, spec: string): boolean {
  const v = version.split('.').map(Number);
  const cmp = (a: number[], b: number[]) => {
    for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) - (b[i] ?? 0);
    return 0;
  };
  return spec.split(',').every((part) => {
    const m = part.trim().match(/^(==|>=|<=|>|<|~=|\^|!=)?\s*([\d.]+)\*?$/);
    if (!m) return true;
    const want = m[2].split('.').map(Number);
    const op = m[1] ?? '==';
    const prefix = cmp(v.slice(0, want.length), want);
    switch (op) {
      case '==':
        return prefix === 0;
      case '!=':
        return prefix !== 0;
      case '>=':
        return cmp(v, want) >= 0;
      case '<=':
        return cmp(v, want) <= 0;
      case '>':
        return cmp(v, want) > 0;
      case '<':
        return cmp(v, want) < 0;
      case '~=':
        return cmp(v, want) >= 0 && cmp(v.slice(0, want.length - 1), want.slice(0, -1)) === 0;
      case '^':
        return cmp(v, want) >= 0 && v[0] === want[0];
      default:
        return true;
    }
  });
}
