import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { RuntimeToolId, RuntimeToolRuntime, RuntimeToolState } from '@shared/types';
import { findCommand, getShellEnv, run } from './env';
import { shimDir, writeCmdShim } from './node';
import { exe, isWin, joinPath, pathKey, splitPath } from './platform';
import { uvEnv, uvPath } from './python';
import { dataDir } from './store';

/**
 * Runtimes → Tools (Node.js, Go, Python): the command-line tools the frameworks DevCatz runs are used with, installed
 * the runtime's own way into DevCatz's folder so they survive switching versions:
 *   Node.js — `npm install -g --prefix <data>/tools/npm` with the default Node (bins in tools/npm/bin, Windows: tools/npm);
 *   Go — `go install <pkg>@latest` with GOBIN=<data>/tools/bin and the default Go;
 *   Python — `uv tool install` with UV_TOOL_DIR=<data>/tools/uv and UV_TOOL_BIN_DIR=<data>/tools/bin.
 * Sites get those folders on their PATH; terminals get them through the shim folder (links / .cmd shims, listed in
 * tools/links.json so the stale ones go). Rust has its own Tools tab (rust.ts, cargo's bin).
 */

interface ToolDef {
  id: RuntimeToolId;
  runtime: RuntimeToolRuntime;
  label: string;
  /** Command(s) it adds; the first is the one checked. */
  bins: string[];
  /** npm package / Go module path / PyPI package. */
  pkg: string;
  /** Go: the module the command belongs to (its version is the tool's); the proxy's @latest is read for it. */
  mod?: string;
  /** npm: packages whose install scripts must run (newer npm skips them for global installs unless allowed). */
  scripts?: string[];
  why: string;
}

