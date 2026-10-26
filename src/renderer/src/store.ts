import { reactive, ref } from 'vue';
import type { AppState, LogLine, ReportKind } from '@shared/types';

export const herd = window.herd;

export const state = ref<AppState | null>(null);
export const logs = reactive(new Map<string, LogLine[]>());
export const toast = ref<{ kind: 'error' | 'success' | 'info'; text: string } | null>(null);

let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(kind: 'error' | 'success' | 'info', text: string): void {
  toast.value = { kind, text };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = null), kind === 'error' ? 7000 : 3500);
}

/** Runs an IPC call and turns failures into a toast. */
export async function attempt<T>(fn: () => Promise<T>, success?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (success) notify('success', success);
    return r;
  } catch (e) {
    notify('error', String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return undefined;
  }
}

const MAX = 5000;

function applyTheme(mode: AppState['settings']['theme']): void {
  // DaisyUI follows prefers-color-scheme without the attribute; set it to force a theme.
  if (mode === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', mode);
}

export async function init(): Promise<void> {
  state.value = await herd.getState();
  applyTheme(state.value.settings.theme);
  herd.onState((s) => {
    state.value = s;
    applyTheme(s.settings.theme);
  });
  herd.onLogs((lines) => {
    for (const line of lines) {
      if (!logs.has(line.projectId)) continue; // loaded lazily on first view
      const buf = logs.get(line.projectId)!;
      buf.push(line);
      if (buf.length > MAX) buf.splice(0, buf.length - MAX);
    }
  });
}

export async function loadLogs(id: string): Promise<void> {
  if (!logs.has(id)) logs.set(id, await herd.getLogs(id));
}

/** A component asks App to switch section (e.g. a site's WebSocket tab → the WebSocket page). */
/** New Site → Clone with this repository filled in (Git page "Clone as site…"). */
export const cloneRequest = ref<{ url: string; name: string; branch: string } | null>(null);
/** Selects a site in Projects (e.g. a worktree's parent, a new worktree site). */
export const openSiteRequest = ref<string | null>(null);
/** Opens a site on one of its tabs (menu bar "Commit…" → Git). */
export const siteTabRequest = ref<{ id: string; tab: string } | null>(null);
/** Monitor → Dependencies → a site: its Settings tab scrolls to the Free up space card (the site's id). */
export const freeSpaceRequest = ref<string | null>(null);
/** Database page: "New Group…" / "Rename Group…" from the native context menus (`db-new-group:<id>` / `db-rename-group:<name>`). */
export const dbGroupRequest = ref<{ mode: 'new' | 'rename'; id?: string; from?: string } | null>(null);
/** Ask DevCatz's "Uninstall …": the service's page opens its own uninstall dialog (typed confirmation), never a silent uninstall. */
export const uninstallRequest = ref<{ scope: 'db' | 'storage' | 'ws' | 'search' | 'gateway' | 'whatsapp'; id: string } | null>(null);
export const navRequest = ref<{ section: 'projects' | 'websocket' | 'search' | 'database' | 'storage' | 'runtimes' | 'git' | 'mail' | 'whatsapp' | 'expose' | 'monitoring' | 'settings'; id?: string } | null>(null);

/** What's New / update progress (Catzoid #54): open from the app menu, the notification, Settings or About. */
export const updateDialog = ref(false);
/** Report a Bug / Send Feedback (Catzoid #65): the kind it opens with, null = closed. */
export const reportDialog = ref<ReportKind | null>(null);
/** Uninstall DevCatz (Catzoid #55). */
export const uninstallDialog = ref(false);
