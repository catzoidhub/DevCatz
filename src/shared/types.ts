import { keyLabel } from './platform';

export type PackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

export type Framework =
  | 'nuxt'
  | 'next'
  | 'vite-vue'
  | 'vite-react'
  | 'tanstack-start'
  | 'vite'
  | 'astro'
  | 'sveltekit'
  | 'nestjs'
  | 'express'
  | 'node'
  | 'go'
  // Rust (cargo run, trunk, dx …; the web framework in `library`)
  | 'rust'
  | 'mix'
  // PHP (served by PHP-FPM)
  | 'laravel'
  | 'codeigniter'
  | 'yii'
  | 'symfony'
  | 'cakephp'
  | 'wordpress'
  | 'drupal'
  | 'joomla'
  | 'slim'
  | 'php'
  // Python (a dev server on a managed port)
  | 'django'
  | 'flask'
  | 'fastapi'
  | 'litestar'
  | 'python';

/** PHP frameworks: served by PHP-FPM from a document root, no dev server of their own. */
export const PHP_FRAMEWORKS: Framework[] = ['laravel', 'codeigniter', 'yii', 'symfony', 'cakephp', 'wordpress', 'drupal', 'joomla', 'slim', 'php'];
export const PYTHON_FRAMEWORKS: Framework[] = ['django', 'flask', 'fastapi', 'litestar', 'python'];
export const isPhpFramework = (f: Framework) => PHP_FRAMEWORKS.includes(f);
export const isPythonFramework = (f: Framework) => PYTHON_FRAMEWORKS.includes(f);

/** One runnable app inside a project (the project itself, or a workspace). */
export interface AppInfo {
  /** Workspace-relative directory ('.' for a single-package project). */
  dir: string;
  name: string;
  framework: Framework;
  /** `web` apps are what a browser opens; `api` apps are backends; `assets` = a Vite dev server behind a PHP site (no domain of its own). */
  kind: 'web' | 'api' | 'assets';
  /**
   * The web framework a Go or Python app is built on when DevCatz runs it like
   * any app of that language (gin, echo, fiber, chi … / starlette, sanic,
   * aiohttp …): for its label and mark only. Null when none was recognised.
   */
  library?: string | null;
  devScript: string | null;
  /** Port the dev server listens on (the managed one when DevCatz assigns ports). */
  port: number | null;
  /** Port the project itself would use (.env / config), for reference. */
  configuredPort: number | null;
  /** Env vars the app reads its port from, e.g. ['PORT', 'WEB_PORT']. */
  portVars: string[];
  /** DevCatz assigns and injects this app's port (instead of using .env). */
  managedPort: boolean;
  /**
   * Where a port DevCatz cannot assign comes from: the line that writes it into the code (`app.js:13`,
   * `const port = 3000;`) or the dev script's `--port 3000`. Shown so it is clear why the app keeps it.
   */
  portSource?: { file: string; line: number; code: string } | null;
  /** Command for this app when it runs on its own (Go apps; JS apps use `<pm> run dev`). */
  command?: string | null;
  /** PHP sites: document root relative to the project (`public` for Laravel). */
  docroot?: string;
  /** The managed port goes on the command line (`--port N`) instead of an env var (Vite behind Laravel). */
  portFlag?: boolean;
  /**
   * Monorepo / folder apps whose dev server reads no port variable (Vite, Astro … default to the same port in every
   * app): the command that runs it on a given port, `{port}` replaced at start, e.g. `bun run dev --port {port}`.
   */
  flagCommand?: string | null;
  prisma: boolean;
  /** Domain this app is served on, e.g. `api.shop.localhost` (or `.test`). */
  domain: string;
}

/** Where a site's OpenAPI document is (Overview → API, and DevCatz/bridge.json for DialCatz). */
/** Report a Bug / Send Feedback (Catzoid #65). */
export type ReportKind = 'bug' | 'idea' | 'question';
/** A screenshot attached to a bug report (Catzoid #67): PNG or JPEG, base64, already re-encoded in the window. */
export interface ReportShot {
  type: 'image/png' | 'image/jpeg';
  data: string;
}
/** "Preview what is sent": the request exactly as it goes out. */
export interface ReportPreview {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}
export interface ReportsState {
  crashReports: boolean;
  /** Ask once, after the first crash or error, whether to send crash reports. */
  askCrash: boolean;
  /** Reports waiting for the site to answer again. */
  queued: number;
  site: string;
}

/** Uninstall DevCatz (Catzoid #55): what it would remove. */
export interface UninstallPlan {
  /** The .app (null in a development build). */
  app: string | null;
  /** Installed with Homebrew: `brew uninstall --cask devcatz` instead of the Trash. */
  homebrew: boolean;
  dataDir: string;
  /** LaunchDaemons and /etc/resolver files (one admin prompt). */
  systemFiles: string[];
  /** Other Catzoid apps on this Mac: then the shared settings stay unless asked. */
  otherCatzoidApps: string[];
  sharedDir: string;
  sharedKeys: string[];
}

/** DevCatz's own update (Catzoid #54), from the feed `<site>/updates/devcatz/`. */
export interface AppUpdateState {
  status: 'idle' | 'checking' | 'none' | 'available' | 'downloading' | 'downloaded' | 'error';
  /** The installed version. */
  current: string;
  /** The newer version found (available / downloading / downloaded). */
  version: string | null;
  date: string | null;
  /** Bytes of the update download (the zip). */
  size: number | null;
  /** Release notes of every version after the installed one, newest first (Markdown). */
  notes: { version: string; date: string | null; notes: string }[];
  progress: { percent: number; transferred: number; total: number; bytesPerSecond: number } | null;
  lastChecked: number | null;
  /** In plain words. */
  error: string | null;
  /** The feed address (the shared site address + /updates/devcatz/). */
  feed: string;
  /** Install the downloaded update when DevCatz quits. */
  installOnQuit: boolean;
  /** A development build: it can check, but only a packaged DevCatz installs. */
  dev: boolean;
}

/** Settings → About (Catzoid family #62): the build, and the shared site address the links are built from. */
export interface AboutInfo {
  version: string;
  arch: string;
  macos: string;
  electron: string;
  chrome: string;
  node: string;
  /** The shared Catzoid site address (Catzoid/shared.json `site`), e.g. https://catzoid.com — no trailing slash. */
  site: string;
  dataDir: string;
}

export interface SiteOpenApi {
  /** A spec file in the project and / or a URL a running app serves it on; `app` = the app's folder. */
  specs: { app: string; file?: string; url?: string }[];
  /** What DevCatz can add when there is none: Scramble (Laravel), @nestjs/swagger (NestJS). */
  install: 'scramble' | 'nest-swagger' | null;
  /** How this stack gets one, when DevCatz cannot add it (FastAPI's built-in, swag for Go …). */
  hint: string | null;
  /** The running apps were asked for their document (false while the site is stopped). */
  probed: boolean;
}

/** One thing the site's Build button can build (header → Build ▾). */
export interface BuildTarget {
  /** 'all' = every app (the root build script, or each target in turn); else the app's folder. */
  id: string;
  label: string;
  command: string;
  /** Folder it runs in, relative to the site. */
  cwd: string;
}

/** A folder of installed dependencies (TODO §30: free disk space on old projects). */
export interface DepFolder {
  /** Relative to the site, e.g. `node_modules`, `apps/web/node_modules`, `vendor`, `.venv`. */
  path: string;
  kind: 'node_modules' | 'vendor' | 'venv' | 'target';
  bytes: number;
}
/** A site's dependency folders and how long ago it was used. */
export interface SiteDeps {
  siteId: string;
  name: string;
  folders: DepFolder[];
  bytes: number;
  /** Last start by DevCatz, else the newest change in the project's own files (ms). */
  lastUsed: number | null;
  /** Last start by DevCatz (ms), when known. */
  lastStarted: number | null;
  running: boolean;
}

export interface DatabaseInfo {
  engine: 'postgres' | 'mysql' | 'mariadb' | 'sqlite' | 'unknown';
  /** null when the database is external (only known from DATABASE_URL); start/stop is then unavailable. */
  composeFile: string | null;
  service: string | null;
  image: string | null;
  /** Host from DATABASE_URL / DB_HOST (external databases), e.g. `localhost`. */
  host?: string | null;
  /** Database name (Laravel DB_DATABASE), when known. */
  database?: string | null;
  hostPort: number | null;
}

export interface RedisInfo {
  /** Redis client found in package.json (ioredis, bullmq, …), if any. */
  client: string | null;
  configuredBy: 'REDIS_URL' | 'REDIS_HOST' | 'default';
  host: string;
  port: number;
  db: number;
  /** Valkey (BSD fork, same protocol) or Redis, from the compose image / client / URL. */
  flavor: 'redis' | 'valkey';
  /** Laravel's cache connection (REDIS_CACHE_DB), when .env sets it. */
  cacheDb: number | null;
  /**
   * Laravel: further connections in config/database.php with their own index
   * (`'database' => env('REDIS_VISIT_DB', '3')`); `db` = .env value, else the default there.
   */
  connections: { name: string; envKey: string; db: number; fromEnv: boolean }[];
  hasPassword: boolean;
  /** Set when the app uses the compose file's redis service. */
  composeFile: string | null;
  service: string | null;
  image: string | null;
  /** Host is this Mac (or a published compose port), so status can be read. */
  reachable: boolean;
}

export interface RedisDetails {
  status: 'running' | 'stopped' | 'unknown';
  error?: string;
  /** What actually answers (INFO server_name / valkey_version). */
  server?: 'redis' | 'valkey';
  version?: string | null;
  memory?: string | null;
  clients?: number;
  uptimeDays?: number;
  keyspace?: { db: number; keys: number; expires: number }[];
}

export interface StackInfo {
  /** null for non-Node projects (Go). */
  packageManager: PackageManager | null;
  /** What the lockfile says, before a site's override. */
  detectedPackageManager: PackageManager | null;
  monorepo: boolean;
  /** Command run by "Start", e.g. `bun run dev`. */
  devCommand: string | null;
  apps: AppInfo[];
  database: DatabaseInfo | null;
  redis: RedisInfo | null;
  /** Workspace-relative dir that owns `prisma/schema.prisma`, if any. */
  prismaDir: string | null;
  node: string | null;
  /** `go` for Go modules (go.mod), `node` for package.json projects, `python` for pyproject/requirements/manage.py. */
  runtime: 'node' | 'go' | 'php' | 'python' | 'rust';
  /** Framework commands for the Database tab (CodeIgniter spark, Yii, Symfony console, CakePHP, WP-CLI, Django, Alembic …). */
  tasks?: StackTask[];
  /** ORMs, query builders and migration tools the site uses (Database tab); their CLIs' commands are in `tasks`. */
  dataLibs?: DataLib[];
  /** Python projects: venv, tool and version wishes. */
  python?: PythonStack;
  /** Dependencies not installed: node_modules (JS) or vendor/ (PHP, `composer install`). */
  depsMissing: boolean;
  /** PHP sites with a package.json: node_modules missing (Vite cannot start). */
  jsDepsMissing?: boolean;
  /** Problems worth showing, e.g. two apps on the same port. */
  warnings: string[];
  /** Monorepo workspaces without a server (shared packages): built before the apps start. */
  libs: { dir: string; name: string; build: boolean; dev: boolean }[];
  /**
   * `folders`: a project made of sibling projects in their own folders (frontend/ + backend/, apps/web + api/ with
   * different languages) instead of one JS workspace; every app runs as its own process, from its folder.
   */
  layout?: 'workspaces' | 'folders';
  /** Languages of the folder apps besides the stack's own runtime (their tools go on PATH). */
  subRuntimes?: ('node' | 'php' | 'python' | 'go' | 'rust')[];
}

export interface ProjectConfig {
  id: string;
  name: string;
  path: string;
  /** A Git worktree of another site (its id): listed under it, with its own branch, domain and ports. */
  worktreeOf?: string;
  /** Primary domain, e.g. `shop.localhost` (suffix = Settings → Default domain). */
  domain: string;
  /** Set when the project comes from a parked folder rather than an explicit link. */
  parkedFrom?: string;
  /** Overrides the detected dev command. */
  devCommand?: string;
  /** Start the dev server when DevCatz launches (e.g. at login). */
  autoStart?: boolean;
  /** When DevCatz last started the site (ISO), for "not run for 30 days" (Free up space). */
  lastStarted?: string;
  /**
   * Monorepo / folder apps: the subdomain of each app (by its folder), chosen in Settings → Apps; '' = the site's
   * own domain. Unset apps keep the default (the main frontend on the site's domain, the others on `<folder>.`).
   */
  appSubdomains?: Record<string, string>;
  /** Exact Node.js version for this site; unset = .nvmrc/engines, then the default. */
  nodeVersion?: string;
  /** false = use the ports from .env/config instead of DevCatz's assigned ones (default true). */
  managedPorts?: boolean;
  /** Overrides the package manager detected from the lockfile. */
  packageManager?: PackageManager;
  /** false = serve the site over plain http (default https). */
  secure?: boolean;
  /** Exact PHP version for this site; unset = newest that satisfies composer.json, preferring the default. */
  phpVersion?: string;
  /** Laravel: run `queue:work` / `schedule:work` alongside the site. */
  queueWorker?: boolean;
  /** Laravel Reverb: run `reverb:start` with the site (served on reverb-<site>.<tld>). */
  reverb?: boolean;
  /** WebSocket tab: the DevCatz server this site's .env points at. */
  wsServer?: WsKind;
  /** WebSocket tab: path the connection test opens on the site's own server (default from the library). */
  wsPath?: string;
  /** Search Engine tab: the DevCatz engine this site's .env points at. */
  searchEngine?: SearchKind;
  /** Storage tab: the DevCatz object storage this site's .env points at. */
  storageService?: StorageKind;
  scheduler?: boolean;
  /** Exact Go toolchain for this site's Go apps; unset = newest that satisfies go.mod, preferring the default. */
  goVersion?: string;
  /** Python sites: the Python the venv is created with; unset = .python-version / requires-python, then the default. */
  pythonVersion?: string;
  /** PHP sites: .env values on the old dev domain (e.g. app.test from Laravel Herd) are overridden with this site's domain for requests and processes run by DevCatz (default on). */
  envDomainOverride?: boolean;
  /** DevCatz database service this site uses (Database tab manages it; it starts with the site). */
  dbService?: string;
  /** Worktree sites: the copy of the parent's database made for this worktree (on `dbService`), dropped with it. */
  worktreeDb?: string;
  /** Env tab: values hidden and editing off, like Dokploy. Locked unless set to false. */
  envLocked?: boolean;
  /** Redis database index for processes and requests DevCatz runs (REDIS_DB, REDIS_URL path); unset = from .env. */
  redisDb?: number;
  /** Laravel: REDIS_CACHE_DB (the cache connection; `cache:clear` flushes it, so keep it apart from queues/sessions). */
  redisCacheDb?: number;
  /** Laravel: index per custom Redis/Valkey connection, keyed by its env var (REDIS_VISIT_DB → 3); unset = from .env. */
  redisConnDbs?: Record<string, number>;
}

export interface LinkOptions {
  name?: string;
  phpVersion?: string;
  /** false = http only (default https). */
  secure?: boolean;
  goVersion?: string;
  packageManager?: PackageManager;
  devCommand?: string;
  /** false = use the ports from .env (default true). */
  managedPorts?: boolean;
  autoStart?: boolean;
  /** Domain label or full `<label>.<tld>`. */
  domain?: string;
  nodeVersion?: string;
  start?: boolean;
}

export interface FolderPreview {
  path: string;
  /** Folder name, the default site name. */
  name: string;
  /** Suggested free domain with the current default TLD, e.g. `shop.localhost`. */
  domain: string;
  stack: StackInfo;
  /** Node version that "Auto" would pick (from .nvmrc / engines / default). */
  autoNode: NodeChoice;
  /** Go toolchain that "Auto" would pick (from go.mod / default); only meaningful with Go apps. */
  autoGo: GoChoice;
  /** PHP version that "Auto" would pick (from composer.json / default). */
  autoPhp: PhpChoice;
  alreadyLinked: boolean;
}

export interface InstalledNode {
  version: string;
  major: number;
  /** `mrcatz` = installed by DevCatz; `herd` = found in Laravel Herd's nvm (read-only). */
  source: 'mrcatz' | 'herd';
  binDir: string;
}

export interface RemoteNode {
  /** Latest release of this major. */
  version: string;
  major: number;
  /** LTS codename, e.g. `Krypton`; null for Current releases. */
  lts: string | null;
  date: string;
}

export interface InstalledBun {
  version: string;
  /** `mrcatz` = installed by DevCatz; `system` = the user's own (~/.bun/bin, Homebrew), read-only. */
  source: 'mrcatz' | 'system';
  binDir: string;
}

export interface RemoteBun {
  version: string;
  date: string;
}

/** Which Bun a site runs with, and why. */
export interface BunChoice {
  version: string | null;
  binDir: string | null;
  reason: 'site' | 'project' | 'default' | 'system' | 'none';
  /** `packageManager: bun@x` / `engines.bun` from package.json. */
  spec: string | null;
  /** The project asks for a version that is not installed (or there is no Bun at all). */
  missing: boolean;
}

