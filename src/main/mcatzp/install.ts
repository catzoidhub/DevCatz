import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { McatzpInstallProgress, McatzpSetup, McatzpTarget } from '@shared/types';
import { stream } from '../database';
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

// stdout only: under Rosetta Bun warns about AVX on stderr, and the first start can take many seconds.
async function versionOf(path: string): Promise<string | null> {
  const { code, stdout } = await run(path, ['--version'], { timeout: 30_000 }).catch(() => ({ code: 1, stdout: '' }));
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

/** `askSite` false: what is on this computer, at once; the site can take seconds to answer, or never. */
export async function setupState(askSite = true): Promise<McatzpSetup> {
  const found = await findInstalled();
  const platform = platformName();
  const base = { ...found, latest: null, noBuild: !platform, error: null, checked: askSite };
  if (!platform || !askSite) return base;
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
    const version = await versionOf(built);
    if (!version) throw new Error('The downloaded MCatzP does not start on this computer');
    if (version !== l.version) throw new Error(`The download is MCatzP ${version}, not the ${l.version} the site offers`);
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

/**
 * Add to <client> (MCatzP TODO #14, group 1): a client's entry pointing at the copy in use. The path always comes from
 * what is found on this computer. An entry named mcatzp in any case is the same entry, so a client never lists two.
 */
const isEntry = (name: string) => name.toLowerCase() === 'mcatzp';
const entryOf = (servers: unknown): [string, { command?: string }] | null => {
  if (!servers || typeof servers !== 'object') return null;
  const hit = Object.entries(servers as Record<string, { command?: string }>).find(([k]) => isEntry(k));
  return hit ?? null;
};
const readJson = (file: string): Record<string, unknown> | null => {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
};
const claudeFile = () => join(homedir(), '.claude.json');
const zcodeDir = () => join(homedir(), '.zcode');
const zcodeFile = () => join(zcodeDir(), 'cli', 'config.json');
const quoted = (path: string) => `"${path}"`;

async function claudeCli(args: string): Promise<{ code: number; output: string }> {
  let output = '';
  const code = await stream(homedir(), `claude mcp ${args}`, (t) => (output += `${t}\n`));
  return { code, output: output.replace(/^\$ .*\n/, '').trim() };
}

const hasClaudeCli = () => {
  const env = getShellEnv();
  return splitPath(env[pathKey(env)]).some((d) => ['claude', 'claude.exe', 'claude.cmd'].some((n) => existsSync(join(d, n))));
};

export async function targets(): Promise<McatzpTarget[]> {
  const { path } = await findInstalled();
  const row = (id: McatzpTarget['id'], label: string, found: boolean, servers: unknown): McatzpTarget => {
    const entry = entryOf(servers);
    const command = entry ? (entry[1].command ?? '') : null;
    return { id, label, found, command, current: command !== null && !!path && command === path };
  };
  return [
    row('claude-code', 'Claude Code', hasClaudeCli(), readJson(claudeFile())?.mcpServers),
    row('zcode', 'ZCode', existsSync(zcodeDir()), (readJson(zcodeFile())?.mcp as { servers?: unknown } | undefined)?.servers),
  ];
}

/** ZCode's file with `change` applied to its servers: a copy of the old file beside it, written in one step. */
function editZcode(change: (servers: Record<string, unknown>) => void): void {
  const file = zcodeFile();
  const exists = existsSync(file);
  const conf = exists ? readJson(file) : {};
  // Never over a file that could not be read: what it holds would be lost.
  if (!conf) throw new Error(`Could not read ${file}: fix it or remove it, then try again`);
  const mcp = (conf.mcp ?? {}) as { servers?: Record<string, unknown> };
  const servers = mcp.servers ?? {};
  change(servers);
  conf.mcp = { ...mcp, servers };
  mkdirSync(dirname(file), { recursive: true });
  if (exists) copyFileSync(file, `${file}.bak`);
  const tmp = `${file}.${randomBytes(4).toString('hex')}`;
  writeFileSync(tmp, `${JSON.stringify(conf, null, 2)}\n`);
  renameSync(tmp, file);
}

/** Adds the entry, or points an existing one at the copy in use. */
export async function addToClient(id: McatzpTarget['id']): Promise<void> {
  const { path } = await findInstalled();
  if (!path) throw new Error('Install MCatzP first');
  if (id === 'zcode') {
    editZcode((servers) => {
      const name = entryOf(servers)?.[0] ?? 'mcatzp';
      servers[name] = { type: 'stdio', command: path, args: [], env: {} };
    });
    return;
  }
  const name = entryOf(readJson(claudeFile())?.mcpServers)?.[0];
  if (name) {
    const removed = await claudeCli(`remove --scope user ${quoted(name)}`);
    if (removed.code !== 0) throw new Error(removed.output || 'claude mcp remove failed');
  }
  const added = await claudeCli(`add --scope user ${quoted(name ?? 'mcatzp')} -- ${quoted(path)}`);
  if (added.code !== 0) throw new Error(added.output || 'claude mcp add failed');
}

export async function removeFromClient(id: McatzpTarget['id']): Promise<void> {
  if (id === 'zcode') {
    editZcode((servers) => {
      const name = entryOf(servers)?.[0];
      if (name) delete servers[name];
    });
    return;
  }
  const name = entryOf(readJson(claudeFile())?.mcpServers)?.[0];
  if (!name) return;
  const removed = await claudeCli(`remove --scope user ${quoted(name)}`);
  if (removed.code !== 0) throw new Error(removed.output || 'claude mcp remove failed');
}
