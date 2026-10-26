import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import type {
  AiAction,
  AiActionKind,
  AiAskAnswer,
  AiAskRequest,
  AiCommitAnswer,
  AiCommitRequest,
  AiDockerEditAnswer,
  AiDockerEditRequest,
  AiEnvAnswer,
  AiEnvRequest,
  AiExplainAnswer,
  AiExplainRequest,
  AiPreview,
  AiSearchAnswer,
  AiSearchRequest,
  AiTurn,
  AiWebhookAnswer,
  AiWebhookRequest,
  DbAction,
  ProjectState,
  StorageAction,
} from '@shared/types';
import type { Herd } from '../herd';
import { git, repoRoot } from '../git';
import { AiClient } from './client';
import { needFeature } from './settings';

/**
 * DevCatz's AI features (TODO §28): each builds a system prompt from what DevCatz knows (stack, logs, Git,
 * Docker, .env names, search index settings, an Expose request), with secrets masked, and asks for a JSON
 * answer. Suggestions that DevCatz can carry out come back as actions from a fixed list; the user clicks them
 * and aiRunAction checks every argument before doing anything.
 */

// ---------------------------------------------------------------- masking

const SECRET_KEY = /(pass(word)?|secret|token|api[_-]?key|private|credential|auth|signature|cookie|session|dsn|salt|_key$|^key$)/i;

/** Masks what looks secret in free text (log lines, payloads): KEY=value secrets, bearer tokens, keys, URL passwords. */
export function maskText(text: string): string {
  return text
    .replaceAll(homedir(), '~')
    .replace(/\b([A-Z][A-Z0-9_]{2,})\s*=\s*("[^"]*"|'[^']*'|\S+)/g, (m, k: string) => (SECRET_KEY.test(k) ? `${k}=•••` : m))
    .replace(/(authorization|x-api-key|api-key|cookie|set-cookie)(["']?\s*[:=]\s*["']?)[^\s"',}]+(\s+[^\s"',}]+)?/gi, '$1$2•••')
    .replace(/\b(bearer|token|basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, '$1 •••')
    .replace(/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs]|glpat|AKIA)[-_A-Za-z0-9]{10,}/g, '•••')
    .replace(/\b[A-Fa-f0-9]{32,}\b/g, '•••')
    .replace(/(\w+:\/\/[^:/\s@]+:)[^@\s/]+@/g, '$1•••@')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, '•••jwt•••');
}

// ---------------------------------------------------------------- schemas

/** Every argument an action kind takes (see ACTION_HELP). */
const ARG_KEYS = ['extension', 'version', 'task', 'service', 'file', 'key', 'value', 'tab', 'section', 'item', 'share', 'database'];
const ACTION_KINDS: AiActionKind[] = ['site-start', 'site-stop', 'site-restart', 'install-deps', 'php-extension', 'set-node-version', 'set-php-version', 'set-python-version', 'db-task', 'stack-task', 'service-start', 'service-stop', 'service-restart', 'service-uninstall', 'expose-start', 'expose-stop', 'site-setting', 'env-set', 'open-tab', 'open-section', 'open-dbcatz'];
/** Sections of the app (open-section); "gateways" is the WhatsApp / push / SMS page. */
const SECTIONS = ['projects', 'runtimes', 'database', 'storage', 'websocket', 'search', 'git', 'mail', 'gateways', 'expose', 'monitoring', 'settings'];
/** Site settings the AI may change (site-setting): on / off switches, and the services a site is linked to. */
const SITE_SWITCHES = ['autoStart', 'queueWorker', 'scheduler', 'secure'] as const;
const SITE_LINKS = ['storageService', 'searchEngine', 'wsServer', 'dbService'] as const;
const ACTION_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ACTION_KINDS },
    label: { type: 'string', description: 'Button text, imperative, short' },
    site: { type: 'string', description: 'Site id the action applies to; empty for the current site' },
    // Every argument any kind takes, each a string ('' when the kind does not use it): structured output needs a
    // closed object (additionalProperties: false), so the keys are listed rather than free.
    args: {
      type: 'object',
      description: 'Kind-specific arguments (see the action list); "" for the ones this kind does not use',
      properties: Object.fromEntries(ARG_KEYS.map((k) => [k, { type: 'string' }])),
      required: ARG_KEYS,
      additionalProperties: false,
    },
  },
  required: ['kind', 'label', 'site', 'args'],
  additionalProperties: false,
};
const EXPLAIN_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    cause: { type: 'string' },
    steps: { type: 'array', items: { type: 'string' } },
    actions: { type: 'array', items: ACTION_SCHEMA },
  },
  required: ['summary', 'cause', 'steps', 'actions'],
  additionalProperties: false,
};
const COMMIT_SCHEMA = {
  type: 'object',
  properties: { title: { type: 'string' }, body: { type: 'string' } },
  required: ['title', 'body'],
  additionalProperties: false,
};
const DOCKER_SCHEMA = {
  type: 'object',
  properties: { content: { type: 'string', description: 'The whole file after the change' }, explanation: { type: 'string' } },
  required: ['content', 'explanation'],
  additionalProperties: false,
};
const ENV_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string' },
          meaning: { type: 'string' },
          issue: { type: 'string', description: 'What is wrong or missing; empty when fine' },
          suggestion: { type: 'string', description: 'A value or what to put there; empty when nothing to suggest' },
          set: { type: 'string', description: 'A value DevCatz should write for this key (only DevCatz service addresses or non-secret defaults); empty for none' },
        },
        required: ['key', 'meaning', 'issue', 'suggestion', 'set'],
        additionalProperties: false,
      },
    },
  },
  required: ['summary', 'items'],
  additionalProperties: false,
};
const SEARCH_SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string' }, filter: { type: 'string' }, sort: { type: 'string' }, explanation: { type: 'string' } },
  required: ['query', 'filter', 'sort', 'explanation'],
  additionalProperties: false,
};
const WEBHOOK_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' }, code: { type: 'string' }, language: { type: 'string' }, where: { type: 'string' } },
  required: ['explanation', 'code', 'language', 'where'],
  additionalProperties: false,
};
const ASK_SCHEMA = {
  type: 'object',
  properties: { explanation: { type: 'string' }, actions: { type: 'array', items: ACTION_SCHEMA } },
  required: ['explanation', 'actions'],
  additionalProperties: false,
};

