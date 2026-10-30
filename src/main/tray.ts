import { Menu, Tray, nativeImage } from 'electron';
import { isWin } from './platform';
import { join } from 'node:path';
import type { AppState, GwKind, SearchKind, StorageAction, StorageKind, WaEngine, WsKind } from '@shared/types';
import { dot, type DotColor } from './menuicons';
import { words } from '@shared/platform';

/** Where the window opens: the sites list, Settings, or the "new site" dialog. */
export type NavTarget = 'sites' | 'settings' | 'new-site' | 'storage' | 'database' | 'websocket' | 'search' | 'monitoring' | 'mail' | 'whatsapp' | 'expose' | 'node' | 'bun' | 'go' | 'rust' | 'php' | 'update:check' | 'update:show';

export interface TrayActions {
  show(target: NavTarget): void;
  startAll(): void;
  stopAll(): void;
  restartServices(): void;
  storageAction(kind: StorageKind, action: StorageAction): void;
  dbAction(id: string, action: StorageAction): void;
  wsAction(kind: WsKind, action: StorageAction): void;
  searchAction(kind: SearchKind, action: StorageAction): void;
  mailAction(action: 'start' | 'stop'): void;
  waAction(engine: WaEngine, action: StorageAction): void;
  gwAction(kind: GwKind, action: StorageAction): void;
  openUrl(url: string): void;
  exposeStop(shareId: string): void;
  copy(text: string): void;
  quit(): void;
}

const TRAY_GUID = '7d1c6f2e-3b8a-4c5e-9f1d-6a2b8e4c0d93';

/** Dot per state: running = green, busy = yellow, down = red, stopped/not needed = hollow gray. */
const DOT: Record<'running' | 'busy' | 'down' | 'stopped' | 'not-needed', [DotColor, boolean]> = {
  running: ['green', false],
  busy: ['yellow', false],
  down: ['red', false],
  stopped: ['gray', true],
  'not-needed': ['gray', true],
};

/**
 * A service row: dot icon, name, and the state as a suffix. Kept enabled
 * (macOS dims the icons of disabled items); a click opens Settings → Project.
 */
function status(state: 'running' | 'down' | 'not-needed', name: string, note: string | undefined, open: () => void): Electron.MenuItemConstructorOptions {
  const text = state === 'running' ? 'running' : state === 'down' ? 'stopped' : (note ?? 'not needed');
  return { label: `${name} · ${note && state !== 'not-needed' ? `${note} · ` : ''}${text}`, icon: dot(...DOT[state]), click: open };
}

/**
 * Menu bar item, kept short like Laravel Herd's: Sites, Create New Site,
 * Start/Stop All, Settings, Quit. Everything per site lives in the window.
 */
export class HerdTray {
  readonly tray: Tray;
  private idle: Electron.NativeImage;
  private active: Electron.NativeImage;
  private lastKey = '';
  /**
   * Keep the menu alive in JS: Electron stores item click callbacks on the JS
   * Menu object, so a menu only referenced natively can be garbage-collected
   * and its items then do nothing when clicked.
   */
  menu: Menu | null = null;
  /** The menu before `menu`; its click may still be in flight right after a rebuild. */
  private previousMenu: Menu | null = null;
  private menuOpen = false;
  private pending: AppState | null = null;

  constructor(resources: string, private actions: TrayActions) {
    if (isWin) {
      // Windows: the app icon (a black template glyph would vanish on the dark taskbar); no GUID (macOS's placement).
      this.idle = this.active = nativeImage.createFromPath(join(resources, 'icon-192.png')).resize({ width: 32, height: 32 });
      this.tray = new Tray(this.idle);
    } else {
      this.idle = nativeImage.createFromPath(join(resources, 'trayTemplate.png'));
      this.active = nativeImage.createFromPath(join(resources, 'trayActiveTemplate.png'));
      this.idle.setTemplateImage(true);
      this.active.setTemplateImage(true);
      // A fixed GUID lets macOS remember where you ⌘-dragged the icon (e.g. next to Laravel Herd).
      this.tray = new Tray(this.idle, TRAY_GUID);
    }
    this.tray.setToolTip('DevCatz');
    this.tray.on('click', () => console.log('tray: icon clicked'));
  }

  private monitorLine: string | null = null;
  private lastState: AppState | null = null;

  /** "Monitor · 4% CPU · 1.2 GB …" under the sites summary (null hides it). */
  setMonitorLine(line: string | null): void {
    if (line === this.monitorLine) return;
    this.monitorLine = line;
    if (this.lastState) this.update(this.lastState);
  }

