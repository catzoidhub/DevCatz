import { existsSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { AppInfo, Framework, PackageManager, StackInfo } from '@shared/types';
import {
  DEFAULT_PORTS,
  detectDatabase,
  detectPackageManager,
  devScriptName,
  execCommand,
  firstExisting,
  readEnvFiles,
  readJson,
  readText,
  runScriptCommand,
  slugify,
  type PackageJson,
} from '../detect';
import { detectRedis } from '../redis';
import { detectGoApp, findGoModules } from './go';
import { findRustApps } from './rust';
import { phpDriver, phpFolderApp } from './php';
import { pythonDriver, pythonFolderApp } from './python';
import type { RuntimeDriver } from './types';

const isPackage = (dir: string) => existsSync(join(dir, 'package.json'));

/**
 * Expands workspace patterns of the form `dir`, `dir/*` (no deep globs) to the folders holding a package.json —
 * or, with `all`, to every folder they match: a PHP / Python project under apps/ has no package.json but is a
 * member of the project all the same.
 */
function workspaceDirs(root: string, pkg: PackageJson | null, all = false): string[] {
  let patterns: string[] = [];
  if (Array.isArray(pkg?.workspaces)) patterns = pkg.workspaces;
  else if (pkg?.workspaces?.packages) patterns = pkg.workspaces.packages;
  const pnpm = readText(join(root, 'pnpm-workspace.yaml'));
  if (pnpm) {
    for (const m of pnpm.matchAll(/^\s*-\s*['"]?([^'"\n#]+)['"]?/gm)) patterns.push(m[1].trim());
  }
  const dirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.startsWith('!')) continue;
    const clean = pattern.replace(/\/+$/, '');
    if (clean.endsWith('/*') || clean.endsWith('/**')) {
      const base = join(root, clean.replace(/\/\*+$/, ''));
      let entries: string[] = [];
      try {
        entries = readdirSync(base);
      } catch {
        continue;
      }
      for (const entry of entries.sort()) {
        const full = join(base, entry);
        if (entry !== 'node_modules' && !entry.startsWith('.') && statSync(full).isDirectory() && (all || isPackage(full))) dirs.push(full);
      }
    } else if (!clean.includes('*') && (all ? existsSync(join(root, clean)) : isPackage(join(root, clean)))) {
      dirs.push(join(root, clean));
    }
  }
  return dirs;
}

/** The Node server framework of an `express` app (Express, Fastify, Hono, Koa), for its label and mark. */
function detectServer(pkg: PackageJson): string | null {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  for (const name of ['fastify', 'hono', 'koa', 'express']) if (deps[name]) return name;
  return null;
}

function detectFramework(pkg: PackageJson): Framework {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.nuxt) return 'nuxt';
  if (deps.next) return 'next';
  if (deps['@sveltejs/kit']) return 'sveltekit';
  if (deps.astro) return 'astro';
  if (deps['@nestjs/core']) return 'nestjs';
  if (deps['@angular/core']) return 'angular';
  // TanStack Start (React or Solid) is a Vite plugin: before the plain Vite checks.
  if (deps['@tanstack/react-start'] || deps['@tanstack/solid-start']) return 'tanstack-start';
  if (deps.vite && deps.vue) return 'vite-vue';
  if (deps.vite && deps.react) return 'vite-react';
  if (deps.vite && deps.svelte) return 'vite-svelte';
  if (deps.vite) return 'vite';
  if (deps.express || deps.fastify || deps.hono || deps.koa) return 'express';
  return 'node';
}

interface PortInfo {
  port: number | null;
  /** Env vars the app reads its port from (what DevCatz can inject). */
  vars: string[];
  /** The line a fixed port is written on (relative to the project root). */
  source?: AppInfo['portSource'];
}

/** `file:line` and the code of the match at `index` in `text`. */
function sourceAt(root: string, file: string, text: string, index: number): NonNullable<AppInfo['portSource']> {
  const line = text.slice(0, index).split('\n').length;
  return { file: relative(root, file) || file, line, code: (text.split('\n')[line - 1] ?? '').trim().slice(0, 140) };
}

const envRefs = (expr: string) => [...expr.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);

