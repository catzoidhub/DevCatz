import { isPhpFramework, isPythonFramework, type BunChoice, type NodeChoice, type ProjectState, type StackInfo } from '@shared/types';
import { STACK_ICONS, type StackIcon } from './stackicons';

/** One language runtime a site uses, for the Runtimes card and the version pickers. */
export interface RuntimeRow {
  kind: 'node' | 'bun' | 'go' | 'php' | 'python';
  label: string;
  version: string | null;
  /** Why this version, in words. */
  why: string;
  missing: boolean;
  /** Apps that run on it. */
  apps: string[];
}

const appName = (dir: string, name: string) => (dir === '.' ? name : dir.split('/').pop()!);

export const usesJs = (stack: StackInfo) =>
  (stack.runtime === 'node' && stack.apps.some((a) => a.framework !== 'go')) || ((stack.runtime === 'php' || stack.runtime === 'python') && stack.apps.some((a) => a.kind === 'assets'));
export const usesPhp = (stack: StackInfo) => stack.runtime === 'php';
export const usesPython = (stack: StackInfo) => stack.runtime === 'python';

/** "Install dependencies (uv sync)" — what the button runs for a Python site. */
export function pythonInstallLabel(stack: StackInfo): string {
  const t = stack.python?.tool;
  return t === 'poetry' ? 'poetry install' : t === 'pdm' ? 'pdm install' : t === 'pipenv' ? 'pipenv install' : t === 'uv' ? 'uv sync' : 'uv venv + pip install';
}
export const usesGo = (stack: StackInfo) => stack.apps.some((a) => a.framework === 'go');
export const usesBun = (stack: StackInfo) => usesJs(stack) && stack.packageManager === 'bun';

function nodeWhy(c: NodeChoice): string {
  if (c.reason === 'site') return 'chosen for this site';
  if (c.reason === 'nvmrc') return `matches ${c.spec} (.nvmrc / engines)`;
  if (c.reason === 'default') return c.missing ? `default; the project asks for ${c.spec}, not installed` : 'default version';
  return "your shell's node";
}

function choiceWhy(c: BunChoice, file: string): string {
  if (c.reason === 'site') return 'chosen for this site';
  if (c.reason === 'project') return `matches ${c.spec} (${file})`;
  if (c.reason === 'default') return c.missing && c.spec ? `default; ${file} asks for ${c.spec}` : 'default version';
  if (c.reason === 'system') return c.missing && c.spec ? `your own; ${file} asks for ${c.spec}` : 'your own installation';
  return 'not installed';
}

export function runtimesOf(p: ProjectState): RuntimeRow[] {
  const rows: RuntimeRow[] = [];
  const js = p.stack.apps.filter((a) => a.framework !== 'go' && !isPhpFramework(a.framework) && !isPythonFramework(a.framework)).map((a) => appName(a.dir, a.name));
  const go = p.stack.apps.filter((a) => a.framework === 'go').map((a) => appName(a.dir, a.name));
  if (usesJs(p.stack)) {
    rows.push({ kind: 'node', label: 'Node.js', version: p.node.version, why: nodeWhy(p.node), missing: p.node.missing, apps: js });
    if (usesBun(p.stack)) rows.push({ kind: 'bun', label: 'Bun', version: p.bun.version, why: choiceWhy(p.bun, 'packageManager'), missing: !p.bun.version, apps: js });
  }
  if (usesPhp(p.stack)) {
    const c = p.php;
    const why =
      c.reason === 'site' ? 'chosen for this site' : c.reason === 'project' ? `matches ${c.spec} (composer.json)` : c.reason === 'default' ? (c.missing && c.spec ? `default; composer.json asks for ${c.spec}` : 'default version') : c.version ? `composer.json asks for ${c.spec}; closest installed` : 'not installed';
    rows.unshift({ kind: 'php', label: 'PHP', version: c.version, why: why + (c.source === 'herd' ? ' · Laravel Herd build' : ''), missing: !c.version || c.missing, apps: [appName('.', p.name)] });
  }
  if (usesGo(p.stack)) rows.push({ kind: 'go', label: 'Go', version: p.go.version, why: choiceWhy(p.go, 'go.mod'), missing: !p.go.version, apps: go });
  if (usesPython(p.stack)) {
    const c = p.python;
    const venv = p.stack.python?.venv;
    const why =
      c.reason === 'venv'
        ? `${venv} (${p.stack.python?.tool})`
        : c.reason === 'site'
          ? 'chosen for this site; used when the venv is created'
          : c.reason === 'project'
            ? `matches ${c.spec}; used when the venv is created`
            : c.reason === 'none'
              ? 'no Python yet: Install dependencies fetches one'
              : `${c.reason === 'default' ? 'default' : 'newest installed'}${c.spec ? `; the project asks for ${c.spec}` : ''}`;
    rows.unshift({ kind: 'python', label: 'Python', version: c.version, why, missing: !c.version || (c.missing && c.reason !== 'venv'), apps: [appName('.', p.name)] });
  }
  return rows;
}

