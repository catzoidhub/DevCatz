import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { SearchInfo, SearchKind, SearchLib } from '@shared/types';
import { readEnvFiles } from './detect';

/**
 * Search libraries a site uses (package.json of the root and workspace apps,
 * composer.json, go.mod, requirements / pyproject / Pipfile), Laravel Scout
 * with its driver (SCOUT_DRIVER) and the models that are Searchable.
 */

type Rule = [match: string | RegExp, lib: Omit<SearchLib, 'source'>];

const NODE: Rule[] = [
  ['meilisearch', { name: 'Meilisearch JS', engine: 'meilisearch', role: 'client' }],
  ['@meilisearch/instant-meilisearch', { name: 'Instant Meilisearch', engine: 'meilisearch', role: 'client' }],
  ['typesense', { name: 'Typesense JS', engine: 'typesense', role: 'client' }],
  ['typesense-instantsearch-adapter', { name: 'Typesense InstantSearch adapter', engine: 'typesense', role: 'client' }],
  ['@opensearch-project/opensearch', { name: 'OpenSearch JS', engine: 'opensearch', role: 'client' }],
  ['manticoresearch', { name: 'Manticore JS', engine: 'manticore', role: 'client' }],
  ['manticoresearch-ts', { name: 'Manticore TS', engine: 'manticore', role: 'client' }],
  ['sonic-channel', { name: 'sonic-channel', engine: 'sonic', role: 'client' }],
  [/^(react-|vue-)?instantsearch(\.js)?$/, { name: 'InstantSearch', engine: 'instantsearch', role: 'client' }],
];
const PHP: Rule[] = [
  ['laravel/scout', { name: 'Laravel Scout', engine: 'scout', role: 'client' }],
  ['meilisearch/meilisearch-php', { name: 'Meilisearch PHP', engine: 'meilisearch', role: 'client' }],
  ['typesense/typesense-php', { name: 'Typesense PHP', engine: 'typesense', role: 'client' }],
  ['opensearch-project/opensearch-php', { name: 'OpenSearch PHP', engine: 'opensearch', role: 'client' }],
  ['manticoresoftware/manticoresearch-php', { name: 'Manticore PHP', engine: 'manticore', role: 'client' }],
  ['james-heinrich/laravel-scout-sonic', { name: 'Scout Sonic driver', engine: 'sonic', role: 'client' }],
  ['ppshobi/psonic', { name: 'psonic', engine: 'sonic', role: 'client' }],
];
const PYTHON: Rule[] = [
  ['meilisearch', { name: 'meilisearch-python', engine: 'meilisearch', role: 'client' }],
  ['typesense', { name: 'typesense-python', engine: 'typesense', role: 'client' }],
  ['opensearch-py', { name: 'opensearch-py', engine: 'opensearch', role: 'client' }],
  ['manticoresearch', { name: 'manticoresearch-python', engine: 'manticore', role: 'client' }],
  ['zincsearch-sdk', { name: 'zincsearch-sdk', engine: 'zincsearch', role: 'client' }],
  ['asonic', { name: 'asonic', engine: 'sonic', role: 'client' }],
  ['sonic-client', { name: 'sonic-client', engine: 'sonic', role: 'client' }],
];
const GO: Rule[] = [
  ['github.com/meilisearch/meilisearch-go', { name: 'meilisearch-go', engine: 'meilisearch', role: 'client' }],
  ['github.com/typesense/typesense-go', { name: 'typesense-go', engine: 'typesense', role: 'client' }],
  [/^github\.com\/typesense\/typesense-go\/v\d+$/, { name: 'typesense-go', engine: 'typesense', role: 'client' }],
  [/^github\.com\/opensearch-project\/opensearch-go(\/v\d+)?$/, { name: 'opensearch-go', engine: 'opensearch', role: 'client' }],
  ['github.com/manticoresoftware/manticoresearch-go', { name: 'manticoresearch-go', engine: 'manticore', role: 'client' }],
  ['github.com/expectedsh/go-sonic', { name: 'go-sonic', engine: 'sonic', role: 'client' }],
];

