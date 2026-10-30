import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { AppInfo, Framework, PythonStack, StackInfo, StackTask } from '@shared/types';
import { DEFAULT_PORTS, detectDatabase, readText } from '../detect';
import { detectRedis } from '../redis';
import type { RuntimeDriver } from './types';

/**
 * Python projects: a dev server on a managed port (PORT), run from the
 * project's virtualenv. Django → `manage.py runserver`, ASGI apps (FastAPI,
 * Starlette, Quart, Litestar …) → uvicorn with reload, Flask → `flask run`,
 * anything else → `python main.py`. Dependencies come from pyproject.toml
 * (PEP 621, Poetry), requirements*.txt or Pipfile; DevCatz installs them into
 * `.venv` with uv (or the project's own Poetry / PDM / Pipenv).
 */

const has = (root: string, f: string) => existsSync(join(root, f));
const isPython = (dir: string) =>
  ['manage.py', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'setup.py'].some((f) => has(dir, f)) &&
  // A JS app with a pyproject for tooling stays a JS app, unless it is clearly a Python web app.
  (!has(dir, 'package.json') || has(dir, 'manage.py') || Boolean(webFramework(dependencies(dir))));

/** Lower-cased distribution names the project depends on. */
/** Package names the project depends on (requirements*.txt, pyproject, Pipfile), lower-case. */
export function pythonDependencies(root: string): Set<string> {
  return dependencies(root);
}