export interface InstalledGo {
  version: string;
  /** `mrcatz` = installed by DevCatz; `system` = the user's own (Homebrew, /usr/local/go), read-only. */
  source: 'mrcatz' | 'system';
  binDir: string;
}

export interface RemoteGo {
  /** Newest patch of `minor`, e.g. 1.27.2. */
  version: string;
  minor: string;
}

export interface InstalledPhp {
  version: string;
  /** `mrcatz` = installed by DevCatz (static-php.dev); `herd` = Laravel Herd's build; `homebrew` = Homebrew's (read-only, e.g. PHP 7.x). */
  source: 'mrcatz' | 'herd' | 'homebrew';
  php: string;
  fpm: string;
  binDir: string;
}

export interface RemotePhp {
  minor: string;
  /** Exact version (static-php.dev), or just the minor for Homebrew installs. */
  version: string;
  /** Legacy versions static-php.dev does not build (7.x, 5.6) come from the shivammathur/php Homebrew tap. */
  via?: 'homebrew';
  /** php.net's newest release of this minor when static-php.dev has not built it yet (informational: downloads stay on static-php.dev). */
  upstream?: { version: string; date: string; security: boolean };
}

export interface PhpChoice {
  version: string | null;
  binDir: string | null;
  reason: 'site' | 'project' | 'default' | 'system' | 'none';
  /** `require.php` from composer.json, e.g. `^8.2`. */
  spec: string | null;
  missing: boolean;
  source: InstalledPhp['source'] | null;
}

/** php.ini values managed on the PHP page (written to conf.d/99-mrcatz.ini). */
/** A PECL extension DevCatz built and loads as a shared module. */
export interface PhpExtension {
  module: string;
  pkg: string;
  version: string;
  zend: boolean;
  enabled: boolean;
}

export interface PhpExtCatalogItem {
  pkg: string;
  title: string;
  description: string;
  /** Loaded with zend_extension (Xdebug). */
  zend?: boolean;
  /** Homebrew formulas it links against; `{formula}` in `configure` becomes that prefix. */
  brew?: string[];
  configure?: string[];
}

export interface PhpExtensions {
  version: string;
  /** Only DevCatz's own builds can take extensions (static-php.dev on macOS, php.net's on Windows). */
  supported: boolean;
  /** Compiled into the binary (always on). */
  builtin: string[];
  installed: PhpExtension[];
  /** Windows: the PHP zip's own extensions (ext\\php_*.dll), switched on and off; empty on macOS. */
  bundled: PhpExtension[];
  catalog: PhpExtCatalogItem[];
  /** phpize + headers for this version are ready (else the first build makes them). */
  toolkit: boolean;
  /** Why nothing can be built here (Xcode tools missing …), null when fine. */
  problem: string | null;
}

/** An extension build in progress (one at a time). */
export interface PhpExtTask {
  version: string;
  pkg: string;
  phase: 'toolkit' | 'deps' | 'download' | 'build' | 'verify' | 'done' | 'error';
  detail: string;
  /** Last lines of the build output. */
  log: string[];
  error?: string;
}

export interface PhpIniSettings {
  memory_limit: string;
  upload_max_filesize: string;
  post_max_size: string;
  max_execution_time: string;
  max_input_vars: string;
  display_errors: string;
  error_reporting: string;
  'date.timezone': string;
  'opcache.enable': string;
  /** Any other directives, one per line. */
  extra: string;
}

export interface FpmStatus {
  version: string;
  running: boolean;
  /** Sites served by this pool. */
  sites: string[];
  error: string | null;
}

/** Which Go toolchain a site's Go apps run with. Same shape as BunChoice. */
export type GoChoice = BunChoice;

/** A rustup toolchain (`stable-aarch64-apple-darwin`, `1.82.0-…`, `nightly-…`). */
export interface InstalledRust {
  name: string;
  /** The name without the host triple: stable, nightly, 1.82.0. */
  channel: string;
  /** rustc's version, e.g. 1.91.0. */
  version: string | null;
  isDefault: boolean;
}

export interface RemoteRust {
  /** stable / beta / nightly or a release number. */
  name: string;
  note: string | null;
}

export type RustToolId = 'trunk' | 'dioxus-cli' | 'cargo-leptos' | 'tauri-cli' | 'solana' | 'anchor' | 'sqlx-cli' | 'sea-orm-cli' | 'diesel-cli';

export interface RustToolState {
  id: RustToolId;
  label: string;
  why: string;
  installed: boolean;
  version: string | null;
}

/** Which toolchain a site's Rust apps build with: rust-toolchain.toml's, else rustup's default. */
export interface RustChoice {
  /** rustc's version of that toolchain; null when it is not installed (or there is no Rust). */
  version: string | null;
  /** The toolchain name (stable, 1.82.0 …). */
  toolchain: string | null;
  reason: 'project' | 'default' | 'none';
  /** `channel` from rust-toolchain.toml. */
  spec: string | null;
  missing: boolean;
  /** CLIs this site's apps run with that are not installed (trunk, dx, solana, anchor …), and a missing wasm32 target. */
  needs: (RustToolId | 'wasm32')[];
}

export interface InstalledPython {
  version: string;
  /** `mrcatz` = installed by DevCatz (uv into its folder); `system` = the user's own (Homebrew, python.org), read-only. */
  source: 'mrcatz' | 'system';
  binDir: string;
  path: string;
}

export interface RemotePython {
  version: string;
  minor: string;
}

/** Which Python a site's venv uses (or would be created with). */
export interface PythonChoice {
  version: string | null;
  reason: 'site' | 'project' | 'default' | 'newest' | 'venv' | 'none';
  /** .python-version / requires-python. */
  spec: string | null;
  missing: boolean;
}

export type RuntimeInstallProgress = NodeInstallProgress;

export interface NodeInstallProgress {
  version: string;
  phase: 'download' | 'extract' | 'done' | 'error';
  received: number;
  total: number;
  error?: string;
  /** Last output line of an external installer (Homebrew), shown instead of MB counts. */
  detail?: string;
}

/** Which Node.js a site runs with, and why. */
/** A runtime a site needs that is not on this Mac (or not in the version the project asks for). */
export interface RuntimeNeed {
  kind: 'php' | 'node' | 'go' | 'bun';
  /** What the project asks for (`^8.2`, `22`, `lts/*`, `1.23.0`), null when it does not say. */
  spec: string | null;
  /** Where the spec comes from (composer.json, .nvmrc …). */
  from: string | null;
  /** The version the site would run with now (null = none at all). */
  current: string | null;
  /** The version Install adds (the newest that fits); null when the release list could not be read. */
  version: string | null;
}

export interface NodeChoice {
  version: string | null;
  reason: 'site' | 'nvmrc' | 'default' | 'system';
  /** The project's .nvmrc / engines spec, if any. */
  spec: string | null;
  /** The spec asks for a version that is not installed. */
  missing: boolean;
}

export type ProcessStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'crashed';
export type DbStatus = 'none' | 'stopped' | 'starting' | 'running' | 'unknown';

export interface ProjectState extends ProjectConfig {
  stack: StackInfo;
  /** The site's own processes (dev server; for PHP sites only Vite/Mix, queue and scheduler). */
  status: ProcessStatus;
  /** PHP sites: PHP-FPM serves it right now (always on, independent of Start). */
  served?: boolean;
  /** Ports of the project's apps that currently accept connections. */
  openPorts: number[];
  dbStatus: DbStatus;
  redisStatus: DbStatus;
  /** Name of a database task in progress (`migrate dev`, …). */
  dbTask: string | null;
  exitCode: number | null;
  /** When the preview screenshot was taken (ms), null if there is none. */
  screenshotAt: number | null;
  /** A screenshot is being taken right now. */
  capturing: boolean;
  node: NodeChoice;
  /** Only meaningful when the site's package manager is Bun. */
  bun: BunChoice;
  /** Only meaningful when the site has Go apps. */
  go: GoChoice;
  /** Only meaningful when the site has Rust apps (or a Tauri app). */
  rust: RustChoice;
  /**
   * While a site starts (from Start until every app's port answers): the shared package being built first, if any,
   * and each app's place — `waiting` (not launched yet) or `starting` (launched, its port not answering yet). An app
   * whose port answers is running. Null otherwise.
   */
  launch: { building: string | null; apps: Record<string, 'waiting' | 'starting'> } | null;
  /** Only meaningful for Python sites. */
  python: PythonChoice;
  /** Only meaningful for PHP/Laravel sites. */
  php: PhpChoice;
  /** S3 libraries and settings of the site. */
  s3: S3Info;
  /** Search libraries (Scout, Meilisearch, Typesense …) the site uses. */
  search: SearchInfo;
  /** Real-time libraries the site uses, and Reverb's endpoint while it runs. */
  realtime: RealtimeInfo;
  /** Laravel Reverb's port and domain (assigned once Reverb is turned on). */
  reverbEndpoint: { port: number; domain: string } | null;
  /** .env values with URLs on dev domains this site no longer uses (e.g. APP_URL=https://shop.test after a TLD change). */
  envHints: { key: string; value: string }[];
  /** Values DevCatz passes instead of the .env ones (old dev domain → this site's domain). */
  envOverrides: Record<string, string>;
  /** Git branch and working-tree summary (sidebar badge); null = not a repository. */
  git: GitSummary | null;
  /** Mailer settings found in .env (keys) and whether they point at DevCatz's catcher. */
  mailInfo: { keys: string[]; catcher: boolean } | null;
  /** WhatsApp keys in .env / client libraries found, the DevCatz engine they point at (null = elsewhere). */
  waInfo: { keys: string[]; libraries: string[]; engine: WaEngine | null } | null;
  /** Email / push / SMS gateway keys in .env and the DevCatz gateways they point at. */
  gwInfo: { keys: string[]; kinds: GwKind[] } | null;
}

export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  /** Default domain suffix: `localhost` (no setup) or e.g. `test` (needs the resolver). */
  tld: string;
  theme: ThemeMode;
  /** Start every site when DevCatz launches (otherwise only those marked autoStart). */
  startAllOnLaunch: boolean;
  /** Node.js version used when a project does not ask for one (null = the shell's node). */
  nodeDefault: string | null;
  /** Bun version used when a project does not pin one (null = the user's own bun). */
  bunDefault: string | null;
  /** Go toolchain used when go.mod allows any (null = the user's own go). */
  goDefault: string | null;
  pythonDefault: string | null;
  /** PHP version used when composer.json allows it (null = newest installed). */
  phpDefault: string | null;
  httpsPort: number;
  httpPort: number;
  /** App name for `open -a`, e.g. `Visual Studio Code`. Empty = auto. */
  editor: string;
  /** Browser for site and service links: the path of an installed browser app; '' = the system default. */
  browser: string;
  parkedDirs: string[];
  /** Check nodejs.org / GitHub / go.dev / static-php.dev for newer patch releases and notify. */
  updateNotifications: boolean;
  /** DevCatz's own updates (Catzoid #54): check 30 s after launch and every 6 h. */
  appUpdateAuto: boolean;
  /** Stable releases, or Beta too (GitHub prereleases). */
  appUpdateChannel: 'stable' | 'beta';
  /** A notification when a new version is found (once per version). */
  appUpdateNotify: boolean;
  /** "Skip this version": no notification or dot for it (a newer one shows again). */
  appUpdateSkip: string | null;
  /** The version the notification was shown for. */
  appUpdateNotified: string | null;
  /** Sites that ran before an update restart: started again on the next launch, then cleared. */
  resumeSites: string[];
  /** Crash and error reports to the Catzoid site (Catzoid #65): off until the user turns them on. */
  crashReports: boolean;
  /** The question "Send crash reports?" was answered (asked once, after the first crash). */
  crashAsked: boolean;
  /** The first-run welcome (Catzoid #29) was closed; it shows only on a first launch with no sites. */
  welcomeSeen: boolean;
  /** Site ids pinned at the top of the sidebar. */
  favorites: string[];
  /** Sidebar groups, in display order; a site is in at most one. */
  siteGroups: SiteGroup[];
  /** Sidebar order of the sites (drag and drop); sites not listed follow in creation order. */
  siteOrder: string[];
  /** Worktrees made outside DevCatz (Claude Code and other agents, `git worktree add`) become sites by themselves. */
  worktreeAutoAdd: boolean;
  /** Worktree folders whose site was removed by hand: automatic adding leaves them alone. */
  worktreeIgnore: string[];
  /** Database page: the same organisation (favorites, groups, drag-and-drop order) for the service list. */
  dbFavorites: string[];
  dbGroups: SiteGroup[];
  dbOrder: string[];
  /** Object storage: region the services run in and clients sign for. */
  s3Region: string;
  /** Object storage: parent folder for new installs' data folders ('' = DevCatz's data folder). */
  storageRoot: string;
  /** Object storage: parent folder for downloaded binaries of new installs ('' = DevCatz's data folder). */
  storageBinRoot: string;
  /** Object storage: endpoint used in .env snippets by default. */
  s3EnvEndpoint: 'domain' | 'local' | 'docker';
  /** Database services: parent folder of the instances' data folders ('' = DevCatz's data folder). */
  dbDataRoot: string;
  /** Database services: parent folder for downloaded server binaries ('' = DevCatz's data folder). */
  dbBinRoot: string;
  /** Database services: host used in .env lines by default (this Mac, or host.docker.internal for containers). */
  dbEnvHost: 'local' | 'docker';
  /**
   * Database services: one domain label for all of them (`db` → db.localhost, suffix from the Default domain);
   * '' = none (clients use 127.0.0.1). It resolves to this Mac; services differ by port.
   */
  dbDomain: string;
  /** Monitoring: seconds between samples while the Monitoring page is open. */
  monitorLiveInterval: number;
  /** Monitoring: keep sampling (every 15 s) while the page is closed, for the 1-hour history and alerts. */
  monitorBackground: boolean;
  /** Monitoring: macOS notifications for sustained high CPU / memory and a low disk. */
  monitorAlerts: boolean;
  monitorCpuAlert: number;
  monitorMemAlertMb: number;
  monitorAlertMinutes: number;
  /** WebSocket servers: origins new servers accept ('*' = any). */
  wsAllowedOrigins: string;
  /** WebSocket test client: events kept in its log. */
  wsTestEvents: number;
  /** Search engines: allowed origins (CORS) for new engines, OpenSearch heap default (MB). */
  searchAllowedOrigins: string;
  searchOpenSearchHeapMb: number;
  monitorDiskAlertGb: number;
  /** Monitoring: a CPU / memory line in the menu bar menu. */
  monitorMenuBar: boolean;
  /** Mail: the SMTP catcher's port (127.0.0.1), the web inbox's domain label (mail → mail.<tld>), autostart. */
  mailPort: number;
  mailDomain: string;
  mailAutoStart: boolean;
  /** Mail: macOS notification when a mail arrives. */
  mailNotify: boolean;
  /** Mail: how many mails are kept (oldest dropped). */
  mailKeep: number;
  /** Expose: minutes a share stays up by default (0 = until stopped). */
  exposeExpiryMinutes: number;
  /** WhatsApp: macOS notification when a message arrives. */
  waNotify: boolean;
  /** WhatsApp: how many messages the inspector keeps. */
  waKeep: number;
}

export interface SiteGroup {
  name: string;
  sites: string[];
  collapsed?: boolean;
}

export type DockerEngineId = 'orbstack' | 'docker-desktop' | 'colima' | 'rancher' | 'podman' | 'finch' | 'other';

export interface DockerStatus {
  /** Container engines found on this Mac (app or CLI), most recommended first. */
  installed: DockerEngineId[];
  /** A docker/podman/finch CLI exists. */
  cliFound: boolean;
  /** An engine answers. */
  daemon: boolean;
  /** Which one answers. */
  engine: DockerEngineId | null;
  context: string | null;
  /** OrbStack: containers get `https://<service>.<project>.orb.local`. */
  orbLocal: boolean;
  error: string | null;
}

export interface DockerFile {
  path: string;
  content: string;
  /** What is on disk now (null = new file). */
  current: string | null;
  same: boolean;
}

export interface DockerService {
  service: string;
  state: string;
  status: string;
  health: string | null;
  /** OrbStack's `https://<service>.<project>.orb.local`, else the first published localhost port. */
  url: string | null;
  published: string[];
}

export interface DockerComposeFile {
  file: string;
  /** Builds images of the app itself (not just a database). */
  build: boolean;
  /** Written by DevCatz's generator. */
  generated: boolean;
  /** `-p` used for it (generated files), null = compose's own default. */
  project: string | null;
}

/** `local`: try it here (database/Redis containers, localhost ports). `production`: Dokploy-style, services from env. */
export type DockerTarget = 'local' | 'production';

export interface DockerGenOptions {
  target: DockerTarget;
  /** Database and Redis containers in the compose file. */
  withServices: boolean;
  /** Laravel: `queue:work` and `schedule:work` containers from the same image. */
  worker: boolean;
  scheduler: boolean;
  /** Production: one compose file per service (`docker-compose.<service>.yml`), each its own Dokploy service. */
  split: boolean;
  /** `docker` = generated .env.docker; `project` = the project's own .env (local: plus container overrides; production: the platform's .env). */
  envFile: 'docker' | 'project';
  /** MrCatz DataTable: vendor/mrcatz views for Tailwind, intl/gd/bcmath/exif (Laravel); `nuxt prepare` (Nuxt). */
  mrcatzDatatable: boolean;
  /** Production: attach services to Dokploy's external `dokploy-network` (Traefik routing). */
  dokployNetwork: boolean;
}

