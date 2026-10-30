<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { attempt, cloneRequest, dbGroupRequest, herd, init, navRequest, notify, openSiteRequest, reportDialog, siteTabRequest, state, toast, updateDialog } from './store';
import UpdateDialog from './components/UpdateDialog.vue';
import ReportDialog from './components/ReportDialog.vue';
import UninstallDialog from './components/UninstallDialog.vue';
import WelcomeDialog from './components/WelcomeDialog.vue';
import ProjectView from './components/ProjectView.vue';
import askMark from './assets/logos/ask-catzoid.svg';
import CatMood from './components/CatMood.vue';
import SettingsView from './components/SettingsView.vue';
import NewSiteDialog from './components/NewSiteDialog.vue';
import ParkDialog from './components/ParkDialog.vue';
import StackMark from './components/StackMark.vue';
import DatabaseView from './components/DatabaseView.vue';
import WebSocketView from './components/WebSocketView.vue';
import SearchView from './components/SearchView.vue';
import RuntimesView, { type RuntimeId } from './components/RuntimesView.vue';
import MonitoringView from './components/MonitoringView.vue';
import GitView from './components/GitView.vue';
import MailView from './components/MailView.vue';
import WhatsAppView from './components/WhatsAppView.vue';
import ExposeView from './components/ExposeView.vue';
import StorageView from './components/StorageView.vue';
import AskDevCatz from './components/AskDevCatz.vue';
import { aiOn } from './ai';
import StatusDot from './components/StatusDot.vue';
import PopMenu from './components/PopMenu.vue';
import { groupByType, sortList, useListView } from './listview';
import { ICONS, STAR } from './icons';
import { siteStatus, stackTag } from './runtimes';
import { backIndex, backList, canBack, canForward, forwardList, goBack, goForward, goTo, navApply, navPrune, navVisit, type NavEntry } from './nav';
import type { ProjectState } from '@shared/types';
import { isWin, WIN_SECTIONS } from './platform';

const PANELS = ['node', 'bun', 'go', 'rust', 'php', 'python'];

/** Sidebar Git chip: changed files and commits to push / pull ("3 · ↑1"). */
function gitBadge(p: ProjectState): string {
  const g = p.git;
  if (!g) return '';
  if (g.operation) return g.operation;
  return [g.changed ? `●${g.changed}` : '', g.ahead ? `↑${g.ahead}` : '', g.behind ? `↓${g.behind}` : ''].filter(Boolean).join(' ');
}
function gitTitle(p: ProjectState): string {
  const g = p.git!;
  return [
    g.branch ?? 'detached HEAD',
    g.changed ? `${g.changed} changed file${g.changed === 1 ? '' : 's'}` : 'clean',
    g.ahead ? `${g.ahead} to push` : '',
    g.behind ? `${g.behind} to pull` : '',
    g.conflicts ? `${g.conflicts} conflict${g.conflicts === 1 ? '' : 's'}` : '',
    g.operation ? `${g.operation} in progress` : '',
  ]
    .filter(Boolean)
    .join(' · ');
}

type AppSection = 'projects' | 'runtimes' | 'database' | 'storage' | 'websocket' | 'search' | 'git' | 'mail' | 'whatsapp' | 'expose' | 'monitoring' | 'settings';
const RAIL: { id: AppSection; label: string; short: string; icon: 'projects' | 'terminal' | 'database' | 'bucket' | 'websocket' | 'search' | 'git' | 'mail' | 'gateway' | 'expose' | 'monitoring' }[] = [
  { id: 'projects', label: 'Projects', short: 'Projects', icon: 'projects' },
  { id: 'runtimes', label: 'Runtimes: PHP, Python, Node.js, Bun, Go', short: 'Runtimes', icon: 'terminal' },
  { id: 'database', label: 'Database', short: 'Database', icon: 'database' },
  { id: 'storage', label: 'Object Storage', short: 'Storage', icon: 'bucket' },
  { id: 'websocket', label: 'WebSocket', short: 'WebSocket', icon: 'websocket' },
  { id: 'search', label: 'Search Engine', short: 'Search', icon: 'search' },
  // New sections go here: Monitor stays the last one.
  { id: 'git', label: 'Git: accounts, repositories, SSH keys', short: 'Git', icon: 'git' },
  { id: 'mail', label: 'Mail: every mail the sites send, caught here', short: 'Mail', icon: 'mail' },
  { id: 'whatsapp', label: 'Gateways: WhatsApp (GOWA, WAHA), sessions, messages, webhooks', short: 'Gateways', icon: 'gateway' },
  { id: 'expose', label: 'Expose: share a site on a public URL', short: 'Expose', icon: 'expose' },
  { id: 'monitoring', label: 'Monitoring', short: 'Monitor', icon: 'monitoring' },
];
// Windows, stage 1: only the sections that work there so far (Catzoid #57).
const railShown = isWin ? RAIL.filter((r) => WIN_SECTIONS.has(r.id)) : RAIL;
/** Remembered per window (convenience only). */
const section = ref<AppSection>(
  (() => {
    try {
      const v = localStorage.getItem('mrcatz-herd.section');
      return ['runtimes', 'database', 'storage', 'websocket', 'search', 'git', 'mail', 'whatsapp', 'expose', 'monitoring', 'settings'].includes(v ?? '') ? (v as AppSection) : 'projects';
    } catch {
      return 'projects';
    }
  })(),
);
watch(section, (v) => {
  try {
    localStorage.setItem('mrcatz-herd.section', v);
  } catch {
    /* storage unavailable */
  }
});
const selected = ref<string | null>(null);
/** Runtimes section: the runtime shown (remembered per window). */
const runtime = ref<RuntimeId>(
  (() => {
    try {
      const v = localStorage.getItem('mrcatz-herd.runtime');
      return PANELS.includes(v ?? '') ? (v as RuntimeId) : 'php';
    } catch {
      return 'php';
    }
  })(),
);
watch(runtime, (v) => {
  try {
    localStorage.setItem('mrcatz-herd.runtime', v);
  } catch {
    /* storage unavailable */
  }
});
const ready = ref(false);


