import { spawn } from 'node:child_process';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import type { GitBranch, GitCommit, GitFile, GitStash, GitStatus, GitSummary, GitTag } from '@shared/types';
import { getShellEnv } from './env';
import { dataDir } from './store';

/**
 * Git for sites, with the user's own `git` binary and configuration
 * (credential helpers, SSH keys, hooks). Nothing ever waits on a terminal
 * prompt: GIT_TERMINAL_PROMPT=0, SSH in batch mode, and HTTPS passwords come
 * from a connected account through a tiny GIT_ASKPASS script when the user's
 * own helper has none.
 */

const US = '\x1f';
const RS = '\x1e';

/** Credentials for one HTTPS remote (from a connected account). */
export interface GitCreds {
  username: string;
  token: string;
}

/** Answers git's "Username for …" / "Password for …" from the environment (never written to disk). */
function askpass(): string {
  const dir = dataDir('git');
  const file = join(dir, 'askpass.sh');
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '#!/bin/sh\ncase "$1" in\n  Username*) printf \'%s\\n\' "$DEVCATZ_GIT_USERNAME" ;;\n  *) printf \'%s\\n\' "$DEVCATZ_GIT_TOKEN" ;;\nesac\n');
    chmodSync(file, 0o700);
  }
  return file;
}

