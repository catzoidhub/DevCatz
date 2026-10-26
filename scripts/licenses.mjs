#!/usr/bin/env node
// Third-party licences of what this app ships (Catzoid TODO #66) — the same script in every Catzoid app.
//   node scripts/licenses.mjs        (runs before every build: package.json "prebuild")
// Writes resources/third-party-licenses.json (for catzoid.com/legal/licences) and resources/third-party-licenses.txt
// (shipped inside the app, opened from About → Third-party licences). What counts as shipped:
//   - every package under "dependencies", with its own dependencies — they go into the app as node_modules;
//   - every devDependency the source imports (Vue, Tailwind CSS, daisyUI …) with its dependencies — bundled into out/;
//   - Electron itself (its Chromium licences also ship inside the app as LICENSES.chromium.html).
// Build-only tools that never reach the app (TypeScript, Vite, electron-builder …) are left out.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const self = pkg.productName || pkg.name;

/** The package.json of `name` as Node would find it from `fromDir` (nested node_modules first, then up). */
function find(name, fromDir) {
  for (let dir = fromDir; ; dir = dirname(dir)) {
    const p = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(p)) return p;
    if (dir === dirname(dir) || relative(root, dir).startsWith('..')) return null;
  }
}

/**
 * Parts of a bundled package that stay at build time (Vue's template compiler, Babel, type packages, CSS tooling):
 * the bundle carries only the runtime, so these are not walked into.
 */
const BUILD_ONLY = /^(@babel\/|@vue\/compiler-|@vue\/server-renderer$|@types\/|@jridgewell\/|csstype$|source-map-js$|postcss|nanoid$|picocolors$|estree-walker$|magic-string$|entities$)/;

const seen = new Map(); // "name@version" → entry
function walk(name, fromDir, why, deep = true) {
  if (why === 'bundled' && BUILD_ONLY.test(name)) return;
  const p = find(name, fromDir);
  if (!p) return; // an optional dependency for another platform
  const meta = JSON.parse(readFileSync(p, 'utf8'));
  const key = `${meta.name}@${meta.version}`;
  if (seen.has(key)) return;
  const dir = dirname(p);
  seen.set(key, { name: meta.name, version: meta.version, licence: licenceOf(meta), url: urlOf(meta), text: textOf(dir), why });
  if (deep) for (const dep of Object.keys({ ...meta.dependencies, ...meta.optionalDependencies })) walk(dep, dir, why);
}

function licenceOf(meta) {
  const l = meta.license ?? meta.licenses ?? 'UNKNOWN';
  if (typeof l === 'string') return l;
  if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(' OR ');
  return l.type ?? 'UNKNOWN';
}
function urlOf(meta) {
  const r = typeof meta.repository === 'string' ? meta.repository : meta.repository?.url;
  const u = (r ?? meta.homepage ?? '').replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://').replace(/^github:/, 'https://github.com/');
  return /^https?:\/\//.test(u) ? u : /^[\w-]+\/[\w.-]+$/.test(u) ? `https://github.com/${u}` : '';
}
function textOf(dir) {
  const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying|notice)(\.(md|txt|markdown|mit|bsd|apache))?$/i.test(n) || /^licen[cs]e[-_.]/i.test(n));
  return f ? readFileSync(join(dir, f), 'utf8').replace(/\r\n?/g, '\n').trim() : '';
}

/** Bare package names the source imports (ts, js, vue, css): the devDependencies that end up bundled. */
function imported() {
  const names = new Set();
  const visit = (dir) => {
    for (const n of readdirSync(dir)) {
      const p = join(dir, n);
      if (statSync(p).isDirectory()) visit(p);
      else if (/\.(m?[jt]s|vue|css)$/.test(n)) {
        const src = readFileSync(p, 'utf8');
        for (const m of src.matchAll(/(?:from\s+|import\s*\(\s*|import\s+|require\(\s*|@import\s+|@plugin\s+)['"]([^'"./][^'"]*)['"]/g)) {
          const spec = m[1];
          if (spec.startsWith('node:') || spec.startsWith('@shared') || spec.startsWith('@/')) continue;
          names.add(spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]);
        }
      }
    }
  };
  visit(join(root, 'src'));
  return names;
}

for (const d of Object.keys(pkg.dependencies ?? {})) walk(d, root, 'shipped');
const used = imported();
for (const d of Object.keys(pkg.devDependencies ?? {})) if (used.has(d) && d !== 'electron' && !d.startsWith('@types/')) walk(d, root, 'bundled');
walk('electron', root, 'runtime', false); // the runtime itself; its npm package's install-time helpers never ship

const list = [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
mkdirSync(join(root, 'resources'), { recursive: true });
writeFileSync(join(root, 'resources', 'third-party-licenses.json'), JSON.stringify({ app: self, version: pkg.version, packages: list }, null, 1) + '\n');

const rule = '-'.repeat(78);
const txt = [
  `${self} ${pkg.version} — third-party software`,
  '',
  `${self} is free software under the GNU General Public License v3.0. It contains the open-source packages below,`,
  'each under its own licence; their copyright notices and licence texts follow. Electron also ships the licences',
  'of Chromium and its components inside the app (LICENSES.chromium.html).',
  '',
  ...list.map((p) => `${p.name} ${p.version} — ${p.licence}${p.url ? `\n${p.url}` : ''}\n\n${p.text || `(No licence file in the package; its package.json says: ${p.licence}.)`}\n\n${rule}\n`),
].join('\n');
writeFileSync(join(root, 'resources', 'third-party-licenses.txt'), txt);
console.log(`licences: ${list.length} packages (${list.filter((p) => p.why === 'shipped').length} shipped, ${list.filter((p) => p.why === 'bundled').length} bundled) → resources/third-party-licenses.{json,txt}`);
const missing = list.filter((p) => !p.text).map((p) => `${p.name}@${p.version}`);
if (missing.length) console.log(`  without a licence file: ${missing.join(', ')}`);
