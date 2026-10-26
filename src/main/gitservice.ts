import { existsSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GitCloneTask, GitPull, GitRemote, GitState, GitStatus, GitSummary, GitSyncAction, ProjectConfig } from '@shared/types';
import * as g from './git';
import * as hosts from './githosts';

/**
 * Git per site: a summary for every site (sidebar badges, refreshed every
 * 20 s and after each operation), the operations behind the Git tab, pull
 * requests through connected accounts, and New Site → Clone.
 */
export interface GitHooks {
  projects(): ProjectConfig[];
  project(id: string): ProjectConfig;
  /** A line in the site's Logs tab. */
  log(id: string, text: string): void;
  /** Site busy label (shared with dependency / database tasks). */
  busy: Map<string, string>;
  changed(): void;
  runtimes(id: string): string[];
  openFile(path: string): Promise<void>;
  /** After each round of summaries (new worktrees are looked for then). */
  polled?(): void;
}

const SHA = /^[0-9a-f]{4,40}$/i;

export class GitService {
  readonly summaries = new Map<string, GitSummary | null>();
  version: string | null = null;
  private clone: GitCloneTask | null = null;
  private cloneAbort: AbortController | null = null;
  private aborts = new Map<string, AbortController>();
  private polling = false;

  constructor(private h: GitHooks) {
    void g.gitVersion().then((v) => {
      this.version = v;
      this.h.changed();
    });
    setTimeout(() => void this.pollAll(), 3_000);
    setInterval(() => void this.pollAll(), 20_000);
  }

  state(): GitState {
    return { version: this.version, accounts: hosts.listAccounts(), clone: this.clone, cloneDir: this.cloneDir() };
  }

  /** The folder most sites live in (new clones go next to them), else ~/Sites. */
  cloneDir(): string {
    const count = new Map<string, number>();
    for (const p of this.h.projects()) count.set(dirname(p.path), (count.get(dirname(p.path)) ?? 0) + 1);
    return [...count.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? join(homedir(), 'Sites');
  }

  private async pollAll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    let changed = false;
    try {
      for (const p of this.h.projects()) {
        const s = existsSync(p.path) ? await g.summary(p.path).catch(() => null) : null;
        if (JSON.stringify(s) !== JSON.stringify(this.summaries.get(p.id) ?? null)) changed = true;
        this.summaries.set(p.id, s);
      }
    } finally {
      this.polling = false;
    }
    if (changed) this.h.changed();
    this.h.polled?.();
  }

  /** Re-reads one site's summary (after an operation). */
  async refresh(id: string): Promise<void> {
    const p = this.h.project(id);
    this.summaries.set(id, await g.summary(p.path).catch(() => null));
    this.h.changed();
  }

  private async root(id: string): Promise<string> {
    const root = await g.repoRoot(this.h.project(id).path);
    if (!root) throw new Error('Not a Git repository');
    return root;
  }

  /** Runs a short git command in the site's repository, then refreshes its summary. */
  private async op(id: string, args: string[], opts: Parameters<typeof g.git>[2] = {}): Promise<string> {
    if (this.h.busy.has(id)) throw new Error(`Busy: ${this.h.busy.get(id)}`);
    const root = await this.root(id);
    try {
      return await g.gitOk(root, args, { ...opts, env: { GIT_EDITOR: 'true', ...opts.env } });
    } finally {
      void this.refresh(id);
    }
  }

  private remoteInfo(name: string, url: string): GitRemote {
    const r = g.parseRemote(url);
    const acc = hosts.accountFor(r?.host ?? null);
    const kind = acc?.kind ?? (r?.host === 'github.com' ? 'github' : r?.host === 'gitlab.com' ? 'gitlab' : r?.host === 'bitbucket.org' ? 'bitbucket' : r?.host === 'codeberg.org' ? 'gitea' : null);
    const web = r ? `https://${r.host === 'ssh.github.com' ? 'github.com' : r.host}/${r.owner}/${r.repo}` : null;
    return { name, url, host: r?.host ?? null, owner: r?.owner ?? null, repo: r?.repo ?? null, webUrl: web, accountId: acc?.id ?? null, kind };
  }

  async status(id: string): Promise<GitStatus | null> {
    const p = this.h.project(id);
    if (!(await g.repoRoot(p.path))) return null;
    const s = await g.status(p.path);
    const { remoteUrls, ...rest } = s;
    this.summaries.set(id, { branch: s.branch, detached: s.detached, upstream: s.upstream, ahead: s.ahead, behind: s.behind, changed: s.changed, conflicts: s.conflicts, operation: s.operation });
    return { ...rest, remotes: remoteUrls.map((r) => this.remoteInfo(r.name, r.url)) };
  }

