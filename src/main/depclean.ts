import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import type { DepFolder, ProjectConfig, StackInfo } from '@shared/types';
import { run } from './env';

/**
 * Free disk space (TODO §30): the dependency folders of a site — node_modules (every app and package of a
 * monorepo), Composer's vendor/, a Python venv — that can be thrown away and installed again with
 * "Install dependencies". Only real folders inside the project count: never a symlink, never outside it.
 */

const VENVS = ['.venv', 'venv', 'env'];

/** The folders a site's dependencies live in, largest first once measured. */
export function depFolders(p: ProjectConfig, stack: StackInfo | undefined): { abs: string; rel: string; kind: DepFolder['kind'] }[] {
  const roots = new Set<string>([p.path]);
  for (const a of stack?.apps ?? []) roots.add(join(p.path, a.dir));
  for (const l of stack?.libs ?? []) roots.add(join(p.path, l.dir));
  const out: { abs: string; rel: string; kind: DepFolder['kind'] }[] = [];
  const add = (dir: string, name: string, kind: DepFolder['kind']) => {
    const abs = join(dir, name);
    if (!isRealDirInside(abs, p.path) || out.some((o) => o.abs === abs)) return;
    out.push({ abs, rel: relative(p.path, abs), kind });
  };
  for (const dir of roots) {
    add(dir, 'node_modules', 'node_modules');
    if (existsSync(join(dir, 'composer.json'))) add(dir, 'vendor', 'vendor');
    for (const v of VENVS) if (existsSync(join(dir, v, 'pyvenv.cfg'))) add(dir, v, 'venv');
  }
  return out;
}

/** A real directory (not a symlink) whose real path is inside `root`. */
export function isRealDirInside(abs: string, root: string): boolean {
  try {
    if (lstatSync(abs).isSymbolicLink() || !statSync(abs).isDirectory()) return false;
    const real = realpathSync(abs);
    const base = realpathSync(root);
    return real !== base && real.startsWith(base + sep);
  } catch {
    return false;
  }
}

/** Size on disk in bytes (`du -sk`; it does not follow symlinks). */
export async function sizeOf(abs: string): Promise<number> {
  const r = await run('du', ['-sk', abs], { timeout: 120_000 });
  const kb = Number(r.stdout.trim().split(/\s+/)[0]);
  return Number.isFinite(kb) ? kb * 1024 : 0;
}

/**
 * When the project was last worked on, for "not run for 30 days": the newest change among its own top-level files
 * (Git's index moves on every commit / checkout), the dependency folders left out.
 */
export function lastActivity(p: ProjectConfig): number | null {
  let newest = 0;
  const skip = new Set(['node_modules', 'vendor', ...VENVS]);
  try {
    for (const e of readdirSync(p.path)) {
      if (skip.has(e)) continue;
      const f = e === '.git' ? join(p.path, '.git', 'index') : join(p.path, e);
      try {
        newest = Math.max(newest, statSync(f).mtimeMs);
      } catch {
        /* vanished */
      }
    }
  } catch {
    return null;
  }
  return newest || null;
}
