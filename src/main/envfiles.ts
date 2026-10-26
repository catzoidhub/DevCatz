import { copyFileSync, existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize } from 'node:path';
import type { EnvFileInfo } from '@shared/types';

/**
 * The site's .env files (project root and each app folder), for the Env tab:
 * list, read, write, create from .env.example. Only `.env` / `.env.<name>`
 * files inside the project can be touched.
 */
const ENV_NAME = /^\.env(\.[\w.-]+)?$/;
/** Templates, not live config: shown but not the file the app reads. */
const TEMPLATE = /\.(example|sample|dist|template)$/;

export function listEnvFiles(root: string, dirs: string[]): EnvFileInfo[] {
  const out: EnvFileInfo[] = [];
  for (const dir of [...new Set(['.', ...dirs])]) {
    let names: string[] = [];
    try {
      names = readdirSync(join(root, dir)).filter((n) => ENV_NAME.test(n));
    } catch {
      continue;
    }
    // Every folder offers a `.env`, even before it exists (Create).
    if (!names.includes('.env') && (dir === '.' || names.length)) names.push('.env');
    for (const name of names.sort(byImportance)) {
      const path = dir === '.' ? name : `${dir}/${name}`;
      const abs = join(root, path);
      const exists = existsSync(abs);
      const st = exists ? statSync(abs) : null;
      out.push({
        path,
        dir,
        name,
        exists,
        template: TEMPLATE.test(name),
        size: st?.size ?? 0,
        mtime: st?.mtimeMs ?? 0,
        example: names.find((n) => TEMPLATE.test(n)) ? (dir === '.' ? names.find((n) => TEMPLATE.test(n))! : `${dir}/${names.find((n) => TEMPLATE.test(n))}`) : null,
      });
    }
  }
  return out;
}

/** .env first, then .env.local, others, templates last. */
function byImportance(a: string, b: string): number {
  const rank = (n: string) => (n === '.env' ? 0 : n === '.env.local' ? 1 : TEMPLATE.test(n) ? 3 : 2);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/** Resolves a project-relative env path, refusing anything else. */
export function envPath(root: string, rel: string, dirs: string[]): string {
  const clean = normalize(rel).replace(/^\.\//, '');
  const parts = clean.split('/');
  const name = parts.pop() ?? '';
  const dir = parts.join('/') || '.';
  if (!ENV_NAME.test(name) || clean.includes('..') || !['.', ...dirs].includes(dir)) throw new Error(`Not an env file of this site: ${rel}`);
  return join(root, clean);
}

export function readEnv(abs: string): { content: string; mtime: number } {
  if (!existsSync(abs)) return { content: '', mtime: 0 };
  return { content: readFileSync(abs, 'utf8'), mtime: statSync(abs).mtimeMs };
}

/** Refuses to overwrite a file that changed on disk since it was read (`expectedMtime`). */
export function writeEnv(abs: string, content: string, expectedMtime: number | null): number {
  if (expectedMtime !== null && existsSync(abs) && Math.abs(statSync(abs).mtimeMs - expectedMtime) > 1) {
    throw new Error('The file changed on disk since it was opened; reload it first');
  }
  writeFileSync(abs, content.endsWith('\n') || !content ? content : `${content}\n`);
  return statSync(abs).mtimeMs;
}

/** New .env: a copy of the example when there is one, else empty. */
export function createEnv(abs: string, exampleAbs: string | null): void {
  if (existsSync(abs)) throw new Error('It already exists');
  if (exampleAbs && existsSync(exampleAbs)) copyFileSync(exampleAbs, abs);
  else writeFileSync(abs, '');
}

export interface EnvMergePlan {
  added: string[];
  changed: { key: string; from: string; to: string }[];
  unchanged: string[];
}

// [ \t] rather than \s: an empty value must not swallow the next line.
const LINE = (key: string) => new RegExp(`^([ \\t]*(?:export[ \\t]+)?${key.replace(/[.]/g, '\\.')}[ \\t]*=).*$`, 'm');
/** Single quotes keep `$` literal (no interpolation); double quotes only when the value has a single quote. */
/** ${OTHER_KEY} references need double quotes (single quotes turn interpolation off in phpdotenv / dotenv-expand). */
const quoteValue = (v: string) =>
  !/[\s#"'$]/.test(v) ? v : /\$\{\w+\}/.test(v) && !v.includes('"') ? `"${v}"` : v.includes("'") ? JSON.stringify(v) : `'${v}'`;
const readValue = (content: string, key: string) => {
  const m = content.match(new RegExp(`^[ \\t]*(?:export[ \\t]+)?${key.replace(/[.]/g, '\\.')}[ \\t]*=[ \\t]*(.*)$`, 'm'));
  return m ? m[1].trim().replace(/^(['"])(.*)\1$/, '$2') : null;
};

/** What setting `entries` in this .env would change (nothing is written). */
export function planMerge(content: string, entries: Record<string, string>): EnvMergePlan {
  const plan: EnvMergePlan = { added: [], changed: [], unchanged: [] };
  for (const [key, value] of Object.entries(entries)) {
    const cur = readValue(content, key);
    if (cur === null) plan.added.push(key);
    else if (cur !== value) plan.changed.push({ key, from: cur, to: value });
    else plan.unchanged.push(key);
  }
  return plan;
}

/** Existing keys are replaced where they are; new ones go to the end under `comment`. */
export function applyMerge(content: string, entries: Record<string, string>, comment: string): string {
  let out = content;
  const added: string[] = [];
  for (const [key, value] of Object.entries(entries)) {
    const cur = readValue(out, key);
    if (cur === null) added.push(`${key}=${quoteValue(value)}`);
    else if (cur !== value) out = out.replace(LINE(key), (_m, head: string) => head + quoteValue(value));
  }
  if (added.length) out = `${out.replace(/\n*$/, '\n')}\n# ${comment}\n${added.join('\n')}\n`;
  return out;
}
