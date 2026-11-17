import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { AppInfo, FrameworkVersion, StackInfo } from '@shared/types';

/**
 * Which version of its framework each app uses (TODO §41: "Laravel 13.2", "Vue 3.5"), on every platform. Read from the
 * project's own files only — no network, nothing run: the installed version first (lockfile, node_modules, the
 * virtualenv), the declared range as a fallback (`exact: false`, shown as "13.x"). Files are cached by their mtime, so
 * detecting a stack again re-reads only what changed.
 */

type Eco = 'npm' | 'composer' | 'pypi' | 'gem' | 'go' | 'cargo';
type Want = { eco: Eco; names: string[] };

/** The package that carries each framework's version. */
const FRAMEWORK_PKG: Partial<Record<AppInfo['framework'], Want>> = {
  nuxt: { eco: 'npm', names: ['nuxt'] },
  next: { eco: 'npm', names: ['next'] },
  'vite-vue': { eco: 'npm', names: ['vue'] },
  'vite-react': { eco: 'npm', names: ['react'] },
  'vite-svelte': { eco: 'npm', names: ['svelte'] },
  'tanstack-start': { eco: 'npm', names: ['@tanstack/react-start', '@tanstack/solid-start', '@tanstack/start'] },
  vite: { eco: 'npm', names: ['vite'] },
  astro: { eco: 'npm', names: ['astro'] },
  sveltekit: { eco: 'npm', names: ['@sveltejs/kit'] },
  angular: { eco: 'npm', names: ['@angular/core'] },
  nestjs: { eco: 'npm', names: ['@nestjs/core'] },
  express: { eco: 'npm', names: ['express'] },
  mix: { eco: 'npm', names: ['laravel-mix'] },
  laravel: { eco: 'composer', names: ['laravel/framework'] },
  codeigniter: { eco: 'composer', names: ['codeigniter4/framework', 'codeigniter/framework'] },
  yii: { eco: 'composer', names: ['yiisoft/yii2', 'yiisoft/yii-http'] },
  symfony: { eco: 'composer', names: ['symfony/framework-bundle', 'symfony/http-kernel'] },
  cakephp: { eco: 'composer', names: ['cakephp/cakephp'] },
  drupal: { eco: 'composer', names: ['drupal/core', 'drupal/core-recommended'] },
  slim: { eco: 'composer', names: ['slim/slim'] },
  django: { eco: 'pypi', names: ['django'] },
  flask: { eco: 'pypi', names: ['flask'] },
  fastapi: { eco: 'pypi', names: ['fastapi'] },
  litestar: { eco: 'pypi', names: ['litestar'] },
  rails: { eco: 'gem', names: ['rails'] },
  sinatra: { eco: 'gem', names: ['sinatra'] },
  hanami: { eco: 'gem', names: ['hanami'] },
  jekyll: { eco: 'gem', names: ['jekyll'] },
};

