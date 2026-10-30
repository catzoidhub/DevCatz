import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { AppInfo, DatabaseInfo, Framework, StackInfo, StackTask } from '@shared/types';
import { detectDatabase, detectPackageManager, firstExisting, readJson, readText, type PackageJson } from '../detect';
import { detectRedis } from '../redis';
import type { RuntimeDriver } from './types';

interface ComposerJson {
  name?: string;
  require?: Record<string, string>;
  'require-dev'?: Record<string, string>;
}

/**
 * A PHP project: composer.json with a front controller, or (no Composer) a
 * WordPress / CodeIgniter 3 / Joomla tree, or plain PHP with an index.php.
 */
const isPhpProject = (dir: string) => {
  const has = (f: string) => existsSync(join(dir, f));
  if (has('composer.json') && (has('artisan') || has('public/index.php') || has('index.php') || has('web/index.php') || has('webroot/index.php') || has('spark') || has('yii')))
    return true;
  return has('wp-load.php') || has('system/core/CodeIgniter.php') || (has('index.php') && !has('package.json')) || (has('public/index.php') && !has('package.json'));
};

interface PhpShape {
  framework: Framework;
  /** Document root of the main app. */
  docroot: string;
  /** Extra apps on their own subdomain (Yii advanced backend). */
  extra: { name: string; docroot: string; label: string }[];
  tasks: StackTask[];
}

const task = (tool: string, id: string, label: string, command: string, extra: Partial<StackTask> = {}): StackTask => ({ id, tool, label, command, cwd: '.', ...extra });

/** Which framework, where its front controller lives, and the commands worth a button. */
function phpShape(root: string, composer: ComposerJson): PhpShape {
  const has = (f: string) => existsSync(join(root, f));
  const req = { ...composer.require, ...composer['require-dev'] };
  const shape = (framework: Framework, docroot: string, tasks: StackTask[] = [], extra: PhpShape['extra'] = []): PhpShape => ({ framework, docroot, tasks, extra });
  if (has('artisan') && req['laravel/framework']) return shape('laravel', 'public');
  if (has('spark') || req['codeigniter4/framework']) {
    return shape('codeigniter', 'public', [
      task('spark', 'migrate', 'migrate', 'php spark migrate'),
      task('spark', 'seed', 'db:seed…', 'php spark db:seed {name}', { needsName: true, namePlaceholder: 'DatabaseSeeder' }),
      task('spark', 'make-migration', 'make:migration…', 'php spark make:migration {name}', { needsName: true, namePlaceholder: 'CreateUsersTable' }),
      task('spark', 'rollback', 'migrate:rollback', 'php spark migrate:rollback -f', { danger: true }),
    ]);
  }
  if (has('system/core/CodeIgniter.php') || req['codeigniter/framework']) return shape('codeigniter', has('public/index.php') ? 'public' : '.');
  const yii = (dirs: string) => [
    task('yii', 'migrate', 'migrate', `php ${dirs}yii migrate --interactive=0`),
    task('yii', 'migrate-create', 'migrate/create…', `php ${dirs}yii migrate/create {name} --interactive=0`, { needsName: true, namePlaceholder: 'create_post_table' }),
    task('yii', 'migrate-down', 'migrate/down', `php ${dirs}yii migrate/down --interactive=0`, { danger: true }),
  ];
  if (has('frontend/web/index.php') && has('backend/web/index.php'))
    return shape('yii', 'frontend/web', yii(''), [{ name: 'backend', docroot: 'backend/web', label: 'backend' }]);
  if (has('web/index.php') && (has('yii') || req['yiisoft/yii2'])) return shape('yii', 'web', yii(''));
  if (has('bin/console') && (req['symfony/framework-bundle'] || req['symfony/runtime'])) {
    return shape('symfony', 'public', [
      task('console', 'migrate', 'doctrine:migrations:migrate', 'php bin/console doctrine:migrations:migrate -n'),
      task('console', 'make-migration', 'make:migration', 'php bin/console make:migration -n'),
      task('console', 'cache-clear', 'cache:clear', 'php bin/console cache:clear'),
    ]);
  }
  if (has('bin/cake') || req['cakephp/cakephp']) {
    return shape('cakephp', 'webroot', [
      task('cake', 'migrate', 'migrations migrate', 'bin/cake migrations migrate'),
      task('cake', 'rollback', 'migrations rollback', 'bin/cake migrations rollback', { danger: true }),
      task('cake', 'cache', 'cache clear_all', 'bin/cake cache clear_all'),
    ]);
  }
  const wpTasks = [
    task('WP-CLI', 'rewrite', 'rewrite flush', 'wp rewrite flush', { needsBin: 'wp' }),
    task('WP-CLI', 'cache', 'cache flush', 'wp cache flush', { needsBin: 'wp' }),
    task('WP-CLI', 'plugins', 'plugin list', 'wp plugin list', { needsBin: 'wp' }),
  ];
  if (has('wp-load.php')) return shape('wordpress', '.', wpTasks);
  // Bedrock (Roots): WordPress under web/wp.
  if (has('web/wp/wp-load.php') || req['roots/wordpress']) return shape('wordpress', 'web', wpTasks.map((t) => ({ ...t, command: `${t.command} --path=web/wp` })));
  if (has('core/lib/Drupal.php') || has('web/core/lib/Drupal.php')) {
    return shape('drupal', has('web/index.php') ? 'web' : '.', [task('drush', 'cr', 'cache:rebuild', 'vendor/bin/drush cr'), task('drush', 'updb', 'updatedb', 'vendor/bin/drush updb -y')]);
  }
  if (has('administrator/index.php') && (has('libraries/src') || has('libraries/joomla'))) return shape('joomla', '.');
  if (req['slim/slim']) return shape('slim', has('public/index.php') ? 'public' : '.');
  return shape('php', has('public/index.php') ? 'public' : '.');
}

