import { existsSync, readdirSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import type { AppInfo, StackInfo } from '@shared/types';
import { DEFAULT_PORTS, detectDatabase, firstExisting, readEnvFiles, readText } from '../detect';
import { detectRedis } from '../redis';
import type { RuntimeDriver } from './types';

/** Port variables of backing services, never the app's own listen port. */
const SERVICE_PORT = /REDIS|DB_|DATABASE|PG|POSTGRES|MYSQL|MARIA|SMTP|MAIL|S3|MINIO|RABBIT|AMQP|KAFKA|MONGO|ELASTIC|MEILI|PROXY/i;

/**
 * One Go module as an app. Dev command: `go tool air` when air is a module
 * tool (Go 1.24+ `tool` directive: hot reload without a global install),
 * `air` with an .air.toml, else `go run .` (or `go run ./cmd/<x>`). The port
 * comes from the env vars the code reads (`os.Getenv("PORT")`, `API_PORT`, …)
 * and their .env values, else a quoted literal like "8081".
 */
export function detectGoApp(dir: string, root: string, domain: string): AppInfo & { command: string | null } {
  const env = readEnvFiles(join(dir, '.env'), join(dir, '.env.local'), join(root, '.env'), join(root, '.env.local'));
  const mainFile = firstExisting(dir, ['main.go', 'cmd/server/main.go', 'cmd/api/main.go', 'cmd/main.go']);
  const src = [mainFile, firstExisting(dir, ['config.go', 'internal/config/config.go', 'config/config.go'])]
    .map((f) => (f ? readText(f) ?? '' : ''))
    .join('\n');
  // os.Getenv("PORT"), and the helpers apps wrap it in: get("API_PORT", get("PORT", "8080")), envOr("PORT", …).
  const vars = [...src.matchAll(/\b(?:os\.)?\w*(?:Getenv|LookupEnv|[Ee]nv|[Gg]et|[Ll]ookup)\w*\(\s*"([A-Z0-9_]*PORT[A-Z0-9_]*)"/g)]
    .map((m) => m[1])
    .filter((v, i, all) => !SERVICE_PORT.test(v) && all.indexOf(v) === i);
  let port: number | null = null;
  for (const v of vars) if (Number(env[v]) > 0) port = port ?? Number(env[v]);
  if (port === null) {
    const literal = src.match(/["'`](?:[\w.]*:)?(\d{4,5})["'`]/);
    port = literal ? Number(literal[1]) : DEFAULT_PORTS.go;
  }
  const goMod = readText(join(dir, 'go.mod')) ?? '';
  const library = goWebFramework(goMod);
  const name = goMod.match(/^module\s+(\S+)/m)?.[1] ?? basename(dir);
  const airTool = /^\s*tool\s+github\.com\/(air-verse|cosmtrek)\/air\b/m.test(goMod) || /^tool\s*\([^)]*github\.com\/(air-verse|cosmtrek)\/air/ms.test(goMod);
  const mainRel = mainFile ? relative(dir, mainFile) : null;
  const runTarget = !mainRel || mainRel === 'main.go' ? '.' : `./${mainRel.replace(/\/main\.go$/, '')}`;
  const command = airTool ? 'go tool air' : existsSync(join(dir, '.air.toml')) ? 'air' : mainFile ? `go run ${runTarget}` : null;
  return {
    dir: relative(root, dir) || '.',
    name,
    framework: 'go',
    library,
    kind: 'api',
    devScript: command,
    port,
    configuredPort: port,
    portVars: vars,
    managedPort: false,
    prisma: false,
    domain,
    command,
  };
}

/** Go modules inside a JS monorepo: direct sub-folders and apps/*, services/*. */
export function findGoModules(root: string): string[] {
  const dirs: string[] = [];
  const scan = (base: string) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(base);
    } catch {
      return;
    }
    for (const e of entries.sort()) {
      if (e.startsWith('.') || e === 'node_modules' || e === 'vendor') continue;
      const d = join(base, e);
      if (existsSync(join(d, 'go.mod')) && !existsSync(join(d, 'package.json'))) dirs.push(d);
    }
  };
  scan(root);
  for (const sub of ['apps', 'services', 'backend', 'server']) scan(join(root, sub));
  return dirs;
}

function detectGoStack(root: string, domain: string): StackInfo {
  const app = detectGoApp(root, root, domain);
  return {
    packageManager: null,
    detectedPackageManager: null,
    monorepo: false,
    devCommand: app.command,
    apps: [app],
    database: detectDatabase(root),
    redis: detectRedis(root, []),
    prismaDir: null,
    node: null,
    runtime: 'go',
    depsMissing: false,
    warnings: [],
    libs: [],
  };
}

export const goDriver: RuntimeDriver = {
  id: 'go',
  matches: (dir) => existsSync(join(dir, 'go.mod')),
  detect: detectGoStack,
};

/**
 * The web framework a Go module requires (go.mod), for the site's label:
 * the first of these found. Null for net/http and anything else.
 */
const GO_WEB: [RegExp, string][] = [
  [/github\.com\/gin-gonic\/gin\b/, 'gin'],
  [/github\.com\/labstack\/echo\b/, 'echo'],
  [/github\.com\/gofiber\/fiber\b/, 'fiber'],
  [/github\.com\/go-chi\/chi\b/, 'chi'],
  [/github\.com\/gorilla\/mux\b/, 'gorilla'],
  [/github\.com\/(?:beego\/beego|astaxie\/beego)\b/, 'beego'],
  [/github\.com\/kataras\/iris\b/, 'iris'],
  [/github\.com\/gobuffalo\/buffalo\b/, 'buffalo'],
  [/github\.com\/cloudwego\/hertz\b/, 'hertz'],
  [/github\.com\/go-kratos\/kratos\b/, 'kratos'],
  [/github\.com\/zeromicro\/go-zero\b/, 'go-zero'],
  [/\bgofr\.dev\b/, 'gofr'],
  [/github\.com\/julienschmidt\/httprouter\b/, 'httprouter'],
];
export function goWebFramework(goMod: string): string | null {
  // Only what the module requires, not the module's own path.
  const requires = goMod.replace(/^module\s+\S+/m, '');
  return GO_WEB.find(([re]) => re.test(requires))?.[1] ?? null;
}