/** A Go / Rust / Python / Ruby / Node app's own web framework (`library`) → its package. */
const LIBRARY_PKG: Record<string, Want> = {
  // Go: module paths (the major-version suffix is matched as a prefix)
  goravel: { eco: 'go', names: ['github.com/goravel/framework'] },
  gin: { eco: 'go', names: ['github.com/gin-gonic/gin'] },
  echo: { eco: 'go', names: ['github.com/labstack/echo'] },
  fiber: { eco: 'go', names: ['github.com/gofiber/fiber'] },
  chi: { eco: 'go', names: ['github.com/go-chi/chi'] },
  gorilla: { eco: 'go', names: ['github.com/gorilla/mux'] },
  beego: { eco: 'go', names: ['github.com/beego/beego', 'github.com/astaxie/beego'] },
  iris: { eco: 'go', names: ['github.com/kataras/iris'] },
  buffalo: { eco: 'go', names: ['github.com/gobuffalo/buffalo'] },
  hertz: { eco: 'go', names: ['github.com/cloudwego/hertz'] },
  kratos: { eco: 'go', names: ['github.com/go-kratos/kratos'] },
  'go-zero': { eco: 'go', names: ['github.com/zeromicro/go-zero'] },
  gofr: { eco: 'go', names: ['gofr.dev'] },
  httprouter: { eco: 'go', names: ['github.com/julienschmidt/httprouter'] },
  // Rust crates
  anchor: { eco: 'cargo', names: ['anchor-lang'] },
  tauri: { eco: 'cargo', names: ['tauri'] },
  loco: { eco: 'cargo', names: ['loco-rs'] },
  leptos: { eco: 'cargo', names: ['leptos'] },
  dioxus: { eco: 'cargo', names: ['dioxus'] },
  yew: { eco: 'cargo', names: ['yew'] },
  sycamore: { eco: 'cargo', names: ['sycamore'] },
  actix: { eco: 'cargo', names: ['actix-web'] },
  axum: { eco: 'cargo', names: ['axum'] },
  rocket: { eco: 'cargo', names: ['rocket'] },
  warp: { eco: 'cargo', names: ['warp'] },
  poem: { eco: 'cargo', names: ['poem'] },
  salvo: { eco: 'cargo', names: ['salvo'] },
  tide: { eco: 'cargo', names: ['tide'] },
  tonic: { eco: 'cargo', names: ['tonic'] },
  hyper: { eco: 'cargo', names: ['hyper'] },
  bevy: { eco: 'cargo', names: ['bevy'] },
  burn: { eco: 'cargo', names: ['burn'] },
  candle: { eco: 'cargo', names: ['candle-core'] },
  // Python
  starlette: { eco: 'pypi', names: ['starlette'] },
  quart: { eco: 'pypi', names: ['quart'] },
  sanic: { eco: 'pypi', names: ['sanic'] },
  tornado: { eco: 'pypi', names: ['tornado'] },
  pyramid: { eco: 'pypi', names: ['pyramid'] },
  falcon: { eco: 'pypi', names: ['falcon'] },
  bottle: { eco: 'pypi', names: ['bottle'] },
  aiohttp: { eco: 'pypi', names: ['aiohttp'] },
  blacksheep: { eco: 'pypi', names: ['blacksheep'] },
  // Node servers and desktop
  fastify: { eco: 'npm', names: ['fastify'] },
  hono: { eco: 'npm', names: ['hono'] },
  koa: { eco: 'npm', names: ['koa'] },
  express: { eco: 'npm', names: ['express'] },
  electron: { eco: 'npm', names: ['electron'] },
  // Ruby
  bridgetown: { eco: 'gem', names: ['bridgetown'] },
  middleman: { eco: 'gem', names: ['middleman'] },
  padrino: { eco: 'gem', names: ['padrino'] },
  rage: { eco: 'gem', names: ['rage-rb'] },
  roda: { eco: 'gem', names: ['roda'] },
  grape: { eco: 'gem', names: ['grape'] },
  cuba: { eco: 'gem', names: ['cuba'] },
  hobbit: { eco: 'gem', names: ['hobbit'] },
  scorched: { eco: 'gem', names: ['scorched'] },
  nyny: { eco: 'gem', names: ['nyny'] },
  camping: { eco: 'gem', names: ['camping'] },
  ramaze: { eco: 'gem', names: ['ramaze'] },
  ramverk: { eco: 'gem', names: ['ramverk'] },
  goliath: { eco: 'gem', names: ['goliath'] },
  cramp: { eco: 'gem', names: ['cramp'] },
  volt: { eco: 'gem', names: ['volt'] },
  rack: { eco: 'gem', names: ['rack'] },
};

/** The libraries that change how a framework's project is written, shown next to it (Laravel + Livewire / Inertia). */
const EXTRAS: Partial<Record<AppInfo['framework'], { label: string; want: Want }[]>> = {
  laravel: [
    { label: 'Livewire', want: { eco: 'composer', names: ['livewire/livewire'] } },
    { label: 'Inertia', want: { eco: 'composer', names: ['inertiajs/inertia-laravel'] } },
    { label: 'Filament', want: { eco: 'composer', names: ['filament/filament'] } },
    // the frontend an Inertia / Vite app is written in
    { label: 'Vue', want: { eco: 'npm', names: ['vue'] } },
    { label: 'React', want: { eco: 'npm', names: ['react'] } },
  ],
  nuxt: [{ label: 'Vue', want: { eco: 'npm', names: ['vue'] } }],
  next: [{ label: 'React', want: { eco: 'npm', names: ['react'] } }],
  sveltekit: [{ label: 'Svelte', want: { eco: 'npm', names: ['svelte'] } }],
  'tanstack-start': [{ label: 'React', want: { eco: 'npm', names: ['react'] } }],
};

// ---------------------------------------------------------------- files, cached by mtime

