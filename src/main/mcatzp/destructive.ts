import type { CallResult } from '@catzoid/mcatzp-host';
import type { DbAction, DbEngine, ExposeTool, GitSyncAction, GwKind, HerdApi, RuntimeToolId, RuntimeToolRuntime, RustToolId, SearchKind, StorageKind, WaEngine, WsKind } from '@shared/types';
import { findSite, type ChangeAction, type Scopes } from './actions';

/**
 * What loses something. Tier `destructive` (the real thing is gone, or history is rewritten) asks the user to type a name
 * in DevCatz every time, as its own pages do. What can be had back (a runtime to reinstall, a file in the Trash, a folder
 * that stays) is a change: one dialog. Each was looked at on its own, not by its name.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SITE = { type: 'string', minLength: 1, maxLength: 200, description: "The site's id, name or domain (see list_sites)." };
const S = (description: string, maxLength = 200) => ({ type: 'string', minLength: 1, maxLength, description });
const SERVICE = S('A kind or name from list_services.');
const SHA = { type: 'string', pattern: '^[0-9a-fA-F]{4,64}$' };
const REF = { type: 'string', minLength: 1, maxLength: 200, pattern: '^[A-Za-z0-9._/#@+-]+$', not: { pattern: '^-' } };
const FILES = { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', minLength: 1, maxLength: 500 } };
const ok = (data: unknown): CallResult => ({ text: JSON.stringify(data, null, 2), data });
type Fact = { label: string; value: string };
type Q = { title: string; facts: Fact[]; page: string; typeName?: string };
const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);
const short = (t: string, m = 300) => (t.length > m ? `${t.slice(0, m)}…` : t);

export function destructiveActions(api: HerdApi, scopes: Scopes): ChangeAction[] {
  if (!scopes.changes) return [];
  const state = () => api.getState();
  const site = async (ref: unknown) => {
    const { projects } = await state();
    const id = findSite(projects, String(ref));
    return projects.find((p) => p.id === id)!;
  };
  /** Type this name, every time. */
  const typed = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], ask: (a: Record<string, unknown>) => Promise<Q> | Q, run: ChangeAction['run']): ChangeAction => ({ name, title, description: `${description} The user types a name in DevCatz to confirm, every time.`, tier: 'destructive', input: OBJECT(props, required), preview: async (a) => ask(a), run });
  /** Can be had back: one dialog. */
  const asked = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], ask: (a: Record<string, unknown>) => Promise<Q> | Q, run: ChangeAction['run']): ChangeAction => ({ name, title, description: `${description} DevCatz asks the user first.`, tier: 'change', input: OBJECT(props, required), preview: async (a) => ask(a), run });
  const branchOf = async (id: string) => (await api.gitStatus(id))?.branch ?? null;
  const onBranch = async (a: Record<string, unknown>) => {
    const p = await site(a.site);
    const b = await branchOf(p.id);
    if (!b) throw new Error('Not on a branch');
    return { p, b };
  };

  const sites: ChangeAction[] = [
    typed('remove_site', 'Remove a site', 'Takes a site out of DevCatz: its settings, domain and ports. The folder stays.', { site: SITE }, ['site'], async (a) => {
      const p = await site(a.site);
      return { title: `Remove ${p.name} from DevCatz?`, facts: [{ label: 'Stays', value: `the folder ${p.path}` }, { label: 'Goes', value: 'its settings, domain and ports' }], page: `site:${p.id}`, typeName: p.domain };
    }, async (a) => {
      const p = await site(a.site);
      await api.removeProject(p.id, p.domain);
      return ok({ removed: p.name });
    }),
    asked('forget_missing_site', 'Forget a missing site', 'Forgets a site whose folder is gone (get_status does not list it: see list_missing_sites).', { id: S('Its id.') }, ['id'], async (a) => {
      const m = (await state()).missingSites.find((x) => x.id === a.id);
      if (!m) throw new Error(`No missing site ${String(a.id)}`);
      return { title: `Forget ${m.name}?`, facts: [{ label: 'Was', value: m.path }], page: 'projects' };
    }, async (a) => (await api.missingRemove(String(a.id)), ok({ forgotten: a.id }))),
    asked('unpark_folder', 'Stop parking a folder', 'Its sites leave DevCatz; the folders stay.', { path: S('The folder.', 500) }, ['path'], async (a) => {
      const s = await state();
      if (!s.settings.parkedDirs.includes(String(a.path))) throw new Error('This folder is not parked');
      return { title: 'Stop parking this folder?', facts: [{ label: 'Folder', value: String(a.path) }, { label: 'Stays', value: 'the folders and their files' }], page: 'projects' };
    }, async (a) => (await api.unparkFolder(String(a.path)), ok({ unparked: a.path }))),
    asked('free_site_deps', 'Free disk from dependencies', 'Moves dependency folders (site_deps) to the Trash; install_deps brings them back.', { site: SITE, paths: FILES }, ['site', 'paths'], async (a) => {
      const p = await site(a.site);
      return { title: 'Move these to the Trash?', facts: [{ label: 'Site', value: p.name }, { label: 'Folders', value: short((a.paths as string[]).join(', ')) }], page: `site:${p.id}` };
    }, async (a) => {
      const p = await site(a.site);
      return ok({ freedBytes: await api.freeDeps(p.id, a.paths as string[]) });
    }),
    asked('openapi_remove', 'Remove an OpenAPI file or generator', 'Moves an OpenAPI file to the Trash, or takes out the generator DevCatz added.', { site: SITE, file: S('A file from site_openapi; left out, the generator.', 500) }, ['site'], async (a) => {
      const p = await site(a.site);
      if (typeof a.file === 'string') return { title: `Move ${a.file} to the Trash?`, facts: [{ label: 'Site', value: p.name }], page: `api:${p.id}` };
      const g = (await api.siteOpenApi(p.id)).generator;
      if (!g) throw new Error('DevCatz added no generator to this site');
      return { title: `Remove ${g === 'scramble' ? 'Scramble' : '@nestjs/swagger'}?`, facts: [{ label: 'Site', value: p.name }], page: `api:${p.id}` };
    }, async (a) => {
      const p = await site(a.site);
      if (typeof a.file !== 'string') {
        await api.openapiRemoveGenerator(p.id);
        return ok({ result: 'Removed' });
      }
      const f = (await api.siteOpenApi(p.id)).specs.find((s) => s.file === a.file || s.file === `${p.path}/${String(a.file)}`)?.file;
      if (!f) throw new Error(`No OpenAPI file ${String(a.file)} in this site`);
      await api.openapiRemoveFile(p.id, f);
      return ok({ result: 'In the Trash', file: a.file });
    }),
    typed('env_remove_variable', 'Remove a .env variable', 'Removes one variable from a .env file. A locked Env tab refuses it: the user unlocks it first.', { site: SITE, file: S('The path, e.g. .env.', 500), name: { type: 'string', pattern: '^[A-Za-z_][A-Za-z0-9_]*$', maxLength: 200 } }, ['site', 'file', 'name'], async (a) => {
      const p = await site(a.site);
      if (p.envLocked !== false) throw new Error("The site's Env tab is locked: the user unlocks it first");
      const c = (await api.envRead(p.id, String(a.file))).content;
      if (!new RegExp(`^\\s*(?:export\\s+)?${String(a.name)}\\s*=`, 'm').test(c)) throw new Error(`${String(a.name)} is not in ${String(a.file)}`);
      return { title: `Remove ${String(a.name)} from ${String(a.file)}?`, facts: [{ label: 'Site', value: p.name }], page: `env:${p.id}`, typeName: String(a.name) };
    }, async (a) => {
      const p = await site(a.site);
      const { content, mtime } = await api.envRead(p.id, String(a.file));
      await api.envWrite(p.id, String(a.file), content.split(/\r?\n/).filter((l) => !new RegExp(`^\\s*(?:export\\s+)?${String(a.name)}\\s*=`).test(l)).join('\n'), mtime);
      return ok({ removed: a.name });
    }),
    typed('site_database_reset', "Reset a site's database", 'Wipes and rebuilds the database of a site (prisma reset, artisan migrate:fresh).', { site: SITE, action: { type: 'string', enum: ['reset', 'artisan-fresh'] } }, ['site', 'action'], async (a) => {
      const p = await site(a.site);
      return { title: `Wipe the database of ${p.name}?`, facts: [{ label: 'Runs', value: a.action === 'reset' ? 'database reset' : 'php artisan migrate:fresh' }, { label: 'Goes', value: 'all its data' }], page: `site:${p.id}`, typeName: p.domain };
    }, async (a) => {
      const p = await site(a.site);
      await api.db(p.id, a.action as DbAction);
      return ok({ site: p.name, result: 'Done' });
    }),
    typed('run_dangerous_task', 'Run a dangerous command', 'Runs a framework, Go database or dependency command flagged dangerous (see get_site, site_go_db, site_dep_commands).', { site: SITE, kind: { type: 'string', enum: ['stack', 'go', 'dependency'] }, task: S('Its id.'), app: S("For go: the app's folder."), name: { type: 'string', maxLength: 200 } }, ['site', 'kind', 'task'], async (a) => {
      const p = await site(a.site);
      const t = a.kind === 'stack' ? p.stack.tasks?.find((x) => x.id === a.task) : a.kind === 'go' ? (await api.goDbInfo(p.id)).find((x) => x.dir === a.app)?.tasks.find((x) => x.id === a.task) : (await api.depCommands(p.id)).find((x) => x.id === a.task);
      if (!t) throw new Error(`No task ${String(a.task)}`);
      if (!t.danger) throw new Error('This command is not flagged dangerous: use the ordinary action');
      return { title: `${t.label}?`, facts: [{ label: 'Site', value: p.name }, { label: 'Runs', value: t.command }], page: `site:${p.id}`, typeName: p.domain };
    }, async (a) => {
      const p = await site(a.site);
      const name = typeof a.name === 'string' ? a.name : undefined;
      await (a.kind === 'stack' ? api.stackTask(p.id, String(a.task), name) : a.kind === 'go' ? api.goDbTask(p.id, String(a.app), String(a.task), name) : api.depRun(p.id, String(a.task)));
      return ok({ site: p.name, task: a.task, result: 'Done' });
    }),
  ];

  const git: ChangeAction[] = [
    typed('git_discard', 'Discard changes', 'Throws away the changes in these files; untracked ones are deleted. They cannot be had back.', { site: SITE, files: FILES }, ['site', 'files'], async (a) => {
      const p = await site(a.site);
      const f = a.files as string[];
      return { title: `Throw away the changes in ${f.length === 1 ? f[0] : `${f.length} files`}?`, facts: [{ label: 'Site', value: p.name }, { label: 'Files', value: short(f.join(', ')) }], page: `git:${p.id}`, typeName: f.length === 1 ? f[0] : `${f.length} files` };
    }, async (a) => {
      const p = await site(a.site);
      await api.gitDiscard(p.id, a.files as string[]);
      return ok({ discarded: a.files });
    }),
    typed('git_reset', 'Reset a branch', 'Moves the current branch to a commit. Hard also throws away uncommitted changes.', { site: SITE, mode: { type: 'string', enum: ['soft', 'mixed', 'hard'] }, sha: SHA }, ['site', 'mode', 'sha'], async (a) => {
      const { p, b } = await onBranch(a);
      return { title: `Reset ${b} to ${String(a.sha).slice(0, 10)}?`, facts: [{ label: 'Mode', value: String(a.mode) }, ...fact('Goes', a.mode === 'hard' ? 'uncommitted changes' : null)], page: `git:${p.id}`, typeName: b };
    }, async (a) => {
      const { p, b } = await onBranch(a);
      await api.gitReset(p.id, a.mode as 'soft' | 'mixed' | 'hard', String(a.sha));
      return ok({ branch: b, result: 'Reset' });
    }),
    typed('git_squash', 'Squash commits', "Squashes the branch's commits since it left another branch into one. This rewrites history.", { site: SITE, onto: REF, message: S('The commit message.', 5000) }, ['site', 'onto', 'message'], async (a) => {
      const { p, b } = await onBranch(a);
      return { title: `Squash ${b}?`, facts: [{ label: 'Since', value: String(a.onto) }, { label: 'Message', value: short(String(a.message), 300) }], page: `git:${p.id}`, typeName: b };
    }, async (a) => {
      const { p, b } = await onBranch(a);
      await api.gitSquash(p.id, String(a.onto), String(a.message));
      return ok({ branch: b, result: 'Squashed' });
    }),
    typed('git_amend', 'Amend the last commit', 'Replaces the last commit with what is staged and this message. This rewrites history.', { site: SITE, message: S('The commit message.', 5000) }, ['site', 'message'], async (a) => {
      const { p, b } = await onBranch(a);
      return { title: `Replace the last commit on ${b}?`, facts: [{ label: 'Message', value: short(String(a.message), 300) }], page: `git:${p.id}`, typeName: b };
    }, async (a) => {
      const { p, b } = await onBranch(a);
      await api.gitCommit(p.id, String(a.message), true);
      return ok({ branch: b, result: 'Amended' });
    }),
    typed('git_force_push', 'Force push', "Overwrites the remote branch with this one (with lease). Others' commits there can be lost.", { site: SITE }, ['site'], async (a) => {
      const { p, b } = await onBranch(a);
      return { title: `Force push ${b}?`, facts: [{ label: 'Goes', value: 'commits on the remote that are not here' }], page: `git:${p.id}`, typeName: b };
    }, async (a) => {
      const { p, b } = await onBranch(a);
      await api.gitSync(p.id, 'push-force' as GitSyncAction);
      return ok({ branch: b, result: 'Pushed' });
    }),
    typed('git_branch_delete', 'Delete a branch', 'Deletes a local branch. `force` also deletes one not merged yet, whose commits are then lost.', { site: SITE, name: REF, force: { type: 'boolean' } }, ['site', 'name'], async (a) => {
      const p = await site(a.site);
      return { title: `Delete the branch ${String(a.name)}?`, facts: [{ label: 'Site', value: p.name }, ...fact('Force', a.force === true ? 'yes, unmerged commits are lost' : null)], page: `git:${p.id}`, typeName: String(a.name) };
    }, async (a) => {
      const p = await site(a.site);
      await api.gitBranch(p.id, a.force === true ? 'force-delete' : 'delete', String(a.name));
      return ok({ deleted: a.name });
    }),
    typed('git_tag_delete', 'Delete a tag', 'Deletes a local tag.', { site: SITE, name: REF }, ['site', 'name'], async (a) => {
      const p = await site(a.site);
      return { title: `Delete the tag ${String(a.name)}?`, facts: [{ label: 'Site', value: p.name }], page: `git:${p.id}`, typeName: String(a.name) };
    }, async (a) => {
      const p = await site(a.site);
      await api.gitTag(p.id, 'delete', String(a.name));
      return ok({ deleted: a.name });
    }),
    typed('git_stash_drop', 'Drop a stash', 'Deletes a stash from site_git_stashes.', { site: SITE, stash: { type: 'string', pattern: '^stash@\\{\\d+\\}$' } }, ['site', 'stash'], async (a) => {
      const p = await site(a.site);
      return { title: `Drop ${String(a.stash)}?`, facts: [{ label: 'Site', value: p.name }], page: `git:${p.id}`, typeName: String(a.stash) };
    }, async (a) => {
      const p = await site(a.site);
      await api.gitStash(p.id, 'drop', String(a.stash));
      return ok({ dropped: a.stash });
    }),
    typed('git_restore_file', 'Restore a file from a commit', "Replaces a file with its version in a commit; its current content is lost.", { site: SITE, file: S('The path.', 500), sha: SHA }, ['site', 'file', 'sha'], async (a) => {
      const p = await site(a.site);
      return { title: `Replace ${String(a.file)} with its version in ${String(a.sha).slice(0, 10)}?`, facts: [{ label: 'Site', value: p.name }], page: `git:${p.id}`, typeName: String(a.file) };
    }, async (a) => {
      const p = await site(a.site);
      await api.gitRestoreFile(p.id, String(a.file), String(a.sha));
      return ok({ restored: a.file });
    }),
    asked('git_revert', 'Revert a commit', 'Adds a new commit that undoes one; history stays.', { site: SITE, sha: SHA }, ['site', 'sha'], async (a) => {
      const p = await site(a.site);
      return { title: `Revert ${String(a.sha).slice(0, 10)}?`, facts: [{ label: 'Site', value: p.name }, ...fact('On', await branchOf(p.id))], page: `git:${p.id}` };
    }, async (a) => {
      const p = await site(a.site);
      await api.gitRevert(p.id, String(a.sha));
      return ok({ reverted: a.sha });
    }),
    typed('worktree_remove', 'Remove a worktree', 'Removes a worktree site and its folder. `force` also throws away its uncommitted changes; `dropDatabase` drops its own database.', { site: SITE, force: { type: 'boolean' }, dropDatabase: { type: 'boolean' } }, ['site'], async (a) => {
      const p = await site(a.site);
      if (!p.worktreeOf) throw new Error(`${p.name} is not a worktree`);
      return { title: `Remove the worktree ${p.name}?`, facts: [{ label: 'Folder', value: p.path }, ...fact('Goes too', a.force === true ? 'uncommitted changes' : null), ...fact('And', a.dropDatabase === true ? 'its database' : null)], page: `site:${p.id}`, typeName: p.domain };
    }, async (a) => {
      const p = await site(a.site);
      if (!p.worktreeOf) throw new Error(`${p.name} is not a worktree`);
      await api.worktreeRemove(p.id, a.force === true, a.dropDatabase === true);
      return ok({ removed: p.name });
    }),
    asked('worktree_prune', 'Clean up worktrees', 'Clears Git’s records of worktrees whose folders are gone.', { site: SITE }, ['site'], async (a) => {
      const p = await site(a.site);
      return { title: 'Clean up worktree records?', facts: [{ label: 'Site', value: p.name }], page: `git:${p.id}` };
    }, async (a) => {
      const p = await site(a.site);
      await api.worktreePrune(p.id);
      return ok({ result: 'Pruned' });
    }),
  ];

  const hostOf = (domain: string, tld: string) => `${domain}.${tld || 'localhost'}`;
  /** The installed service to take out: the domain to type, as its page asks, and the call. */
  const uninstallOf = async (ref: unknown) => {
    const s = await state();
    const r = String(ref).trim().toLowerCase();
    const tld = s.settings.tld;
    const by = (x: { kind: string; name: string }) => x.kind.toLowerCase() === r || x.name.toLowerCase() === r;
    const d = s.databases.filter((x) => !x.pending && (x.id.toLowerCase() === r || x.name.toLowerCase() === r));
    if (d.length === 1) return { name: d[0].name, page: `db:${d[0].id}`, typeName: d[0].name, data: d[0].resolvedDataDir, run: (del: boolean) => api.dbRemove(d[0].id, del, d[0].name) };
    const a = s.searchEngines.find(by);
    if (a?.config) { const h = hostOf(a.config.domain, tld); return { name: a.name, page: `services:${a.kind}`, typeName: h, data: a.config.dataDir, run: (del: boolean) => api.searchUninstall(a.kind as SearchKind, del, h) }; }
    const b = s.websockets.find(by);
    if (b?.config) { const h = hostOf(b.config.domain, tld); return { name: b.name, page: 'websocket', typeName: h, data: b.config.dataDir, run: (del: boolean) => api.wsUninstall(b.kind as WsKind, del, h) }; }
    const c = s.storage.find(by);
    if (c?.config && c.urls) { const h = new URL(c.urls.api).hostname; return { name: c.name, page: 'storage', typeName: h, data: c.config.dataDir, run: (del: boolean) => api.storageUninstall(c.kind as StorageKind, del, h) }; }
    const g = s.gateways.find(by);
    if (g?.config) { const h = hostOf(g.config.domain, tld); return { name: g.name, page: `gateways:${g.kind}`, typeName: h, data: g.config.dataDir, run: (del: boolean) => api.gwUninstall(g.kind as GwKind, del, h) }; }
    const w = s.whatsapp.find((x) => x.engine === r || x.name.toLowerCase() === r);
    if (w?.config) { const h = hostOf(w.config.domain, tld); return { name: w.name, page: `gateways:${w.engine}`, typeName: h, data: w.config.dataDir, run: (del: boolean) => api.waUninstall(w.engine as WaEngine, del, h) }; }
    throw new Error(`No installed service ${String(ref)} (list_services shows them)`);
  };
  const search = async (ref: unknown): Promise<SearchKind> => {
    const r = String(ref).trim().toLowerCase();
    const x = (await state()).searchEngines.find((y) => y.kind === r || y.name.toLowerCase() === r);
    if (!x?.installed) throw new Error(`No installed search engine ${String(ref)}`);
    return x.kind;
  };
  const storage = async (ref: unknown): Promise<StorageKind> => {
    const r = String(ref).trim().toLowerCase();
    const x = (await state()).storage.find((y) => y.kind === r || y.name.toLowerCase() === r);
    if (!x?.installed) throw new Error(`No installed object storage ${String(ref)}`);
    return x.kind;
  };
  const RT = { type: 'string', enum: ['node', 'bun', 'go', 'python', 'php'] };

  const services: ChangeAction[] = !scopes.services
    ? []
    : [
        typed('uninstall_service', 'Uninstall a service', 'Stops and removes a service. `deleteData` also deletes its data for good; otherwise the data folder stays.', { service: SERVICE, deleteData: { type: 'boolean' } }, ['service'], async (a) => {
          const x = await uninstallOf(a.service);
          return { title: `Uninstall ${x.name}?`, facts: [a.deleteData === true ? { label: 'Goes', value: `its data, ${x.data}` } : { label: 'Stays', value: `its data, ${x.data}` }], page: x.page, typeName: x.typeName };
        }, async (a) => {
          const x = await uninstallOf(a.service);
          await x.run(a.deleteData === true);
          return ok({ uninstalled: x.name, dataDeleted: a.deleteData === true });
        }),
        typed('uninstall_tunnel_tool', 'Uninstall a tunnel tool', 'Removes cloudflared, ngrok or Expose. Refused while it shares a site.', { tool: { type: 'string', enum: ['cloudflared', 'ngrok', 'expose'] } }, ['tool'], async (a) => {
          const NAMES: Record<string, string> = { cloudflared: 'cloudflared', ngrok: 'ngrok', expose: 'Expose' };
          if (!(await state()).expose.tools[a.tool as ExposeTool]) throw new Error(`${NAMES[String(a.tool)]} is not installed`);
          return { title: `Uninstall ${NAMES[String(a.tool)]}?`, facts: [], page: 'expose', typeName: NAMES[String(a.tool)] };
        }, async (a) => {
          const NAMES: Record<string, string> = { cloudflared: 'cloudflared', ngrok: 'ngrok', expose: 'Expose' };
          await api.exposeUninstall(a.tool as ExposeTool, NAMES[String(a.tool)]);
          return ok({ uninstalled: a.tool });
        }),
        asked('uninstall_runtime', 'Uninstall a runtime version', 'Removes a version of a runtime; install_runtime brings it back. Sites asking for it stop working until then.', { runtime: RT, version: { type: 'string', minLength: 1, maxLength: 40 } }, ['runtime', 'version'], async (a) => {
          const s = await state();
          if (!s[a.runtime as 'node' | 'bun' | 'go' | 'python' | 'php'].installed.some((x) => x.version === a.version)) throw new Error(`${String(a.runtime)} ${String(a.version)} is not installed (list_runtimes shows them)`);
          return { title: `Uninstall ${String(a.runtime)} ${String(a.version)}?`, facts: [{ label: 'Note', value: 'Sites that use it stop working until it is back' }], page: String(a.runtime) };
        }, async (a) => {
          const v = String(a.version);
          await (a.runtime === 'node' ? api.nodeUninstall(v) : a.runtime === 'bun' ? api.bunUninstall(v) : a.runtime === 'go' ? api.goUninstall(v) : a.runtime === 'python' ? api.pythonUninstall(v) : api.phpUninstall(v));
          return ok({ uninstalled: `${String(a.runtime)} ${v}` });
        }),
        asked('uninstall_runtime_tool', 'Uninstall a runtime tool', 'Removes a tool from list_runtime_tools; install_runtime_tool brings it back.', { runtime: { type: 'string', enum: ['node', 'go', 'python'] }, tool: S('An id from list_runtime_tools.', 60) }, ['runtime', 'tool'], async (a) => {
          const t = (await api.toolsState(a.runtime as RuntimeToolRuntime)).find((x) => x.id === a.tool);
          if (!t) throw new Error(`No tool ${String(a.tool)}`);
          return { title: `Uninstall ${t.label}?`, facts: fact('Needed by', t.neededBy.join(', ')), page: `${String(a.runtime)}:tools` };
        }, async (a) => (await api.toolUninstall(a.tool as RuntimeToolId), ok({ uninstalled: a.tool }))),
        asked('uninstall_rust_part', 'Uninstall a Rust toolchain or tool', 'Removes a toolchain or a cargo tool; they can be installed again.', { kind: { type: 'string', enum: ['toolchain', 'tool'] }, name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._-]+$' } }, ['kind', 'name'], (a) => ({ title: `Uninstall the ${String(a.kind)} ${String(a.name)}?`, facts: [], page: 'rust' }), async (a) => {
          await (a.kind === 'toolchain' ? api.rustToolchainUninstall(String(a.name)) : api.rustToolUninstall(a.name as RustToolId));
          return ok({ uninstalled: a.name });
        }),
        asked('remove_php_extension', 'Remove a PHP extension', 'Removes an extension from a PHP version; php_extension brings it back.', { version: { type: 'string', minLength: 1, maxLength: 40 }, extension: S('The module.', 100) }, ['version', 'extension'], (a) => ({ title: `Remove ${String(a.extension)} from PHP ${String(a.version)}?`, facts: [], page: 'php:extensions' }), async (a) => (await api.phpExtRemove(String(a.version), String(a.extension)), ok({ removed: a.extension }))),
        asked('remove_db_build', 'Remove a database build', 'Removes a downloaded server build no service uses; it downloads again when needed. Its data is not touched.', { engine: S('The engine.', 40), version: { type: 'string', minLength: 1, maxLength: 40 } }, ['engine', 'version'], (a) => ({ title: `Remove the ${String(a.engine)} ${String(a.version)} build?`, facts: [], page: 'database' }), async (a) => (await api.dbBuildAction(a.engine as DbEngine, String(a.version), 'remove'), ok({ removed: `${String(a.engine)} ${String(a.version)}` }))),
        typed('search_delete_index', 'Delete a search index', 'Deletes an index and its documents.', { service: SERVICE, index: S('The index.', 100) }, ['service', 'index'], async (a) => {
          const k = await search(a.service);
          const i = (await api.searchIndexes(k)).find((x) => x.name === a.index);
          if (!i) throw new Error(`No index ${String(a.index)}`);
          return { title: `Delete the index ${i.name}?`, facts: [{ label: 'Goes', value: `${i.docs} documents` }], page: `services:${k}`, typeName: i.name };
        }, async (a) => (await api.searchDeleteIndex(await search(a.service), String(a.index)), ok({ deleted: a.index }))),
        typed('search_delete_document', 'Delete a search document', 'Deletes one document from an index.', { service: SERVICE, index: S('The index.', 100), id: S('Its id.') }, ['service', 'index', 'id'], async (a) => {
          const k = await search(a.service);
          return { title: `Delete the document ${String(a.id)}?`, facts: [{ label: 'From', value: String(a.index) }], page: `services:${k}`, typeName: String(a.id) };
        }, async (a) => (await api.searchDeleteDoc(await search(a.service), String(a.index), String(a.id)), ok({ deleted: a.id }))),
        typed('search_restore_backup', 'Restore a search backup', 'Replaces what the engine holds now with a dump or snapshot from search_backups.', { service: SERVICE, name: S('A name from search_backups.', 300) }, ['service', 'name'], async (a) => {
          const k = await search(a.service);
          const b = (await api.searchBackups(k)).find((x) => x.name === a.name);
          if (!b) throw new Error(`No backup ${String(a.name)}`);
          return { title: `Restore ${b.name}?`, facts: [{ label: 'Goes', value: 'what the engine holds now' }], page: `services:${k}`, typeName: b.name };
        }, async (a) => {
          const k = await search(a.service);
          const b = (await api.searchBackups(k)).find((x) => x.name === a.name);
          if (!b) throw new Error(`No backup ${String(a.name)}`);
          await api.searchRestoreBackup(k, b.file);
          return ok({ restored: b.name });
        }),
        typed('search_delete_backup', 'Delete a search backup', 'Deletes a dump or snapshot.', { service: SERVICE, name: S('A name from search_backups.', 300) }, ['service', 'name'], async (a) => {
          const k = await search(a.service);
          const b = (await api.searchBackups(k)).find((x) => x.name === a.name);
          if (!b) throw new Error(`No backup ${String(a.name)}`);
          return { title: `Delete the backup ${b.name}?`, facts: [], page: `services:${k}`, typeName: b.name };
        }, async (a) => {
          const k = await search(a.service);
          const b = (await api.searchBackups(k)).find((x) => x.name === a.name);
          if (!b) throw new Error(`No backup ${String(a.name)}`);
          await api.searchDeleteBackup(k, b.file);
          return ok({ deleted: b.name });
        }),
        typed('search_delete_key', 'Delete a search API key', 'Deletes a key; whatever uses it stops working.', { service: SERVICE, id: S('An id from search_keys.') }, ['service', 'id'], async (a) => {
          const k = await search(a.service);
          const x = (await api.searchKeys(k)).find((y) => y.id === a.id);
          if (!x) throw new Error(`No key ${String(a.id)}`);
          return { title: `Delete the key ${x.name ?? x.id}?`, facts: [{ label: 'Note', value: 'What uses it stops working' }], page: `services:${k}`, typeName: x.name ?? x.id };
        }, async (a) => (await api.searchDeleteKey(await search(a.service), String(a.id)), ok({ deleted: a.id }))),
        asked('search_clear_tasks', 'Clear finished search tasks', "Clears a search engine's list of finished tasks; the data stays.", { service: SERVICE }, ['service'], async (a) => ({ title: 'Clear the finished tasks?', facts: [], page: `services:${await search(a.service)}` }), async (a) => (await api.searchClearTasks(await search(a.service)), ok({ result: 'Cleared' }))),
        typed('scout_flush', 'Flush a Laravel Scout index', "Removes a site's records from its search engine; scout_command import brings them back from the database.", { site: SITE, model: { type: 'string', maxLength: 200 } }, ['site'], async (a) => {
          const p = await site(a.site);
          return { title: `Flush the search records of ${p.name}?`, facts: fact('Model', a.model), page: 'search', typeName: p.domain };
        }, async (a) => {
          const p = await site(a.site);
          return ok({ output: await api.scoutCommand(p.id, 'flush', typeof a.model === 'string' ? a.model : null) });
        }),
        typed('storage_delete_bucket', 'Delete a bucket', 'Deletes a bucket and everything in it.', { service: SERVICE, bucket: S('The bucket.', 63) }, ['service', 'bucket'], async (a) => {
          const k = await storage(a.service);
          if (!(await api.s3Buckets(k)).some((b) => b.name === a.bucket)) throw new Error(`No bucket ${String(a.bucket)}`);
          return { title: `Delete the bucket ${String(a.bucket)}?`, facts: [{ label: 'Goes', value: 'everything in it' }], page: 'storage', typeName: String(a.bucket) };
        }, async (a) => (await api.s3DeleteBucket(await storage(a.service), String(a.bucket)), ok({ deleted: a.bucket }))),
        typed('storage_delete', 'Delete a file in a bucket', 'Deletes a file, or a folder and all under it.', { service: SERVICE, bucket: S('The bucket.', 63), key: S('Its key from storage_list.', 1000) }, ['service', 'bucket', 'key'], async (a) => {
          await storage(a.service);
          return { title: `Delete ${String(a.key)}?`, facts: [{ label: 'From', value: String(a.bucket) }], page: 'storage', typeName: String(a.key) };
        }, async (a) => (await api.s3Delete(await storage(a.service), String(a.bucket), String(a.key)), ok({ deleted: a.key }))),
      ];

  const messages: ChangeAction[] = !scopes.messages
    ? []
    : [
        typed('mail_delete', 'Delete caught mail', 'Deletes these caught mails.', { ids: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', maxLength: 200 } } }, ['ids'], (a) => {
          const n = (a.ids as string[]).length;
          return { title: `Delete ${n} caught mail(s)?`, facts: [], page: 'mail', typeName: `${n} mail` };
        }, async (a) => (await api.mailDelete(a.ids as string[]), ok({ deleted: (a.ids as string[]).length }))),
        typed('mail_delete_all', 'Delete all caught mail', 'Empties the mail catcher, every site’s mail included, shared or not.', {}, [], async () => {
          const n = (await state()).mail.count;
          return { title: `Delete all ${n} caught mails?`, facts: [{ label: 'Note', value: 'Every site’s, shared or not' }], page: 'mail', typeName: 'all mail' };
        }, async () => (await api.mailDeleteAll(), ok({ result: 'Emptied' }))),
        asked('clear_caught', 'Clear caught messages', 'Clears the test SMS caught, the WhatsApp message log, or the requests recorded for a share.', { what: { type: 'string', enum: ['sms', 'whatsapp', 'share'] }, share: S('For share: an id from list_shares.') }, ['what'], async (a) => {
          if (a.what === 'share') {
            const x = (await state()).expose.shares.find((y) => y.id === a.share);
            if (!x || !scopes.site(x.siteId)) throw new Error('No such share among the shared sites');
          }
          return { title: `Clear ${{ sms: 'the caught SMS', whatsapp: 'the WhatsApp message log', share: "this share's recorded requests" }[String(a.what)]}?`, facts: [], page: a.what === 'share' ? 'expose' : 'whatsapp' };
        }, async (a) => {
          await (a.what === 'sms' ? api.gwClearSms() : a.what === 'whatsapp' ? api.waClearMessages() : api.exposeClearRequests(String(a.share)));
          return ok({ cleared: a.what });
        }),
        typed('whatsapp_remove_session', 'Remove a WhatsApp session', 'Deletes a session and its login; the phone must be linked again.', { engine: SERVICE, session: S('Its name.', 100) }, ['engine', 'session'], (a) => ({ title: `Remove the session ${String(a.session)}?`, facts: [{ label: 'Note', value: 'The phone must be linked again' }], page: 'whatsapp', typeName: String(a.session) }), async (a) => {
          const r = String(a.engine).trim().toLowerCase();
          const w = (await state()).whatsapp.find((x) => x.engine === r || x.name.toLowerCase() === r);
          if (!w?.installed) throw new Error(`No installed WhatsApp gateway ${String(a.engine)}`);
          await api.waSessionRemove(w.engine, String(a.session));
          return ok({ removed: a.session });
        }),
        asked('whatsapp_remove_hook', 'Remove a WhatsApp webhook', 'Removes a webhook of a shared site.', { hook: S('An id from whatsapp_hooks.') }, ['hook'], async (a) => {
          const h = (await api.waHooks()).find((x) => x.id === a.hook && scopes.site(x.siteId));
          if (!h) throw new Error(`No webhook ${String(a.hook)} among the shared sites`);
          return { title: 'Remove this webhook?', facts: [{ label: 'Site', value: h.siteName }, { label: 'URL', value: h.url }], page: 'whatsapp' };
        }, async (a) => (await api.waRemoveHook(String(a.hook)), ok({ removed: a.hook }))),
      ];

  return [...sites, ...git, ...services, ...messages];
}