export type DockerAction = 'up' | 'down' | 'restart' | 'build' | 'logs';

// ------------------------------------------------------------ object storage

export type StorageKind = 'rustfs' | 'minio' | 'seaweedfs';

/** Settings of one installed object storage service (one per kind). */
export interface StorageConfig {
  kind: StorageKind;
  /** S3 API port (127.0.0.1). */
  apiPort: number;
  /** Web console port (127.0.0.1). */
  consolePort: number;
  /** Domain labels; the Default domain suffix is appended (`minio` → minio.localhost). */
  apiDomain: string;
  consoleDomain: string;
  dataDir: string;
  /** An existing server binary to use; empty = DevCatz downloads the official build into `binaryDir`. */
  binaryPath: string;
  /** Where the downloaded binary lives ('' = <DevCatz data>/storage/<engine>/bin). */
  binaryDir: string;
  autoStart: boolean;
  /** S3 region the server runs in and clients sign for (default from Settings → Object Storage). */
  region: string;
  accessKey: string;
  secretKey: string;
  /** Installed version (from the binary). */
  version?: string | null;
}

/** A multi-step job (install / uninstall) with the step it is on, for a stepper in the UI. */
export interface TaskProgress {
  kind: 'install' | 'uninstall' | 'update' | 'share';
  /** e.g. "Installing RustFS 1.0.3". */
  title: string;
  steps: string[];
  /** Index of the step running now (steps.length = finished). */
  step: number;
  /** Bytes of the current download step. */
  received?: number;
  total?: number;
  /** What the step is working on (file, folder, URL). */
  detail?: string;
  /** Set when the job failed on `step`. */
  error?: string;
  /** Stopped by the user (Cancel). */
  cancelled?: boolean;
  done?: boolean;
}

export interface StorageState {
  kind: StorageKind;
  name: string;
  description: string;
  installed: boolean;
  config: StorageConfig | null;
  /** Defaults for the install form. */
  defaults: StorageConfig;
  /** Where the binary actually is (managed download or the chosen file). */
  binary: string | null;
  status: ProcessStatus;
  error: string | null;
  /** Install / uninstall in progress (or just finished / failed). */
  task: TaskProgress | null;
  urls: { api: string; console: string; apiLocal: string; consoleLocal: string } | null;
  /** Newer release available (from the same source as the installer), or null. */
  update: string | null;
  /** SeaweedFS internal ports (master / volume / filer), for information. */
  internalPorts?: Record<string, number>;
}

// ------------------------------------------------------------ WebSocket servers

/** Real-time servers DevCatz installs, one instance per kind (like Object Storage). */
export type WsKind = 'reverb' | 'sockudo' | 'centrifugo' | 'mercure' | 'nats';
/** How clients talk to it: Pusher (laravel-echo / pusher-js), Centrifugo's own, Mercure (SSE), NATS. */
export type WsProtocol = 'pusher' | 'centrifugo' | 'mercure' | 'nats';

export interface WsConfig {
  kind: WsKind;
  /** The WebSocket / HTTP port clients and the HTTP API use (127.0.0.1). */
  port: number;
  /** Second port: Sockudo metrics, NATS client (TCP) port; 0 when unused. */
  extraPort: number;
  /** Domain label; the Default domain suffix is appended (`ws` → ws.localhost). */
  domain: string;
  /** Pusher app id; Centrifugo admin password; unused for Mercure / NATS. */
  appId: string;
  /** Pusher app key; Centrifugo HTTP API key; Mercure publisher JWT key; NATS token ('' = none). */
  key: string;
  /** Pusher app secret; Centrifugo token HMAC secret; Mercure subscriber JWT key. */
  secret: string;
  /** Origins clients may connect from ('*' for any). */
  allowedOrigins: string;
  dataDir: string;
  /** Where the downloaded binary lives ('' = <DevCatz data>/websocket/<kind>/bin). */
  binaryDir: string;
  autoStart: boolean;
  version?: string | null;
}

export interface WsChannelStat {
  name: string;
  /** Subscribed clients (connections). */
  clients: number;
  /** Presence members, when the server reports them. */
  members?: number;
}

export interface WsStats {
  at: number;
  /** Open client connections. */
  clients: number;
  channels: WsChannelStat[];
  /** Messages per second in + out, null until two samples exist or when the server does not count them. */
  messagesPerSec: number | null;
  error?: string;
}

export interface WsState {
  kind: WsKind;
  name: string;
  protocol: WsProtocol;
  description: string;
  /** Field labels for this kind (appId / key / secret), null = not used. */
  fields: { appId: string | null; key: string | null; secret: string | null; extraPort: string | null };
  installed: boolean;
  config: WsConfig | null;
  defaults: WsConfig;
  binary: string | null;
  status: ProcessStatus;
  error: string | null;
  task: TaskProgress | null;
  /** wss:// URL clients use (through the proxy), its local ws://, the HTTP base (API) and an admin page if any. */
  urls: { ws: string; wsLocal: string; http: string; httpLocal: string; admin: string | null } | null;
  /** Newer release available (from the same source as the installer), or null. */
  update: string | null;
}

/** What a site uses for real-time messaging (detected from its manifests). */
export interface RealtimeLib {
  /** Display name: Socket.IO, ws, Laravel Echo, Django Channels … */
  name: string;
  /** server = runs inside the site (proxied on its domain); client = talks to a server elsewhere. */
  role: 'server' | 'client';
  /** Protocol it speaks; `socketio` / `ws` = the site's own server. */
  protocol: WsProtocol | 'socketio' | 'ws' | 'reverb' | 'channels';
  /** Manifest it was found in (package.json, composer.json, go.mod, requirements.txt …). */
  source: string;
}

/** A Laravel event that broadcasts (app/**). */
export interface BroadcastEvent {
  /** Fully qualified class, e.g. App\\Events\\OrderShipped. */
  class: string;
  file: string;
  /** From broadcastOn(): `{…}` marks a dynamic part (orders.{…}). */
  channels: { type: 'public' | 'private' | 'presence'; name: string }[];
  /** broadcastAs() name, else Echo listens for the class name. */
  as: string | null;
  /** ShouldBroadcastNow (no queue worker needed). */
  now: boolean;
}

export interface BroadcastCheck {
  id: string;
  label: string;
  /** null = not applicable / unknown. */
  ok: boolean | null;
  detail: string;
}

export interface LaravelBroadcastInfo {
  connection: string | null;
  events: BroadcastEvent[];
  channels: { name: string; type: 'private' | 'presence' }[];
  checks: BroadcastCheck[];
  /** For DevCatz's listener: the app key and the server's local ws:// base (Reverb or Sockudo), null if unknown. */
  listen: { key: string; ws: string } | null;
  /** A queue worker is needed for ShouldBroadcast events and none runs with the site. */
  queueHint: boolean;
}

export interface RealtimeInfo {
  libs: RealtimeLib[];
  /** Laravel Reverb is installed (laravel/reverb): DevCatz can run `reverb:start` with the site. */
  reverb: boolean;
  /** A DevCatz server kind that fits the client libs (Pusher clients → Sockudo …), null if none. */
  suggested: WsKind | null;
}

// ------------------------------------------------------------ search engines

/** Search engines DevCatz installs, one instance per kind. */
export type SearchKind = 'meilisearch' | 'typesense' | 'opensearch' | 'manticore' | 'zincsearch' | 'sonic';

export interface SearchConfig {
  kind: SearchKind;
  /** HTTP API port (127.0.0.1). */
  port: number;
  /** Second port: Manticore SQL (MySQL protocol), OpenSearch transport, Typesense peering. */
  extraPort: number;
  /** Domain label; the Default domain suffix is appended (`meilisearch` → meilisearch.localhost). */
  domain: string;
  /** Master / admin API key, ZincSearch admin password, Sonic channel password ('' for OpenSearch and Manticore: no auth locally). */
  key: string;
  /** A search-only key for front ends (Meilisearch / Typesense), filled in when first needed. */
  searchKey?: string;
  /** OpenSearch JVM heap (MB). */
  memoryMb: number;
  allowedOrigins: string;
  dataDir: string;
  binaryDir: string;
  autoStart: boolean;
  version?: string | null;
}

export interface SearchState {
  kind: SearchKind;
  name: string;
  description: string;
  fields: { key: string | null; extraPort: string | null; memory: boolean };
  /** What this engine offers in DevCatz's UI. */
  features: {
    keys: boolean;
    facets: boolean;
    editSettings: boolean;
    schemaOnCreate: boolean;
    /** Meilisearch: task queue, dumps / snapshots. */
    tasks: boolean;
    backups: boolean;
    /** Filter / sort syntax in the playground (Sonic only ranks ids). */
    filters: boolean;
    /** The server speaks HTTP (proxied on its domain); false = TCP only (Sonic). */
    http: boolean;
  };
  installed: boolean;
  config: SearchConfig | null;
  defaults: SearchConfig;
  status: ProcessStatus;
  error: string | null;
  task: TaskProgress | null;
  urls: { http: string; httpLocal: string; admin: string | null } | null;
  /** Newer release available (from the same source as the installer), or null. */
  update: string | null;
}

export interface SearchIndex {
  name: string;
  docs: number;
  sizeBytes: number | null;
  primaryKey: string | null;
}

export interface SearchQuery {
  index: string;
  q: string;
  /** Engine syntax: Meilisearch `genre = horror`, Typesense `price:<10`, OpenSearch query_string, Manticore SQL `price < 10`. */
  filter?: string;
  /** Meilisearch `price:asc`, Typesense `price:asc`, OpenSearch `price:asc`, Manticore `price ASC`. */
  sort?: string;
  facets?: string[];
  limit: number;
  offset: number;
}

export interface SearchHit {
  id: string;
  doc: Record<string, unknown>;
  /** Field → highlighted HTML (<mark>/<em>/<b> only). */
  highlight: Record<string, string>;
}

export interface SearchResult {
  hits: SearchHit[];
  total: number;
  ms: number | null;
  facets: Record<string, Record<string, number>>;
}