const cache = new Map<string, { mtime: number; text: string | null }>();
function read(file: string): string | null {
  let mtime: number;
  try {
    mtime = statSync(file).mtimeMs;
  } catch {
    cache.delete(file);
    return null;
  }
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.text;
  let text: string | null = null;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    /* unreadable */
  }
  cache.set(file, { mtime, text });
  return text;
}
const json = <T>(file: string): T | null => {
  const t = read(file);
  if (!t) return null;
  try {
    return JSON.parse(t) as T;
  } catch {
    return null;
  }
};
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** The folders from the app's own up to the project root: the nearest lockfile wins. */
function upTo(dir: string, root: string): string[] {
  const out: string[] = [];
  let d = resolve(dir);
  const top = resolve(root);
  for (;;) {
    out.push(d);
    if (d === top || !d.startsWith(top + sep)) break;
    d = dirname(d);
  }
  return out;
}

/** "1.2.3" / "v1.2.3" → "1.2.3"; a range ("^13.0", ">=5.1,<6", "~> 7.1") → its major (or 0.minor), not exact. */
function exact(v: string | null | undefined): FrameworkVersion | null {
  const m = v?.trim().replace(/^[v=]+/, '').match(/^\d+(?:\.\d+){0,3}(?:[-+][\w.-]+)?/);
  return m ? { version: m[0], exact: true } : null;
}
function range(r: string | null | undefined): FrameworkVersion | null {
  const m = r?.match(/(\d+)(?:\.(\d+))?/);
  if (!m) return null;
  return { version: m[1] === '0' && m[2] ? `0.${m[2]}` : m[1], exact: false };
}

// ---------------------------------------------------------------- per ecosystem

function npmVersion(dirs: string[], appDir: string, root: string, name: string): FrameworkVersion | null {
  // What is installed for this app (a workspace's own node_modules, else hoisted ones further up).
  for (const d of dirs) {
    const v = exact(json<{ version?: string }>(join(d, 'node_modules', name, 'package.json'))?.version);
    if (v) return v;
  }
  for (const d of dirs) {
    const rel = relative(d, appDir).split(sep).join('/');
    const lock = json<{ packages?: Record<string, { version?: string }>; dependencies?: Record<string, { version?: string }> }>(join(d, 'package-lock.json'));
    if (lock) {
      const v = exact(lock.packages?.[`${rel ? `${rel}/` : ''}node_modules/${name}`]?.version ?? lock.packages?.[`node_modules/${name}`]?.version ?? lock.dependencies?.[name]?.version);
      if (v) return v;
    }
    const bun = read(join(d, 'bun.lock'));
    if (bun) {
      const v = exact(bun.match(new RegExp(`"${esc(name)}": \\[\\s*"${esc(name)}@([^"]+)"`))?.[1]);
      if (v) return v;
    }
    const pnpm = read(join(d, 'pnpm-lock.yaml'));
    if (pnpm) {
      // The importer of this app first (pnpm 7–9: `importers:` → `<dir>:` → `dependencies:` → `<name>:` → `version:`).
      const imp = pnpm.match(new RegExp(`\\n  ${rel ? esc(rel) : '\\.'}:\\n([\\s\\S]*?)(?=\\n  \\S|$)`))?.[1] ?? '';
      const v =
        exact(imp.match(new RegExp(`\\n {6}'?${esc(name)}'?:\\n {8}specifier: [^\\n]*\\n {8}version: ([^\\s(]+)`))?.[1]) ??
        exact(pnpm.match(new RegExp(`\\n  '?/?${esc(name)}[@/](\\d[^:'(\\s]*)`))?.[1]);
      if (v) return v;
    }
    const yarn = read(join(d, 'yarn.lock'));
    if (yarn) {
      const v = exact(yarn.match(new RegExp(`\\n"?${esc(name)}@[^\\n]*:\\n\\s+version:? "?([^"\\n]+)`))?.[1]);
      if (v) return v;
    }
    if (d === resolve(root)) break;
  }
  const pkg = json<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(join(appDir, 'package.json'));
  return range(pkg?.dependencies?.[name] ?? pkg?.devDependencies?.[name]);
}