const projects = computed(() => state.value?.projects ?? []);
const current = computed(() => projects.value.find((p) => p.id === selected.value) ?? null);
/** Runtime updates waiting: a dot on the Runtimes rail item. */
const runtimeUpdates = computed(() => state.value?.updates.list.length ?? 0);

/** Sidebar: ★ Favorites, then the user's groups, then the rest ("Other sites" once groups exist). */
interface Section {
  key: string;
  title: string;
  group?: string;
  collapsed?: boolean;
  sites: ProjectState[];
  running: number;
}
const favs = computed(() => new Set(state.value?.settings.favorites ?? []));
/** Sidebar search: name, domain, stack tag or group name; `/` or ⌘F focuses it, Esc clears. */
const query = ref('');
const searchBox = ref<HTMLInputElement | null>(null);
const matches = (p: ProjectState, groupName: string | null) => {
  const q = query.value.trim().toLowerCase();
  if (!q) return true;
  return [p.name, p.domain, stackTag(p).label, groupName ?? ''].some((s) => s.toLowerCase().includes(q));
};
function onSearchKey(e: KeyboardEvent) {
  // A code editor's own ⌘F (find in the file) already took it.
  if (e.defaultPrevented) return;
  const t = e.target as HTMLElement | null;
  const typing = t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName);
  if (((e.metaKey || e.ctrlKey) && e.key === 'f') || (!typing && e.key === '/')) {
    if (section.value !== 'projects') return;
    e.preventDefault();
    searchBox.value?.focus();
    searchBox.value?.select();
  }
}
onMounted(() => window.addEventListener('keydown', onSearchKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onSearchKey));

/** Sort and grouping of the sidebar (⇅ menu): default = drag-and-drop order and the user's groups. */
const listView = useListView('mrcatz-herd.sites.view', 'stack', 'Running sites only');
const view = listView.view;
/**
 * "Running sites only" (⇅ menu): what the status dot shows as running or starting — PHP sites served by PHP-FPM
 * (always on) included, as in the "N running" count.
 */
const started = (p: ProjectState) => ['running', 'starting'].includes(siteStatus(p));
const startedCount = computed(() => projects.value.filter(started).length);
const shown = (p: ProjectState, groupName: string | null) => matches(p, groupName) && (!view.value.runningOnly || started(p));
/** Worktree sites hang under their parent site (not listed on their own while the parent exists). */
const worktreeKids = computed(() => {
  const ids = new Set(projects.value.map((p) => p.id));
  const map = new Map<string, ProjectState[]>();
  for (const p of ordered.value) if (p.worktreeOf && ids.has(p.worktreeOf)) map.set(p.worktreeOf, [...(map.get(p.worktreeOf) ?? []), p]);
  return map;
});
const isChild = (p: ProjectState) => Boolean(p.worktreeOf && projects.value.some((x) => x.id === p.worktreeOf));
/** A parent stays listed when one of its worktrees matches the search / filter. */
const shownTree = (p: ProjectState, groupName: string | null) => shown(p, groupName) || (worktreeKids.value.get(p.id) ?? []).some((c) => shown(c, groupName));
/** The worktrees shown under a parent row: all of them, or while filtering only those that match. */
function kidsShown(p: ProjectState, groupName: string | null): ProjectState[] {
  const kids = worktreeKids.value.get(p.id) ?? [];
  return query.value.trim() || view.value.runningOnly ? kids.filter((c) => shown(c, groupName)) : kids;
}
/** Sidebar order: the drag-and-drop order first, sites not placed yet after it (creation order); or by name / stack. */
const ordered = computed(() => {
  const idx = new Map((state.value?.settings.siteOrder ?? []).map((id, i) => [id, i]));
  const base = [...projects.value].map((p, i) => ({ p, k: idx.get(p.id) ?? 1e6 + i })).sort((a, b) => a.k - b.k).map((x) => x.p);
  return sortList(base, view.value.sort, (p) => p.name, (p) => stackTag(p).label);
});
const sections = computed<Section[]>(() => {
  const all = ordered.value.filter((p) => !isChild(p));
  const searching = query.value.trim() !== '';
  // Filtering (search or started only) hides empty groups; only searching opens collapsed ones.
  const filtering = searching || view.value.runningOnly;
  const groups = state.value?.settings.siteGroups ?? [];
  // Collapsed state: the user's groups keep it in Settings, the other sections (favorites, type, rest) per window; searching opens everything.
  const mk = (key: string, title: string, sites: ProjectState[], extra: Partial<Section> = {}): Section => ({
    key, title, sites, running: sites.filter((p) => siteStatus(p) === 'running').length, collapsed: searching ? false : listView.isCollapsed(key), ...extra,
  });
  const out: Section[] = [];
  const favSites = all.filter((p) => favs.value.has(p.id) && shownTree(p, 'favorites'));
  if (favSites.length) out.push(mk('fav', 'Favorites', favSites));
  if (view.value.group === 'type') {
    for (const [label, sites] of groupByType(all.filter((p) => shownTree(p, null)), (p) => stackTag(p).label)) out.push(mk(`t:${label}`, label, sites));
    return out;
  }
  if (view.value.group === 'none') {
    const sites = all.filter((p) => shownTree(p, null));
    if (sites.length || !filtering) out.push(mk('rest', out.length ? 'All sites' : '', sites));
    return out;
  }
  const grouped = new Set<string>();
  for (const g of groups) {
    const members = new Set(g.sites);
    const all_ = all.filter((p) => members.has(p.id));
    all_.forEach((p) => grouped.add(p.id));
    const sites = all_.filter((p) => shownTree(p, g.name));
    // While searching, groups open up and empty ones disappear.
    if (!filtering || sites.length) out.push(mk(`g:${g.name}`, g.name, sites, { group: g.name, collapsed: searching ? false : g.collapsed }));
  }
  const rest = all.filter((p) => !grouped.has(p.id) && shownTree(p, null));
  if (rest.length || (!out.length && !filtering)) out.push(mk('rest', out.length ? (groups.length ? 'Other sites' : 'All sites') : '', rest));
  return out;
});

