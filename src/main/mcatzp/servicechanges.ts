import type { CallResult } from '@catzoid/mcatzp-host';
import type { DbServiceInput, ExposeProvider, ExposeTool, GwKind, HerdApi, SearchKind, StorageKind, WaEngine, WsKind } from '@shared/types';
import { findSite, inBackground, type ChangeAction, type Scopes } from './actions';
import { maskDeep } from './mask';

/**
 * Changes on the service pages: settings and upgrades, search, object storage, mail, gateways, Expose. What leaves this
 * computer for someone else (a WhatsApp message, an email, a public share) always asks, showing who and what, and can never
 * be allowed for a session. A file picker or save dialog only makes sense in the window, so those stay in the app.
 */
const OBJECT = (properties: Record<string, unknown> = {}, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
const SITE = { type: 'string', minLength: 1, maxLength: 200, description: "The site's id, name or domain (see list_sites)." };
const S = (description: string, maxLength = 200) => ({ type: 'string', minLength: 1, maxLength, description });
const SERVICE = S('A kind or name from list_services.');
const ok = (data: unknown): CallResult => ({ text: JSON.stringify(data, null, 2), data });
const masked = (data: unknown): CallResult => ({ text: maskDeep(JSON.stringify(data, null, 2)) });
type Fact = { label: string; value: string };
const fact = (label: string, value: unknown): Fact[] => (value === null || value === undefined || value === '' ? [] : [{ label, value: String(value) }]);
const short = (text: string, max = 300) => (text.length > max ? `${text.slice(0, max)}…` : text);

export function serviceChanges(api: HerdApi, scopes: Scopes): ChangeAction[] {
  if (!scopes.changes) return [];
  const state = () => api.getState();
  const act = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], ask: (a: Record<string, unknown>) => Promise<{ title: string; facts: Fact[]; page: string }> | { title: string; facts: Fact[]; page: string }, run: ChangeAction['run'], allowSession = false): ChangeAction => ({ name, title, description: `${description} DevCatz asks the user first.`, tier: 'change', allowSession, input: OBJECT(props, required), preview: async (a) => ask(a), run });
  const stop = (name: string, title: string, description: string, props: Record<string, unknown>, required: string[], run: ChangeAction['run']): ChangeAction => ({ name, title, description: `${description} Runs at once, without a dialog.`, tier: 'change', noDialog: true, input: OBJECT(props, required), preview: async () => ({ title: '', facts: [], page: '' }), run });

  /** Any installed service, with how to change it. Port, domain and autostart only: keys and passwords stay with the user. */
  const serviceOf = async (ref: unknown) => {
    const s = await state();
    const r = String(ref).trim().toLowerCase();
    const by = (x: { kind: string; name: string }) => x.kind.toLowerCase() === r || x.name.toLowerCase() === r;
    const db = s.databases.filter((d) => !d.pending && (d.id.toLowerCase() === r || d.name.toLowerCase() === r));
    if (db.length === 1) {
      const d = db[0];
      return { name: d.name, page: `db:${d.id}`, port: d.port, domain: null as string | null, autoStart: d.autoStart, update: (c: Set) => api.dbUpdate(d.id, { ...toInput(d), ...(c.port ? { port: c.port } : {}), ...(c.autoStart !== undefined ? { autoStart: c.autoStart } : {}) }), upgrade: null as null | (() => Promise<void>) };
    }
    const a = s.searchEngines.find(by);
    if (a?.config) return { name: a.name, page: `services:${a.kind}`, port: a.config.port, domain: a.config.domain, autoStart: a.config.autoStart, update: (c: Set) => api.searchUpdate(a.kind, { ...a.config!, ...c }), upgrade: () => api.searchUpgrade(a.kind) };
    const b = s.websockets.find(by);
    if (b?.config) return { name: b.name, page: 'websocket', port: b.config.port, domain: b.config.domain, autoStart: b.config.autoStart, update: (c: Set) => api.wsUpdate(b.kind, { ...b.config!, ...c }), upgrade: () => api.wsUpgrade(b.kind) };
    const d = s.storage.find(by);
    if (d?.config) return { name: d.name, page: 'storage', port: d.config.apiPort, domain: d.config.apiDomain, autoStart: d.config.autoStart, update: (c: Set) => api.storageUpdate(d.kind, { ...d.config!, ...(c.port ? { apiPort: c.port } : {}), ...(c.domain ? { apiDomain: c.domain } : {}), ...(c.autoStart !== undefined ? { autoStart: c.autoStart } : {}) }), upgrade: () => api.storageUpgrade(d.kind) };
    const g = s.gateways.find(by);
    if (g?.config) return { name: g.name, page: `gateways:${g.kind}`, port: g.config.port, domain: g.config.domain, autoStart: g.config.autoStart, update: (c: Set) => api.gwUpdate(g.kind, { ...g.config!, ...c }), upgrade: () => api.gwUpgrade(g.kind) };
    const w = s.whatsapp.find((x) => x.engine === r || x.name.toLowerCase() === r);
    if (w?.config) return { name: w.name, page: `gateways:${w.engine}`, port: w.config.port, domain: w.config.domain, autoStart: w.config.autoStart, update: (c: Set) => api.waUpdate(w.engine, { ...w.config!, ...c }), upgrade: () => api.waUpgrade(w.engine) };
    throw new Error(`No installed service ${String(ref)} (list_services shows them)`);
  };
  type Set = { port?: number; domain?: string; autoStart?: boolean };
  const toInput = (d: Awaited<ReturnType<HerdApi['getState']>>['databases'][number]): DbServiceInput => ({ engine: d.engine, version: d.version, name: d.name, port: d.port, socket: d.socket, dataDir: d.dataDir, configFile: d.configFile, disableBinLog: d.disableBinLog, autoStart: d.autoStart, user: d.user, password: d.password });
  const pick = async <K extends string>(list: (s: Awaited<ReturnType<typeof state>>) => { kind: K; name: string; installed: boolean }[], ref: unknown, what: string): Promise<K> => {
    const r = String(ref).trim().toLowerCase();
    const x = list(await state()).find((y) => y.kind.toLowerCase() === r || y.name.toLowerCase() === r);
    if (!x) throw new Error(`No ${what} ${String(ref)} (list_services shows them)`);
    if (!x.installed) throw new Error(`${x.name} is not installed`);
    return x.kind;
  };
  const search = (ref: unknown) => pick<SearchKind>((s) => s.searchEngines, ref, 'search engine');
  const ws = (ref: unknown) => pick<WsKind>((s) => s.websockets, ref, 'WebSocket server');
  const storage = (ref: unknown) => pick<StorageKind>((s) => s.storage, ref, 'object storage');
  const gateway = (ref: unknown) => pick<GwKind>((s) => s.gateways, ref, 'gateway');
  const wa = (ref: unknown) => pick<WaEngine>((s) => s.whatsapp.map((w) => ({ kind: w.engine, name: w.name, installed: w.installed })), ref, 'WhatsApp gateway');
  const siteId = async (ref: unknown) => findSite((await state()).projects, String(ref));
  const BUCKET = { type: 'string', minLength: 3, maxLength: 63, pattern: '^[a-z0-9][a-z0-9.-]*[a-z0-9]$' };
  const noop = async () => undefined;

  const services: ChangeAction[] = !scopes.services
    ? []
    : [
        act('update_service', 'Change a service', "Changes a service's port, domain or autostart. Keys and passwords stay with the user.", { service: SERVICE, set: { type: 'object', minProperties: 1, additionalProperties: false, properties: { port: { type: 'integer', minimum: 1024, maximum: 65535 }, domain: { type: 'string', minLength: 1, maxLength: 63, pattern: '^[a-z0-9.-]+$' }, autoStart: { type: 'boolean' } } } }, ['service', 'set'], async (a) => {
          const x = await serviceOf(a.service);
          return { title: `Change ${x.name}?`, facts: Object.entries(a.set as Record<string, unknown>).map(([k, v]) => ({ label: k, value: `${String((x as Record<string, unknown>)[k] ?? '')} → ${String(v)}` })), page: x.page };
        }, async (a) => {
          const x = await serviceOf(a.service);
          await x.update(a.set as Set);
          return ok({ service: x.name, set: a.set });
        }),
        act('upgrade_service', 'Upgrade a service', 'Moves a service to its newer release (see list_updates); its data stays. Runs while the service restarts.', { service: SERVICE }, ['service'], async (a) => {
          const x = await serviceOf(a.service);
          if (!x.upgrade) throw new Error(`${x.name} is upgraded by making a new service of a newer version`);
          return { title: `Upgrade ${x.name}?`, facts: [{ label: 'Note', value: 'It restarts; its data stays' }], page: x.page };
        }, async (a, ctx) => {
          const x = await serviceOf(a.service);
          if (!x.upgrade) throw new Error(`${x.name} is upgraded by making a new service of a newer version`);
          return inBackground(api, ctx, x.upgrade(), noop, { service: x.name }, 'Upgraded', 'Still upgrading: list_services shows it', () => null);
        }),
        act('search_create_index', 'Create a search index', 'Creates an index on a search engine, with a schema where the engine needs one.', { service: SERVICE, name: S('Its name.', 100), schema: { type: 'string', maxLength: 100000 } }, ['service', 'name'], (a) => ({ title: `Create the index ${String(a.name)}?`, facts: fact('Schema', a.schema ? short(String(a.schema), 200) : null), page: `services:${String(a.service)}` }), async (a) => (await api.searchCreateIndex(await search(a.service), String(a.name), typeof a.schema === 'string' ? a.schema : ''), ok({ index: a.name, result: 'Created' }))),
        act('search_save_settings', 'Change index settings', "Replaces a search index's settings (search_settings shows them).", { service: SERVICE, index: S('The index.', 100), settings: { type: 'string', minLength: 1, maxLength: 200000 } }, ['service', 'index', 'settings'], (a) => ({ title: `Change the settings of ${String(a.index)}?`, facts: [{ label: 'Settings', value: short(String(a.settings), 300) }], page: `services:${String(a.service)}` }), async (a) => (await api.searchSaveSettings(await search(a.service), String(a.index), String(a.settings)), ok({ index: a.index, result: 'Saved' }))),
        act('search_add_documents', 'Add search documents', 'Adds or replaces documents in an index, given as JSON.', { service: SERVICE, index: S('The index.', 100), documents: { type: 'string', minLength: 1, maxLength: 1000000 } }, ['service', 'index', 'documents'], (a) => ({ title: `Add documents to ${String(a.index)}?`, facts: [{ label: 'Size', value: `${String(a.documents).length} characters` }, { label: 'Starts', value: short(String(a.documents), 200) }], page: `services:${String(a.service)}` }), async (a) => ok({ index: a.index, documents: await api.searchUpsert(await search(a.service), String(a.index), String(a.documents)) })),
        stop('search_cancel_tasks', 'Cancel search tasks', 'Cancels tasks waiting in a search engine (see search_tasks).', { service: SERVICE, tasks: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'integer', minimum: 0 } } }, ['service', 'tasks'], async (a) => (await api.searchCancelTasks(await search(a.service), a.tasks as number[]), ok({ cancelled: a.tasks }))),
        act('search_create_backup', 'Back up a search engine', 'Makes a dump or snapshot (see search_backups).', { service: SERVICE, type: { type: 'string', enum: ['dump', 'snapshot'] } }, ['service', 'type'], (a) => ({ title: `Make a ${String(a.type)}?`, facts: [{ label: 'Service', value: String(a.service) }], page: `services:${String(a.service)}` }), async (a) => (await api.searchCreateBackup(await search(a.service), a.type as 'dump' | 'snapshot'), ok({ result: 'Started: search_backups shows it' }))),
        act('search_create_key', 'Create a search API key', 'Creates an API key on a search engine. Its value stays in DevCatz (the Keys tab): site_service_env is how a site gets one.', { service: SERVICE, name: S('Its name.', 100), actions: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', maxLength: 60 } }, indexes: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', maxLength: 100 } }, expiresAt: { type: 'string', maxLength: 40 } }, ['service', 'name', 'actions', 'indexes'], (a) => ({ title: `Create the key ${String(a.name)}?`, facts: [{ label: 'May', value: (a.actions as string[]).join(', ') }, { label: 'On', value: (a.indexes as string[]).join(', ') }, ...fact('Until', a.expiresAt)], page: `services:${String(a.service)}` }), async (a) => {
          const k = await api.searchCreateKey(await search(a.service), String(a.name), a.actions as string[], a.indexes as string[], typeof a.expiresAt === 'string' ? a.expiresAt : null);
          return ok({ id: k.id, name: k.name, actions: k.actions, indexes: k.indexes, expiresAt: k.expiresAt });
        }),
        act('scout_command', 'Run a Laravel Scout command', 'Imports or syncs a Laravel site with its search engine. Flush waits for the destructive tier.', { site: SITE, command: { type: 'string', enum: ['import', 'sync'] }, model: { type: 'string', maxLength: 200 } }, ['site', 'command'], (a) => ({ title: `Scout ${String(a.command)}?`, facts: [...fact('Model', a.model)], page: 'search' }), async (a) => ok({ output: maskDeep(await api.scoutCommand(await siteId(a.site), a.command as 'import' | 'sync', typeof a.model === 'string' ? a.model : null)) })),
        act('websocket_publish', 'Publish a WebSocket event', 'Publishes an event to a channel of a WebSocket server, for testing.', { service: SERVICE, channel: S('The channel.'), event: S('The event.'), data: { type: 'string', maxLength: 100000 } }, ['service', 'channel', 'event'], (a) => ({ title: `Publish to ${String(a.channel)}?`, facts: [{ label: 'Event', value: String(a.event) }, ...fact('Data', a.data ? short(String(a.data), 200) : null)], page: 'websocket' }), async (a) => (await api.wsPublish(await ws(a.service), String(a.channel), String(a.event), typeof a.data === 'string' ? a.data : ''), ok({ result: 'Published' })), true),
        act('laravel_broadcast_test', 'Test a Laravel broadcast', "Fires a test broadcast through a Laravel site's own broadcaster.", { site: SITE, type: { type: 'string', enum: ['public', 'private', 'presence'] }, channel: S('The channel.'), event: S('The event.'), payload: { type: 'string', maxLength: 100000 } }, ['site', 'type', 'channel', 'event'], (a) => ({ title: `Broadcast on ${String(a.channel)}?`, facts: [{ label: 'Type', value: String(a.type) }, { label: 'Event', value: String(a.event) }], page: 'websocket' }), async (a) => ok({ output: maskDeep(await api.laravelTestBroadcast(await siteId(a.site), a.type as 'public', String(a.channel), String(a.event), typeof a.payload === 'string' ? a.payload : '{}')) })),
        act('storage_create_bucket', 'Create a bucket', 'Creates a bucket on an object storage service.', { service: SERVICE, bucket: BUCKET }, ['service', 'bucket'], (a) => ({ title: `Create the bucket ${String(a.bucket)}?`, facts: [], page: 'storage' }), async (a) => (await api.s3CreateBucket(await storage(a.service), String(a.bucket)), ok({ bucket: a.bucket, result: 'Created' }))),
        act('storage_set_public', 'Make a bucket public or private', 'Lets anyone who can reach the service read a bucket, or stops that.', { service: SERVICE, bucket: BUCKET, public: { type: 'boolean' } }, ['service', 'bucket', 'public'], (a) => ({ title: `Make ${String(a.bucket)} ${a.public ? 'public' : 'private'}?`, facts: a.public ? [{ label: 'Note', value: 'Anyone who can reach this service can read it' }] : [], page: 'storage' }), async (a) => (await api.s3SetPublic(await storage(a.service), String(a.bucket), a.public === true), ok({ bucket: a.bucket, public: a.public }))),
        act('storage_make_folder', 'Make a folder in a bucket', 'Makes a folder under a prefix of a bucket.', { service: SERVICE, bucket: BUCKET, prefix: S('The folder path.', 500) }, ['service', 'bucket', 'prefix'], (a) => ({ title: `Make ${String(a.prefix)} in ${String(a.bucket)}?`, facts: [], page: 'storage' }), async (a) => (await api.s3MkDir(await storage(a.service), String(a.bucket), String(a.prefix)), ok({ result: 'Made' }))),
        act('storage_upload', 'Upload files to a bucket', 'Uploads files or folders from this computer. The dialog names each one.', { service: SERVICE, bucket: BUCKET, prefix: { type: 'string', maxLength: 500 }, paths: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'string', minLength: 1, maxLength: 1000 } } }, ['service', 'bucket', 'paths'], (a) => ({ title: `Upload to ${String(a.bucket)}?`, facts: [{ label: 'Files', value: short((a.paths as string[]).join(', ')) }, ...fact('Under', a.prefix)], page: 'storage' }), async (a, ctx) => {
          const k = await storage(a.service);
          return inBackground(api, ctx, api.s3Upload(k, String(a.bucket), typeof a.prefix === 'string' ? a.prefix : '', a.paths as string[]), () => api.s3CancelUpload(k), { bucket: a.bucket }, 'Uploaded', 'Still uploading: storage_list shows it; only storage_cancel_upload stops it', () => null);
        }),
        stop('storage_cancel_upload', 'Cancel an upload', 'Stops an upload in progress.', { service: SERVICE }, ['service'], async (a) => (await api.s3CancelUpload(await storage(a.service)), ok({ result: 'Cancelled' }))),
        act('import_databases', 'Copy a database from another app', 'Copies a database from a server another app runs (list_external_databases) into a DevCatz service; the original stays. Only for a server that needs no password: with one, the user does it in DevCatz.', { target: SERVICE, engine: { type: 'string', enum: ['mysql', 'mariadb', 'postgresql'] }, port: { type: 'integer', minimum: 1, maximum: 65535 }, user: S('The user there.', 100), database: S('The database.', 100) }, ['target', 'engine', 'port', 'user', 'database'], async (a) => {
          const t = (await state()).databases.find((d) => d.id === a.target || d.name === a.target);
          if (!t) throw new Error(`No database service ${String(a.target)}`);
          const list = await api.dbImportList(t.id, { engine: a.engine as 'mysql', port: Number(a.port), user: String(a.user), password: '', label: 'MCatzP' });
          const c = list.find((x) => x.name === a.database);
          if (!c) throw new Error(`No database ${String(a.database)} there: ${list.map((x) => x.name).join(', ')}`);
          if (c.exists) throw new Error(`${t.name} already has a database ${String(a.database)}`);
          return { title: `Copy ${String(a.database)} into ${t.name}?`, facts: [{ label: 'From', value: `${String(a.engine)} on port ${String(a.port)}` }, ...fact('Size', c.bytes ? `${Math.round(c.bytes / 1048576)} MB` : null)], page: `db:${t.id}` };
        }, async (a, ctx) => {
          const t = (await state()).databases.find((d) => d.id === a.target || d.name === a.target);
          if (!t) throw new Error(`No database service ${String(a.target)}`);
          return inBackground(api, ctx, api.dbImportOne(t.id, { engine: a.engine as 'mysql', port: Number(a.port), user: String(a.user), password: '', label: 'MCatzP' }, String(a.database)), noop, { database: a.database, into: t.name }, 'Copied', 'Still copying: list_databases shows it', () => null);
        }),
      ];

  const TOOL = { type: 'string', enum: ['cloudflared', 'ngrok', 'expose'] };
  const expose: ChangeAction[] = [
    act('expose_install', 'Install a tunnel tool', 'Installs or upgrades cloudflared, ngrok or Expose.', { tool: TOOL }, ['tool'], async (a) => {
      const have = (await state()).expose.tools[a.tool as ExposeTool];
      return { title: `${have ? 'Upgrade' : 'Install'} ${String(a.tool)}?`, facts: fact('Now', have), page: 'expose' };
    }, async (a, ctx) => {
      const have = (await state()).expose.tools[a.tool as ExposeTool];
      return inBackground(api, ctx, have ? api.exposeUpgrade(a.tool as ExposeTool) : api.exposeInstall(a.tool as ExposeTool), () => api.exposeCancelInstall(), { tool: a.tool }, 'Installed', 'Still installing: list_shares shows it; only expose_cancel_install stops it', () => null);
    }),
    stop('expose_cancel_install', 'Cancel a tunnel tool install', 'Stops the install in progress.', {}, [], async () => (await api.exposeCancelInstall(), ok({ result: 'Cancelled' }))),
    act('share_site', 'Share a site publicly', 'Opens a public URL to a site through a tunnel. Anyone with the URL reaches it. A password and an expiry are for the user to weigh in the dialog.', { site: SITE, provider: { type: 'string', enum: ['cloudflare', 'cloudflare-domain', 'ngrok', 'expose'] }, password: { type: 'string', minLength: 4, maxLength: 200 }, expiryMinutes: { type: 'integer', minimum: 1, maximum: 10080 } }, ['site'], async (a) => {
      const id = await siteId(a.site);
      const p = (await state()).projects.find((x) => x.id === id)!;
      return { title: `Put ${p.name} on the internet?`, facts: [{ label: 'Site', value: p.domain }, { label: 'Who', value: a.password ? 'Anyone with the URL and the password' : 'Anyone with the URL' }, ...fact('Through', a.provider), { label: 'Ends', value: a.expiryMinutes ? `after ${String(a.expiryMinutes)} minutes` : 'by the default in Settings → Expose' }], page: 'expose' };
    }, async (a) => {
      const r = await api.exposeStart({ siteId: await siteId(a.site), ...(a.provider ? { provider: a.provider as ExposeProvider } : {}), ...(typeof a.password === 'string' ? { auth: `share:${a.password}` } : {}), ...(typeof a.expiryMinutes === 'number' ? { expiryMinutes: a.expiryMinutes } : {}) });
      return ok({ id: r.id, status: r.status, url: r.url, user: typeof a.password === 'string' ? 'share' : null, expiresAt: r.expiresAt });
    }),
    stop('stop_share', 'Stop a share', 'Closes a public share of a shared site (see list_shares).', { share: S('An id from list_shares.') }, ['share'], async (a) => {
      const share = (await state()).expose.shares.find((x) => x.id === a.share);
      if (!share || !scopes.site(share.siteId)) throw new Error('No such share among the shared sites');
      await api.exposeStop(share.id);
      return ok({ share: share.id, result: 'Stopped' });
    }),
  ];

  const messages: ChangeAction[] = !scopes.messages
    ? []
    : [
        act('mail_mark_read', 'Mark caught mail read', 'Marks caught mail read or unread.', { ids: { type: 'array', minItems: 1, maxItems: 200, items: { type: 'string', maxLength: 200 } }, read: { type: 'boolean' } }, ['ids', 'read'], (a) => ({ title: `Mark ${(a.ids as string[]).length} mail(s) ${a.read ? 'read' : 'unread'}?`, facts: [], page: 'mail' }), async (a) => (await api.mailMarkRead(a.ids as string[], a.read === true), ok({ ids: a.ids, read: a.read })), true),
        act('mail_forward', 'Forward a caught mail', 'Sends a caught mail on to a real address, through the forwarding account in Settings → Mail. It leaves this computer.', { id: S('An id from mail_list.'), to: { type: 'string', minLength: 3, maxLength: 320, pattern: '^[^\\s@]+@[^\\s@]+$' } }, ['id', 'to'], async (a) => {
          const m = await api.mailGet(String(a.id));
          if (!(m.siteId ? scopes.site(m.siteId) : scopes.allSites)) throw new Error('This mail belongs to a site that is not shared');
          return { title: 'Send this mail out?', facts: [{ label: 'To', value: String(a.to) }, { label: 'Subject', value: m.subject }, ...fact('Starts', m.text ? short(maskDeep(m.text), 200) : null)], page: 'mail' };
        }, async (a) => (await api.mailForward(String(a.id), String(a.to)), ok({ result: 'Sent', to: a.to }))),
        act('mail_send_test', 'Send a test mail', 'Sends a test mail into the mail catcher; it stays on this computer.', { site: SITE }, [], (a) => ({ title: 'Send a test mail to the catcher?', facts: fact('Site', a.site), page: 'mail' }), async (a) => (await api.mailSendTest(a.site ? await siteId(a.site) : null), ok({ result: 'Sent' }))),
        act('gateway_send', 'Send through a gateway', 'Sends an email, push or SMS through an installed gateway. It may leave this computer.', { service: SERVICE, to: S('The receiver.', 320), subject: { type: 'string', maxLength: 300 }, text: { type: 'string', minLength: 1, maxLength: 20000 }, from: { type: 'string', maxLength: 320 } }, ['service', 'to', 'text'], async (a) => {
          const k = await gateway(a.service);
          return { title: `Send through ${k}?`, facts: [{ label: 'To', value: String(a.to) }, ...fact('From', a.from), ...fact('Subject', a.subject), { label: 'Text', value: short(String(a.text), 400) }], page: `gateways:${k}` };
        }, async (a) => {
          const r = await api.gwSend(await gateway(a.service), { to: String(a.to), subject: typeof a.subject === 'string' ? a.subject : '', text: String(a.text), ...(typeof a.from === 'string' ? { from: a.from } : {}) });
          return masked({ status: r.status, response: r.response });
        }),
        act('whatsapp_session', 'Start or log out a WhatsApp session', 'Starts a session (the QR to scan stays in DevCatz) or logs one out.', { engine: SERVICE, session: S('Its name.', 100), action: { type: 'string', enum: ['start', 'logout'] } }, ['engine', 'session', 'action'], async (a) => {
          const k = await wa(a.engine);
          return { title: `${a.action === 'start' ? 'Start' : 'Log out'} the session ${String(a.session)}?`, facts: a.action === 'start' ? [{ label: 'Note', value: 'You scan the QR here in DevCatz' }] : [], page: `gateways:${k}` };
        }, async (a) => {
          const k = await wa(a.engine);
          await (a.action === 'start' ? api.waSessionStart(k, String(a.session)) : api.waSessionLogout(k, String(a.session)));
          return ok({ session: a.session, result: String(a.action) });
        }),
        act('whatsapp_send', 'Send a WhatsApp message', 'Sends a text message to a real person or group from a connected session. It leaves this computer. Text only: a file goes from DevCatz.', { engine: SERVICE, session: S('A session from whatsapp_sessions.', 100), to: S('The number or chat id.', 100), text: { type: 'string', minLength: 1, maxLength: 10000 } }, ['engine', 'session', 'to', 'text'], async (a) => {
          const k = await wa(a.engine);
          return { title: 'Send this WhatsApp message?', facts: [{ label: 'To', value: String(a.to) }, { label: 'From', value: String(a.session) }, { label: 'Text', value: short(String(a.text), 500) }], page: `gateways:${k}` };
        }, async (a) => {
          const r = await api.waSend(await wa(a.engine), { session: String(a.session), to: String(a.to), kind: 'text', text: String(a.text) });
          return masked({ status: r.status, response: r.response });
        }),
        act('whatsapp_set_hook', 'Set a WhatsApp webhook', 'Adds or changes a webhook for a shared site. Its secret is not returned.', { id: { type: 'string', maxLength: 100 }, site: SITE, url: S('The URL.', 500), events: { type: 'array', minItems: 1, maxItems: 30, items: { type: 'string', maxLength: 60 } }, enabled: { type: 'boolean' } }, ['site', 'url', 'events'], (a) => ({ title: `${a.id ? 'Change' : 'Add'} this webhook?`, facts: [{ label: 'Site', value: String(a.site) }, { label: 'URL', value: String(a.url) }, { label: 'Events', value: (a.events as string[]).join(', ') }], page: 'whatsapp' }), async (a) => {
          const h = await api.waSetHook({ ...(typeof a.id === 'string' ? { id: a.id } : {}), siteId: await siteId(a.site), url: String(a.url), events: a.events as string[], enabled: a.enabled !== false });
          return ok({ id: h.id, url: h.url, events: h.events, enabled: h.enabled });
        }),
        act('whatsapp_replay', 'Replay a webhook delivery', 'Sends a webhook delivery again (see whatsapp_deliveries).', { delivery: S('A delivery id.') }, ['delivery'], (a) => ({ title: 'Send this delivery again?', facts: [{ label: 'Delivery', value: String(a.delivery) }], page: 'whatsapp' }), async (a) => {
          const d = await api.waReplay(String(a.delivery));
          return masked({ id: d.id, status: d.status, ms: d.ms, error: d.error });
        }),
        act('expose_replay', 'Replay a request', 'Sends a request that came through a share again, to the local site (see expose_requests).', { share: S('An id from list_shares.'), request: S('An id from expose_requests.') }, ['share', 'request'], async (a) => {
          const share = (await state()).expose.shares.find((x) => x.id === a.share);
          if (!share || !scopes.site(share.siteId)) throw new Error('No such share among the shared sites');
          return { title: 'Send this request again?', facts: [{ label: 'Site', value: share.siteName }, { label: 'Request', value: String(a.request) }], page: 'expose' };
        }, async (a) => {
          const share = (await state()).expose.shares.find((x) => x.id === a.share);
          if (!share || !scopes.site(share.siteId)) throw new Error('No such share among the shared sites');
          const r = await api.exposeReplay(share.id, String(a.request));
          return masked({ id: r.id, method: r.method, path: r.path, status: r.status, ms: r.ms });
        }),
      ];

  return [...services, ...expose, ...messages];
}