const LANG = '- Write explanations in the language the user wrote in (the log or the request); default to English.';

/** What each action kind takes, for the prompts. */
const ACTION_HELP = [
  'Actions DevCatz can run (only these kinds; args are strings):',
  '- site-start / site-stop / site-restart: {} — the site\'s dev server and processes.',
  '- install-deps: {} — npm / pnpm / bun / composer / uv install in the site.',
  '- php-extension: {"extension": "intl", "version": "8.4"} — a PECL / bundled extension for an installed PHP version.',
  '- set-node-version / set-php-version / set-python-version: {"version": "22.11.0"} — only versions listed as installed.',
  '- db-task: {"task": "artisan-migrate" | "artisan-fresh" | "artisan-seed" | "migrate" | "generate" | "seed"} — Laravel artisan / Prisma tasks.',
  '- stack-task: {"task": "<task id from the list>"} — a framework command DevCatz knows for the site.',
  '- service-start / service-stop / service-restart: {"service": "<service ref from the list>"} — any installed DevCatz service: databases (db:<id>), object storage (storage:rustfs …), WebSocket (ws:reverb …), search (search:meilisearch …), mail (mail), gateways (gateway:ntfy …, whatsapp:gowa …). No "site" needed.',
  '- service-uninstall: {"service": "<service ref>"} — opens that service\'s own uninstall dialog, where the user types its name to confirm and chooses whether to keep the data; it never uninstalls by itself.',
  '- expose-start: {} — share the site on a public URL (Expose, default provider); expose-stop: {"share": "<share id>"}.',
  `- site-setting: {"key": "<${[...SITE_SWITCHES, ...SITE_LINKS].join(' | ')}>", "value": "…"} — switches take "true" / "false"; storageService / searchEngine / wsServer take an installed service kind (e.g. "rustfs"), dbService a database service id, "" unlinks.`,
  '- env-set: {"file": ".env", "key": "DB_HOST", "value": "127.0.0.1"} — never secrets; DevCatz shows a preview first.',
  '- open-tab: {"tab": "overview" | "env" | "database" | "git" | "docker" | "logs" | "settings"} — just shows a tab of the site.',
  `- open-section: {"section": "${SECTIONS.join('" | "')}", "item": "<optional: a service kind or id to focus>"} — just shows a page; use it to install something not installed yet (DevCatz installs from that page) or for anything no action covers.`,
  '- open-dbcatz: {"service": "db:<id>", "database": "<optional database name>"} — opens DBCatz, the database viewer app, at that DevCatz database service (optionally at one database) to see or edit its tables, rows and keys; DevCatz offers to install DBCatz when it is missing. Use it whenever the user wants to look inside a database or run a query (start the service first when it is stopped). Never say DevCatz cannot open DBCatz.',
  'Propose an action only when it clearly fixes or advances the problem; prefer one or two. Label it as a short imperative button text.',
];

export class DevCatzAi {
  readonly client = new AiClient();

  constructor(private herd: Herd) {}

  private site(id: string): ProjectState {
    const p = this.herd.find(id);
    if (!p) throw new Error('This site is gone');
    return this.herd.state(p);
  }

  /** The site in a few lines: stack, frameworks, runtime versions, dev command, services, tasks. */
  private siteContext(p: ProjectState): string[] {
    const s = p.stack;
    const apps = s.apps.map((a) => `${a.name} (${a.framework}${a.library ? ` / ${a.library}` : ''}, ${a.kind}${a.port ? `, port ${a.port}` : ''})`).join('; ');
    const rt = [
      s.runtime === 'node' || s.packageManager ? `Node ${p.node.version ?? '?'}${s.packageManager ? `, ${s.packageManager}` : ''}` : '',
      s.runtime === 'php' ? `PHP ${p.php.version ?? '?'} (installed: ${this.herd.phpVersions().join(', ') || 'none'})` : '',
      s.runtime === 'python' ? `Python ${p.python?.version ?? '?'}` : '',
      p.go?.version ? `Go ${p.go.version}` : '',
    ].filter(Boolean);
    const tasks = (s.tasks ?? []).map((t) => `${t.id} (${t.tool} ${t.label})`).join(', ');
    const services = this.herd.dbs.state().filter((d) => !d.pending).map((d) => `db:${d.id}: ${d.name} ${d.engine} ${d.version} on 127.0.0.1:${d.port} (${d.status})`);
    return [
      `Site "${p.name}" (id ${p.id}) at ${p.domain}, folder ${p.path.replace(homedir(), '~')}, status ${p.status}.`,
      `Runtime: ${s.runtime}. Apps: ${apps || 'none detected'}.`,
      rt.length ? `Versions: ${rt.join('; ')}.` : '',
      p.stack.devCommand || p.devCommand ? `Dev command: ${p.devCommand ?? p.stack.devCommand}.` : '',
      s.database ? `Database: ${s.database.engine}${s.database.database ? ` "${s.database.database}"` : ''}${p.dbService ? ` on DevCatz service ${p.dbService}` : ''} (status ${p.dbStatus}).` : '',
      tasks ? `Stack tasks: ${tasks}.` : '',
      `Installed Node versions: ${this.herd.nodeVersions().join(', ') || 'none'}.`,
      services.length ? `DevCatz database services:\n${services.map((x) => `  ${x}`).join('\n')}` : 'No DevCatz database services.',
    ].filter(Boolean);
  }

