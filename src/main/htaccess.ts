import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A subset of Apache's mod_rewrite for PHP sites, read from the document
 * root's `.htaccess`, so apps written for Apache keep their pretty URLs:
 * RewriteEngine, RewriteBase, RewriteCond (regex against %{VAR}s, -f, -d, -s,
 * -l, [NC], [OR]) and RewriteRule (backreferences $n / %n, [L], [END], [QSA],
 * [QSD], [NC], [R=301], [F], [G], `-` for "no substitution"). The front
 * controller rules of WordPress / CodeIgniter / Laravel resolve to what the
 * proxy does anyway; custom ones (product/12 → product.php?id=12) now work.
 */

interface Cond {
  test: string;
  pattern: string;
  negate: boolean;
  nc: boolean;
  or: boolean;
}

interface Rule {
  conds: Cond[];
  pattern: RegExp;
  negate: boolean;
  target: string;
  flags: { last: boolean; end: boolean; qsa: boolean; qsd: boolean; redirect: number | null; forbidden: boolean; gone: boolean };
}

interface Parsed {
  enabled: boolean;
  base: string;
  rules: Rule[];
}

export type RewriteResult =
  | { kind: 'none' }
  | { kind: 'rewrite'; path: string; query: string }
  | { kind: 'redirect'; status: number; location: string }
  | { kind: 'forbidden' }
  | { kind: 'gone' };

export interface RewriteContext {
  /** Decoded URL path, starting with "/". */
  path: string;
  query: string;
  docroot: string;
  host: string;
  method: string;
  https: boolean;
  headers: Record<string, string | string[] | undefined>;
}

const cache = new Map<string, { mtime: number; parsed: Parsed }>();

/** Splits a directive line into arguments (quotes kept together). */
function args(line: string): string[] {
  return [...line.matchAll(/"([^"]*)"|(\S+)/g)].map((m) => m[1] ?? m[2]);
}

function parseFlags(raw: string | undefined): string[] {
  return raw && raw.startsWith('[') ? raw.slice(1, -1).split(',').map((f) => f.trim()) : [];
}

export function parse(text: string): Parsed {
  const out: Parsed = { enabled: false, base: '/', rules: [] };
  let conds: Cond[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('<')) continue;
    const [directive, ...a] = args(line);
    switch (directive.toLowerCase()) {
      case 'rewriteengine':
        out.enabled = /^on$/i.test(a[0] ?? '');
        break;
      case 'rewritebase':
        out.base = a[0]?.endsWith('/') ? a[0] : `${a[0] ?? ''}/`;
        break;
      case 'rewritecond': {
        const flags = parseFlags(a[2]).map((f) => f.toUpperCase());
        const pattern = a[1] ?? '';
        conds.push({
          test: a[0] ?? '',
          pattern: pattern.replace(/^!/, ''),
          negate: pattern.startsWith('!'),
          nc: flags.includes('NC') || flags.includes('NOCASE'),
          or: flags.includes('OR') || flags.includes('ORNEXT'),
        });
        break;
      }
      case 'rewriterule': {
        const flags = parseFlags(a[2]);
        const upper = flags.map((f) => f.toUpperCase());
        const pat = a[0] ?? '';
        const nc = upper.includes('NC') || upper.includes('NOCASE');
        let pattern: RegExp;
        try {
          pattern = new RegExp(pat.replace(/^!/, ''), nc ? 'i' : '');
        } catch {
          conds = [];
          continue; // an Apache-only regex feature: skip the rule
        }
        const r = upper.find((f) => f === 'R' || f.startsWith('R=') || f.startsWith('REDIRECT'));
        out.rules.push({
          conds,
          pattern,
          negate: pat.startsWith('!'),
          target: a[1] ?? '-',
          flags: {
            last: upper.includes('L') || upper.includes('LAST'),
            end: upper.includes('END'),
            qsa: upper.includes('QSA') || upper.includes('QSAPPEND'),
            qsd: upper.includes('QSD') || upper.includes('QSDISCARD'),
            redirect: r ? Number(r.split('=')[1]) || 302 : null,
            forbidden: upper.includes('F') || upper.includes('FORBIDDEN'),
            gone: upper.includes('G') || upper.includes('GONE'),
          },
        });
        conds = [];
        break;
      }
      default:
        break;
    }
  }
  return out;
}

/** The docroot's .htaccess, parsed once per change. */
function load(docroot: string): Parsed | null {
  const file = join(docroot, '.htaccess');
  if (!existsSync(file)) return null;
  const mtime = statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtime === mtime) return hit.parsed;
  const parsed = parse(readFileSync(file, 'utf8'));
  cache.set(file, { mtime, parsed });
  return parsed;
}