/** WordPress keeps its database in wp-config.php (define('DB_NAME', …)), not .env. */
function wpDatabase(root: string, docroot: string): DatabaseInfo | null {
  const cfg = readText(join(root, docroot, 'wp-config.php')) ?? readText(join(root, 'wp-config.php'));
  if (!cfg) return null;
  const val = (k: string) => cfg.match(new RegExp(`define\\(\\s*['"]${k}['"]\\s*,\\s*['"]([^'"]*)['"]`))?.[1] ?? null;
  const [host, port] = (val('DB_HOST') ?? 'localhost').split(':');
  return { engine: 'mysql', composeFile: null, service: null, image: null, host, hostPort: Number(port) || 3306, database: val('DB_NAME') };
}

/**
 * PHP sites (Laravel first). They are served by PHP-FPM through the proxy
 * (always on, like Laravel Herd); "Start" only runs the extras: the Vite dev
 * server (laravel-vite-plugin) and, for Laravel, optional queue/scheduler.
 */
function detectPhpStack(root: string, domain: string): StackInfo {
  const composer = readJson<ComposerJson>(join(root, 'composer.json')) ?? {};
  const shape = phpShape(root, composer);
  const laravel = shape.framework === 'laravel';
  const docroot = shape.docroot;
  const pkg = readJson<PackageJson>(join(root, 'package.json'));
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const pm = pkg ? detectPackageManager(root, pkg) : null;

  const apps: AppInfo[] = [
    {
      dir: '.',
      // The skeleton's own name says nothing about the app.
      name: composer.name && composer.name !== 'laravel/laravel' ? composer.name : basename(root),
      framework: shape.framework,
      kind: 'web',
      devScript: null,
      // Served through PHP-FPM, no port of its own.
      port: null,
      configuredPort: null,
      portVars: [],
      managedPort: false,
      prisma: false,
      domain,
      docroot,
    },
    // Yii advanced: the backend app on its own subdomain (backend.<site>).
    ...shape.extra.map(
      (x): AppInfo => ({
        dir: '.',
        name: x.name,
        framework: shape.framework,
        kind: 'web',
        devScript: null,
        port: null,
        configuredPort: null,
        portVars: [],
        managedPort: false,
        prisma: false,
        domain: `${x.label}.${domain}`,
        docroot: x.docroot,
      }),
    ),
  ];

  // laravel-vite-plugin dev server: same origin as the site (the proxy routes /@vite, /resources, … to it).
  if (pkg?.scripts?.dev && deps.vite) {
    const cfg = readText(firstExisting(root, ['vite.config.js', 'vite.config.ts', 'vite.config.mjs']) ?? '') ?? '';
    const port = Number(cfg.match(/server\s*:\s*\{[^}]*?port\s*:\s*(\d+)/s)?.[1]) || 5173;
    apps.push({
      dir: '.',
      name: 'vite',
      framework: 'vite',
      kind: 'assets',
      devScript: pkg.scripts.dev,
      port,
      configuredPort: port,
      // Vite takes `--port` on the command line; DevCatz passes its managed port there.
      portVars: [],
      portFlag: true,
      managedPort: false,
      prisma: false,
      domain: '',
    });
  }

  // Laravel Mix (webpack) builds into public/; `mix watch` rebuilds on change. No dev server or port.
  if (!apps.some((a) => a.kind === 'assets') && deps['laravel-mix']) {
    apps.push({
      dir: '.',
      name: 'mix',
      framework: 'mix',
      kind: 'assets',
      devScript: pkg?.scripts?.watch ?? null,
      port: null,
      configuredPort: null,
      portVars: [],
      managedPort: false,
      prisma: false,
      domain: '',
      command: pkg?.scripts?.watch ? runWatch(pm ?? 'npm') : 'npx mix watch',
    });
  }

  const envFile = existsSync(join(root, '.env'));
  const warnings: string[] = [];
  if (laravel && !envFile) warnings.push('No .env yet: copy .env.example to .env and run `php artisan key:generate`.');
  if (shape.framework === 'codeigniter' && existsSync(join(root, 'env')) && !envFile) warnings.push('No .env yet: copy the `env` file to `.env` (CodeIgniter 4).');
  if (shape.framework === 'wordpress' && !existsSync(join(root, docroot, 'wp-config.php')) && !existsSync(join(root, 'wp-config.php')))
    warnings.push('No wp-config.php yet: open the site to run the WordPress installer.');

  return {
    packageManager: pm,
    detectedPackageManager: pm,
    monorepo: false,
    devCommand: null,
    apps,
    database: shape.framework === 'wordpress' ? (wpDatabase(root, docroot) ?? detectDatabase(root)) : detectDatabase(root),
    redis: detectRedis(root, []),
    prismaDir: null,
    node: null,
    runtime: 'php',
    // Only Composer projects have a vendor/ to install (WordPress, CI3 and plain PHP may have none).
    depsMissing: existsSync(join(root, 'composer.json')) && !existsSync(join(root, 'vendor/autoload.php')),
    tasks: shape.tasks,
    jsDepsMissing: Boolean(pkg) && !hasNodeModules(root),
    warnings,
    libs: [],
  };
}