  async init(id: string): Promise<void> {
    const p = this.h.project(id);
    if (await g.repoRoot(p.path)) throw new Error('Already a Git repository');
    await g.gitOk(p.path, ['init', '-b', 'main']);
    await this.refresh(id);
  }

  async diff(id: string, file: string, staged: boolean): Promise<string> {
    return g.diff(await this.root(id), file, staged);
  }

  private async files(id: string, files: string[]): Promise<{ root: string; list: string[] }> {
    const root = await this.root(id);
    const list = files.map((f) => g.inside(root, f));
    if (!list.length) throw new Error('No files');
    return { root, list };
  }

  async stage(id: string, files: string[]): Promise<void> {
    const { list } = await this.files(id, files);
    await this.op(id, ['add', '-A', '--', ...list]);
  }

  async unstage(id: string, files: string[]): Promise<void> {
    const { root, list } = await this.files(id, files);
    const hasHead = (await g.git(root, ['rev-parse', '--verify', '-q', 'HEAD'])).code === 0;
    await this.op(id, hasHead ? ['restore', '--staged', '--', ...list] : ['rm', '--cached', '-r', '-q', '--', ...list]);
  }

  async discard(id: string, files: string[]): Promise<void> {
    const { root, list } = await this.files(id, files);
    const tracked: string[] = [];
    const untracked: string[] = [];
    for (const f of list) ((await g.git(root, ['ls-files', '--error-unmatch', '--', f])).code === 0 ? tracked : untracked).push(f);
    if (tracked.length) await this.op(id, ['restore', '--staged', '--worktree', '--source=HEAD', '--', ...tracked]);
    if (untracked.length) await this.op(id, ['clean', '-f', '-q', '--', ...untracked]);
  }

  async commit(id: string, message: string, amend: boolean): Promise<void> {
    const root = await this.root(id);
    if (!message.trim() && !amend) throw new Error('Write a commit message');
    const staged = (await g.git(root, ['diff', '--cached', '--quiet'])).code === 1;
    if (!staged && !amend) throw new Error('Nothing staged: stage files first');
    const who = await g.git(root, ['config', 'user.email']);
    if (!who.stdout.trim()) throw new Error('Set your name and email first (Git tab → identity)');
    await this.op(id, ['commit', ...(amend ? ['--amend'] : []), ...(message.trim() ? ['-F', '-'] : ['--no-edit'])], { input: message.trim() ? `${message.trim()}\n` : undefined });
    this.h.log(id, `git commit${amend ? ' --amend' : ''}: ${message.trim().split('\n')[0] ?? ''}`);
  }

  /** Credentials for the remote a command talks to (HTTPS + a connected account). */
  private async credsFor(root: string, remote: string): Promise<g.GitCreds | null> {
    const url = (await g.git(root, ['remote', 'get-url', remote])).stdout.trim();
    const r = g.parseRemote(url);
    return r?.https ? hosts.credsFor(r.host) : null;
  }

