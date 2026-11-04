import { chmodSync, existsSync, mkdirSync, readdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { app } from 'electron';
import type { BridgeEntry } from '@catzoid/mcatzp-host';
import type { AppInfo, ProjectConfig, SiteOpenApi, StackInfo } from '@shared/types';

/**
 * DevCatz's manifest for the other Catzoid apps (decided 2026-10-25: each app writes its own `bridge.json` in its
 * own data folder; the others read it — no shared Bridge folder). DialCatz reads the sites from here: their domains,
 * apps and where each one's OpenAPI document is (a file in the project, or a URL a running app serves), so "Open in
 * DialCatz" can import routes of a site whose API lives on a subdomain or only in a spec file.
 * Owner-only (0600), rewritten when something changes; no secrets (no .env values).
 */

export interface BridgeSite {
  id: string;
  name: string;
  domain: string;
  url: string;
  path: string;
  worktreeOf?: string;
  running: boolean;
  apps: { dir: string; name: string; framework: string; kind: AppInfo['kind']; domain: string; url: string | null; port: number | null }[];
  openapi: SiteOpenApi['specs'];
}

/**
 * A gateway DevCatz runs (email / push / SMS / Telegram, WhatsApp), for DoCatz's DevCatz Services group: on Windows the Docker
 * ones run in DoCatz's engine. `project` / `container` is how they appear there; `link` (devcatz://gateways/<kind>)
 * opens it in DevCatz, with `?install=1` its install dialog, `?action=start|stop|restart` runs that. No secrets.
 */
export interface BridgeGateway {
  kind: string;
  name: string;
  category: string;
  docker: boolean;
  installed: boolean;
  status: string;
  version: string | null;
  url: string | null;
  api: string | null;
  webUi: string | null;
  project: string | null;
  container: string | null;
  link: string;
}

/**
 * `services`: servers DevCatz runs that have no Windows build (Typesense, Sonic, Sockudo), in the gateways' shape —
 * on Windows they run in DoCatz's engine (compose project devcatz-svc-<kind>), listed read-only on DoCatz's DevCatz
 * Services page; `link` is devcatz://services/<kind> (?install=1, ?action=start|stop|restart). All three, installed or not.
 */
export const bridgeFile = () => join(app.getPath('userData'), 'bridge.json');

let last = '';
let timer: ReturnType<typeof setTimeout> | null = null;
let written: { sites: BridgeSite[]; gateways: BridgeGateway[]; services: BridgeGateway[] } | null = null;
let mcatzp: BridgeEntry | null = null;

function writeFile(): void {
  if (!written) return;
  try {
    const file = bridgeFile();
    const dir = join(file, '..');
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, `${JSON.stringify({ schema: 1, app: 'DevCatz', written: new Date().toISOString(), ...written, ...(mcatzp ? { mcatzp } : {}) }, null, 2)}\n`, { mode: 0o600 });
    chmodSync(tmp, 0o600);
    renameSync(tmp, file);
  } catch (e) {
    console.warn('bridge.json could not be written:', (e as Error).message);
  }
}

/** Writes bridge.json (debounced, only when it changed). */
export function writeBridge(sites: BridgeSite[], gateways: BridgeGateway[] = [], services: BridgeGateway[] = []): void {
  const body = JSON.stringify([sites, gateways, services]);
  if (body === last) return;
  last = body;
  written = { sites, gateways, services };
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    writeFile();
  }, 400);
}

/** MCatzP's entry (MCatzP #4): how `mcatzp` finds this app's channel. Written at once when the switch flips. */
export function setBridgeMcatzp(entry: BridgeEntry): void {
  mcatzp = entry;
  writeFile();
}

// ------------------------------------------------------------------ OpenAPI

const SPEC_NAME = /^(openapi|swagger)([.-][\w.-]+)?\.(ya?ml|json)$/i;
const SKIP = new Set(['node_modules', 'vendor', '.git', 'dist', 'build', 'out', '.venv', 'venv', 'storage', 'coverage', '.next', '.nuxt', '.output', '.astro', 'tmp']);

/** OpenAPI / Swagger files in the project (three levels deep), each with the app whose folder holds it. */
export function specFiles(p: ProjectConfig, stack: StackInfo | undefined): { app: string; file: string }[] {
  const out: { app: string; file: string }[] = [];
  const walk = (dir: string, depth: number) => {
    let entries: string[] = [];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.startsWith('.') && e !== '.') continue;
      const abs = join(dir, e);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        if (depth < 3 && !SKIP.has(e)) walk(abs, depth + 1);
      } else if (SPEC_NAME.test(e) && st.size < 20 * 1024 * 1024) {
        // Forward slashes on Windows too, so app folders (`api`, `apps/web`) compare the same way.
        const rel = relative(p.path, abs).split(sep).join('/');
        // The app whose folder holds it (the deepest match), else the site's first app.
        const owner = [...(stack?.apps ?? [])].filter((a) => a.dir === '.' || rel.startsWith(`${a.dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
        out.push({ app: owner?.dir ?? '.', file: abs });
      }
    }
  };
  walk(p.path, 0);
  return out;
}

/** Paths a running app may serve its document on (FastAPI, NestJS, Scramble, swag, springdoc, swagger-ui …). */
export const OPENAPI_PATHS = [
  '/openapi.json',
  '/docs/api.json',
  '/api-json',
  '/docs-json',
  '/swagger.json',
  '/api/openapi.json',
  '/docs/openapi.json',
  '/v3/api-docs',
  '/swagger/doc.json',
  '/swagger/v1/swagger.json',
  '/api/docs.json',
  '/api-docs.json',
  '/openapi.yaml',
];

/** The first OpenAPI document an app answers with on 127.0.0.1:<port> (not an HTML page), or null. */
export async function probeOpenApi(port: number): Promise<string | null> {
  for (const path of OPENAPI_PATHS) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(1500), redirect: 'follow' });
      if (!r.ok) continue;
      if (/html/i.test(r.headers.get('content-type') ?? '')) continue;
      const head = (await r.text()).slice(0, 4000);
      if (/["']?(openapi|swagger)["']?\s*:/i.test(head)) return path;
    } catch {
      /* not served there */
    }
  }
  return null;
}
