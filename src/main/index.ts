import { aiSettings, migrateAiToShared, setAiKey, setAiSettings } from './ai/settings';
import { readShared, siteBase, watchShared, writeShared } from './shared';
// First: moves the MrCatz Herd data folder before store/herd read it.
import './migrate';
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, Notification, shell } from 'electron';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { loadShellEnv, run } from './env';
import { Herd } from './herd';
import { setStatusPageIcon } from './proxy';
import { store } from './store';
import { screenshotDataUrl } from './screenshots';
import { HerdTray } from './tray';
import { dockerStatus, startEngine } from './docker';
import { etcDir } from './php';
import * as s3 from './s3';
import { ENGINES } from './storage';
import { SearchManager } from './search';
import * as gitHosts from './githosts';
import { MIGRATION_FLAG } from './migrate';
import { API_METHODS, type HerdApi, type LogLine, type ReportKind, type S3UploadProgress, type Settings, type TaskProgress, type GwKind, type SearchKind, type StorageKind, type WaEngine, type WsKind } from '@shared/types';
import { uninstall, uninstallPlan, UNINSTALL_STEPS } from './uninstall';
import { isMac, isWin } from './platform';
import { openWeb, refreshBrowsers, refreshEditorIcons } from './browsers';
import { words } from '@shared/platform';

app.setName('DevCatz');

if (!app.requestSingleInstanceLock()) {
  app.quit();
}

const RESOURCES = app.isPackaged ? process.resourcesPath : join(__dirname, '../../resources');
const EDITORS = ['Visual Studio Code', 'Cursor', 'Zed', 'WebStorm', 'PhpStorm', 'Sublime Text', 'Nova'];

let herd: Herd;
let win: BrowserWindow | null = null;
let tray: HerdTray | null = null;
let quitting = false;

function editorPath(e: string): string | null {
  return [`/Applications/${e}.app`, `${app.getPath('home')}/Applications/${e}.app`].find((p) => existsSync(p)) ?? null;
}
function installedEditors(): string[] {
  // Windows, stage 1: no editor list; Open in Editor uses VS Code's `code` command when it is on the Path.
  if (isWin) return [];
  return EDITORS.filter((e) => editorPath(e) !== null);
}
/** Browsers, the system default and the editors' icons (Settings → Open with); true when anything changed. */
async function refreshApps(): Promise<boolean> {
  const a = await refreshBrowsers();
  const b = await refreshEditorIcons(installedEditors().map((name) => ({ name, path: editorPath(name)! })));
  return a || b;
}

/**
 * After the data folder moved (migrate.ts): php.ini files carry absolute
 * paths, and the login item still points at the old app bundle.
 */
async function finishMigration(): Promise<void> {
  const flag = join(app.getPath('userData'), MIGRATION_FLAG);
  if (!existsSync(flag)) return;
  try {
    await herd.rewriteManagedFiles();
    const items = await run('osascript', ['-e', 'tell application "System Events" to get the name of every login item'], { timeout: 10_000 });
    if (items.stdout.includes('MrCatz Herd')) {
      await run('osascript', ['-e', 'tell application "System Events" to delete login item "MrCatz Herd"'], { timeout: 10_000 });
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: true });
    }
    console.log('Finished the MrCatz Herd → DevCatz migration');
  } catch (err) {
    console.error('Migration follow-up failed:', err);
  } finally {
    rmSync(flag, { force: true });
  }
}

/** Mirrors console output of the main process into logs/main.log (kept under ~1 MB). */
function setupLogFile(): void {
  const dir = join(app.getPath('userData'), 'logs');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'main.log');
  try {
    if (statSync(file).size > 1_000_000) renameSync(file, `${file}.1`);
  } catch {
    /* no log yet */
  }
  const write = (level: string, args: unknown[]) => {
    const text = args.map((a) => (a instanceof Error ? a.stack : typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
    try {
      appendFileSync(file, `${new Date().toISOString()} ${level} ${text}\n`);
    } catch {
      /* disk full or permissions: logging is best effort */
    }
  };
  for (const level of ['log', 'warn', 'error'] as const) {
    const original = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      original(...args);
      write(level, args);
    };
  }
  // Logged, and sent as an error report when crash reports are on (Catzoid #65).
  process.on('uncaughtException', (err) => {
    console.error('uncaught:', err);
    herd?.reports.error('error', 'main', err?.message ?? String(err), err?.stack);
  });
  process.on('unhandledRejection', (err) => {
    console.error('unhandled rejection:', err);
    const e = err as Error | undefined;
    herd?.reports.error('error', 'main', e?.message ?? String(err), e?.stack);
  });
}

function loginState() {
  return { launchAtLogin: app.getLoginItemSettings().openAtLogin, packaged: app.isPackaged };
}

/** Navigation for a window that is still loading; the renderer collects it after start-up. */
let pendingNav: string | null = null;

/** Shows the window, optionally at `sites`, `settings`, `new-site` or `site:<id>`. */
function showWindow(target?: string): void {
  const fresh = !win || win.isDestroyed();
  if (fresh) createWindow();
  app.dock?.show();
  win!.show();
  win!.focus();
  if (!target) return;
  if (fresh || win!.webContents.isLoading()) pendingNav = target;
  else win!.webContents.send('herd:navigate', target);
}

/**
 * Windows: the minimize / maximize / close buttons sit on a neutral block in the theme's colours (on the page's own
 * background they vanished in dark mode); repainted when the theme changes.
 */
function titleBarOverlay(): { color: string; symbolColor: string; height: number } {
  return nativeTheme.shouldUseDarkColors ? { color: '#2b2d34', symbolColor: '#e5e7eb', height: 40 } : { color: '#e7e8ec', symbolColor: '#1f2937', height: 40 };
}
if (isWin) nativeTheme.on('updated', () => win && !win.isDestroyed() && win.setTitleBarOverlay(titleBarOverlay()));

function createWindow(): void {
  win = new BrowserWindow({
    width: 1120,
    height: 740,
    minWidth: 860,
    minHeight: 520,
    show: false,
    title: 'DevCatz',
    ...(isWin
      ? {
          // Windows: the page draws its own title strip; the system buttons sit over it on the right.
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: titleBarOverlay(),
          backgroundColor: nativeTheme.shouldUseDarkColors ? '#1d1f24' : '#f6f7f9',
        }
      : {
          titleBarStyle: 'hiddenInset' as const,
          // Inside the 96 px section rail (App.vue) with room to spare on macOS 26's larger buttons.
          trafficLightPosition: { x: 18, y: 18 },
          backgroundColor: '#00000000',
          vibrancy: 'sidebar' as const,
        }),
    icon: join(RESOURCES, 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
    },
  });
  // Coming back to DevCatz: runtimes installed or removed meanwhile (Herd uninstalled …) show up.
  win.on('focus', () => void herd.refreshRuntimes().catch(() => undefined));
  win.once('ready-to-show', () => win?.show());
  // Back / forward: three-finger swipe on macOS, the mouse / keyboard browser keys on Windows.
  win.on('swipe', (_e, dir) => {
    if (dir === 'left' || dir === 'right') win?.webContents.send('herd:navigate', dir === 'right' ? 'history:back' : 'history:forward');
  });
  win.on('app-command', (_e, cmd) => {
    if (cmd === 'browser-backward' || cmd === 'browser-forward') win?.webContents.send('herd:navigate', cmd === 'browser-backward' ? 'history:back' : 'history:forward');
  });
  // Closing the window keeps the app (and dev servers) running in the menu bar.
  win.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    win?.hide();
    app.dock?.hide();
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    void openWeb(url);
    return { action: 'deny' };
  });
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(__dirname, '../renderer/index.html'));
}

/** Logs of `storage:<kind>`, `db:<id>` and `ws:<kind>` live in their own process managers. */
const managerOf = (id: string) =>
  id.startsWith('storage:')
    ? herd.storage.processes
    : id.startsWith('db:')
      ? herd.dbs.processes
      : id.startsWith('ws:')
        ? herd.ws.processes
        : id.startsWith('search:')
          ? herd.search.processes
          : id.startsWith('wa:')
            ? herd.whatsapp.processes
            : id.startsWith('gw:')
              ? herd.gateways.processes
          : herd.processes;

/** Uploads in progress per storage service (Cancel aborts the current request). */
const uploads = new Map<StorageKind, AbortController>();

