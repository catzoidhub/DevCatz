import { existsSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { AppInfo, Framework, RubyStack, StackInfo, StackTask } from '@shared/types';
import { DEFAULT_PORTS, detectDatabase, readText } from '../detect';
import { detectRedis } from '../redis';
import type { RuntimeDriver } from './types';
import { isWin } from '../platform';

/**
 * Ruby projects (TODO §37): a dev server on a managed port (PORT), run with the site's Ruby and, with a Gemfile,
 * through Bundler. Rails → `bin/rails server`, Hanami → `hanami server`, Jekyll / Bridgetown / Middleman → their dev
 * servers, Padrino / Rage → their own CLIs, a Sinatra file → `ruby app.rb`, any Rack app (Roda, Grape, Cuba, Hobbit,
 * Scorched, NYNY, Camping, Ramaze, Ramverk, Sinatra modular, plain Rack) → Puma or rackup on its config.ru, a plain
 * script that listens (WEBrick, TCPServer) → `ruby <file>`. Gems come from the Gemfile with `bundle install`.
 */

const has = (root: string, f: string) => existsSync(join(root, f));
/** A project's own `bin/<name>` script: cmd.exe cannot run a Ruby script by itself, so Windows calls it with ruby. */
const binstub = (name: string) => (isWin ? `ruby bin/${name}` : `bin/${name}`);
const ENTRIES = ['app.rb', 'server.rb', 'main.rb', 'web.rb', 'application.rb'];
/** A script with no Gemfile that serves something; one that only computes is not a site. */
const SERVES = /\brequire\s+['"](?:webrick|socket|sinatra|rack|puma|roda)['"]|\bTCPServer\.new\b|\bWEBrick::HTTPServer\b|\bRack::Handler\b/;
const loneScript = (dir: string) => !has(dir, 'Gemfile') && !has(dir, 'package.json') && ENTRIES.some((f) => SERVES.test(readText(join(dir, f)) ?? ''));

/** Web gems, in the order a project is recognised by (Rails first: a Rails app also has Rack, Puma …). */
const WEB_GEMS = ['rails', 'hanami', 'bridgetown', 'jekyll', 'middleman', 'padrino', 'rage-rb', 'sinatra', 'roda', 'grape', 'cuba', 'hobbit', 'scorched', 'nyny', 'camping', 'ramaze', 'ramverk', 'goliath', 'cramp', 'volt', 'rack'];
/** Label (and logo) of the framework a project is built on when DevCatz runs it as a Rack / Ruby app. */
const LIBRARY: Record<string, string> = {
  bridgetown: 'bridgetown',
  middleman: 'middleman',
  padrino: 'padrino',
  'rage-rb': 'rage',
  roda: 'roda',
  grape: 'grape',
  cuba: 'cuba',
  hobbit: 'hobbit',
  scorched: 'scorched',
  nyny: 'nyny',
  camping: 'camping',
  ramaze: 'ramaze',
  ramverk: 'ramverk',
  goliath: 'goliath',
  cramp: 'cramp',
  volt: 'volt',
  rack: 'rack',
};

/** Gem names the Gemfile asks for (and, when resolved, everything in Gemfile.lock), lower-case. */
export function rubyGems(root: string): Set<string> {
  const out = new Set<string>();
  const gemfile = readText(join(root, 'Gemfile')) ?? readText(join(root, 'gems.rb')) ?? '';
  for (const m of gemfile.matchAll(/^\s*gem\s+['"]([A-Za-z0-9_.-]+)['"]/gm)) out.add(m[1].toLowerCase());
  const lock = readText(join(root, 'Gemfile.lock')) ?? readText(join(root, 'gems.locked')) ?? '';
  for (const m of lock.matchAll(/^ {4}([A-Za-z0-9_.-]+) \(/gm)) out.add(m[1].toLowerCase());
  return out;
}

function webGem(gems: Set<string>, root: string): string | null {
  for (const g of WEB_GEMS) if (gems.has(g)) return g;
  // A Rails app whose Gemfile only lists railties pieces.
  if (has(root, 'config/application.rb') && has(root, 'bin/rails')) return 'rails';
  if (has(root, 'config.ru')) return 'rack';
  return null;
}

const isRuby = (dir: string) => {
  if (loneScript(dir)) return true;
  if (!has(dir, 'Gemfile') && !has(dir, 'gems.rb') && !has(dir, 'config.ru')) return false;
  // A JS / mobile project with a Gemfile only for CocoaPods or fastlane stays what it is.
  return Boolean(webGem(rubyGems(dir), dir));
};

/** What the project asks for: .ruby-version, .tool-versions, or the Gemfile's `ruby "3.3.0"` / `ruby "~> 3.3"`. */
function rubySpec(root: string): string | null {
  const rv = readText(join(root, '.ruby-version'))?.trim().split('\n')[0].replace(/^ruby-/, '');
  if (rv && /^\d+(\.\d+){0,2}$/.test(rv)) return rv;
  const tv = readText(join(root, '.tool-versions'))?.match(/^ruby\s+([\d.]+)/m)?.[1];
  if (tv) return tv;
  const gemfile = readText(join(root, 'Gemfile')) ?? '';
  const m = gemfile.match(/^\s*ruby\s+['"]([^'"]+)['"](?:\s*,\s*['"]([^'"]+)['"])?/m);
  if (m) return [m[1], m[2]].filter(Boolean).join(',').replace(/\s+/g, ' ').trim();
  return null;
}

function detectRubyStack(root: string, domain: string): StackInfo {
  const gems = rubyGems(root);
  const gemfile = has(root, 'Gemfile') || has(root, 'gems.rb');
  const web = webGem(gems, root);
  const bx = gemfile ? 'bundle exec ' : '';
  const P = (port: number) => `\${PORT:-${port}}`;
  let framework: Framework = 'ruby';
  let port = DEFAULT_PORTS.ruby ?? 9292;
  let command: string | null = null;
  const tasks: StackTask[] = [];
  /** A Rack app on its config.ru: Puma when the project has it, Falcon likewise, else rackup. */
  const rack = (p = port) =>
    gems.has('puma')
      ? `${bx}puma -b tcp://127.0.0.1:${P(p)} config.ru`
      : gems.has('falcon')
        ? `${bx}falcon serve --bind http://127.0.0.1:${P(p)}`
        : `${bx}rackup -o 127.0.0.1 -p ${P(p)}`;

  switch (web) {
    case 'rails': {
      framework = 'rails';
      port = DEFAULT_PORTS.rails ?? 3000;
      const rails = has(root, 'bin/rails') ? binstub('rails') : `${bx}rails`;
      command = `${rails} server -b 127.0.0.1 -p ${P(port)}`;
      tasks.push(
        { id: 'db-prepare', tool: 'Rails', label: 'db:prepare', command: `${rails} db:prepare`, cwd: '.' },
        { id: 'db-migrate', tool: 'Rails', label: 'db:migrate', command: `${rails} db:migrate`, cwd: '.' },
        { id: 'db-seed', tool: 'Rails', label: 'db:seed', command: `${rails} db:seed`, cwd: '.' },
        { id: 'db-rollback', tool: 'Rails', label: 'db:rollback', command: `${rails} db:rollback`, cwd: '.', danger: true },
        { id: 'migration', tool: 'Rails', label: 'generate migration…', command: `${rails} generate migration {name}`, cwd: '.', needsName: true, namePlaceholder: 'AddTitleToPosts' },
      );
      break;
    }
    case 'hanami':
      framework = 'hanami';
      port = DEFAULT_PORTS.hanami ?? 2300;
      command = `${bx}hanami server --host 127.0.0.1 --port ${P(port)}`;
      if (gems.has('hanami-db') || gems.has('rom-sql'))
        tasks.push(
          { id: 'db-prepare', tool: 'Hanami', label: 'db prepare', command: `${bx}hanami db prepare`, cwd: '.' },
          { id: 'db-migrate', tool: 'Hanami', label: 'db migrate', command: `${bx}hanami db migrate`, cwd: '.' },
        );
      break;
    case 'jekyll':
      framework = 'jekyll';
      port = DEFAULT_PORTS.jekyll ?? 4000;
      // No --livereload: its fixed port (35729) would clash between two Jekyll sites.
      command = `${bx}jekyll serve --host 127.0.0.1 --port ${P(port)}`;
      break;
    case 'bridgetown':
      port = 4000;
      command = `${has(root, 'bin/bridgetown') ? binstub('bridgetown') : `${bx}bridgetown`} start --bind 127.0.0.1 --port ${P(port)}`;
      break;
    case 'middleman':
      port = 4567;
      command = `${bx}middleman server --bind-address 127.0.0.1 -p ${P(port)}`;
      break;
    case 'padrino':
      port = 3000;
      command = `${bx}padrino start -h 127.0.0.1 -p ${P(port)}`;
      if (gems.has('activerecord') || gems.has('sequel')) tasks.push({ id: 'migrate', tool: 'Padrino', label: 'rake db:migrate', command: `${bx}padrino rake db:migrate`, cwd: '.' });
      break;
    case 'rage-rb':
      port = 3000;
      command = `${bx}rage server -b 127.0.0.1 -p ${P(port)}`;
      break;
    case 'sinatra': {
      framework = 'sinatra';
      port = DEFAULT_PORTS.sinatra ?? 4567;
      // Modular apps come with a config.ru; a classic app is one file that runs itself (-p / -o are Sinatra's own).
      const file = ENTRIES.find((f) => /require\s+['"]sinatra['"]/.test(readText(join(root, f)) ?? ''));
      command = has(root, 'config.ru') || !file ? rack(port) : `${bx}ruby ${file} -o 127.0.0.1 -p ${P(port)}`;
      break;
    }
    case 'camping': {
      const file = ENTRIES.find((f) => has(root, f)) ?? 'app.rb';
      command = has(root, 'config.ru') ? rack() : `${bx}camping ${file} -h 127.0.0.1 -p ${P(port)}`;
      break;
    }
    case 'goliath': {
      // Goliath apps are scripts that start their own server (-p, -e).
      const file = ENTRIES.find((f) => has(root, f)) ?? 'server.rb';
      command = `${bx}ruby ${file} -sv -a 127.0.0.1 -p ${P(port)}`;
      break;
    }
    case 'volt':
      port = 3000;
      command = `${bx}volt server -b 127.0.0.1 -p ${P(port)}`;
      break;
    default: {
      if (has(root, 'config.ru')) command = rack();
      else {
        // A plain script that listens: run it; it should read PORT.
        const entry = ENTRIES.find((f) => has(root, f));
        command = entry ? `${bx}ruby ${entry}` : null;
      }
    }
  }
  // Rake tasks a Sequel / ActiveRecord app outside Rails keeps (Roda, Sinatra, Grape): only when the Rakefile has them.
  if (framework !== 'rails' && framework !== 'hanami' && /\bdb:migrate\b|namespace\s+:db/.test(readText(join(root, 'Rakefile')) ?? '')) {
    tasks.push({ id: 'rake-migrate', tool: 'Rake', label: 'db:migrate', command: `${bx}rake db:migrate`, cwd: '.' });
  }
  const jobs: RubyStack['jobs'] = gems.has('sidekiq') ? 'sidekiq' : gems.has('solid_queue') ? 'solid_queue' : gems.has('good_job') ? 'good_job' : null;
  const library = web && LIBRARY[web] && framework === 'ruby' ? LIBRARY[web] : null;
  const app: AppInfo = {
    dir: '.',
    name: basename(root),
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
  if (!command) warnings.push('No entry point found (config.ru, a framework, app.rb or server.rb): set a dev command in the site settings.');
  const lockfile = has(root, 'Gemfile.lock') || has(root, 'gems.locked');
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
    runtime: 'ruby',
    // A Gemfile never resolved: nothing installed yet. (A lockfile with gems missing is Bundler's to say at Start.)
    depsMissing: gemfile && !lockfile,
    warnings,
    libs: [],
    tasks,
    ruby: { gemfile, lockfile, spec: rubySpec(root), jobs },
  };
}

/** The command a site's queue switch runs next to the web server (Sidekiq, Solid Queue, GoodJob). */
export function rubyJobsCommand(stack: StackInfo): string | null {
  const bx = stack.ruby?.gemfile ? 'bundle exec ' : '';
  switch (stack.ruby?.jobs) {
    case 'sidekiq':
      return `${bx}sidekiq`;
    case 'solid_queue':
      return isWin ? 'ruby bin/jobs' : 'bin/jobs';
    case 'good_job':
      return `${bx}good_job start`;
    default:
      return null;
  }
}

/** A Ruby project in a folder of another site (api/ beside a frontend): one `api` app run from that folder. */
export function rubyFolderApp(root: string, dir: string): { app: AppInfo; depsMissing: boolean; warnings: string[] } | null {
  const s = detectRubyStack(dir, '');
  const app = s.apps[0];
  if (!app?.command) return null;
  // Bundler finds the folder's Gemfile from its own directory (each folder app runs with cwd = its folder).
  const command = isWin ? app.command : `env BUNDLE_GEMFILE="${join(dir, 'Gemfile')}" ${app.command}`;
  return { depsMissing: s.depsMissing, warnings: s.warnings, app: { ...app, dir: relative(root, dir), kind: 'api', devScript: app.command, command: s.ruby?.gemfile ? command : app.command, domain: '' } };
}

export const rubyDriver: RuntimeDriver = {
  id: 'ruby',
  matches: isRuby,
  detect: detectRubyStack,
};