const dragId = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
function onDrop(sec: Section) {
  const id = dragId.value;
  dragId.value = null;
  dropTarget.value = null;
  if (!id) return;
  if (sec.key === 'fav') void attempt(() => herd.setFavorite(id, true));
  else if (view.value.group === 'default') void attempt(() => herd.setSiteGroup(id, sec.group ?? null));
}
/** Dropped on a site row: placed before it (and moved into its section when that differs). */
const dropRow = ref<string | null>(null);
function onDropRow(target: ProjectState, sec: Section) {
  const id = dragId.value;
  dragId.value = null;
  dropTarget.value = null;
  dropRow.value = null;
  if (!id || id === target.id) return;
  const order = ordered.value.map((p) => p.id).filter((x) => x !== id);
  order.splice(order.indexOf(target.id), 0, id);
  void attempt(async () => {
    // Reordering only makes sense in the default sort; the group move only with the user's groups shown.
    if (view.value.sort === 'default') await herd.setSiteOrder(order);
    else notify('info', 'Sorted by name / stack: switch to the default sort (⇅) to reorder by hand');
    if (sec.key === 'fav') {
      if (!favs.value.has(id)) await herd.setFavorite(id, true);
    } else if (view.value.group === 'default') {
      const current = state.value?.settings.siteGroups.find((g) => g.sites.includes(id))?.name ?? null;
      if (current !== (sec.group ?? null)) await herd.setSiteGroup(id, sec.group ?? null);
    }
  });
}

/** "New Group…" / "Rename Group…" from the native context menus. */
const groupDialog = ref<{ mode: 'new' | 'rename'; site?: string; from?: string; name: string } | null>(null);
async function saveGroup() {
  const d = groupDialog.value;
  if (!d || !d.name.trim()) return;
  const ok = await attempt(() => (d.mode === 'new' ? herd.setSiteGroup(d.site!, d.name) : herd.renameGroup(d.from!, d.name)).then(() => true));
  if (ok) groupDialog.value = null;
}

const runningCount = computed(() => projects.value.filter((p) => siteStatus(p) === 'running').length);

