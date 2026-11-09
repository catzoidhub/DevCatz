import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectStack, isProjectDir } from '../src/main/runtimes';

/** Goravel and projects with no framework (TODO #34): each fixture is only the files detection looks at. */
const root = mkdtempSync(join(tmpdir(), 'devcatz-detect-'));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let n = 0;
function project(files: Record<string, string>): string {
  const dir = join(root, String(n++));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}
const detect = (files: Record<string, string>) => {
  const dir = project(files);
  return { dir, stack: detectStack(dir, 'x.test'), isProject: isProjectDir(dir) };
};

const GO_SERVER = 'package main\nimport ("net/http"; "os")\nfunc main() { http.ListenAndServe(":"+os.Getenv("PORT"), nil) }\n';
const GORAVEL = { 'go.mod': 'module goravel\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.10.0\n\tgithub.com/goravel/framework v1.18.0\n)\n', 'main.go': 'package main\nfunc main() {}\n', '.air.toml': '' };

describe('Goravel', () => {
  test('wins over the Gin it requires, runs without air, takes APP_PORT', () => {
    const { stack } = detect({ ...GORAVEL, 'config/http.go': '"port": config.Env("APP_PORT", "3100"),', '.env': 'APP_KEY=abc\n' });
    const app = stack.apps[0];
    expect(app.library).toBe('goravel');
    expect(app.command).toBe('go run .');
    expect(app.port).toBe(3100);
    expect(app.portVars).toEqual(['APP_PORT']);
    expect(stack.warnings).toEqual([]);
    expect(stack.tasks?.some((t) => t.command === 'go run . artisan key:generate')).toBe(true);
  });
  test('.env decides the port', () => {
    expect(detect({ ...GORAVEL, '.env': 'APP_KEY=abc\nAPP_PORT=3200\n' }).stack.apps[0].port).toBe(3200);
  });
  test('says when .env is missing', () => {
    expect(detect(GORAVEL).stack.warnings[0]).toStartWith('No .env yet');
  });
  test('says when APP_KEY is empty, whatever the next line holds', () => {
    expect(detect({ ...GORAVEL, '.env': 'APP_KEY=\nAPP_DEBUG=true\n' }).stack.warnings[0]).toStartWith('No APP_KEY');
  });
});

describe('plain Go', () => {
  test('a module on net/http', () => {
    const app = detect({ 'go.mod': 'module demo\n', 'cmd/server/main.go': GO_SERVER }).stack.apps[0];
    expect([app.framework, app.library, app.command]).toEqual(['go', null, 'go run ./cmd/server']);
    expect(app.portVars).toEqual(['PORT']);
  });
  test('a lone main.go that serves', () => {
    const { stack, isProject } = detect({ 'main.go': GO_SERVER });
    expect(isProject).toBe(true);
    expect(stack.apps[0].command).toBe('go run main.go');
  });
  test('a lone main.go that only prints is no project', () => {
    expect(detect({ 'main.go': 'package main\nfunc main() { println("hi") }\n' }).isProject).toBe(false);
  });
});

describe('plain Rust', () => {
  const CARGO = '[package]\nname = "demo"\nversion = "0.1.0"\n';
  test('a listener on the standard library has a port', () => {
    const app = detect({ 'Cargo.toml': CARGO, 'src/main.rs': 'fn main() { let p = std::env::var("PORT").unwrap_or_else(|_| "3456".into()); std::net::TcpListener::bind(format!("127.0.0.1:{p}")).unwrap(); }\n' }).stack.apps[0];
    expect([app.framework, app.library, app.command, app.port]).toEqual(['rust', null, 'cargo run', 3456]);
    expect(app.portVars).toEqual(['PORT']);
  });
  test('a CLI gets no port', () => {
    expect(detect({ 'Cargo.toml': CARGO, 'src/main.rs': 'fn main() { println!("hi"); }\n' }).stack.apps[0].port).toBeNull();
  });
});