export const TOOLS: ToolDef[] = [
  // Node.js
  { id: 'pnpm', runtime: 'node', label: 'pnpm', bins: ['pnpm', 'pnpx'], pkg: 'pnpm', why: 'Package manager of sites with pnpm-lock.yaml' },
  { id: 'yarn', runtime: 'node', label: 'Yarn', bins: ['yarn', 'yarnpkg'], pkg: 'yarn', why: 'Package manager of sites with yarn.lock (Yarn 1; Berry projects bring their own through .yarnrc.yml)' },
  { id: 'electron', runtime: 'node', label: 'Electron', bins: ['electron'], pkg: 'electron', scripts: ['electron'], why: '`electron .` for a folder with a main.js and no electron in its package.json; projects use their own copy' },
  { id: 'electron-forge', runtime: 'node', label: 'Electron Forge', bins: ['electron-forge'], pkg: '@electron-forge/cli', scripts: ['electron'], why: 'Creates, packages and publishes Electron apps (electron-forge init / package / make)' },
  { id: 'angular-cli', runtime: 'node', label: 'Angular CLI', bins: ['ng'], pkg: '@angular/cli', why: 'ng new / generate outside a project; Angular sites run their own ng' },
  { id: 'nest-cli', runtime: 'node', label: 'NestJS CLI', bins: ['nest'], pkg: '@nestjs/cli', why: 'nest new / generate (modules, controllers, resources) for NestJS sites' },
  { id: 'typescript', runtime: 'node', label: 'TypeScript', bins: ['tsc', 'tsserver'], pkg: 'typescript', why: 'tsc for scripts and folders without their own TypeScript' },
  { id: 'tsx', runtime: 'node', label: 'tsx', bins: ['tsx'], pkg: 'tsx', scripts: ['esbuild'], why: 'Runs a .ts file directly (tsx watch server.ts) — Express / Hono backends without a build step' },
  { id: 'nodemon', runtime: 'node', label: 'nodemon', bins: ['nodemon'], pkg: 'nodemon', why: 'Restarts a Node server when its files change (dev scripts that call nodemon)' },
  // Go
  { id: 'air', runtime: 'go', mod: 'github.com/air-verse/air', label: 'Air', bins: ['air'], pkg: 'github.com/air-verse/air', why: 'Live reload for Gin, Echo, Fiber, Chi … — sites with an .air.toml start with it' },
  { id: 'swag', runtime: 'go', mod: 'github.com/swaggo/swag', label: 'swag', bins: ['swag'], pkg: 'github.com/swaggo/swag/cmd/swag', why: 'swag init writes docs/swagger.json from handler comments (API tab, DialCatz)' },
  { id: 'migrate', runtime: 'go', mod: 'github.com/golang-migrate/migrate/v4', label: 'golang-migrate', bins: ['migrate'], pkg: 'github.com/golang-migrate/migrate/v4/cmd/migrate', why: 'migrate up / down for golang-migrate migrations (Database tab)' },
  { id: 'goose', runtime: 'go', mod: 'github.com/pressly/goose/v3', label: 'goose', bins: ['goose'], pkg: 'github.com/pressly/goose/v3/cmd/goose', why: 'goose up / status for goose migrations (Database tab)' },
  { id: 'sqlc', runtime: 'go', mod: 'github.com/sqlc-dev/sqlc', label: 'sqlc', bins: ['sqlc'], pkg: 'github.com/sqlc-dev/sqlc/cmd/sqlc', why: 'Type-safe Go from SQL (sqlc generate) for sqlc projects' },
  { id: 'templ', runtime: 'go', mod: 'github.com/a-h/templ', label: 'templ', bins: ['templ'], pkg: 'github.com/a-h/templ/cmd/templ', why: 'templ generate / --watch for templ HTML components' },
  { id: 'wails', runtime: 'go', mod: 'github.com/wailsapp/wails/v2', label: 'Wails', bins: ['wails'], pkg: 'github.com/wailsapp/wails/v2/cmd/wails', why: 'wails dev for Go desktop apps with a web frontend (like Electron / Tauri)' },
  { id: 'delve', runtime: 'go', mod: 'github.com/go-delve/delve', label: 'Delve', bins: ['dlv'], pkg: 'github.com/go-delve/delve/cmd/dlv', why: 'The Go debugger editors use (VS Code, GoLand)' },
  // Python
  { id: 'poetry', runtime: 'python', label: 'Poetry', bins: ['poetry'], pkg: 'poetry', why: 'For projects managed with Poetry (poetry.lock); DevCatz itself installs with uv' },
  { id: 'pipenv', runtime: 'python', label: 'Pipenv', bins: ['pipenv'], pkg: 'pipenv', why: 'For projects with a Pipfile.lock you keep updating with pipenv' },
  { id: 'pdm', runtime: 'python', label: 'PDM', bins: ['pdm'], pkg: 'pdm', why: 'For projects managed with PDM (pdm.lock)' },
  { id: 'ruff', runtime: 'python', label: 'Ruff', bins: ['ruff'], pkg: 'ruff', why: 'Fast linter and formatter for Django / FastAPI / Flask code' },
  { id: 'pre-commit', runtime: 'python', label: 'pre-commit', bins: ['pre-commit'], pkg: 'pre-commit', why: 'Runs a repository’s .pre-commit-config.yaml hooks before each commit' },
  { id: 'cookiecutter', runtime: 'python', label: 'Cookiecutter', bins: ['cookiecutter'], pkg: 'cookiecutter', why: 'Starts a project from a template (cookiecutter-django …)' },
];

const npmPrefix = () => dataDir('tools', 'npm');
const npmBin = () => (isWin ? npmPrefix() : join(npmPrefix(), 'bin'));
const toolsBin = () => dataDir('tools', 'bin');
const uvToolDir = () => dataDir('tools', 'uv');
const linksFile = () => dataDir('tools', 'links.json');

/** Folders with installed tools, for a site's PATH (after its own runtimes). */
export const toolPathDirs = (): string[] => [npmBin(), toolsBin()];

/** Where an installed tool's command is (null when DevCatz has not installed it). */
function binPath(t: ToolDef, bin = t.bins[0]): string | null {
  const dir = t.runtime === 'node' ? npmBin() : toolsBin();
  const file = join(dir, isWin ? (t.runtime === 'node' ? `${bin}.cmd` : exe(bin)) : bin);
  return existsSync(file) ? file : null;
}