  /** The remote of the current branch's upstream, else origin, else the first one. */
  private async remoteOf(root: string): Promise<string> {
    const up = (await g.git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])).stdout.trim();
    const remotes = (await g.git(root, ['remote'])).stdout.split('\n').filter(Boolean);
    if (!remotes.length) throw new Error('No remote: add one first (e.g. origin)');
    const fromUp = up && remotes.find((r) => up.startsWith(`${r}/`));
    return fromUp || (remotes.includes('origin') ? 'origin' : remotes[0]);
  }

  /** A long git command as a site task: output in Logs, busy label, cancellable. */
  private async task(id: string, label: string, root: string, args: string[], creds: g.GitCreds | null): Promise<void> {
    if (this.h.busy.has(id)) throw new Error(`Busy: ${this.h.busy.get(id)}`);
    const abort = new AbortController();
    this.aborts.set(id, abort);
    this.h.busy.set(id, label);
    this.h.changed();
    this.h.log(id, `$ git ${args.join(' ')}`);
    let pending = '';
    try {
      const code = await g.gitStream(
        root,
        args,
        (line, progress) => {
          if (progress) pending = line;
          else {
            if (pending) this.h.log(id, pending);
            pending = '';
            this.h.log(id, line);
          }
        },
        { env: { ...g.gitEnv(creds), GIT_EDITOR: 'true' }, signal: abort.signal },
      );
      if (pending) this.h.log(id, pending);
      this.h.log(id, `→ exit ${code}`);
      if (abort.signal.aborted) throw new Error(`${label} cancelled`);
      if (code !== 0) throw new Error(`${label} failed (exit ${code}); see the log`);
    } finally {
      this.aborts.delete(id);
      this.h.busy.delete(id);
      void this.refresh(id);
    }
  }

  cancel(id: string): void {
    this.aborts.get(id)?.abort();
  }

  async sync(id: string, action: GitSyncAction): Promise<void> {
    // Anything else must not fall through to a push.
    if (!['fetch', 'pull', 'pull-rebase', 'push', 'push-force'].includes(action)) throw new Error(`Unknown Git action: ${String(action)}`);
    const root = await this.root(id);
    if (action === 'fetch') {
      const remotes = (await g.git(root, ['remote'])).stdout.split('\n').filter(Boolean);
      if (!remotes.length) throw new Error('No remote: add one first (e.g. origin)');
      for (const r of remotes) await this.task(id, `git fetch ${r}`, root, ['fetch', '--prune', '--progress', r], await this.credsFor(root, r));
      return;
    }
    const remote = await this.remoteOf(root);
    const creds = await this.credsFor(root, remote);
    const branch = (await g.git(root, ['branch', '--show-current'])).stdout.trim();
    if (!branch) throw new Error('Not on a branch (detached HEAD): switch to a branch first');
    const hasUp = (await g.git(root, ['rev-parse', '--abbrev-ref', '@{upstream}'])).code === 0;
    if (action === 'pull' || action === 'pull-rebase') {
      if (!hasUp) throw new Error(`${branch} has no upstream yet: push it first`);
      await this.task(id, action === 'pull' ? 'git pull' : 'git pull --rebase', root, ['pull', '--progress', ...(action === 'pull' ? ['--no-rebase'] : ['--rebase', '--autostash'])], creds);
    } else {
      const args = ['push', '--progress', ...(action === 'push-force' ? ['--force-with-lease'] : []), ...(hasUp ? [] : ['-u', remote, `HEAD:refs/heads/${branch}`])];
      await this.task(id, action === 'push-force' ? 'git push --force-with-lease' : 'git push', root, args, creds);
    }
  }

  async log(id: string, search: string, skip: number, ref?: string) {
    const root = await this.root(id);
    if (ref && !(await g.branches(root)).some((b) => b.name === ref)) throw new Error(`Unknown branch ${ref}`);
    return g.log(root, search, skip, 100, ref);
  }

  show(id: string, sha: string) {
    return this.root(id).then((r) => g.show(r, sha));
  }

  branches(id: string) {
    return this.root(id).then((r) => g.branches(r));
  }

  async branch(id: string, action: 'create' | 'switch' | 'delete' | 'force-delete' | 'merge', name: string, from?: string): Promise<void> {
    const root = await this.root(id);
    const all = await g.branches(root);
    const known = all.find((b) => b.name === name);
    if (action === 'create') {
      const n = await g.checkRefName(root, name);
      if (from && !all.some((b) => b.name === from) && !SHA.test(from)) throw new Error(`Unknown start point ${from}`);
      await this.op(id, ['switch', '-c', n, ...(from ? [from] : [])]);
      return;
    }
    if (!known) throw new Error(`Unknown branch ${name}`);
    if (action === 'switch') {
      if (known.remote) {
        const local = name.split('/').slice(1).join('/');
        await this.op(id, all.some((b) => !b.remote && b.name === local) ? ['switch', local] : ['switch', '--track', name]);
      } else await this.op(id, ['switch', name]);
    } else if (action === 'merge') await this.op(id, ['merge', '--no-edit', name]);
    else {
      if (known.remote) throw new Error('Delete remote branches on the host');
      if (known.current) throw new Error('Switch to another branch first');
      await this.op(id, ['branch', action === 'force-delete' ? '-D' : '-d', name]);
    }
  }

  stashes(id: string) {
    return this.root(id).then((r) => g.stashes(r));
  }

  async stash(id: string, action: 'save' | 'apply' | 'pop' | 'drop', arg: string): Promise<void> {
    if (action === 'save') {
      await this.op(id, ['stash', 'push', '--include-untracked', ...(arg.trim() ? ['-m', arg.trim()] : [])]);
      return;
    }
    if (!/^stash@\{\d+\}$/.test(arg)) throw new Error('Not a stash');
    await this.op(id, ['stash', action, arg]);
  }

  tags(id: string) {
    return this.root(id).then((r) => g.tags(r));
  }

  async tag(id: string, action: 'create' | 'delete' | 'push', name: string, message?: string): Promise<void> {
    const root = await this.root(id);
    const n = await g.checkRefName(root, name, 'tag');
    if (action === 'create') await this.op(id, ['tag', ...(message?.trim() ? ['-a', n, '-m', message.trim()] : [n])]);
    else if (action === 'delete') await this.op(id, ['tag', '-d', n]);
    else {
      const remote = await this.remoteOf(root);
      await this.task(id, `git push tag ${n}`, root, ['push', '--progress', remote, `refs/tags/${n}`], await this.credsFor(root, remote));
    }
  }

  async operation(id: string, action: 'rebase' | 'continue' | 'skip' | 'abort', onto?: string): Promise<void> {
    const root = await this.root(id);
    if (action === 'rebase') {
      if (!onto || !(await g.branches(root)).some((b) => b.name === onto)) throw new Error('Choose the branch to rebase onto');
      await this.op(id, ['rebase', '--autostash', onto]).catch((e) => {
        throw new Error(`${(e as Error).message} — resolve the conflicts, stage them and Continue, or Abort`);
      });
      return;
    }
    const st = await g.summary(root);
    const kind = st?.operation;
    if (!kind) throw new Error('No merge, rebase or cherry-pick in progress');
    if (action === 'continue' && st.conflicts) throw new Error(`${st.conflicts} file(s) still have conflicts: fix and stage them first`);
    if (kind === 'merge') {
      if (action === 'skip') throw new Error('A merge cannot skip');
      await this.op(id, action === 'abort' ? ['merge', '--abort'] : ['commit', '--no-edit']);
    } else await this.op(id, [kind, `--${action}`]);
  }

  async squash(id: string, onto: string, message: string): Promise<void> {
    const root = await this.root(id);
    if (!message.trim()) throw new Error('Write the message of the squashed commit');
    const st = await g.summary(root);
    if (st?.changed) throw new Error('Commit or stash your changes first');
    const base = (await g.gitOk(root, ['merge-base', 'HEAD', onto])).trim();
    const count = Number((await g.gitOk(root, ['rev-list', '--count', `${base}..HEAD`])).trim());
    if (count < 2) throw new Error(`Only ${count} commit(s) since ${onto}: nothing to squash`);
    await this.op(id, ['reset', '--soft', base]);
    await this.op(id, ['commit', '-F', '-'], { input: `${message.trim()}\n` });
    this.h.log(id, `Squashed ${count} commits into one (was based on ${base.slice(0, 7)})`);
  }

  async cherryPick(id: string, sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    await this.op(id, ['cherry-pick', sha]);
  }

  async revert(id: string, sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    await this.op(id, ['revert', '--no-edit', sha]);
  }

  async reset(id: string, mode: 'soft' | 'mixed' | 'hard', sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    await this.op(id, ['reset', `--${mode}`, sha]);
    this.h.log(id, `git reset --${mode} ${sha.slice(0, 7)}`);
  }

  async restoreFile(id: string, file: string, sha: string): Promise<void> {
    if (!SHA.test(sha)) throw new Error('Not a commit id');
    const { list } = await this.files(id, [file]);
    await this.op(id, ['restore', `--source=${sha}`, '--staged', '--worktree', '--', ...list]);
  }

  async openFile(id: string, file: string): Promise<void> {
    const root = await this.root(id);
    await this.h.openFile(join(root, g.inside(root, file)));
  }

  async ignoreSuggestions(id: string): Promise<string[]> {
    return g.ignoreSuggestions(await this.root(id), this.h.runtimes(id));
  }

  async ignoreAdd(id: string, lines: string[]): Promise<void> {
    g.addIgnore(await this.root(id), lines);
    await this.refresh(id);
  }

  async setIdentity(id: string, name: string, email: string, global: boolean): Promise<void> {
    const root = await this.root(id);
    if (!name.trim() || !/^[^\s@]+@[^\s@]+$/.test(email.trim())) throw new Error('Enter a name and an email address');
    await g.gitOk(root, ['config', ...(global ? ['--global'] : []), 'user.name', name.trim()]);
    await g.gitOk(root, ['config', ...(global ? ['--global'] : []), 'user.email', email.trim()]);
  }

  async addRemote(id: string, name: string, url: string): Promise<void> {
    if (!/^[\w.-]+$/.test(name)) throw new Error('Remote name: letters, digits, . _ -');
    if (!g.parseRemote(url) && !url.startsWith('/')) throw new Error('Not a Git URL');
    await this.op(id, ['remote', 'add', name, url.trim()]);
  }

  // ---- pull requests

  private async hosted(id: string): Promise<{ root: string; remote: GitRemote; accountId: string }> {
    const root = await this.root(id);
    const name = await this.remoteOf(root);
    const url = (await g.git(root, ['remote', 'get-url', name])).stdout.trim();
    const remote = this.remoteInfo(name, url);
    if (!remote.owner || !remote.repo) throw new Error(`Cannot read the repository from ${url}`);
    if (!remote.accountId) throw new Error(`Connect a ${remote.host ?? 'Git host'} account on the Git page to see pull requests`);
    return { root, remote, accountId: remote.accountId };
  }

  async pulls(id: string): Promise<GitPull[]> {
    const { remote, accountId } = await this.hosted(id);
    return hosts.pulls(accountId, remote.owner!, remote.repo!);
  }

  async createPull(id: string, title: string, body: string, base: string, draft: boolean): Promise<GitPull> {
    const { root, remote, accountId } = await this.hosted(id);
    if (!title.trim()) throw new Error('Write a title');
    const head = (await g.git(root, ['branch', '--show-current'])).stdout.trim();
    if (!head) throw new Error('Not on a branch');
    if (head === base) throw new Error(`Pick a base other than ${head}`);
    const up = await g.git(root, ['rev-parse', '--abbrev-ref', '@{upstream}']);
    if (up.code !== 0) throw new Error(`Push ${head} first (it has no upstream on ${remote.name})`);
    const s = await g.summary(root);
    if (s?.ahead) throw new Error(`${s.ahead} commit(s) not pushed yet: push first`);
    return hosts.createPull(accountId, remote.owner!, remote.repo!, { title: title.trim(), body, head, base, draft });
  }

  async checkoutPull(id: string, pull: GitPull): Promise<void> {
    const { root, remote, accountId } = await this.hosted(id);
    const kind = hosts.listAccounts().find((a) => a.id === accountId)!.kind;
    const ref = hosts.pullRef(kind, pull.number);
    const creds = await this.credsFor(root, remote.name);
    const local = ref ? `pr/${pull.number}` : pull.head;
    await this.task(id, `fetch pull #${pull.number}`, root, ['fetch', '--progress', remote.name, `+${ref ?? `refs/heads/${pull.head}`}:refs/heads/${local}`], creds);
    await this.op(id, ['switch', local]);
  }

  // ---- clone

  async cloneRepo(url: string, parent: string, name: string, branch: string, shallow: boolean): Promise<string> {
    if (this.cloneAbort) throw new Error('A clone is already running');
    if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) throw new Error('Folder name: letters, digits, . _ -');
    if (!existsSync(parent)) throw new Error(`${parent} does not exist`);
    const src = url.trim();
    const remote = g.parseRemote(src);
    if (!remote && !src.startsWith('/')) throw new Error('Not a Git URL (https://…, git@host:owner/repo.git)');
    if (branch && (branch.startsWith('-') || /\s/.test(branch))) throw new Error('Not a branch or tag name');
    const dest = join(parent, name);
    const abort = new AbortController();
    this.cloneAbort = abort;
    this.clone = { url: src, dest, lines: [], done: false, error: null };
    this.h.changed();
    let lastProgress = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const push = (line: string, progress: boolean) => {
      const c = this.clone!;
      if (lastProgress && c.lines.length) c.lines[c.lines.length - 1] = line;
      else c.lines.push(line);
      lastProgress = progress;
      if (c.lines.length > 200) c.lines.splice(0, c.lines.length - 200);
      // Progress updates are frequent: send state at most every 250 ms.
      timer ??= setTimeout(() => {
        timer = null;
        this.h.changed();
      }, 250);
    };
    try {
      await g.clone({ url: src, dest, branch, shallow, creds: remote?.https ? hosts.credsFor(remote.host) : null, log: push, signal: abort.signal });
      this.clone = { ...this.clone!, done: true };
      return dest;
    } catch (err) {
      this.clone = { ...this.clone!, done: true, error: (err as Error).message };
      if (abort.signal.aborted) rmSync(dest, { recursive: true, force: true });
      throw err;
    } finally {
      this.cloneAbort = null;
      if (timer) clearTimeout(timer);
      this.h.changed();
    }
  }

  cancelClone(): void {
    this.cloneAbort?.abort();
  }
}