// ---- Back / forward (nav.ts): record where the window is, and go back there.
const itemOf = (sec: AppSection) => (sec === 'projects' ? selected.value : sec === 'runtimes' ? runtime.value : undefined);
watch(section, (sec) => navVisit({ section: sec, item: itemOf(sec) ?? null }));
watch(selected, (id) => section.value === 'projects' && navVisit({ section: 'projects', item: id }));
watch(runtime, (r) => section.value === 'runtimes' && navVisit({ section: 'runtimes', item: r }));
watch(navApply, async (r) => {
  if (!r) return;
  const { section: sec, item, tab } = r.entry;
  section.value = sec as AppSection;
  if (sec === 'projects' && item) {
    selected.value = item;
    if (tab) siteTabRequest.value = { id: item, tab };
  }
  if (sec === 'runtimes' && item) runtime.value = item as RuntimeId;
  // Focus props only react to a change: clear them first so going back to the same service / tab still applies.
  if (sec === 'database' || sec === 'storage' || sec === 'settings') {
    dbFocus.value = storageFocus.value = settingsFocus.value = null;
    await nextTick();
    if (sec === 'database') dbFocus.value = item ?? null;
    if (sec === 'storage') storageFocus.value = item ?? null;
    if (sec === 'settings') settingsFocus.value = tab ?? null;
  }
});
// Removed sites / database services drop out of the history.
watch(
  () => [projects.value.length, state.value?.databases.length],
  () =>
    navPrune(
      (e) =>
        !e.item ||
        (e.section === 'projects' ? projects.value.some((p) => p.id === e.item) : e.section === 'database' ? (state.value?.databases ?? []).some((d) => d.id === e.item) : true),
    ),
);
/** "Shop · Git", "Database · mysql-1", "Settings · Mail" for the history menus. */
function navLabel(e: NavEntry): string {
  const rail = e.section === 'settings' ? 'Settings' : (RAIL.find((r) => r.id === e.section)?.short ?? e.section);
  const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);
  const item =
    e.section === 'projects'
      ? projects.value.find((p) => p.id === e.item)?.name
      : e.section === 'database'
        ? state.value?.databases.find((d) => d.id === e.item)?.name
        : e.item
          ? cap(e.item)
          : undefined;
  return [e.section === 'projects' && item ? null : rail, item, e.tab ? cap(e.tab === 'whatsapp' ? 'gateways' : e.tab) : null].filter(Boolean).join(' · ');
}
const backItems = computed(() => backList.value.map((e, i) => ({ label: navLabel(e), action: () => goTo('back', backIndex(i)) })));
const forwardItems = computed(() => forwardList.value.map((e, i) => ({ label: navLabel(e), action: () => goTo('forward', i) })));
const backMenu = ref<{ toggle: () => void } | null>(null);
const forwardMenu = ref<{ toggle: () => void } | null>(null);
/** Ask DevCatz (⌘K): plain-word commands turned into DevCatz actions (Settings → AI). */
const askOn = aiOn('ask');
const askOpen = ref(false);
/** ⌘[ / ⌘] (Ctrl on Windows) and the mouse's back / forward buttons; ⌘K for Ask DevCatz. */
function onHistoryKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
  if (e.key.toLowerCase() === 'k' && askOn.value) {
    e.preventDefault();
    askOpen.value = !askOpen.value;
    return;
  }
  if (e.key === '[') {
    e.preventDefault();
    goBack();
  } else if (e.key === ']') {
    e.preventDefault();
    goForward();
  }
}
function onHistoryMouse(e: MouseEvent) {
  if (e.button === 3) goBack();
  else if (e.button === 4) goForward();
}
onMounted(() => {
  window.addEventListener('keydown', onHistoryKey);
  window.addEventListener('mouseup', onHistoryMouse);
});
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onHistoryKey);
  window.removeEventListener('mouseup', onHistoryMouse);
});

// Uncaught errors in the window: reported when crash reports are on (Catzoid #65; the main process decides).
const reportWindowError = (message: string, stack?: string | null) => void herd.reportError(message, stack ?? null).catch(() => undefined);
window.addEventListener('error', (e) => reportWindowError(e.message, (e.error as Error | undefined)?.stack));
window.addEventListener('unhandledrejection', (e) => reportWindowError(String((e.reason as Error)?.message ?? e.reason), (e.reason as Error)?.stack));
/** A DevCatz update waits that was not skipped: a dot on the Settings gear. */
const updateDot = computed(() => {
  const u = state.value?.appUpdate;
  return !!u && ['available', 'downloading', 'downloaded'].includes(u.status) && u.version !== state.value?.settings.appUpdateSkip;
});

onMounted(async () => {
  await init();
  ready.value = true;
  selected.value = projects.value[0]?.id ?? null;
  navVisit({ section: section.value, item: itemOf(section.value) ?? null });
  herd.onNavigate(navigate);
  const pending = await herd.takePendingNav();
  if (pending) navigate(pending);
});

/** Monitoring → "Open site / database / storage". */
function openFromMonitor(link: { section: 'projects' | 'database' | 'storage' | 'websocket' | 'search' | 'whatsapp'; id: string }) {
  section.value = link.section;
  if (link.section === 'whatsapp') waFocus.value = link.id;
  if (link.section === 'projects') selected.value = link.id;
  if (link.section === 'database') dbFocus.value = link.id;
  if (link.section === 'websocket') wsFocus.value = link.id;
  if (link.section === 'search') searchFocus.value = link.id;
}
const searchFocus = ref<string | null>(null);
const storageFocus = ref<string | null>(null);
/** Database page: the service to show (devcatz://db/<id> from DBCatz, Monitoring). */
const dbFocus = ref<string | null>(null);
/** WebSocket page: the server to show (from Monitoring or a site's WebSocket tab). */
const wsFocus = ref<string | null>(null);
const mailFocus = ref<string | null>(null);
const exposeFocus = ref<string | null>(null);
const waFocus = ref<string | null>(null);
const settingsFocus = ref<string | null>(null);
watch(navRequest, (r) => {
  if (!r) return;
  section.value = r.section;
  if (r.section === 'settings') settingsFocus.value = r.id ?? null;
  if (r.section === 'websocket') wsFocus.value = r.id ?? null;
  if (r.section === 'mail') mailFocus.value = r.id ?? null;
  if (r.section === 'expose') exposeFocus.value = r.id ?? null;
  if (r.section === 'whatsapp') waFocus.value = r.id ?? null;
  if (r.section === 'search') searchFocus.value = r.id ?? null;
  if (r.section === 'storage') storageFocus.value = r.id ?? null;
  if (r.section === 'database') dbFocus.value = r.id ?? null;
  navRequest.value = null;
});
const dismissToast = () => (toast.value = null);
// A view asks for a site (a worktree's parent, a new worktree site).
watch(openSiteRequest, (id) => {
  if (!id) return;
  section.value = 'projects';
  selected.value = id;
  openSiteRequest.value = null;
});
// Git page "Clone as site…": the New Site dialog on its Clone step.
watch(cloneRequest, (r) => {
  if (!r) return;
  section.value = 'projects';
  newSiteOpen.value = true;
});
function openSite(id: string) {
  section.value = 'projects';
  selected.value = id;
}