/** What the status dot shows: PHP sites count as running while PHP-FPM serves them. */
export function siteStatus(p: ProjectState): ProjectState['status'] {
  return p.status === 'stopped' && p.served ? 'running' : p.status;
}

/** PHP sites: Start has something to run (Vite/Mix, queue worker, scheduler). */
export const hasExtras = (p: ProjectState) =>
  p.stack.runtime !== 'php' || p.stack.apps.some((a) => a.kind === 'assets') || Boolean(p.queueWorker || p.scheduler);

/** Per-app processes (monorepos and Go services) when DevCatz manages the ports. */
export function runsPerApp(p: ProjectState): boolean {
  // Sibling projects (frontend/ + backend/) always run app by app, from their folders.
  if (p.stack.layout === 'folders') return !p.devCommand;
  if (p.stack.runtime === 'php') return false;
  const multi = p.stack.monorepo || p.stack.apps.some((a) => a.framework === 'go' && a.dir !== '.');
  return multi && !p.devCommand && p.managedPorts !== false && p.stack.packageManager !== null;
}

/** What starts this app: its own command in per-app mode, else the site's dev command. */
export function appCommand(p: ProjectState, app: ProjectState['stack']['apps'][number]): string {
  // An app that reads no port variable runs with its managed port on the command line (Vite, Astro …).
  const single = !runsPerApp(p) && p.stack.apps.length === 1 && !p.devCommand;
  if ((runsPerApp(p) || single) && app.managedPort && app.flagCommand && app.port) return app.flagCommand.replace('{port}', String(app.port));
  if (p.stack.layout === 'folders' && app.command) return app.command.replace(/^env (?:\S+=\S+ )+/, '');
  if (isPhpFramework(app.framework)) return `PHP-FPM ${p.php.version ?? ''} (always on)`;
  if (app.framework === 'mix') return app.command ?? 'npx mix watch';
  if (app.kind === 'assets') {
    const pm = p.stack.packageManager ?? 'npm';
    return `${pm === 'yarn' ? 'yarn dev' : `${pm} run dev`}${pm === 'npm' ? ' --' : ''} --port ${app.port}`;
  }
  if (runsPerApp(p)) {
    if (app.command) return app.command;
    const pm = p.stack.packageManager ?? 'npm';
    return pm === 'yarn' ? 'yarn dev' : `${pm} run dev`;
  }
  return p.devCommand || p.stack.devCommand || '—';
}

/** Framework (or language) → its name and mark in STACK_ICONS. */
const TAGS: Record<string, [string, string]> = {
  laravel: ['Laravel', 'laravel'],
  mix: ['Laravel', 'laravel'],
  php: ['PHP', 'php'],
  codeigniter: ['CodeIgniter', 'codeigniter'],
  yii: ['Yii', 'yii'],
  symfony: ['Symfony', 'symfony'],
  cakephp: ['CakePHP', 'cakephp'],
  wordpress: ['WordPress', 'wordpress'],
  drupal: ['Drupal', 'drupal'],
  joomla: ['Joomla', 'joomla'],
  slim: ['Slim', 'slim'],
  go: ['Go', 'go'],
  nuxt: ['Nuxt', 'nuxtdotjs'],
  'vite-vue': ['Vue', 'vuedotjs'],
  'vite-react': ['React', 'react'],
  'tanstack-start': ['TanStack Start', 'tanstack'],
  next: ['Next.js', 'nextdotjs'],
  nestjs: ['NestJS', 'nestjs'],
  astro: ['Astro', 'astro'],
  sveltekit: ['SvelteKit', 'svelte'],
  vite: ['Vite', 'vite'],
  express: ['Express', 'express'],
  node: ['Node.js', 'nodedotjs'],
  django: ['Django', 'django'],
  flask: ['Flask', 'flask'],
  fastapi: ['FastAPI', 'fastapi'],
  litestar: ['Litestar', 'litestar'],
  python: ['Python', 'python'],
};

/**
 * Web frameworks of Go, Python and Node apps (AppInfo.library): their own name
 * and mark (Simple Icons, or the project's own logo in assets/logos/fw;
 * httprouter has none and keeps the Go mark).
 */