/** Files to upload with their keys: a dropped folder keeps its name and structure (dotfiles like .DS_Store skipped). */
function uploadList(paths: string[], prefix: string): { path: string; key: string; size: number }[] {
  const out: { path: string; key: string; size: number }[] = [];
  const walk = (abs: string, key: string) => {
    const st = statSync(abs);
    if (st.isDirectory()) {
      for (const e of readdirSync(abs)) if (!e.startsWith('.')) walk(join(abs, e), `${key}/${e}`);
    } else if (st.isFile()) out.push({ path: abs, key, size: st.size });
  };
  for (const p of paths) walk(p, prefix + basename(p));
  return out;
}

function broadcast(channel: string, payload: unknown): void {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Windows: starts a command line detached (an editor's CLI, Windows Terminal); false when it could not start. */
function startDetached(command: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: false, shell: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}

async function openEditor(path: string): Promise<void> {
  if (isWin) {
    const where = await run('where', ['code']);
    if (where.code === 0 && (await startDetached('code', [`"${path}"`]))) return;
    await shell.openPath(path);
    return;
  }
  const editor = store.settings.editor || installedEditors()[0];
  if (editor) {
    const { code } = await run('open', ['-a', editor, path]);
    if (code === 0) return;
  }
  await shell.openPath(path);
}

async function openTerminal(path: string): Promise<void> {
  if (isWin) {
    // Windows Terminal when it is there, else a plain Command Prompt in the folder.
    if ((await run('where', ['wt'])).code === 0 && (await startDetached('wt', ['-d', `"${path}"`]))) return;
    await startDetached('start', ['""', 'cmd', '/K', `cd /d "${path}"`]);
    return;
  }
  const apps = ['Warp', 'iTerm', 'Ghostty'].filter((t) => existsSync(`/Applications/${t}.app`));
  await run('open', ['-a', apps[0] ?? 'Terminal', path]);
}

function api(): HerdApi {
  const project = (id: string) => {
    const p = herd.find(id);
    if (!p) throw new Error('Unknown project');
    return p;
  };
  return {
    getState: async () => herd.snapshot(installedEditors(), loginState()),
    // `storage:<kind>` ids belong to the object storage services' own process manager.
    getLogs: async (id) => managerOf(id).getLogs(id),
    clearLogs: async (id) => managerOf(id).clearLogs(id),
    pickFile: async (title) => {
      const r = await dialog.showOpenDialog(win!, { title, properties: ['openFile', 'treatPackageAsDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    searchInstall: (kind, config) => herd.search.install(kind, config),
    searchUpdate: (kind, config) => herd.search.update(kind, config),
    searchCancelInstall: async (kind) => herd.search.cancelInstall(kind),
    searchUninstall: async (kind, deleteData, confirmHost) => {
      const c = herd.search.config(kind);
      const expected = c ? `${c.domain}.${store.settings.tld || 'localhost'}` : '';
      if (confirmHost.trim().toLowerCase() !== expected) throw new Error(`Type ${expected} to confirm`);
      await herd.search.uninstall(kind, deleteData);
    },
    searchAction: (kind, action) => herd.search.action(kind, action),
    searchOpenData: async (kind) => {
      const c = herd.search.config(kind);
      if (c) await shell.openPath(c.dataDir);
    },
    searchIndexes: (kind) => herd.search.indexes(kind),
    searchCreateIndex: (kind, name, schema) => herd.search.createIndex(kind, name, schema),
    searchDeleteIndex: (kind, name) => herd.search.deleteIndex(kind, name),
    searchGetSettings: (kind, index) => herd.search.getSettings(kind, index),
    searchSaveSettings: (kind, index, text) => herd.search.saveSettings(kind, index, text),
    searchQuery: (kind, query) => herd.search.search(kind, query),
    searchUpsert: (kind, index, text) => herd.search.upsert(kind, index, SearchManager.parseDocs(text)),
    searchImportFile: async (kind, index) => {
      const r = await dialog.showOpenDialog(win!, { title: `Import into ${index}`, properties: ['openFile'], filters: [{ name: 'JSON, NDJSON or CSV', extensions: ['json', 'ndjson', 'jsonl', 'csv'] }] });
      if (r.canceled || !r.filePaths[0]) return null;
      return herd.search.upsert(kind, index, herd.search.readDocsFile(r.filePaths[0]));
    },
    searchDeleteDoc: (kind, index, id) => herd.search.deleteDoc(kind, index, id),
    searchTasks: (kind, status, from) => herd.search.taskQueue(kind, status, from),
    searchCancelTasks: (kind, uids) => herd.search.cancelTasks(kind, uids),
    searchClearTasks: (kind) => herd.search.clearTasks(kind),
    searchBackups: async (kind) => herd.search.backups(kind),
    searchCreateBackup: (kind, type) => herd.search.createBackup(kind, type),
    searchDeleteBackup: (kind, file) => herd.search.deleteBackup(kind, file),
    searchRevealBackup: async (kind, file) => shell.showItemInFolder(herd.search.backupFile(kind, file)),
    searchRestoreBackup: (kind, file) => herd.search.restoreBackup(kind, file),
    searchExport: async (kind, index, format) => {
      const docs = await herd.search.exportDocs(kind, index);
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      const r = await dialog.showSaveDialog(win!, {
        title: `Export ${index} (${docs.length} documents)`,
        defaultPath: join(app.getPath('downloads'), `${index}-${stamp}.${format}`),
        filters: [format === 'json' ? { name: 'JSON', extensions: ['json'] } : { name: 'NDJSON', extensions: ['ndjson', 'jsonl'] }],
      });
      if (r.canceled || !r.filePath) return null;
      writeFileSync(r.filePath, format === 'json' ? JSON.stringify(docs, null, 2) : docs.map((d) => JSON.stringify(d)).join('\n') + '\n');
      return docs.length;
    },
    searchKeys: (kind) => herd.search.keys(kind),
    searchUpgrade: (kind) => herd.search.upgrade(kind),
    mailAction: (action) => (action === 'start' ? herd.mail.start() : action === 'stop' ? herd.mail.stop() : herd.mail.restart()),
    mailList: async (query, siteId, limit) => herd.mail.list(query, siteId, limit),
    mailGet: async (id) => herd.mail.get(id),
    mailRaw: async (id) => herd.mail.raw(id).toString('utf8'),
    mailMarkRead: async (ids, read) => herd.mail.markRead(ids, read),
    mailDelete: async (ids) => herd.mail.delete(ids),
    mailDeleteAll: async () => herd.mail.deleteAll(),
    mailSaveAttachment: async (id, attachmentId) => {
      const a = herd.mail.attachment(id, attachmentId);
      const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), a.filename) });
      if (r.canceled || !r.filePath) return null;
      writeFileSync(r.filePath, a.data);
      return r.filePath;
    },
    mailAttachmentData: async (id, attachmentId) => {
      const a = herd.mail.attachment(id, attachmentId);
      return `data:${a.contentType};base64,${a.data.toString('base64')}`;
    },
    mailForward: (id, to) => herd.mail.forward(id, to),
    mailForwardConfig: async () => herd.mail.forwardConfig(),
    mailSetForwardConfig: async (config) => herd.mail.setForwardConfig(config),
    mailEnv: async (siteId) => herd.mail.env(siteId),
    mailSendTest: (siteId) => herd.mail.sendTest(siteId),
    mailOpenData: async () => void shell.openPath(herd.mail.openData()),
    exposeInstall: (tool) => herd.expose.install(tool),
    exposeCancelInstall: async () => herd.expose.cancelInstall(),
    exposeUninstall: (tool, confirmName) => herd.expose.uninstall(tool, confirmName),
    exposeCheckUpdates: () => herd.expose.checkUpdates(),
    exposeUpgrade: (tool) => herd.expose.upgrade(tool),
    exposeCloudflareLogin: () => herd.expose.cloudflareLogin(),
    exposeCloudflareLogout: async () => herd.expose.cloudflareLogout(),
    exposeSetAccount: async (provider, input) => herd.expose.setAccount(provider, input),
    exposeStart: (options) => herd.expose.start(options),
    exposeStop: (shareId) => herd.expose.stop(shareId),
    exposeRequests: async (shareId, limit) => herd.expose.requests(shareId, limit),
    exposeClearRequests: async (shareId) => herd.expose.clearRequests(shareId),
    exposeReplay: (shareId, requestId) => herd.expose.replay(shareId, requestId),
    waInstall: (engine, config) => herd.whatsapp.install(engine, config),
    waUpdate: (engine, config) => herd.whatsapp.update(engine, config),
    waCancelInstall: async (engine) => herd.whatsapp.cancelInstall(engine),
    waUninstall: (engine, deleteData, confirmHost) => herd.whatsapp.uninstall(engine, deleteData, confirmHost),
    waAction: (engine, action) => herd.whatsapp.action(engine, action),
    waOpenData: async (engine) => void shell.openPath(herd.whatsapp.openData(engine)),
    waCheckUpdates: () => herd.whatsapp.checkUpdates(),
    gwInstall: (kind, config) => herd.gateways.install(kind, config),
    gwUpdate: (kind, config) => herd.gateways.update(kind, config),
    gwCancelInstall: async (kind) => herd.gateways.cancelInstall(kind),
    gwUninstall: (kind, deleteData, confirmHost) => herd.gateways.uninstall(kind, deleteData, confirmHost),
    gwAction: (kind, action) => herd.gateways.action(kind, action),
    gwOpenData: async (kind) => void shell.openPath(herd.gateways.openData(kind)),
    gwCheckUpdates: () => herd.gateways.checkUpdates(),
    gwUpgrade: (kind) => herd.gateways.upgrade(kind),
    gwSetAutoStart: async (kind, on) => herd.gateways.setAutoStart(kind, on),
    gwSend: (kind, input) => herd.gateways.send(kind, input),
    gwEnv: (kind, siteId) => herd.gateways.env(kind, siteId),
    gwSms: async (limit) => herd.gateways.smsList(limit),
    gwClearSms: async () => herd.gateways.clearSms(),
    taskDismiss: async (scope, id) => {
      if (scope === 'storage') herd.storage.dismissTask(id as StorageKind);
      else if (scope === 'ws') herd.ws.dismissTask(id as WsKind);
      else if (scope === 'search') herd.search.dismissTask(id as SearchKind);
      else if (scope === 'whatsapp') herd.whatsapp.dismissTask(id as WaEngine);
      else if (scope === 'gateway') herd.gateways.dismissTask(id as GwKind);
      else herd.expose.dismissTask();
    },
    waUpgrade: (engine) => herd.whatsapp.upgrade(engine),
    waSessionStart: (engine, name) => herd.whatsapp.sessionStart(engine, name),
    waSessionQr: (engine, name) => herd.whatsapp.sessionQr(engine, name),
    waSessionLogout: (engine, name) => herd.whatsapp.sessionLogout(engine, name),
    waSessionRemove: (engine, name) => herd.whatsapp.sessionRemove(engine, name),
    waSend: (engine, input) => herd.whatsapp.send(engine, input),
    waContacts: (engine, session) => herd.whatsapp.contacts(engine, session),
    waGroups: (engine, session) => herd.whatsapp.groups(engine, session),
    waMessages: async (limit) => herd.whatsapp.list(limit),
    waClearMessages: async () => herd.whatsapp.clear(),
    waHooks: async () => herd.whatsapp.hooks(),
    waSetHook: async (hook) => herd.whatsapp.setHook(hook),
    waRemoveHook: async (hookId) => herd.whatsapp.removeHook(hookId),
    waDeliveries: async (hookId, limit) => herd.whatsapp.deliveriesOf(hookId, limit),
    waReplay: (deliveryId) => herd.whatsapp.replay(deliveryId),
    waEnv: async (engine, siteId) => herd.whatsapp.env(engine, siteId),
    gitStatus: (id) => herd.git.status(id),
    gitInit: (id) => herd.git.init(id),
    gitDiff: (id, file, staged) => herd.git.diff(id, file, staged),
    gitStage: (id, files) => herd.git.stage(id, files),
    gitUnstage: (id, files) => herd.git.unstage(id, files),
    // Confirmed in the window (DevCatz's own dialog, renderer/confirms.ts), like the actions below.
    gitDiscard: (id, files) => herd.git.discard(id, files),
    gitCommit: (id, message, amend) => herd.git.commit(id, message, amend),
    gitSync: (id, action) => herd.git.sync(id, action),
    gitCancel: async (id) => herd.git.cancel(id),
    gitLog: (id, search, skip, ref) => herd.git.log(id, search, skip, ref),
    gitShow: (id, sha) => herd.git.show(id, sha),
    gitBranches: (id) => herd.git.branches(id),
    aiSettings: async () => aiSettings(),
    aiSetSettings: async (patch) => {
      const r = setAiSettings(patch);
      herd.emit('change');
      return r;
    },
    aiSetKey: async (provider, key) => {
      const r = await setAiKey(provider, key);
      herd.emit('change');
      return r;
    },
    aiModels: (provider) => herd.ai.client.models(provider),
    aiProbe: (provider, models) => herd.ai.client.probe(provider, models),
    aiTest: () => herd.ai.client.test(),
    aiCancel: async (token) => herd.ai.client.cancel(token),
    aiPreviewExplain: async (req) => herd.ai.previewExplain(req),
    aiExplain: (req, token) => herd.ai.explain(req, token),
    aiPreviewCommit: (req) => herd.ai.previewCommit(req),
    aiCommit: (req, token) => herd.ai.commit(req, token),
    aiPreviewDockerEdit: async (req) => herd.ai.previewDockerEdit(req),
    aiDockerEdit: (req, token) => herd.ai.dockerEdit(req, token),
    aiPreviewEnv: async (req) => herd.ai.previewEnv(req),
    aiEnv: (req, token) => herd.ai.env(req, token),
    aiPreviewSearch: (req) => herd.ai.previewSearch(req),
    aiSearch: (req, token) => herd.ai.search(req, token),
    aiPreviewWebhook: async (req) => herd.ai.previewWebhook(req),
    aiWebhook: (req, token) => herd.ai.webhook(req, token),
    aiPreviewAsk: async (req) => herd.ai.previewAsk(req),
    aiAsk: (req, token) => herd.ai.ask(req, token),
    aiRunAction: (siteId, action) => herd.ai.runAction(siteId, action),
    dockerListFiles: async (id) => herd.dockerListFiles(id),
    dockerReadFile: async (id, file) => herd.dockerReadFile(id, file),
    dockerSaveFile: async (id, file, content) => herd.dockerSaveFile(id, file, content),
    worktreeList: (id) => herd.worktreeList(id),
    worktreeCreate: (id, o) => herd.worktreeCreate(id, o),
    worktreeAdd: (id, path) => herd.worktreeAdd(id, path),
    worktreeCheck: (id) => herd.worktreeCheck(id),
    worktreeRemove: (id, force, drop) => herd.worktreeRemove(id, force, drop),
    worktreePrune: (id) => herd.worktreePrune(id),
    gitBranch: (id, action, name, from) => herd.git.branch(id, action, name, from),
    gitStashes: (id) => herd.git.stashes(id),
    gitStash: (id, action, arg) => herd.git.stash(id, action, arg),
    gitTags: (id) => herd.git.tags(id),
    gitTag: (id, action, name, message) => herd.git.tag(id, action, name, message),
    gitOperation: (id, action, onto) => herd.git.operation(id, action, onto),
    gitSquash: (id, onto, message) => herd.git.squash(id, onto, message),
    gitCherryPick: (id, sha) => herd.git.cherryPick(id, sha),
    gitRevert: (id, sha) => herd.git.revert(id, sha),
    gitReset: (id, mode, sha) => herd.git.reset(id, mode, sha),
    gitRestoreFile: (id, file, sha) => herd.git.restoreFile(id, file, sha),
    gitOpenFile: (id, file) => herd.git.openFile(id, file),
    gitIgnoreSuggestions: (id) => herd.git.ignoreSuggestions(id),
    gitIgnoreAdd: (id, lines) => herd.git.ignoreAdd(id, lines),
    gitSetIdentity: (id, name, email, global) => herd.git.setIdentity(id, name, email, global),
    gitAddRemote: (id, name, url) => herd.git.addRemote(id, name, url),
    gitPulls: (id) => herd.git.pulls(id),
    gitCreatePull: (id, title, body, base, draft) => herd.git.createPull(id, title, body, base, draft),
    gitCheckoutPull: (id, pull) => herd.git.checkoutPull(id, pull),
    gitAddAccount: async (kind, baseUrl, token, username) => {
      const a = await gitHosts.addAccount(kind, baseUrl, token, username);
      herd.emit('change');
      return a;
    },
    gitRemoveAccount: async (accountId) => {
      await gitHosts.removeAccount(accountId);
      herd.emit('change');
    },
    gitRepos: (accountId, search) => gitHosts.repos(accountId, search),
    gitSshKeys: () => gitHosts.sshKeys(),
    gitSshGenerate: (email) => gitHosts.sshGenerate(email),
    gitSshAddToAccount: (accountId, keyPath, title) => gitHosts.sshAddToAccount(accountId, keyPath, title),
    gitClone: (url, parent, name, branch, shallow) => herd.git.cloneRepo(url, parent, name, branch, shallow),
    gitCancelClone: async () => herd.git.cancelClone(),
    wsUpgrade: (kind) => herd.ws.upgrade(kind),
    storageUpgrade: (kind) => herd.storage.upgrade(kind),
    serviceSetAutoStart: async (scope, kind, on) =>
      scope === 'storage' ? herd.storage.setAutoStart(kind as StorageKind, on) : scope === 'ws' ? herd.ws.setAutoStart(kind as WsKind, on) : herd.search.setAutoStart(kind as SearchKind, on),
    servicesCheckUpdates: async () => (await Promise.all([herd.storage.checkUpdates(), herd.ws.checkUpdates(), herd.search.checkUpdates()])).flat(),
    searchCreateKey: (kind, name, actions, indexes, expiresAt) => herd.search.createKey(kind, name, actions, indexes, expiresAt),
    searchDeleteKey: (kind, id) => herd.search.deleteKey(kind, id),
    searchEnv: (kind, siteId) => herd.searchEnv(kind, siteId),
    depCommands: async (id) => herd.depCommands(id),
    depRun: (id, commandId) => herd.depRun(id, commandId),
    storageEnv: async (kind, siteId, bucket) => herd.storageEnv(kind, siteId, bucket),
    scoutCommand: (siteId, command, model) => herd.scoutCommand(siteId, command, model),
    wsInstall: (kind, config) => herd.ws.install(kind, config),
    wsUpdate: (kind, config) => herd.ws.update(kind, config),
    wsCancelInstall: async (kind) => herd.ws.cancelInstall(kind),
    wsUninstall: async (kind, deleteData, confirmHost) => {
      const c = herd.ws.config(kind);
      const expected = c ? `${c.domain}.${store.settings.tld || 'localhost'}` : '';
      if (confirmHost.trim().toLowerCase() !== expected) throw new Error(`Type ${expected} to confirm`);
      await herd.ws.uninstall(kind, deleteData);
    },
    wsAction: (kind, action) => herd.ws.action(kind, action),
    wsOpenData: async (kind) => {
      const c = herd.ws.config(kind);
      if (c) await shell.openPath(c.dataDir);
    },
    wsStats: (kind) => herd.ws.stats(kind),
    wsPublish: (kind, channel, event, data) => herd.ws.publish(kind, channel, event, data),
    wsClientAuth: async (kind, socketId, channel) => herd.ws.clientAuth(kind, socketId, channel),
    wsEnv: async (kind, siteId) => herd.wsEnv(kind, siteId),
    reverbEnv: async (siteId) => herd.reverbEnv(siteId),
    laravelBroadcast: (siteId) => herd.laravelBroadcast(siteId),
    laravelTestBroadcast: (siteId, type, channel, event, payload) => herd.laravelTestBroadcast(siteId, type, channel, event, payload),
    storageInstall: (kind, config) => herd.storage.install(kind, config),
    storageUpdate: (kind, config) => herd.storage.update(kind, config),
    storageCancelInstall: async (kind) => herd.storage.cancelInstall(kind),
    storageUninstall: async (kind, deleteData, confirmHost) => {
      const c = herd.storage.config(kind);
      if (!c) return;
      // Typed confirmation (Storage page): guards against a misclick.
      const expected = new URL(herd.storage.state().find((x) => x.kind === kind)!.urls!.api).hostname;
      if (confirmHost.trim().toLowerCase() !== expected) throw new Error(`Type ${expected} to confirm`);
      await herd.storage.uninstall(kind, deleteData);
    },
    storageAction: (kind, action) => herd.storage.action(kind, action),
    openLogsFolder: async () => {
      await shell.openPath(join(app.getPath('userData'), 'logs'));
    },
    dbEngines: () => herd.dbs.engines(),
    dbVersions: (engine) => herd.dbs.versions(engine),
    dbDefaults: (engine, version) => herd.dbs.defaults(engine, version),
    dbCreate: (input) => herd.dbs.create({ ...input }),
    dbCancelCreate: async (id) => herd.dbs.cancelCreate(id),
    dbDismiss: async (id) => herd.dbs.dismiss(id),
    dbUpdate: (id, input) => herd.dbs.update(id, { ...input }),
    dbRemove: async (id, deleteData, confirmName) => {
      const c = herd.dbs.config(id);
      if (!c) return;
      // Typed confirmation (Database page): guards against a misclick.
      if (confirmName.trim() !== c.name) throw new Error(`Type ${c.name} to confirm`);
      await herd.dbs.remove(id, deleteData);
    },
    dbAction: (id, action) => herd.dbs.action(id, action),
    dbOpenData: async (id) => {
      const c = herd.dbs.config(id);
      if (!c) return;
      const dir = herd.dbs.dataDirOf(c);
      mkdirSync(dir, { recursive: true });
      await shell.openPath(dir);
    },
    dbOpenBinaries: async (id) => {
      const c = herd.dbs.config(id);
      const b = c && herd.dbs.binaryOf(c);
      if (!b) throw new Error('The server build is not installed');
      // SQLite: show the sqlite3 binary itself rather than all of /usr.
      // Windows: SQLite is built into DevCatz (node:sqlite), nothing to show.
      if (b.source === 'system' && isWin) throw new Error('SQLite is built into DevCatz on Windows');
      if (b.source === 'system') shell.showItemInFolder('/usr/bin/sqlite3');
      else await shell.openPath(b.root);
    },
    dbDetect: () => herd.dbs.detect(),
    dbList: (id) => herd.dbs.databases(id),
    dbCreateDatabase: (id, name) => herd.dbs.createDatabase(id, name),
    dbBuildAction: async (engine, version, action) => {
      const root = await herd.dbs.buildAction(engine, version, action);
      if (root) await shell.openPath(root);
    },
    dbcatzOpen: (connId, database) => herd.dbcatz.open(connId, database),
    dbcatzInstall: (connId, database) => herd.dbcatz.install(connId, database),
    dbcatzCancelInstall: async () => herd.dbcatz.cancelInstall(),
    dbcatzDismiss: async () => herd.dbcatz.dismiss(),
    monitorSnapshot: () => herd.monitor.snapshot(),
    monitorLive: async (on) => herd.monitor.setLive(on),
    monitorHistory: async (range) => herd.monitor.rangeHistory(range),
    monitorExport: async (range) => {
      const stamp = new Date().toISOString().slice(0, 16).replace(/[T:]/g, '-');
      const r = await dialog.showSaveDialog(win!, {
        defaultPath: join(app.getPath('downloads'), `devcatz-monitor-${range}-${stamp}.csv`),
        filters: [{ name: 'CSV', extensions: ['csv'] }],
      });
      if (r.canceled || !r.filePath) return null;
      writeFileSync(r.filePath, herd.monitor.csv(range));
      return r.filePath;
    },
    storageOpenData: async (kind) => {
      const c = herd.storage.config(kind);
      if (c) await shell.openPath(c.dataDir);
    },
    s3Buckets: (kind) => herd.s3Buckets(kind),
    s3CreateBucket: (kind, bucket) => s3.createBucket(herd.s3Target(kind), bucket),
    s3DeleteBucket: (kind, bucket) => s3.deleteBucket(herd.s3Target(kind), bucket),
    s3SetPublic: (kind, bucket, on) => herd.s3SetPublic(kind, bucket, on),
    s3List: (kind, bucket, prefix) => s3.list(herd.s3Target(kind), bucket, prefix),
    s3Upload: async (kind, bucket, prefix, paths) => {
      if (uploads.has(kind)) throw new Error('An upload is already running');
      const t = herd.s3Target(kind);
      if (!paths) {
        const r = await dialog.showOpenDialog(win!, { title: `Upload to ${bucket}/${prefix}`, properties: ['openFile', 'openDirectory', 'multiSelections'] });
        if (r.canceled) return 0;
        paths = r.filePaths;
      }
      const files = uploadList(paths, prefix);
      if (!files.length) return 0;
      const total = files.reduce((n, f) => n + f.size, 0);
      const ctrl = new AbortController();
      uploads.set(kind, ctrl);
      let base = 0;
      let last = 0;
      const progress = (p: Omit<S3UploadProgress, 'kind' | 'bucket' | 'count' | 'total'>, force = false) => {
        // At most ~10 updates a second.
        if (!force && Date.now() - last < 100) return;
        last = Date.now();
        broadcast('herd:upload', { kind, bucket, count: files.length, total, ...p } satisfies S3UploadProgress);
      };
      try {
        for (const [i, f] of files.entries()) {
          progress({ key: f.key, index: i + 1, sent: base }, true);
          await s3.upload(t, bucket, f.key, f.path, (n) => progress({ key: f.key, index: i + 1, sent: base + n }), ctrl.signal);
          base += f.size;
        }
        progress({ key: files.at(-1)!.key, index: files.length, sent: total, done: true }, true);
        return files.length;
      } catch (err) {
        const cancelled = ctrl.signal.aborted;
        progress({ key: '', index: 0, sent: base, done: true, cancelled, error: cancelled ? 'Upload cancelled' : (err as Error).message }, true);
        if (cancelled) return 0;
        throw err;
      } finally {
        uploads.delete(kind);
      }
    },
    s3CancelUpload: async (kind) => uploads.get(kind)?.abort(),
    s3Download: async (kind, bucket, key) => {
      const t = herd.s3Target(kind);
      const r = await dialog.showSaveDialog(win!, { defaultPath: join(app.getPath('downloads'), basename(key)) });
      if (r.canceled || !r.filePath) return null;
      await s3.download(t, bucket, key, r.filePath);
      return r.filePath;
    },
    s3Delete: (kind, bucket, key) => s3.remove(herd.s3Target(kind), bucket, key),
    s3MkDir: (kind, bucket, prefix) => s3.mkdir(herd.s3Target(kind), bucket, prefix),
    pickFolder: async () => {
      const r = await dialog.showOpenDialog(win!, { properties: ['openDirectory', 'createDirectory'] });
      return r.canceled ? null : r.filePaths[0];
    },
    inspectFolder: async (path) => herd.inspect(path),
    linkProject: async (path, options) => {
      const p = herd.link(path, options);
      // Its Git summary now, not at the next 20 s poll.
      if (p) void herd.git.refresh(p.id);
      return p;
    },
    parkFolder: async (path, group) => herd.park(String(path), typeof group === 'string' ? group : null),
    unparkFolder: async (path) => herd.unpark(path),
    removeProject: async (id, confirmDomain) => {
      const p = herd.siteInfo(id);
      const expected = p ? new URL(p.url).hostname : '';
      if (!expected || confirmDomain.trim().toLowerCase() !== expected) throw new Error(`Type ${expected || 'the domain'} to confirm`);
      await herd.remove(id);
    },
    updateProject: async (id, patch) => herd.update(id, patch),
    restartApp: (siteId, dir) => herd.restartApp(siteId, dir),
    envKeyGenerate: (siteId) => herd.envKeyGenerate(String(siteId)),
    siteRuntimeNeeds: (siteId) => herd.siteRuntimeNeeds(String(siteId)),
    runtimePick: (kind, spec) => herd.runtimePick(['php', 'node', 'go', 'bun'].includes(kind) ? kind : 'node', spec ? String(spec) : null),
    appUpdateCheck: () => herd.updater.check(true),
    appUpdateDownload: () => herd.updater.download(),
    appUpdateCancel: async () => herd.updater.cancelDownload(),
    appUpdateRestart: () => restartForUpdate(),
    appUpdateSkip: async () => herd.updater.skip(),
    appUpdateInstallOnQuit: async (on) => herd.updater.setInstallOnQuit(Boolean(on)),
    appUpdatePrefs: async (patch) => {
      const p: Partial<Settings> = {};
      if (typeof patch.auto === 'boolean') p.appUpdateAuto = patch.auto;
      if (patch.channel === 'stable' || patch.channel === 'beta') p.appUpdateChannel = patch.channel;
      if (typeof patch.notify === 'boolean') p.appUpdateNotify = patch.notify;
      store.updateSettings(p);
      herd.updater.schedule();
      herd.emit('change');
    },
    reportPreview: async (kind, message, email, shots) => herd.reports.preview(reportKind(kind), String(message ?? ''), String(email ?? ''), Number(shots) || 0),
    reportSend: (kind, message, email, shots) => herd.reports.sendFeedback(reportKind(kind), String(message ?? ''), String(email ?? ''), Array.isArray(shots) ? shots : []),
    captureWindow: async () => (win && !win.isDestroyed() ? (await win.webContents.capturePage()).toPNG().toString('base64') : ''),
    reportError: async (message, stack) => herd.reports.error('error', 'renderer', String(message ?? ''), stack ? String(stack) : undefined),
    setCrashReports: async (on) => herd.reports.setCrashReports(Boolean(on)),
    crashAskDismiss: async () => herd.reports.dismissAsk(),
    uninstallPlan: async () => uninstallPlan(),
    uninstall: (opts) => runUninstall({ removeData: Boolean(opts?.removeData), removeShared: Boolean(opts?.removeShared) }),
    aboutInfo: async () => ({
      version: app.getVersion(),
      arch: process.arch,
      macos: process.getSystemVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      site: siteBase(),
      dataDir: app.getPath('userData'),
    }),
    siteOpenApi: (siteId, probe) => herd.siteOpenApi(String(siteId), Boolean(probe)),
    openapiReveal: async (siteId, file) => {
      if (!herd.isSpecFile(String(siteId), String(file))) throw new Error('Not an OpenAPI file of this site');
      shell.showItemInFolder(String(file));
    },
    addOpenApi: (siteId, kind) => herd.addOpenApi(String(siteId), kind === 'nest-swagger' ? 'nest-swagger' : 'scramble'),
    createOpenApi: (siteId, format, app) => herd.createOpenApi(String(siteId), format === 'json' ? 'json' : 'yaml', typeof app === 'string' ? app : undefined),
    dialcatzOpen: (siteId) => {
      if (!herd.find(String(siteId))) throw new Error('This site is gone');
      return herd.dialcatz.open(String(siteId));
    },
    dialcatzInstall: (siteId) => {
      if (!herd.find(String(siteId))) throw new Error('This site is gone');
      return herd.dialcatz.install(String(siteId));
    },
    dialcatzCancelInstall: async () => herd.dialcatz.cancelInstall(),
    dialcatzDismiss: async () => herd.dialcatz.dismiss(),
    dbImportList: (targetId, source) => herd.dbs.importList(String(targetId), source),
    dbImportOne: (targetId, source, name) => herd.dbs.importOne(String(targetId), source, String(name)),
    domainOwner: async (domain, siteId) => herd.domainOwner(String(domain), siteId ? String(siteId) : undefined),
    buildTargets: async (siteId) => herd.buildTargets(siteId),
    buildSite: (siteId, target) => herd.buildSite(siteId, String(target)),
    gitignoreRead: (siteId) => herd.gitignoreRead(siteId),
    gitignoreSave: (siteId, content) => herd.gitignoreSave(siteId, String(content)),
    setAppSubdomain: (siteId, dir, sub) => herd.setAppSubdomain(siteId, String(dir), sub === null ? null : String(sub)),
    siteDeps: (siteId, fresh) => herd.siteDeps(siteId, Boolean(fresh)),
    depsReport: (fresh) => herd.depsReport(Boolean(fresh)),
    freeDeps: (siteId, paths) => herd.freeDeps(siteId, Array.isArray(paths) ? paths.map(String) : []),
    sitePortUse: (siteId, dir, port) => herd.portUse(siteId, dir, Number(port)),
    setSitePort: (siteId, dir, port, writeEnv) => herd.setAppPort(siteId, dir, Number(port), Boolean(writeEnv)),
    appPortEnv: async (siteId, dir) => herd.appPortEnv(siteId, String(dir)),
    freePortFor: (siteId, dir) => herd.freePortFor(siteId, String(dir)),
    envFiles: async (id) => herd.envFiles(id),
    envRead: async (id, path) => herd.envRead(id, path),
    envWrite: async (id, path, content, mtime) => herd.envWrite(id, path, content, mtime),
    envCreate: (id, path) => herd.envCreate(id, path),
    envMerge: async (id, path, entries, comment, apply) => herd.envMerge(id, path, { ...entries }, comment, apply),
    rescan: async () => herd.rescan(),
    refreshRuntimes: () => herd.refreshRuntimes(true),
    start: (id) => herd.start(id),
    stop: (id) => herd.stop(id),
    restart: (id) => herd.restart(id),
    // app:licenses — the third-party licences shipped inside the app (Catzoid #66), readable offline
    openUrl: async (url) => {
      if (url === 'app:licenses') await shell.openPath(app.isPackaged ? join(process.resourcesPath, 'third-party-licenses.txt') : join(app.getAppPath(), 'resources', 'third-party-licenses.txt'));
      else await openWeb(url);
    },
    openFolder: async (id) => void (await shell.openPath(project(id).path)),
    openEditor: (id) => openEditor(project(id).path),
    openTerminal: (id) => openTerminal(project(id).path),
    db: (id, action, arg) => herd.db(id, action, arg),
    updateSettings: async (patch) => {
      await herd.updateSettings(patch);
      // Native parts (vibrancy, dialogs, menus) follow the chosen theme too; the other Catzoid apps follow it.
      if (patch.theme) {
        nativeTheme.themeSource = patch.theme;
        writeShared({ theme: patch.theme });
      }
    },
    trustCa: () => herd.trustCa(),
    untrustCa: () => herd.untrustCa(),
    revealCa: async () => shell.showItemInFolder(herd.certs.caPath),
    installCleanUrls: () => herd.installCleanUrls(),
    uninstallCleanUrls: () => herd.uninstallCleanUrls(),
    setTld: (next, dryRun) => herd.setTld(next, dryRun),
    installResolver: () => herd.installResolver(),
    uninstallResolver: () => herd.uninstallResolver(),
    quitApp: async () => void quit('window'),
    startAll: async () => herd.startAll(),
    stopAll: () => herd.stopAll(),
    takePendingNav: async () => {
      const nav = pendingNav;
      pendingNav = null;
      return nav;
    },
    getScreenshot: async (id) => screenshotDataUrl(id),
    redisDetails: (id) => herd.redisInfo(id),
    redisWriteEnv: async (id, apply) => herd.redisWriteEnv(id, apply),
    installDeps: (id) => herd.installDeps(id),
    nodeRemote: (refresh) => herd.nodeRemote(refresh),
    nodeInstall: (version) => herd.withCancel('node', () => herd.nodeInstall(version)),
    // Confirmed in the window (DevCatz's own dialog).
    nodeUninstall: async (version) => herd.nodeUninstall(version),
    nodeSetDefault: async (version) => herd.nodeSetDefault(version),
    shimPathSet: async (on) => herd.shimPathSet(on),
    bunRemote: (refresh) => herd.bunRemote(refresh),
    bunInstall: (version) => herd.withCancel('bun', () => herd.bunInstall(version)),
    // Confirmed in the window (DevCatz's own dialog).
    bunUninstall: (version) => herd.bunUninstall(version),
    bunSetDefault: (version) => herd.bunSetDefault(version),
    goRemote: (refresh) => herd.goRemote(refresh),
    goInstall: (version) => herd.withCancel('go', () => herd.goInstall(version)),
    // Confirmed in the window (DevCatz's own dialog).
    goUninstall: (version) => herd.goUninstall(version),
    goSetDefault: (version) => herd.goSetDefault(version),
    rustInstall: () => herd.withCancel('rust', () => herd.rustInstall()),
    rustRemote: (refresh) => herd.rustRemote(refresh),
    rustToolchainInstall: (name) => herd.withCancel('rust', () => herd.rustToolchainInstall(String(name))),
    rustToolchainUninstall: (name) => herd.rustToolchainUninstall(String(name)),
    rustSetDefault: (name) => herd.rustSetDefault(String(name)),
    rustTargetAdd: (target) => herd.rustTargetAdd(String(target)),
    rustToolInstall: (id) => herd.rustToolInstall(id),
    rustToolsCheck: () => herd.rustToolsCheck(),
    rustToolUninstall: (id) => herd.rustToolUninstall(id),
    toolsState: (runtime, refresh) => herd.toolsState(runtime === 'go' || runtime === 'python' ? runtime : 'node', Boolean(refresh)),
    toolInstall: (id) => herd.toolInstall(id),
    toolUninstall: (id) => herd.toolUninstall(id),
    repairElectron: (siteId) => herd.repairElectron(String(siteId)),
    installCancel: async (key) => herd.installCancel(String(key)),
    phpRemote: (refresh) => herd.phpRemote(refresh),
    phpInstall: (version) => herd.withCancel('php', () => herd.phpInstall(version)),
    // Confirmed in the window (DevCatz's own dialog).
    phpUninstall: (version) => herd.phpUninstall(version),
    phpSetDefault: (version) => herd.phpSetDefault(version),
    phpGetIni: (version) => herd.phpGetIni(version),
    phpSetIni: (version, settings) => herd.phpSetIni(version, settings),
    composerInstall: () => herd.withCancel('composer', () => herd.composerInstall()),
    phpExtensions: (version) => herd.phpExtensions(version),
    phpExtInstall: (version, pkg) => herd.phpExtInstall(version, pkg),
    phpExtSetEnabled: async (version, module, on) => herd.phpExtSetEnabled(version, module, on),
    phpExtRemove: async (version, module) => herd.phpExtRemove(version, module),
    phpExtDismiss: async () => herd.phpExtDismiss(),
    phpOpenIni: (version) => openEditor(etcDir(version)),
    goDbInfo: async (id) => herd.goDbInfo(id),
    goDbTask: (id, dir, taskId, name) => herd.goDbTask(id, dir, taskId, name),
    stackTask: (id, taskId, name) => herd.stackTask(id, taskId, name),
    uvInstall: () => herd.withCancel('python', () => herd.uvInstall()),
    pythonRemote: () => herd.pythonRemote(),
    pythonInstall: (version) => herd.withCancel('python', () => herd.pythonInstall(version)),
    pythonUninstall: (version) => herd.pythonUninstall(version),
    pythonSetDefault: (version) => herd.pythonSetDefault(version),
    dockerStatus: () => dockerStatus(),
    dockerFiles: async (id) => herd.dockerFiles(id),
    dockerServices: (id, file) => herd.dockerServices(id, file),
    dockerGenerate: async (id, options) => herd.dockerGenerate(id, options),
    dockerWrite: async (id, options, paths, overwrite, edited) => herd.dockerWrite(id, options, paths, overwrite, edited ?? {}),
    dockerCompose: (id, file, action, service) => herd.dockerCompose(id, file, action, service),
    startEngine: (id) => startEngine(id),
    setFavorite: async (id, on) => herd.setFavorite(id, on),
    setSiteGroup: async (id, group) => herd.setSiteGroup(id, group),
    renameGroup: async (from, to) => herd.renameGroup(from, to),
    deleteGroup: async (name) => herd.deleteGroup(name),
    toggleGroup: async (name) => herd.toggleGroup(name),
    moveGroup: async (name, delta) => herd.moveGroup(name, delta),
    siteMenu: async (id) => {
      const { favorites, siteGroups } = store.settings;
      const fav = favorites.includes(id);
      const current = siteGroups.find((g) => g.sites.includes(id))?.name ?? null;
      const p = herd.siteInfo(id);
      Menu.buildFromTemplate([
        { label: fav ? 'Remove from Favorites' : 'Add to Favorites', click: () => herd.setFavorite(id, !fav) },
        {
          label: 'Move to Group',
          submenu: [
            ...siteGroups.map((g) => ({ label: g.name, type: 'checkbox' as const, checked: g.name === current, click: () => herd.setSiteGroup(id, g.name) })),
            ...(siteGroups.length ? [{ type: 'separator' as const }] : []),
            { label: 'New Group…', click: () => win?.webContents.send('herd:navigate', `new-group:${id}`) },
            ...(current ? [{ label: `Remove from “${current}”`, click: () => herd.setSiteGroup(id, null) }] : []),
          ],
        },
        { type: 'separator' },
        { label: 'Open in Browser', enabled: Boolean(p), click: () => p && void openWeb(p.url) },
        { label: 'Open Folder', enabled: Boolean(p), click: () => p && void shell.openPath(p.path) },
      ]).popup({ window: win ?? undefined });
    },
    setSiteOrder: async (order) => herd.setSiteOrder(order),
    dbSetFavorite: async (id, on) => herd.dbSetFavorite(id, on),
    dbSetGroup: async (id, group) => herd.dbSetGroup(id, group),
    dbGroupAction: async (name, action, value) => herd.dbGroupAction(name, action, value),
    dbSetOrder: async (order) => herd.dbSetOrder(order),
    dbMenu: async (id) => {
      const { dbFavorites, dbGroups } = store.settings;
      const fav = dbFavorites.includes(id);
      const current = dbGroups.find((g) => g.sites.includes(id))?.name ?? null;
      Menu.buildFromTemplate([
        { label: fav ? 'Remove from Favorites' : 'Add to Favorites', click: () => herd.dbSetFavorite(id, !fav) },
        {
          label: 'Move to Group',
          submenu: [
            ...dbGroups.map((g) => ({ label: g.name, type: 'checkbox' as const, checked: g.name === current, click: () => herd.dbSetGroup(id, g.name) })),
            ...(dbGroups.length ? [{ type: 'separator' as const }] : []),
            { label: 'New Group…', click: () => win?.webContents.send('herd:navigate', `db-new-group:${id}`) },
            ...(current ? [{ label: `Remove from “${current}”`, click: () => herd.dbSetGroup(id, null) }] : []),
          ],
        },
      ]).popup({ window: win ?? undefined });
    },
    dbGroupMenu: async (name) => {
      const groups = store.settings.dbGroups;
      const i = groups.findIndex((g) => g.name === name);
      Menu.buildFromTemplate([
        { label: 'Rename Group…', click: () => win?.webContents.send('herd:navigate', `db-rename-group:${name}`) },
        { label: 'Move Up', enabled: i > 0, click: () => herd.dbGroupAction(name, 'up') },
        { label: 'Move Down', enabled: i >= 0 && i < groups.length - 1, click: () => herd.dbGroupAction(name, 'down') },
        { type: 'separator' },
        { label: 'Delete Group (keeps the services)', click: () => herd.dbGroupAction(name, 'delete') },
      ]).popup({ window: win ?? undefined });
    },
    groupMenu: async (name) => {
      const groups = store.settings.siteGroups;
      const i = groups.findIndex((g) => g.name === name);
      Menu.buildFromTemplate([
        { label: 'Rename Group…', click: () => win?.webContents.send('herd:navigate', `rename-group:${name}`) },
        { label: 'Move Up', enabled: i > 0, click: () => herd.moveGroup(name, -1) },
        { label: 'Move Down', enabled: i >= 0 && i < groups.length - 1, click: () => herd.moveGroup(name, 1) },
        { type: 'separator' },
        { label: 'Delete Group (keeps the sites)', click: () => herd.deleteGroup(name) },
      ]).popup({ window: win ?? undefined });
    },
    checkUpdates: () => herd.checkUpdates(),
    runtimeUpdate: (runtime, from) => herd.withCancel(String(runtime), () => herd.runtimeUpdate(runtime, from)),
    restartServices: () => herd.restartServices(),
    laravelLog: async (id, lines) => herd.laravelLog(id, lines),
    herdSites: async () => herd.herdSites(),
    refreshScreenshot: (id) => herd.screenshot(id),
    setLaunchAtLogin: async (on) => {
      app.setLoginItemSettings({ openAtLogin: on });
      herd.emit('change');
    },
  };
}

function registerIpc(): void {
  const impl = api() as unknown as Record<string, (...args: unknown[]) => unknown>;
  for (const method of API_METHODS) {
    ipcMain.handle(`herd:${method}`, (_e, ...args) => impl[method](...args));
  }
}

const reportKind = (k: unknown): ReportKind => (k === 'idea' || k === 'question' ? k : 'bug');

/**
 * "Restart now" for a downloaded update (Catzoid #54): remembers the running sites (started again by the new
 * version), stops everything like a normal quit, then hands over to Squirrel, which swaps the app and relaunches it.
 */
async function restartForUpdate(): Promise<void> {
  if (herd.updater.state().status !== 'downloaded') throw new Error('The update is not downloaded yet');
  store.updateSettings({ resumeSites: herd.runningSites() });
  quitting = true;
  const timeout = new Promise<void>((resolve) => setTimeout(resolve, 8000));
  await Promise.race([herd.shutdown().catch((e) => console.error('shutdown before update:', e)), timeout]);
  herd.updater.quitAndInstall();
}

/** Uninstall DevCatz (Catzoid #55): progress in state.uninstall; quits at the end. */
async function runUninstall(opts: { removeData: boolean; removeShared: boolean }): Promise<void> {
  if (herd.uninstallTask && !herd.uninstallTask.done && !herd.uninstallTask.error) return;
  const set = (p: Partial<TaskProgress>) => {
    herd.uninstallTask = { ...(herd.uninstallTask as TaskProgress), ...p };
    herd.emit('change');
  };
  herd.uninstallTask = { kind: 'uninstall', title: 'Uninstalling DevCatz', steps: UNINSTALL_STEPS, step: 0 } as TaskProgress;
  herd.emit('change');
  try {
    await uninstall(opts, { stopAll: () => herd.shutdown(), untrustCa: async () => void (await herd.untrustCa()) }, set);
    console.log('uninstalled: quitting');
    quitting = true;
    setTimeout(() => app.exit(0), 1500);
  } catch (e) {
    set({ error: (e as Error).message });
  }
}

async function quit(reason: string): Promise<void> {
  if (quitting) {
    console.log(`quit (${reason}) ignored: already quitting`);
    return;
  }
  quitting = true;
  console.log(`quit requested (${reason})`);
  // Never hang on the way out: dev servers get SIGKILL after 5s inside stop(),
  // and this is the backstop for anything else.
  const timeout = new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 8000));
  try {
    const result = await Promise.race([herd.shutdown().then(() => 'done' as const), timeout]);
    console.log(`shutdown ${result}`);
  } catch (err) {
    console.error('shutdown failed:', err);
  } finally {
    app.exit(0);
  }
}

