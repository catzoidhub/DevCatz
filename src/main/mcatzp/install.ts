import { randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, renameSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McatzpInstallProgress, McatzpSetup } from '@shared/types';
import { downloadVerified } from '../download';
import { getShellEnv, run } from '../env';
import { brewBin } from '../php';
import { exe, isMac, isWin, pathKey, splitPath, TAR } from '../platform';
import { siteBase } from '../shared';

/**
 * Settings → MCatzP → Install MCatzP (MCatzP TODO #2, #24). One copy per computer, at a path client configs can keep:
 * ~/.catzoid/bin/mcatzp, %LOCALAPPDATA%\Catzoid\bin\mcatzp.exe. A copy from Homebrew or npm is used as it is, never a
 * second one next to it. The build comes through the site for this computer only, its sha256 checked before it is
 * unpacked, and it must answer --version before it takes its place.
 */
export const installPath = (): string =>
  isWin ? join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Catzoid', 'bin', 'mcatzp.exe') : join(homedir(), '.catzoid', 'bin', 'mcatzp');

/** The site's name for this computer; null when MCatzP has no build for it. */
function platformName(): 'mac-arm64' | 'mac-x64' | 'win-x64' | null {
  if (isMac) return process.arch === 'arm64' ? 'mac-arm64' : 'mac-x64';
  return isWin && process.arch === 'x64' ? 'win-x64' : null;
}

async function versionOf(path: string): Promise<string | null> {
  const { code, stdout } = await run(path, ['--version'], { timeout: 8000 }).catch(() => ({ code: 1, stdout: '' }));
  return code === 0 ? (stdout.trim().match(/^\d+\.\d+[\w.+-]*$/)?.[0] ?? null) : null;
}

/** The copy in use: ours first, then one on the shell's PATH or in Homebrew's folder. */
async function findInstalled(): Promise<Pick<McatzpSetup, 'path' | 'version' | 'source'>> {
  const ours = installPath();
  const env = getShellEnv();
  const brew = brewBin();
  const dirs = [...splitPath(env[pathKey(env)]), ...(brew ? [dirname(brew)] : [])];
  for (const path of [ours, ...dirs.map((d) => join(d, exe('mcatzp')))]) {
    if (!existsSync(path)) continue;
    const version = await versionOf(path);
    if (version) return { path, version, source: path === ours ? 'catzoid' : brew && dirname(path) === dirname(brew) ? 'homebrew' : 'other' };
  }
  return { path: null, version: null, source: null };
}

interface Latest {
  version: string;
  sha256: string;
}

/** What the site offers this computer; null when there is no build for it (404). */
async function latest(platform: string): Promise<Latest | null> {
  const res = await fetch(`${siteBase()}/api/mcatzp/latest?platform=${platform}`, { signal: AbortSignal.timeout(10_000), cache: 'no-store' });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`The site answered HTTP ${res.status}`);
  const body = (await res.json()) as Partial<Latest>;
  if (typeof body.version !== 'string' || typeof body.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(body.sha256)) throw new Error('The site gave no version or checksum for MCatzP');
  return { version: body.version, sha256: body.sha256.toLowerCase() };
}

export async function setupState(): Promise<McatzpSetup> {
  const found = await findInstalled();
  const platform = platformName();
  const base = { ...found, latest: null, noBuild: !platform, error: null };
  if (!platform) return base;
  try {
    const l = await latest(platform);
    return { ...base, latest: l?.version ?? null, noBuild: !l };
  } catch (e) {
    return { ...base, error: (e as Error).message };
  }
}

/** Downloads, checks and installs the build for this computer; replaces only a copy of ours. */
export async function install(progress: (p: McatzpInstallProgress) => void, signal: AbortSignal): Promise<void> {
  const platform = platformName();
  const l = platform ? await latest(platform) : null;
  if (!platform || !l) throw new Error('MCatzP has no build for this computer yet');
  const target = installPath();
  const tmp = join(dirname(target), `.install-${randomBytes(4).toString('hex')}`);
  mkdirSync(tmp, { recursive: true });
  try {
    const archive = join(tmp, 'mcatzp.zip');
    await downloadVerified(`${siteBase()}/download/mcatzp/${platform}`, archive, l.sha256, (received, total) => progress({ phase: 'download', received, total }), undefined, signal);
    progress({ phase: 'install', received: 0, total: 0 });
    const unpacked = join(tmp, 'out');
    mkdirSync(unpacked);
    const { code, stderr } = isWin ? await run(TAR, ['-xf', archive, '-C', unpacked], { timeout: 120_000 }) : await run('/usr/bin/ditto', ['-x', '-k', archive, unpacked], { timeout: 120_000 });
    if (code !== 0) throw new Error(`Could not unpack MCatzP: ${stderr.trim()}`);
    const built = join(unpacked, exe('mcatzp'));
    if (!existsSync(built) || !lstatSync(built).isFile()) throw new Error('The download holds no MCatzP program');
    if (!isWin) chmodSync(built, 0o755);
    if (!(await versionOf(built))) throw new Error('The downloaded MCatzP does not start on this computer');
    try {
      renameSync(built, target);
    } catch (e) {
      // Windows keeps a running .exe locked.
      if (isWin) throw new Error('MCatzP is in use: close the AI assistant using it, then try again');
      throw e;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