export interface ToolRuntimes {
  /** bin folder of the default Node / Go (null when none is installed). */
  node: string | null;
  go: string | null;
}

/** Each tool of `runtime`: installed by DevCatz (with its version), else found on the PATH, plus the sites that need it. */
export async function toolStates(runtime: RuntimeToolRuntime, needs: Map<RuntimeToolId, string[]>, refresh = false): Promise<RuntimeToolState[]> {
  return Promise.all(
    TOOLS.filter((t) => t.runtime === runtime).map(async (t) => {
      const path = binPath(t);
      // Not DevCatz's: the user's own copy (Homebrew, corepack, npm -g, go install …) counts as installed; DevCatz does
      // not update it.
      const external = path ? null : await findCommand(t.bins[0]).catch(() => null);
      const elsewhere = !!external;
      const version = path ? await installedVersion(t, path) : external ? await externalVersion(t, external) : null;
      const latest = path ? await latestVersion(t, refresh).catch(() => null) : null;
      return {
        id: t.id,
        runtime: t.runtime,
        label: t.label,
        why: t.why,
        pkg: t.pkg,
        installed: !!path,
        onPath: elsewhere,
        externalPath: external,
        version,
        latest,
        update: !!(version && latest && newer(latest, version)),
        neededBy: !path && !elsewhere ? (needs.get(t.id) ?? []) : [],
      };
    }),
  );
}

/** The installed version from the runtime's own records (faster and steadier than each tool's --version). */
async function installedVersion(t: ToolDef, path: string): Promise<string | null> {
  if (t.runtime === 'node') {
    const dir = isWin ? join(npmPrefix(), 'node_modules', t.pkg) : join(npmPrefix(), 'lib', 'node_modules', t.pkg);
    try {
      return (JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { version?: string }).version ?? null;
    } catch {
      return null;
    }
  }
  if (t.runtime === 'go') {
    // `go version -m` prints the module a binary was built from: "mod  github.com/air-verse/air  v1.61.7  h1:…".
    const go = goBin;
    if (!go) return null;
    const r = await run(go, ['version', '-m', path], { timeout: 15_000 }).catch(() => null);
    return r?.stdout.match(/^\s*mod\s+\S+\s+v?([^\s]+)/m)?.[1] ?? null;
  }
  const uv = uvPath();
  if (!uv) return null;
  const r = await run(uv, ['tool', 'list'], { timeout: 15_000, env: { ...uvEnv(), UV_TOOL_DIR: uvToolDir(), UV_TOOL_BIN_DIR: toolsBin() } }).catch(() => null);
  return r?.stdout.match(new RegExp(`^${t.pkg.replace(/[.-]/g, '[.-]')}\\s+v?(\\S+)`, 'im'))?.[1] ?? null;
}

/** Version of the user's own copy: npm's package.json next to the real file, Go's build info; else unknown. */
async function externalVersion(t: ToolDef, file: string): Promise<string | null> {
  if (t.runtime === 'node') {
    // …/lib/node_modules/<pkg>/cli.js (a symlink from …/bin/<bin>): the nearest package.json named after the package.
    let dir = dirname(realpathSync(file));
    for (let i = 0; i < 5; i++) {
      try {
        const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
        if (pkg.name === t.pkg) return pkg.version ?? null;
      } catch {
        /* keep looking up */
      }
      dir = dirname(dir);
    }
    return null;
  }
  if (t.runtime === 'go' && goBin) {
    const r = await run(goBin, ['version', '-m', file], { timeout: 15_000 }).catch(() => null);
    return r?.stdout.match(/^\s*mod\s+\S+\s+v?([^\s]+)/m)?.[1] ?? null;
  }
  return null;
}

/** Go binary used to read build info (set by the caller from the default Go). */
let goBin: string | null = null;
export const setGoBin = (binDir: string | null) => (goBin = binDir ? join(binDir, exe('go')) : null);