export function gitEnv(creds?: GitCreds | null): Record<string, string> {
  return {
    GIT_TERMINAL_PROMPT: '0',
    // Accept a new host's key once (like a first `ssh` would after "yes"), never prompt.
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new',
    LC_ALL: 'C',
    ...(creds ? { GIT_ASKPASS: askpass(), SSH_ASKPASS: askpass(), DEVCATZ_GIT_USERNAME: creds.username, DEVCATZ_GIT_TOKEN: creds.token } : {}),
  };
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs git with arguments (no shell) and collects its output. */
export function git(cwd: string, args: string[], opts: { env?: Record<string, string>; input?: string; timeout?: number; maxBytes?: number } = {}): Promise<GitResult> {
  return new Promise((done) => {
    const child = spawn('git', args, { cwd, env: { ...getShellEnv(), ...gitEnv(), ...opts.env } as NodeJS.ProcessEnv, stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    const max = opts.maxBytes ?? 32 * 1024 * 1024;
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size <= max) out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => err.push(d));
    const timer = setTimeout(() => child.kill('SIGTERM'), opts.timeout ?? 60_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      done({ code: 127, stdout: '', stderr: e.message.includes('ENOENT') ? 'git is not installed (xcode-select --install)' : e.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      done({ code: code ?? 1, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') });
    });
    if (opts.input !== undefined) child.stdin.end(opts.input);
    else child.stdin.end();
  });
}

/** git, throwing its last error lines when it fails. */
export async function gitOk(cwd: string, args: string[], opts: Parameters<typeof git>[2] = {}): Promise<string> {
  const r = await git(cwd, args, opts);
  if (r.code !== 0) throw new Error(cleanError(r.stderr || r.stdout) || `git ${args[0]} failed (exit ${r.code})`);
  return r.stdout;
}

const cleanError = (s: string) => {
  // Conflicts: name the files instead of git's advice text.
  const conflicts = [...s.matchAll(/CONFLICT \([^)]+\): (?:Merge conflict in )?(.+)/g)].map((m) => m[1].trim());
  if (conflicts.length) return `Conflict in ${conflicts.join(', ')}: fix the file${conflicts.length === 1 ? '' : 's'}, mark resolved, then continue`;
  if (/both modified|unmerged/i.test(s)) return 'Conflicts: fix the files marked with <<<<<<< / >>>>>>>, then mark them resolved';
  return s
    .split('\n')
    .map((l) => l.replace(/^(fatal|error): /, '').trim())
    .filter((l) => l && !l.startsWith('hint:'))
    .slice(-4)
    .join(' ');
};

/**
 * Streams a long git command (fetch / pull / push / clone) line by line;
 * progress lines (\r) are passed with `progress = true`. Resolves with the exit
 * code; `signal` kills it.
 */
export function gitStream(
  cwd: string,
  args: string[],
  log: (line: string, progress: boolean) => void,
  opts: { env?: Record<string, string>; signal?: AbortSignal } = {},
): Promise<number> {
  return new Promise((done) => {
    const child = spawn('git', args, { cwd, env: { ...getShellEnv(), ...gitEnv(), ...opts.env } as NodeJS.ProcessEnv, stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => child.kill('SIGTERM');
    opts.signal?.addEventListener('abort', onAbort);
    const feed = (d: Buffer) => {
      const text = d.toString('utf8');
      // "Receiving objects:  42% (…)\r" repeats on one line.
      for (const part of text.split(/(?<=[\r\n])/)) {
        const line = part.replace(/[\r\n]+$/, '');
        if (line.trim()) log(line, part.endsWith('\r'));
      }
    };
    child.stdout.on('data', feed);
    child.stderr.on('data', feed);
    child.on('error', (e) => {
      log(e.message, false);
      done(127);
    });
    child.on('close', (code) => {
      opts.signal?.removeEventListener('abort', onAbort);
      done(code ?? 1);
    });
  });
}

export async function gitVersion(): Promise<string | null> {
  const r = await git(process.cwd(), ['--version'], { timeout: 10_000 });
  return r.code === 0 ? (r.stdout.match(/git version (\S+)/)?.[1] ?? null) : null;
}

/** Top of the repository the folder is in, or null. */
export async function repoRoot(dir: string): Promise<string | null> {
  if (!existsSync(dir)) return null;
  const r = await git(dir, ['rev-parse', '--show-toplevel'], { timeout: 10_000 });
  const root = r.code === 0 ? r.stdout.trim() : null;
  // A repository at the home folder (a stray `git init ~`) is not the site's: every site would look changed.
  return root && resolve(root) !== resolve(homedir()) ? root : null;
}

async function gitDir(root: string): Promise<string> {
  return resolve(root, (await gitOk(root, ['rev-parse', '--git-dir'])).trim());
}

function operationOf(dir: string): GitSummary['operation'] {
  if (existsSync(join(dir, 'rebase-merge')) || existsSync(join(dir, 'rebase-apply'))) return 'rebase';
  if (existsSync(join(dir, 'MERGE_HEAD'))) return 'merge';
  if (existsSync(join(dir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (existsSync(join(dir, 'REVERT_HEAD'))) return 'revert';
  return null;
}

/** Porcelain v2 status (-z) → summary + files. */
function parseStatus(text: string): { summary: Omit<GitSummary, 'operation'>; head: string | null; stashes: number; files: GitFile[] } {
  const summary = { branch: null as string | null, detached: false, upstream: null as string | null, ahead: 0, behind: 0, changed: 0, conflicts: 0 };
  let head: string | null = null;
  let stashes = 0;
  const files: GitFile[] = [];
  const parts = text.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const line = parts[i];
    if (!line) continue;
    if (line.startsWith('# ')) {
      const [, key, ...rest] = line.split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') head = value === '(initial)' ? null : value;
      else if (key === 'branch.head') {
        summary.detached = value === '(detached)';
        summary.branch = summary.detached ? null : value;
      } else if (key === 'branch.upstream') summary.upstream = value;
      else if (key === 'branch.ab') {
        const m = value.match(/\+(\d+) -(\d+)/);
        if (m) [summary.ahead, summary.behind] = [Number(m[1]), Number(m[2])];
      } else if (key === 'stash') stashes = Number(value) || 0;
      continue;
    }
    const kind = line[0];
    if (kind === '?') {
      files.push({ path: line.slice(2), from: null, index: '?', worktree: '?', staged: false, unstaged: true, untracked: true, conflict: false });
    } else if (kind === '1' || kind === '2') {
      const f = line.split(' ');
      const xy = f[1];
      const path = f.slice(kind === '1' ? 8 : 9).join(' ');
      const from = kind === '2' ? (parts[++i] ?? null) : null;
      files.push({ path, from, index: xy[0], worktree: xy[1], staged: xy[0] !== '.', unstaged: xy[1] !== '.', untracked: false, conflict: false });
    } else if (kind === 'u') {
      const f = line.split(' ');
      files.push({ path: f.slice(10).join(' '), from: null, index: f[1][0], worktree: f[1][1], staged: false, unstaged: true, untracked: false, conflict: true });
    }
  }
  summary.changed = files.length;
  summary.conflicts = files.filter((f) => f.conflict).length;
  return { summary, head, stashes, files };
}

/** Cheap summary for every site (sidebar badges): one `git status` without taking the index lock. */
export async function summary(dir: string): Promise<GitSummary | null> {
  if (!(await repoRoot(dir))) return null;
  // `-- .`: a site inside a bigger repository (a monorepo of demos) counts only its own folder.
  const r = await git(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal', '--', '.'], { timeout: 15_000 });
  if (r.code !== 0) return null;
  const s = parseStatus(r.stdout);
  const gd = await git(dir, ['rev-parse', '--git-dir'], { timeout: 5_000 });
  return { ...s.summary, operation: gd.code === 0 ? operationOf(resolve(dir, gd.stdout.trim())) : null };
}

export async function status(dir: string): Promise<Omit<GitStatus, 'remotes'> & { remoteUrls: { name: string; url: string }[] }> {
  const root = (await repoRoot(dir)) ?? dir;
  const [st, remotes, name, email, last] = await Promise.all([
    // Only the site's folder when it sits inside a bigger repository.
    gitOk(dir, ['--no-optional-locks', 'status', '--porcelain=v2', '--branch', '--show-stash', '-z', '--untracked-files=all', '--', '.']),
    git(root, ['remote', '-v']),
    git(root, ['config', 'user.name']),
    git(root, ['config', 'user.email']),
    log(root, '', 0, 1).catch(() => []),
  ]);
  const s = parseStatus(st);
  const remoteUrls = [...new Map(remotes.stdout.split('\n').map((l) => l.match(/^(\S+)\s+(\S+)\s+\(fetch\)/)).filter(Boolean).map((m) => [m![1], { name: m![1], url: m![2] }])).values()];
  return {
    ...s.summary,
    operation: operationOf(await gitDir(root)),
    root,
    head: s.head,
    files: s.files,
    remoteUrls,
    stashes: s.stashes,
    identity: { name: name.stdout.trim() || null, email: email.stdout.trim() || null },
    last: last[0] ?? null,
  };
}

/** A path inside the repository (no escaping it with ../ or an absolute path). */
export function inside(root: string, file: string): string {
  const abs = resolve(root, file);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error(`${file} is outside the repository`);
  return relative(root, abs);
}

export async function diff(root: string, file: string, staged: boolean): Promise<string> {
  const f = inside(root, file);
  const tracked = (await git(root, ['ls-files', '--error-unmatch', '--', f])).code === 0;
  const args = !tracked
    ? ['diff', '--no-color', '--no-ext-diff', '--no-index', '--', '/dev/null', f]
    : ['diff', '--no-color', '--no-ext-diff', ...(staged ? ['--cached'] : []), '--', f];
  const r = await git(root, args, { maxBytes: 600_000 });
  // --no-index exits 1 when the files differ.
  if (r.code > 1) throw new Error(cleanError(r.stderr));
  return r.stdout.length >= 600_000 ? `${r.stdout.slice(0, 600_000)}\n… (diff cut at 600 KB)` : r.stdout;
}

const LOG_FORMAT = ['%H', '%h', '%P', '%an', '%ae', '%aI', '%s', '%D'].join('%x1f') + '%x1e';
function parseLog(text: string): GitCommit[] {
  return text
    .split(RS)
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [sha, short, parents, author, email, date, subject, refs] = r.split(US);
      return {
        sha,
        short,
        parents: parents ? parents.split(' ') : [],
        author,
        email,
        date,
        subject,
        refs: refs ? refs.split(', ').filter((x) => x && x !== 'HEAD') : [],
      };
    });
}

/** History of the current branch; `search` matches the message, the author or a commit id. */
export async function log(root: string, search: string, skip: number, limit = 100, ref?: string): Promise<GitCommit[]> {
  const base = ['log', `--format=${LOG_FORMAT}`, `--max-count=${limit}`, `--skip=${Math.max(0, skip)}`];
  // The branch (if any) after the options, then -- so it is never read as a path.
  const tail = [...(ref ? [ref] : []), '--'];
  const q = search.trim();
  if (!q) return parseLog(await gitOk(root, [...base, ...tail]));
  if (/^[0-9a-f]{4,40}$/i.test(q)) {
    const one = await git(root, ['log', `--format=${LOG_FORMAT}`, '-1', q]);
    if (one.code === 0) return parseLog(one.stdout);
  }
  const [byMsg, byAuthor] = await Promise.all([
    gitOk(root, [...base, '-i', `--grep=${q}`, '--fixed-strings', ...tail]),
    gitOk(root, [...base, '-i', `--author=${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, ...tail]),
  ]);
  const seen = new Map<string, GitCommit>();
  for (const c of [...parseLog(byMsg), ...parseLog(byAuthor)]) seen.set(c.sha, c);
  return [...seen.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, limit);
}

export async function show(root: string, sha: string): Promise<string> {
  if (!/^[0-9a-f]{4,40}$/i.test(sha)) throw new Error('Not a commit id');
  const r = await git(root, ['show', '--no-color', '--no-ext-diff', '--stat', '--patch', '--format=fuller', sha], { maxBytes: 800_000 });
  if (r.code !== 0) throw new Error(cleanError(r.stderr));
  return r.stdout.length >= 800_000 ? `${r.stdout.slice(0, 800_000)}\n… (cut at 800 KB)` : r.stdout;
}

export async function branches(root: string): Promise<GitBranch[]> {
  const fmt = ['%(refname)', '%(refname:short)', '%(upstream:short)', '%(upstream:track,nobracket)', '%(objectname:short)', '%(subject)', '%(committerdate:iso-strict)', '%(HEAD)'].join('%1f');
  const out = await gitOk(root, ['for-each-ref', `--format=${fmt}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, name, upstream, track, sha, subject, date, head] = l.split(US);
      return {
        name,
        remote: ref.startsWith('refs/remotes/'),
        current: head === '*',
        upstream: upstream || null,
        ahead: Number(track?.match(/ahead (\d+)/)?.[1] ?? 0),
        behind: Number(track?.match(/behind (\d+)/)?.[1] ?? 0),
        sha,
        subject,
        date,
      };
    })
    .filter((b) => !(b.remote && b.name.endsWith('/HEAD')) && b.name !== 'origin');
}

export async function stashes(root: string): Promise<GitStash[]> {
  const out = await gitOk(root, ['stash', 'list', `--format=%gd${'%x1f'}%gs${'%x1f'}%cI`]);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, message, date] = l.split(US);
      return { ref, message, date };
    });
}

export async function tags(root: string): Promise<GitTag[]> {
  const out = await gitOk(root, ['for-each-ref', '--sort=-creatordate', `--format=${['%(refname:short)', '%(objectname:short)', '%(creatordate:iso-strict)', '%(subject)'].join('%1f')}`, 'refs/tags']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, sha, date, subject] = l.split(US);
      return { name, sha, date, subject };
    });
}

/** A branch / tag name git accepts (no option-looking names). */
export async function checkRefName(root: string, name: string, kind: 'branch' | 'tag' = 'branch'): Promise<string> {
  const n = name.trim();
  if (!n || n.startsWith('-')) throw new Error('Enter a name');
  const r = await git(root, ['check-ref-format', kind === 'branch' ? '--branch' : '--allow-onelevel', kind === 'branch' ? n : `refs/tags/${n}`]);
  if (r.code !== 0) throw new Error(`"${n}" is not a valid ${kind} name`);
  return n;
}

/** Remote URL → host, owner (may contain subgroups), repo. */
export function parseRemote(url: string): { host: string; owner: string; repo: string; https: boolean } | null {
  const u = url.trim();
  let host: string;
  let path: string;
  let https = false;
  const scp = u.match(/^(?:[\w.-]+@)?([\w.-]+):(?!\/\/)(.+)$/);
  if (/^[a-z+]+:\/\//i.test(u)) {
    try {
      const x = new URL(u);
      host = x.hostname;
      path = x.pathname;
      https = x.protocol === 'https:' || x.protocol === 'http:';
    } catch {
      return null;
    }
  } else if (scp) {
    host = scp[1];
    path = scp[2];
  } else return null;
  const segs = path.replace(/^\/+|\/+$/g, '').replace(/\.git$/, '').split('/').filter(Boolean);
  // Bitbucket Server: /scm/<project>/<repo>
  if (segs[0] === 'scm' && segs.length === 3) segs.shift();
  if (segs.length < 2) return null;
  return { host: host.toLowerCase(), owner: segs.slice(0, -1).join('/'), repo: segs.at(-1)!, https };
}

/** .gitignore lines that fit the stack and are missing (and not ignored already). */
export async function ignoreSuggestions(root: string, runtimes: string[]): Promise<string[]> {
  const wanted = ['.DS_Store', '.env', '.env.*.local', '*.log'];
  const has = (f: string) => existsSync(join(root, f));
  if (has('package.json')) wanted.push('node_modules/', 'dist/', '.output/', '.nuxt/', '.next/', '.astro/', '.vite/', '.turbo/', 'coverage/');
  if (has('composer.json')) wanted.push('/vendor/', '/public/hot', '/public/build/', '/storage/*.key', '.phpunit.result.cache');
  if (has('artisan')) wanted.push('/storage/logs/*.log', '/bootstrap/cache/*.php');
  if (runtimes.includes('python') || has('pyproject.toml') || has('requirements.txt')) wanted.push('.venv/', '__pycache__/', '*.pyc', '.pytest_cache/', '.mypy_cache/', '.ruff_cache/');
  if (runtimes.includes('go') || has('go.mod')) wanted.push('/bin/', '*.test', 'tmp/');
  wanted.push('.idea/', '.vscode/*', '!.vscode/extensions.json');
  const current = existsSync(join(root, '.gitignore')) ? readFileSync(join(root, '.gitignore'), 'utf8').split('\n').map((l) => l.trim()) : [];
  const missing = [...new Set(wanted)].filter((w) => !current.includes(w));
  // Keep only patterns that would change something (git check-ignore on a sample path).
  const out: string[] = [];
  for (const w of missing) {
    if (w.startsWith('!') || w.includes('*')) {
      out.push(w);
      continue;
    }
    const sample = w.replace(/^\//, '').replace(/\/$/, '/x');
    const r = await git(root, ['check-ignore', '-q', '--no-index', sample]);
    if (r.code !== 0) out.push(w);
  }
  return out;
}

export function addIgnore(root: string, lines: string[]): void {
  const clean = lines.map((l) => l.trim()).filter((l) => l && !/[\n\r]/.test(l));
  if (!clean.length) return;
  const file = join(root, '.gitignore');
  const cur = existsSync(file) ? readFileSync(file, 'utf8') : '';
  appendFileSync(file, `${cur && !cur.endsWith('\n') ? '\n' : ''}${cur ? '\n' : ''}# Added by DevCatz\n${clean.join('\n')}\n`);
}

// ------------------------------------------------------------ clone

export interface CloneOptions {
  url: string;
  dest: string;
  branch: string;
  shallow: boolean;
  creds: GitCreds | null;
  log: (line: string, progress: boolean) => void;
  signal: AbortSignal;
}

/** Clones into `dest` (which must not exist); a failed or cancelled clone leaves nothing behind. */
export async function clone(o: CloneOptions): Promise<void> {
  if (existsSync(o.dest)) throw new Error(`${o.dest} already exists`);
  const parent = resolve(o.dest, '..');
  mkdirSync(parent, { recursive: true });
  try {
    const args = ['clone', '--progress', ...(o.branch ? ['--branch', o.branch] : []), ...(o.shallow ? ['--depth', '1', '--no-single-branch'] : []), '--', o.url, o.dest];
    const code = await gitStream(parent, args, o.log, { env: gitEnv(o.creds), signal: o.signal });
    if (o.signal.aborted) throw new Error('Clone cancelled');
    if (code !== 0) throw new Error(`git clone failed (exit ${code}); see the output above`);
  } catch (err) {
    rmSync(o.dest, { recursive: true, force: true });
    throw err;
  }
}

// ---------------------------------------------------------------- worktrees

export interface WorktreeEntry {
  path: string;
  branch: string | null;
  head: string | null;
  main: boolean;
  locked: boolean;
  prunable: boolean;
}

/** `git worktree list --porcelain`: the main working tree first, then the linked ones. */
export async function worktrees(root: string): Promise<WorktreeEntry[]> {
  const out = await gitOk(root, ['worktree', 'list', '--porcelain'], { timeout: 10_000 });
  const list: WorktreeEntry[] = [];
  const bare = new Set<WorktreeEntry>();
  let cur: WorktreeEntry | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), branch: null, head: null, main: list.length === 0, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') bare.add(cur);
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  // A bare repository's own entry has no files to serve.
  return list.filter((w) => !bare.has(w));
}

/**
 * Adds a worktree at `dest` (which must not exist): a new branch made from `from` (default HEAD), or an existing
 * one — a branch that only exists on a remote is checked out tracking it (git's own guess).
 */
export async function worktreeAdd(root: string, dest: string, branch: string, create: boolean, from?: string): Promise<void> {
  if (existsSync(dest)) throw new Error(`${dest} already exists`);
  mkdirSync(resolve(dest, '..'), { recursive: true });
  const args = create ? ['worktree', 'add', '-b', branch, '--', dest, ...(from ? [from] : [])] : ['worktree', 'add', '--', dest, branch];
  await gitOk(root, args, { timeout: 120_000 });
}

/** Removes a linked worktree; `force` also throws away its changes and untracked files. */
export async function worktreeRemove(root: string, path: string, force: boolean): Promise<void> {
  await gitOk(root, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path], { timeout: 60_000 });
}

/**
 * Commits that would be lost with the worktree's branch: those not on its upstream, or — without one — those on
 * no other branch and no remote (a branch made from main and never committed to has none).
 */
export async function unpushed(dir: string): Promise<number> {
  const up = await git(dir, ['rev-list', '--count', '@{upstream}..HEAD'], { timeout: 10_000 });
  if (up.code === 0) return Number(up.stdout.trim()) || 0;
  const head = (await git(dir, ['symbolic-ref', '-q', 'HEAD'], { timeout: 5_000 })).stdout.trim();
  // --exclude patterns for --branches go without the refs/heads/ prefix.
  const args = ['rev-list', '--count', 'HEAD', '--not', ...(head ? [`--exclude=${head.replace(/^refs\/heads\//, '')}`] : []), '--branches', '--remotes'];
  const only = await git(dir, args, { timeout: 10_000 });
  return only.code === 0 ? Number(only.stdout.trim()) || 0 : 0;
}

/** Drops the records of worktrees whose folder is gone. */
export async function worktreePrune(root: string): Promise<void> {
  await gitOk(root, ['worktree', 'prune'], { timeout: 30_000 });
}