/**
 * devcatz:// links (DBCatz's "Open in DevCatz", scripts):
 *   devcatz://db/<service id>   the Database page at that service
 *   devcatz://<section>          a rail section (database, storage, …)
 */
function handleLink(raw: string): void {
  try {
    const u = new URL(raw);
    const id = u.pathname.replace(/^\/+/, '');
    if (u.hostname === 'db' && id) return showWindow(`db:${decodeURIComponent(id)}`);
    showWindow(u.hostname || undefined);
  } catch {
    showWindow();
  }
}

app.on('second-instance', (_e, argv) => {
  const link = argv.find((a) => a.startsWith('devcatz://'));
  if (link) handleLink(link);
  else showWindow();
});
app.on('open-url', (e, url) => {
  e.preventDefault();
  if (app.isReady() && herd) handleLink(url);
  else app.once('ready', () => setTimeout(() => handleLink(url), 500));
});
app.on('activate', () => showWindow());
app.on('window-all-closed', () => {
  /* stay in the menu bar */
});
app.on('before-quit', (e) => {
  if (quitting) return;
  e.preventDefault();
  void quit('before-quit');
});
for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => void quit(sig));

app.whenReady().then(async () => {
  setupLogFile();
  // Windows: Node's fetch tries one IPv4 address and gives up when a CDN node is unreachable from the user's network
  // (windows.php.net / downloads.php.net, 2026-10-27); Chromium's stack tries every address (IPv6 too) and uses the
  // system proxy, as the browser does. Every download / API call in the main process goes through it there.
  if (isWin) globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => net.fetch(input as string, init as never)) as typeof fetch;
  console.log(`DevCatz ${app.getVersion()} starting (packaged=${app.isPackaged})`);
  await loadShellEnv();
  // Theme and AI connection are shared with the other Catzoid apps (shared.ts): theirs wins when set.
  const sharedTheme = readShared().theme;
  if (sharedTheme && sharedTheme !== store.settings.theme) store.updateSettings({ theme: sharedTheme });
  else if (!sharedTheme) writeShared({ theme: store.settings.theme });
  nativeTheme.themeSource = store.settings.theme;
  setStatusPageIcon(join(RESOURCES, 'icon-192.png'));
  herd = new Herd();
  registerIpc();
  void migrateAiToShared()
    .then(() => herd.emit('change'))
    .catch((e) => console.warn('AI settings migration:', e.message));
  // DBCatz (or another Catzoid app) changed the theme or the AI connection: follow it.
  watchShared((sh) => {
    if (sh.theme && sh.theme !== store.settings.theme) {
      store.updateSettings({ theme: sh.theme });
      nativeTheme.themeSource = sh.theme;
    }
    herd.emit('change');
  });
  // macOS needs the standard menus for ⌘C / ⌘V and the app menu. About DevCatz opens Settings → About (Catzoid #62);
  // Check for Updates… sits right under it and reads "Update Available…" while one waits (#54); Help → Report a Bug…
  // / Send Feedback… (#65).
  let menuKey = '';
  const appMenu = () => {
    const key = String(herd.updater.pending());
    if (key === menuKey) return;
    menuKey = key;
    // Windows: no menu bar in the window (the page has its own controls); the same items stay on Alt / shortcuts.
    if (isWin) {
      Menu.setApplicationMenu(
        Menu.buildFromTemplate([
          {
            label: 'File',
            submenu: [
              { label: 'Settings', accelerator: 'Ctrl+,', click: () => showWindow('settings') },
              { type: 'separator' },
              { label: 'Quit DevCatz', accelerator: 'Ctrl+Q', click: () => void quit('menu') },
            ],
          },
          { role: 'editMenu' },
          { role: 'viewMenu' },
          {
            role: 'help',
            submenu: [
              { label: `About ${app.name}`, click: () => showWindow('settings:about') },
              { label: herd.updater.pending() ? 'Update Available…' : 'Check for Updates…', click: () => showWindow('update:check') },
              { type: 'separator' },
              { label: 'Report a Bug…', click: () => showWindow('report:bug') },
              { label: 'Send Feedback…', click: () => showWindow('report:idea') },
              { label: 'DevCatz Docs', click: () => void shell.openExternal(`${siteBase()}/docs`) },
            ],
          },
        ]),
      );
      return;
    }
    Menu.setApplicationMenu(
      Menu.buildFromTemplate([
        {
          label: app.name,
          submenu: [
            { label: `About ${app.name}`, click: () => showWindow('settings:about') },
            { label: herd.updater.pending() ? 'Update Available…' : 'Check for Updates…', click: () => showWindow('update:check') },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' },
          ],
        },
        { role: 'editMenu' },
        { role: 'viewMenu' },
        { role: 'windowMenu' },
        {
          role: 'help',
          submenu: [
            { label: 'Report a Bug…', click: () => showWindow('report:bug') },
            { label: 'Send Feedback…', click: () => showWindow('report:idea') },
            { type: 'separator' },
            { label: 'DevCatz Docs', click: () => void shell.openExternal(`${siteBase()}/docs`) },
          ],
        },
      ]),
    );
  };
  appMenu();
  herd.on('change', appMenu);
  // Updates: the feed sends the install id / version / channel headers; a click on the notification opens What's New.
  herd.updater.onShow = () => showWindow('update:show');
  herd.updater.schedule();
  herd.reports.startCrashReporter();
  if (app.isPackaged) app.setAsDefaultProtocolClient('devcatz'); // not the dev Electron binary
  // Installed browsers and the system default (Settings → Browser), looked at again when DevCatz comes to the front.
  void refreshApps().then((changed) => changed && herd.emit('change'));
  app.on('browser-window-focus', () => void refreshApps().then((changed) => changed && herd.emit('change')));
  const link = process.argv.find((a) => a.startsWith('devcatz://'));
  if (link) handleLink(link);
  let pending: LogLine[] = [];
  let flush: NodeJS.Timeout | null = null;
  const onLog = (lines: LogLine[]) => {
    pending.push(...lines);
    flush ??= setTimeout(() => {
      broadcast('herd:logs', pending);
      pending = [];
      flush = null;
    }, 60);
  };
  herd.processes.on('log', onLog);
  herd.storage.processes.on('log', onLog);
  herd.dbs.processes.on('log', onLog);
  herd.whatsapp.processes.on('log', onLog);
  herd.gateways.processes.on('log', onLog);

  tray = new HerdTray(RESOURCES, {
    show: (target) => showWindow(target),
    startAll: () => herd.startAll(),
    stopAll: () => void herd.stopAll(),
    restartServices: () => void herd.restartServices(),
    storageAction: (kind, action) => void herd.storage.action(kind, action).catch((e) => console.error(`tray ${kind} ${action}:`, e.message)),
    dbAction: (id, action) => void herd.dbs.action(id, action).catch((e) => console.error(`tray db ${id} ${action}:`, e.message)),
    openUrl: (url) => void openWeb(url),
    exposeStop: (id) => void herd.expose.stop(id).catch((e) => console.error('tray expose stop:', e.message)),
    copy: (text) => clipboard.writeText(text),
    searchAction: (kind, action) => void herd.search.action(kind, action).catch((e) => console.error(`tray search ${kind} ${action}:`, e.message)),
    wsAction: (kind, action) => void herd.ws.action(kind, action).catch((e) => console.error(`tray ws ${kind} ${action}:`, e.message)),
    mailAction: (action) => void (action === 'start' ? herd.mail.start() : herd.mail.stop()).catch((e) => console.error(`tray mail ${action}:`, e.message)),
    gwAction: (kind, action) => void herd.gateways.action(kind, action).catch((e) => console.error(`tray gateway ${kind} ${action}:`, e.message)),
    waAction: (engine, action) => void herd.whatsapp.action(engine, action).catch((e) => console.error(`tray whatsapp ${engine} ${action}:`, e.message)),
    quit: () => void quit('tray'),
  });
  // Dev-only handle for poking the tray from a main-process inspector (`--inspect`).
  if (!app.isPackaged) (globalThis as Record<string, unknown>).__mrcatzHerd = { tray: () => tray, herd: () => herd };
  const RUNTIME_NAMES = { node: 'Node.js', bun: 'Bun', go: 'Go', php: 'PHP' } as const;
  herd.openFileHook = (path) => openEditor(path);
  herd.notifyHook = (title, body) => {
    if (Notification.isSupported()) new Notification({ title, body }).show();
  };
  herd.onMail = (m) => {
    if (!store.settings.mailNotify || !Notification.isSupported()) return;
    const n = new Notification({ title: `${m.siteName ?? 'Mail'}: ${m.subject || '(no subject)'}`, body: `From ${m.from?.address ?? 'unknown'} · caught by DevCatz`, silent: true });
    n.on('click', () => showWindow('mail'));
    n.show();
  };
  // Mail, WhatsApp and the gateways run macOS builds: Windows stage 1 leaves them off (Catzoid #57).
  if (isMac) {
    void herd.mail.autoStart();
    herd.whatsapp.autoStart();
    herd.gateways.autoStart();
  }
  gitHosts.setAccountsListener(() => herd.emit('change'));
  // DevCatz 1.0.0's own Git accounts → the shared store (once; DialCatz then sees them too).
  void gitHosts.moveLocalAccounts().catch((e: Error) => console.warn(`Git accounts: ${e.message}`));
  herd.onNewToolUpdates = (list) => {
    if (!Notification.isSupported()) return;
    const body = list.map((u) => `${u.label} ${u.from} → ${u.to}`).join('\n');
    const n = new Notification({ title: list.length === 1 ? 'Tool update available' : `${list.length} tool updates available`, body });
    n.on('click', () => showWindow(`${list[0].page}:tools`));
    n.show();
  };
  herd.onNewUpdates = (list) => {
    if (!Notification.isSupported()) return;
    const body = list.map((u) => `${RUNTIME_NAMES[u.runtime]} ${u.from} → ${u.to}`).join('\n');
    const n = new Notification({ title: list.length === 1 ? 'Runtime update available' : `${list.length} runtime updates available`, body });
    n.on('click', () => showWindow(list[0].runtime));
    n.show();
  };
  // Monitoring: pushed to the page while it is open; a summary line in the menu bar; alerts as notifications.
  herd.monitor.onSample = (u, live) => {
    if (live) broadcast('herd:monitor', u);
    const own = u.total;
    tray?.setMonitorLine(
      store.settings.monitorMenuBar ? `Monitor · ${Math.round(own.cpu)}% CPU · ${(own.mem / 1073741824).toFixed(1)} GB for sites & services` : null,
    );
  };
  herd.monitor.notify = (title, body) => {
    if (!Notification.isSupported()) return;
    const n = new Notification({ title, body });
    n.on('click', () => showWindow('monitoring'));
    n.show();
  };
  herd.on('change', () => {
    const state = herd.snapshot(installedEditors(), loginState());
    tray?.update(state);
    broadcast('herd:state', state);
  });

  try {
    await herd.init();
  } catch (err) {
    // Keep the UI usable; the Settings page shows proxy/certificate state.
    console.error('DevCatz failed to initialise:', err);
  }
  if (app.dock && existsSync(join(RESOURCES, 'icon.png'))) app.dock.setIcon(join(RESOURCES, 'icon.png'));
  await finishMigration();
  herd.autoStart();
  // Started by the login item: live quietly in the menu bar, like Laravel Herd.
  if (app.getLoginItemSettings().wasOpenedAtLogin || process.argv.includes('--hidden')) app.dock?.hide();
  else createWindow();
});