  // ---------------------------------------------------------------- explain & fix

  private explainParts(req: AiExplainRequest): { system: string; turns: AiTurn[] } {
    const p = this.site(req.siteId);
    const lines = (req.lines?.length ? req.lines : this.herd.processes.getLogs(p.id).slice(-150).map((l) => `${l.stream === 'err' ? '! ' : ''}${l.text}`)).slice(-200);
    const system = [
      `You help a developer with a site running in DevCatz, a local development environment for macOS (sites on *.localhost with HTTPS, PHP-FPM, Node, Bun, Python, Go, local database services). Explain the ${req.source === 'docker' ? 'Docker / compose output' : req.source === 'crash' ? 'crash of the dev server' : 'log lines'} below and say how to fix it.`,
      LANG,
      '- summary: one or two sentences, what happened. cause: why, in plain words. steps: what to do that DevCatz cannot do (code changes, commands); short, concrete; empty when an action covers it.',
      ...ACTION_HELP,
      '',
      ...this.siteContext(p),
    ].join('\n');
    const last = `${req.prompt?.trim() ? `${req.prompt.trim()}\n\n` : ''}${req.source === 'docker' ? 'Docker output' : 'Log'}:\n${maskText(lines.join('\n')).slice(-24_000)}`;
    return { system, turns: [...(req.history ?? []).slice(-8), { role: 'user', text: last }] };
  }

  previewExplain(req: AiExplainRequest): AiPreview {
    needFeature(req.source === 'docker' ? 'docker' : 'explain');
    const { system, turns } = this.explainParts(req);
    return this.client.preview(system, turns);
  }

  async explain(req: AiExplainRequest, token = ''): Promise<AiExplainAnswer> {
    needFeature(req.source === 'docker' ? 'docker' : 'explain');
    const { system, turns } = this.explainParts(req);
    const a = await this.client.run<AiExplainAnswer>(system, turns, EXPLAIN_SCHEMA, token);
    return { summary: String(a.summary ?? ''), cause: String(a.cause ?? ''), steps: (a.steps ?? []).map(String), actions: this.cleanActions(a.actions, req.siteId) };
  }

  // ---------------------------------------------------------------- commit message / PR

  private async commitParts(req: AiCommitRequest): Promise<{ system: string; turns: AiTurn[] }> {
    const p = this.site(req.siteId);
    const root = await repoRoot(p.path);
    if (!root) throw new Error(`${p.name} is not a Git repository`);
    const subjects = (await git(root, ['log', '-15', '--format=%s'], { timeout: 10_000 })).stdout.trim();
    let diff: string;
    let stat: string;
    let commits = '';
    if (req.kind === 'commit') {
      stat = (await git(root, ['diff', '--cached', '--stat'], { timeout: 15_000 })).stdout.trim();
      if (!stat) throw new Error('Nothing is staged: stage the changes first');
      diff = (await git(root, ['diff', '--cached', '--no-color', '-U3'], { timeout: 30_000, maxBytes: 4_000_000 })).stdout;
    } else {
      const base = req.base?.trim() || (await this.defaultBase(root));
      commits = (await git(root, ['log', `${base}..HEAD`, '--format=%s%n%b%n---'], { timeout: 15_000 })).stdout.trim();
      if (!commits) throw new Error(`No commits on this branch that ${base} does not have`);
      stat = (await git(root, ['diff', `${base}...HEAD`, '--stat'], { timeout: 15_000 })).stdout.trim();
      diff = (await git(root, ['diff', `${base}...HEAD`, '--no-color', '-U2'], { timeout: 30_000, maxBytes: 4_000_000 })).stdout;
    }
    const system = [
      req.kind === 'commit'
        ? 'You write the Git commit message for the staged changes below.'
        : 'You write the title and description of a pull request for the branch below.',
      '- Follow the repository\'s own style, seen in its recent commit subjects (language, length, prefixes like "feat:" only if they use them).',
      req.kind === 'commit'
        ? '- title: the subject line, at most ~72 characters, imperative. body: what changed and why, wrapped at ~80 columns, plain text; empty when the subject says it all.'
        : '- title: a short PR title. body: Markdown — a summary of what and why, then a short list of the notable changes, and how to test when it is not obvious.',
      '- Describe what the diff does; do not invent changes, tickets or issue numbers.',
      '',
      `Recent commit subjects:\n${subjects || '(none yet)'}`,
    ].join('\n');
    const body = [
      req.prompt?.trim() ? `Wishes: ${req.prompt.trim()}` : '',
      commits ? `Commits on the branch:\n${commits.slice(0, 8000)}` : '',
      `Files:\n${stat}`,
      `Diff${diff.length > 60_000 ? ' (cut, too long)' : ''}:\n${maskText(diff.slice(0, 60_000))}`,
    ]
      .filter(Boolean)
      .join('\n\n');
    return { system, turns: [{ role: 'user', text: body }] };
  }