const runWatch = (pm: string) => (pm === 'yarn' ? 'yarn watch' : `${pm} run watch`);

function hasNodeModules(root: string): boolean {
  try {
    return readdirSync(join(root, 'node_modules')).length > 0;
  } catch {
    return false;
  }
}

/**
 * A PHP project in a folder of another site (frontend/ + backend/, a workspace's apps/api): one `api` app DevCatz
 * runs from that folder on its own port — Laravel through `artisan serve`, other PHP through PHP's built-in server
 * — instead of PHP-FPM. Null when the folder has nothing to serve.
 */
export function phpFolderApp(root: string, dir: string): { app: AppInfo; depsMissing: boolean; warnings: string[] } | null {
  const s = detectPhpStack(dir, '');
  const web = s.apps.find((a) => a.kind === 'web');
  if (!web) return null;
  const laravel = existsSync(join(dir, 'artisan'));
  const docroot = web.docroot ?? '.';
  const command = laravel ? 'php artisan serve --host=127.0.0.1 --port=${PORT:-8000}' : `php -S 127.0.0.1:\${PORT:-8000} -t ${docroot}`;
  return {
    depsMissing: s.depsMissing,
    warnings: s.warnings,
    app: { ...web, dir: relative(root, dir), kind: 'api', docroot: undefined, devScript: command, command, port: 8000, configuredPort: 8000, portVars: ['PORT'], managedPort: false, portFlag: false, flagCommand: null, domain: '' },
  };
}

export const phpDriver: RuntimeDriver = {
  id: 'php',
  matches: isPhpProject,
  detect: detectPhpStack,
};