/** Port variables of backing services, never the app's own listen port. */
const SERVICE_PORT = /REDIS|DB_|DATABASE|PG|POSTGRES|MYSQL|MARIA|SMTP|MAIL|S3|MINIO|RABBIT|AMQP|KAFKA|MONGO|ELASTIC|MEILI|PROXY/i;
const ownPortVars = (expr: string) => envRefs(expr).filter((n) => /PORT/i.test(n) && !SERVICE_PORT.test(n));

/**
 * Evaluates a port expression from a config file the way it would run:
 * `Number(process.env.PORT || process.env.WEB_PORT) || 3000` → the first
 * referenced env var that is set in the project's .env files, else the literal.
 */
function portFromExpr(expr: string, env: Record<string, string>): number | null {
  for (const name of envRefs(expr)) {
    const v = Number(env[name]);
    if (v > 0) return v;
  }
  const literal = expr.match(/\b(\d{2,5})\b/);
  return literal ? Number(literal[1]) : null;
}

/** `port: <expr>` inside a `<block>: { … }` object (devServer / server). */
function portExprInBlock(text: string | null, block: string): string | null {
  const m = text?.match(new RegExp(`${block}\\s*:\\s*\\{[^}]*?port\\s*:\\s*([^,\\n}]+)`, 's'));
  return m ? m[1] : null;
}