const LIBRARIES: Record<string, [string, string]> = {
  gin: ['Gin', 'gin'],
  echo: ['Echo', 'echo'],
  fiber: ['Fiber', 'fiber'],
  chi: ['Chi', 'chi'],
  gorilla: ['Gorilla mux', 'gorilla'],
  beego: ['Beego', 'beego'],
  iris: ['Iris', 'iris'],
  buffalo: ['Buffalo', 'buffalo'],
  hertz: ['Hertz', 'hertz'],
  kratos: ['Kratos', 'kratos'],
  'go-zero': ['go-zero', 'gozero'],
  gofr: ['GoFr', 'gofr'],
  httprouter: ['httprouter', 'go'],
  starlette: ['Starlette', 'starlette'],
  quart: ['Quart', 'quart'],
  sanic: ['Sanic', 'sanic'],
  tornado: ['Tornado', 'tornado'],
  pyramid: ['Pyramid', 'pyramid'],
  falcon: ['Falcon', 'falcon'],
  bottle: ['Bottle', 'bottle'],
  aiohttp: ['aiohttp', 'aiohttp'],
  blacksheep: ['BlackSheep', 'blacksheep'],
  fastify: ['Fastify', 'fastify'],
  hono: ['Hono', 'hono'],
  koa: ['Koa', 'koa'],
  express: ['Express', 'express'],
};

/** The name and mark of a framework; a Go / Python app's own web framework (`library`) wins when known. */
export function frameworkTag(fw: string, library?: string | null): { label: string; icon: StackIcon } {
  const [label, icon] = (library && LIBRARIES[library]) || TAGS[fw] || ['JavaScript', 'javascript'];
  return { label, icon: STACK_ICONS[icon] ?? STACK_ICONS.javascript };
}

/** The site's framework (or language) for the site list: its web app's mark and name (Laravel, Nuxt, Go, …). */
export function stackTag(p: ProjectState): { label: string; icon: StackIcon } {
  const web = p.stack.apps.find((a) => a.kind === 'web') ?? p.stack.apps[0];
  return frameworkTag(web?.framework ?? (p.stack.runtime === 'go' ? 'go' : p.stack.runtime === 'python' ? 'python' : 'node'), web?.library);
}

/**
 * Every framework the site's apps use, the site list's one first (a monorepo's
 * Next.js web app and NestJS API; Vite asset servers behind a PHP site are not
 * frameworks of their own). Each with the apps that use it.
 */
export function siteFrameworks(p: ProjectState): { label: string; icon: StackIcon; apps: string[]; main: boolean }[] {
  const main = stackTag(p);
  const out: { label: string; icon: StackIcon; apps: string[]; main: boolean }[] = [{ ...main, apps: [], main: true }];
  for (const a of p.stack.apps) {
    if (a.kind === 'assets') continue;
    const t = frameworkTag(a.framework, a.library);
    const hit = out.find((x) => x.label === t.label);
    if (hit) hit.apps.push(a.name);
    else out.push({ ...t, apps: [a.name], main: false });
  }
  return out;
}

/**
 * Why an app keeps its own port instead of one DevCatz assigns, in plain words: where the port is written (the file
 * and line of `const port = 3000`, the dev script's `--port 3000`), and what would let DevCatz assign one. Null when
 * DevCatz assigns it.
 */
export function portWhy(p: ProjectState, app: ProjectState['stack']['apps'][number]): { title: string; detail: string } | null {
  if (app.managedPort || app.docroot !== undefined || app.kind === 'assets') return null;
  if (p.managedPorts === false) return { title: 'From the project', detail: '“Let DevCatz assign dev ports” is off for this site, so the ports in its .env / config are used.' };
  const s = app.portSource;
  if (s?.file === 'package.json') return { title: `Fixed in package.json:${s.line}`, detail: `The dev script sets it (${s.code}). Remove --port there to let DevCatz assign one.` };
  if (s) return { title: `Written in ${s.file}:${s.line}`, detail: `${s.code} — the code sets this port itself, so DevCatz cannot change it. An app that reads it from the environment (e.g. Number(process.env.PORT) || ${app.port ?? 3000}) gets its own port from DevCatz.` };
  if (app.portVars.length) return { title: 'Shared with another app', detail: `${app.portVars.join(', ')} is read by more than one app of this project, so one value cannot tell them apart; give each its own variable.` };
  return { title: 'Default port', detail: `DevCatz found no port setting it could change, so it expects the framework's default (${app.port ?? '?'}).` };
}
