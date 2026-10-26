import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import type { TaskProgress } from '@shared/types';

/**
 * Updates of the services DevCatz installs (object storage, WebSocket servers,
 * search engines): the newest release from the same place the installer uses,
 * compared with the installed version, and a binary swap that keeps the data
 * folder and settings and rolls back when the new build does not run.
 */

type Report = (p: Partial<TaskProgress>) => void;

/** Numbers of a version string (v1.2.3, RELEASE.2025-10-15T17-29-55Z, 1.0.0-beta3 …). */
const parts = (v: string) => (v.match(/\d+/g) ?? []).map(Number);

/** True when `latest` is a newer version than `current` (numeric parts, left to right). */
export function isNewer(latest: string | null | undefined, current: string | null | undefined): boolean {
  if (!latest || !current) return false;
  const a = parts(latest);
  const b = parts(current);
  if (!a.length || !b.length) return false;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x > y;
  }
  return false;
}

/** Newest non-prerelease tag of a GitHub repository (without a leading v); engines use the newest release with a macOS build instead (githubAsset). */
export async function githubLatest(repo: string): Promise<string> {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=10`, { headers: { Accept: 'application/vnd.github+json' } });
  if (!res.ok) throw new Error(`GitHub: HTTP ${res.status}`);
  const list = (await res.json()) as { tag_name: string; prerelease: boolean; draft: boolean }[];
  const tag = list.find((r) => !r.prerelease && !r.draft)?.tag_name;
  if (!tag) throw new Error(`No release in ${repo}`);
  return tag.replace(/^v/, '');
}

/** Stable version of a Homebrew formula (formulae.brew.sh). */
export async function brewLatest(formula: string): Promise<string> {
  const res = await fetch(`https://formulae.brew.sh/api/formula/${formula}.json`);
  if (!res.ok) throw new Error(`formulae.brew.sh: HTTP ${res.status}`);
  return ((await res.json()) as { versions: { stable: string } }).versions.stable;
}

/** Newest stable version of a Composer package (packagist.org). */
export async function packagistLatest(name: string): Promise<string> {
  const res = await fetch(`https://repo.packagist.org/p2/${name}.json`);
  if (!res.ok) throw new Error(`packagist.org: HTTP ${res.status}`);
  const list = ((await res.json()) as { packages: Record<string, { version: string }[]> }).packages[name] ?? [];
  const v = list.map((p) => p.version).find((x) => /^v?\d+\.\d+\.\d+$/.test(x));
  if (!v) throw new Error(`No stable release of ${name}`);
  return v.replace(/^v/, '');
}

/** The steps an update shows: the installer's first five (find, download, verify, unpack, place), then these. */
export const UPDATE_TAIL = ['Stopping the service', 'Replacing the binary', 'Checking the version', 'Starting again'];

export interface UpgradeOptions {
  /** Folder the binaries live in (only what the new install brings is replaced). */
  binDir: string;
  /** The engine's installer, run into a fresh folder. */
  install: (dir: string, report: Report, signal: AbortSignal) => Promise<void>;
  /** Update in place (the installer upgrades its own folder, e.g. Composer for Reverb). */
  inPlace?: boolean;
  stop: () => Promise<void>;
  start: () => Promise<void>;
  wasActive: boolean;
  version: () => Promise<string | null>;
  report: Report;
  signal: AbortSignal;
  /** Index of UPDATE_TAIL's first step in the task's steps. */
  tailAt: number;
}

/**
 * Downloads the new build next to the old one (checksums as for an install),
 * then stops the service, swaps the files, checks the version and starts it
 * again. If the new build does not run, the previous files are put back.
 */
export async function upgradeBinaries(o: UpgradeOptions): Promise<string> {
  const step = (i: number, detail?: string) => o.report({ step: o.tailAt + i, detail, received: undefined, total: undefined });
  if (o.inPlace) {
    step(0);
    await o.stop();
    await o.install(o.binDir, o.report, o.signal);
    step(2);
    const v = await o.version();
    if (!v) throw new Error('The updated service does not report a version');
    if (o.wasActive) {
      step(3);
      await o.start();
    }
    return v;
  }
  const stamp = Date.now();
  const fresh = `${o.binDir}.update-${stamp}`;
  const previous = `${o.binDir}.previous-${stamp}`;
  rmSync(fresh, { recursive: true, force: true });
  mkdirSync(fresh, { recursive: true });
  try {
    await o.install(fresh, o.report, o.signal);
    step(0);
    await o.stop();
    step(1, o.binDir);
    mkdirSync(previous, { recursive: true });
    const moved: string[] = [];
    for (const e of readdirSync(fresh)) {
      if (existsSync(`${o.binDir}/${e}`)) {
        renameSync(`${o.binDir}/${e}`, `${previous}/${e}`);
        moved.push(e);
      }
      renameSync(`${fresh}/${e}`, `${o.binDir}/${e}`);
    }
    step(2);
    const v = await o.version();
    if (!v) {
      // Put the old build back.
      for (const e of readdirSync(previous)) {
        rmSync(`${o.binDir}/${e}`, { recursive: true, force: true });
        renameSync(`${previous}/${e}`, `${o.binDir}/${e}`);
      }
      if (o.wasActive) await o.start().catch(() => undefined);
      throw new Error('The new build does not run on this Mac; the previous version was kept');
    }
    if (o.wasActive) {
      step(3);
      await o.start();
    }
    return v;
  } finally {
    rmSync(fresh, { recursive: true, force: true });
    rmSync(previous, { recursive: true, force: true });
  }
}