function detectPort(dir: string, root: string, pkg: PackageJson, framework: Framework): PortInfo {
  const script = pkg.scripts?.[devScriptName(pkg) ?? 'dev'] ?? '';
  const flag = script.match(/(?:--port[= ]|\s-p\s+)(\d{2,5})/);
  // A literal --port in the dev script cannot be overridden from the environment.
  if (flag) {
    const pkgFile = join(dir, 'package.json');
    const text = readText(pkgFile) ?? '';
    const at = text.indexOf(flag[0].trim());
    return { port: Number(flag[1]), vars: [], source: at >= 0 ? sourceAt(root, pkgFile, text, at) : { file: relative(root, pkgFile), line: 1, code: `"dev": "${script}"` } };
  }

  const env = readEnvFiles(join(dir, '.env'), join(dir, '.env.local'), join(root, '.env'), join(root, '.env.local'));
  const fromBlock = (files: string[], block: string, extraVars: string[] = []): PortInfo | null => {
    const file = firstExisting(dir, files);
    const text = readText(file ?? '');
    const expr = portExprInBlock(text, block);
    if (!expr || !file || !text) return null;
    const vars = [...new Set([...envRefs(expr), ...extraVars])];
    const at = text.search(new RegExp(`port\\s*:\\s*${expr.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    return { port: portFromExpr(expr, env), vars, source: !envRefs(expr).length && at >= 0 ? sourceAt(root, file, text, at) : null };
  };

  if (framework === 'nuxt') {
    // nuxi gives NUXT_PORT (and PORT) precedence over devServer.port.
    const info = fromBlock(['nuxt.config.ts', 'nuxt.config.js', 'nuxt.config.mjs'], 'devServer', ['NUXT_PORT']);
    if (info?.port) return info;
    return { port: Number(env.NUXT_PORT) || Number(env.PORT) || DEFAULT_PORTS.nuxt, vars: ['NUXT_PORT'] };
  }
  if (framework === 'vite' || framework === 'vite-vue' || framework === 'vite-react' || framework === 'vite-svelte' || framework === 'sveltekit' || framework === 'tanstack-start') {
    const info = fromBlock(['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs'], 'server');
    if (info?.port) return info;
  }
  if (framework === 'astro') {
    const info = fromBlock(['astro.config.mjs', 'astro.config.ts'], 'server');
    if (info?.port) return info;
  }
  if (framework === 'nestjs' || framework === 'express' || framework === 'node') {
    // The entry file — the one the dev script runs (`node --watch app.js`, `tsx watch src/app.ts`, `nodemon server.js`)
    // or package.json's "main" — then the usual names, then config modules (NestJS apps often read the port in
    // src/config/app.config.ts).
    const scripted = script.match(/(?:^|\s)((?:\.\/)?[\w./-]+\.(?:m?[jt]s|cjs))(?:\s|$)/)?.[1];
    const entries = [scripted, pkg.main, 'src/main.ts', 'src/main.js', 'src/index.ts', 'src/index.js', 'src/server.ts', 'src/app.ts', 'src/app.js', 'index.js', 'server.js', 'app.js', 'main.js']
      .filter((f): f is string => !!f)
      .map((f) => f.replace(/^\.\//, ''));
    const files: (string | null)[] = [...new Set(entries)].filter((f) => existsSync(join(dir, f))).map((f) => join(dir, f));
    if (!files.length) files.push(null);
    try {
      const rank = (f: string) => (/^(app|server|main|http)\b/.test(f) ? 0 : 1);
      const configs = readdirSync(join(dir, 'src/config'))
        .filter((f) => /\.(ts|js)$/.test(f) && !f.includes('.spec.'))
        .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
      for (const f of configs) files.push(join(dir, 'src/config', f));
    } catch {
      /* no config folder */
    }
    const exprs: { expr: string; source: NonNullable<AppInfo['portSource']> }[] = [];
    for (const file of files) {
      const text = file ? readText(file) : null;
      if (!file || !text) continue;
      for (const m of text.matchAll(/\.listen\(\s*([^,)\n]+)/g)) exprs.push({ expr: m[1], source: sourceAt(root, file, text, m.index ?? 0) });
      for (const m of text.matchAll(/\bport\s*[:=]\s*([^,;\n]+)/gi)) exprs.push({ expr: m[1], source: sourceAt(root, file, text, m.index ?? 0) });
    }
    // An expression reading the environment beats a bare fallback like `?? 4400`.
    const withEnv = exprs.find((e) => ownPortVars(e.expr).length > 0);
    if (withEnv) return { port: portFromExpr(withEnv.expr, env), vars: ownPortVars(withEnv.expr) };
    // A number written in the code (`const port = 3000`): the line it is on, for the explanation.
    const literal = exprs.find((e) => /\b\d{2,5}\b/.test(e.expr) && portFromExpr(e.expr, env));
    if (literal) return { port: portFromExpr(literal.expr, env), vars: [], source: literal.source };
  }
  // Only frameworks known to honour PORT get it; injecting a variable the app
  // ignores would send the proxy to a port nothing listens on.
  return { port: Number(env.PORT) || DEFAULT_PORTS[framework], vars: framework === 'next' ? ['PORT'] : [] };
}

/**
 * Dev servers whose CLI takes `--port` (Vite and the frameworks on it, Astro, Nuxt, Next): when the dev script calls
 * one directly, DevCatz can give each app its own port on the command line — in a monorepo they all default to the
 * same one (5173, 4321, 3000) and only the first would start.
 */
const PORT_CLI = /^\s*(?:npx\s+|bunx\s+)?(vite|astro|nuxi|nuxt|next|ng)(?:\s+(?:dev|serve))?(?:\s|$)/;

/**
 * `<pm> run <script> … --port {port}` for an app whose dev script is a plain CLI call, else null. A script that
 * writes its own port (`vite dev --port 3000`, TanStack's starter) runs the CLI directly with that flag replaced:
 * a second `--port` would not override it.
 */
export function portFlagCommand(pm: PackageManager, script: string, devScript: string | undefined): string | null {
  if (!devScript || /&&|\|\||[;|&]/.test(devScript)) return null;
  const cli = devScript.match(PORT_CLI)?.[1];
  if (!cli) return null;
  // Angular's dev server listens on ::1 only when told `localhost`; the proxy reaches apps on 127.0.0.1.
  const extra = cli === 'vite' ? ' --strictPort' : cli === 'ng' ? ' --host 127.0.0.1' : '';
  if (/--port[= ]|\s-p\s/.test(devScript)) {
    const call = devScript.trim().replace(/^(?:npx|bunx)\s+/, '').replace(/(--port[= ]|\s-p\s+)\d{2,5}/, '$1{port}');
    return `${execCommand(pm, call)}${/--strictPort|--host/.test(call) ? '' : extra}`;
  }
  const sep = pm === 'npm' ? ' --' : '';
  return `${runScriptCommand(pm, script)}${sep} --port {port}${extra}`;
}

function hasPrisma(dir: string, pkg: PackageJson): boolean {
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  return Boolean(deps.prisma || deps['@prisma/client']) && existsSync(join(dir, 'prisma'));
}

/** An Electron app: `electron` in its dependencies (electron-vite, Electron Forge, or plain `electron .`). */
const isElectron = (pkg: PackageJson) => Boolean(pkg.dependencies?.electron || pkg.devDependencies?.electron);

function detectNodeStack(root: string, domain: string): StackInfo {
  const rootPkg = readJson<PackageJson>(join(root, 'package.json'));
  const pm = detectPackageManager(root, rootPkg);
  const wsDirs = workspaceDirs(root, rootPkg);
  const monorepo = wsDirs.length > 0;
  // PHP / Python members have no package.json: the patterns' other folders, when they are such projects.
  const others = monorepo ? workspaceDirs(root, rootPkg, true).filter((d) => !wsDirs.includes(d) && (phpDriver.matches(d) || pythonDriver.matches(d))) : [];
  const candidates = monorepo ? [...wsDirs, ...others].sort() : [root];

  const apps: AppInfo[] = [];
  const libs: StackInfo['libs'] = [];
  const warnings: string[] = [];
  const subRuntimes = new Set<NonNullable<StackInfo['subRuntimes']>[number]>();
  let prismaDir: string | null = null;
  for (const dir of candidates) {
    // A workspace member that is a PHP / Python project (apps/api with artisan beside apps/web): DevCatz runs it
    // from its folder like a folder layout does, not as a JS package.
    if (dir !== root) {
      const folder = phpDriver.matches(dir) ? { runtime: 'php' as const, found: phpFolderApp(root, dir) } : pythonDriver.matches(dir) ? { runtime: 'python' as const, found: pythonFolderApp(root, dir) } : null;
      if (folder?.found) {
        apps.push(folder.found.app);
        subRuntimes.add(folder.runtime);
        warnings.push(...folder.found.warnings.map((w) => `${folder.found!.app.dir}: ${w}`));
        if (folder.found.depsMissing) warnings.push(`Dependencies missing in ${folder.found.app.dir}: use Install dependencies.`);
        continue;
      }
    }
    const pkg = readJson<PackageJson>(join(dir, 'package.json'));
    if (!pkg) continue;
    const prisma = hasPrisma(dir, pkg);
    if (prisma && prismaDir === null) prismaDir = relative(root, dir) || '.';
    // Electron Forge starts with `start` (no dev script).
    const electronScript = isElectron(pkg) ? (pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : null) : null;
    const script = devScriptName(pkg);
    if (!script && !electronScript) {
      if (monorepo && pkg.scripts?.build) libs.push({ dir: relative(root, dir), name: pkg.name ?? basename(dir), build: true, dev: false });
      continue;
    }
    const framework = detectFramework(pkg);
    if (electronScript) {
      // A desktop app: its window is the app, so no port to wait for or to manage (electron-vite's renderer dev
      // server only works inside that window, with its preload).
      const command = runScriptCommand(pm, electronScript);
      apps.push({ dir: relative(root, dir) || '.', name: pkg.name ?? basename(dir), framework, library: 'electron', kind: 'web', devScript: pkg.scripts![electronScript], command, port: null, configuredPort: null, portVars: [], managedPort: false, portSource: null, portFlag: false, flagCommand: null, prisma, domain: '' });
      continue;
    }
    const { port, vars, source } = detectPort(dir, root, pkg, framework);
    // An app that reads no port variable gets its own port on the command line: in a monorepo every app defaults to
    // the same one, and so do two worktrees (or two copies) of one Astro / Vite site.
    const flagCommand = !vars.length ? portFlagCommand(pm, script!, pkg.scripts![script!]) : null;
    // A workspace without a server (e.g. `tsc --watch` in packages/shared-types)
    // still runs as part of the root dev script, but gets no domain.
    if (framework === 'node' && port === null) {
      if (monorepo && script === 'dev') libs.push({ dir: relative(root, dir), name: pkg.name ?? basename(dir), build: Boolean(pkg.scripts?.build), dev: true });
      continue;
    }
    apps.push({
      dir: relative(root, dir) || '.',
      name: pkg.name ?? basename(dir),
      framework,
      library: framework === 'express' ? detectServer(pkg) : null,
      kind: ['nestjs', 'express', 'node'].includes(framework) ? 'api' : 'web',
      devScript: pkg.scripts![script!],
      // Run app by app, a NestJS app starts with `start:dev`, not `dev` (which `<pm> run dev` would look for).
      command: script !== 'dev' ? runScriptCommand(pm, script!) : null,
      port,
      configuredPort: port,
      portVars: vars,
      managedPort: false,
      // A port DevCatz can replace on the command line is not one the app keeps.
      portSource: flagCommand ? null : (source ?? null),
      portFlag: Boolean(flagCommand),
      flagCommand,
      prisma,
      domain: '',
    });
  }
  if (prismaDir === null && existsSync(join(root, 'prisma'))) prismaDir = '.';

  // Go services living next to the JS apps (e.g. api/ with a go.mod beside web/).
  for (const dir of findGoModules(root)) apps.push(detectGoApp(dir, root, ''));
  // …and Rust crates (apps/api with a Cargo.toml): each runs `cargo run`, trunk, dx … from its folder.
  for (const app of findRustApps(root)) if (!apps.some((a) => a.dir === app.dir)) apps.push(app);

  // The first web app owns the bare domain (one named web / frontend / app … before an admin); the others get `<dir>.<domain>`.
  apps.sort((a, b) => (a.kind === b.kind ? mainRank(a) - mainRank(b) : a.kind === 'web' ? -1 : 1));
  apps.forEach((app, i) => {
    app.domain = i === 0 ? domain : `${slugify(basename(app.dir === '.' ? root : app.dir))}.${domain}`;
  });

  let devCommand: string | null = null;
  const rootScript = devScriptName(rootPkg);
  if (rootScript && !monorepo) devCommand = runScriptCommand(pm, rootScript);
  else if (rootPkg?.scripts?.dev) devCommand = runScriptCommand(pm, 'dev');
  else if (apps.length === 1 && monorepo) devCommand = `cd ${apps[0].dir} && ${apps[0].command ?? runScriptCommand(pm, 'dev')}`;
  // No dev script at the root (bun / npm workspaces of apps/web + apps/api): Start runs every app from its folder.
  else if (apps.length > 1 && monorepo) devCommand = `${apps.length} apps, each from its folder`;
  // Tauri (src-tauri/ beside a Vite frontend): `tauri dev` opens the app's window and starts the frontend through
  // its beforeDevCommand; the site's domain still shows the frontend in a browser.
  if (rootPkg?.scripts?.tauri && existsSync(join(root, 'src-tauri', 'tauri.conf.json')) && apps.length === 1) {
    devCommand = `${runScriptCommand(pm, 'tauri')} dev`;
    apps[0].library = 'tauri';
  }
  // Electron Forge at the root: `start`.
  if (!devCommand && apps.length === 1 && apps[0].library === 'electron' && apps[0].dir === '.') devCommand = apps[0].command ?? null;

  const nvmrc = readText(join(root, '.nvmrc'))?.trim() || readText(join(root, '.node-version'))?.trim();

  return {
    packageManager: pm,
    detectedPackageManager: pm,
    monorepo,
    devCommand,
    apps,
    database: detectDatabase(root, candidates),
    redis: detectRedis(root, candidates),
    prismaDir,
    node: nvmrc || rootPkg?.engines?.node || null,
    runtime: 'node',
    depsMissing: !hasDependencies(root),
    warnings: [...portClashes(apps), ...warnings],
    libs,
    layout: monorepo ? 'workspaces' : undefined,
    ...(subRuntimes.size ? { subRuntimes: [...subRuntimes] } : {}),
  };
}

/** node_modules exists and has something in it (bun's isolated layout included). */
export function hasDependencies(root: string): boolean {
  try {
    return readdirSync(join(root, 'node_modules')).length > 0;
  } catch {
    return false;
  }
}

/** 0 for the folder names of a main frontend (web, frontend, app, site, client, www), else 1. */
export const mainRank = (a: AppInfo) => (/^(web|frontend|front|app|site|client|www|ui)$/i.test(basename(a.dir)) ? 0 : 1);

export function portClashes(apps: AppInfo[]): string[] {
  const byPort = new Map<number, string[]>();
  for (const a of apps) if (a.port) byPort.set(a.port, [...(byPort.get(a.port) ?? []), a.name]);
  return [...byPort.entries()]
    .filter(([, names]) => names.length > 1)
    .map(([port, names]) => `${names.join(' and ')} both use port ${port}; give each its own port (e.g. in .env).`);
}

export const nodeDriver: RuntimeDriver = {
  id: 'node',
  matches: isPackage,
  detect: detectNodeStack,
};
