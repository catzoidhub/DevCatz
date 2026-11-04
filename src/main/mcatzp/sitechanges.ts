import type { CallResult } from '@catzoid/mcatzp-host';
import type { DbAction, HerdApi, LinkOptions, PhpIniSettings, RuntimeKind, RustToolId } from '@shared/types';
import { findSite, inBackground, type ChangeAction, type Scopes } from './actions';

/**
 * Changes on the Projects and Runtimes pages: linking and setting up sites, ports, builds, dependencies, framework tasks,
 * sidebar organisation, default runtimes, Rust, PHP. A task flagged dangerous (migrate:fresh, removing data) waits for
 * the destructive tier, which asks for the name typed.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SITE = { type: 'string', minLength: 1, maxLength: 200, description: "The site's id, name or domain (see list_sites)." };
const S = (description: string, maxLength = 200) => ({ type: 'string', minLength: 1, maxLength, description });
const APP = S("An app's folder from get_site, '.' for a single app.");
const VERSION = { type: 'string', minLength: 1, maxLength: 40 };
const ok = (data: unknown): CallResult => ({ text: JSON.stringify(data, null, 2), data });
type Fact = { label: string; value: string };
const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);

/** Settings a client may change on a site (the site's Settings tab); nothing that holds a secret. */
const SITE_FIELDS = {
  name: { type: 'string', minLength: 1, maxLength: 100 },
  domain: { type: 'string', minLength: 1, maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' },
  devCommand: { type: 'string', maxLength: 500 },
  autoStart: { type: 'boolean' },
  managedPorts: { type: 'boolean' },
  secure: { type: 'boolean' },
  queueWorker: { type: 'boolean' },
  scheduler: { type: 'boolean' },
  reverb: { type: 'boolean' },
  packageManager: { type: 'string', enum: ['bun', 'pnpm', 'yarn', 'npm'] },
  nodeVersion: VERSION,
  phpVersion: VERSION,
  goVersion: VERSION,
  pythonVersion: VERSION,
};

export function siteChanges(api: HerdApi, scopes: Scopes): ChangeAction[] {
  if (!scopes.changes) return [];
  const site = async (ref: unknown) => {
    const { projects } = await api.getState();
    const id = findSite(projects, String(ref));
    return projects.find((p) => p.id === id)!;
  };
  type Site = Awaited<ReturnType<typeof site>>;
  const onSite = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], ask: (p: Site, a: Record<string, unknown>) => Promise<{ title: string; facts: Fact[] }> | { title: string; facts: Fact[] }, run: (p: Site, a: Record<string, unknown>, ctx: Parameters<ChangeAction['run']>[1]) => Promise<CallResult>, allowSession = false): ChangeAction => ({
    name,
    title,
    description: `${description} DevCatz asks the user first.`,
    tier: 'change',
    allowSession,
    input: OBJECT({ site: SITE, ...props }, ['site', ...required]),
    preview: async (a) => {
      const p = await site(a.site);
      const q = await ask(p, a);
      return { ...q, facts: [{ label: 'Site', value: p.name }, ...q.facts], page: `site:${p.id}` };
    },
    run: async (a, ctx) => run(await site(a.site), a, ctx),
  });
  const global = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], page: string, ask: (a: Record<string, unknown>) => Promise<{ title: string; facts: Fact[] }> | { title: string; facts: Fact[] }, run: (a: Record<string, unknown>, ctx: Parameters<ChangeAction['run']>[1]) => Promise<CallResult>): ChangeAction => ({
    name,
    title,
    description: `${description} DevCatz asks the user first.`,
    tier: 'change',
    input: OBJECT(props, required),
    preview: async (a) => ({ ...(await ask(a)), page }),
    run,
  });
  const running = (s: string) => `Still running: ${s}`;

  const sites: ChangeAction[] = [
    global('link_site', 'Link a folder as a site', 'Links a project folder as a new site. A folder inside a parked one appears by itself.', { path: S('The folder.', 500), name: { type: 'string', maxLength: 100 }, domain: { type: 'string', maxLength: 253, pattern: '^[A-Za-z0-9.-]+$' }, start: { type: 'boolean' } }, ['path'], 'projects', async (a) => {
      const f = await api.inspectFolder(String(a.path));
      if (f.alreadyLinked) throw new Error('This folder is already a site');
      return { title: `Link ${String(a.name ?? f.name)} as a site?`, facts: [{ label: 'Folder', value: f.path }, { label: 'Domain', value: String(a.domain ?? f.domain) }, ...fact('Apps', f.stack.apps.map((x) => `${x.name} (${x.framework})`).join(', ')), ...fact('Then', a.start === true ? 'starts it' : null)] };
    }, async (a) => {
      const o: LinkOptions = { ...(typeof a.name === 'string' ? { name: a.name } : {}), ...(typeof a.domain === 'string' ? { domain: a.domain } : {}), ...(a.start === true ? { start: true } : {}) };
      const p = await api.linkProject(String(a.path), o);
      return ok({ site: p?.name ?? null, id: p?.id ?? null, domain: p?.domain ?? null, note: 'Share it in Settings → MCatzP for a client to see it' });
    }),
    global('park_folder', 'Park a folder', 'Makes every project in a folder a site, including new ones; optionally gathers them in a sidebar group.', { path: S('The folder.', 500), group: { type: 'string', maxLength: 100 } }, ['path'], 'projects', (a) => ({ title: 'Park this folder?', facts: [{ label: 'Folder', value: String(a.path) }, ...fact('Group', a.group)] }), async (a) => (await api.parkFolder(String(a.path), typeof a.group === 'string' ? a.group : null), ok({ parked: a.path }))),
    global('park_restore', 'Restore a parked site', 'Brings back a site removed from a parked folder.', { path: S('The folder of the site.', 500) }, ['path'], 'projects', (a) => ({ title: 'Bring this site back?', facts: [{ label: 'Folder', value: String(a.path) }] }), async (a) => (await api.parkRestore(String(a.path)), ok({ restored: a.path }))),
    global('locate_missing_site', 'Point a missing site at a folder', 'A linked site whose folder is gone (see get_status): uses a new folder for it, or links that folder as a new site.', { id: S('The id of the missing site.'), path: S('The folder.', 500), mode: { type: 'string', enum: ['use', 'link'] } }, ['id', 'path', 'mode'], 'projects', async (a) => {
      const m = (await api.getState()).missingSites.find((x) => x.id === a.id);
      if (!m) throw new Error(`No missing site ${String(a.id)}`);
      return { title: `${a.mode === 'use' ? 'Use this folder for' : 'Link this folder beside'} ${m.name}?`, facts: [{ label: 'Was', value: m.path }, { label: 'Folder', value: String(a.path) }] };
    }, async (a) => ok({ site: await api.missingLocateApply(String(a.id), String(a.path), a.mode as 'use' | 'link') })),
    onSite('update_site', 'Change site settings', "Changes a site's settings: name, domain, dev command, autostart, ports, HTTPS, worker, scheduler, runtime versions.", { set: { type: 'object', minProperties: 1, properties: SITE_FIELDS, additionalProperties: false } }, ['set'], (_p, a) => ({ title: 'Change these settings?', facts: Object.entries(a.set as Record<string, unknown>).map(([k, v]) => ({ label: k, value: String(v) })) }), async (p, a) => (await api.updateProject(p.id, a.set as never), ok({ site: p.name, set: a.set }))),
    onSite('set_app_subdomain', "Change an app's subdomain", "Sets the subdomain one app of the site answers on; empty goes back to the default.", { app: APP, subdomain: { type: 'string', maxLength: 63, pattern: '^[a-z0-9-]*$' } }, ['app', 'subdomain'], (_p, a) => ({ title: `Serve ${String(a.app)} on ${String(a.subdomain) || 'its default'}?`, facts: [] }), async (p, a) => (await api.setAppSubdomain(p.id, String(a.app), String(a.subdomain) || null), ok({ app: a.app, subdomain: a.subdomain }))),
    onSite('set_app_port', "Change an app's port", 'Sets the port of one app, optionally writing it to its .env.', { app: APP, port: { type: 'integer', minimum: 1024, maximum: 65535 }, writeEnv: { type: 'boolean' } }, ['app', 'port'], async (p, a) => {
      const used = await api.sitePortUse(p.id, String(a.app), Number(a.port));
      if (used) throw new Error(`Port ${String(a.port)} is used by ${used}`);
      return { title: `Use port ${String(a.port)} for ${String(a.app)}?`, facts: fact('Also', a.writeEnv === true ? 'writes it to .env' : null) };
    }, async (p, a) => ok({ app: a.app, port: a.port, files: await api.setSitePort(p.id, String(a.app), Number(a.port), a.writeEnv === true) })),
    onSite('restart_app', 'Restart one app', 'Restarts one app of a running site.', { app: APP }, ['app'], (_p, a) => ({ title: `Restart ${String(a.app)}?`, facts: [] }), async (p, a) => (await api.restartApp(p.id, String(a.app)), ok({ app: a.app, result: 'Restarted' })), true),
    onSite('build_site', 'Build a site', 'Runs a build from site_build_targets. Output goes to site_logs.', { target: S("An id from site_build_targets; 'all' for every app.") }, ['target'], async (p, a) => {
      const t = (await api.buildTargets(p.id)).find((x) => x.id === a.target);
      if (!t) throw new Error(`No build target ${String(a.target)} (site_build_targets shows them)`);
      return { title: `Build ${t.label}?`, facts: [{ label: 'Runs', value: t.command }] };
    }, async (p, a, ctx) => inBackground(api, ctx, api.buildSite(p.id, String(a.target)), async () => undefined, { site: p.name, target: a.target }, 'Built', running('site_logs shows it'), () => null)),
    onSite('install_deps', 'Install dependencies', "Installs the site's dependencies (npm, composer, uv, go …). Output goes to site_logs.", {}, [], () => ({ title: 'Install the dependencies?', facts: [] }), async (p, _a, ctx) => inBackground(api, ctx, api.installDeps(p.id), async () => undefined, { site: p.name }, 'Installed', running('site_logs shows it'), () => null)),
    onSite('run_dep_command', 'Run a dependency command', 'Runs a command from site_dep_commands (update, audit …). One flagged dangerous is refused until the destructive tier.', { command: S('An id from site_dep_commands.') }, ['command'], async (p, a) => {
      const c = (await api.depCommands(p.id)).find((x) => x.id === a.command);
      if (!c) throw new Error(`No command ${String(a.command)} (site_dep_commands shows them)`);
      if (c.danger) throw new Error('This command is flagged dangerous: run it from the site in DevCatz');
      return { title: `${c.label}?`, facts: [{ label: 'Runs', value: c.command }] };
    }, async (p, a, ctx) => {
      const c = (await api.depCommands(p.id)).find((x) => x.id === a.command);
      if (!c || c.danger) throw new Error('Not allowed');
      return inBackground(api, ctx, api.depRun(p.id, c.id), async () => undefined, { site: p.name, command: c.label }, 'Done', running('site_logs shows it'), () => null);
    }),
    onSite('run_stack_task', 'Run a framework command', "Runs one of the site's framework commands from get_site `tasks` (migrate, seed …). One flagged dangerous is refused until the destructive tier.", { task: S('A task id.'), name: { type: 'string', maxLength: 200 } }, ['task'], (p, a) => {
      const t = p.stack.tasks?.find((x) => x.id === a.task);
      if (!t) throw new Error(`No task ${String(a.task)} (get_site lists them)`);
      if (t.danger) throw new Error('This task is flagged dangerous: run it from the site in DevCatz');
      return { title: `${t.label}?`, facts: [{ label: 'Runs', value: t.command }, ...fact('Name', a.name)] };
    }, async (p, a, ctx) => {
      const t = p.stack.tasks?.find((x) => x.id === a.task);
      if (!t || t.danger) throw new Error('Not allowed');
      return inBackground(api, ctx, api.stackTask(p.id, t.id, typeof a.name === 'string' ? a.name : undefined), async () => undefined, { site: p.name, task: t.label }, 'Done', running('site_logs shows it'), () => null);
    }),
    onSite('run_go_db_task', 'Run a Go database task', 'Runs a task from site_go_db. One flagged dangerous is refused until the destructive tier.', { app: APP, task: S('A task id from site_go_db.'), name: { type: 'string', maxLength: 200 } }, ['app', 'task'], async (p, a) => {
      const t = (await api.goDbInfo(p.id)).find((x) => x.dir === a.app)?.tasks.find((x) => x.id === a.task);
      if (!t) throw new Error(`No task ${String(a.task)} (site_go_db shows them)`);
      if (t.danger) throw new Error('This task is flagged dangerous: run it from the site in DevCatz');
      return { title: `${t.label}?`, facts: [{ label: 'Runs', value: t.command }] };
    }, async (p, a, ctx) => {
      const t = (await api.goDbInfo(p.id)).find((x) => x.dir === a.app)?.tasks.find((x) => x.id === a.task);
      if (!t || t.danger) throw new Error('Not allowed');
      return inBackground(api, ctx, api.goDbTask(p.id, String(a.app), t.id, typeof a.name === 'string' ? a.name : undefined), async () => undefined, { site: p.name, task: t.label }, 'Done', running('site_logs shows it'), () => null);
    }),
    onSite('site_database', "Run a site's database action", "Starts or stops the site's own database, or runs a safe task on it (migrate, seed, generate). Reset and fresh wait for the destructive tier.", { action: { type: 'string', enum: ['start', 'stop', 'migrate', 'seed', 'generate', 'redis-start', 'redis-stop', 'artisan-migrate', 'artisan-seed'] } }, ['action'], (_p, a) => ({ title: `${String(a.action)} the site's database?`, facts: [] }), async (p, a, ctx) => inBackground(api, ctx, api.db(p.id, a.action as DbAction), async () => undefined, { site: p.name, action: a.action }, 'Done', running('site_logs shows it'), () => null)),
    onSite('redis_write_env', 'Write the Redis settings', "Writes the site's chosen Redis database numbers to its .env.", {}, [], async (p) => {
      const plan = await api.redisWriteEnv(p.id, false);
      return { title: `Change ${plan.file}?`, facts: [...fact('Adds', plan.added.join(', ')), ...fact('Changes', plan.changed.map((c) => c.key).join(', '))] };
    }, async (p) => {
      const r = await api.redisWriteEnv(p.id, true);
      return ok({ file: r.file, added: r.added, changed: r.changed.map((c) => c.key) });
    }),
    onSite('repair_electron', 'Repair Electron', 'Downloads the Electron binary a site is missing.', {}, [], () => ({ title: 'Repair Electron for this site?', facts: [] }), async (p, _a, ctx) => inBackground(api, ctx, api.repairElectron(p.id), async () => undefined, { site: p.name }, 'Repaired', running('site_logs shows it'), () => null)),
    onSite('clear_site_logs', 'Clear site logs', "Clears a site's log view.", {}, [], () => ({ title: "Clear this site's logs?", facts: [] }), async (p) => (await api.clearLogs(p.id), ok({ site: p.name, result: 'Cleared' }))),
    onSite('set_site_favorite', 'Favorite a site', 'Pins a site at the top of the sidebar, or unpins it.', { on: { type: 'boolean' } }, ['on'], (_p, a) => ({ title: a.on ? 'Add to favorites?' : 'Remove from favorites?', facts: [] }), async (p, a) => (await api.setFavorite(p.id, a.on === true), ok({ site: p.name, favorite: a.on })), true),
    onSite('set_site_group', "Change a site's group", 'Moves a site into a sidebar group (made when new), or out of every group when left out.', { group: { type: 'string', minLength: 1, maxLength: 100 } }, [], (_p, a) => ({ title: typeof a.group === 'string' ? `Move to the group ${a.group}?` : 'Take out of its group?', facts: [] }), async (p, a) => (await api.setSiteGroup(p.id, typeof a.group === 'string' ? a.group : null), ok({ site: p.name, group: a.group ?? null })), true),
    global('rename_site_group', 'Rename a site group', 'Renames a sidebar group.', { from: S('Its name.', 100), to: S('The new name.', 100) }, ['from', 'to'], 'projects', (a) => ({ title: `Rename the group ${String(a.from)} to ${String(a.to)}?`, facts: [] }), async (a) => (await api.renameGroup(String(a.from), String(a.to)), ok({ group: a.to }))),
    global('delete_site_group', 'Delete a site group', 'Deletes a sidebar group. Its sites stay, out of any group.', { name: S('Its name.', 100) }, ['name'], 'projects', async (a) => {
      const g = (await api.getState()).settings.siteGroups.find((x) => x.name === a.name);
      if (!g) throw new Error(`No group ${String(a.name)}`);
      return { title: `Delete the group ${g.name}?`, facts: [{ label: 'Its sites', value: `${g.sites.length} stay, out of any group` }] };
    }, async (a) => (await api.deleteGroup(String(a.name)), ok({ deleted: a.name }))),
    global('start_all_sites', 'Start the shared sites', 'Starts every site shared with MCatzP.', {}, [], 'projects', async () => {
      const list = (await api.getState()).projects.filter((p) => scopes.site(p.id) && p.status !== 'running');
      return { title: `Start ${list.length} site(s)?`, facts: fact('Sites', list.map((p) => p.name).join(', ').slice(0, 300)) };
    }, async () => {
      const list = (await api.getState()).projects.filter((p) => scopes.site(p.id) && p.status !== 'running');
      const r = await Promise.allSettled(list.map((p) => api.start(p.id)));
      return ok({ started: list.filter((_, i) => r[i].status === 'fulfilled').map((p) => p.name), failed: list.filter((_, i) => r[i].status === 'rejected').map((p) => p.name) });
    }),
    global('stop_all_sites', 'Stop the shared sites', 'Stops every site shared with MCatzP.', {}, [], 'projects', async () => {
      const list = (await api.getState()).projects.filter((p) => scopes.site(p.id) && p.status === 'running');
      return { title: `Stop ${list.length} site(s)?`, facts: fact('Sites', list.map((p) => p.name).join(', ').slice(0, 300)) };
    }, async () => {
      const list = (await api.getState()).projects.filter((p) => scopes.site(p.id) && p.status === 'running');
      await Promise.allSettled(list.map((p) => api.stop(p.id)));
      return ok({ stopped: list.map((p) => p.name) });
    }),
  ];

  const RT = { type: 'string', enum: ['node', 'bun', 'go', 'python', 'php'] };
  const runtimes: ChangeAction[] = !scopes.services
    ? []
    : [
        global('set_default_runtime', 'Set a default runtime version', 'Sets which installed version a runtime uses by default; left out, none.', { runtime: RT, version: VERSION }, ['runtime'], 'runtimes', (a) => ({ title: `Use ${String(a.version ?? 'no default')} for ${String(a.runtime)}?`, facts: [] }), async (a) => {
          const v = typeof a.version === 'string' ? a.version : null;
          await (a.runtime === 'node' ? api.nodeSetDefault(v) : a.runtime === 'bun' ? api.bunSetDefault(v) : a.runtime === 'go' ? api.goSetDefault(v) : a.runtime === 'python' ? api.pythonSetDefault(v) : api.phpSetDefault(v));
          return ok({ runtime: a.runtime, default: v });
        }),
        global('update_runtime', 'Update a runtime', 'Installs the newer patch release of an installed runtime (see list_updates).', { runtime: { type: 'string', enum: ['node', 'bun', 'go', 'php'] }, from: VERSION }, ['runtime', 'from'], 'runtimes', (a) => ({ title: `Update ${String(a.runtime)} ${String(a.from)}?`, facts: [] }), async (a, ctx) => inBackground(api, ctx, api.runtimeUpdate(a.runtime as RuntimeKind, String(a.from)), () => api.installCancel(String(a.runtime)), { runtime: a.runtime }, 'Updated', 'Still updating: list_updates shows it; only cancel_install stops it', () => null)),
        global('check_updates', 'Check for updates', 'Asks for new versions of runtimes, tools and services; then list_updates shows them.', {}, [], 'runtimes', () => ({ title: 'Check for updates now?', facts: [{ label: 'Note', value: 'Goes online for each runtime and service' }] }), async () => {
          await Promise.allSettled([api.checkUpdates(), api.servicesCheckUpdates(), api.gwCheckUpdates(), api.waCheckUpdates(), api.exposeCheckUpdates(), api.rustToolsCheck()]);
          return ok({ result: 'Checked: list_updates shows them' });
        }),
        global('refresh_runtimes', 'Look for runtimes again', 'Looks again for installed runtimes, and for sites in parked folders.', {}, [], 'runtimes', () => ({ title: 'Look for runtimes and sites again?', facts: [] }), async () => {
          await Promise.all([api.refreshRuntimes(), api.rescan()]);
          return ok({ result: 'Done' });
        }),
        global('install_uv', 'Install uv', 'Installs uv, which then installs Pythons and creates venvs.', {}, [], 'python', () => ({ title: 'Install uv?', facts: [] }), async (_a, ctx) => inBackground(api, ctx, api.uvInstall(), () => api.installCancel('python'), { tool: 'uv' }, 'Installed', 'Still installing: list_runtimes shows it', () => null)),
        global('install_composer', 'Install Composer', 'Installs Composer for PHP.', {}, [], 'php', () => ({ title: 'Install Composer?', facts: [] }), async (_a, ctx) => inBackground(api, ctx, api.composerInstall(), () => api.installCancel('composer'), { tool: 'composer' }, 'Installed', 'Still installing: list_runtimes shows it', () => null)),
        global('php_extension', 'Install or switch a PHP extension', 'Installs an extension for a PHP version, or switches one on or off (see php_extensions).', { version: VERSION, action: { type: 'string', enum: ['install', 'enable', 'disable'] }, extension: S('The package or module name.', 100) }, ['version', 'action', 'extension'], 'php:extensions', (a) => ({ title: `${String(a.action)} ${String(a.extension)} on PHP ${String(a.version)}?`, facts: [] }), async (a, ctx) => {
          if (a.action === 'install') return inBackground(api, ctx, api.phpExtInstall(String(a.version), String(a.extension)), () => api.installCancel('php'), { extension: a.extension }, 'Installed', 'Still installing: php_extensions shows it', () => null);
          await api.phpExtSetEnabled(String(a.version), String(a.extension), a.action === 'enable');
          return ok({ extension: a.extension, result: String(a.action) });
        }),
        global('php_set_ini', 'Change PHP settings', 'Changes settings of a PHP version (php_ini shows them); the rest stay. PHP restarts for the sites using it.', { version: VERSION, set: { type: 'object', minProperties: 1, additionalProperties: false, properties: Object.fromEntries(['memory_limit', 'upload_max_filesize', 'post_max_size', 'max_execution_time', 'max_input_vars', 'display_errors', 'error_reporting', 'date.timezone', 'opcache.enable'].map((k) => [k, { type: 'string', maxLength: 100 }])) } }, ['version', 'set'], 'php:ini', (a) => ({ title: `Change PHP ${String(a.version)} settings?`, facts: Object.entries(a.set as Record<string, string>).map(([k, v]) => ({ label: k, value: v })) }), async (a) => {
          const { settings } = await api.phpGetIni(String(a.version));
          await api.phpSetIni(String(a.version), { ...settings, ...(a.set as Partial<PhpIniSettings>) });
          return ok({ version: a.version, set: a.set });
        }),
        global('restart_php', 'Restart PHP', "Restarts DevCatz's PHP servers.", {}, [], 'php', () => ({ title: 'Restart PHP?', facts: [{ label: 'Note', value: 'PHP sites stop answering for a moment' }] }), async () => (await api.restartServices(), ok({ result: 'Restarted' }))),
        global('install_rust', 'Install Rust', 'Installs Rust the standard way (rustup, into ~/.rustup and ~/.cargo).', {}, [], 'rust', () => ({ title: 'Install Rust?', facts: [] }), async (_a, ctx) => inBackground(api, ctx, api.rustInstall(), () => api.installCancel('rust'), { tool: 'rust' }, 'Installed', 'Still installing: rust_status shows it; only cancel_install stops it', () => null)),
        global('rust_toolchain', 'Install or choose a Rust toolchain', 'Installs a toolchain, makes one the default, or adds a build target (see rust_status).', { action: { type: 'string', enum: ['install', 'default', 'add_target'] }, name: { type: 'string', minLength: 1, maxLength: 100, pattern: '^[A-Za-z0-9._-]+$' } }, ['action', 'name'], 'rust', (a) => ({ title: `${{ install: 'Install the toolchain', default: 'Use by default', add_target: 'Add the target' }[String(a.action)]} ${String(a.name)}?`, facts: [] }), async (a, ctx) => {
          const n = String(a.name);
          if (a.action === 'install') return inBackground(api, ctx, api.rustToolchainInstall(n), () => api.installCancel('rust'), { toolchain: n }, 'Installed', 'Still installing: rust_status shows it', () => null);
          await (a.action === 'default' ? api.rustSetDefault(n) : api.rustTargetAdd(n));
          return ok({ name: n, result: String(a.action) });
        }),
        global('install_rust_tool', 'Install a Rust tool', 'Installs or updates a cargo tool from rust_status; `linker` installs the fast linker.', { tool: { type: 'string', enum: ['trunk', 'dioxus-cli', 'cargo-leptos', 'tauri-cli', 'solana', 'anchor', 'sqlx-cli', 'sea-orm-cli', 'diesel-cli', 'linker'] } }, ['tool'], 'rust', (a) => ({ title: `Install ${String(a.tool)}?`, facts: [{ label: 'Note', value: 'May compile for minutes' }] }), async (a, ctx) => inBackground(api, ctx, a.tool === 'linker' ? api.rustInstallLinker() : api.rustToolInstall(a.tool as RustToolId), () => api.installCancel('rust'), { tool: a.tool }, 'Installed', 'Still installing: rust_status shows it', () => null)),
        global('set_shim_path', 'node and npm on PATH', "Puts DevCatz's node, npm and npx on the shell's PATH, or takes them off.", { on: { type: 'boolean' } }, ['on'], 'node', (a) => ({ title: a.on ? "Put DevCatz's Node on your PATH?" : "Take DevCatz's Node off your PATH?", facts: [] }), async (a) => (await api.shimPathSet(a.on === true), ok({ on: a.on }))),
        global('set_launch_at_login', 'Start at login', 'Starts DevCatz when the user logs in, or not.', { on: { type: 'boolean' } }, ['on'], 'settings', (a) => ({ title: a.on ? 'Start DevCatz at login?' : 'Stop starting DevCatz at login?', facts: [] }), async (a) => (await api.setLaunchAtLogin(a.on === true), ok({ on: a.on }))),
        global('set_default_domain', 'Change the default domain', 'Changes the domain suffix of every site (e.g. localhost to test); some need the resolver set up in DevCatz.', { tld: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9-]+$' } }, ['tld'], 'settings', async (a) => {
          const c = await api.setTld(String(a.tld), true);
          return { title: `Change the default domain from ${c.from} to ${c.to}?`, facts: fact('Renames', c.renamed.map((r) => r.to).join(', ').slice(0, 300)) };
        }, async (a) => ok(await api.setTld(String(a.tld)))),
        global('restart_dns', 'Restart DNS', "Restarts DevCatz's local DNS.", {}, [], 'settings', () => ({ title: 'Restart the local DNS?', facts: [] }), async () => ok({ running: await api.restartDns() })),
        global('set_db_favorite', 'Favorite a database', 'Pins a database service at the top of its list, or unpins it.', { service: S('An id from list_services.'), on: { type: 'boolean' } }, ['service', 'on'], 'database', (a) => ({ title: a.on ? 'Add to favorites?' : 'Remove from favorites?', facts: [{ label: 'Service', value: String(a.service) }] }), async (a) => (await api.dbSetFavorite(String(a.service), a.on === true), ok({ service: a.service, favorite: a.on }))),
        global('set_db_group', "Change a database's group", 'Moves a database service into a group, or out when left out.', { service: S('An id from list_services.'), group: { type: 'string', minLength: 1, maxLength: 100 } }, ['service'], 'database', (a) => ({ title: typeof a.group === 'string' ? `Move to the group ${a.group}?` : 'Take out of its group?', facts: [{ label: 'Service', value: String(a.service) }] }), async (a) => (await api.dbSetGroup(String(a.service), typeof a.group === 'string' ? a.group : null), ok({ service: a.service, group: a.group ?? null }))),
        global('delete_db_group', 'Delete a database group', 'Deletes a group of database services. They stay, out of any group.', { name: S('Its name.', 100) }, ['name'], 'database', async (a) => {
          const g = (await api.getState()).settings.dbGroups.find((x) => x.name === a.name);
          if (!g) throw new Error(`No group ${String(a.name)}`);
          return { title: `Delete the group ${g.name}?`, facts: [{ label: 'Its services', value: `${g.sites.length} stay, out of any group` }] };
        }, async (a) => (await api.dbGroupAction(String(a.name), 'delete'), ok({ deleted: a.name }))),
        global('rename_db_group', 'Rename a database group', 'Renames a group of database services.', { from: S('Its name.', 100), to: S('The new name.', 100) }, ['from', 'to'], 'database', (a) => ({ title: `Rename the group ${String(a.from)} to ${String(a.to)}?`, facts: [] }), async (a) => (await api.dbGroupAction(String(a.from), 'rename', String(a.to)), ok({ group: a.to }))),
      ];

  return [...sites, ...runtimes];
}