describe('plain JS', () => {
  const pkg = (o: object) => JSON.stringify({ name: 'demo', ...o });
  test('process.env.PORT with no fallback is still a server', () => {
    const { stack } = detect({ 'package.json': pkg({ scripts: { dev: 'node --watch server.js' } }), 'server.js': 'const port = process.env.PORT;\nrequire("node:http").createServer().listen(port);\n' });
    expect(stack.apps[0].framework).toBe('node');
    expect(stack.apps[0].portVars).toEqual(['PORT']);
    expect(stack.apps[0].port).toBe(3000);
    expect(stack.depsMissing).toBe(false);
  });
  test('"start": "node server.js" with no dev script', () => {
    const { stack } = detect({ 'package.json': pkg({ scripts: { start: 'node server.js' } }), 'server.js': 'require("node:http").createServer().listen(3456);\n' });
    expect(stack.devCommand).toBe('npm run start');
    expect(stack.apps[0].port).toBe(3456);
  });
  test('main with no scripts', () => {
    const { stack } = detect({ 'package.json': pkg({ main: 'lib/run.js' }), 'lib/run.js': 'require("node:http").createServer().listen(4000);\n' });
    expect(stack.devCommand).toBe('node --watch lib/run.js');
    expect(stack.apps[0].port).toBe(4000);
  });
  test('a lone file, for each runtime', () => {
    const lone = (file: string, text: string) => detect({ [file]: text });
    const node = lone('server.js', 'require("node:http").createServer().listen(process.env.PORT || 3100);\n');
    expect([node.isProject, node.stack.devCommand, node.stack.apps[0].port]).toEqual([true, 'node --watch server.js', 3100]);
    const bun = lone('index.ts', 'Bun.serve({ fetch: () => new Response("x") });\n').stack;
    expect([bun.packageManager, bun.apps[0].library, bun.apps[0].port, bun.apps[0].portVars]).toEqual(['bun', 'bun', 3000, ['PORT']]);
    const deno = lone('main.ts', 'Deno.serve(() => new Response("x"));\n').stack;
    expect([deno.apps[0].library, deno.apps[0].port]).toEqual(['deno', 8000]);
    const denoEnv = lone('main.ts', 'Deno.serve({ port: Number(Deno.env.get("PORT")) || 8100 }, () => new Response("x"));\n').stack;
    expect([denoEnv.apps[0].port, denoEnv.apps[0].portVars]).toEqual([8100, ['PORT']]);
  });
  test('a script that serves nothing is no project', () => {
    expect(detect({ 'index.js': 'console.log("hi");\n' }).isProject).toBe(false);
  });
  test('a Go module with a server.js beside it stays Go', () => {
    expect(detect({ 'go.mod': 'module demo\n', 'main.go': GO_SERVER, 'server.js': 'x.listen(1)\n' }).stack.runtime).toBe('go');
  });
  test('a library package with no server gets no app', () => {
    expect(detect({ 'package.json': pkg({ scripts: { build: 'tsc' } }), 'index.js': 'module.exports = 1;\n' }).stack.apps).toEqual([]);
  });
});

describe('plain Python', () => {
  const SERVER = 'from http.server import HTTPServer\nHTTPServer(("127.0.0.1", 8000), None).serve_forever()\n';
  test('a lone script that serves, nothing to install', () => {
    const { stack, isProject } = detect({ 'app.py': SERVER });
    expect(isProject).toBe(true);
    expect([stack.runtime, stack.devCommand, stack.depsMissing]).toEqual(['python', 'python app.py', false]);
  });
  test('a pyproject with no dependencies needs no install', () => {
    const { stack } = detect({ 'pyproject.toml': '[project]\nname = "demo"\ndependencies = []\n', 'main.py': SERVER });
    expect([stack.devCommand, stack.depsMissing]).toEqual(['python main.py', false]);
  });
  test('declared dependencies still ask for an install', () => {
    expect(detect({ 'requirements.txt': 'requests\n', 'main.py': SERVER }).stack.depsMissing).toBe(true);
  });
  test('a script that serves nothing is no project', () => {
    expect(detect({ 'main.py': 'print("hi")\n' }).isProject).toBe(false);
  });
});

describe('static files', () => {
  test('an index.html alone', () => {
    const { stack, isProject } = detect({ 'index.html': '<!doctype html>' });
    expect(isProject).toBe(true);
    expect([stack.apps[0].framework, stack.packageManager, stack.depsMissing]).toEqual(['static', null, false]);
  });
  test('beside a package.json only for tooling', () => {
    expect(detect({ 'package.json': '{"name":"demo","devDependencies":{"prettier":"3"}}', 'index.html': '<!doctype html>' }).stack.apps[0].framework).toBe('static');
  });
  test('a server beside it wins', () => {
    expect(detect({ 'index.html': '<!doctype html>', 'server.js': 'x.listen(3456)\n' }).stack.apps[0].framework).toBe('node');
  });
});