/** A Meilisearch task (the queue of indexing / settings work). */
export interface SearchTask {
  uid: number;
  index: string | null;
  status: 'enqueued' | 'processing' | 'succeeded' | 'failed' | 'canceled';
  type: string;
  /** Short summary of the task's details (documents received / indexed, settings keys …). */
  details: string;
  error: string | null;
  enqueuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/** A backup file of a search engine (Meilisearch dump or snapshot). */
export interface SearchBackup {
  file: string;
  name: string;
  kind: 'dump' | 'snapshot';
  sizeBytes: number;
  createdAt: string;
}

export interface SearchKey {
  id: string;
  name: string | null;
  /** Full key (Meilisearch), or its prefix (Typesense shows the full value only once). */
  value: string;
  actions: string[];
  indexes: string[];
  expiresAt: string | null;
}

/** S3 use of a site (Storage tab). */
export interface S3Info {
  libs: { name: string; source: string }[];
  /** Libraries found and the .env configures S3 (FILESYSTEM_DISK=s3, keys, bucket or endpoint). */
  used: boolean;
  /** .env AWS_ENDPOINT / S3_ENDPOINT …, null = AWS itself. */
  endpoint: string | null;
  bucket: string | null;
  /** Laravel FILESYSTEM_DISK. */
  disk: string | null;
  /** The DevCatz storage service the endpoint points at, if any. */
  service?: StorageKind | null;
}

/** Search libraries a site uses. */
export interface SearchLib {
  name: string;
  engine: SearchKind | 'scout' | 'instantsearch';
  role: 'server' | 'client';
  source: string;
}

export interface SearchInfo {
  libs: SearchLib[];
  /** laravel/scout is installed; `scoutDriver` from .env (SCOUT_DRIVER). */
  scout: boolean;
  scoutDriver: string | null;
  /** Models using the Searchable trait (Scout). */
  searchable: string[];
  suggested: SearchKind | null;
}

export interface S3Bucket {
  name: string;
  created: string;
  public: boolean;
}

export interface S3Entry {
  key: string;
  /** Folder (common prefix) rather than an object. */
  folder: boolean;
  size: number;
  modified: string | null;
}

/** Upload into a bucket in progress (pushed to the window on `herd:upload`). */
export interface S3UploadProgress {
  kind: StorageKind;
  bucket: string;
  /** Key of the object being sent. */
  key: string;
  /** 1-based index of the current file. */
  index: number;
  count: number;
  /** Bytes of all files sent so far / in total. */
  sent: number;
  total: number;
  done?: boolean;
  cancelled?: boolean;
  error?: string;
}

export type StorageAction = 'start' | 'stop' | 'restart';

export type RuntimeKind = 'node' | 'bun' | 'go' | 'php';

/** A newer patch release for an installed runtime. */
export interface RuntimeUpdate {
  runtime: RuntimeKind;
  from: string;
  to: string;
  /** `from` is the default version; the update becomes the default. */
  isDefault: boolean;
}

export interface UpdatesState {
  list: RuntimeUpdate[];
  checkedAt: number | null;
  checking: boolean;
  error: string | null;
  /** Runtime update being installed right now (`<runtime>@<from>`). */
  updating: string | null;
}

export interface CertState {
  caExists: boolean;
  caTrusted: boolean;
  caPath: string;
}

export interface DomainState {
  tld: string;
  /** `.localhost` needs nothing; other TLDs need DevCatz's DNS + /etc/resolver/<tld>. */
  needsResolver: boolean;
  dnsRunning: boolean;
  dnsError: string | null;
  resolver: 'ours' | 'foreign' | 'none';
  /** A test name under the TLD resolves to this Mac. */
  resolves: boolean;
}

export interface TldChange {
  from: string;
  to: string;
  renamed: { name: string; from: string; to: string }[];
}

export interface CleanUrlState {
  /** [::1]:443 is forwarded to the proxy (URLs work without a port). */
  installed: boolean;
  /** The forwarding LaunchDaemon is installed (it may still not answer). */
  configured: boolean;
  /** The forwarder also covers 127.0.0.1 (possible once Laravel Herd no longer owns 127.0.0.1:443). */
  ipv4: boolean;
  /** 127.0.0.1:443 is free, so reinstalling would add IPv4. */
  ipv4Available: boolean;
}

export interface BrowserInfo {
  name: string;
  /** The app bundle, e.g. /Applications/Google Chrome.app. */
  path: string;
  /** Its app icon as a PNG data URL ('' when macOS gave none). */
  icon: string;
}
export interface BrowsersState {
  list: BrowserInfo[];
  /** What macOS opens https links with (null when it could not be read). */
  systemDefault: BrowserInfo | null;
}

export interface AppState {
  projects: ProjectState[];
  settings: Settings;
  /** AI provider settings (no keys, only which providers have one). */
  ai: AiSettings;
  cert: CertState;
  cleanUrls: CleanUrlState;
  domain: DomainState;
  proxy: { https: boolean; http: boolean; error: string | null };
  editors: string[];
  /** Installed web browsers and the one macOS opens https links with. */
  browsers: BrowsersState;
  /** App icons of the installed editors (name → PNG data URL). */
  editorIcons: Record<string, string>;
  /** Registered as a macOS login item (menu bar app starts at login). */
  launchAtLogin: boolean;
  /** false in `electron-vite dev`: the login item would point at the dev Electron binary. */
  packaged: boolean;
  /** `:8443` while clean URLs are off, '' when they work. */
  urlSuffix: string;
  /** Same for plain http: `:8180`, or '' when [::1]:80 is forwarded. */
  httpUrlSuffix: string;
  node: {
    installed: InstalledNode[];
    defaultVersion: string | null;
    /** The login shell's own `node -v`. */
    system: string | null;
    /** Folder with node/npm/npx shims for the default version. */
    shimDir: string;
    shimOnPath: boolean;
    installing: NodeInstallProgress | null;
  };
  bun: {
    installed: InstalledBun[];
    defaultVersion: string | null;
    installing: RuntimeInstallProgress | null;
  };
  go: {
    installed: InstalledGo[];
    defaultVersion: string | null;
    installing: RuntimeInstallProgress | null;
  };
  rust: {
    /** rustup's version, null when Rust is not installed. */
    rustup: string | null;
    toolchains: InstalledRust[];
    /** Targets of the default toolchain (wasm32-unknown-unknown …). */
    targets: string[];
    tools: RustToolState[];
    /** What is being installed: rustup, a toolchain, a target or a tool (`detail` = its last output line). */
    installing: RuntimeInstallProgress | null;
    /** macOS without the Xcode Command Line Tools: Rust cannot link. */
    linkerMissing: boolean;
  };
  python: {
    /** uv version, null when DevCatz has not installed uv yet. */
    uv: string | null;
    installed: InstalledPython[];
    defaultVersion: string | null;
    installing: RuntimeInstallProgress | null;
  };
  php: {
    installed: InstalledPhp[];
    defaultVersion: string | null;
    installing: RuntimeInstallProgress | null;
    composer: boolean;
    fpm: FpmStatus[];
    extTask: PhpExtTask | null;
  };
  /** Menu-bar style service overview (like Laravel Herd's nginx / dnsmasq / FPM). */
  services: { proxy: boolean; dns: 'running' | 'not-needed' | 'down' };
  updates: UpdatesState;
  storage: StorageState[];
  websockets: WsState[];
  searchEngines: SearchState[];
  databases: DbServiceState[];
  dbcatz: DbCatzState;
  /** DialCatz, the API client: installed, and its Download & Install progress. */
  dialcatz: DbCatzState;
  /** DevCatz's own update (Catzoid #54). */
  appUpdate: AppUpdateState;
  /** Report a Bug / feedback / crash reports (Catzoid #65). */
  reports: ReportsState;
  /** Uninstall DevCatz in progress (Catzoid #55). */
  uninstall: TaskProgress | null;
  git: GitState;
  mail: MailState;
  expose: ExposeState;
  whatsapp: WaState[];
  gateways: GwState[];
}

// ------------------------------------------------------------ Mail (SMTP catcher)

export interface MailAddress {
  name: string;
  address: string;
}

export interface MailAttachment {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  /** Content-ID of an inline image (referenced as cid:… in the HTML). */
  cid: string | null;
}

/** One caught mail, as the inbox list shows it. */
export interface MailSummary {
  id: string;
  receivedAt: string;
  from: MailAddress | null;
  to: MailAddress[];
  cc: MailAddress[];
  subject: string;
  /** The site that sent it (SMTP username, else the sender's domain), if known. */
  siteId: string | null;
  siteName: string | null;
  unread: boolean;
  hasHtml: boolean;
  attachments: number;
  size: number;
  snippet: string;
}

export interface MailMessage extends MailSummary {
  /** HTML ready for a sandboxed iframe: inline images resolved, remote images blocked (see `remoteImages`). */
  html: string | null;
  text: string | null;
  headers: { name: string; value: string }[];
  attachmentList: MailAttachment[];
  /** Remote images the HTML loads (blocked until "Load images"). */
  remoteImages: number;
  /** Checks on the mail (missing alt, no List-Unsubscribe, links to dev domains …). */
  hints: string[];
  envelope: { from: string; to: string[]; username: string | null };
}

export interface MailForwardConfig {
  host: string;
  port: number;
  /** TLS from the start (465), STARTTLS (587), or plain. */
  security: 'tls' | 'starttls' | 'none';
  username: string;
  /** Kept encrypted; '' in the UI means unchanged, null = none. */
  password?: string | null;
  from: string;
}

export interface MailState {
  running: boolean;
  port: number;
  /** https://mail.<tld> (through the proxy). */
  webUrl: string;
  count: number;
  unread: number;
  error: string | null;
  /** A forwarding account is set up (Settings → Mail). */
  forwardReady: boolean;
  /** Last mail's time (the inbox reloads when it changes). */
  lastAt: string | null;
}

// ------------------------------------------------------------ Expose (public tunnels)

/** Quick tunnel (random URL), a named tunnel on the user's Cloudflare domain, ngrok, or Expose (expose.dev). */
export type ExposeProvider = 'cloudflare' | 'cloudflare-domain' | 'ngrok' | 'expose';
export type ExposeTool = 'cloudflared' | 'ngrok' | 'expose';

/** Provider accounts (tokens are kept encrypted in the main process; the UI only sees whether one is set). */
export interface ExposeAccounts {
  ngrok: { token: boolean; domain: string };
  expose: { token: boolean; server: string; domain: string };
  /** cloudflared is logged in to a Cloudflare account (~/.cloudflared/cert.pem). */
  cloudflare: boolean;
}

/** One request that went through a share's tunnel (request inspector). */
export interface ExposeRequest {
  id: string;
  at: string;
  method: string;
  path: string;
  status: number | null;
  ms: number | null;
  ip: string | null;
  requestHeaders: Record<string, string>;
  responseHeaders: Record<string, string>;
  /** Up to 64 KB of each body, as text (binary noted). */
  requestBody: string | null;
  responseBody: string | null;
  /** Replayed from the inspector. */
  replay: boolean;
}

export interface ExposeShare {
  id: string;
  siteId: string;
  siteName: string;
  /** Local host the tunnel serves (the site's domain, or an app's). */
  domain: string;
  provider: ExposeProvider;
  status: 'starting' | 'running' | 'stopping' | 'stopped' | 'crashed';
  url: string | null;
  startedAt: string;
  expiresAt: string | null;
  /** Basic auth is on (the password stays in the main process). */
  auth: string | null;
  requests: number;
  error: string | null;
  /** Steps while the tunnel starts (gateway, tool, public URL); null once it runs. */
  task: TaskProgress | null;
}

export interface ExposeState {
  /** Versions of the tools, null = not installed. */
  tools: Record<ExposeTool, string | null>;
  /** The tool being installed and its progress. */
  installing: { tool: ExposeTool; task: TaskProgress } | null;
  /** Newer releases found by exposeCheckUpdates (tool → version). */
  updates: Partial<Record<ExposeTool, string>>;
  accounts: ExposeAccounts;
  shares: ExposeShare[];
}

export interface ExposeOptions {
  siteId: string;
  domain?: string;
  provider?: ExposeProvider;
  /** "user:password" for basic auth, '' for none. */
  auth?: string;
  /** Minutes until it stops on its own (0 = never). */
  expiryMinutes?: number;
  /** cloudflare-domain: the public hostname on the user's zone (demo.example.com). */
  hostname?: string;
  /** ngrok: a reserved domain of the account; expose: a subdomain (or custom domain) on the server. */
  subdomain?: string;
}

// ------------------------------------------------------------ WhatsApp

/** WhatsApp HTTP gateways DevCatz runs: GOWA (a Go binary) and WAHA (a Docker image). */
export type WaEngine = 'gowa' | 'waha';

export interface WaConfig {
  engine: WaEngine;
  /** 127.0.0.1 port of the HTTP API. */
  port: number;
  /** Public name through the proxy: label.<tld> (gowa.localhost). */
  domain: string;
  /** Basic auth user (GOWA: API and web UI; WAHA: dashboard and Swagger). */
  apiUser: string;
  /** API key (WAHA: X-Api-Key; GOWA: the basic auth password). */
  apiKey: string;
  /** Release (GOWA) or image tag (WAHA). */
  version: string;
  autoStart: boolean;
  dataDir: string;
}

export interface WaSession {
  name: string;
  status: 'starting' | 'scanning' | 'connected' | 'disconnected' | 'failed';
  /** The linked number (jid) and its push name once connected. */
  jid: string | null;
  pushName: string | null;
}

export interface WaState {
  engine: WaEngine;
  name: string;
  description: string;
  /** WAHA runs in a container. */
  docker: boolean;
  installed: boolean;
  config: WaConfig | null;
  defaults: WaConfig;
  status: ProcessStatus;
  error: string | null;
  task: TaskProgress | null;
  /** https://gowa.<tld> (through the proxy) and the API's own address. */
  url: string | null;
  apiLocal: string | null;
  /** Newer release available, or null. */
  update: string | null;
  sessions: WaSession[];
  /** Dashboard / API docs path of the engine. */
  dashboardPath: string;
}

/** A message seen by DevCatz: from the engine's webhook (in / out), or sent from the test sender. */
export interface WaMessage {
  id: string;
  at: string;
  engine: WaEngine;
  session: string;
  direction: 'in' | 'out';
  /** The engine's event name (message, message.any, session.status …) or `send` for the test sender. */
  event: string;
  from: string | null;
  fromName: string | null;
  to: string | null;
  /** Text, caption, or a short description of a media message. */
  body: string;
  /** text, image, document, audio, video, sticker, location, reaction, status … */
  kind: string;
  /** The webhook body as received (JSON). */
  raw: string;
}

/** A site that receives the engine's events on a URL. */
export interface WaHook {
  id: string;
  siteId: string;
  siteName: string;
  url: string;
  /** Event names to forward; empty = everything. */
  events: string[];
  enabled: boolean;
  /** HMAC secret (X-DevCatz-Signature: sha256=…). */
  secret: string;
  deliveries: number;
  lastStatus: number | null;
  lastAt: string | null;
}

export interface WaDelivery {
  id: string;
  hookId: string;
  at: string;
  engine: WaEngine;
  event: string;
  status: number | null;
  ms: number;
  error: string | null;
  /** The JSON body sent (first 64 KB). */
  body: string;
  response: string | null;
  replay: boolean;
}

export interface WaSendInput {
  session: string;
  /** A number (6281234…) or a chat id (…@s.whatsapp.net / …@c.us / …@g.us). */
  to: string;
  kind: 'text' | 'image' | 'document';
  text: string;
  /** Local file for image / document. */
  file?: string;
}

/** What the test sender did: the API request (key redacted) and the engine's answer. */
export interface WaSendResult {
  request: { method: string; url: string; body: string };
  status: number;
  response: string;
}

export interface WaContact {
  id: string;
  name: string;
  /** Group chats carry their member count. */
  members?: number;
}

// ------------------------------------------------------------ Gateways (email, push, SMS)

/** Gateway servers besides WhatsApp: email (Stalwart, Postal), push (ntfy, Gotify), SMS (Jasmin) and Telegram (Bot API server). */
export type GwKind = 'stalwart' | 'postal' | 'ntfy' | 'gotify' | 'jasmin' | 'telegram';
export type GwCategory = 'email' | 'push' | 'sms' | 'telegram';

export interface GwConfig {
  kind: GwKind;
  /** Web UI / HTTP API port on 127.0.0.1. */
  port: number;
  /** Other ports: Stalwart smtp / submission / imap, Postal smtp, Jasmin jcli / smpp (the SMS catcher). */
  ports: Record<string, number>;
  /** Domain label: <label>.<tld> through the proxy. */
  domain: string;
  /** Administrator (web UI) and the account sites use. */
  user: string;
  password: string;
  /** Release (Stalwart) or image tag (Docker engines). */
  version: string;
  autoStart: boolean;
  dataDir: string;
  /** Made by the first start: API keys and tokens (ntfy token, Gotify app token, Postal keys, Jasmin login …);
   *  Telegram: apiId / apiHash (my.telegram.org) and botToken, entered in the form. */
  secrets: Record<string, string>;
  /** First-start setup done (users, tokens, routes); cleared when ports or credentials change so it runs again. */
  setupDone: boolean;
}

export interface GwState {
  kind: GwKind;
  name: string;
  category: GwCategory;
  description: string;
  docker: boolean;
  installed: boolean;
  config: GwConfig | null;
  defaults: GwConfig;
  /** Extra ports the form edits: key → label. */
  portFields: { key: string; label: string }[];
  status: ProcessStatus;
  error: string | null;
  task: TaskProgress | null;
  /** https://<label>.<tld> and the 127.0.0.1 address of its web UI / API. */
  url: string | null;
  apiLocal: string | null;
  /** Path of the web UI (null: the engine has none, e.g. Jasmin). */
  webPath: string | null;
  update: string | null;
  /** Connection details to show (label, value, secret). */
  connection: { label: string; value: string; secret?: boolean }[];
}

export interface GwSendInput {
  /** Email address, ntfy topic, or phone number (SMS). */
  to: string;
  subject: string;
  text: string;
  from?: string;
}

export interface GwSendResult {
  request: { method: string; url: string; body: string };
  status: number;
  response: string;
}

/** A text message the SMS catcher took from Jasmin. */
export interface CaughtSms {
  id: string;
  at: string;
  systemId: string;
  from: string;
  to: string;
  text: string;
  dataCoding: number;
  parts: number;
}

// ------------------------------------------------------------ DBCatz (the database viewer app)

export interface DbCatzState {
  /** /Applications/DBCatz.app (or ~/Applications) exists. */
  installed: boolean;
  /** A Download & Install in progress (or just finished / failed). */
  task: TaskProgress | null;
}

// ------------------------------------------------------------ Git

export type GitHostKind = 'github' | 'gitlab' | 'gitea' | 'bitbucket';

/** A connected hosting account (token kept encrypted with the macOS Keychain). */
export interface GitAccount {
  id: string;
  kind: GitHostKind;
  /** Web URL: https://github.com, https://gitlab.example.com … */
  baseUrl: string;
  username: string;
  name: string | null;
  avatarUrl: string | null;
  addedAt: string;
}

export interface GitRepo {
  fullName: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  defaultBranch: string | null;
  cloneHttps: string;
  cloneSsh: string | null;
  webUrl: string;
  updatedAt: string | null;
}

/** Branch and working tree at a glance (sidebar, header). */
// ------------------------------------------------------------------ AI (TODO §28; provider layer as in DBCatz)

export type AiProvider = 'anthropic' | 'openai' | 'gemini' | 'zai' | 'deepseek' | 'mistral' | 'xai' | 'groq' | 'openrouter' | 'ollama' | 'openai-compatible';
export interface AiProviderInfo {
  id: AiProvider;
  name: string;
  /** Where its API key is made (empty: no key needed). */
  keyUrl: string;
  /** API base URL; editable for Z.ai (China: open.bigmodel.cn), Ollama and OpenAI-compatible. */
  baseUrl: string;
  /** Models offered before the list is loaded from the provider; the first is the default. */
  models: string[];
}
/** Same list as DBCatz (keep them in step). */
export const AI_PROVIDERS: AiProviderInfo[] = [
  { id: 'anthropic', name: 'Anthropic (Claude)', keyUrl: 'https://console.anthropic.com/settings/keys', baseUrl: 'https://api.anthropic.com', models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { id: 'openai', name: 'OpenAI (GPT)', keyUrl: 'https://platform.openai.com/api-keys', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5', 'gpt-5-mini', 'gpt-4.1'] },
  { id: 'gemini', name: 'Google (Gemini)', keyUrl: 'https://aistudio.google.com/apikey', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
  { id: 'zai', name: 'Z.ai (GLM)', keyUrl: 'https://z.ai/manage-apikey/apikey-list', baseUrl: 'https://api.z.ai/api/paas/v4', models: ['glm-5.3', 'glm-5.2'] },
  { id: 'deepseek', name: 'DeepSeek', keyUrl: 'https://platform.deepseek.com/api_keys', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'mistral', name: 'Mistral', keyUrl: 'https://console.mistral.ai/api-keys', baseUrl: 'https://api.mistral.ai/v1', models: ['mistral-large-latest', 'codestral-latest'] },
  { id: 'xai', name: 'xAI (Grok)', keyUrl: 'https://console.x.ai', baseUrl: 'https://api.x.ai/v1', models: ['grok-4', 'grok-3-mini'] },
  { id: 'groq', name: 'Groq', keyUrl: 'https://console.groq.com/keys', baseUrl: 'https://api.groq.com/openai/v1', models: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'] },
  { id: 'openrouter', name: 'OpenRouter (many models)', keyUrl: 'https://openrouter.ai/keys', baseUrl: 'https://openrouter.ai/api/v1', models: ['anthropic/claude-sonnet-4.5', 'openai/gpt-5', 'google/gemini-2.5-pro'] },
  { id: 'ollama', name: 'Ollama (local, offline)', keyUrl: '', baseUrl: 'http://localhost:11434', models: ['qwen2.5-coder', 'llama3.1'] },
  { id: 'openai-compatible', name: 'OpenAI-compatible server', keyUrl: '', baseUrl: 'http://localhost:1234/v1', models: [] },
];
export const aiProvider = (id: AiProvider) => AI_PROVIDERS.find((p) => p.id === id) ?? AI_PROVIDERS[0];

/** Where DevCatz uses AI; each can be switched off on its own. */
export type AiFeature = 'explain' | 'commit' | 'docker' | 'env' | 'search' | 'webhook' | 'ask';
export const AI_FEATURES: { id: AiFeature; label: string; hint: string; sends: string }[] = [
  { id: 'explain', label: 'Explain & fix errors', hint: 'Ask AI on a crashed site or on error lines in Logs: what went wrong and one-click DevCatz fixes.', sends: 'the log lines (secrets masked), the stack and runtime versions, the dev command' },
  { id: 'commit', label: 'Commit messages and PR descriptions', hint: 'Write with AI in the Git tab, from the staged changes, in the repository’s own style.', sends: 'the staged diff (or the branch’s commits and diff for a PR) and recent commit subjects' },
  { id: 'docker', label: 'Docker', hint: 'Why a build or `docker compose up` failed; adjust a generated Dockerfile from plain words.', sends: 'the compose / build log, the generated file you adjust' },
  { id: 'env', label: '.env helper', hint: 'Explains empty or odd keys against .env.example and suggests values pointing at DevCatz services.', sends: 'key names, whether each is set, .env.example values, DevCatz service addresses — never your .env values' },
  { id: 'search', label: 'Search playground', hint: 'Plain words become the engine’s query, filter and sort (Meilisearch, Typesense, OpenSearch …).', sends: 'the index’s settings (fields, filterable / sortable attributes) and your request' },
  { id: 'webhook', label: 'Webhooks (Expose)', hint: 'Explains a request that came in through a share and writes a handler for the site’s framework.', sends: 'that request’s method, path, headers (auth masked) and body' },
  { id: 'ask', label: `Ask DevCatz (${keyLabel('mod+K')})`, hint: 'Plain-word commands (“start shop and its database”) turned into DevCatz actions you confirm.', sends: 'site and service names, domains, status and stack — no code, no .env' },
];

export interface AiSettings {
  enabled: boolean;
  provider: AiProvider;
  /** The chosen model per provider (a listed one or any id the provider knows). */
  models: Partial<Record<AiProvider, string>>;
  /** Base URL overrides (Z.ai, Ollama, OpenAI-compatible). */
  baseUrls: Partial<Record<AiProvider, string>>;
  /** Switched-off features (all on by default once AI is on). */
  off: AiFeature[];
  /** Providers with an API key stored (encrypted); keys never reach the window. */
  keys: AiProvider[];
}
export const AI_DEFAULTS: AiSettings = { enabled: false, provider: 'anthropic', models: {}, baseUrls: {}, off: [], keys: [] };
export type AiSettingsPatch = Partial<Omit<AiSettings, 'keys'>>;

/** One turn of a conversation with the model. */
export interface AiTurn {
  role: 'user' | 'assistant';
  text: string;
}

/** Exactly what a request sends (Preview what is sent). */
export interface AiPreview {
  provider: string;
  model: string;
  system: string;
  messages: AiTurn[];
}

/**
 * Something DevCatz can do for the user, proposed by the model and run only when the user clicks it. The model
 * may only pick from this list; the main process checks every argument before running it.
 */
export type AiActionKind =
  | 'site-start'
  | 'site-stop'
  | 'site-restart'
  | 'install-deps'
  | 'php-extension'
  | 'set-node-version'
  | 'set-php-version'
  | 'set-python-version'
  | 'db-task'
  | 'stack-task'
  | 'service-start'
  | 'service-stop'
  | 'service-restart'
  | 'service-uninstall'
  | 'expose-start'
  | 'expose-stop'
  | 'site-setting'
  | 'env-set'
  | 'open-tab'
  | 'open-section'
  | 'open-dbcatz';
export interface AiAction {
  kind: AiActionKind;
  /** Button text, e.g. "Install the intl extension for PHP 8.4". */
  label: string;
  /** The site it applies to (Ask DevCatz can name any site; elsewhere the current one). */
  site?: string;
  /** Kind-specific: extension / version / task id / service ref / env key, value and file / tab or section name. */
  args: Record<string, string>;
}

export interface AiExplainRequest {
  siteId: string;
  /** Where the lines come from. */
  source: 'logs' | 'crash' | 'docker';
  /** The lines to explain (selected in Logs, or the tail DevCatz picks). */
  lines?: string[];
  prompt?: string;
  history?: AiTurn[];
}
export interface AiExplainAnswer {
  /** One or two sentences: what happened. */
  summary: string;
  /** Why, in plain words. */
  cause: string;
  /** What to do, step by step (things DevCatz cannot do itself, e.g. code changes). */
  steps: string[];
  /** One-click DevCatz fixes. */
  actions: AiAction[];
}

export interface AiCommitRequest {
  siteId: string;
  kind: 'commit' | 'pr';
  /** PR: the branch it goes into (default: the upstream's default branch). */
  base?: string;
  /** Extra wishes ("mention the ticket ABC-12", "shorter"). */
  prompt?: string;
}
export interface AiCommitAnswer {
  title: string;
  body: string;
}

export interface AiDockerEditRequest {
  siteId: string;
  file: string;
  content: string;
  prompt: string;
}
export interface AiDockerEditAnswer {
  content: string;
  explanation: string;
}

export interface AiEnvRequest {
  siteId: string;
  /** The .env file, relative to the site. */
  file: string;
  prompt?: string;
}
export interface AiEnvAnswer {
  summary: string;
  items: { key: string; meaning: string; issue: string; suggestion: string; action: AiAction | null }[];
}

export interface AiSearchRequest {
  kind: SearchKind;
  index: string;
  prompt: string;
  history?: AiTurn[];
}
export interface AiSearchAnswer {
  query: string;
  filter: string;
  sort: string;
  explanation: string;
}

export interface AiWebhookRequest {
  shareId: string;
  requestId: string;
  prompt?: string;
}
export interface AiWebhookAnswer {
  /** What the request is (who sent it, what event). */
  explanation: string;
  /** A handler for the site's framework. */
  code: string;
  /** Language for highlighting (php, ts, py, go). */
  language: string;
  /** Where the code goes, e.g. routes/web.php + app/Http/Controllers/StripeWebhookController.php. */
  where: string;
}

export interface AiAskRequest {
  prompt: string;
  history?: AiTurn[];
}
export interface AiAskAnswer {
  /** What DevCatz will do, or the answer when nothing needs doing. */
  explanation: string;
  actions: AiAction[];
}

/** One working tree of a site's repository (`git worktree list`). */
export interface WorktreeInfo {
  /** The worktree's folder. */
  path: string;
  /** The site's folder inside it (differs when the site is a subfolder of the repository). */
  sitePath: string;
  branch: string | null;
  head: string | null;
  /** The repository's main working tree (where `.git` lives). */
  main: boolean;
  locked: boolean;
  /** Its folder is gone (`git worktree prune` would drop it). */
  prunable: boolean;
  /** The DevCatz site serving it, when there is one. */
  siteId: string | null;
}

export interface WorktreeList {
  /** Where New worktree… puts the folder by default (`<repo>.worktrees` next to the repository). */
  defaultFolder: string;
  items: WorktreeInfo[];
}

/** What removing a worktree would throw away (asked before Remove worktree). */
export interface WorktreeCheck {
  branch: string | null;
  /** Uncommitted changes and untracked files. */
  changed: number;
  /** Commits not on the branch's upstream (or on no remote). */
  unpushed: number;
  /** The worktree's own database copy, if any. */
  database: string | null;
}

export interface WorktreeCreateOptions {
  branch: string;
  /** Create the branch (from `from`, default the current HEAD) instead of checking out an existing one. */
  create: boolean;
  from?: string;
  /** Parent folder of the new worktree; empty = the default folder. */
  folder?: string;
  /** node_modules / vendor: cloned from the parent site (APFS copy-on-write), installed, or left alone. */
  deps: 'clone' | 'install' | 'none';
  /** The parent's database, or a copy of it named after the branch (MySQL, MariaDB, PostgreSQL, SQLite services). */
  database: 'shared' | 'copy';
}

export interface GitSummary {
  branch: string | null;
  detached: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  /** Changed, added, deleted and untracked files. */
  changed: number;
  conflicts: number;
  /** A merge / rebase / cherry-pick / revert waiting to be finished. */
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
}

export interface GitFile {
  path: string;
  /** Renamed / copied from. */
  from: string | null;
  /** Porcelain codes: index (staged) and worktree letters (M A D R C U ? .). */
  index: string;
  worktree: string;
  staged: boolean;
  unstaged: boolean;
  untracked: boolean;
  conflict: boolean;
}

export interface GitRemote {
  name: string;
  url: string;
  /** Parsed host / owner / repo and the matching connected account, if any. */
  host: string | null;
  owner: string | null;
  repo: string | null;
  webUrl: string | null;
  accountId: string | null;
  kind: GitHostKind | null;
}

export interface GitStatus extends GitSummary {
  root: string;
  head: string | null;
  files: GitFile[];
  remotes: GitRemote[];
  stashes: number;
  /** Commit author identity (git config user.name / user.email). */
  identity: { name: string | null; email: string | null };
  last: GitCommit | null;
}

export interface GitCommit {
  sha: string;
  short: string;
  parents: string[];
  author: string;
  email: string;
  date: string;
  subject: string;
  refs: string[];
}

export interface GitBranch {
  name: string;
  remote: boolean;
  current: boolean;
  upstream: string | null;
  ahead: number;
  behind: number;
  sha: string;
  subject: string;
  date: string;
}

export interface GitStash {
  ref: string;
  message: string;
  date: string;
}

export interface GitTag {
  name: string;
  sha: string;
  date: string;
  subject: string;
}

/** An open pull / merge request of the site's repository. */
export interface GitPull {
  number: number;
  title: string;
  author: string;
  draft: boolean;
  head: string;
  base: string;
  url: string;
  updatedAt: string;
  /** CI result of the head commit (GitHub check runs, GitLab pipeline …), null = none / unknown. */
  checks: 'success' | 'failure' | 'pending' | null;
  /** Review / merge state as the host words it (approved, changes requested, mergeable …). */
  review: string | null;
}

export interface GitSshKey {
  path: string;
  type: string;
  comment: string;
  fingerprint: string;
  publicKey: string;
}

/** A clone in progress (New Site → from Git). */
export interface GitCloneTask {
  url: string;
  dest: string;
  /** Last output lines (progress lines replace each other). */
  lines: string[];
  done: boolean;
  error: string | null;
}

export interface GitState {
  /** `git --version`, null when git is missing (Xcode Command Line Tools not installed). */
  version: string | null;
  accounts: GitAccount[];
  clone: GitCloneTask | null;
  /** Default folder new clones go into (the folder most sites live in). */
  cloneDir: string;
}

export type GitSyncAction = 'fetch' | 'pull' | 'pull-rebase' | 'push' | 'push-force';

// ------------------------------------------------------------ database services

export type DbEngine = 'mysql' | 'mariadb' | 'postgresql' | 'redis' | 'valkey' | 'mongodb' | 'elasticsearch' | 'sqlite';

/** One database server instance (or, for SQLite, a folder of database files). */
export interface DbServiceConfig {
  id: string;
  engine: DbEngine;
  /** Full server version, e.g. 8.4.11. */
  version: string;
  name: string;
  /** 127.0.0.1 port (0 for SQLite). */
  port: number;
  /** MySQL/MariaDB unix socket ('' = /tmp/devcatz-<engine>-<port>.sock). */
  socket: string;
  /** '' = <Settings → Database data folder>/<id>. */
  dataDir: string;
  /** Optional my.cnf / postgresql.conf / redis.conf / mongod.conf / elasticsearch.yml. */
  configFile: string;
  /** MySQL/MariaDB: run without the binary log. */
  disableBinLog: boolean;
  autoStart: boolean;
  user: string;
  password: string;
  /** First-start setup done (root@'%' for MySQL/MariaDB, postgres role for PostgreSQL). */
  bootstrapped?: boolean;
}

/** A server build on disk that instances run from. */
export interface DbBinary {
  engine: DbEngine;
  version: string;
  /** Folder with bin/, lib/ … (Homebrew: the formula's opt prefix). */
  root: string;
  source: 'download' | 'source' | 'homebrew' | 'system';
}

export interface DbVersionOption {
  version: string;
  /** e.g. "8.4 LTS". */
  label: string;
  installed: boolean;
  source: DbBinary['source'];
  note?: string;
}

export interface DbEngineInfo {
  engine: DbEngine;
  name: string;
  description: string;
  defaultPort: number;
  /** Where builds come from, shown in the form. */
  sourceNote: string;
  /** Set when something is missing to install (Homebrew, Xcode Command Line Tools). */
  requirement: string | null;
  installed: DbBinary[];
}

export interface DbServiceState extends DbServiceConfig {
  engineName: string;
  status: ProcessStatus;
  error: string | null;
  /** Install (download/build + data folder) or removal in progress. */
  task: TaskProgress | null;
  /** Being created: not saved yet (the install is still running or failed). */
  pending: boolean;
  resolvedDataDir: string;
  /** Settings → Database → DB domain (db.localhost) when set: every service answers on it, told apart by port. */
  host: string | null;
  /** Socket clients can use (MySQL/MariaDB/PostgreSQL), if any. */
  resolvedSocket: string | null;
  binaryRoot: string | null;
  /** Project ids linked to this instance. */
  linkedSites: string[];
}

/** A database server running outside DevCatz (DBngin, Laravel Herd, Docker, Homebrew …). */
export interface ExternalDbService {
  engine: DbEngine | null;
  port: number;
  pid: number | null;
  process: string;
  source: 'DBngin' | 'Laravel Herd' | 'Docker' | 'OrbStack' | 'Homebrew' | 'Postgres.app' | 'Other';
  path: string | null;
}

/** A database server outside DevCatz to copy databases from (Database → Running elsewhere → Import). */
export interface DbImportSource {
  engine: 'mysql' | 'mariadb' | 'postgresql';
  port: number;
  user: string;
  password: string;
  /** Where it comes from, for messages: "DBngin", "Postgres.app" … */
  label: string;
}
/** One database on the source server. */
export interface DbImportCandidate {
  name: string;
  bytes: number | null;
  /** The target service already has a database with this name (it is skipped). */
  exists: boolean;
}

/** DBngin's installed servers (not necessarily running). */
export interface DbnginInstall {
  engine: DbEngine;
  version: string;
}

export type DbServiceInput = Omit<DbServiceConfig, 'id' | 'bootstrapped'>;

// ------------------------------------------------------------ monitoring

/**
 * What the monitor measures. New kinds of services (WebSocket servers, search
 * engines) register their processes the same way and show up on their own.
 */
export type MonitorKind = 'site' | 'php' | 'database' | 'storage' | 'websocket' | 'search' | 'whatsapp' | 'gateway' | 'container' | 'devcatz';

/** One point: CPU %, memory bytes, network and disk rates (bytes/s). */
export interface MonitorPoint {
  t: number;
  cpu: number;
  mem: number;
  netIn: number;
  netOut: number;
  diskRead: number;
  diskWrite: number;
}

export interface MonitorEntity extends Omit<MonitorPoint, 't'> {
  id: string;
  kind: MonitorKind;
  name: string;
  /** e.g. "MySQL 26.7 · :3306", "Laravel", sites served by a PHP-FPM pool. */
  detail: string;
  /** Running something right now (stopped services stay listed with their disk use). */
  active: boolean;
  processes: number;
  /** Bytes on disk of its data folders (measured every few minutes), null when not known. */
  disk: number | null;
  /** Bytes of the installed build (binaries, bundled libraries), null when not applicable. */
  binaries: number | null;
  /** TCP ports it listens on, and open TCP connections (while the Monitoring page is open). */
  ports: number[];
  connections: number;
  /** Where it lives in the app, for "open". */
  link: { section: 'projects' | 'database' | 'storage' | 'websocket' | 'search' | 'whatsapp'; id: string } | null;
}

export interface MonitorSystem {
  /** Whole Mac. */
  cpu: number;
  cores: number;
  load: [number, number, number];
  memTotal: number;
  /** App memory + wired + compressed, like Activity Monitor's "Memory Used". */
  memUsed: number;
  memPressure: 'normal' | 'warn' | 'critical' | null;
  swapUsed: number;
  diskTotal: number;
  diskFree: number;
  /** All processes' network rates (bytes/s). */
  netIn: number;
  netOut: number;
}

export interface MonitorUpdate {
  at: number;
  /** Seconds between samples right now. */
  interval: number;
  system: MonitorSystem;
  /** Totals over everything DevCatz runs (sites, services, DevCatz itself). */
  total: MonitorPoint;
  entities: MonitorEntity[];
  capabilities: { blockIo: boolean; net: boolean; docker: boolean; blockIoHint: string | null };
}

export type MonitorRange = '1h' | '6h' | '24h';

export interface MonitorSnapshot extends MonitorUpdate {
  /** Up to an hour of points per entity id, plus `system` and `total`. */
  history: Record<string, MonitorPoint[]>;
}

export interface LogLine {
  projectId: string;
  /** `out`/`err` from the dev process, `sys` for DevCatz messages, `db` for database tasks. */
  stream: 'out' | 'err' | 'sys' | 'db';
  text: string;
  time: number;
}

/** A framework command run from the site's Database tab (PHP / Python frameworks). */
/** A dependency command of a site (composer install, npm update, go mod tidy …), from the manifests it has. */
export interface DepCommand {
  id: string;
  /** composer, npm / bun / pnpm / yarn, uv / poetry / pdm / pipenv / pip, go. */
  tool: string;
  /** Manifest it comes from (composer.json, package.json, requirements.txt, go.mod …). */
  manifest: string;
  label: string;
  /** Shown under the button; the shell command, or what DevCatz does for the Python install. */
  command: string;
  /** Changes lock files / versions. */
  danger?: boolean;
}

/** A data library a site uses: an ORM, a query builder or a migration tool. */
export interface DataLib {
  /** Mark key: knex, drizzle, sequelize, kysely, prisma, sqlalchemy, sqlmodel, pypika, alembic, eloquent, db-facade, doctrine, hydrahon, gorm. */
  id: string;
  name: string;
  kind: 'orm' | 'query-builder' | 'migrations' | 'codegen' | 'driver';
  /** Where it was found (project-relative). */
  dir: string;
  /** e.g. the config file it uses, or what is missing for its commands. */
  note?: string;
}

export interface StackTask {
  id: string;
  /** Group label, e.g. "spark", "yii", "Django". */
  tool: string;
  label: string;
  /** Shell command; `{name}` is replaced by what the user types (needsName). */
  command: string;
  cwd: string;
  danger?: boolean;
  needsName?: boolean;
  /** Placeholder for the name field, e.g. "create_users_table". */
  namePlaceholder?: string;
  needsBin?: string;
}

export interface PythonStack {
  /** uv, Poetry, PDM, Pipenv or pip (requirements.txt). */
  tool: 'uv' | 'poetry' | 'pdm' | 'pipenv' | 'pip';
  /** Project-relative virtualenv folder (`.venv`, `venv`, `env`), null when none yet. */
  venv: string | null;
  /** Python of the venv (pyvenv.cfg). */
  venvVersion: string | null;
  /** What the project asks for: .python-version or requires-python. */
  spec: string | null;
  /** Celery found: worker / beat can run next to the site (the site's queue / scheduler switches). */
  celery: string | null;
}

/** One database command a Go/GORM module supports (goose, golang-migrate, Atlas, Makefile, cmd/seed). */
export interface GoDbTask {
  id: string;
  tool: string;
  label: string;
  /** Shell command; `{name}` is replaced by the name the user types (needsName). */
  command: string;
  /** Project-relative directory it runs in. */
  cwd: string;
  danger?: boolean;
  needsName?: boolean;
  /** A CLI that must be installed (e.g. `atlas`). */
  needsBin?: string;
}

export interface GoDbInfo {
  app: string;
  /** Module directory, project-relative. */
  dir: string;
  /** What it uses: data libraries (gorm, ent, sqlc, sqlx, bun, pgx, sqlboiler, squirrel, goqu) and migration tools (goose, golang-migrate, atlas, dbmate, sql-migrate, tern). */
  libs: string[];
  engine: 'mysql' | 'postgres' | 'sqlite' | null;
  /** Files calling db.AutoMigrate(…): the schema follows the models when the app starts. */
  autoMigrate: string[];
  migrationDir: string | null;
  tasks: GoDbTask[];
  hints: string[];
}

export interface EnvFileInfo {
  /** Project-relative, e.g. `.env` or `apps/api/.env`. */
  path: string;
  dir: string;
  name: string;
  exists: boolean;
  /** .env.example and friends. */
  template: boolean;
  size: number;
  mtime: number;
  /** The folder's .env.example (for Create). */
  example: string | null;
}

export type DbAction =
  | 'start'
  | 'stop'
  | 'migrate'
  | 'reset'
  | 'seed'
  | 'generate'
  | 'redis-start'
  | 'redis-stop'
  | 'artisan-migrate'
  | 'artisan-fresh'
  | 'artisan-seed';

/** A Laravel Herd site found for import. */
export interface HerdSite {
  name: string;
  path: string;
  /** `link` = in Herd's Sites folder, `park` = inside a parked folder. */
  via: 'link' | 'park';
  /** Already a DevCatz site. */
  linked: boolean;
}

/** Methods the renderer may call; mirrored by `ipcMain.handle` in the main process. */
export interface HerdApi {
  getState(): Promise<AppState>;
  getLogs(projectId: string): Promise<LogLine[]>;
  clearLogs(projectId: string): Promise<void>;
  pickFolder(): Promise<string | null>;
  /** Detects a folder's stack without linking it (for the New Site form). */
  inspectFolder(path: string): Promise<FolderPreview>;
  linkProject(path: string, options?: LinkOptions): Promise<ProjectState | null>;
  parkFolder(path: string): Promise<void>;
  unparkFolder(path: string): Promise<void>;
  /** `confirmDomain` must equal the site's domain (typed by the user): guards against a misclick. */
  removeProject(id: string, confirmDomain: string): Promise<void>;
  /** Puts one app of a monorepo / folder site on `<sub>.<site domain>` ('' = the site's own domain); `null` = the default. */
  setAppSubdomain(siteId: string, dir: string, sub: string | null): Promise<void>;
  /** The site's .gitignore (`exists` false: none yet), and a starting point for its stack. */
  gitignoreRead(siteId: string): Promise<{ exists: boolean; content: string; suggested: string }>;
  /** Writes the site's .gitignore (creates it when missing). */
  gitignoreSave(siteId: string, content: string): Promise<void>;
  /** What Build can run for a site: the whole project (root build script) and each app with a build (npm run build, go build …). */
  buildTargets(siteId: string): Promise<BuildTarget[]>;
  /** Runs one build target (its `id`), output in the site's log; resolves when it finished, throws when it failed. */
  buildSite(siteId: string, target: string): Promise<void>;
  /** A site's dependency folders with their sizes (Free up space). */
  siteDeps(siteId: string, fresh?: boolean): Promise<SiteDeps>;
  /** Every site's dependency folders (measured in the background, cached for a few minutes; `fresh` measures again). */
  depsReport(fresh?: boolean): Promise<SiteDeps[]>;
  /** Moves these dependency folders of a stopped site to the Trash; returns the bytes freed. */
  freeDeps(siteId: string, paths: string[]): Promise<number>;
  /** Who already uses a domain (another site, an app, a DevCatz service), or null when it is free; `siteId` = the site being edited. */
  domainOwner(domain: string, siteId?: string): Promise<string | null>;
  /** The databases on a server outside DevCatz, read with the target service's client (and which the target already has). */
  dbImportList(targetId: string, source: DbImportSource): Promise<DbImportCandidate[]>;
  /** Copies one database from that server into the target service (dump → restore); the source is only read. */
  dbImportOne(targetId: string, source: DbImportSource, name: string): Promise<void>;
  /** Where the site's OpenAPI document is (files in the project; URLs its running apps serve when `probe`). */
  siteOpenApi(siteId: string, probe?: boolean): Promise<SiteOpenApi>;
  /** Shows one of the site's OpenAPI files in Finder. */
  openapiReveal(siteId: string, file: string): Promise<void>;
  /** Adds an OpenAPI generator to the site: Scramble (Laravel) or @nestjs/swagger (NestJS); output in Logs. */
  addOpenApi(siteId: string, kind: 'scramble' | 'nest-swagger'): Promise<void>;
  /**
   * Writes a starter OpenAPI 3 document into an app's folder (`openapi.yaml`, or `swagger.json` in JSON): the app's
   * name and version, its local URL as the server, one example path. Refused when the file exists. Returns its path.
   */
  createOpenApi(siteId: string, format: 'yaml' | 'json', app?: string): Promise<string>;
  /** Opens DialCatz's import for a site (dialcatz://open?site=<id>); false when DialCatz is not installed. */
  dialcatzOpen(siteId: string): Promise<boolean>;
  /** Downloads the latest DialCatz release, installs it to /Applications and opens the site; progress in state.dialcatz.task. */
  dialcatzInstall(siteId: string): Promise<void>;
  dialcatzCancelInstall(): Promise<void>;
  dialcatzDismiss(): Promise<void>;
  /** Restarts one app of a site that runs one process per app (monorepo / folder project); the rest keep running. */
  restartApp(siteId: string, dir: string): Promise<void>;
  /** Who uses `port` (another site, a program), or null when one of the site's apps can take it. */
  sitePortUse(siteId: string, dir: string, port: number): Promise<string | null>;
  /** Moves a managed app of the site to `port` (refused while it is in use); `writeEnv` also writes it into the .env (the keys changed). */
  setSitePort(siteId: string, dir: string, port: number, writeEnv?: boolean): Promise<string[]>;
  /** The .env files holding an app's port variables, and whether the environment is locked. */
  appPortEnv(siteId: string, dir: string): Promise<{ files: string[]; keys: string[]; locked: boolean } | null>;
  /** A free port for an app (not another site's, nothing listening). */
  freePortFor(siteId: string, dir: string): Promise<number>;
  updateProject(id: string, patch: Partial<Pick<ProjectConfig, 'name' | 'domain' | 'devCommand' | 'autoStart' | 'nodeVersion' | 'managedPorts' | 'packageManager' | 'goVersion' | 'secure' | 'phpVersion' | 'queueWorker' | 'scheduler' | 'reverb' | 'wsServer' | 'wsPath' | 'searchEngine' | 'storageService' | 'envLocked' | 'envDomainOverride' | 'redisDb' | 'redisCacheDb' | 'redisConnDbs' | 'dbService' | 'pythonVersion'>>): Promise<void>;
  envFiles(id: string): Promise<EnvFileInfo[]>;
  envRead(id: string, path: string): Promise<{ content: string; mtime: number }>;
  /** `mtime` from the read: refuses if the file changed on disk meanwhile. Returns the new mtime. */
  envWrite(id: string, path: string, content: string, mtime: number | null): Promise<number>;
  /** Creates the file from the folder's .env.example (or empty); Laravel also gets `artisan key:generate`. */
  envCreate(id: string, path: string): Promise<void>;
  /**
   * Sets keys in a site's .env: `apply: false` only returns what would change (added / changed / unchanged);
   * `apply: true` writes it (existing keys replaced in place, new ones appended under `comment`).
   */
  envMerge(id: string, path: string, entries: Record<string, string>, comment: string, apply: boolean): Promise<{ added: string[]; changed: { key: string; from: string; to: string }[]; unchanged: string[] }>;
  rescan(): Promise<void>;
  /** Looks for installed PHP / Node / Bun / Go / Python again (versions added or removed outside DevCatz, e.g. Laravel Herd uninstalled). */
  refreshRuntimes(): Promise<void>;
  start(id: string): Promise<void>;
  stop(id: string): Promise<void>;
  restart(id: string): Promise<void>;
  openUrl(url: string): Promise<void>;
  /** Laravel: `php artisan key:generate` (a new APP_KEY in .env). */
  envKeyGenerate(siteId: string): Promise<void>;
  /** Runtimes a site needs that are missing, with the version Install adds. */
  siteRuntimeNeeds(siteId: string): Promise<RuntimeNeed[]>;
  /** The version Install would add for a runtime spec (New Site, before the site exists). */
  runtimePick(kind: RuntimeNeed['kind'], spec: string | null): Promise<string | null>;
  /** Version, platform and the shared site address, for Settings → About. */
  aboutInfo(): Promise<AboutInfo>;
  /** DevCatz's own updates (Catzoid #54). */
  appUpdateCheck(): Promise<AppUpdateState>;
  appUpdateDownload(): Promise<void>;
  appUpdateCancel(): Promise<void>;
  /** Stops everything, installs the downloaded update and starts DevCatz again (running sites come back). */
  appUpdateRestart(): Promise<void>;
  appUpdateSkip(): Promise<void>;
  appUpdateInstallOnQuit(on: boolean): Promise<void>;
  appUpdatePrefs(patch: { auto?: boolean; channel?: 'stable' | 'beta'; notify?: boolean }): Promise<void>;
  /** Report a Bug / Send Feedback (Catzoid #65). */
  reportPreview(kind: ReportKind, message: string, email: string, shots?: number): Promise<ReportPreview>;
  reportSend(kind: ReportKind, message: string, email: string, shots?: ReportShot[]): Promise<{ sent: boolean; queued: boolean }>;
  /** The window as a PNG (base64), for "Capture this window" in Report a Bug (the dialog hides itself first). */
  captureWindow(): Promise<string>;
  /** An uncaught error in the window (sent only with crash reports on). */
  reportError(message: string, stack: string | null): Promise<void>;
  setCrashReports(on: boolean): Promise<void>;
  crashAskDismiss(): Promise<void>;
  /** Uninstall DevCatz (Catzoid #55). */
  uninstallPlan(): Promise<UninstallPlan>;
  uninstall(opts: { removeData: boolean; removeShared: boolean }): Promise<void>;
  openFolder(id: string): Promise<void>;
  openEditor(id: string): Promise<void>;
  openTerminal(id: string): Promise<void>;
  db(id: string, action: DbAction, arg?: string): Promise<void>;
  updateSettings(patch: Partial<Settings>): Promise<void>;
  trustCa(): Promise<boolean>;
  untrustCa(): Promise<boolean>;
  revealCa(): Promise<void>;
  setLaunchAtLogin(on: boolean): Promise<void>;
  /** Stops every dev server and exits the app. */
  quitApp(): Promise<void>;
  startAll(): Promise<void>;
  stopAll(): Promise<void>;
  /** Navigation requested from the menu bar before the window was ready (e.g. `new-site`). */
  takePendingNav(): Promise<string | null>;
  /** Data URL of the site's preview screenshot. */
  getScreenshot(id: string): Promise<string | null>;
  redisDetails(id: string): Promise<RedisDetails | null>;
  /** Writes the chosen Redis DB index(es) to the project's .env (preview with apply=false); the per-site override is cleared after a write. */
  redisWriteEnv(id: string, apply: boolean): Promise<{ file: string; added: string[]; changed: { key: string; from: string; to: string }[]; unchanged: string[] }>;
  /** Runs `<package manager> install` for the site. */
  installDeps(id: string): Promise<void>;
  /** Dependency commands for the site's manifests. */
  depCommands(id: string): Promise<DepCommand[]>;
  depRun(id: string, commandId: string): Promise<void>;
  nodeRemote(refresh?: boolean): Promise<RemoteNode[]>;
  nodeInstall(version: string): Promise<void>;
  nodeUninstall(version: string): Promise<void>;
  nodeSetDefault(version: string | null): Promise<void>;
  /** Windows: adds DevCatz's shim folder (node, npm, bun, go, php, composer …) to the user's Path, or takes it out. */
  shimPathSet(on: boolean): Promise<void>;
  bunRemote(refresh?: boolean): Promise<RemoteBun[]>;
  bunInstall(version: string): Promise<void>;
  bunUninstall(version: string): Promise<void>;
  bunSetDefault(version: string | null): Promise<void>;
  goRemote(refresh?: boolean): Promise<RemoteGo[]>;
  goInstall(version: string): Promise<void>;
  goUninstall(version: string): Promise<void>;
  goSetDefault(version: string | null): Promise<void>;
  /** Downloads rustup-init and installs Rust (stable) the standard way: ~/.rustup and ~/.cargo. */
  rustInstall(): Promise<void>;
  rustRemote(refresh?: boolean): Promise<RemoteRust[]>;
  rustToolchainInstall(name: string): Promise<void>;
  rustToolchainUninstall(name: string): Promise<void>;
  rustSetDefault(name: string): Promise<void>;
  /** rustup target add (wasm32-unknown-unknown for WebAssembly frontends). */
  rustTargetAdd(target: string): Promise<void>;
  /** Installs a framework CLI (trunk, dx, cargo-leptos, cargo-tauri), Solana (Agave) or Anchor (avm). */
  rustToolInstall(id: RustToolId): Promise<void>;
  /** Installs uv (Astral), which then installs Pythons and creates venvs. */
  uvInstall(): Promise<void>;
  pythonRemote(): Promise<RemotePython[]>;
  pythonInstall(version: string): Promise<void>;
  pythonUninstall(version: string): Promise<void>;
  pythonSetDefault(version: string | null): Promise<void>;
  phpRemote(refresh?: boolean): Promise<RemotePhp[]>;
  phpInstall(version: string): Promise<void>;
  phpUninstall(version: string): Promise<void>;
  phpSetDefault(version: string | null): Promise<void>;
  phpGetIni(version: string): Promise<{ settings: PhpIniSettings; effective: Record<string, string> }>;
  phpSetIni(version: string, settings: PhpIniSettings): Promise<void>;
  composerInstall(): Promise<void>;
  /** Built-in modules, DevCatz-built PECL extensions and the catalog for one PHP version. */
  phpExtensions(version: string): Promise<PhpExtensions>;
  /** Builds a PECL package for a PHP version (phpize), enables it and reloads PHP-FPM. */
  phpExtInstall(version: string, pkg: string): Promise<void>;
  phpExtSetEnabled(version: string, module: string, on: boolean): Promise<void>;
  phpExtRemove(version: string, module: string): Promise<void>;
  phpExtDismiss(): Promise<void>;
  /** Opens that version's php.ini (etc folder: php.ini + conf.d) in the configured editor. */
  phpOpenIni(version: string): Promise<void>;
  restartServices(): Promise<void>;
  /** GORM tooling per Go module of the site. */
  goDbInfo(id: string): Promise<GoDbInfo[]>;
  /** Runs one detected task (`name` for create/diff tasks); output goes to the Logs tab. */
  goDbTask(id: string, dir: string, taskId: string, name?: string): Promise<void>;
  /** Runs one of the site's framework commands (StackInfo.tasks); output in the Logs tab. */
  stackTask(id: string, taskId: string, name?: string): Promise<void>;
  /** Engines with their installed builds (no network). */
  dbEngines(): Promise<DbEngineInfo[]>;
  /** Versions that can be installed (network, cached) plus the installed ones. */
  dbVersions(engine: DbEngine): Promise<DbVersionOption[]>;
  /** Defaults for a new instance of `engine` at `version` (name, port, data folder). */
  dbDefaults(engine: DbEngine, version: string): Promise<DbServiceInput>;
  /** Installs the build if needed, prepares the data folder and saves the instance; returns its id. */
  dbCreate(input: DbServiceInput): Promise<string>;
  dbCancelCreate(id: string): Promise<void>;
  /** Drops a failed/pending create from the list. */
  dbDismiss(id: string): Promise<void>;
  dbUpdate(id: string, input: DbServiceInput): Promise<void>;
  /** `confirmName` must be the instance name (typed by the user). */
  dbRemove(id: string, deleteData: boolean, confirmName: string): Promise<void>;
  dbAction(id: string, action: StorageAction): Promise<void>;
  dbOpenData(id: string): Promise<void>;
  dbOpenBinaries(id: string): Promise<void>;
  /** Database servers listening on this Mac that DevCatz does not run, plus DBngin's installed versions. */
  dbDetect(): Promise<{ running: ExternalDbService[]; dbngin: DbnginInstall[] }>;
  /** Databases on the server (SQL engines), or database files (SQLite). */
  dbList(id: string): Promise<string[]>;
  /** CREATE DATABASE (SQL engines) or a new .sqlite file. */
  dbCreateDatabase(id: string, name: string): Promise<void>;
  /** An installed server build: show it in Finder, or remove it (refused while an instance uses it). */
  dbBuildAction(engine: DbEngine, version: string, action: 'reveal' | 'remove'): Promise<void>;
  /** Latest sample plus up to an hour of history. */
  monitorSnapshot(): Promise<MonitorSnapshot>;
  /** History for a range: every sample for 1 h, per-minute averages (kept on disk) for 6 h / 24 h. */
  monitorHistory(range: MonitorRange): Promise<Record<string, MonitorPoint[]>>;
  /** Saves a range of history as CSV (save dialog); returns the file, null when cancelled. */
  monitorExport(range: MonitorRange): Promise<string | null>;
  /** The Monitoring page is open: sample every few seconds and push updates (`onMonitor`). */
  monitorLive(on: boolean): Promise<void>;
  /** Opens DBCatz (the database viewer app) at a connection: `svc:<service id>` with an optional database, or null for its Connections tab. false when DBCatz is not installed. */
  dbcatzOpen(connId: string | null, database?: string): Promise<boolean>;
  /** Downloads the latest DBCatz release, installs it to /Applications and opens `connId`; progress in state.dbcatz.task. */
  dbcatzInstall(connId: string | null, database?: string): Promise<void>;
  dbcatzCancelInstall(): Promise<void>;
  dbcatzDismiss(): Promise<void>;
  searchInstall(kind: SearchKind, config: SearchConfig): Promise<void>;
  searchUpdate(kind: SearchKind, config: SearchConfig): Promise<void>;
  searchCancelInstall(kind: SearchKind): Promise<void>;
  /** `confirmHost` must be the engine's domain (typed by the user). */
  searchUninstall(kind: SearchKind, deleteData: boolean, confirmHost: string): Promise<void>;
  searchAction(kind: SearchKind, action: StorageAction): Promise<void>;
  searchOpenData(kind: SearchKind): Promise<void>;
  searchIndexes(kind: SearchKind): Promise<SearchIndex[]>;
  /** `schema`: Manticore columns (`title text, price float`); Meilisearch primary key; ignored elsewhere. */
  searchCreateIndex(kind: SearchKind, name: string, schema: string): Promise<void>;
  searchDeleteIndex(kind: SearchKind, name: string): Promise<void>;
  /** Settings as text (JSON, or Manticore's CREATE TABLE) and whether they can be saved. */
  searchGetSettings(kind: SearchKind, index: string): Promise<{ text: string; editable: boolean }>;
  searchSaveSettings(kind: SearchKind, index: string, text: string): Promise<void>;
  searchQuery(kind: SearchKind, query: SearchQuery): Promise<SearchResult>;
  /** Adds or replaces documents (JSON array, one object, or NDJSON); returns how many. */
  searchUpsert(kind: SearchKind, index: string, text: string): Promise<number>;
  /** Imports a JSON / NDJSON / CSV file chosen in a dialog; returns how many, null when cancelled. */
  searchImportFile(kind: SearchKind, index: string): Promise<number | null>;
  searchDeleteDoc(kind: SearchKind, index: string, id: string): Promise<void>;
  /** Meilisearch task queue, newest first; `status` filters (comma list). */
  searchTasks(kind: SearchKind, status: string, from: number | null): Promise<{ tasks: SearchTask[]; next: number | null }>;
  searchCancelTasks(kind: SearchKind, uids: number[]): Promise<void>;
  searchClearTasks(kind: SearchKind): Promise<void>;
  searchBackups(kind: SearchKind): Promise<SearchBackup[]>;
  searchCreateBackup(kind: SearchKind, type: 'dump' | 'snapshot'): Promise<void>;
  searchDeleteBackup(kind: SearchKind, file: string): Promise<void>;
  searchRevealBackup(kind: SearchKind, file: string): Promise<void>;
  /** Stops the engine, moves the current data aside and starts it with the dump / snapshot imported. */
  searchRestoreBackup(kind: SearchKind, file: string): Promise<void>;
  /** Saves every document of an index as NDJSON or a JSON array (save dialog); null when cancelled. */
  searchExport(kind: SearchKind, index: string, format: 'ndjson' | 'json'): Promise<number | null>;
  searchKeys(kind: SearchKind): Promise<SearchKey[]>;
  // ---- Mail
  mailAction(action: 'start' | 'stop' | 'restart'): Promise<void>;
  /** Newest first; `query` matches subject, addresses and the site; `siteId` limits to one site. */
  mailList(query: string, siteId: string | null, limit: number): Promise<MailSummary[]>;
  mailGet(id: string): Promise<MailMessage>;
  mailRaw(id: string): Promise<string>;
  mailMarkRead(ids: string[], read: boolean): Promise<void>;
  mailDelete(ids: string[]): Promise<void>;
  mailDeleteAll(): Promise<void>;
  /** Save dialog for one attachment. */
  mailSaveAttachment(id: string, attachmentId: string): Promise<string | null>;
  /** data: URL of an attachment (images shown inline in the viewer). */
  mailAttachmentData(id: string, attachmentId: string): Promise<string>;
  mailForward(id: string, to: string): Promise<void>;
  mailForwardConfig(): Promise<MailForwardConfig | null>;
  mailSetForwardConfig(config: MailForwardConfig | null): Promise<void>;
  /** .env lines pointing a site at the catcher (per stack). */
  mailEnv(siteId: string): Promise<Record<string, string>>;
  /** Sends a test mail into the catcher (from a site when given). */
  mailSendTest(siteId: string | null): Promise<void>;
  mailOpenData(): Promise<void>;
  // ---- Expose
  exposeInstall(tool: ExposeTool): Promise<void>;
  exposeCancelInstall(): Promise<void>;
  /** Removes a tunnel tool's binary; refused while a share runs on it. `confirmName` must be the tool's name (typed by the user). Accounts and logins stay. */
  exposeUninstall(tool: ExposeTool, confirmName: string): Promise<void>;
  /** Looks for newer releases of the installed tools; returns the ones that could not be checked. */
  exposeCheckUpdates(): Promise<string[]>;
  /** Downloads the newer release in place of the tool (shares on it are stopped first). */
  exposeUpgrade(tool: ExposeTool): Promise<void>;
  /** Opens the browser for `cloudflared tunnel login`; resolves once the certificate is saved. */
  exposeCloudflareLogin(): Promise<void>;
  exposeCloudflareLogout(): Promise<void>;
  /** Saves (or with token null removes) a provider account; '' keeps the stored token. */
  exposeSetAccount(provider: 'ngrok' | 'expose', input: { token: string | null; domain?: string; server?: string }): Promise<void>;
  exposeStart(options: ExposeOptions): Promise<ExposeShare>;
  exposeStop(shareId: string): Promise<void>;
  exposeRequests(shareId: string, limit: number): Promise<ExposeRequest[]>;
  exposeClearRequests(shareId: string): Promise<void>;
  exposeReplay(shareId: string, requestId: string): Promise<ExposeRequest>;
  // ---- Git (site)
  // WhatsApp (gateway engines, sessions, inspector, webhooks)
  waInstall(engine: WaEngine, config: WaConfig): Promise<void>;
  waUpdate(engine: WaEngine, config: WaConfig): Promise<void>;
  waCancelInstall(engine: WaEngine): Promise<void>;
  /** `confirmHost` must be the engine's domain (typed by the user). */
  waUninstall(engine: WaEngine, deleteData: boolean, confirmHost: string): Promise<void>;
  waAction(engine: WaEngine, action: StorageAction): Promise<void>;
  waOpenData(engine: WaEngine): Promise<void>;
  waCheckUpdates(): Promise<string[]>;
  /** Hides a finished / failed / cancelled task of a service (storage, ws, search, whatsapp, gateway, expose). */
  taskDismiss(scope: 'storage' | 'ws' | 'search' | 'whatsapp' | 'gateway' | 'expose', id: string): Promise<void>;
  // Gateways: email (Stalwart, Postal), push (ntfy, Gotify), SMS (Jasmin)
  gwInstall(kind: GwKind, config: GwConfig): Promise<void>;
  gwUpdate(kind: GwKind, config: GwConfig): Promise<void>;
  gwCancelInstall(kind: GwKind): Promise<void>;
  /** `confirmHost` must be the gateway's domain (typed by the user). */
  gwUninstall(kind: GwKind, deleteData: boolean, confirmHost: string): Promise<void>;
  gwAction(kind: GwKind, action: StorageAction): Promise<void>;
  gwOpenData(kind: GwKind): Promise<void>;
  gwCheckUpdates(): Promise<string[]>;
  gwUpgrade(kind: GwKind): Promise<void>;
  gwSetAutoStart(kind: GwKind, on: boolean): Promise<void>;
  /** Sends a test email / notification / SMS through the gateway, as a site would. */
  gwSend(kind: GwKind, input: GwSendInput): Promise<GwSendResult>;
  /** .env lines pointing a site at the gateway. */
  gwEnv(kind: GwKind, siteId: string): Promise<Record<string, string>>;
  /** SMS caught from Jasmin, newest first. */
  gwSms(limit: number): Promise<CaughtSms[]>;
  gwClearSms(): Promise<void>;
  waUpgrade(engine: WaEngine): Promise<void>;
  /** Creates (or starts) a session; the QR to link a phone comes from waSessionQr. */
  waSessionStart(engine: WaEngine, name: string): Promise<void>;
  /** PNG data URL of the current QR, or '' when the session is not waiting for a scan. */
  waSessionQr(engine: WaEngine, name: string): Promise<string>;
  waSessionLogout(engine: WaEngine, name: string): Promise<void>;
  waSessionRemove(engine: WaEngine, name: string): Promise<void>;
  waSend(engine: WaEngine, input: WaSendInput): Promise<WaSendResult>;
  waContacts(engine: WaEngine, session: string): Promise<WaContact[]>;
  waGroups(engine: WaEngine, session: string): Promise<WaContact[]>;
  waMessages(limit: number): Promise<WaMessage[]>;
  waClearMessages(): Promise<void>;
  waHooks(): Promise<WaHook[]>;
  /** Adds (no id) or edits a webhook to a site; the secret is generated. */
  waSetHook(hook: { id?: string; siteId: string; url: string; events: string[]; enabled: boolean }): Promise<WaHook>;
  waRemoveHook(id: string): Promise<void>;
  waDeliveries(hookId: string, limit: number): Promise<WaDelivery[]>;
  waReplay(deliveryId: string): Promise<WaDelivery>;
  /** .env lines pointing a site at an engine (WHATSAPP_API_URL / KEY / SESSION, webhook secret). */
  waEnv(engine: WaEngine, siteId: string): Promise<Record<string, string>>;
  gitStatus(id: string): Promise<GitStatus | null>;
  gitInit(id: string): Promise<void>;
  gitDiff(id: string, file: string, staged: boolean): Promise<string>;
  gitStage(id: string, files: string[]): Promise<void>;
  gitUnstage(id: string, files: string[]): Promise<void>;
  /** Throws away worktree changes of these files (untracked files are deleted). */
  gitDiscard(id: string, files: string[]): Promise<void>;
  gitCommit(id: string, message: string, amend: boolean): Promise<void>;
  /** fetch / pull / push as a site task (output in Logs, cancellable). */
  gitSync(id: string, action: GitSyncAction): Promise<void>;
  gitCancel(id: string): Promise<void>;
  /** History of the current branch, or of `ref` (another branch, for cherry-picking). */
  gitLog(id: string, search: string, skip: number, ref?: string): Promise<GitCommit[]>;
  gitShow(id: string, sha: string): Promise<string>;
  gitBranches(id: string): Promise<GitBranch[]>;
  // AI (TODO §28)
  aiSettings(): Promise<AiSettings>;
  aiSetSettings(patch: AiSettingsPatch): Promise<AiSettings>;
  /** Saves (or with '' removes) a provider's API key, encrypted with the Keychain; the key never comes back. */
  aiSetKey(provider: AiProvider, key: string): Promise<AiSettings>;
  aiModels(provider: AiProvider): Promise<string[]>;
  aiProbe(provider: AiProvider, models: string[]): Promise<Record<string, string | null>>;
  aiTest(): Promise<string>;
  /** Stops a running request (token given with it). */
  aiCancel(token: string): Promise<void>;
  aiPreviewExplain(req: AiExplainRequest): Promise<AiPreview>;
  aiExplain(req: AiExplainRequest, token?: string): Promise<AiExplainAnswer>;
  aiPreviewCommit(req: AiCommitRequest): Promise<AiPreview>;
  aiCommit(req: AiCommitRequest, token?: string): Promise<AiCommitAnswer>;
  aiPreviewDockerEdit(req: AiDockerEditRequest): Promise<AiPreview>;
  aiDockerEdit(req: AiDockerEditRequest, token?: string): Promise<AiDockerEditAnswer>;
  aiPreviewEnv(req: AiEnvRequest): Promise<AiPreview>;
  aiEnv(req: AiEnvRequest, token?: string): Promise<AiEnvAnswer>;
  aiPreviewSearch(req: AiSearchRequest): Promise<AiPreview>;
  aiSearch(req: AiSearchRequest, token?: string): Promise<AiSearchAnswer>;
  aiPreviewWebhook(req: AiWebhookRequest): Promise<AiPreview>;
  aiWebhook(req: AiWebhookRequest, token?: string): Promise<AiWebhookAnswer>;
  aiPreviewAsk(req: AiAskRequest): Promise<AiPreview>;
  aiAsk(req: AiAskRequest, token?: string): Promise<AiAskAnswer>;
  /** Runs one action the model proposed (after the user clicked it); returns what happened. */
  aiRunAction(siteId: string | null, action: AiAction): Promise<string>;
  /** Working trees of the site's repository (a worktree site lists its parent's). */
  worktreeList(id: string): Promise<WorktreeList>;
  /** New worktree…: returns the new site's id. */
  worktreeCreate(id: string, options: WorktreeCreateOptions): Promise<string>;
  /** Adds an existing worktree (made outside DevCatz) as a site; returns its id. */
  worktreeAdd(id: string, sitePath: string): Promise<string>;
  worktreeCheck(id: string): Promise<WorktreeCheck>;
  worktreeRemove(id: string, force: boolean, dropDatabase: boolean): Promise<void>;
  worktreePrune(id: string): Promise<void>;
  gitBranch(id: string, action: 'create' | 'switch' | 'delete' | 'force-delete' | 'merge', name: string, from?: string): Promise<void>;
  gitStashes(id: string): Promise<GitStash[]>;
  gitStash(id: string, action: 'save' | 'apply' | 'pop' | 'drop', arg: string): Promise<void>;
  gitTags(id: string): Promise<GitTag[]>;
  gitTag(id: string, action: 'create' | 'delete' | 'push', name: string, message?: string): Promise<void>;
  /** Rebase onto a branch, or continue / skip / abort the merge, rebase or cherry-pick in progress. */
  gitOperation(id: string, action: 'rebase' | 'continue' | 'skip' | 'abort', onto?: string): Promise<void>;
  /** Squashes the branch's commits since it left `onto` into one. */
  gitSquash(id: string, onto: string, message: string): Promise<void>;
  gitCherryPick(id: string, sha: string): Promise<void>;
  gitRevert(id: string, sha: string): Promise<void>;
  gitReset(id: string, mode: 'soft' | 'mixed' | 'hard', sha: string): Promise<void>;
  /** Puts one file back to how it was in a commit (staged). */
  gitRestoreFile(id: string, file: string, sha: string): Promise<void>;
  gitOpenFile(id: string, file: string): Promise<void>;
  gitIgnoreSuggestions(id: string): Promise<string[]>;
  gitIgnoreAdd(id: string, lines: string[]): Promise<void>;
  gitSetIdentity(id: string, name: string, email: string, global: boolean): Promise<void>;
  gitAddRemote(id: string, name: string, url: string): Promise<void>;
  // ---- Git hosts
  gitPulls(id: string): Promise<GitPull[]>;
  gitCreatePull(id: string, title: string, body: string, base: string, draft: boolean): Promise<GitPull>;
  gitCheckoutPull(id: string, pull: GitPull): Promise<void>;
  gitAddAccount(kind: GitHostKind, baseUrl: string, token: string, username: string): Promise<GitAccount>;
  gitRemoveAccount(accountId: string): Promise<void>;
  gitRepos(accountId: string, search: string): Promise<GitRepo[]>;
  gitSshKeys(): Promise<GitSshKey[]>;
  gitSshGenerate(email: string): Promise<GitSshKey>;
  gitSshAddToAccount(accountId: string, keyPath: string, title: string): Promise<void>;
  /** Clones into `parent/name`; resolves with the folder. */
  gitClone(url: string, parent: string, name: string, branch: string, shallow: boolean): Promise<string>;
  gitCancelClone(): Promise<void>;
  /** Downloads the newer release, swaps the binary (data and settings stay) and restarts the service if it was running. */
  searchUpgrade(kind: SearchKind): Promise<void>;
  wsUpgrade(kind: WsKind): Promise<void>;
  storageUpgrade(kind: StorageKind): Promise<void>;
  /** Looks for newer releases of every installed storage / WebSocket / search service now; returns the ones that could not be checked. */
  servicesCheckUpdates(): Promise<string[]>;
  /** Settings → Services tables: "Starts with DevCatz" of a storage / WebSocket / search service, without a restart. */
  serviceSetAutoStart(scope: 'storage' | 'ws' | 'search', kind: string, on: boolean): Promise<void>;
  searchCreateKey(kind: SearchKind, name: string, actions: string[], indexes: string[], expiresAt: string | null): Promise<SearchKey>;
  searchDeleteKey(kind: SearchKind, id: string): Promise<void>;
  /** .env lines for a site using this engine (backend on 127.0.0.1, front end on the https:// domain with a search-only key). */
  searchEnv(kind: SearchKind, siteId: string): Promise<Record<string, string>>;
  /** .env lines pointing a site at a DevCatz storage service and bucket (backend 127.0.0.1, public URLs on the https:// domain). */
  storageEnv(kind: StorageKind, siteId: string, bucket: string): Promise<Record<string, string>>;
  /** Laravel Scout: `scout:import` / `scout:flush` for a model, or `scout:sync-index-settings`. */
  scoutCommand(siteId: string, command: 'import' | 'flush' | 'sync', model: string | null): Promise<string>;
  wsInstall(kind: WsKind, config: WsConfig): Promise<void>;
  wsUpdate(kind: WsKind, config: WsConfig): Promise<void>;
  wsCancelInstall(kind: WsKind): Promise<void>;
  /** `confirmHost` must be the server's domain (typed by the user). */
  wsUninstall(kind: WsKind, deleteData: boolean, confirmHost: string): Promise<void>;
  wsAction(kind: WsKind, action: StorageAction): Promise<void>;
  wsOpenData(kind: WsKind): Promise<void>;
  /** Live numbers from the server's API: clients, channels, messages per second. */
  wsStats(kind: WsKind): Promise<WsStats>;
  /** Publishes an event on a channel through the server's API (Pusher `event` name; others ignore it). */
  wsPublish(kind: WsKind, channel: string, event: string, data: string): Promise<void>;
  /** Test client credentials: Pusher private/presence auth for (socketId, channel), Centrifugo connection JWT, Mercure subscriber JWT. */
  wsClientAuth(kind: WsKind, socketId: string, channel: string): Promise<string>;
  /** .env lines for a site using this server (Laravel Echo / Pusher, Centrifugo, Mercure, NATS keys). */
  wsEnv(kind: WsKind, siteId: string): Promise<Record<string, string>>;
  /** Laravel broadcasting of a site: events, channel routes, checks (incl. GET /broadcasting/auth through the proxy). */
  laravelBroadcast(siteId: string): Promise<LaravelBroadcastInfo>;
  /** Fires an anonymous broadcast through the app's own broadcaster (Broadcast::on/private/presence()->sendNow()). */
  laravelTestBroadcast(siteId: string, type: 'public' | 'private' | 'presence', channel: string, event: string, payload: string): Promise<string>;
  /** .env lines for a Laravel site's own Reverb (REVERB_* / VITE_REVERB_*). */
  reverbEnv(siteId: string): Promise<Record<string, string>>;
  storageInstall(kind: StorageKind, config: StorageConfig): Promise<void>;
  storageUpdate(kind: StorageKind, config: StorageConfig): Promise<void>;
  /** Stops a running install: the download is aborted and nothing is kept. */
  storageCancelInstall(kind: StorageKind): Promise<void>;
  /**
   * `confirmHost` must be the service's API domain (typed by the user, e.g. rustfs.localhost);
   * `deleteData` also removes the data folder.
   */
  storageUninstall(kind: StorageKind, deleteData: boolean, confirmHost: string): Promise<void>;
  storageAction(kind: StorageKind, action: StorageAction): Promise<void>;
  storageOpenData(kind: StorageKind): Promise<void>;
  /** Opens DevCatz's logs folder (main.log, storage-<engine>.log, php-fpm …) in Finder. */
  openLogsFolder(): Promise<void>;
  /** A file picker (binary path); null when cancelled. */
  pickFile(title: string): Promise<string | null>;
  s3Buckets(kind: StorageKind): Promise<S3Bucket[]>;
  s3CreateBucket(kind: StorageKind, bucket: string): Promise<void>;
  /** Asks first; removes every object, then the bucket. */
  s3DeleteBucket(kind: StorageKind, bucket: string): Promise<void>;
  s3SetPublic(kind: StorageKind, bucket: string, on: boolean): Promise<void>;
  s3List(kind: StorageKind, bucket: string, prefix: string): Promise<S3Entry[]>;
  /**
   * Uploads into `prefix`: the given files/folders (drag & drop), or the ones picked in a dialog. Folders keep their
   * structure. Progress arrives through onUploadProgress; returns the number of files uploaded.
   */
  s3Upload(kind: StorageKind, bucket: string, prefix: string, paths?: string[]): Promise<number>;
  s3CancelUpload(kind: StorageKind): Promise<void>;
  /** Save dialog in main, then downloads; returns the saved path (null when cancelled). */
  s3Download(kind: StorageKind, bucket: string, key: string): Promise<string | null>;
  /** Asks first; a key ending in `/` deletes the whole folder. */
  s3Delete(kind: StorageKind, bucket: string, key: string): Promise<void>;
  s3MkDir(kind: StorageKind, bucket: string, prefix: string): Promise<void>;
  dockerStatus(): Promise<DockerStatus>;
  dockerFiles(id: string): Promise<DockerComposeFile[]>;
  dockerServices(id: string, file: string): Promise<DockerService[]>;
  /** Preview of the generated Docker setup (nothing is written). */
  /** Without options: the defaults for `target` (local when omitted). */
  dockerGenerate(id: string, options?: Partial<DockerGenOptions>): Promise<{ files: DockerFile[]; composeFile: string; project: string; options: DockerGenOptions; mrcatzDetected: boolean }>;
  /** Writes the chosen generated files; existing ones only when listed in `overwrite`. */
  /** `edited`: files changed in the preview (by hand or with AI), written instead of the generated content. */
  dockerWrite(id: string, options: DockerGenOptions, paths: string[], overwrite: string[], edited?: Record<string, string>): Promise<string[]>;
  /** Docker files in the site (Dockerfile*, *compose*.yml, .dockerignore) for Adjust with AI. */
  dockerListFiles(id: string): Promise<string[]>;
  dockerReadFile(id: string, file: string): Promise<string>;
  /** Saves one of those files (after the user saw the diff). */
  dockerSaveFile(id: string, file: string, content: string): Promise<void>;
  /** Runs `docker compose <action>`; output goes to the site's log. */
  dockerCompose(id: string, file: string, action: DockerAction, service?: string): Promise<void>;
  /** Opens/starts an installed container engine. */
  startEngine(id: DockerEngineId): Promise<void>;
  setFavorite(id: string, on: boolean): Promise<void>;
  /** Moves a site into `group` (created when new), or out of every group with null. */
  setSiteGroup(id: string, group: string | null): Promise<void>;
  renameGroup(from: string, to: string): Promise<void>;
  deleteGroup(name: string): Promise<void>;
  toggleGroup(name: string): Promise<void>;
  moveGroup(name: string, delta: number): Promise<void>;
  /** Native right-click menus for the sidebar. */
  siteMenu(id: string): Promise<void>;
  groupMenu(name: string): Promise<void>;
  /** Drag-and-drop order of the sidebar (every site id, in order). */
  setSiteOrder(order: string[]): Promise<void>;
  // Database list organisation (favorites, groups, order), like the sites sidebar.
  dbSetFavorite(id: string, on: boolean): Promise<void>;
  dbSetGroup(id: string, group: string | null): Promise<void>;
  dbGroupAction(name: string, action: 'rename' | 'delete' | 'toggle' | 'up' | 'down', value?: string): Promise<void>;
  dbSetOrder(order: string[]): Promise<void>;
  dbMenu(id: string): Promise<void>;
  dbGroupMenu(name: string): Promise<void>;
  /** Looks for newer patch releases of installed runtimes now. */
  checkUpdates(): Promise<void>;
  /** Installs the update for `from`; it becomes the default if `from` was. */
  runtimeUpdate(runtime: RuntimeKind, from: string): Promise<void>;
  /** Tail of storage/logs/laravel.log (or the newest laravel-*.log). */
  laravelLog(id: string, lines?: number): Promise<{ file: string | null; text: string }>;
  herdSites(): Promise<HerdSite[]>;
  refreshScreenshot(id: string): Promise<boolean>;
  /** Previews (dryRun) or applies a new default TLD, renaming sites that use the old one. */
  setTld(tld: string, dryRun?: boolean): Promise<TldChange>;
  installResolver(): Promise<boolean>;
  uninstallResolver(): Promise<boolean>;
  installCleanUrls(): Promise<boolean>;
  uninstallCleanUrls(): Promise<boolean>;
}

export const API_METHODS: (keyof HerdApi)[] = [
  'getState', 'getLogs', 'clearLogs', 'pickFolder', 'inspectFolder', 'linkProject', 'parkFolder', 'unparkFolder',
  'removeProject', 'updateProject', 'aboutInfo', 'envKeyGenerate', 'siteRuntimeNeeds', 'runtimePick', 'appUpdateCheck', 'appUpdateDownload', 'appUpdateCancel', 'appUpdateRestart', 'appUpdateSkip', 'appUpdateInstallOnQuit', 'appUpdatePrefs', 'reportPreview', 'reportSend', 'captureWindow', 'reportError', 'setCrashReports', 'crashAskDismiss', 'uninstallPlan', 'uninstall', 'openapiReveal', 'siteOpenApi', 'addOpenApi', 'createOpenApi', 'dialcatzOpen', 'dialcatzInstall', 'dialcatzCancelInstall', 'dialcatzDismiss', 'dbImportList', 'dbImportOne', 'domainOwner', 'buildTargets', 'buildSite', 'appPortEnv', 'freePortFor', 'gitignoreRead', 'gitignoreSave', 'setAppSubdomain', 'siteDeps', 'depsReport', 'freeDeps', 'restartApp', 'sitePortUse', 'setSitePort', 'envFiles', 'envRead', 'envWrite', 'envCreate', 'envMerge', 'rescan', 'refreshRuntimes', 'start', 'stop', 'restart', 'openUrl', 'openFolder',
  'openEditor', 'openTerminal', 'db', 'updateSettings', 'trustCa', 'untrustCa', 'revealCa',
  'setLaunchAtLogin', 'quitApp', 'startAll', 'stopAll', 'takePendingNav', 'getScreenshot', 'refreshScreenshot', 'redisDetails', 'redisWriteEnv',
  'installDeps', 'depCommands', 'depRun', 'nodeRemote', 'nodeInstall', 'nodeUninstall', 'nodeSetDefault', 'shimPathSet',
  'bunRemote', 'bunInstall', 'bunUninstall', 'bunSetDefault',
  'goRemote', 'goInstall', 'goUninstall', 'goSetDefault', 'rustInstall', 'rustRemote', 'rustToolchainInstall', 'rustToolchainUninstall', 'rustSetDefault', 'rustTargetAdd', 'rustToolInstall', 'uvInstall', 'pythonRemote', 'pythonInstall', 'pythonUninstall', 'pythonSetDefault',
  'phpRemote', 'phpInstall', 'phpUninstall', 'phpSetDefault', 'phpGetIni', 'phpSetIni', 'composerInstall', 'phpExtensions', 'phpExtInstall', 'phpExtSetEnabled', 'phpExtRemove', 'phpExtDismiss', 'phpOpenIni', 'restartServices', 'checkUpdates', 'runtimeUpdate', 'goDbInfo', 'goDbTask', 'stackTask', 'dbEngines', 'dbVersions', 'dbDefaults', 'dbCreate', 'dbCancelCreate', 'dbDismiss', 'dbUpdate', 'dbRemove', 'dbAction', 'dbOpenData', 'dbOpenBinaries', 'dbDetect', 'dbList', 'dbCreateDatabase', 'dbBuildAction', 'dbcatzOpen', 'dbcatzInstall', 'dbcatzCancelInstall', 'dbcatzDismiss', 'monitorSnapshot', 'monitorLive', 'monitorHistory', 'monitorExport', 'searchInstall', 'searchUpdate', 'searchCancelInstall', 'searchUninstall', 'searchAction', 'searchOpenData', 'searchIndexes', 'searchCreateIndex', 'searchDeleteIndex', 'searchGetSettings', 'searchSaveSettings', 'searchQuery', 'searchUpsert', 'searchImportFile', 'searchDeleteDoc', 'mailAction', 'mailList', 'mailGet', 'mailRaw', 'mailMarkRead', 'mailDelete', 'mailDeleteAll', 'mailSaveAttachment', 'mailAttachmentData', 'mailForward', 'mailForwardConfig', 'mailSetForwardConfig', 'mailEnv', 'mailSendTest', 'mailOpenData', 'exposeInstall', 'exposeCancelInstall', 'exposeUninstall', 'exposeCheckUpdates', 'exposeUpgrade', 'exposeCloudflareLogin', 'exposeCloudflareLogout', 'exposeSetAccount', 'exposeStart', 'exposeStop', 'exposeRequests', 'exposeClearRequests', 'exposeReplay', 'waInstall', 'waUpdate', 'waCancelInstall', 'waUninstall', 'waAction', 'waOpenData', 'waCheckUpdates', 'taskDismiss', 'gwInstall', 'gwUpdate', 'gwCancelInstall', 'gwUninstall', 'gwAction', 'gwOpenData', 'gwCheckUpdates', 'gwUpgrade', 'gwSetAutoStart', 'gwSend', 'gwEnv', 'gwSms', 'gwClearSms', 'waUpgrade', 'waSessionStart', 'waSessionQr', 'waSessionLogout', 'waSessionRemove', 'waSend', 'waContacts', 'waGroups', 'waMessages', 'waClearMessages', 'waHooks', 'waSetHook', 'waRemoveHook', 'waDeliveries', 'waReplay', 'waEnv', 'gitStatus', 'gitInit', 'gitDiff', 'gitStage', 'gitUnstage', 'gitDiscard', 'gitCommit', 'gitSync', 'gitCancel', 'gitLog', 'gitShow', 'gitBranches', 'gitBranch', 'aiSettings', 'aiSetSettings', 'aiSetKey', 'aiModels', 'aiProbe', 'aiTest', 'aiCancel', 'aiPreviewExplain', 'aiExplain', 'aiPreviewCommit', 'aiCommit', 'aiPreviewDockerEdit', 'aiDockerEdit', 'aiPreviewEnv', 'aiEnv', 'aiPreviewSearch', 'aiSearch', 'aiPreviewWebhook', 'aiWebhook', 'aiPreviewAsk', 'aiAsk', 'aiRunAction', 'worktreeList', 'worktreeCreate', 'worktreeAdd', 'worktreeCheck', 'worktreeRemove', 'worktreePrune', 'gitStashes', 'gitStash', 'gitTags', 'gitTag', 'gitOperation', 'gitSquash', 'gitCherryPick', 'gitRevert', 'gitReset', 'gitRestoreFile', 'gitOpenFile', 'gitIgnoreSuggestions', 'gitIgnoreAdd', 'gitSetIdentity', 'gitAddRemote', 'gitPulls', 'gitCreatePull', 'gitCheckoutPull', 'gitAddAccount', 'gitRemoveAccount', 'gitRepos', 'gitSshKeys', 'gitSshGenerate', 'gitSshAddToAccount', 'gitClone', 'gitCancelClone', 'searchUpgrade', 'wsUpgrade', 'storageUpgrade', 'servicesCheckUpdates', 'serviceSetAutoStart', 'searchTasks', 'searchCancelTasks', 'searchClearTasks', 'searchBackups', 'searchCreateBackup', 'searchDeleteBackup', 'searchRevealBackup', 'searchRestoreBackup', 'searchExport', 'searchKeys', 'searchCreateKey', 'searchDeleteKey', 'searchEnv', 'storageEnv', 'scoutCommand', 'wsInstall', 'wsUpdate', 'wsCancelInstall', 'wsUninstall', 'wsAction', 'wsOpenData', 'wsStats', 'wsPublish', 'wsClientAuth', 'wsEnv', 'reverbEnv', 'laravelBroadcast', 'laravelTestBroadcast', 'storageInstall', 'storageUpdate', 'storageCancelInstall', 'storageUninstall', 'storageAction', 'storageOpenData', 'openLogsFolder', 'pickFile', 's3Buckets', 's3CreateBucket', 's3DeleteBucket', 's3SetPublic', 's3List', 's3Upload', 's3CancelUpload', 's3Download', 's3Delete', 's3MkDir', 'dockerStatus', 'dockerFiles', 'dockerServices', 'dockerGenerate', 'dockerWrite', 'dockerListFiles', 'dockerReadFile', 'dockerSaveFile', 'dockerCompose', 'startEngine', 'setFavorite', 'setSiteGroup', 'renameGroup', 'deleteGroup', 'toggleGroup', 'moveGroup', 'siteMenu', 'groupMenu', 'setSiteOrder', 'dbSetFavorite', 'dbSetGroup', 'dbGroupAction', 'dbSetOrder', 'dbMenu', 'dbGroupMenu', 'laravelLog', 'herdSites', 'setTld', 'installResolver', 'uninstallResolver', 'installCleanUrls', 'uninstallCleanUrls',
];