const read = (f: string) => {
  try {
    return readFileSync(f, 'utf8');
  } catch {
    return null;
  }
};
function match(rules: Rule[], names: string[], source: string, out: SearchLib[]): void {
  for (const [m, lib] of rules) {
    if (names.some((n) => (typeof m === 'string' ? n === m : m.test(n))) && !out.some((o) => o.name === lib.name)) out.push({ ...lib, source });
  }
}
function packageJsons(root: string): string[] {
  const out = [join(root, 'package.json')];
  for (const dir of ['apps', 'packages', 'services']) {
    try {
      for (const e of readdirSync(join(root, dir))) out.push(join(root, dir, e, 'package.json'));
    } catch {
      /* none */
    }
  }
  return out.filter((f) => existsSync(f));
}

/** Models with `use Searchable;` (app/Models, app/). */
function searchableModels(root: string): string[] {
  const out: string[] = [];
  for (const dir of ['app/Models', 'app']) {
    const d = join(root, dir);
    if (!existsSync(d)) continue;
    for (const f of readdirSync(d)) {
      if (!f.endsWith('.php')) continue;
      const src = read(join(d, f)) ?? '';
      if (/use\s+(?:\\?Laravel\\Scout\\)?Searchable\s*;/.test(src) && /class\s+\w+/.test(src)) {
        const ns = src.match(/namespace\s+([\w\\]+);/)?.[1];
        const cls = src.match(/class\s+(\w+)/)![1];
        const fq = ns ? `${ns}\\${cls}` : cls;
        if (!out.includes(fq)) out.push(fq);
      }
    }
  }
  return out;
}

const MANIFESTS = ['package.json', 'composer.json', 'go.mod', 'requirements.txt', 'pyproject.toml', 'Pipfile', '.env', 'app/Models'];
const cache = new Map<string, { sig: string; info: SearchInfo }>();

export function detectSearch(root: string): SearchInfo {
  const files = [...new Set([...MANIFESTS.map((m) => join(root, m)), ...packageJsons(root)])].filter((f) => existsSync(f));
  const sig = files.map((f) => `${f}:${statSync(f).mtimeMs}`).join('|');
  const hit = cache.get(root);
  if (hit && hit.sig === sig) return hit.info;

  const libs: SearchLib[] = [];
  for (const f of packageJsons(root)) {
    try {
      const pkg = JSON.parse(read(f) ?? '{}') as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
      match(NODE, Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }), relative(root, f), libs);
    } catch {
      /* invalid JSON */
    }
  }
  const composer = read(join(root, 'composer.json'));
  if (composer) {
    try {
      const c = JSON.parse(composer) as { require?: Record<string, string>; 'require-dev'?: Record<string, string> };
      match(PHP, Object.keys({ ...c.require, ...c['require-dev'] }), 'composer.json', libs);
    } catch {
      /* invalid JSON */
    }
  }
  const goMod = read(join(root, 'go.mod'));
  if (goMod) match(GO, [...goMod.matchAll(/^\s*(?:require\s+)?([\w./-]+)\s+v\d/gm)].map((m) => m[1]), 'go.mod', libs);
  for (const f of ['requirements.txt', 'pyproject.toml', 'Pipfile']) {
    const text = read(join(root, f));
    if (text) match(PYTHON, [...text.matchAll(/^[\s"']*([A-Za-z][\w.-]*)(?=[\s\[<>=~!;,"']|$)/gm)].map((m) => m[1].toLowerCase()), f, libs);
  }

  const scout = libs.some((l) => l.engine === 'scout');
  const env = scout ? readEnvFiles(join(root, '.env')) : {};
  const scoutDriver = scout ? env.SCOUT_DRIVER || null : null;
  const engines: SearchKind[] = ['meilisearch', 'typesense', 'opensearch', 'manticore', 'zincsearch', 'sonic'];
  const fromDriver = engines.find((e) => e === scoutDriver) ?? null;
  const fromLibs = engines.find((e) => libs.some((l) => l.engine === e)) ?? null;
  const info: SearchInfo = {
    libs,
    scout,
    scoutDriver,
    searchable: scout ? searchableModels(root) : [],
    // Scout without a client library yet: Meilisearch is its default engine.
    suggested: fromDriver ?? fromLibs ?? (scout ? 'meilisearch' : null),
  };
  cache.set(root, { sig, info });
  return info;
}
