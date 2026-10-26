import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { AppInfo, StackInfo } from '@shared/types';
import { detectDatabase, readJson, runScriptCommand, slugify, type PackageJson } from '../detect';
import { detectRedis } from '../redis';
import { detectGoApp } from './go';
import { hasDependencies, mainRank, nodeDriver, portClashes, portFlagCommand } from './node';
import { phpDriver } from './php';
import { pythonDriver } from './python';

/**
 * Projects made of sibling projects (TODO §29): `frontend/` + `backend/`, `web/` + `api/`, `apps/*` and
 * `services/*` with different languages — no JS workspace ties them together, so the root matches no driver (or
 * only a tooling package.json). Each folder is detected by its own driver and becomes an app that DevCatz runs in
 * its folder, with its own port: JS dev servers through their `--port` or PORT, Laravel through `artisan serve`,
 * other PHP through PHP's built-in server, Python and Go through their usual commands (they read $PORT).
 */

const SKIP = new Set(['node_modules', 'vendor', 'dist', 'build', 'out', 'public', 'storage', 'tmp', 'docs', 'doc', 'coverage', 'target', 'bin']);
/** Folders whose children are projects too (apps/web, services/api …). */
const GROUPS = ['apps', 'services', 'packages', 'projects'];

function subDirs(base: string): string[] {
  try {
    return readdirSync(base)
      .filter((e) => !e.startsWith('.') && !SKIP.has(e))
      .map((e) => join(base, e))
      .filter((d) => statSync(d).isDirectory())
      .sort();
  } catch {
    return [];
  }
}

/** The project folders of a folder layout (one level, plus the children of apps/, services/ …). */
export function projectFolders(root: string): string[] {
  const out: string[] = [];
  for (const d of subDirs(root)) {
    if (GROUPS.includes(basename(d))) out.push(...subDirs(d).filter(isProject));
    else if (isProject(d)) out.push(d);
  }
  return out;
}

const isProject = (d: string) => phpDriver.matches(d) || pythonDriver.matches(d) || existsSync(join(d, 'go.mod')) || existsSync(join(d, 'package.json'));

/** One folder as one app (its own dev command, run from that folder); null when it has nothing to run. */
function folderApp(root: string, dir: string): { app: AppInfo; runtime: 'node' | 'php' | 'python' | 'go'; depsMissing: boolean; warnings: string[] } | null {
  const rel = relative(root, dir);
  if (phpDriver.matches(dir)) {
    const s = phpDriver.detect(dir, '');
    const web = s.apps.find((a) => a.kind === 'web');
    if (!web) return null;
    const laravel = existsSync(join(dir, 'artisan'));
    const docroot = web.docroot ?? '.';
    const command = laravel ? 'php artisan serve --host=127.0.0.1 --port=${PORT:-8000}' : `php -S 127.0.0.1:\${PORT:-8000} -t ${docroot}`;
    return {
      runtime: 'php',
      depsMissing: s.depsMissing,
      warnings: s.warnings,
      app: { ...web, dir: rel, kind: 'api', docroot: undefined, devScript: command, command, port: 8000, configuredPort: 8000, portVars: ['PORT'], managedPort: false, portFlag: false, flagCommand: null, domain: '' },
    };
  }
  if (pythonDriver.matches(dir)) {
    const s = pythonDriver.detect(dir, '');
    const app = s.apps[0];
    if (!app?.command) return null;
    // The folder's own venv first (the site-wide one is the root's).
    const venv = s.python?.venv ? join(dir, s.python.venv) : null;
    const command = venv ? `env VIRTUAL_ENV="${venv}" PATH="${venv}/bin:$PATH" PYTHONUNBUFFERED=1 ${app.command}` : `env PYTHONUNBUFFERED=1 ${app.command}`;
    return { runtime: 'python', depsMissing: s.depsMissing, warnings: s.warnings, app: { ...app, dir: rel, kind: 'api', devScript: app.command, command, domain: '' } };
  }
  if (existsSync(join(dir, 'go.mod')) && !existsSync(join(dir, 'package.json'))) {
    const app = detectGoApp(dir, root, '');
    return app.command ? { runtime: 'go', depsMissing: false, warnings: [], app: { ...app, kind: 'api' } } : null;
  }
  const pkg = readJson<PackageJson>(join(dir, 'package.json'));
  if (!pkg?.scripts?.dev) return null;
  const s = nodeDriver.detect(dir, '');
  const app = s.apps[0];
  if (!app || !s.packageManager) return null;
  const pm = s.packageManager;
  // A nested JS monorepo runs as one process with its own dev script (its apps keep their own ports).
  const flagCommand = !s.monorepo && !app.portVars.length ? portFlagCommand(pm, pkg.scripts.dev) : null;
  return {
    runtime: 'node',
    depsMissing: !hasDependencies(dir),
    warnings: s.warnings,
    app: { ...app, dir: rel, command: s.devCommand ?? runScriptCommand(pm, 'dev'), portFlag: Boolean(flagCommand), flagCommand, domain: '' },
  };
}

/**
 * The folder layout of `root`, or null when it is not one: at least two runnable folders, or one runnable folder
 * under a root that runs nothing itself (`base` = what the root's own driver found).
 */
export function detectFolders(root: string, domain: string, base: StackInfo | null): StackInfo | null {
  const found = projectFolders(root)
    .map((d) => folderApp(root, d))
    .filter((x): x is NonNullable<typeof x> => x !== null);
  if (!found.length || (base?.apps.length && found.length < 2)) return null;
  const apps = found.map((f) => f.app);
  // The first web app owns the bare domain (the frontend); the others get `<folder>.<domain>`.
  apps.sort((a, b) => (a.kind === b.kind ? mainRank(a) - mainRank(b) || a.dir.localeCompare(b.dir) : a.kind === 'web' ? -1 : 1));
  apps.forEach((app, i) => {
    app.domain = i === 0 ? domain : `${slugify(basename(app.dir))}.${domain}`;
  });
  const runtimes = [...new Set(found.map((f) => f.runtime))];
  const node = found.find((f) => f.runtime === 'node');
  const dirs = apps.map((a) => join(root, a.dir));
  const missing = found.filter((f) => f.depsMissing).map((f) => f.app.dir);
  return {
    packageManager: node ? (nodeDriver.detect(join(root, node.app.dir), '').packageManager ?? 'npm') : null,
    detectedPackageManager: null,
    monorepo: true,
    layout: 'folders',
    subRuntimes: runtimes,
    // What the site settings show; Start runs each app from its folder.
    devCommand: `${apps.length} apps, each from its folder`,
    apps,
    database: detectDatabase(root, dirs),
    redis: detectRedis(root, dirs),
    prismaDir: null,
    node: null,
    runtime: 'node',
    depsMissing: missing.length > 0,
    warnings: [...portClashes(apps), ...found.flatMap((f) => f.warnings.map((w) => `${f.app.dir}: ${w}`)), ...(missing.length ? [`Dependencies missing in ${missing.join(', ')}: use Install dependencies.`] : [])],
    libs: [],
  };
}