function variable(name: string, ctx: RewriteContext, path: string, query: string): string {
  const n = name.toUpperCase();
  if (n.startsWith('HTTP:')) {
    const v = ctx.headers[name.slice(5).toLowerCase()];
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  if (n.startsWith('HTTP_')) {
    const v = ctx.headers[n.slice(5).toLowerCase().replace(/_/g, '-')];
    return Array.isArray(v) ? v.join(', ') : (v ?? '');
  }
  switch (n) {
    case 'REQUEST_URI':
      return path;
    case 'REQUEST_FILENAME':
    case 'SCRIPT_FILENAME':
      return join(ctx.docroot, path);
    case 'QUERY_STRING':
      return query;
    case 'HTTP_HOST':
    case 'SERVER_NAME':
      return ctx.host;
    case 'REQUEST_METHOD':
      return ctx.method;
    case 'HTTPS':
      return ctx.https ? 'on' : 'off';
    case 'REQUEST_SCHEME':
      return ctx.https ? 'https' : 'http';
    case 'DOCUMENT_ROOT':
      return ctx.docroot;
    case 'THE_REQUEST':
      return `${ctx.method} ${path}${query ? `?${query}` : ''} HTTP/1.1`;
    default:
      return '';
  }
}

const expand = (s: string, rule: RegExpMatchArray | null, cond: RegExpMatchArray | null, ctx: RewriteContext, path: string, query: string) =>
  s
    .replace(/%\{([^}]+)\}/g, (_m, v: string) => variable(v, ctx, path, query))
    .replace(/\$(\d)/g, (_m, i: string) => rule?.[Number(i)] ?? '')
    .replace(/%(\d)/g, (_m, i: string) => cond?.[Number(i)] ?? '');

function testCond(c: Cond, ctx: RewriteContext, path: string, query: string, rule: RegExpMatchArray | null, last: RegExpMatchArray | null): { ok: boolean; match: RegExpMatchArray | null } {
  const value = expand(c.test, rule, last, ctx, path, query);
  let ok: boolean;
  let match: RegExpMatchArray | null = null;
  if (c.pattern === '-f' || c.pattern === '-F') ok = existsSync(value) && statSync(value).isFile();
  else if (c.pattern === '-d') ok = existsSync(value) && statSync(value).isDirectory();
  else if (c.pattern === '-s') ok = existsSync(value) && statSync(value).isFile() && statSync(value).size > 0;
  else if (c.pattern === '-l' || c.pattern === '-L') ok = false;
  else if (c.pattern.startsWith('=')) ok = value === c.pattern.slice(1);
  else {
    try {
      match = value.match(new RegExp(c.pattern, c.nc ? 'i' : ''));
    } catch {
      match = null;
    }
    ok = Boolean(match);
  }
  return { ok: c.negate ? !ok : ok, match: c.negate ? null : match };
}

/**
 * Runs the rules like Apache does in a per-directory context: patterns see the
 * path without the leading slash; an internal rewrite runs the rules again
 * (up to 10 rounds) unless [END] or nothing changed.
 */
export function rewrite(ctx: RewriteContext): RewriteResult {
  const parsed = load(ctx.docroot);
  if (!parsed?.enabled || !parsed.rules.length) return { kind: 'none' };
  let path = ctx.path;
  let query = ctx.query;
  let changed = false;
  for (let round = 0; round < 10; round++) {
    let rewroteThisRound = false;
    let stop = false;
    for (const r of parsed.rules) {
      const subject = path.replace(/^\//, '');
      const m = subject.match(r.pattern);
      if (r.negate ? m : !m) continue;
      const ruleMatch = r.negate ? null : m;
      // Conditions: AND by default; [OR] ORs a condition with the next one.
      let ok = true;
      let acc = false;
      let inOr = false;
      let lastCond: RegExpMatchArray | null = null;
      for (const c of r.conds) {
        const res = testCond(c, ctx, path, query, ruleMatch, lastCond);
        if (res.match) lastCond = res.match;
        acc = inOr ? acc || res.ok : res.ok;
        if (c.or) {
          inOr = true;
          continue;
        }
        inOr = false;
        if (!acc) {
          ok = false;
          break;
        }
      }
      if (inOr && !acc) ok = false;
      if (!ok) continue;
      if (r.flags.forbidden) return { kind: 'forbidden' };
      if (r.flags.gone) return { kind: 'gone' };
      if (r.target === '-') {
        if (r.flags.last || r.flags.end) {
          stop = true;
          break;
        }
        continue;
      }
      let target = expand(r.target, ruleMatch, lastCond, ctx, path, query);
      let newQuery = query;
      const qi = target.indexOf('?');
      if (qi >= 0) {
        const tq = target.slice(qi + 1);
        target = target.slice(0, qi);
        newQuery = r.flags.qsa && query ? `${tq}${tq ? '&' : ''}${query}` : tq;
      } else if (r.flags.qsd) newQuery = '';
      if (r.flags.redirect || /^https?:\/\//.test(target)) {
        const loc = /^https?:\/\//.test(target) ? target : `${target.startsWith('/') ? '' : parsed.base}${target}`;
        return { kind: 'redirect', status: r.flags.redirect ?? 302, location: `${loc}${newQuery ? `?${newQuery}` : ''}` };
      }
      const next = target.startsWith('/') ? target : `${parsed.base}${target}`;
      if (next !== path || newQuery !== query) {
        path = next;
        query = newQuery;
        rewroteThisRound = true;
        changed = true;
      }
      if (r.flags.last || r.flags.end) {
        stop = r.flags.end;
        break;
      }
    }
    // Landed on a script (index.php, index.php/path): what Apache would hand to PHP; no further rounds.
    const script = path.match(/^(.*?\.php)(\/|$)/);
    if (script && existsSync(join(ctx.docroot, script[1]))) break;
    if (stop || !rewroteThisRound) break;
  }
  return changed ? { kind: 'rewrite', path, query } : { kind: 'none' };
}