/** Menu bar navigation: `sites`, `settings`, `new-site` or `site:<id>`. */
const newSiteOpen = ref(false);
/** The folder being parked (its dialog: park as a group, and the group's name). */
const parking = ref<string | null>(null);
function navigate(target: string) {
  // Trackpad swipe (macOS) and the mouse / keyboard browser keys (Windows) arrive from the main process.
  if (target === 'history:back') return goBack();
  if (target === 'history:forward') return goForward();
  // Check for Updates… / the update notification (Catzoid #54); Help → Report a Bug… / Send Feedback… (#65).
  if (target === 'update:check' || target === 'update:show') {
    updateDialog.value = true;
    if (target === 'update:check' && !['available', 'downloading', 'downloaded'].includes(state.value?.appUpdate.status ?? '')) void attempt(() => herd.appUpdateCheck());
    return;
  }
  if (target === 'report:bug' || target === 'report:idea') {
    reportDialog.value = target === 'report:bug' ? 'bug' : 'idea';
    return;
  }
  // `settings:<tab>`: a Settings tab (About DevCatz in the app menu → settings:about).
  if (target.startsWith('settings:')) {
    section.value = 'settings';
    settingsFocus.value = null;
    void nextTick(() => (settingsFocus.value = target.slice(9)));
    return;
  }
  // Menu bar targets all live in Projects.
  if (['settings', 'storage', 'database', 'websocket', 'search', 'git', 'mail', 'whatsapp', 'expose', 'monitoring'].includes(target)) {
    section.value = target as AppSection;
    return;
  }
  // Menu bar "PHP-FPM" etc. open that runtime.
  if (PANELS.includes(target)) {
    section.value = 'runtimes';
    runtime.value = target as RuntimeId;
    return;
  }
  if (!target.startsWith('new-group:') && !target.startsWith('rename-group:')) section.value = 'projects';
  if (target.startsWith('db:')) {
    section.value = 'database';
    dbFocus.value = target.slice(3);
    return;
  }
  if (target.startsWith('db-new-group:') || target.startsWith('db-rename-group:')) {
    section.value = 'database';
    dbGroupRequest.value = target.startsWith('db-new-group:') ? { mode: 'new', id: target.slice(13) } : { mode: 'rename', from: target.slice(16) };
    return;
  }
  if (target.startsWith('new-group:')) groupDialog.value = { mode: 'new', site: target.slice(10), name: '' };
  else if (target.startsWith('rename-group:')) groupDialog.value = { mode: 'rename', from: target.slice(13), name: target.slice(13) };
  else if (target === 'new-site') newSiteOpen.value = true;
  else if (target.startsWith('site:')) selected.value = target.slice(5);
  else if (target.startsWith('git:')) {
    siteTabRequest.value = { id: target.slice(4), tab: 'git' };
    selected.value = target.slice(4);
  }
}

function onCreated(id: string) {
  newSiteOpen.value = false;
  selected.value = id;
}
async function parkFromDialog() {
  newSiteOpen.value = false;
  await park();
}

async function park() {
  const dir = await herd.pickFolder();
  if (dir) parking.value = dir;
}
</script>