/** Ruby (TODO §37): plain Ruby, Rack and the frameworks; each fixture is only the files detection looks at. */
describe('Ruby', () => {
  const gemfile = (...gems: string[]) => `source 'https://rubygems.org'\n${gems.map((g) => `gem '${g}'`).join('\n')}\n`;
  test('Rails: bin/rails server on PORT, its database tasks, before the package.json it keeps', () => {
    const { stack } = detect({ Gemfile: gemfile('rails', 'puma'), 'Gemfile.lock': 'GEM\n', 'bin/rails': '#!/usr/bin/env ruby\n', 'config/application.rb': '', 'package.json': '{"name":"x"}', '.ruby-version': 'ruby-3.4.7\n' });
    expect([stack.runtime, stack.apps[0].framework, stack.depsMissing, stack.ruby?.spec]).toEqual(['ruby', 'rails', false, '3.4.7']);
    expect(stack.apps[0].command).toBe('bin/rails server -b 127.0.0.1 -p ${PORT:-3000}');
    expect(stack.tasks?.map((t) => t.label)).toContain('db:migrate');
  });
  test('Sinatra classic runs its file; modular goes through config.ru and Puma', () => {
    expect(detect({ Gemfile: gemfile('sinatra'), 'app.rb': "require 'sinatra'\nget('/') { 'hi' }\n" }).stack.apps[0].command).toBe('bundle exec ruby app.rb -o 127.0.0.1 -p ${PORT:-4567}');
    const modular = detect({ Gemfile: gemfile('sinatra', 'puma'), 'config.ru': 'run App\n' }).stack.apps[0];
    expect([modular.framework, modular.command]).toEqual(['sinatra', 'bundle exec puma -b tcp://127.0.0.1:${PORT:-4567} config.ru']);
  });
  test('Rack frameworks keep their name; without Puma it is rackup', () => {
    const roda = detect({ Gemfile: gemfile('roda', 'puma'), 'config.ru': 'run App.app\n' }).stack.apps[0];
    expect([roda.framework, roda.library]).toEqual(['ruby', 'roda']);
    expect(detect({ Gemfile: gemfile('rack', 'rackup'), 'config.ru': 'run ->(e) {}\n' }).stack.apps[0].command).toBe('bundle exec rackup -o 127.0.0.1 -p ${PORT:-9292}');
  });
  test('Jekyll, Hanami, Rage and Sidekiq', () => {
    expect(detect({ Gemfile: gemfile('jekyll') }).stack.apps[0].framework).toBe('jekyll');
    expect(detect({ Gemfile: gemfile('hanami') }).stack.apps[0].command).toBe('bundle exec hanami server --host 127.0.0.1 --port ${PORT:-2300}');
    expect(detect({ Gemfile: gemfile('rage-rb') }).stack.apps[0].library).toBe('rage');
    expect(detect({ Gemfile: gemfile('rails', 'sidekiq') }).stack.ruby?.jobs).toBe('sidekiq');
  });
  test('a Gemfile never resolved: dependencies missing', () => {
    expect(detect({ Gemfile: gemfile('sinatra'), 'app.rb': "require 'sinatra'\n" }).stack.depsMissing).toBe(true);
  });
  test('a plain script that listens, no Gemfile; one that only computes is not a site', () => {
    const { stack, isProject } = detect({ 'server.rb': "require 'socket'\nTCPServer.new('127.0.0.1', ENV['PORT'])\n" });
    expect([isProject, stack.runtime, stack.apps[0].command, stack.depsMissing]).toEqual([true, 'ruby', 'ruby server.rb', false]);
    expect(detect({ 'main.rb': 'puts 1 + 1\n' }).isProject).toBe(false);
  });
  test('a React Native app with a Gemfile only for CocoaPods stays a JS app', () => {
    const { stack } = detect({ Gemfile: gemfile('cocoapods'), 'package.json': '{"name":"app","scripts":{"start":"react-native start"},"dependencies":{"react-native":"0.80.0"}}' });
    expect(stack.runtime).toBe('node');
  });
  test('a Ruby API beside a Vite frontend: one app per folder', () => {
    const { stack } = detect({ 'api/Gemfile': gemfile('roda', 'puma'), 'api/config.ru': 'run App\n', 'web/package.json': '{"name":"web","scripts":{"dev":"vite"},"devDependencies":{"vite":"7"}}' });
    expect(stack.layout).toBe('folders');
    expect(stack.apps.map((a) => [a.dir, a.library ?? a.framework]).sort()).toEqual([['api', 'roda'], ['web', 'vite']]);
  });
});