function dependencies(root: string): Set<string> {
  const out = new Set<string>();
  const add = (spec: string) => {
    const name = spec
      .trim()
      .replace(/^["']|["'],?$/g, '')
      .match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/)?.[1];
    if (name) out.add(name.toLowerCase().replace(/_/g, '-'));
  };
  const py = readText(join(root, 'pyproject.toml')) ?? '';
  // [project] dependencies = [ "django>=5", … ] and optional groups.
  for (const block of py.matchAll(/^\s*(?:dependencies|dev|test)\s*=\s*\[([\s\S]*?)\]/gm)) for (const item of block[1].split(',')) add(item);
  // Poetry: [tool.poetry.dependencies] name = "^1"
  const poetry = py.match(/\[tool\.poetry(?:\.group\.\w+)?\.dependencies\]([\s\S]*?)(?:\n\[|$)/g) ?? [];
  for (const sec of poetry) for (const m of sec.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)) if (m[1] !== 'python') add(m[1]);
  for (const f of safeList(root).filter((n) => /^requirements.*\.txt$/.test(n)).concat(safeList(join(root, 'requirements')).map((n) => `requirements/${n}`))) {
    for (const line of (readText(join(root, f)) ?? '').split('\n')) if (line.trim() && !line.trim().startsWith('#') && !line.trim().startsWith('-')) add(line);
  }
  const pipfile = readText(join(root, 'Pipfile')) ?? '';
  for (const sec of pipfile.match(/\[(?:dev-)?packages\]([\s\S]*?)(?:\n\[|$)/g) ?? []) for (const m of sec.matchAll(/^([A-Za-z0-9_.-]+)\s*=/gm)) add(m[1]);
  return out;
}

function safeList(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function webFramework(deps: Set<string>): string | null {
  for (const f of ['django', 'fastapi', 'litestar', 'flask', 'starlette', 'quart', 'sanic', 'tornado', 'pyramid', 'falcon', 'bottle', 'aiohttp', 'blacksheep']) if (deps.has(f)) return f;
  return null;
}

/** Python files worth scanning for the app object (top level, app/, src/<pkg>/, api/). */
function candidates(root: string): string[] {
  const out: string[] = [];
  const add = (rel: string) => has(root, rel) && !out.includes(rel) && out.push(rel);
  for (const f of ['main.py', 'app.py', 'server.py', 'asgi.py', 'wsgi.py', 'run.py', 'application.py']) add(f);
  for (const d of ['app', 'api', 'src', 'backend']) {
    for (const f of ['main.py', 'app.py', '__init__.py', 'server.py', 'asgi.py']) add(`${d}/${f}`);
    for (const pkg of safeList(join(root, d))) for (const f of ['main.py', 'app.py', '__init__.py', 'asgi.py']) add(`${d}/${pkg}/${f}`);
  }
  return out;
}

/** `app/main.py` → `app.main` (module path for uvicorn / flask --app); src/ layouts drop the src. */
const moduleOf = (rel: string) =>
  rel
    .replace(/\.py$/, '')
    .replace(/\/__init__$/, '')
    .replace(/^src\//, '')
    .replace(/\//g, '.');

/** First file defining `<var> = <Ctor>(` → "module:var". */
function findApp(root: string, ctor: RegExp): string | null {
  for (const rel of candidates(root)) {
    const src = readText(join(root, rel)) ?? '';
    const m = src.match(new RegExp(`^([A-Za-z_][A-Za-z0-9_]*)\\s*(?::\\s*\\w+\\s*)?=\\s*${ctor.source}`, 'm'));
    if (m) return `${moduleOf(rel)}:${m[1]}`;
    // Flask app factory.
    if (/Flask/.test(ctor.source) && /def create_app\(/.test(src)) return `${moduleOf(rel)}:create_app()`;
  }
  return null;
}

function detectVenv(root: string): { dir: string | null; version: string | null } {
  for (const d of ['.venv', 'venv', 'env', '.env-py']) {
    if (!has(root, `${d}/bin/python`)) continue;
    const cfg = readText(join(root, d, 'pyvenv.cfg')) ?? '';
    return { dir: d, version: cfg.match(/^version(?:_info)?\s*=\s*([\d.]+)/m)?.[1] ?? null };
  }
  return { dir: null, version: null };
}

function pythonSpec(root: string): string | null {
  const pinned = readText(join(root, '.python-version'))?.trim().split('\n')[0];
  if (pinned && /^\d+(\.\d+){0,2}$/.test(pinned)) return pinned;
  const py = readText(join(root, 'pyproject.toml')) ?? '';
  const req = py.match(/^requires-python\s*=\s*["']([^"']+)["']/m)?.[1] ?? py.match(/^python\s*=\s*["']([^"']+)["']/m)?.[1];
  return req?.replace(/\s/g, '') ?? null;
}

function detectPythonStack(root: string, domain: string): StackInfo {
  const deps = dependencies(root);
  const web = webFramework(deps);
  const manage = has(root, 'manage.py') ? 'manage.py' : (['src', 'app', 'backend'].map((d) => `${d}/manage.py`).find((f) => has(root, f)) ?? null);
  const py = readText(join(root, 'pyproject.toml')) ?? '';
  const tool: PythonStack['tool'] = has(root, 'uv.lock') || /\[tool\.uv\]/.test(py)
    ? 'uv'
    : has(root, 'poetry.lock') || /\[tool\.poetry\]/.test(py)
      ? 'poetry'
      : has(root, 'pdm.lock') || /\[tool\.pdm\]/.test(py)
        ? 'pdm'
        : has(root, 'Pipfile')
          ? 'pipenv'
          : /^\s*dependencies\s*=/m.test(py)
            ? 'uv'
            : 'pip';

  let framework: Framework = 'python';
  let command: string | null = null;
  let port = DEFAULT_PORTS.python ?? 8000;
  const tasks: StackTask[] = [];
  const uvicorn = (target: string) => `python -m uvicorn ${target} --reload --host 127.0.0.1 --port \${PORT:-${port}}`;

  if (manage || web === 'django') {
    framework = 'django';
    port = DEFAULT_PORTS.django ?? 8000;
    const m = manage ?? 'manage.py';
    command = `python ${m} runserver 127.0.0.1:\${PORT:-${port}}`;
    tasks.push(
      { id: 'migrate', tool: 'Django', label: 'migrate', command: `python ${m} migrate`, cwd: '.' },
      { id: 'makemigrations', tool: 'Django', label: 'makemigrations', command: `python ${m} makemigrations`, cwd: '.' },
      { id: 'collectstatic', tool: 'Django', label: 'collectstatic', command: `python ${m} collectstatic --noinput`, cwd: '.' },
      { id: 'check', tool: 'Django', label: 'check', command: `python ${m} check`, cwd: '.' },
      {
        id: 'superuser',
        tool: 'Django',
        label: 'createsuperuser…',
        // Non-interactive: the password is "password" (change it in the admin); the name is what the user types.
        command: `DJANGO_SUPERUSER_PASSWORD=password python ${m} createsuperuser --noinput --username {name} --email admin@example.com`,
        cwd: '.',
        needsName: true,
        namePlaceholder: 'admin',
      },
    );
  } else if (web === 'fastapi' || web === 'starlette' || web === 'quart' || web === 'falcon' || web === 'blacksheep') {
    framework = web === 'fastapi' ? 'fastapi' : 'python';
    const ctor = { fastapi: /FastAPI\(/, starlette: /Starlette\(/, quart: /Quart\(/, falcon: /falcon\.(?:asgi\.)?App\(/, blacksheep: /Application\(/ }[web];
    const target = findApp(root, ctor) ?? 'main:app';
    command = uvicorn(target);
  } else if (web === 'litestar') {
    framework = 'litestar';
    const target = findApp(root, /Litestar\(/) ?? 'app:app';
    command = `python -m litestar --app ${target} run --reload --host 127.0.0.1 --port \${PORT:-${port}}`;
  } else if (web === 'flask') {
    framework = 'flask';
    port = DEFAULT_PORTS.flask ?? 5000;
    const target = findApp(root, /Flask\(/);
    command = `python -m flask${target ? ` --app ${target}` : ''} run --debug --host 127.0.0.1 --port \${PORT:-${port}}`;
    if (deps.has('flask-migrate')) {
      const app = target ? ` --app ${target}` : '';
      tasks.push(
        { id: 'db-upgrade', tool: 'Flask-Migrate', label: 'db upgrade', command: `python -m flask${app} db upgrade`, cwd: '.' },
        { id: 'db-migrate', tool: 'Flask-Migrate', label: 'db migrate…', command: `python -m flask${app} db migrate -m {name}`, cwd: '.', needsName: true, namePlaceholder: 'add users' },
      );
    }
  } else if (web === 'sanic') {
    const target = findApp(root, /Sanic\(/) ?? 'server:app';
    command = `python -m sanic ${target} --dev --host 127.0.0.1 --port \${PORT:-${port}}`;
  } else {
    // Tornado, aiohttp, Pyramid, Bottle, plain scripts: run the entry file; it should read PORT.
    const entry = ['main.py', 'app.py', 'server.py', 'run.py'].find((f) => has(root, f));
    command = entry ? `python ${entry}` : null;
  }
  // Alembic (SQLAlchemy / SQLModel), wherever the app is.
  if (has(root, 'alembic.ini')) {
    tasks.push(
      { id: 'alembic-upgrade', tool: 'Alembic', label: 'upgrade head', command: 'python -m alembic upgrade head', cwd: '.' },
      { id: 'alembic-revision', tool: 'Alembic', label: 'revision --autogenerate…', command: 'python -m alembic revision --autogenerate -m {name}', cwd: '.', needsName: true, namePlaceholder: 'add users' },
      { id: 'alembic-downgrade', tool: 'Alembic', label: 'downgrade -1', command: 'python -m alembic downgrade -1', cwd: '.', danger: true },
    );
  }

  // Celery: the app module (Django project package with celery.py, or a top-level celery_app/tasks module).
  let celery: string | null = null;
  if (deps.has('celery')) {
    const djangoPkg = safeList(root).find((d) => has(root, `${d}/settings.py`) || has(root, `${d}/celery.py`));
    celery = djangoPkg ?? (['celery_app', 'tasks', 'worker', 'app'].find((m) => has(root, `${m}.py`) || has(root, `${m}/__init__.py`)) ?? 'app');
  }

  const venv = detectVenv(root);
  const name = py.match(/^name\s*=\s*["']([^"']+)["']/m)?.[1] ?? basename(root);
  // Frameworks DevCatz starts like any Python app keep their own name for the label (Starlette, Sanic, aiohttp …).
  const library = framework === 'python' && web && ['starlette', 'quart', 'sanic', 'tornado', 'pyramid', 'falcon', 'bottle', 'aiohttp', 'blacksheep'].includes(web) ? web : null;
  const app: AppInfo = {
    dir: '.',
    name,
    framework,
    library,
    kind: 'web',
    devScript: command,
    port,
    configuredPort: port,
    // DevCatz assigns the port and passes it as PORT (the commands above read $PORT).
    portVars: ['PORT'],
    managedPort: false,
    prisma: false,
    domain,
    command,
  };
  const warnings: string[] = [];
  if (!command) warnings.push('No entry point found (manage.py, an ASGI/WSGI app, main.py or app.py): set a dev command in the site settings.');
  return {
    packageManager: null,
    detectedPackageManager: null,
    monorepo: false,
    devCommand: command,
    apps: [app],
    database: detectDatabase(root),
    redis: detectRedis(root, []),
    prismaDir: null,
    node: null,
    runtime: 'python',
    depsMissing: !venv.dir,
    warnings,
    libs: [],
    tasks,
    python: { tool, venv: venv.dir, venvVersion: venv.version, spec: pythonSpec(root), celery },
  };
}

/**
 * A Python project in a folder of another site (client/ + server/, a workspace's apps/api): one `api` app run from
 * that folder's own venv (the site-wide one is the root's). Null when the folder has nothing to run.
 */
export function pythonFolderApp(root: string, dir: string): { app: AppInfo; depsMissing: boolean; warnings: string[] } | null {
  const s = detectPythonStack(dir, '');
  const app = s.apps[0];
  if (!app?.command) return null;
  const venv = s.python?.venv ? join(dir, s.python.venv) : null;
  const command = venv ? `env VIRTUAL_ENV="${venv}" PATH="${venv}/bin:$PATH" PYTHONUNBUFFERED=1 ${app.command}` : `env PYTHONUNBUFFERED=1 ${app.command}`;
  return { depsMissing: s.depsMissing, warnings: s.warnings, app: { ...app, dir: relative(root, dir), kind: 'api', devScript: app.command, command, domain: '' } };
}

export const pythonDriver: RuntimeDriver = {
  id: 'python',
  matches: isPython,
  detect: detectPythonStack,
};