function composerVersion(dirs: string[], name: string): FrameworkVersion | null {
  for (const d of dirs) {
    const lock = json<{ packages?: { name: string; version: string }[]; 'packages-dev'?: { name: string; version: string }[] }>(join(d, 'composer.lock'));
    const hit = [...(lock?.packages ?? []), ...(lock?.['packages-dev'] ?? [])].find((p) => p.name === name);
    const v = exact(hit?.version);
    if (v) return v;
    const installed = json<{ packages?: { name: string; version: string }[] } | { name: string; version: string }[]>(join(d, 'vendor', 'composer', 'installed.json'));
    const list = Array.isArray(installed) ? installed : (installed?.packages ?? []);
    const v2 = exact(list.find((p) => p.name === name)?.version);
    if (v2) return v2;
  }
  for (const d of dirs) {
    const c = json<{ require?: Record<string, string> }>(join(d, 'composer.json'));
    const v = range(c?.require?.[name]);
    if (v) return v;
  }
  return null;
}

/** PHP apps that ship their own code instead of a Composer package. */
function phpBundled(dir: string, docroot: string | undefined, framework: AppInfo['framework']): FrameworkVersion | null {
  const bases = [...new Set([dir, docroot ? join(dir, docroot) : dir])];
  for (const b of bases) {
    if (framework === 'wordpress') {
      const v = exact(read(join(b, 'wp-includes', 'version.php'))?.match(/\$wp_version\s*=\s*'([^']+)'/)?.[1]);
      if (v) return v;
    }
    if (framework === 'drupal') {
      const v = exact(read(join(b, 'core', 'lib', 'Drupal.php'))?.match(/const VERSION\s*=\s*'([^']+)'/)?.[1]);
      if (v) return v;
    }
    if (framework === 'joomla') {
      const t = read(join(b, 'libraries', 'src', 'Version.php'));
      const part = (k: string) => t?.match(new RegExp(`const ${k}\\s*=\\s*(\\d+)`))?.[1];
      if (part('MAJOR_VERSION')) return { version: [part('MAJOR_VERSION'), part('MINOR_VERSION') ?? '0', part('PATCH_VERSION') ?? '0'].join('.'), exact: true };
    }
    if (framework === 'codeigniter') {
      const v = exact(read(join(b, 'system', 'core', 'CodeIgniter.php'))?.match(/CI_VERSION',\s*'([^']+)'/)?.[1]);
      if (v) return v;
    }
  }
  return null;
}

const norm = (n: string) => n.toLowerCase().replace(/[-_.]+/g, '-');

function pypiVersion(dirs: string[], name: string): FrameworkVersion | null {
  const want = norm(name);
  for (const d of dirs) {
    // The virtualenv the site runs with: <name>-<version>.dist-info
    for (const venv of ['.venv', 'venv', 'env']) {
      for (const lib of [join(d, venv, 'Lib', 'site-packages'), ...pyLibs(join(d, venv, 'lib'))]) {
        try {
          for (const e of readdirSync(lib)) {
            const m = e.match(/^(.+?)-(\d[^-]*)\.dist-info$/);
            if (m && norm(m[1]) === want) return exact(m[2]);
          }
        } catch {
          /* no such venv */
        }
      }
    }
    for (const f of ['uv.lock', 'poetry.lock']) {
      const t = read(join(d, f));
      const m = t && [...t.matchAll(/\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g)].find((x) => norm(x[1]) === want);
      if (m) return exact(m[2]);
    }
    const pipfile = json<{ default?: Record<string, { version?: string }>; develop?: Record<string, { version?: string }> }>(join(d, 'Pipfile.lock'));
    if (pipfile) {
      const all = { ...pipfile.develop, ...pipfile.default };
      const key = Object.keys(all).find((k) => norm(k) === want);
      const v = key ? exact(all[key].version?.replace(/^==/, '')) : null;
      if (v) return v;
    }
    const req = read(join(d, 'requirements.txt'));
    const line = req?.split(/\r?\n/).find((l) => norm(l.split(/[\s=<>~!;[]/)[0] ?? '') === want);
    if (line) {
      const pinned = line.match(/==\s*([\w.]+)/)?.[1];
      return pinned ? exact(pinned) : range(line.slice(name.length));
    }
    const py = read(join(d, 'pyproject.toml'));
    if (py) {
      const m = py.match(new RegExp(`["']${esc(name)}(?:\\[[^\\]]*\\])?\\s*([^"']*)["']`, 'i')) ?? py.match(new RegExp(`^${esc(name)}\\s*=\\s*(?:\\{[^}]*version\\s*=\\s*)?"([^"]+)"`, 'im'));
      if (m) return m[1].includes('==') ? exact(m[1].split('==')[1]) : range(m[1]);
    }
  }
  return null;
}
function pyLibs(lib: string): string[] {
  try {
    return readdirSync(lib)
      .filter((e) => e.startsWith('python'))
      .map((e) => join(lib, e, 'site-packages'));
  } catch {
    return [];
  }
}

function gemVersion(dirs: string[], name: string): FrameworkVersion | null {
  for (const d of dirs) {
    const v = exact(read(join(d, 'Gemfile.lock'))?.match(new RegExp(`\\n {4}${esc(name)} \\(([^)]+)\\)`))?.[1]);
    if (v) return v;
  }
  for (const d of dirs) {
    const m = read(join(d, 'Gemfile'))?.match(new RegExp(`gem\\s+["']${esc(name)}["']\\s*,\\s*["']([^"']+)["']`));
    if (m) return /^[\d.]+$/.test(m[1].trim()) ? exact(m[1]) : range(m[1]);
  }
  return null;
}

function goVersion(dirs: string[], names: string[]): FrameworkVersion | null {
  for (const d of dirs) {
    const mod = read(join(d, 'go.mod'));
    if (!mod) continue;
    for (const n of names) {
      const v = exact(mod.match(new RegExp(`\\n\\s*(?:require\\s+)?${esc(n)}(?:/v\\d+)?\\s+(v[\\w.+-]+)`))?.[1]);
      if (v) return { version: v.version.replace(/\+incompatible$/, ''), exact: true };
    }
  }
  return null;
}

function cargoVersion(dirs: string[], name: string): FrameworkVersion | null {
  for (const d of dirs) {
    const v = exact(read(join(d, 'Cargo.lock'))?.match(new RegExp(`\\[\\[package\\]\\]\\s*\\nname = "${esc(name)}"\\s*\\nversion = "([^"]+)"`))?.[1]);
    if (v) return v;
  }
  for (const d of dirs) {
    const toml = read(join(d, 'Cargo.toml'));
    const m = toml?.match(new RegExp(`^${esc(name)}\\s*=\\s*(?:"([^"]+)"|\\{[^}]*version\\s*=\\s*"([^"]+)")`, 'm'));
    if (m) return range(m[1] ?? m[2]);
  }
  return null;
}

function find(want: Want, dirs: string[], appDir: string, root: string): FrameworkVersion | null {
  for (const n of want.names) {
    const v =
      want.eco === 'npm'
        ? npmVersion(dirs, appDir, root, n)
        : want.eco === 'composer'
          ? composerVersion(dirs, n)
          : want.eco === 'pypi'
            ? pypiVersion(dirs, n)
            : want.eco === 'gem'
              ? gemVersion(dirs, n)
              : want.eco === 'cargo'
                ? cargoVersion(dirs, n)
                : null;
    if (v) return v;
  }
  return want.eco === 'go' ? goVersion(dirs, want.names) : null;
}

/** One app's framework version, and its main libraries' (Laravel + Livewire …). */
export function frameworkVersion(root: string, app: AppInfo): FrameworkVersion | null {
  const appDir = join(root, app.dir);
  if (!existsSync(appDir)) return null;
  const want = (app.library && LIBRARY_PKG[app.library]) || FRAMEWORK_PKG[app.framework];
  // A Tauri app keeps its crate (and Cargo.lock) in src-tauri/.
  const dirs = [...(want?.eco === 'cargo' && existsSync(join(appDir, 'src-tauri')) ? [join(appDir, 'src-tauri')] : []), ...upTo(appDir, root)];
  const own = (want ? find(want, dirs, appDir, root) : null) ?? (['wordpress', 'drupal', 'joomla', 'codeigniter'].includes(app.framework) ? phpBundled(appDir, app.docroot, app.framework) : null);
  if (!own) return null;
  const extras = (app.library ? [] : (EXTRAS[app.framework] ?? []))
    .map((x) => ({ label: x.label, ...find(x.want, dirs, appDir, root) }))
    .filter((x): x is { label: string; version: string; exact: boolean } => !!x.version);
  return extras.length ? { ...own, extras } : own;
}

/** Every app of a detected stack gets its version (TODO §41). */
export function withFrameworkVersions(root: string, stack: StackInfo): StackInfo {
  for (const a of stack.apps) {
    try {
      a.frameworkVersion = frameworkVersion(root, a);
    } catch {
      a.frameworkVersion = null;
    }
  }
  return stack;
}