const latestCache = new Map<string, { at: number; version: string }>();

/** The newest release on the runtime's registry (npm, the Go module proxy, PyPI); cached for 6 hours unless `refresh`. */
export async function latestVersion(t: ToolDef, refresh = false): Promise<string | null> {
  const hit = latestCache.get(t.id);
  if (hit && !refresh && Date.now() - hit.at < 6 * 3600_000) return hit.version;
  let version: string | null = null;
  if (t.runtime === 'node') {
    const res = await fetch(`https://registry.npmjs.org/${t.pkg.replace('/', '%2F')}/latest`);
    if (res.ok) version = ((await res.json()) as { version?: string }).version ?? null;
  } else if (t.runtime === 'go') {
    const res = await fetch(`https://proxy.golang.org/${t.mod ?? t.pkg}/@latest`);
    if (res.ok) version = (((await res.json()) as { Version?: string }).Version ?? '').replace(/^v/, '') || null;
  } else {
    const res = await fetch(`https://pypi.org/pypi/${t.pkg}/json`);
    if (res.ok) version = ((await res.json()) as { info?: { version?: string } }).info?.version ?? null;
  }
  if (version) latestCache.set(t.id, { at: Date.now(), version });
  return version;
}

/** a > b for versions like 1.61.7 / 10.2.0 / 2.1.3 (pre-release suffixes count as older). */
export function newer(a: string, b: string): boolean {
  const parts = (v: string) => v.replace(/^v/, '').split(/[.+-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : -1));
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length, 3); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p !== q) return p > q;
  }
  return false;
}

/** Every installed tool with a newer release (for the automatic check and its notification). */
export async function toolUpdates(): Promise<{ id: RuntimeToolId; runtime: RuntimeToolRuntime; label: string; from: string; to: string }[]> {
  const out: { id: RuntimeToolId; runtime: RuntimeToolRuntime; label: string; from: string; to: string }[] = [];
  for (const t of TOOLS) {
    const path = binPath(t);
    if (!path) continue;
    const from = await installedVersion(t, path);
    const to = await latestVersion(t, true).catch(() => null);
    if (from && to && newer(to, from)) out.push({ id: t.id, runtime: t.runtime, label: t.label, from, to });
  }
  return out;
}

/** PATH with the tool folders and `extra` first (the runtime that installs / runs them). */
function toolEnv(extra: string[] = []): Record<string, string> {
  const env = getShellEnv();
  const key = pathKey(env);
  return { [key]: joinPath([...extra, ...toolPathDirs(), ...splitPath(env[key])]) };
}

const tail = (r: { stdout: string; stderr: string }) => `${r.stderr}\n${r.stdout}`.trim().split('\n').slice(-4).join(' ');

