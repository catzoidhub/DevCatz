import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { slugify } from './detect';
import { run } from './env';

/**
 * Files a Git worktree does not get from the repository (they are gitignored) but a site needs to run:
 * its .env files and installed dependencies, taken from the parent site's folder.
 */

/** `feat/login` → `feat-login` (a DNS label for `<branch>.<site>.localhost`). */
export const branchLabel = (branch: string) => slugify(branch.replace(/^refs\/heads\//, ''));

/** `.env`, `.env.local`, `.env.development.local` …; not the committed templates. */
const ENV_FILE = /^\.env(\.[\w.-]+)?$/;
const TEMPLATE = /\.(example|sample|dist|template|defaults)$/;

/**
 * Copies the parent's .env files that are missing in the worktree (root and app folders), with the parent's
 * domain rewritten to the worktree's: `shop.localhost` → `feat-login.shop.localhost`, and app subdomains with it
 * (`api.shop.localhost` → `api.feat-login.shop.localhost`). Returns the copied paths (relative).
 */
export function copyEnvFiles(from: string, to: string, dirs: string[], parentDomain: string, domain: string): string[] {
  const re = new RegExp(`(?<![a-z0-9-])${parentDomain.replace(/\./g, '\\.')}(?![a-z0-9-])`, 'gi');
  const copied: string[] = [];
  for (const dir of new Set(['.', ...dirs])) {
    const src = join(from, dir);
    let names: string[] = [];
    try {
      names = readdirSync(src);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!ENV_FILE.test(name) || TEMPLATE.test(name)) continue;
      const file = join(src, name);
      const dest = join(to, dir, name);
      if (existsSync(dest) || !existsSync(join(to, dir)) || !statSync(file).isFile()) continue;
      writeFileSync(dest, readFileSync(file, 'utf8').replace(re, domain), { mode: statSync(file).mode & 0o777 });
      copied.push(join(dir, name));
    }
  }
  return copied;
}

/** Dependency folders worth cloning (absolute paths inside them would point back at the parent: not .venv). */
const DEP_DIRS = ['node_modules', 'vendor'];

/**
 * Clones the parent's node_modules / vendor folders into the worktree with APFS copy-on-write (`cp -c`):
 * near instant and no extra disk until files change. Folders the worktree already has are left alone.
 */
export async function cloneDeps(from: string, to: string, dirs: string[]): Promise<string[]> {
  const cloned: string[] = [];
  for (const dir of new Set(['.', ...dirs])) {
    for (const dep of DEP_DIRS) {
      const src = join(from, dir, dep);
      const dest = join(to, dir, dep);
      if (!existsSync(src) || existsSync(dest) || !existsSync(join(to, dir))) continue;
      const r = await run('cp', ['-cR', src, dest], { timeout: 10 * 60_000 });
      // Not APFS (or an old macOS): a plain copy would be slow and big — the caller installs instead.
      if (r.code !== 0) throw new Error(`Could not clone ${join(dir, dep)}: ${r.stderr.trim() || `cp exit ${r.code}`}`);
      cloned.push(join(dir, dep));
    }
  }
  return cloned;
}

/** A database name for the worktree's copy: `shop_feat_login` (letters, digits, _; at most 64). */
export function copyName(db: string, branch: string): string {
  const base = db.replace(/\.(sqlite3?|db)$/i, '');
  const name = `${base}_${branchLabel(branch).replace(/-/g, '_')}`.slice(0, 64);
  return /\.(sqlite3?|db)$/i.test(db) ? `${name}${db.slice(base.length)}` : name;
}

const DB_KEYS = /^(DB_DATABASE|DB_NAME|DATABASE_NAME|DATABASE|POSTGRES_DB|MYSQL_DATABASE|PGDATABASE)$/;

/**
 * Points the worktree's .env files at its copied database: `DB_DATABASE=shop` → `shop_feat_login`, and the
 * path of `DATABASE_URL`-style URLs (`…/shop?…`). Returns the files changed.
 */
export function rewriteEnvDb(root: string, files: string[], from: string, to: string): string[] {
  const changed: string[] = [];
  const url = new RegExp(`(://[^\\s"'/]+/)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=["'?\\s]|$)`, 'gm');
  for (const rel of files) {
    const file = join(root, rel);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, 'utf8');
    const next = text
      .split('\n')
      .map((line) => {
        const m = line.match(/^(\s*(?:export\s+)?)([A-Z0-9_]+)(\s*=\s*)(["']?)(.*?)\4(\s*(?:#.*)?)$/);
        if (m && DB_KEYS.test(m[2]) && m[5] === from) return `${m[1]}${m[2]}${m[3]}${m[4]}${to}${m[4]}${m[6]}`;
        return line.replace(url, `$1${to}`);
      })
      .join('\n');
    if (next !== text) {
      writeFileSync(file, next);
      changed.push(rel);
    }
  }
  return changed;
}

/** A project-local SQLite file (Laravel's database/database.sqlite, gitignored) copied into the worktree. */
export function copyLocalFile(from: string, to: string, rel: string): boolean {
  const src = join(from, rel);
  const dest = join(to, rel);
  if (!existsSync(src) || existsSync(dest) || !existsSync(join(dest, '..'))) return false;
  copyFileSync(src, dest);
  return true;
}