  update(state: AppState): void {
    this.lastState = state;
    // Never swap the menu while it is on screen: the item being clicked would
    // lose its callback. Rebuild shortly after it closes (the click fires after close).
    if (this.menuOpen) {
      this.pending = state;
      return;
    }
    const total = state.projects.length;
    const running = state.projects.filter((p) => p.status === 'running' || p.status === 'starting' || p.served).length;
    this.tray.setImage(running ? this.active : this.idle);
    this.tray.setToolTip(running ? `DevCatz: ${running} of ${total} sites running` : 'DevCatz');

    const fpm = state.php.fpm;
    const updates = state.updates.list;
    const storage = state.storage.filter((s) => s.installed);
    const dbs = state.databases.filter((d) => !d.pending && d.engine !== 'sqlite');
    const ws = state.websockets.filter((w) => w.installed);
    const search = state.searchEngines.filter((w) => w.installed);
    const wa = state.whatsapp.filter((w) => w.installed);
    const gw = state.gateways.filter((g) => g.installed);
    const key = JSON.stringify([
      running,
      total,
      this.monitorLine,
      state.services,
      updates.map((u) => u.to),
      storage.map((s) => [s.kind, s.status, s.urls?.api]),
      dbs.map((d) => [d.id, d.name, d.status, d.port]),
      fpm.map((f) => [f.version, f.running, f.sites.length]),
      ws.map((w) => [w.kind, w.status]),
      search.map((w) => [w.kind, w.status]),
      wa.map((w) => [w.engine, w.status, w.sessions.filter((x) => x.status === 'connected').length]),
      gw.map((g) => [g.kind, g.status]),
      [state.mail.running, state.mail.unread, state.mail.count],
      state.expose.shares.map((s) => [s.id, s.status, s.url]),
    ]);
    if (key === this.lastKey) return;
    this.lastKey = key;

    // Every action is logged, so a click that never arrives shows up in logs/main.log.
    const act = (name: string, fn: () => void) => () => {
      console.log(`tray: ${name}`);
      fn();
    };
    const a = this.actions;
    const menu = Menu.buildFromTemplate([
      { label: running ? `Sites (${running}/${total} running)` : 'Sites', click: act('sites', () => a.show('sites')) },
      { label: 'Create New Site…', click: act('new-site', () => a.show('new-site')) },
      ...(this.monitorLine ? [{ label: this.monitorLine, click: act('monitoring', () => a.show('monitoring')) }] : []),
      // Windows: no mail catcher, object storage or DNS yet (those sections are hidden there).
      ...(isWin ? [] : [{
        label: state.mail.running ? `Mail · ${state.mail.unread ? `${state.mail.unread} new` : `${state.mail.count} caught`}` : 'Mail · catcher off',
        icon: dot(...DOT[state.mail.running ? 'running' : 'stopped']),
        submenu: [
          { label: 'Open Inbox', click: act('mail', () => a.show('mail')) },
          state.mail.running
            ? { label: 'Stop Mail Server', click: act('mail-stop', () => a.mailAction('stop')) }
            : { label: 'Start Mail Server', click: act('mail-start', () => a.mailAction('start')) },
        ],
      }]),
      ...wa.map((w) => {
        const on = w.status === 'running' || w.status === 'starting';
        const linked = w.sessions.filter((x) => x.status === 'connected').length;
        return {
          label: `${w.name} (WhatsApp) · ${on ? (linked ? `${linked} linked` : 'no session linked') : w.status}`,
          icon: dot(...DOT[w.status === 'running' ? 'running' : w.status === 'starting' || w.status === 'stopping' ? 'busy' : w.status === 'crashed' ? 'down' : 'stopped']),
          submenu: [
            { label: 'Open', click: act('whatsapp', () => a.show('whatsapp')) },
            on ? { label: 'Stop', click: act(`wa-stop-${w.engine}`, () => a.waAction(w.engine, 'stop')) } : { label: 'Start', click: act(`wa-start-${w.engine}`, () => a.waAction(w.engine, 'start')) },
            { label: 'Restart', enabled: on, click: act(`wa-restart-${w.engine}`, () => a.waAction(w.engine, 'restart')) },
          ],
        };
      }),
      ...gw.map((g) => {
        const on = g.status === 'running' || g.status === 'starting';
        return {
          label: `${g.name}${g.category === 'telegram' ? '' : ` (${g.category === 'email' ? 'email' : g.category === 'push' ? 'push' : 'SMS'})`} · ${g.status}`,
          icon: dot(...DOT[g.status === 'running' ? 'running' : g.status === 'starting' || g.status === 'stopping' ? 'busy' : g.status === 'crashed' ? 'down' : 'stopped']),
          submenu: [
            { label: 'Open', click: act('whatsapp', () => a.show('whatsapp')) },
            on ? { label: 'Stop', click: act(`gw-stop-${g.kind}`, () => a.gwAction(g.kind, 'stop')) } : { label: 'Start', click: act(`gw-start-${g.kind}`, () => a.gwAction(g.kind, 'start')) },
            { label: 'Restart', enabled: on, click: act(`gw-restart-${g.kind}`, () => a.gwAction(g.kind, 'restart')) },
          ],
        };
      }),
      ...(state.expose.shares.length
        ? [
            { label: 'Shared sites', enabled: false },
            ...state.expose.shares.map((s) => ({
              label: `${s.siteName} · ${s.url?.replace(/^https:\/\//, '') ?? s.status}`,
              icon: dot(...DOT[s.status === 'running' ? 'running' : s.status === 'starting' ? 'busy' : s.status === 'crashed' ? 'down' : 'stopped']),
              submenu: [
                { label: 'Copy URL', enabled: Boolean(s.url), click: act(`expose-copy-${s.id}`, () => a.copy(s.url!)) },
                { label: 'Open', enabled: Boolean(s.url), click: act(`expose-open-${s.id}`, () => a.openUrl(s.url!)) },
                { label: 'Requests…', click: act(`expose-show-${s.id}`, () => a.show('expose')) },
                { label: 'Stop sharing', click: act(`expose-stop-${s.id}`, () => a.exposeStop(s.id)) },
              ],
            })),
          ]
        : []),
      { type: 'separator' },
      running
        ? { label: 'Stop All', click: act('stop-all', () => a.stopAll()) }
        : { label: 'Start All', click: act('start-all', () => a.startAll()), enabled: total > 0 },
      { type: 'separator' },
      // Like Laravel Herd's nginx / dnsmasq / PHP-FPM rows: a status dot icon + name · state.
      { label: 'Services', enabled: false },
      status(state.services.proxy ? 'running' : 'down', isWin ? 'Proxy' : 'Proxy (nginx)', undefined, act('services', () => a.show('settings'))),
      ...(isWin ? [] : [status(state.services.dns, 'DNS (dnsmasq)', state.services.dns === 'not-needed' ? 'not needed for .localhost' : undefined, act('services', () => a.show('settings')))]),
      ...(fpm.length
        ? fpm.map((f) => status(f.running ? 'running' : 'down', `${words.phpServer} ${f.version}`, `${f.sites.length} site${f.sites.length === 1 ? '' : 's'}`, act('services', () => a.show('php'))))
        : [status('not-needed', words.phpServer, 'no PHP sites', act('services', () => a.show('php')))]),
      { label: 'Restart Services', click: act('restart-services', () => a.restartServices()) },
      { type: 'separator' },
      // Database services: status and start/stop per instance.
      { label: 'Databases', enabled: false },
      ...(dbs.length
        ? dbs.map((d) => {
            const on = d.status === 'running' || d.status === 'starting';
            return {
              label: `${d.name} · ${d.status}`,
              icon: dot(...DOT[d.status === 'running' ? 'running' : d.status === 'starting' || d.status === 'stopping' ? 'busy' : d.status === 'crashed' ? 'down' : 'stopped']),
              submenu: [
                { label: `${d.engineName} ${d.version} · 127.0.0.1:${d.port}`, enabled: false },
                on
                  ? { label: 'Stop', click: act(`db-stop-${d.id}`, () => a.dbAction(d.id, 'stop')) }
                  : { label: 'Start', click: act(`db-start-${d.id}`, () => a.dbAction(d.id, 'start')) },
                { label: 'Restart', enabled: on, click: act(`db-restart-${d.id}`, () => a.dbAction(d.id, 'restart')) },
              ],
            };
          })
        : [{ label: 'Set up a database…', click: act('database', () => a.show('database')) }]),
      { type: 'separator' },
      // Object storage: status and controls per installed service.
      ...(isWin ? [] : [{ label: 'Object Storage', enabled: false }]),
      ...(isWin ? [] : storage.length
        ? storage.map((s) => {
            const on = s.status === 'running' || s.status === 'starting';
            return {
              label: `${s.name} · ${s.status}`,
              icon: dot(...DOT[s.status === 'running' ? 'running' : s.status === 'starting' || s.status === 'stopping' ? 'busy' : s.status === 'crashed' ? 'down' : 'stopped']),
              submenu: [
                on
                  ? { label: 'Stop', click: act(`storage-stop-${s.kind}`, () => a.storageAction(s.kind, 'stop')) }
                  : { label: 'Start', click: act(`storage-start-${s.kind}`, () => a.storageAction(s.kind, 'start')) },
                { label: 'Restart', enabled: on, click: act(`storage-restart-${s.kind}`, () => a.storageAction(s.kind, 'restart')) },
                { type: 'separator' as const },
                { label: 'Open Console', enabled: s.status === 'running', click: act(`storage-console-${s.kind}`, () => a.openUrl(s.urls!.console)) },
                { label: 'Open API', enabled: s.status === 'running', click: act(`storage-api-${s.kind}`, () => a.openUrl(s.urls!.api)) },
              ],
            };
          })
        : [{ label: 'Set up storage…', click: act('storage', () => a.show('storage')) }]),
      ...(isWin ? [] : [{ type: 'separator' as const }]),
      // WebSocket servers: only the installed ones (nothing when none is).
      ...(ws.length
        ? [
            { label: 'WebSocket', enabled: false },
            ...ws.map((w) => {
              const on = w.status === 'running' || w.status === 'starting';
              return {
                label: `${w.name} · ${w.status}`,
                icon: dot(...DOT[w.status === 'running' ? 'running' : w.status === 'starting' || w.status === 'stopping' ? 'busy' : w.status === 'crashed' ? 'down' : 'stopped']),
                submenu: [
                  on
                    ? { label: 'Stop', click: act(`ws-stop-${w.kind}`, () => a.wsAction(w.kind, 'stop')) }
                    : { label: 'Start', click: act(`ws-start-${w.kind}`, () => a.wsAction(w.kind, 'start')) },
                  { label: 'Restart', enabled: on, click: act(`ws-restart-${w.kind}`, () => a.wsAction(w.kind, 'restart')) },
                  { type: 'separator' as const },
                  { label: 'Open in DevCatz', click: act('websocket', () => a.show('websocket')) },
                ],
              };
            }),
            { type: 'separator' as const },
          ]
        : []),
      // Search engines: the same rule, only the installed ones.
      ...(search.length
        ? [
            { label: 'Search Engine', enabled: false },
            ...search.map((w) => {
              const on = w.status === 'running' || w.status === 'starting';
              return {
                label: `${w.name} · ${w.status}`,
                icon: dot(...DOT[w.status === 'running' ? 'running' : w.status === 'starting' || w.status === 'stopping' ? 'busy' : w.status === 'crashed' ? 'down' : 'stopped']),
                submenu: [
                  on
                    ? { label: 'Stop', click: act(`search-stop-${w.kind}`, () => a.searchAction(w.kind, 'stop')) }
                    : { label: 'Start', click: act(`search-start-${w.kind}`, () => a.searchAction(w.kind, 'start')) },
                  { label: 'Restart', enabled: on, click: act(`search-restart-${w.kind}`, () => a.searchAction(w.kind, 'restart')) },
                  { type: 'separator' as const },
                  { label: 'Open in DevCatz', click: act('search', () => a.show('search')) },
                ],
              };
            }),
            { type: 'separator' as const },
          ]
        : []),
      ...(updates.length
        ? [{ label: `Runtime Updates (${updates.length})…`, click: act('updates', () => a.show(updates[0].runtime)) }, { type: 'separator' as const }]
        : []),
      // DevCatz's own update (Catzoid #54): "Update to 0.x.y…" while one waits, else Check for Updates….
      ['available', 'downloading', 'downloaded'].includes(state.appUpdate.status) && state.appUpdate.version !== state.settings.appUpdateSkip
        ? { label: `Update to ${state.appUpdate.version}…`, click: act('app-update', () => a.show('update:show')) }
        : { label: 'Check for Updates…', click: act('app-update', () => a.show('update:check')) },
      { label: 'Settings…', accelerator: 'CommandOrControl+,', click: act('settings', () => a.show('settings')) },
      { type: 'separator' },
      { label: 'Quit', accelerator: 'CommandOrControl+Q', click: act('quit', () => a.quit()) },
    ]);
    menu.on('menu-will-show', () => {
      this.menuOpen = true;
      console.log('tray: menu opened');
    });
    menu.on('menu-will-close', () => {
      console.log('tray: menu closed');
      setTimeout(() => {
        this.menuOpen = false;
        const next = this.pending;
        this.pending = null;
        if (next) this.update(next);
      }, 500);
    });
    this.previousMenu = this.menu;
    this.menu = menu;
    this.tray.setContextMenu(menu);
  }
}