/** Installs (or updates to the latest) one tool with its runtime. */
export async function installTool(id: RuntimeToolId, rt: ToolRuntimes, log: (line: string) => void): Promise<void> {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown tool ${id}`);
  mkdirSync(toolsBin(), { recursive: true });
  let r: { code: number; stdout: string; stderr: string };
  if (t.runtime === 'node') {
    if (!rt.node) throw new Error('Node.js is not installed: install it on the Node.js page first');
    mkdirSync(npmPrefix(), { recursive: true });
    const npm = join(rt.node, isWin ? 'npm.cmd' : 'npm');
    log(`npm install -g ${t.pkg}`);
    r = await run(isWin ? (process.env.ComSpec ?? 'cmd.exe') : npm, [...(isWin ? ['/d', '/c', npm] : []), 'install', '-g', '--prefix', npmPrefix(), ...(t.scripts ? [`--allow-scripts=${t.scripts.join(',')}`] : []), `${t.pkg}@latest`], {
      timeout: 15 * 60_000,
      env: toolEnv([rt.node]),
    });
  } else if (t.runtime === 'go') {
    if (!rt.go) throw new Error('Go is not installed: install it on the Go page first');
    log(`go install ${t.pkg}@latest`);
    r = await run(join(rt.go, exe('go')), ['install', `${t.pkg}@latest`], { timeout: 20 * 60_000, env: { ...toolEnv([rt.go]), GOBIN: toolsBin() } });
  } else {
    const uv = uvPath();
    if (!uv) throw new Error('uv is not installed: install it on the Python page first');
    log(`uv tool install ${t.pkg}`);
    r = await run(uv, ['tool', 'install', '--force', t.pkg], {
      timeout: 15 * 60_000,
      env: { ...uvEnv(), UV_TOOL_DIR: uvToolDir(), UV_TOOL_BIN_DIR: toolsBin() },
    });
  }
  for (const line of `${r.stdout}\n${r.stderr}`.split('\n')) if (line.trim()) log(line);
  if (r.code !== 0 || !binPath(t)) throw new Error(`${t.label}: ${tail(r) || `exit ${r.code}`}`);
  // Electron 45+ downloads its binary on first run, not on install: fetch it now so the first `electron .` starts at once.
  if (t.id === 'electron' && rt.node) {
    const dir = isWin ? join(npmPrefix(), 'node_modules', 'electron') : join(npmPrefix(), 'lib', 'node_modules', 'electron');
    if (!existsSync(join(dir, 'path.txt')) || !existsSync(join(dir, 'dist'))) {
      log('Downloading the Electron app…');
      const d = await run(join(rt.node, exe('node')), [join(dir, 'install.js')], { timeout: 15 * 60_000, env: toolEnv([rt.node]) });
      if (d.code !== 0) throw new Error(`Electron's download failed: ${tail(d)}`);
    }
  }
  writeToolShims();
}

export async function uninstallTool(id: RuntimeToolId, rt: ToolRuntimes): Promise<void> {
  const t = TOOLS.find((x) => x.id === id);
  if (!t) throw new Error(`Unknown tool ${id}`);
  if (t.runtime === 'node' && rt.node) {
    const npm = join(rt.node, isWin ? 'npm.cmd' : 'npm');
    await run(isWin ? (process.env.ComSpec ?? 'cmd.exe') : npm, [...(isWin ? ['/d', '/c', npm] : []), 'uninstall', '-g', '--prefix', npmPrefix(), t.pkg], {
      timeout: 5 * 60_000,
      env: toolEnv([rt.node]),
    });
  } else if (t.runtime === 'python' && uvPath()) {
    await run(uvPath()!, ['tool', 'uninstall', t.pkg], { timeout: 5 * 60_000, env: { ...uvEnv(), UV_TOOL_DIR: uvToolDir(), UV_TOOL_BIN_DIR: toolsBin() } });
  }
  // Go binaries (and anything a runtime left behind): the files themselves.
  for (const bin of t.bins) {
    const p = binPath(t, bin);
    if (p) rmSync(p, { force: true });
  }
  writeToolShims();
}

/** Links (macOS) / .cmd shims (Windows) in the shim folder for every installed tool, so terminals that use it find them. */
export function writeToolShims(): void {
  const dir = shimDir();
  mkdirSync(dir, { recursive: true });
  let old: string[] = [];
  try {
    old = JSON.parse(readFileSync(linksFile(), 'utf8')) as string[];
  } catch {
    /* first time */
  }
  for (const name of old) {
    try {
      unlinkSync(join(dir, isWin ? `${name}.cmd` : name));
    } catch {
      /* gone */
    }
  }
  const made: string[] = [];
  for (const t of TOOLS) {
    for (const bin of t.bins) {
      const target = binPath(t, bin);
      if (!target) continue;
      if (isWin) writeCmdShim(dir, bin, target);
      else {
        try {
          symlinkSync(target, join(dir, bin));
        } catch {
          continue; // a shim of the same name (node, npm …) wins
        }
      }
      made.push(bin);
    }
  }
  mkdirSync(dataDir('tools'), { recursive: true });
  writeFileSync(linksFile(), JSON.stringify(made));
}