  private async defaultBase(root: string): Promise<string> {
    const head = (await git(root, ['symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD'], { timeout: 5000 })).stdout.trim();
    if (head) return head;
    for (const b of ['main', 'master', 'develop']) if ((await git(root, ['rev-parse', '--verify', '-q', b], { timeout: 5000 })).code === 0) return b;
    return 'HEAD~1';
  }

  async previewCommit(req: AiCommitRequest): Promise<AiPreview> {
    needFeature('commit');
    const { system, turns } = await this.commitParts(req);
    return this.client.preview(system, turns);
  }

  async commit(req: AiCommitRequest, token = ''): Promise<AiCommitAnswer> {
    needFeature('commit');
    const { system, turns } = await this.commitParts(req);
    const a = await this.client.run<AiCommitAnswer>(system, turns, COMMIT_SCHEMA, token);
    return { title: String(a.title ?? '').trim(), body: String(a.body ?? '').trim() };
  }

  // ---------------------------------------------------------------- Docker file edits

  private dockerParts(req: AiDockerEditRequest): { system: string; turns: AiTurn[] } {
    const p = this.site(req.siteId);
    const system = [
      `You change ${req.file}, a Docker file DevCatz generated for a site, as the user asks.`,
      '- Return the whole file after the change in content, keeping everything else as it is (comments, stages, order). explanation: one to three sentences on what you changed.',
      '- Use official images and keep the image small (multi-stage, slim / alpine where the stack allows, no build tools in the final stage).',
      LANG,
      '',
      ...this.siteContext(p),
    ].join('\n');
    return { system, turns: [{ role: 'user', text: `${req.prompt.trim()}\n\n${req.file}:\n${maskText(req.content)}` }] };
  }

  previewDockerEdit(req: AiDockerEditRequest): AiPreview {
    needFeature('docker');
    const { system, turns } = this.dockerParts(req);
    return this.client.preview(system, turns);
  }

  async dockerEdit(req: AiDockerEditRequest, token = ''): Promise<AiDockerEditAnswer> {
    needFeature('docker');
    if (!req.prompt.trim()) throw new Error('Say what to change');
    const { system, turns } = this.dockerParts(req);
    const a = await this.client.run<AiDockerEditAnswer>(system, turns, DOCKER_SCHEMA, token);
    if (!a.content?.trim()) throw new Error('The model returned an empty file');
    return { content: a.content.endsWith('\n') ? a.content : `${a.content}\n`, explanation: String(a.explanation ?? '') };
  }

  // ---------------------------------------------------------------- .env helper

