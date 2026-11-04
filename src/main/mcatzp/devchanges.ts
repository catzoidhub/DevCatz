import type { HerdApi, DevServiceKind, DockerAction, DockerEngineId, GitSyncAction } from '@shared/types';
import { findSite, inBackground, type ChangeAction, type Scopes } from './actions';
import { maskDeep } from './mask';

/**
 * Git and Docker changes (the site's Git and Docker tabs). What loses work or rewrites history (discard, reset, force push,
 * deleting a branch or tag, dropping a stash, amending) is left for the destructive tier, which asks for the name typed.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SITE = { type: 'string', minLength: 1, maxLength: 200, description: "The site's id, name or domain (see list_sites)." };
const S = (description: string, maxLength = 200) => ({ type: 'string', minLength: 1, maxLength, description });
const FILES = { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 500 }, description: 'Paths from site_git_status.' };
/** A ref name git would accept; never something that reads as an option. */
const REF = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._/#@+-]+$', not: { pattern: '^-' } };
const SHA = { type: 'string', pattern: '^[0-9a-fA-F]{4,64}$' };

const ok = (data: unknown) => ({ text: JSON.stringify(data, null, 2), data });
type Fact = { label: string; value: string };
const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);
const short = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function devChanges(api: HerdApi, scopes: Scopes): ChangeAction[] {
  if (!scopes.changes) return [];
  const site = async (ref: unknown) => {
    const { projects } = await api.getState();
    const id = findSite(projects, String(ref));
    return projects.find((p) => p.id === id)!;
  };
  /** An action on one site; `page` is the tab that shows it. */
  const onSite = (o: {
    name: string;
    title: string;
    description: string;
    props?: Record<string, unknown>;
    required?: string[];
    allowSession?: boolean;
    tab: 'git' | 'docker';
    ask: (p: Awaited<ReturnType<typeof site>>, a: Record<string, unknown>) => Promise<{ title: string; facts: Fact[] }> | { title: string; facts: Fact[] };
    run: ChangeAction['run'] extends (...x: infer _) => unknown ? (p: Awaited<ReturnType<typeof site>>, a: Record<string, unknown>, ctx: Parameters<ChangeAction['run']>[1]) => ReturnType<ChangeAction['run']> : never;
  }): ChangeAction => ({
    name: o.name,
    title: o.title,
    description: `${o.description} DevCatz asks the user first.`,
    tier: 'change',
    allowSession: o.allowSession,
    input: OBJECT({ site: SITE, ...(o.props ?? {}) }, ['site', ...(o.required ?? [])]),
    preview: async (a) => {
      const p = await site(a.site);
      const q = await o.ask(p, a);
      return { ...q, facts: [{ label: 'Site', value: p.name }, ...q.facts], page: `${o.tab}:${p.id}` };
    },
    run: async (a, ctx) => o.run(await site(a.site), a, ctx),
  });
  const branchOf = async (id: string) => (await api.gitStatus(id))?.branch ?? null;

  const git: ChangeAction[] = [
    onSite({ name: 'git_init', title: 'Start a Git repository', description: 'Makes the site a Git repository.', tab: 'git', ask: () => ({ title: 'Start a Git repository?', facts: [] }), run: async (p) => (await api.gitInit(p.id), ok({ site: p.name, result: 'Repository started' })) }),
    onSite({ name: 'git_stage', title: 'Stage files', description: 'Stages files for the next commit.', props: { files: FILES }, required: ['files'], allowSession: true, tab: 'git', ask: (_p, a) => ({ title: `Stage ${(a.files as string[]).length} file(s)?`, facts: fact('Files', short((a.files as string[]).join(', '))) }), run: async (p, a) => (await api.gitStage(p.id, a.files as string[]), ok({ staged: a.files })) }),
    onSite({ name: 'git_unstage', title: 'Unstage files', description: 'Takes files out of the next commit; their changes stay.', props: { files: FILES }, required: ['files'], allowSession: true, tab: 'git', ask: (_p, a) => ({ title: `Unstage ${(a.files as string[]).length} file(s)?`, facts: fact('Files', short((a.files as string[]).join(', '))) }), run: async (p, a) => (await api.gitUnstage(p.id, a.files as string[]), ok({ unstaged: a.files })) }),
    onSite({
      name: 'git_commit',
      title: 'Commit',
      description: 'Commits what is staged.',
      props: { message: S('The commit message.', 5000) },
      required: ['message'],
      tab: 'git',
      ask: async (p, a) => {
        const g = await api.gitStatus(p.id);
        const staged = g?.files.filter((f) => f.staged).map((f) => f.path) ?? [];
        return { title: 'Commit these changes?', facts: [...fact('Branch', g?.branch), { label: 'Message', value: short(String(a.message), 400) }, { label: 'Files', value: staged.length ? short(staged.join(', ')) : 'nothing staged' }] };
      },
      run: async (p, a) => {
        await api.gitCommit(p.id, String(a.message), false);
        return ok({ site: p.name, result: 'Committed', branch: await branchOf(p.id) });
      },
    }),
    onSite({
      name: 'git_sync',
      title: 'Fetch, pull or push',
      description: 'Fetches, pulls, pulls with rebase, or pushes the current branch. Output goes to site_logs; git_cancel stops it.',
      props: { action: { type: 'string', enum: ['fetch', 'pull', 'pull-rebase', 'push'] } },
      required: ['action'],
      tab: 'git',
      ask: async (p, a) => {
        const g = await api.gitStatus(p.id);
        const remote = g?.remotes.find((r) => g.upstream?.startsWith(`${r.name}/`)) ?? g?.remotes[0];
        return { title: `${{ fetch: 'Fetch', pull: 'Pull', 'pull-rebase': 'Pull with rebase', push: 'Push' }[String(a.action)]} ${g?.branch ?? ''}?`, facts: [...fact('Upstream', g?.upstream), ...fact('Remote', remote ? maskDeep(remote.url) : null), ...fact('To push', g?.ahead), ...fact('To pull', g?.behind)] };
      },
      run: async (p, a, ctx) => inBackground(api, ctx, api.gitSync(p.id, a.action as GitSyncAction), () => api.gitCancel(p.id), { site: p.name, action: a.action }, 'Done', 'Still running: site_logs shows it; only git_cancel stops it', () => null),
    }),
    {
      name: 'git_cancel',
      title: 'Cancel a Git task',
      description: 'Stops the fetch, pull or push a site is running. Runs at once, without a dialog.',
      tier: 'change',
      noDialog: true,
      input: OBJECT({ site: SITE }, ['site']),
      preview: async () => ({ title: '', facts: [], page: '' }),
      run: async (a) => {
        const p = await site(a.site);
        await api.gitCancel(p.id);
        return ok({ site: p.name, result: 'Cancelled' });
      },
    },
    onSite({
      name: 'git_branch',
      title: 'Create, switch or merge a branch',
      description: 'Creates a branch (optionally from another), switches to one, or merges one into the current branch.',
      props: { action: { type: 'string', enum: ['create', 'switch', 'merge'] }, name: REF, from: REF },
      required: ['action', 'name'],
      tab: 'git',
      ask: async (p, a) => ({ title: `${{ create: 'Create', switch: 'Switch to', merge: 'Merge' }[String(a.action)]} the branch ${String(a.name)}?`, facts: [...fact('Current', await branchOf(p.id)), ...fact('From', a.from)] }),
      run: async (p, a) => {
        await api.gitBranch(p.id, a.action as 'create' | 'switch' | 'merge', String(a.name), typeof a.from === 'string' ? a.from : undefined);
        return ok({ site: p.name, result: `${String(a.action)} ${String(a.name)}`, branch: await branchOf(p.id) });
      },
    }),
    onSite({
      name: 'git_stash',
      title: 'Stash changes',
      description: 'Saves the changes to a stash, or applies or pops one from site_git_stashes.',
      props: { action: { type: 'string', enum: ['save', 'apply', 'pop'] }, message: { type: 'string', maxLength: 300, description: 'For save.' }, stash: { type: 'string', pattern: '^stash@\\{\\d+\\}$', description: 'For apply and pop.' } },
      required: ['action'],
      tab: 'git',
      ask: (_p, a) => ({ title: `${{ save: 'Stash the changes', apply: 'Apply a stash', pop: 'Pop a stash' }[String(a.action)]}?`, facts: [...fact('Message', a.message), ...fact('Stash', a.stash)] }),
      run: async (p, a) => {
        if (a.action !== 'save' && typeof a.stash !== 'string') throw new Error('Name the stash (site_git_stashes)');
        await api.gitStash(p.id, a.action as 'save' | 'apply' | 'pop', a.action === 'save' ? String(a.message ?? '') : String(a.stash));
        return ok({ site: p.name, result: String(a.action) });
      },
    }),
    onSite({
      name: 'git_tag',
      title: 'Create or push a tag',
      description: 'Creates a tag on the current commit, or pushes one.',
      props: { action: { type: 'string', enum: ['create', 'push'] }, name: REF, message: { type: 'string', maxLength: 2000 } },
      required: ['action', 'name'],
      tab: 'git',
      ask: (_p, a) => ({ title: `${a.action === 'push' ? 'Push' : 'Create'} the tag ${String(a.name)}?`, facts: fact('Message', a.message) }),
      run: async (p, a) => (await api.gitTag(p.id, a.action as 'create' | 'push', String(a.name), typeof a.message === 'string' ? a.message : undefined), ok({ site: p.name, tag: a.name, result: String(a.action) })),
    }),
    onSite({
      name: 'git_rebase',
      title: 'Rebase, or go on with an operation',
      description: 'Rebases onto a branch, or continues, skips or aborts a merge, rebase, cherry-pick or revert in progress.',
      props: { action: { type: 'string', enum: ['rebase', 'continue', 'skip', 'abort'] }, onto: REF },
      required: ['action'],
      tab: 'git',
      ask: async (p, a) => ({ title: a.action === 'rebase' ? `Rebase onto ${String(a.onto)}?` : `${String(a.action)} the operation in progress?`, facts: fact('Branch', await branchOf(p.id)) }),
      run: async (p, a) => {
        if (a.action === 'rebase' && typeof a.onto !== 'string') throw new Error('Name the branch to rebase onto');
        await api.gitOperation(p.id, a.action as 'rebase' | 'continue' | 'skip' | 'abort', typeof a.onto === 'string' ? a.onto : undefined);
        return ok({ site: p.name, result: String(a.action) });
      },
    }),
    onSite({ name: 'git_cherry_pick', title: 'Cherry-pick a commit', description: 'Applies a commit to the current branch.', props: { sha: SHA }, required: ['sha'], tab: 'git', ask: async (p, a) => ({ title: `Cherry-pick ${String(a.sha).slice(0, 10)}?`, facts: fact('Onto', await branchOf(p.id)) }), run: async (p, a) => (await api.gitCherryPick(p.id, String(a.sha)), ok({ site: p.name, result: 'Picked', sha: a.sha })) }),
    onSite({ name: 'git_ignore_add', title: 'Add to .gitignore', description: 'Adds lines to the .gitignore of a site.', props: { lines: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 300 } } }, required: ['lines'], tab: 'git', ask: (_p, a) => ({ title: 'Add to .gitignore?', facts: fact('Lines', short((a.lines as string[]).join(', '))) }), run: async (p, a) => (await api.gitIgnoreAdd(p.id, a.lines as string[]), ok({ site: p.name, added: a.lines })) }),
    onSite({ name: 'git_add_remote', title: 'Add a remote', description: 'Adds a Git remote to a site. A URL holding a password is refused.', props: { name: REF, url: S('The remote URL, with no credentials in it.', 500) }, required: ['name', 'url'], tab: 'git', ask: (_p, a) => ({ title: `Add the remote ${String(a.name)}?`, facts: fact('URL', maskDeep(String(a.url))) }), run: async (p, a) => {
      if (/\/\/[^/@\s]+:[^/@\s]+@/.test(String(a.url))) throw new Error('No credentials in the URL: connect the account on the Git page');
      await api.gitAddRemote(p.id, String(a.name), String(a.url));
      return ok({ site: p.name, remote: a.name, result: 'Added' });
    } }),
    onSite({
      name: 'git_create_pull',
      title: 'Open a pull request',
      description: 'Opens a pull request from the current branch, through the connected account.',
      props: { title: S('Its title.', 300), body: { type: 'string', maxLength: 20000 }, base: REF, draft: { type: 'boolean' } },
      required: ['title', 'base'],
      tab: 'git',
      ask: async (p, a) => ({ title: 'Open this pull request?', facts: [{ label: 'Title', value: String(a.title) }, ...fact('From', await branchOf(p.id)), { label: 'Into', value: String(a.base) }, ...fact('Draft', a.draft === true ? 'yes' : null), ...fact('Body', a.body ? short(String(a.body)) : null)] }),
      run: async (p, a) => {
        const r = await api.gitCreatePull(p.id, String(a.title), typeof a.body === 'string' ? a.body : '', String(a.base), a.draft === true);
        return ok({ number: r.number, title: r.title, url: r.url });
      },
    }),
    onSite({
      name: 'git_checkout_pull',
      title: 'Check out a pull request',
      description: 'Switches the site to the branch of an open pull request (see site_git_pulls).',
      props: { number: { type: 'integer', minimum: 1 } },
      required: ['number'],
      tab: 'git',
      ask: async (p, a) => {
        const pull = (await api.gitPulls(p.id)).find((x) => x.number === a.number);
        if (!pull) throw new Error(`No open pull request ${String(a.number)}`);
        return { title: `Check out pull request #${pull.number}?`, facts: [{ label: 'Title', value: pull.title }, ...fact('Current', await branchOf(p.id))] };
      },
      run: async (p, a) => {
        const pull = (await api.gitPulls(p.id)).find((x) => x.number === a.number);
        if (!pull) throw new Error(`No open pull request ${String(a.number)}`);
        await api.gitCheckoutPull(p.id, pull);
        return ok({ site: p.name, result: 'Checked out', branch: await branchOf(p.id) });
      },
    }),
    onSite({
      name: 'worktree_add',
      title: 'Add a worktree as a site',
      description: 'Adds an existing Git worktree of this site, made outside DevCatz, as a site of its own.',
      props: { path: S('The folder of the worktree.', 500) },
      required: ['path'],
      tab: 'git',
      ask: (_p, a) => ({ title: 'Add this worktree as a site?', facts: [{ label: 'Folder', value: String(a.path) }] }),
      run: async (p, a) => ok({ site: await api.worktreeAdd(p.id, String(a.path)), result: 'Added' }),
    }),
    {
      name: 'git_clone',
      title: 'Clone a repository',
      description: 'Clones a repository into a new folder and links it as a site. A URL holding a password is refused. DevCatz asks the user first; git_cancel_clone stops it.',
      tier: 'change',
      input: OBJECT({ url: S('The repository URL, with no credentials in it.', 500), name: { ...REF, description: "The new folder's name." }, parent: S('Where to put it; DevCatz’s clone folder when left out.', 500), branch: REF, shallow: { type: 'boolean' } }, ['url', 'name']),
      preview: async (a) => {
        if (/\/\/[^/@\s]+:[^/@\s]+@/.test(String(a.url))) throw new Error('No credentials in the URL: connect the account on the Git page');
        const dir = typeof a.parent === 'string' ? a.parent : (await api.getState()).git.cloneDir;
        return { title: 'Clone this repository?', facts: [{ label: 'From', value: String(a.url) }, { label: 'Into', value: `${dir}/${String(a.name)}` }, ...fact('Branch', a.branch)], page: 'git' };
      },
      run: async (a, ctx) => {
        if (/\/\/[^/@\s]+:[^/@\s]+@/.test(String(a.url))) throw new Error('No credentials in the URL: connect the account on the Git page');
        const dir = typeof a.parent === 'string' ? a.parent : (await api.getState()).git.cloneDir;
        return inBackground(api, ctx, api.gitClone(String(a.url), dir, String(a.name), typeof a.branch === 'string' ? a.branch : '', a.shallow === true), () => api.gitCancelClone(), { repository: a.url, folder: `${dir}/${String(a.name)}` }, 'Cloned', 'Still cloning: list_sites shows it when done; only git_cancel_clone stops it', () => null);
      },
    },
    onSite({
      name: 'worktree_create',
      title: 'Create a worktree',
      description: 'Creates a Git worktree of this site on a branch and links it as a site of its own, as the Git tab does.',
      props: { branch: REF, create: { type: 'boolean', description: 'Make a new branch (default: use an existing one).' }, from: REF, deps: { type: 'string', enum: ['clone', 'install', 'none'], description: 'Its dependencies (default clone).' }, database: { type: 'string', enum: ['shared', 'copy'], description: 'Its database (default shared).' } },
      required: ['branch'],
      tab: 'git',
      ask: (_p, a) => ({ title: `Create a worktree on ${String(a.branch)}?`, facts: [{ label: 'Branch', value: `${String(a.branch)}${a.create === true ? ' (new)' : ''}` }, ...fact('From', a.from), { label: 'Dependencies', value: String(a.deps ?? 'clone') }, { label: 'Database', value: String(a.database ?? 'shared') }] }),
      run: async (p, a) => ok({ site: await api.worktreeCreate(p.id, { branch: String(a.branch), create: a.create === true, ...(typeof a.from === 'string' ? { from: a.from } : {}), deps: (a.deps as 'clone' | 'install' | 'none') ?? 'clone', database: (a.database as 'shared' | 'copy') ?? 'shared' }), result: 'Created' }),
    }),
    onSite({
      name: 'git_ignore_save',
      title: 'Save .gitignore',
      description: 'Replaces the whole .gitignore of a site. git_ignore_add only adds lines.',
      props: { content: { type: 'string', maxLength: 200000 } },
      required: ['content'],
      tab: 'git',
      ask: async (p, a) => {
        const was = await api.gitignoreRead(p.id);
        return { title: 'Replace .gitignore?', facts: [{ label: 'Was', value: was.exists ? `${was.content.split('\n').length} lines` : 'none' }, { label: 'Now', value: `${String(a.content).split('\n').length} lines` }, { label: 'Starts', value: short(String(a.content), 200) }] };
      },
      run: async (p, a) => (await api.gitignoreSave(p.id, String(a.content)), ok({ site: p.name, result: 'Saved' })),
    }),
    { name: 'git_cancel_clone', title: 'Cancel a clone', description: 'Stops a clone in progress. Runs at once, without a dialog.', tier: 'change', noDialog: true, input: OBJECT(), preview: async () => ({ title: '', facts: [], page: '' }), run: async () => (await api.gitCancelClone(), ok({ result: 'Cancelled' })) },
  ];

  const docker: ChangeAction[] = !scopes.changes
    ? []
    : [
        onSite({
          name: 'docker_dev_write',
          title: 'Write the dev compose file',
          description: 'Writes the dev compose file DevCatz generates (site_docker_preview) with the services named.',
          props: { services: { type: 'array', maxItems: 10, items: { type: 'string', enum: ['postgres', 'mysql', 'mariadb', 'redis', 'mongo', 'mailpit', 'meilisearch'] } } },
          required: ['services'],
          tab: 'docker',
          ask: (_p, a) => ({ title: 'Write the dev compose file?', facts: fact('Services', (a.services as string[]).join(', ') || 'none') }),
          run: async (p, a) => ok({ site: p.name, file: await api.dockerDevWrite(p.id, a.services as DevServiceKind[]) }),
        }),
        onSite({
          name: 'docker_write',
          title: 'Write the Docker files',
          description: 'Writes the Docker files DevCatz generates for a site (see site_docker_generate). A file that exists is only replaced when listed in `overwrite`.',
          props: { target: { type: 'string', enum: ['local', 'production'] }, paths: FILES, overwrite: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 500 } } },
          required: ['paths'],
          tab: 'docker',
          ask: async (_p, a) => ({ title: 'Write these Docker files?', facts: [{ label: 'For', value: String(a.target ?? 'local') }, { label: 'Files', value: short((a.paths as string[]).join(', ')) }, ...fact('Replaces', Array.isArray(a.overwrite) ? short((a.overwrite as string[]).join(', ')) : null)] }),
          run: async (p, a) => {
            const g = await api.dockerGenerate(p.id, { target: (a.target as 'local' | 'production') ?? 'local' });
            return ok({ site: p.name, written: await api.dockerWrite(p.id, g.options, a.paths as string[], (a.overwrite as string[]) ?? []) });
          },
        }),
        onSite({
          name: 'docker_save_file',
          title: 'Save a Docker file',
          description: 'Writes a Docker file of the site (one from site_docker_list_files). Writing over a file replaces it whole: read it first, since secrets come back masked and must not be saved as such.',
          props: { file: S('The path.', 500), content: { type: 'string', maxLength: 500000 } },
          required: ['file', 'content'],
          tab: 'docker',
          ask: async (p, a) => {
            const was = await api.dockerReadFile(p.id, String(a.file)).catch(() => null);
            const lines = String(a.content).split('\n').length;
            return { title: `${was === null ? 'Create' : 'Replace'} ${String(a.file)}?`, facts: [...fact('Was', was === null ? null : `${was.split('\n').length} lines`), { label: 'Now', value: `${lines} lines` }, { label: 'Starts', value: short(maskDeep(String(a.content)), 200) }] };
          },
          run: async (p, a) => {
            if (String(a.content).includes('•••')) throw new Error('This holds a masked value (•••): it would replace the real secret. Leave that line out, or let the user edit it in DevCatz.');
            await api.dockerSaveFile(p.id, String(a.file), String(a.content));
            return ok({ site: p.name, file: a.file, result: 'Saved' });
          },
        }),
        onSite({
          name: 'docker_compose',
          title: 'Run docker compose',
          description: 'Build & up, down, restart or build, for a compose file of the site or one service in it. Output goes to site_logs; docker_cancel stops it.',
          props: { file: S('A file from site_docker_files.', 500), action: { type: 'string', enum: ['up', 'down', 'restart', 'build'] }, service: { type: 'string', maxLength: 200, description: 'One service; the whole file when left out.' } },
          required: ['file', 'action'],
          tab: 'docker',
          ask: (_p, a) => ({ title: `${{ up: 'Build & up', down: 'Take down', restart: 'Restart', build: 'Build' }[String(a.action)]} ${typeof a.service === 'string' ? a.service : 'this compose file'}?`, facts: [{ label: 'File', value: String(a.file) }] }),
          run: async (p, a, ctx) => inBackground(api, ctx, api.dockerCompose(p.id, String(a.file), a.action as DockerAction, typeof a.service === 'string' ? a.service : undefined), () => api.dockerCancel(p.id), { site: p.name, action: a.action }, 'Done', 'Still running: site_logs shows it; only docker_cancel stops it', () => null),
        }),
        { name: 'docker_cancel', title: 'Cancel a compose command', description: "Stops a site's running compose command. Runs at once, without a dialog.", tier: 'change', noDialog: true, input: OBJECT({ site: SITE }, ['site']), preview: async () => ({ title: '', facts: [], page: '' }), run: async (a) => {
          const p = await site(a.site);
          await api.dockerCancel(p.id);
          return ok({ site: p.name, result: 'Cancelled' });
        } },
        onSite({
          name: 'docker_env_replace',
          title: "Update DoCatz's .env for a compose file",
          description: "Replaces the compose file's .env in DoCatz with the site's (see site_docker_env).",
          props: { file: S('A file from site_docker_files.', 500) },
          required: ['file'],
          tab: 'docker',
          ask: (_p, a) => ({ title: "Replace this compose file's .env in DoCatz?", facts: [{ label: 'File', value: String(a.file) }] }),
          run: async (p, a) => ok({ site: p.name, file: await api.dockerDocatzEnvReplace(p.id, String(a.file)) }),
        }),
        ...(scopes.services
          ? [
              {
                name: 'start_docker_engine',
                title: 'Start a Docker engine',
                description: 'Opens an installed container engine (see docker_status). DevCatz asks the user first.',
                tier: 'change' as const,
                input: OBJECT({ engine: S('An engine id from docker_status.', 40) }, ['engine']),
                preview: async (a: Record<string, unknown>) => {
                  const d = await api.dockerStatus();
                  if (!d.installed.includes(a.engine as DockerEngineId)) throw new Error(`${String(a.engine)} is not installed (docker_status shows them)`);
                  return { title: `Start ${String(a.engine)}?`, facts: [], page: 'database' };
                },
                run: async (a: Record<string, unknown>) => {
                  const d = await api.dockerStatus();
                  if (!d.installed.includes(a.engine as DockerEngineId)) throw new Error(`${String(a.engine)} is not installed (docker_status shows them)`);
                  await api.startEngine(a.engine as DockerEngineId);
                  return ok({ engine: a.engine, result: 'Starting' });
                },
              } satisfies ChangeAction,
            ]
          : []),
      ];

  return [...git, ...docker];
}