<template>
  <div v-if="ready && state" class="flex h-full text-sm">
    <!-- Section rail: Projects, Database, Object Storage. The top stays free for the window's traffic lights. -->
    <nav class="flex w-24 shrink-0 flex-col items-center gap-1 border-r border-base-300/60 bg-base-200/60 pb-3 backdrop-blur-xl">
      <!-- The window's close / minimise / full-screen buttons sit here, centred in the rail (main/index.ts). -->
      <div class="drag h-14 w-full shrink-0" />
      <!-- Scrolls (no bar) when the window is too short for every section. -->
      <div class="rail-scroll no-scrollbar flex min-h-0 w-full flex-1 flex-col items-center gap-1 overflow-y-auto pb-3">
        <button
          v-for="r in railShown"
          :key="r.id"
          class="rail-item relative shrink-0"
          :class="{ 'is-active': section === r.id }"
          :style="{ '--rail-c': `var(--c-${r.id})` }"
          :title="r.label"
          @click="section = r.id"
        >
          <span class="rail-icon"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS[r.icon]" /></svg></span>
          {{ r.short }}
          <span v-if="r.id === 'runtimes' && runtimeUpdates" class="absolute top-1.5 right-4 size-2 rounded-full bg-info ring-2 ring-base-200" title="Runtime updates available" />
          <span v-if="r.id === 'mail' && state?.mail.unread" class="absolute top-1 right-3 rounded-full bg-[var(--c-mail)] px-1.5 text-[10px] font-semibold leading-4 text-white ring-2 ring-base-200" :title="`${state.mail.unread} new mail`">{{ state.mail.unread > 99 ? '99+' : state.mail.unread }}</span>
          <span v-if="r.id === 'whatsapp' && state?.whatsapp.some((w) => w.status === 'running')" class="absolute top-1.5 right-4 size-2 rounded-full bg-success ring-2 ring-base-200" title="A gateway is running" />
          <span v-if="r.id === 'expose' && state?.expose.shares.some((s) => s.status === 'running')" class="absolute top-1.5 right-4 size-2 rounded-full bg-success ring-2 ring-base-200" title="A site is shared" />
        </button>
      </div>
      <!-- Settings stays put below the scrolling sections: a divider keeps the cut clean. -->
      <div class="mb-2 h-px w-12 shrink-0 bg-base-content/15" />
      <button class="rail-item relative shrink-0" :class="{ 'is-active': section === 'settings' }" style="--rail-c: var(--c-settings)" :title="`Settings (${keyLabel('mod+,')})`" @click="section = 'settings'">
        <span class="rail-icon"><svg class="size-5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.cog" /></svg></span>
        Settings
        <span v-if="updateDot" class="absolute top-1.5 right-4 size-2 rounded-full bg-primary ring-2 ring-base-200" :title="`DevCatz ${state?.appUpdate.version} is available`" />
        <span v-else-if="state?.cert.caTrusted === false" class="absolute top-1.5 right-4 size-2 rounded-full bg-warning ring-2 ring-base-200" title="HTTPS certificate not trusted" />
      </button>
    </nav>

    <template v-if="section === 'projects'">
    <!-- Sidebar -->
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip flex h-14 items-end justify-end gap-1 px-3 pb-2">
        <span class="nav-hole" aria-hidden="true" />
        <button class="btn btn-ghost btn-sm btn-square" title="Create New Site" @click="newSiteOpen = true">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
        </button>
      </div>

      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">Sites</span>
        <span v-if="runningCount && !view.runningOnly" class="badge badge-success badge-soft badge-xs">{{ runningCount }} running</span>
        <button
          v-if="view.runningOnly"
          class="badge badge-primary badge-soft badge-xs gap-1"
          :title="`Showing the ${startedCount} running sites of ${projects.length}: click to show all`"
          @click="listView.setRunningOnly(false)"
        >Running · {{ startedCount }} of {{ projects.length }} <span class="opacity-70">✕</span></button>
        <span class="flex-1" />
        <PopMenu :items="listView.items.value" align="end" :width="260">
          <button class="btn btn-ghost btn-xs btn-square" :class="{ 'text-primary': listView.custom.value }" title="Sort and group">
            <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M2.5 5.25A.75.75 0 0 1 3.25 4.5h13.5a.75.75 0 0 1 0 1.5H3.25a.75.75 0 0 1-.75-.75Zm2 4A.75.75 0 0 1 5.25 8.5h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Zm2 4a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" /></svg>
          </button>
        </PopMenu>
      </div>
      <label v-if="projects.length" class="search-box mx-3 mb-1">
        <svg class="size-3.5 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>
        <input
          ref="searchBox"
          v-model="query"
          type="text"
          placeholder="Search sites"
          spellcheck="false"
          @keydown.esc.stop="query = ''; ($event.target as HTMLInputElement).blur()"
        />
        <kbd v-if="!query" class="kbd kbd-xs opacity-60">/</kbd>
        <button v-else class="btn btn-ghost btn-xs btn-circle" title="Clear" @click="query = ''">×</button>
      </label>
      <ul class="menu w-full flex-1 flex-nowrap overflow-y-auto px-2 py-1" @dragend="dropTarget = null">
        <template v-for="sec in sections" :key="sec.key">
          <li
            v-if="sec.title"
            class="menu-title mt-1 flex-row items-center gap-1 rounded-md px-3 py-1 text-xs"
            :class="{ 'bg-primary/15': dropTarget === sec.key }"
            @dragover.prevent="dropTarget = sec.key"
            @dragleave="dropTarget = dropTarget === sec.key ? null : dropTarget"
            @drop.prevent="onDrop(sec)"
            @contextmenu.prevent="sec.group && herd.groupMenu(sec.group)"
          >
            <button class="flex flex-1 items-center gap-1 text-left" @click="sec.group ? herd.toggleGroup(sec.group) : listView.toggle(sec.key)">
              <svg class="size-3 transition-transform" :class="{ '-rotate-90': sec.collapsed }" viewBox="0 0 20 20" fill="currentColor"><path d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" /></svg>
              <svg v-if="sec.key === 'fav'" class="size-3 text-warning" viewBox="0 0 20 20" fill="currentColor"><path :d="STAR" /></svg>
              <span class="truncate">{{ sec.title }}</span>
            </button>
            <span class="sec-count" :class="{ 'is-live': sec.running }" :title="sec.running ? `${sec.running} of ${sec.sites.length} running` : `${sec.sites.length} sites`">
              <span v-if="sec.running" class="status status-success status-xs" />
              {{ sec.running ? `${sec.running}/${sec.sites.length}` : sec.sites.length }}
            </span>
          </li>
          <template v-if="!sec.collapsed">
            <template v-for="p in sec.sites" :key="sec.key + p.id">
            <li
              draggable="true"
              :class="{ 'drop-before': dropRow === p.id && dragId !== p.id }"
              @dragstart="dragId = p.id"
              @dragover.prevent.stop="dropRow = p.id"
              @dragleave="dropRow = dropRow === p.id ? null : dropRow"
              @drop.prevent.stop="onDropRow(p, sec)"
              @contextmenu.prevent="herd.siteMenu(p.id)"
            >
              <a :class="{ 'menu-active': selected === p.id }" @click="selected = p.id">
                <StatusDot :status="siteStatus(p)" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate font-medium">{{ p.name }}</span>
                    <svg v-if="favs.has(p.id) && sec.key !== 'fav'" class="size-3 shrink-0 text-warning" viewBox="0 0 20 20" fill="currentColor"><path :d="STAR" /></svg>
                  </div>
                  <div class="flex items-center gap-1.5 text-xs">
                    <span class="truncate opacity-60">{{ p.domain }}</span>
                    <span v-if="gitBadge(p)" class="git-chip shrink-0" :class="{ 'is-warn': p.git?.conflicts || p.git?.operation }" :title="gitTitle(p)">{{ gitBadge(p) }}</span>
                  </div>
                </div>
                <span class="shrink-0" :title="`Built with ${stackTag(p).label}`"><StackMark :icon="stackTag(p).icon" :label="stackTag(p).label" class="size-4" /></span>
              </a>
            </li>
            <!-- Its worktrees, indented under it (branch name, own domain). -->
            <li v-for="c in kidsShown(p, sec.group ?? null)" :key="sec.key + c.id" class="worktree-row" @contextmenu.prevent="herd.siteMenu(c.id)">
              <a :class="{ 'menu-active': selected === c.id }" :title="`Worktree of ${p.name}`" @click="selected = c.id">
                <svg class="size-3 shrink-0 opacity-40" viewBox="0 0 20 20" fill="currentColor"><path d="M5 3.75a.75.75 0 0 1 1.5 0V10a2.5 2.5 0 0 0 2.5 2.5h6.19l-1.72-1.72a.75.75 0 1 1 1.06-1.06l3 3a.75.75 0 0 1 0 1.06l-3 3a.75.75 0 1 1-1.06-1.06L15.19 14H9a4 4 0 0 1-4-4V3.75Z" /></svg>
                <StatusDot :status="siteStatus(c)" />
                <div class="min-w-0 flex-1">
                  <div class="flex items-center gap-1.5">
                    <span class="truncate font-mono text-xs font-medium">{{ c.git?.branch ?? c.name.replace(`${p.name} · `, '') }}</span>
                    <span v-if="gitBadge(c)" class="git-chip shrink-0" :class="{ 'is-warn': c.git?.conflicts || c.git?.operation }" :title="gitTitle(c)">{{ gitBadge(c) }}</span>
                  </div>
                  <div class="truncate text-xs opacity-60">{{ c.domain }}</div>
                </div>
              </a>
            </li>
            </template>
            <li v-if="sec.group && !sec.sites.length" class="px-3 py-1 text-xs opacity-50">Drop sites here</li>
          </template>
        </template>
        <li v-if="projects.length && query && !sections.some((s) => s.sites.length)" class="px-3 py-6 text-center text-xs opacity-60">
          No site matches “{{ query }}”.
        </li>
        <li v-else-if="projects.length && view.runningOnly && !sections.some((s) => s.sites.length)" class="px-3 py-6 text-center text-xs">
          <span class="opacity-60">No running sites.</span>
          <button class="btn btn-ghost btn-xs mx-auto mt-1" @click="listView.setRunningOnly(false)">Show all sites</button>
        </li>
        <li v-if="!projects.length" class="pointer-events-auto px-1 py-4">
          <div class="flex flex-col gap-2 text-xs">
            <span class="px-2 opacity-60">No sites yet.</span>
            <button class="btn btn-sm justify-start" @click="newSiteOpen = true"><svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.link" /></svg>Create New Site</button>
            <button class="btn btn-sm justify-start" @click="park"><svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.folder" /></svg>Park a folder</button>
          </div>
        </li>
      </ul>

    </aside>

    <!-- Main -->
    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <ProjectView v-if="current" :key="current.id" :project="current" :url-suffix="state?.urlSuffix ?? ''" />
      <div v-else class="drag flex flex-1 items-center justify-center opacity-60">Select a site</div>
    </main>
    </template>

    <RuntimesView v-else-if="section === 'runtimes'" v-model="runtime" />
    <DatabaseView v-else-if="section === 'database'" :focus="dbFocus" />
    <GitView v-else-if="section === 'git'" @open-site="openSite" />
    <MailView v-else-if="section === 'mail'" :focus="mailFocus" @open-site="openSite" />
    <WhatsAppView v-else-if="section === 'whatsapp'" :focus="waFocus" @open-site="openSite" />
    <ExposeView v-else-if="section === 'expose'" :focus="exposeFocus" @open-site="openSite" />
    <MonitoringView v-else-if="section === 'monitoring'" @open="openFromMonitor" />
    <section v-else-if="section === 'websocket'" class="flex min-w-0 flex-1 flex-col bg-base-100">
      <WebSocketView :focus="wsFocus" @open-site="openSite" />
    </section>
    <section v-else-if="section === 'search'" class="flex min-w-0 flex-1 flex-col bg-base-100">
      <SearchView :focus="searchFocus" @open-site="openSite" />
    </section>
    <section v-else-if="section === 'settings'" class="flex min-w-0 flex-1 flex-col bg-base-100">
      <!-- Room for back / forward above the header (the strip moves the window). -->
      <!-- Windows: PageHeader's win-top already leaves the room above. -->
      <div v-if="!isWin" class="drag title-strip h-10 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
      <SettingsView :closable="false" :focus="settingsFocus" />
    </section>
    <section v-else class="flex min-w-0 flex-1 flex-col bg-base-100">
      <StorageView :focus="storageFocus" />
    </section>

    <AskDevCatz v-if="askOpen" @close="askOpen = false" />
    <UpdateDialog />
    <ReportDialog />
    <UninstallDialog />
    <WelcomeDialog />
    <!-- Asked once, after the first crash or error (Catzoid #65). -->
    <dialog v-if="state?.reports.askCrash" open class="modal modal-open">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-3">
        <div class="flex items-start gap-3">
          <CatMood mood="question" class="size-12 shrink-0" />
          <div class="space-y-1">
            <h3 class="text-lg font-semibold tracking-tight">Send crash reports?</h3>
            <p class="text-sm opacity-70">
              DevCatz just hit an error. With crash reports on, reports like this go to the Catzoid site so it gets fixed — the version, {{ words.os }} and where
              it happened; never projects, .env values, keys, hosts or paths. You can change this in Settings → General.
            </p>
          </div>
        </div>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" @click="herd.crashAskDismiss()">Not now</button>
          <button type="button" class="btn btn-primary btn-sm" @click="herd.setCrashReports(true)">Send crash reports</button>
        </div>
      </div>
    </dialog>
    <NewSiteDialog v-if="newSiteOpen" @close="newSiteOpen = false" @created="onCreated" @park="parkFromDialog" />
    <ParkDialog v-if="parking" :dir="parking" @close="parking = null" />
    <dialog v-if="groupDialog" open class="modal modal-open" @keydown.esc="groupDialog = null">
      <form class="modal-box w-80 space-y-3" @submit.prevent="saveGroup">
        <h3 class="font-semibold">{{ groupDialog.mode === 'new' ? 'New group' : 'Rename group' }}</h3>
        <input v-model="groupDialog.name" class="input input-sm w-full" placeholder="e.g. Catz Shop" maxlength="40" autofocus />
        <div v-if="groupDialog.mode === 'new' && state.settings.siteGroups.length" class="flex flex-wrap gap-1">
          <button v-for="g in state.settings.siteGroups" :key="g.name" type="button" class="btn btn-xs" @click="groupDialog.name = g.name">{{ g.name }}</button>
        </div>
        <div class="modal-action mt-2">
          <button type="button" class="btn btn-sm btn-ghost" @click="groupDialog = null">Cancel</button>
          <button class="btn btn-sm btn-primary" :disabled="!groupDialog.name.trim()">{{ groupDialog.mode === 'new' ? 'Create & move' : 'Rename' }}</button>
        </div>
      </form>
      <div class="modal-backdrop" @click="groupDialog = null" />
    </dialog>

    <!-- Back / forward in the title bar, right of the rail and level with the traffic lights (like Finder);
         the left of every sidebar's top strip is free for it, Monitor and Settings leave room above.
         Last in the document on purpose: Electron builds the window's drag area in document order (drag adds,
         no-drag cuts out), so a no-drag hole made before the sidebars' drag strips would be filled again and
         clicks here would move the window instead. -->
    <div class="nav-history no-drag fixed top-3 left-[6.5rem] z-30 flex items-center gap-0.5">
      <PopMenu ref="backMenu" :items="backItems" :width="220">
        <button class="btn btn-ghost btn-xs btn-square" :disabled="!canBack" :title="`Back (${keyLabel('mod+[')}) · right-click for recent screens`" @click.stop="goBack" @contextmenu.prevent.stop="canBack && backMenu?.toggle()">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M12.8 4.2a.75.75 0 0 1 0 1.06L8.06 10l4.74 4.74a.75.75 0 1 1-1.06 1.06l-5.27-5.27a.75.75 0 0 1 0-1.06l5.27-5.27a.75.75 0 0 1 1.06 0Z" clip-rule="evenodd" /></svg>
        </button>
      </PopMenu>
      <PopMenu ref="forwardMenu" :items="forwardItems" :width="220">
        <button class="btn btn-ghost btn-xs btn-square" :disabled="!canForward" :title="`Forward (${keyLabel('mod+]')}) · right-click for recent screens`" @click.stop="goForward" @contextmenu.prevent.stop="canForward && forwardMenu?.toggle()">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.2 4.2a.75.75 0 0 1 1.06 0l5.27 5.27a.75.75 0 0 1 0 1.06L8.26 15.8a.75.75 0 1 1-1.06-1.06L11.94 10 7.2 5.26a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
        </button>
      </PopMenu>
    </div>
    <!-- Ask DevCatz: a floating button bottom-right, in reach from every screen. -->
    <button v-if="askOn && !askOpen" class="ask-fab no-drag" :title="`Ask DevCatz (${keyLabel('mod+K')}): say what to do in plain words`" aria-label="Ask DevCatz" @click="askOpen = true"><span><img :src="askMark" alt="" /></span></button>
    <div v-if="toast" class="toast toast-end z-50" :class="{ 'is-beside-fab': askOn && !askOpen }">
      <div
        role="status"
        class="alert max-w-md items-start gap-2.5 text-sm shadow-lg"
        :class="{ 'alert-error': toast.kind === 'error', 'alert-success': toast.kind === 'success', 'alert-info': toast.kind === 'info' }"
      >
        <CatMood :mood="toast.kind" class="-my-1 size-8 shrink-0" />
        <span class="selectable min-w-0 flex-1">{{ toast.text }}</span>
        <button type="button" class="btn btn-ghost btn-xs btn-square -my-0.5 opacity-60 hover:opacity-100" title="Dismiss" @click="dismissToast">✕</button>
      </div>
    </div>
  </div>
</template>