  /** KEY, set or empty, and the shape of the value (never the value). */
  private envShape(text: string): { key: string; state: string }[] {
    const out: { key: string; state: string }[] = [];
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, '');
      let state = v ? 'set' : 'EMPTY';
      // Dev hosts and ports are not secret and are what the suggestions are about.
      const host = v.match(/^(?:[a-z+]+:\/\/)?(?:[^@/\s]*@)?((?:[a-z0-9-]+\.)*(?:localhost|test|local)|127\.0\.0\.1|::1)(?::(\d+))?/i);
      if (v && host && !SECRET_KEY.test(m[1])) state = `set (points at ${host[1]}${host[2] ? `:${host[2]}` : ''})`;
      else if (v && /^(true|false|null|\d+|local|development|production|testing|debug|info)$/i.test(v) && !SECRET_KEY.test(m[1])) state = `set to ${v}`;
      out.push({ key: m[1], state });
    }
    return out;
  }

  private envParts(req: AiEnvRequest): { system: string; turns: AiTurn[] } {
    const p = this.site(req.siteId);
    const file = resolve(p.path, req.file);
    if (relative(p.path, file).startsWith('..')) throw new Error('That file is outside the site');
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    const exampleFile = ['.env.example', '.env.sample', '.env.dist'].map((f) => join(p.path, f)).find((f) => existsSync(f));
    const example = exampleFile ? readFileSync(exampleFile, 'utf8').slice(0, 12_000) : '';
    const storage = this.herd.storage.state().filter((s) => s.installed).map((s) => `${s.kind} S3 API ${s.urls?.api ?? ''}`);
    const system = [
      `You explain a site's ${req.file} for a developer using DevCatz (sites on https://<name>.localhost, local database / Redis / S3 / mail services).`,
      '- You see key names, whether each is set, and only harmless shapes (which dev host a URL points at, booleans, numbers); never the real values. Never ask for or invent secrets.',
      '- items: the keys that matter — empty ones, ones that look wrong for local development (pointing at a host that is not this site or a DevCatz service), keys .env.example has that the file lacks — plus any the user asks about. meaning: what the key is for in this framework. issue: what is wrong, empty when fine. suggestion: what to put there.',
      '- set: only when DevCatz should write a value itself and it is not a secret (a DevCatz service host / port, the site URL, a mail catcher setting); else empty.',
      LANG,
      '',
      ...this.siteContext(p),
      `Site URL: ${this.herd.urlFor(p)}. Mail catcher: SMTP 127.0.0.1:${this.herd.mail.state().port ?? 2525}.`,
      storage.length ? `DevCatz object storage: ${storage.join('; ')}.` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const shape = this.envShape(text);
    const body = [
      req.prompt?.trim() ? `Question: ${req.prompt.trim()}` : 'Check this file for local development.',
      `${req.file} (${shape.length} keys):\n${shape.map((x) => `${x.key}: ${x.state}`).join('\n') || '(empty or missing)'}`,
      example ? `${exampleFile!.split('/').pop()} (committed template, values shown):\n${maskText(example)}` : '',
    ]
      .filter(Boolean)
      .join('\n\n');
    return { system, turns: [{ role: 'user', text: body }] };
  }

  previewEnv(req: AiEnvRequest): AiPreview {
    needFeature('env');
    const { system, turns } = this.envParts(req);
    return this.client.preview(system, turns);
  }

  async env(req: AiEnvRequest, token = ''): Promise<AiEnvAnswer> {
    needFeature('env');
    const { system, turns } = this.envParts(req);
    const a = await this.client.run<{ summary: string; items: { key: string; meaning: string; issue: string; suggestion: string; set: string }[] }>(system, turns, ENV_SCHEMA, token);
    return {
      summary: String(a.summary ?? ''),
      items: (a.items ?? []).map((i) => ({
        key: String(i.key),
        meaning: String(i.meaning ?? ''),
        issue: String(i.issue ?? ''),
        suggestion: String(i.suggestion ?? ''),
        action: i.set && /^[A-Za-z_][A-Za-z0-9_.]*$/.test(i.key) && !SECRET_KEY.test(i.key) ? { kind: 'env-set', label: `Set ${i.key}`, site: req.siteId, args: { file: req.file, key: i.key, value: String(i.set) } } : null,
      })),
    };
  }

  // ---------------------------------------------------------------- search playground

  private async searchParts(req: AiSearchRequest): Promise<{ system: string; turns: AiTurn[] }> {
    const settings = await this.herd.search.getSettings(req.kind, req.index).catch(() => ({ text: '' }));
    const syntax: Record<string, string> = {
      meilisearch: 'Meilisearch: query = the q text; filter = a Meilisearch filter expression (e.g. `genre = "drama" AND year > 2010`, only filterableAttributes); sort = comma-separated `attr:asc|desc` (only sortableAttributes).',
      typesense: 'Typesense: query = q; filter = filter_by (e.g. `genre:=drama && year:>2010`); sort = sort_by (e.g. `year:desc`).',
      opensearch: 'OpenSearch: query = the text for multi_match; filter = a query_string clause (e.g. `genre:drama AND year:>2010`); sort = `field:asc|desc` comma-separated.',
      zincsearch: 'ZincSearch: query = the text; filter = a query_string clause; sort = `-field` or `field`, comma-separated.',
      manticore: 'Manticore: query = the full-text MATCH text; filter = a SQL WHERE condition on attributes (e.g. `year > 2010`); sort = an ORDER BY list (e.g. `year DESC`).',
      sonic: 'Sonic: only query text (no filter or sort: leave them empty).',
    };
    const system = [
      `You turn a request in plain words into a search for the ${req.kind} index "${req.index}" in DevCatz's search playground.`,
      syntax[req.kind] ?? 'query = text, filter and sort in the engine’s syntax.',
      '- Use only fields that exist in the settings below; leave filter / sort empty when they are not needed or not allowed.',
      '- explanation: one or two sentences.',
      LANG,
      '',
      `Index settings / schema:\n${maskText(settings.text).slice(0, 12_000) || '(unknown)'}`,
    ].join('\n');
    return { system, turns: [...(req.history ?? []).slice(-8), { role: 'user', text: req.prompt.trim() }] };
  }

  async previewSearch(req: AiSearchRequest): Promise<AiPreview> {
    needFeature('search');
    const { system, turns } = await this.searchParts(req);
    return this.client.preview(system, turns);
  }

  async search(req: AiSearchRequest, token = ''): Promise<AiSearchAnswer> {
    needFeature('search');
    if (!req.prompt.trim()) throw new Error('Say what to search for');
    const { system, turns } = await this.searchParts(req);
    const a = await this.client.run<AiSearchAnswer>(system, turns, SEARCH_SCHEMA, token);
    return { query: String(a.query ?? ''), filter: String(a.filter ?? ''), sort: String(a.sort ?? ''), explanation: String(a.explanation ?? '') };
  }

  // ---------------------------------------------------------------- webhooks (Expose)

  private webhookParts(req: AiWebhookRequest): { system: string; turns: AiTurn[] } {
    const share = this.herd.expose.state().shares.find((s) => s.id === req.shareId);
    if (!share) throw new Error('That share is gone');
    const r = this.herd.expose.requests(req.shareId, 500).find((x) => x.id === req.requestId);
    if (!r) throw new Error('That request is no longer in the inspector');
    const p = this.site(share.siteId);
    const headers = Object.entries(r.requestHeaders)
      .map(([k, v]) => `${k}: ${SECRET_KEY.test(k) || /signature|authorization|cookie/i.test(k) ? '•••' : v}`)
      .join('\n');
    const system = [
      'You look at an HTTP request that reached a local site through a public tunnel (DevCatz Expose) — usually a webhook — and help handle it.',
      '- explanation: who sent it (Stripe, GitHub, Midtrans, Xendit, WhatsApp gateway, Telegram …) and which event, what the important fields mean, and how to verify it (signature header and secret name) if the sender signs requests.',
      `- code: a handler for this site's framework (${p.stack.apps.map((a) => a.library ?? a.framework).join(', ')}) that verifies the request when it can, parses it, and handles this event; idiomatic, with the route. language: php, ts, js, py or go. where: which files it goes in.`,
      '- Read secrets from environment variables; never put real values in code.',
      LANG,
      '',
      ...this.siteContext(p),
    ].join('\n');
    const text = [`${r.method} ${r.path}`, headers, '', maskText(r.requestBody ?? '(no body)').slice(0, 30_000), req.prompt?.trim() ? `\nWishes: ${req.prompt.trim()}` : ''].join('\n');
    return { system, turns: [{ role: 'user', text }] };
  }

  previewWebhook(req: AiWebhookRequest): AiPreview {
    needFeature('webhook');
    const { system, turns } = this.webhookParts(req);
    return this.client.preview(system, turns);
  }

  async webhook(req: AiWebhookRequest, token = ''): Promise<AiWebhookAnswer> {
    needFeature('webhook');
    const { system, turns } = this.webhookParts(req);
    const a = await this.client.run<AiWebhookAnswer>(system, turns, WEBHOOK_SCHEMA, token);
    return { explanation: String(a.explanation ?? ''), code: String(a.code ?? ''), language: String(a.language ?? ''), where: String(a.where ?? '') };
  }

  /** Every DevCatz service with its ref (for service-* actions) and status; not-installed ones say where to add them. */
  private serviceLines(): string[] {
    const h = this.herd;
    const out: string[] = [];
    for (const d of h.dbs.state().filter((x) => !x.pending)) out.push(`db:${d.id} — database ${d.name} (${d.engine} ${d.version}, :${d.port}) ${d.status}`);
    const kinds = (label: string, prefix: string, section: string, list: { kind?: string; engine?: string; name: string; installed: boolean; status: string }[]) => {
      for (const x of list) {
        const k = x.kind ?? x.engine;
        out.push(x.installed ? `${prefix}:${k} — ${label} ${x.name} ${x.status}` : `(${label} ${x.name} [${k}] not installed: open-section ${section})`);
      }
    };
    kinds('object storage', 'storage', 'storage', h.storage.state());
    kinds('WebSocket', 'ws', 'websocket', h.ws.state());
    kinds('search engine', 'search', 'search', h.search.state());
    kinds('gateway', 'gateway', 'gateways', h.gateways.state());
    kinds('WhatsApp', 'whatsapp', 'gateways', h.whatsapp.state());
    const mail = h.mail.state();
    out.push(`mail — Mail catcher (SMTP :${mail.port}) ${mail.running ? 'running' : 'stopped'}, ${mail.count} mails`);
    return out;
  }

  /** Public shares (Expose) that are live. */
  private shareLines(): string[] {
    return this.herd.expose.state().shares.filter((x) => x.status !== 'stopped').map((x) => `${x.id}: ${x.domain} → ${x.url ?? '(starting)'} via ${x.provider} (${x.status})`);
  }

  // ---------------------------------------------------------------- Ask DevCatz (⌘K)

  private askParts(req: AiAskRequest): { system: string; turns: AiTurn[] } {
    const sites = this.herd.sites().map((c) => {
      const p = this.herd.state(c);
      const links = [p.dbService && `database ${p.dbService}`, c.storageService && `storage ${c.storageService}`, c.searchEngine && `search ${c.searchEngine}`, c.wsServer && `WebSocket ${c.wsServer}`].filter(Boolean).join(', ');
      const switches = SITE_SWITCHES.filter((k) => c[k]).join(', ');
      return `${p.id}: "${p.name}" ${p.domain} — ${p.stack.runtime}${p.stack.apps[0] ? ` ${p.stack.apps[0].library ?? p.stack.apps[0].framework}` : ''}, ${p.status}${p.worktreeOf ? `, worktree of ${p.worktreeOf}` : ''}${links ? `; uses ${links}` : ''}${switches ? `; on: ${switches}` : ''}`;
    });
    const shares = this.shareLines();
    const system = [
      'You are the command line of DevCatz, a local development environment for macOS. The user says in plain words what they want; you answer with DevCatz actions that do it (the user confirms each), or just answer when it is a question.',
      'DevCatz pages: Projects (sites: dev servers, .env, database, Git, Docker, logs), Runtimes (PHP, Python, Node.js, Bun, Go versions and PHP extensions), Database (MySQL, MariaDB, PostgreSQL, Redis … services), Storage (S3: RustFS, MinIO, SeaweedFS), WebSocket (Reverb, Sockudo, Centrifugo, Mercure, NATS), Search (Meilisearch, Typesense, OpenSearch, Manticore, ZincSearch, Sonic), Git (accounts, repositories, SSH keys), Mail (catches every mail sites send), Gateways (WhatsApp GOWA / WAHA, Stalwart, Postal, ntfy, Gotify, Jasmin SMS, Telegram), Expose (public URLs), Monitoring, Settings.',
      '- Removing things (uninstall a service, delete data) only ever goes through service-uninstall, which opens a confirmation dialog; never say something was removed.',
      '- Use the site ids and service refs below; set "site" on every site action. Order actions as they should run (start a service before the site that needs it).',
      '- When the request is unclear or impossible with these actions, say so in explanation and return no actions. Never invent sites, services or versions.',
      '- explanation: one or two sentences — what will happen, or the answer.',
      LANG,
      ...ACTION_HELP,
      '',
      `Sites:\n${sites.join('\n') || '(none)'}`,
      `Services:\n${this.serviceLines().join('\n')}`,
      `Public shares (Expose):\n${shares.join('\n') || '(none)'}`,
      `Installed: Node ${this.herd.nodeVersions().join(', ') || '-'}; PHP ${this.herd.phpVersions().join(', ') || '-'}.`,
    ].join('\n');
    return { system, turns: [...(req.history ?? []).slice(-8), { role: 'user', text: req.prompt.trim() }] };
  }

  previewAsk(req: AiAskRequest): AiPreview {
    needFeature('ask');
    const { system, turns } = this.askParts(req);
    return this.client.preview(system, turns);
  }

  async ask(req: AiAskRequest, token = ''): Promise<AiAskAnswer> {
    needFeature('ask');
    if (!req.prompt.trim()) throw new Error('Say what DevCatz should do');
    const { system, turns } = this.askParts(req);
    const a = await this.client.run<AiAskAnswer>(system, turns, ASK_SCHEMA, token);
    return { explanation: String(a.explanation ?? ''), actions: this.cleanActions(a.actions, null) };
  }

  // ---------------------------------------------------------------- actions

  /** Keeps well-formed actions only; the site defaults to the current one. */
  private cleanActions(list: unknown, siteId: string | null): AiAction[] {
    if (!Array.isArray(list)) return [];
    return list
      .filter((a): a is AiAction => !!a && typeof a === 'object' && ACTION_KINDS.includes((a as AiAction).kind))
      .map((a) => ({ kind: a.kind, label: String(a.label || a.kind).slice(0, 120), site: (a.site && this.herd.find(a.site) ? a.site : siteId) ?? undefined, args: Object.fromEntries(Object.entries(a.args ?? {}).filter(([, v]) => v !== '' && v !== null && v !== undefined).map(([k, v]) => [k, String(v)])) }))
      .slice(0, 6);
  }

  /** A service ref from serviceLines (db:<id>, storage:<kind>, ws:…, search:…, gateway:…, whatsapp:…, mail; a bare id = database). */
  private service(ref: string): { name: string; run: (act: StorageAction) => Promise<void> } {
    const h = this.herd;
    const [scope, id] = ref.includes(':') ? [ref.slice(0, ref.indexOf(':')), ref.slice(ref.indexOf(':') + 1)] : ref === 'mail' ? ['mail', ''] : ['db', ref];
    const pick = <T extends { name: string; installed: boolean }>(list: T[], key: (x: T) => string, run: (k: never, act: StorageAction) => Promise<void>) => {
      const x = list.find((s) => key(s) === id);
      if (!x) throw new Error(`No such service: ${ref}`);
      if (!x.installed) throw new Error(`${x.name} is not installed`);
      return { name: x.name, run: (act: StorageAction) => run(key(x) as never, act) };
    };
    switch (scope) {
      case 'db': {
        const d = h.dbs.list().find((x) => x.id === id);
        if (!d) throw new Error(`No such database service: ${id}`);
        return { name: d.name, run: (act) => h.dbs.action(d.id, act) };
      }
      case 'storage':
        return pick(h.storage.state(), (x) => x.kind, (k, act) => h.storage.action(k, act));
      case 'ws':
        return pick(h.ws.state(), (x) => x.kind, (k, act) => h.ws.action(k, act));
      case 'search':
        return pick(h.search.state(), (x) => x.kind, (k, act) => h.search.action(k, act));
      case 'gateway':
        return pick(h.gateways.state(), (x) => x.kind, (k, act) => h.gateways.action(k, act));
      case 'whatsapp':
        return pick(h.whatsapp.state(), (x) => x.engine, (k, act) => h.whatsapp.action(k, act));
      case 'mail':
        return { name: 'Mail', run: (act) => (act === 'start' ? h.mail.start() : act === 'stop' ? h.mail.stop() : h.mail.restart()) };
    }
    throw new Error(`No such service: ${ref}`);
  }

  /** Runs one action after the user clicked it; every argument is checked against what DevCatz knows. */
  async runAction(siteId: string | null, a: AiAction): Promise<string> {
    const id = a.site || siteId;
    const p = id ? this.herd.find(id) : undefined;
    const needSite = () => {
      if (!p) throw new Error('No such site');
      return p;
    };
    const arg = (k: string) => String(a.args?.[k] ?? '').trim();
    switch (a.kind) {
      case 'site-start':
        await this.herd.start(needSite().id);
        return `${needSite().name} started`;
      case 'site-stop':
        await this.herd.stop(needSite().id);
        return `${needSite().name} stopped`;
      case 'site-restart':
        await this.herd.restart(needSite().id);
        return `${needSite().name} restarted`;
      case 'install-deps':
        await this.herd.installDeps(needSite().id);
        return `Dependencies of ${needSite().name} installed`;
      case 'php-extension': {
        const version = arg('version') || this.herd.phpChoice(needSite()).version || '';
        if (!this.herd.phpVersions().some((v) => v === version || v.startsWith(`${version}.`))) throw new Error(`PHP ${version || '?'} is not installed`);
        const full = this.herd.phpVersions().find((v) => v === version || v.startsWith(`${version}.`))!;
        const ext = arg('extension').toLowerCase();
        if (!/^[a-z][a-z0-9_-]{1,40}$/.test(ext)) throw new Error('Invalid extension name');
        await this.herd.phpExtInstall(full, ext);
        return `Installing ${ext} for PHP ${full} (Runtimes → PHP shows the progress)`;
      }
      case 'set-node-version':
      case 'set-php-version':
      case 'set-python-version': {
        const v = arg('version');
        const list = a.kind === 'set-node-version' ? this.herd.nodeVersions() : a.kind === 'set-php-version' ? this.herd.phpVersions() : this.herd.pythonVersions();
        const hit = list.find((x) => x === v || x.startsWith(`${v}.`));
        if (!hit) throw new Error(`Version ${v} is not installed (Runtimes)`);
        this.herd.update(needSite().id, a.kind === 'set-node-version' ? { nodeVersion: hit } : a.kind === 'set-php-version' ? { phpVersion: hit } : { pythonVersion: hit });
        return `${needSite().name} now uses ${hit}`;
      }
      case 'db-task': {
        const task = arg('task') as DbAction;
        if (!['artisan-migrate', 'artisan-fresh', 'artisan-seed', 'migrate', 'generate', 'seed'].includes(task)) throw new Error('Unknown database task');
        await this.herd.db(needSite().id, task);
        return `${task} done`;
      }
      case 'stack-task': {
        const task = this.herd.state(needSite()).stack.tasks?.find((t) => t.id === arg('task'));
        if (!task) throw new Error('Unknown task');
        if (task.needsName) throw new Error(`${task.label} needs a name: run it from the Database tab`);
        await this.herd.stackTask(needSite().id, task.id);
        return `${task.tool} ${task.label} done`;
      }
      case 'service-start':
      case 'service-stop':
      case 'service-restart': {
        const act = a.kind === 'service-start' ? 'start' : a.kind === 'service-stop' ? 'stop' : 'restart';
        const svc = this.service(arg('service'));
        await svc.run(act);
        return `${svc.name} ${act === 'start' ? 'started' : act === 'stop' ? 'stopped' : 'restarted'}`;
      }
      case 'service-uninstall': {
        // Only opens the page's uninstall dialog: the typed confirmation there (and in the main process) stays the gate.
        const ref = arg('service');
        if (ref === 'mail') throw new Error('Mail is built in and cannot be uninstalled');
        this.service(ref);
        return `uninstall:${ref.includes(':') ? ref : `db:${ref}`}`;
      }
      case 'expose-start': {
        const share = await this.herd.expose.start({ siteId: needSite().id });
        return `${needSite().name} is shared${share.url ? ` at ${share.url}` : ' (the URL shows in Expose)'}`;
      }
      case 'expose-stop': {
        const share = this.herd.expose.state().shares.find((x) => x.id === arg('share') || (p && x.siteId === p.id && x.status !== 'stopped'));
        if (!share) throw new Error('No such share');
        await this.herd.expose.stop(share.id);
        return `Stopped sharing ${share.domain}`;
      }
      case 'site-setting': {
        const key = arg('key');
        const value = arg('value');
        const site = needSite();
        if ((SITE_SWITCHES as readonly string[]).includes(key)) {
          if (!/^(true|false)$/.test(value)) throw new Error(`${key} takes true or false`);
          this.herd.update(site.id, { [key]: value === 'true' });
          return `${site.name}: ${key} ${value === 'true' ? 'on' : 'off'}`;
        }
        if (!(SITE_LINKS as readonly string[]).includes(key)) throw new Error('DevCatz does not change that setting for you');
        if (value) {
          const known =
            key === 'dbService' ? this.herd.dbs.list().some((d) => d.id === value)
            : key === 'storageService' ? this.herd.storage.state().some((x) => x.installed && x.kind === value)
            : key === 'searchEngine' ? this.herd.search.state().some((x) => x.installed && x.kind === value)
            : this.herd.ws.state().some((x) => x.installed && x.kind === value);
          if (!known) throw new Error(`${value} is not an installed service`);
        }
        this.herd.update(site.id, { [key]: value || undefined });
        return `${site.name}: ${key} ${value ? `→ ${value}` : 'unlinked'}`;
      }
      case 'env-set': {
        const key = arg('key');
        const file = arg('file') || '.env';
        if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(key) || SECRET_KEY.test(key)) throw new Error('DevCatz does not write that key for you');
        if (!/^\.env[\w.-]*$/.test(file.split('/').pop() ?? '')) throw new Error('Only .env files');
        this.herd.envMerge(needSite().id, file, { [key]: arg('value') }, 'Set by DevCatz (AI suggestion)', true);
        return `${key} written to ${file}`;
      }
      case 'open-tab':
        return `open:${arg('tab')}`;
      case 'open-dbcatz': {
        // The window shows this step as an Open in DBCatz button (it installs DBCatz when missing); this is the same open.
        const ref = arg('service');
        const id = ref.startsWith('db:') ? ref.slice(3) : ref;
        const d = this.herd.dbs.list().find((x) => x.id === id);
        if (!d) throw new Error(`No such database service: ${ref || '?'}`);
        const ok = await this.herd.dbcatz.open(`svc:${d.id}`, arg('database') || undefined);
        if (!ok) throw new Error('DBCatz is not installed: use Open in DBCatz to install it');
        return `DBCatz opened at ${d.name}${arg('database') ? ` › ${arg('database')}` : ''}`;
      }
      case 'open-section': {
        const section = arg('section');
        if (!SECTIONS.includes(section)) throw new Error('Unknown page');
        return `section:${section}${arg('item') ? `:${arg('item')}` : ''}`;
      }
    }
    throw new Error('Unknown action');
  }
}
