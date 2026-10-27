<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { BuildTarget, DbAction, PackageManager, ProjectState } from '@shared/types';
import { attempt, herd, navRequest, notify, siteTabRequest, state } from '../store';
import { navVisit } from '../nav';
import AiExplain from './AiExplain.vue';
import { aiOn } from '../ai';
import { appCommand, frameworkTag, hasExtras, pythonInstallLabel, siteFrameworks, siteStatus, runsPerApp, runtimesOf, usesGo, usesJs, usesPhp, usesPython, portWhy } from '../runtimes';
import StackMark from './StackMark.vue';
import DataLibsCard from './DataLibsCard.vue';
import { mark } from '../datamarks';
import { STACK_ICONS } from '../stackicons';
import LogView from './LogView.vue';
import SitePreview from './SitePreview.vue';
import SitePorts from './SitePorts.vue';
import FreeSpaceCard from './FreeSpaceCard.vue';
import OpenApiCard from './OpenApiCard.vue';
import RuntimeNeeds from './RuntimeNeeds.vue';
import RedisCard from './RedisCard.vue';
import DbLinkCard from './DbLinkCard.vue';
import TasksCard from './TasksCard.vue';
import StatusDot from './StatusDot.vue';
import DockerTab from './DockerTab.vue';
import UnlinkDialog from './UnlinkDialog.vue';
import EnvTab from './EnvTab.vue';
import GormCard from './GormCard.vue';
import SiteWebSocketTab from './SiteWebSocketTab.vue';
import SiteSearchTab from './SiteSearchTab.vue';
import SiteStorageTab from './SiteStorageTab.vue';
import SiteGitTab from './SiteGitTab.vue';
import SiteMailTab from './SiteMailTab.vue';
import SiteGatewaysTab from './SiteGatewaysTab.vue';
import ExposeShareDialog from './ExposeShareDialog.vue';
import DepsCard from './DepsCard.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import SiteTabLabel from './SiteTabLabel.vue';
import { ICONS } from '../icons';
import CatMood from './CatMood.vue';
import { isWin, WIN_SITE_TABS } from '../platform';

/** What serves PHP sites: PHP-FPM on macOS, php-cgi workers (FastCGI) on Windows. */
const FPM = isWin ? 'PHP (FastCGI)' : 'PHP-FPM';

const props = defineProps<{ project: ProjectState; urlSuffix: string }>();

type Tab = 'overview' | 'api' | 'logs' | 'env' | 'git' | 'mail' | 'whatsapp' | 'database' | 'storage' | 'websocket' | 'search' | 'docker' | 'settings';
const tab = ref<Tab>('overview');
// Menu bar "Commit…" / other sections open a site on a given tab.
watch(
  siteTabRequest,
  (r) => {
    if (r && r.id === props.project.id) {
      tab.value = r.tab as Tab;
      siteTabRequest.value = null;
    }
  },
  { immediate: true },
);
// Back / forward history: every tab visited is a step.
watch(tab, (t) => navVisit({ section: 'projects', item: props.project.id, tab: t }), { immediate: true });

const p = computed(() => props.project);
const aiExplainOn = aiOn('explain');
const crashExplain = ref(false);
const worktreeParent = computed(() => (p.value.worktreeOf ? (state.value?.projects.find((x) => x.id === p.value.worktreeOf) ?? null) : null));
/** The WebSocket tab shows when the site uses real-time libraries (or runs Reverb / points at a DevCatz server). */
const hasWs = computed(() => p.value.realtime.libs.length > 0 || Boolean(p.value.reverb) || Boolean(p.value.wsServer));
/** The Search Engine tab shows when the site uses Scout or a search client (or points at a DevCatz engine). */
const hasSearch = computed(() => p.value.search.libs.length > 0 || Boolean(p.value.searchEngine));
/** The Storage tab shows when the site uses an S3 library (or points at a DevCatz storage service). */
const hasS3 = computed(() => p.value.s3.libs.length > 0 || Boolean(p.value.storageService));
watch(hasS3, (on) => !on && tab.value === 'storage' && (tab.value = 'overview'));
/** Dot on the Storage tab: green once the .env points at a running DevCatz service. */
const s3Status = computed(() => {
  const s = state.value?.storage.find((x) => x.kind === (p.value.s3.service ?? p.value.storageService));
  return s?.installed && p.value.s3.service ? s.status : 'stopped';
});
const allTabs = computed<Tab[]>(() => [
  'overview',
  'env',
  'database',
  ...(hasS3.value ? (['storage'] as Tab[]) : []),
  'api',
  ...(hasWs.value ? (['websocket'] as Tab[]) : []),
  ...(hasSearch.value ? (['search'] as Tab[]) : []),
  'git',
  ...(p.value.mailInfo ? (['mail'] as Tab[]) : []),
  ...(p.value.waInfo || p.value.gwInfo ? (['whatsapp'] as Tab[]) : []),
  'docker',
  'logs',
  'settings',
]);
// Windows, stage 1: the tabs of macOS-only services stay hidden (Catzoid #57).
const tabs = computed<Tab[]>(() => (isWin ? allTabs.value.filter((t) => WIN_SITE_TABS.has(t)) : allTabs.value));
watch(hasWs, (on) => !on && tab.value === 'websocket' && (tab.value = 'overview'));
watch(hasSearch, (on) => !on && tab.value === 'search' && (tab.value = 'overview'));
/** Dot on the Search Engine tab: the engine the site uses. */
const searchStatus = computed(() => {
  const e = state.value?.searchEngines.find((s) => s.kind === (p.value.searchEngine ?? p.value.search.suggested));
  return e?.installed ? e.status : 'stopped';
});
/** Dot on the tab: the site's own server runs with the site; client libraries need their DevCatz server. */
/**
 * The tab strip fits its width: tabs that do not fit move into a "More ▾"
 * menu (the active one always stays visible). Widths come from a hidden copy
 * of every tab, measured again when the strip resizes or the tabs change.
 */
const strip = ref<HTMLElement | null>(null);
const measureRow = ref<HTMLElement | null>(null);
const stripWidth = ref(0);
const tabWidths = ref<Record<string, number>>({});
const MORE_WIDTH = 86;
function measure() {
  const row = measureRow.value;
  if (!row) return;
  const w: Record<string, number> = {};
  for (const el of Array.from(row.children) as HTMLElement[]) w[el.dataset.tab ?? ''] = el.offsetWidth;
  tabWidths.value = w;
  stripWidth.value = strip.value?.clientWidth ?? 0;
}
let ro: ResizeObserver | null = null;
// ⌘S on the Settings tab saves the form (other tabs keep their own ⌘S: .env, Docker files); not while a dialog is open.
function onSaveKey(e: KeyboardEvent) {
  if (!(e.metaKey || e.ctrlKey) || e.key.toLowerCase() !== 's' || e.shiftKey || e.altKey) return;
  if (tab.value !== 'settings' || document.querySelector('dialog[open]')) return;
  e.preventDefault();
  if (domainTaken.value) return;
  void save();
}
onMounted(() => window.addEventListener('keydown', onSaveKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onSaveKey));

onMounted(() => {
  ro = new ResizeObserver(() => measure());
  if (strip.value) ro.observe(strip.value);
  if (measureRow.value) ro.observe(measureRow.value);
  void nextTick(measure);
});
onBeforeUnmount(() => ro?.disconnect());
watch(tabs, () => void nextTick(measure));
const tabLayout = computed(() => {
  const all = tabs.value;
  const avail = stripWidth.value - 6; // the strip's own padding
  if (!avail || !Object.keys(tabWidths.value).length) return { visible: all, hidden: [] as Tab[] };
  const gap = 2;
  const width = (t: Tab) => (tabWidths.value[t] ?? 80) + gap;
  if (all.reduce((n, t) => n + width(t), 0) <= avail) return { visible: all, hidden: [] as Tab[] };
  let used = MORE_WIDTH + gap;
  let n = 0;
  while (n < all.length && used + width(all[n]) <= avail) {
    used += width(all[n]);
    n++;
  }
  const visible = all.slice(0, Math.max(1, n));
  // The active tab is never hidden: it takes the last visible slot.
  if (!visible.includes(tab.value)) visible[visible.length - 1] = tab.value;
  return { visible, hidden: all.filter((t) => !visible.includes(t)) };
});
const TAB_NAMES: Record<string, string> = { api: 'API', websocket: 'WebSocket', search: 'Search Engine', whatsapp: 'Gateways' };
const moreTabs = computed<MenuItem[]>(() => tabLayout.value.hidden.map((t) => ({ label: TAB_NAMES[t] ?? t.charAt(0).toUpperCase() + t.slice(1), checked: tab.value === t, action: () => (tab.value = t) })));

const wsStatus = computed(() => {
  const rt = p.value.realtime;
  if (rt.libs.some((l) => l.role === 'server') || p.value.reverb) return siteStatus(p.value);
  const server = state.value?.websockets.find((s) => s.kind === (p.value.wsServer ?? rt.suggested));
  return server?.installed ? server.status : 'stopped';
});
const active = computed(() => p.value.status === 'running' || p.value.status === 'starting');
const command = computed(() => p.value.devCommand || p.value.stack.devCommand);
/** Overview → Apps: restart one app of a site that runs one process per app (monorepo / folder project). */
const perAppRunning = computed(() => !!p.value && runsPerApp(p.value) && (p.value.status === 'running' || p.value.status === 'starting') && p.value.stack.apps.length > 1);
const restartingApp = ref<string | null>(null);
async function restartApp(dir: string, name: string) {
  restartingApp.value = dir;
  await attempt(() => herd.restartApp(p.value!.id, dir).then(() => true), `${name} restarted`);
  restartingApp.value = null;
}

/** The site's URL in its scheme (http sites use the HTTP port, or none with clean URLs). */
const url = (domain: string) =>
  p.value.secure === false ? `http://${domain}${state.value?.httpUrlSuffix ?? ''}` : `https://${domain}${props.urlSuffix}`;

const PMS: PackageManager[] = ['bun', 'npm', 'pnpm', 'yarn'];

const STATUS_BADGE: Record<string, string> = {
  running: 'badge-success',
  starting: 'badge-warning',
  stopping: 'badge-warning',
  crashed: 'badge-error',
  stopped: 'badge-ghost',
};

/** The site's frameworks, the one the site list shows first. */
const frameworks = computed(() => siteFrameworks(p.value));

// Jump to the logs when a start is requested from here.
async function start() {
  tab.value = 'logs';
  await attempt(() => herd.start(p.value.id));
}

// ---- Build (header): the project's build (npm run build, go build …), per app in a monorepo; output in Logs.
const buildTargets = ref<BuildTarget[]>([]);
watch(
  () => `${p.value.id}|${p.value.stack.apps.map((a) => a.dir + a.framework).join(',')}|${p.value.stack.libs.length}`,
  async () => (buildTargets.value = (await herd.buildTargets(p.value.id).catch(() => [])) ?? []),
  { immediate: true },
);
const building = computed(() => p.value.dbTask?.startsWith('building ') ?? false);
async function build(t: BuildTarget) {
  tab.value = 'logs';
  if (await attempt(() => herd.buildSite(p.value.id, t.id).then(() => true))) notify('success', `${t.id === 'all' ? p.value.name : t.label}: build finished`);
}
const buildItems = computed<MenuItem[]>(() =>
  buildTargets.value.map((t) => {
    // "Build all" without a root build script runs every target in turn: name them instead of the long command.
    const each = t.id === 'all' && t.command.startsWith('(cd ') ? `${buildTargets.value.filter((x) => x.id !== 'all').map((x) => x.cwd).join(', ')} in turn` : null;
    return { label: t.label, hint: each ?? (t.cwd === '.' ? t.command : `${t.cwd} · ${t.command}`), action: () => void build(t) };
  }),
);

/** Worktrees of this site (sites of their own, each on its own ports). */
const worktrees = computed(() => (state.value?.projects ?? []).filter((x) => x.worktreeOf === p.value.id));
/** Start ▾ → Start all: this site and every worktree of it that is not running yet. */
async function startAll() {
  tab.value = 'logs';
  const list = [p.value, ...worktrees.value].filter((x) => x.status !== 'running' && x.status !== 'starting');
  let ok = 0;
  for (const x of list) if (await attempt(() => herd.start(x.id).then(() => true))) ok++;
  if (ok) notify('success', `${ok} of ${list.length} started: ${p.value.name}${worktrees.value.length ? ` and ${worktrees.value.length} worktree${worktrees.value.length === 1 ? '' : 's'}` : ''}`);
}
const startItems = computed<MenuItem[]>(() => [
  { label: 'Start', hint: p.value.name, action: () => void start() },
  { label: `Start all`, hint: `${p.value.name} + ${worktrees.value.length} worktree${worktrees.value.length === 1 ? '' : 's'}`, action: () => void startAll() },
]);

const openItems = computed<MenuItem[]>(() => [
  ...p.value.stack.apps.map((app) => ({ label: app.domain, hint: 'Open in browser', icon: ICONS.globe, action: () => void herd.openUrl(url(app.domain)) })),
  { label: 'Editor', icon: ICONS.code, action: () => void herd.openEditor(p.value.id) },
  { label: words.fileManager, icon: ICONS.folder, action: () => void herd.openFolder(p.value.id) },
  { label: 'Terminal', icon: ICONS.terminal, action: () => void herd.openTerminal(p.value.id) },
]);

async function installDeps() {
  tab.value = 'logs';
  await attempt(() => herd.installDeps(p.value.id), 'Dependencies installed');
}

const runtimes = computed(() => runtimesOf(p.value));
const perApp = computed(() => runsPerApp(p.value));
const RUNTIME_ICON = { node: ICONS.hexagon, bun: ICONS.bun, go: ICONS.go, php: ICONS.php, python: STACK_ICONS.python.d };

const stop = () => attempt(() => herd.stop(p.value.id));
const restart = () => attempt(() => herd.restart(p.value.id));
const rescan = () => attempt(() => herd.rescan(), 'Rescanned');

// ---- database
const migrationName = ref('');
const dbBusy = computed(() => p.value.dbTask !== null);
async function db(action: DbAction, arg?: string) {
  if ((action === 'reset' || action === 'artisan-fresh') && !confirm(`Reset the ${p.value.name} database? All tables are dropped, migrations re-applied and the seeders run.`)) return;
  tab.value = ['start', 'stop', 'redis-start', 'redis-stop'].includes(action) ? tab.value : 'logs';
  const ok = await attempt(() => herd.db(p.value.id, action, arg), undefined);
  if (ok !== undefined && action === 'migrate') migrationName.value = '';
}

// ---- settings
const form = ref({
  name: '',
  domain: '',
  devCommand: '',
  autoStart: false,
  nodeVersion: '',
  managedPorts: true,
  packageManager: '' as '' | PackageManager,
  goVersion: '',
  secure: true,
  phpVersion: '',
  pythonVersion: '',
  queueWorker: false,
  scheduler: false,
});
/** The form holds the label only (my-project); the suffix follows Settings → General → Default domain. */
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const stripTld = (domain: string) => domain.replace(new RegExp(`\\.${tld.value.replace(/\./g, '\\.')}$`), '');
/** A worktree lives on a subdomain of its parent site (feature.shop.localhost): its Settings edit that part only. */
const parentDomain = computed(() => (p.value.worktreeOf ? (state.value?.projects.find((x) => x.id === p.value.worktreeOf)?.domain ?? null) : null));
const domainPart = (domain: string) => (parentDomain.value && domain.endsWith(`.${parentDomain.value}`) ? domain.slice(0, -parentDomain.value.length - 1) : stripTld(domain));
// The domain being typed: who already uses it (another site, an app, a DevCatz service such as gowa.localhost).
const domainTaken = ref<string | null>(null);
let domainTimer: ReturnType<typeof setTimeout> | undefined;
const typedDomain = computed(() => (form.value?.domain ? (parentDomain.value ? `${slug(form.value.domain)}.${parentDomain.value}` : `${slug(form.value.domain)}.${tld.value}`) : ''));
watch(typedDomain, (d) => {
  clearTimeout(domainTimer);
  domainTaken.value = null;
  if (!d || d === p.value.domain) return;
  domainTimer = setTimeout(async () => {
    const owner = await herd.domainOwner(d, p.value.id).catch(() => null);
    if (typedDomain.value === d) domainTaken.value = owner ? `${d} is already used by ${owner}` : null;
  }, 250);
});

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '');
const domainPreview = computed(() => `${slug(form.value.domain) || '…'}.${tld.value}`);

watch(
  p,
  (v) => {
    form.value = { name: v.name, domain: domainPart(v.domain), devCommand: v.devCommand ?? '', autoStart: Boolean(v.autoStart), nodeVersion: v.nodeVersion ?? '', managedPorts: v.managedPorts !== false, packageManager: v.packageManager ?? '', goVersion: v.goVersion ?? '', secure: v.secure !== false, phpVersion: v.phpVersion ?? '', pythonVersion: v.pythonVersion ?? '', queueWorker: Boolean(v.queueWorker), scheduler: Boolean(v.scheduler) };
  },
  { immediate: true },
);

async function save() {
  await attempt(
    () =>
      herd.updateProject(p.value.id, {
        ...form.value,
        domain: parentDomain.value ? `${slug(form.value.domain)}.${parentDomain.value}` : `${slug(form.value.domain)}.${tld.value}`,
        packageManager: form.value.packageManager || undefined,
        goVersion: form.value.goVersion,
        phpVersion: form.value.phpVersion,
        pythonVersion: form.value.pythonVersion,
      }),
    'Saved',
  );
}
const unlinking = ref(false);
// ---- Expose: the share of this site, if any
const share = computed(() => state.value?.expose.shares.find((s) => s.siteId === p.value.id && s.status !== 'stopped') ?? null);
const sharing = ref(false);
async function copyShare() {
  if (!share.value?.url) return;
  await navigator.clipboard.writeText(share.value.url).catch(() => undefined);
  notify('info', 'Public URL copied');
}

const isFav = computed(() => state.value?.settings.favorites.includes(props.project.id) ?? false);
const group = computed(() => state.value?.settings.siteGroups.find((g) => g.sites.includes(props.project.id))?.name ?? null);
</script>

<template>
  <!-- Header -->
  <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-3">
    <!-- A narrow window puts the buttons on a line of their own instead of over the title. -->
    <div class="flex flex-wrap items-start gap-x-3 gap-y-2">
      <div class="min-w-[14rem] flex-1 basis-[18rem]">
        <div class="flex min-w-0 items-center gap-2">
          <StatusDot :status="siteStatus(p)" class="shrink-0" />
          <h1 class="min-w-0 truncate text-xl font-semibold tracking-tight" :title="p.name">{{ p.name }}</h1>
          <button
            class="no-drag btn btn-ghost btn-xs btn-square"
            :class="isFav ? 'text-warning' : 'opacity-40 hover:opacity-100'"
            :title="isFav ? 'Remove from Favorites' : 'Add to Favorites'"
            @click="herd.setFavorite(p.id, !isFav)"
          >
            <svg class="size-4" viewBox="0 0 20 20" :fill="isFav ? 'currentColor' : 'none'" stroke="currentColor" stroke-width="1.5"><path d="M9.05 2.93c.3-.92 1.6-.92 1.9 0l1.26 3.88a1 1 0 0 0 .95.69h4.08c.97 0 1.37 1.24.59 1.81l-3.3 2.4a1 1 0 0 0-.37 1.11l1.27 3.89c.3.92-.76 1.68-1.54 1.11l-3.3-2.4a1 1 0 0 0-1.18 0l-3.3 2.4c-.78.57-1.83-.19-1.54-1.11l1.27-3.89a1 1 0 0 0-.37-1.11l-3.3-2.4c-.78-.57-.38-1.81.59-1.81h4.08a1 1 0 0 0 .95-.69l1.26-3.88Z" /></svg>
          </button>
          <span v-if="group" class="badge badge-outline badge-sm max-w-[10rem] shrink-0 truncate" title="Sidebar group (right-click the site to change)">{{ group }}</span>
          <span class="badge badge-sm badge-soft shrink-0" :class="STATUS_BADGE[siteStatus(p)] ?? 'badge-ghost'" :title="p.served ? `Served by ${FPM} (always on)` : undefined">{{ siteStatus(p) }}</span>
          <span v-if="p.parkedFrom" class="badge badge-outline badge-sm" :title="p.parkedFrom">parked</span>
          <button
            v-if="p.worktreeOf"
            class="no-drag badge badge-primary badge-soft badge-sm gap-1 font-mono"
            :title="`Git worktree of ${worktreeParent?.name ?? 'another site'}: open its Worktrees view`"
            @click="tab = 'git'"
          >worktree · {{ p.git?.branch ?? 'detached' }}</button>
        </div>
        <a class="url-chip no-drag mt-1.5" :title="`Open ${url(p.domain)}`" @click="herd.openUrl(url(p.domain))">
          <svg class="size-3.5 opacity-70" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.globe" /></svg>
          <span class="truncate">{{ url(p.domain) }}</span>
          <svg class="size-3 opacity-60" viewBox="0 0 20 20" fill="currentColor"><path d="M4.25 5.5a.75.75 0 0 0-.75.75v8.5c0 .414.336.75.75.75h8.5a.75.75 0 0 0 .75-.75v-4a.75.75 0 0 1 1.5 0v4A2.25 2.25 0 0 1 12.75 17h-8.5A2.25 2.25 0 0 1 2 14.75v-8.5A2.25 2.25 0 0 1 4.25 4h5a.75.75 0 0 1 0 1.5h-5Z" /><path d="M6.194 12.753a.75.75 0 0 0 1.06.053L16.5 4.44v2.81a.75.75 0 0 0 1.5 0v-4.5a.75.75 0 0 0-.75-.75h-4.5a.75.75 0 0 0 0 1.5h2.553l-9.056 8.194a.75.75 0 0 0-.053 1.06Z" /></svg>
        </a>
      </div>
      <div class="ml-auto flex max-w-full flex-wrap justify-end gap-1.5">
        <span v-if="!hasExtras(p)" class="badge badge-success badge-soft self-center" :title="`PHP sites are served by ${FPM} all the time; nothing to start (enable the queue worker or scheduler in Settings)`">Always on</span>
        <template v-else>
        <div v-if="!active && worktrees.length" class="join">
          <button class="btn btn-primary btn-sm join-item" :disabled="(!command && p.stack.runtime !== 'php') || p.status === 'stopping'" @click="start">Start</button>
          <PopMenu :items="startItems" align="end" :width="240">
            <button class="btn btn-primary btn-sm join-item border-l border-l-white/25 px-2" :disabled="(!command && p.stack.runtime !== 'php') || p.status === 'stopping'" title="Start or Start all (with the worktrees)" aria-label="More start options">▾</button>
          </PopMenu>
        </div>
        <button v-else-if="!active" class="btn btn-primary btn-sm" :disabled="(!command && p.stack.runtime !== 'php') || p.status === 'stopping'" @click="start">
          Start
        </button>
        <button v-else class="btn btn-sm" @click="stop">Stop</button>
        <button class="btn btn-sm" :disabled="!active" @click="restart">Restart</button>
        </template>
        <template v-if="buildTargets.length">
          <PopMenu v-if="buildTargets.length > 1" :items="buildItems" align="end" :width="300">
            <button class="btn btn-sm" :disabled="!!p.dbTask" title="Build the project, or one of its apps">
              <span v-if="building" class="loading loading-spinner loading-xs" />Build ▾
            </button>
          </PopMenu>
          <button v-else class="btn btn-sm" :disabled="!!p.dbTask" :title="`${buildTargets[0].command}${buildTargets[0].cwd === '.' ? '' : ` (in ${buildTargets[0].cwd})`}`" @click="build(buildTargets[0])">
            <span v-if="building" class="loading loading-spinner loading-xs" />Build
          </button>
        </template>
        <PopMenu :items="openItems" align="end" :width="260">
          <button class="btn btn-sm">Open ▾</button>
        </PopMenu>
        <button v-if="!share" class="btn btn-sm" title="Share this site on a public URL (Cloudflare quick tunnel)" @click="sharing = true">Share</button>
        <button v-else class="btn btn-sm btn-success btn-soft" :title="share.url ?? share.status" @click="navRequest = { section: 'expose', id: p.id }">
          <span class="status status-success status-xs" />Shared
        </button>
      </div>
    </div>
    <a v-if="share?.url" class="url-chip no-drag mt-1.5" :title="`Copy ${share.url}`" @click="copyShare">
      <svg class="size-3.5 opacity-70" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.expose" /></svg>
      <span class="truncate">{{ share.url }}</span>
      <span class="font-sans text-[10px] opacity-60">public · click to copy</span>
    </a>
    <div ref="strip" class="no-drag relative mt-3 min-w-0">
      <div role="tablist" class="seg max-w-full">
        <a v-for="t in tabLayout.visible" :key="t" role="tab" class="seg-item normal-case" :class="{ 'is-active': tab === t }" @click="tab = t">
          <SiteTabLabel :t="t" :project="p" :ws-status="wsStatus" :search-status="searchStatus" :s3-status="s3Status" />
        </a>
        <PopMenu v-if="tabLayout.hidden.length" :items="moreTabs" align="end" :width="200">
          <a role="tab" class="seg-item normal-case" :class="{ 'is-active': tabLayout.hidden.includes(tab) }" :title="`${tabLayout.hidden.length} more tabs`">
            More <span class="badge badge-ghost badge-xs">{{ tabLayout.hidden.length }}</span>
          </a>
        </PopMenu>
      </div>
      <!-- Measuring copy: every tab at its natural width, never shown. -->
      <div ref="measureRow" class="seg pointer-events-none invisible absolute top-0 left-0 whitespace-nowrap" aria-hidden="true">
        <a v-for="t in tabs" :key="t" :data-tab="t" class="seg-item normal-case">
          <SiteTabLabel :t="t" :project="p" :ws-status="wsStatus" :search-status="searchStatus" :s3-status="s3Status" />
        </a>
      </div>
    </div>
  </header>

  <!-- Overview -->
  <section v-if="tab === 'overview'" class="site-tab">
    <!-- Crashed: say so, and offer the AI's explanation of the last lines. -->
    <div v-if="p.status === 'crashed'" class="alert alert-error items-start"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
      <div class="min-w-0 flex-1">
        <div class="font-medium">The dev server stopped with an error{{ p.exitCode !== null ? ` (exit ${p.exitCode})` : '' }}</div>
        <div class="text-xs opacity-80">The last lines are in Logs.</div>
      </div>
      <button class="btn btn-sm" @click="tab = 'logs'">Logs</button>
      <button v-if="aiExplainOn && !crashExplain" class="btn btn-sm" @click="crashExplain = true">✦ Explain with AI</button>
    </div>
    <AiExplain v-if="crashExplain && p.status === 'crashed'" :site-id="p.id" source="crash" @close="crashExplain = false" />
    <!-- A runtime the site needs and this Mac does not have yet: one-click install. -->
    <RuntimeNeeds :key="`rt-${p.id}`" :site="p" />
    <div v-if="p.stack.depsMissing" role="alert" class="alert alert-warning"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
      <div class="flex-1">
        <div class="font-medium">Dependencies are not installed</div>
        <div class="text-xs opacity-80">
          <template v-if="p.stack.runtime === 'php'"><code>vendor/</code> is missing, so PHP cannot boot the app yet.</template>
          <template v-else-if="p.stack.runtime === 'python'">There is no virtualenv (<code>.venv</code>) yet; DevCatz creates it with Python {{ p.python.version ?? p.python.spec ?? '3.13' }} and installs the packages.</template>
          <template v-else><code>node_modules</code> is empty, so the dev command cannot run yet.</template>
        </div>
      </div>
      <button class="btn btn-sm" :disabled="!!p.dbTask" @click="installDeps">
        <span v-if="p.dbTask" class="loading loading-spinner loading-xs" />
        {{
          p.dbTask
            ? `${p.dbTask}…`
            : p.stack.runtime === 'php'
              ? 'Install dependencies (composer install)'
              : p.stack.runtime === 'python'
                ? `Install dependencies (${pythonInstallLabel(p.stack)})`
                : `Install dependencies (${p.stack.packageManager} install)`
        }}
      </button>
    </div>
    <div v-if="p.stack.runtime === 'php' && !p.stack.depsMissing && p.stack.jsDepsMissing" role="alert" class="alert text-sm">
      <div class="flex-1"><code>node_modules</code> is missing, so Vite (HMR) cannot start; pages use the built assets in public/build.</div>
      <button class="btn btn-xs" :disabled="!!p.dbTask" @click="installDeps">{{ p.stack.packageManager }} install</button>
    </div>
    <div v-for="w in p.stack.warnings" :key="w" role="alert" class="alert alert-warning text-sm">
      <CatMood mood="warning" class="size-7 shrink-0 -my-0.5" /><span class="flex-1">{{ w }}</span>
      <!-- "No .env yet": the Env tab creates it from the example (and a Laravel APP_KEY with it). -->
      <button v-if="/\.env\b/.test(w)" class="btn btn-sm" @click="tab = 'env'">Open Env</button>
    </div>
    <div v-if="p.envHints.length || Object.keys(p.envOverrides).length" role="alert" class="alert text-sm">
      <div class="min-w-0 flex-1">
        <template v-if="Object.keys(p.envOverrides).length">
          <div class="font-medium">Old dev domain mapped to {{ p.domain }}</div>
          <ul class="mt-1 font-mono text-xs">
            <li v-for="(v, k) in p.envOverrides" :key="k" class="truncate">{{ k }}=<span class="text-primary">{{ v }}</span></li>
          </ul>
          <div class="mt-1 text-xs opacity-70">
            DevCatz passes these instead of the .env values to {{ FPM }}, Vite, the queue worker and artisan, so subdomain routes work
            (<code>*.{{ p.domain }}</code> reaches this site). Your .env file itself is left unchanged.
          </div>
        </template>
        <template v-else>
          <div class="font-medium">.env still points at other dev domains</div>
          <ul class="mt-1 font-mono text-xs">
            <li v-for="h in p.envHints" :key="h.key">{{ h.key }}={{ h.value }}</li>
          </ul>
          <div class="mt-1 text-xs opacity-70">This site is served on {{ p.stack.apps.map((a) => a.domain).filter(Boolean).join(', ') }}.</div>
        </template>
      </div>
      <button
        v-if="p.stack.runtime === 'php'"
        class="btn btn-xs"
        :title="p.envDomainOverride === false ? 'Map the old dev domain to this site again' : 'Use the .env values as they are'"
        @click="herd.updateProject(p.id, { envDomainOverride: p.envDomainOverride === false })"
      >
        {{ p.envDomainOverride === false ? 'Map to ' + p.domain : 'Turn off' }}
      </button>
    </div>
    <!-- The shot keeps its 16:10; beside it (lg) the Framework card takes the shot's height and scrolls inside when it has more. -->
    <div class="grid gap-6 lg:grid-cols-[minmax(0,24rem)_1fr]">
      <SitePreview :project="p" :url="url(p.domain)" />
      <div class="card min-w-0 lg:relative">
        <div class="card-body gap-5 lg:absolute lg:inset-0 lg:overflow-y-auto">
          <!-- Framework: the same mark and name as the site list, then any other framework its apps use -->
          <div>
            <div class="label-caps mb-2.5">{{ frameworks.length > 1 ? 'Frameworks' : 'Framework' }}</div>
            <ul class="flex flex-wrap gap-2">
              <li v-for="f in frameworks" :key="f.label" class="flex items-center gap-2.5 rounded-xl border border-base-300/60 bg-base-200/40 py-1.5 pr-3.5 pl-1.5">
                <span class="grid size-8 shrink-0 place-items-center rounded-lg bg-base-100 ring-1 ring-base-content/10">
                  <StackMark :icon="f.icon" :label="f.label" class="size-5" />
                </span>
                <span class="min-w-0">
                  <span class="block text-sm font-medium leading-tight">{{ f.label }}</span>
                  <span class="block text-[11px] leading-tight opacity-55">{{ f.main ? 'main framework' : f.apps.join(', ') }}</span>
                </span>
              </li>
            </ul>
          </div>

          <div v-if="p.stack.packageManager || p.stack.monorepo || p.stack.prismaDir !== null || p.stack.database || p.stack.redis">
            <div class="label-caps mb-2.5">Stack</div>
            <div class="flex flex-wrap gap-1.5">
              <span v-if="p.stack.packageManager" class="badge badge-ghost badge-sm">{{ p.stack.packageManager }}</span>
              <span v-if="p.stack.monorepo" class="badge badge-ghost badge-sm">monorepo</span>
              <span v-if="p.stack.prismaDir !== null" class="badge badge-ghost badge-sm">Prisma</span>
              <span v-if="p.stack.database" class="badge badge-ghost badge-sm">{{ p.stack.database.engine }}</span>
              <span v-if="p.stack.redis" class="badge badge-ghost badge-sm">redis</span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- Runtimes and how the site starts, side by side under the shot -->
    <div class="grid gap-6 md:grid-cols-2">
      <div class="card min-w-0">
        <div class="card-body p-4">
          <!-- Runtimes actually used by this site (Node/Bun for JS apps, Go for Go apps; PHP later) -->
          <div class="label-caps mb-2.5">Runtimes</div>
          <ul class="space-y-2.5">
            <li v-for="r in runtimes" :key="r.kind" class="flex items-start gap-2.5">
              <svg class="mt-0.5 size-4 shrink-0 opacity-70" :viewBox="r.kind === 'python' ? '0 0 24 24' : '0 0 20 20'" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="RUNTIME_ICON[r.kind]" /></svg>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="font-medium">{{ r.label }}</span>
                  <span class="badge badge-sm font-mono" :class="r.missing || !r.version ? 'badge-warning' : 'badge-ghost'">{{ r.version ?? 'not installed' }}</span>
                  <span v-if="r.apps.length" class="ml-auto text-xs opacity-50">{{ r.apps.join(', ') }}</span>
                </div>
                <div class="text-xs opacity-60">{{ r.why }}</div>
              </div>
            </li>
            <li v-if="!runtimes.length" class="text-xs opacity-60">No runtime detected.</li>
          </ul>
      </div>
    </div>
    <div class="card min-w-0">
      <div class="card-body p-4">
          <div class="label-caps mb-2.5">{{ p.stack.runtime === 'php' ? 'Served by' : perApp ? 'Started as' : 'Dev command' }}</div>
          <div v-if="p.stack.runtime === 'php'" class="text-sm leading-relaxed opacity-80">
            {{ FPM }} {{ p.php.version ?? '(PHP not installed)' }}, always on.
            <template v-if="p.stack.apps.some((a) => a.framework === 'mix')"> Start runs Laravel Mix (<code>mix watch</code>, rebuilds public/ on change)</template>
            <template v-else-if="p.stack.apps.some((a) => a.kind === 'assets')"> Start runs Vite (HMR) on the same domain</template>
            <template v-if="p.queueWorker || p.scheduler">{{ p.stack.apps.some((a) => a.kind === 'assets') ? ',' : ' Start runs' }} {{ [p.queueWorker && 'the queue worker', p.scheduler && 'the scheduler'].filter(Boolean).join(' and ') }}</template><template v-if="p.stack.apps.some((a) => a.framework === 'mix' || a.kind === 'assets') || p.queueWorker || p.scheduler">.</template>
          </div>
          <code v-else-if="!perApp" class="selectable inline-block rounded-md bg-base-200/70 px-2 py-1 text-xs">{{ command ?? 'not detected (set one in Settings)' }}</code>
          <div v-else class="text-sm opacity-70">one process per app (see Apps below), each on its own port</div>
          <div class="mt-2 font-mono text-[11px] break-all opacity-50">{{ p.path }}</div>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body card-table">
      <div class="card-head">
        <h2>Apps</h2>
        <span class="ml-auto text-xs opacity-60">{{ p.stack.apps.length }} app{{ p.stack.apps.length === 1 ? '' : 's' }}</span>
      </div>
      <div class="overflow-x-auto">
        <table class="table table-sm">
          <thead>
            <tr><th></th><th>App</th><th>Stack</th><th>Command</th><th>Port</th><th>URL</th></tr>
          </thead>
          <tbody>
            <tr v-for="app in p.stack.apps" :key="app.dir">
              <td>
                <StatusDot
                  :status="
                    app.docroot !== undefined
                      ? p.served ? 'running' : 'stopped'
                      : app.framework === 'mix'
                        ? p.status
                        : app.port && p.openPorts.includes(app.port) ? 'running' : 'stopped'
                  "
                />
                <button
                  v-if="perAppRunning"
                  class="btn btn-ghost btn-xs btn-square ml-1 align-middle"
                  :disabled="restartingApp === app.dir"
                  :title="`${app.port && p.openPorts.includes(app.port) ? 'Restart' : 'Start'} ${app.name} only; the other apps keep running`"
                  :aria-label="`Restart ${app.name}`"
                  @click="restartApp(app.dir, app.name)"
                >
                  <span v-if="restartingApp === app.dir" class="loading loading-spinner loading-xs" />
                  <svg v-else viewBox="0 0 20 20" fill="currentColor" class="size-3.5"><path d="M15.3 7.5A6 6 0 1 0 16 11h-1.6a4.4 4.4 0 1 1-.9-3.5L11.5 9.5H17V4l-1.7 3.5Z" /></svg>
                </button>
              </td>
              <td>
                <div class="font-medium">{{ app.name }}</div>
                <div class="text-xs opacity-50">{{ app.dir }}</div>
              </td>
              <td>
                <span class="inline-flex items-center gap-1.5">
                  <StackMark :icon="frameworkTag(app.framework, app.library).icon" class="size-3.5 shrink-0" />
                  {{ app.framework === 'mix' ? 'Laravel Mix' : app.kind === 'assets' && app.framework.startsWith('vite') ? 'Vite' : frameworkTag(app.framework, app.library).label }}
                </span>
                <span class="opacity-50">({{ app.kind }})</span>
              </td>
              <td><code class="text-xs whitespace-nowrap">{{ appCommand(p, app) }}</code></td>
              <td v-if="app.docroot !== undefined" class="text-xs opacity-60">— <span class="opacity-70">(FastCGI)</span></td>
              <td v-else-if="app.framework === 'mix'" class="text-xs opacity-60">— <span class="opacity-70">(builds into public/)</span></td>
              <td v-else class="whitespace-nowrap">
                <code>{{ app.port ?? '?' }}</code>
                <span
                  v-if="app.managedPort"
                  class="badge badge-ghost badge-xs ml-1"
                  :title="`Assigned by DevCatz via ${app.portVars.length ? app.portVars.join(', ') : '--port on the command line'}; the project's own setting is ${app.configuredPort ?? 'unknown'}`"
                >
                  managed{{ app.configuredPort && app.configuredPort !== app.port ? ` · .env ${app.configuredPort}` : '' }}
                </span>
                <span v-else-if="portWhy(p, app)" class="badge badge-ghost badge-xs ml-1 opacity-70" :title="portWhy(p, app)!.detail">{{ portWhy(p, app)!.title }}</span>
              </td>
              <td>
                <a v-if="app.domain" class="link link-primary" @click="herd.openUrl(url(app.domain))">{{ app.domain }}</a>
                <span v-else class="text-xs opacity-60">via {{ p.domain }}</span>
              </td>
            </tr>
            <tr v-if="!p.stack.apps.length">
              <td colspan="6" class="py-5 text-center text-xs opacity-60">No app with a <code>dev</code> script found.</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p class="card-foot text-xs opacity-60">
        The proxy rewrites the Host header to <code>localhost:&lt;port&gt;</code>, so Vite/Nuxt need no <code>allowedHosts</code> change.
        HMR WebSockets are proxied too.
      </p>
      </div>
    </div>

    <DepsCard :key="p.id" :project="p" @logs="tab = 'logs'" />
  </section>

  <!-- API: its OpenAPI document(s) and Open in DialCatz -->
  <section v-else-if="tab === 'api'" class="site-tab">
    <OpenApiCard :key="`openapi-${p.id}`" :site="p" @logs="tab = 'logs'" />
  </section>

  <!-- Logs -->
  <LogView v-else-if="tab === 'logs'" :project-id="p.id" :laravel="p.stack.apps.some((a) => a.framework === 'laravel')" />

  <!-- Env -->
  <section v-else-if="tab === 'env'" class="site-tab">
    <EnvTab :key="p.id" :project="p" />
  </section>

  <!-- WebSocket -->
  <!-- Git -->
  <SiteGitTab v-else-if="tab === 'git'" :key="p.id + 'git'" :project="p" @logs="tab = 'logs'" />
 <SiteMailTab v-else-if="tab === 'mail'" :key="p.id + 'mail'" :project="p" />
 <SiteGatewaysTab v-else-if="tab === 'whatsapp'" :key="p.id + 'gateways'" :project="p" />
  <SiteWebSocketTab v-else-if="tab === 'websocket'" :key="p.id" :project="p" :url-suffix="urlSuffix" />

  <!-- Storage (S3) -->
  <SiteStorageTab v-else-if="tab === 'storage'" :key="p.id" :project="p" />

  <!-- Search Engine -->
  <SiteSearchTab v-else-if="tab === 'search'" :key="p.id" :project="p" />

  <!-- Docker -->
  <section v-else-if="tab === 'docker'" class="site-tab">
    <DockerTab :key="p.id" :project="p" @logs="tab = 'logs'" />
  </section>

  <!-- Database -->
  <section v-else-if="tab === 'database'" class="site-tab">
    <DbLinkCard :key="p.id" :project="p" />

    <div v-if="p.stack.database" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <StatusDot :status="p.dbStatus" />
          <h2 class="font-semibold capitalize">{{ p.stack.database.engine }}</h2>
          <span class="badge badge-ghost badge-sm">{{ p.dbStatus }}</span>
          <span v-if="p.dbTask" class="loading loading-spinner loading-xs" />
          <span v-if="p.dbTask" class="text-xs opacity-60">{{ p.dbTask }}…</span>
        </div>
        <div v-if="p.stack.database.composeFile" class="text-xs opacity-70">
          Service <code>{{ p.stack.database.service }}</code> in <code>{{ p.stack.database.composeFile }}</code>
          <template v-if="p.stack.database.image"> · <code>{{ p.stack.database.image }}</code></template>
          <template v-if="p.stack.database.hostPort"> · localhost:{{ p.stack.database.hostPort }}</template>
        </div>
        <div v-else class="text-xs opacity-70">
          <template v-if="p.stack.database.engine === 'sqlite'">SQLite file <code>{{ p.stack.database.database }}</code> (from <code>DB_CONNECTION=sqlite</code>).</template>
          <template v-else>
            External database from
            <code>{{ p.stack.runtime === 'php' ? 'DB_*' : 'DATABASE_URL' }}</code>
            ({{ p.stack.database.host ?? 'localhost' }}:{{ p.stack.database.hostPort }}{{ p.stack.database.database ? ` / ${p.stack.database.database}` : '' }}). It is managed outside
            DevCatz (another app or Docker), so only its status is shown.
          </template>
        </div>
        <div v-if="p.stack.database.composeFile" class="flex gap-2">
          <button class="btn btn-sm btn-primary" :disabled="dbBusy || p.dbStatus === 'running'" @click="db('start')">Start</button>
          <button class="btn btn-sm" :disabled="dbBusy || p.dbStatus === 'stopped'" @click="db('stop')">Stop</button>
        </div>
      </div>
    </div>
    <div v-else class="alert alert-soft text-sm">No database found: no compose database service and no <code>DATABASE_URL</code> in .env.</div>

    <DataLibsCard :project="p" />

    <div v-if="p.stack.apps.some((a) => a.framework === 'laravel')" class="card">
      <div class="card-body">
        <h2 class="flex items-center gap-2 font-semibold"><StackMark :icon="mark('laravel')" label="Laravel" class="size-4" />Artisan</h2>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-sm" :disabled="dbBusy" @click="db('artisan-migrate')">migrate</button>
          <button class="btn btn-sm" :disabled="dbBusy" @click="db('artisan-seed')">db:seed</button>
          <button class="btn btn-sm btn-error btn-outline" :disabled="dbBusy" @click="db('artisan-fresh')">migrate:fresh --seed…</button>
        </div>
        <p class="text-xs opacity-60">Runs with this site's PHP ({{ p.php.version ?? 'not installed' }}) and php.ini; output in the Logs tab.</p>
      </div>
    </div>

    <TasksCard :project="p" :busy="dbBusy" @logs="tab = 'logs'" />

    <GormCard v-if="p.stack.apps.some((a) => a.framework === 'go')" :key="p.id" :project="p" :busy="dbBusy" @logs="tab = 'logs'" />

    <RedisCard v-if="p.stack.redis" :project="p" :busy="dbBusy" @action="db" />

    <div v-if="p.stack.prismaDir !== null" class="card">
      <div class="card-body">
        <h2 class="flex items-center gap-2 font-semibold"><StackMark :icon="mark('prisma')" label="Prisma" class="size-4" />Prisma <span class="text-xs font-normal opacity-60">in {{ p.stack.prismaDir }}</span></h2>
        <div class="join">
          <input v-model="migrationName" class="input input-sm join-item w-64" placeholder="migration name (when schema changed)" />
          <button class="btn btn-sm join-item" :disabled="dbBusy" @click="db('migrate', migrationName || undefined)">migrate dev</button>
        </div>
        <div class="flex flex-wrap gap-2">
          <button class="btn btn-sm" :disabled="dbBusy" @click="db('seed')">db seed</button>
          <button class="btn btn-sm" :disabled="dbBusy" @click="db('generate')">generate</button>
          <button class="btn btn-sm btn-error btn-outline" :disabled="dbBusy" @click="db('reset')">migrate reset…</button>
        </div>
        <p class="text-xs opacity-60">Output appears in the Logs tab. Commands run without a TTY, so <code>migrate dev</code> needs a name when it has to create a migration.</p>
      </div>
    </div>
  </section>

  <!-- Settings -->
  <section v-else class="site-tab">
    <form class="flex max-w-2xl flex-col gap-6" @submit.prevent="save">
      <!-- Site -->
      <div class="card">
        <div class="card-body gap-4">
          <h2>Site</h2>
          <div class="grid gap-4 sm:grid-cols-2">
            <label class="block">
              <span class="label-caps mb-1.5 block">Name</span>
              <input v-model="form.name" class="input input-sm w-full" />
            </label>
            <label class="block">
              <span class="label-caps mb-1.5 block">{{ parentDomain ? 'Subdomain' : 'Domain' }}</span>
              <div class="join flex w-full">
                <input v-model="form.domain" class="input input-sm join-item min-w-0 flex-1 font-mono" :class="{ 'input-warning': domainTaken }" :placeholder="parentDomain ? 'feature' : 'my-project'" spellcheck="false" autocapitalize="off" />
                <span class="join-item flex max-w-[70%] shrink-0 items-center overflow-hidden border border-base-300 bg-base-200 px-2.5 font-mono text-xs text-ellipsis whitespace-nowrap opacity-70" :title="`.${parentDomain ?? tld}`">.{{ parentDomain ?? tld }}</span>
              </div>
              <span v-if="domainTaken" class="mt-1.5 flex items-start gap-1.5 text-xs text-warning"><CatMood mood="warning" class="size-5 shrink-0" />{{ domainTaken }}. Pick another one.</span>
              <span v-else-if="parentDomain" class="mt-1.5 block text-xs opacity-60">This worktree runs next to its parent site on its own subdomain and ports.</span>
            </label>
          </div>
          <div>
            <span class="label-caps mb-1.5 block">Protocol</span>
            <div class="flex flex-wrap items-center gap-3">
              <div class="join">
                <button type="button" class="btn btn-sm join-item" :class="{ 'btn-active btn-primary': form.secure }" @click="form.secure = true">HTTPS</button>
                <button type="button" class="btn btn-sm join-item" :class="{ 'btn-active btn-primary': !form.secure }" @click="form.secure = false">HTTP</button>
              </div>
              <code class="selectable text-xs opacity-80">{{ form.secure ? 'https' : 'http' }}://{{ domainPreview }}</code>
            </div>
            <span class="mt-1.5 block text-xs opacity-60">
              The other scheme redirects to this one; HTTPS is recommended (secure cookies, service workers, OAuth callbacks).
              {{ isWin ? 'Names end in .localhost' : 'The suffix follows Settings → General → Default domain' }}<template v-if="p.stack.apps.filter((a) => a.kind !== 'assets').length > 1">; other apps get <code>&lt;app&gt;.{{ domainPreview }}</code></template>.
            </span>
          </div>
        </div>
      </div>

      <!-- Dev server -->
      <div class="card">
        <div class="card-body gap-4">
          <h2>Dev server</h2>
          <label class="block">
            <span class="label-caps mb-1.5 block">Dev command</span>
            <input v-model="form.devCommand" class="input input-sm w-full font-mono" :placeholder="p.stack.devCommand ?? 'e.g. bun run dev'" />
            <span class="mt-1.5 block text-xs opacity-60">Leave empty to use the detected command.</span>
          </label>
          <div class="grid gap-4 sm:grid-cols-2">
            <label v-if="usesJs(p.stack)" class="block">
              <span class="label-caps mb-1.5 block">Package manager</span>
              <select v-model="form.packageManager" class="select select-sm w-full">
                <option value="">Auto: {{ p.stack.detectedPackageManager }} (from the lockfile)</option>
                <option v-for="pm in PMS" :key="pm" :value="pm">{{ pm }}</option>
              </select>
              <span class="mt-1.5 block text-xs opacity-60">npm comes with Node.js; Bun is managed on the Bun page; pnpm/yarn need corepack or their own install.</span>
            </label>
            <label v-if="usesJs(p.stack)" class="block">
              <span class="label-caps mb-1.5 block">Node.js version</span>
              <select v-model="form.nodeVersion" class="select select-sm w-full">
                <option value="">Auto: {{ p.node.spec ? `${p.node.spec} from the project` : 'default version' }}</option>
                <option v-for="v in state?.node.installed ?? []" :key="v.version" :value="v.version">{{ v.version }}</option>
              </select>
              <span class="mt-1.5 block text-xs opacity-60">Applies on the next start/restart. Bun-run scripts (<code>bun --bun</code>) use Bun, not Node.</span>
            </label>
            <label v-if="usesPhp(p.stack)" class="block">
              <span class="label-caps mb-1.5 block">PHP version</span>
              <select v-model="form.phpVersion" class="select select-sm w-full">
                <option value="">Auto: {{ p.php.version ?? 'not installed' }} ({{ p.php.spec ? `composer.json asks for ${p.php.spec}` : 'default' }})</option>
                <option v-for="v in state?.php.installed ?? []" :key="v.version" :value="v.version">{{ v.version }}{{ v.source === 'herd' ? ' (Laravel Herd)' : '' }}</option>
              </select>
              <span class="mt-1.5 block text-xs opacity-60">The site moves to that version's {{ FPM }} right after saving.</span>
            </label>
            <label v-if="usesPython(p.stack)" class="block">
              <span class="label-caps mb-1.5 block">Python version</span>
              <select v-model="form.pythonVersion" class="select select-sm w-full">
                <option value="">Auto: {{ p.python.version ?? 'none installed' }} ({{ p.python.reason === 'venv' ? `the ${p.stack.python?.venv} venv` : p.python.spec ? `the project asks for ${p.python.spec}` : 'default' }})</option>
                <option v-for="v in state?.python.installed ?? []" :key="v.version" :value="v.version">{{ v.version }}{{ v.source === 'system' ? ' (your own)' : '' }}</option>
              </select>
              <span class="mt-1.5 block text-xs opacity-60">Used when the venv is (re)created by Install dependencies; delete <code>.venv</code> to switch an existing one.</span>
            </label>
            <label v-if="usesGo(p.stack)" class="block">
              <span class="label-caps mb-1.5 block">Go version</span>
              <select v-model="form.goVersion" class="select select-sm w-full">
                <option value="">Auto: {{ p.go.version ?? 'not installed' }} ({{ p.go.spec ? `go.mod asks for ${p.go.spec}` : 'default' }})</option>
                <option v-for="v in state?.go.installed ?? []" :key="v.version" :value="v.version">{{ v.version }}{{ v.source === 'system' ? ' (your own)' : '' }}</option>
              </select>
              <span class="mt-1.5 block text-xs opacity-60">For the Go apps of this site; applies on the next start.</span>
            </label>
          </div>
          <div class="divider my-0" />
          <label class="flex cursor-pointer items-start gap-3">
            <input v-model="form.managedPorts" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
            <span class="text-sm">
              Let DevCatz assign dev ports
              <span class="mt-0.5 block text-xs opacity-60">
                Each app gets its own port (4100+) injected via the env vars it reads, so sites never collide; .env keeps its production/Docker values. Off = use the
                ports from .env. Applies on the next start.
              </span>
            </span>
          </label>
          <SitePorts v-if="p.stack.apps.length" :site="p" />
          <label class="flex cursor-pointer items-start gap-3">
            <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
            <span class="text-sm">
              Start automatically when DevCatz launches
              <span class="mt-0.5 block text-xs opacity-60">Used when "Start all sites on launch" is off.</span>
            </span>
          </label>
        </div>
      </div>

      <FreeSpaceCard :site-id="p.id" :running="p.status === 'running' || p.status === 'starting'" />

      <!-- Background processes -->
      <div v-if="(usesPhp(p.stack) && p.stack.apps.some((a) => a.framework === 'laravel')) || (usesPython(p.stack) && p.stack.python?.celery)" class="card">
        <div class="card-body gap-4">
          <h2>Runs with Start</h2>
          <template v-if="usesPhp(p.stack) && p.stack.apps.some((a) => a.framework === 'laravel')">
            <label class="flex cursor-pointer items-start gap-3">
              <input v-model="form.queueWorker" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
              <span class="text-sm">Queue worker <span class="mt-0.5 block font-mono text-xs opacity-60">php artisan queue:work</span></span>
            </label>
            <label class="flex cursor-pointer items-start gap-3">
              <input v-model="form.scheduler" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
              <span class="text-sm">Scheduler <span class="mt-0.5 block font-mono text-xs opacity-60">php artisan schedule:work</span></span>
            </label>
          </template>
          <template v-else-if="p.stack.python?.celery">
            <label class="flex cursor-pointer items-start gap-3">
              <input v-model="form.queueWorker" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
              <span class="text-sm">Celery worker <span class="mt-0.5 block font-mono text-xs opacity-60">celery -A {{ p.stack.python.celery }} worker</span></span>
            </label>
            <label class="flex cursor-pointer items-start gap-3">
              <input v-model="form.scheduler" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
              <span class="text-sm">Celery beat <span class="mt-0.5 block font-mono text-xs opacity-60">celery -A {{ p.stack.python.celery }} beat</span></span>
            </label>
          </template>
        </div>
      </div>

      <div class="flex flex-wrap items-center gap-2">
        <button class="btn btn-primary btn-sm" type="submit" :disabled="!!domainTaken" :title="domainTaken ?? `Save (${keyLabel('mod+S')})`">Save <kbd class="kbd kbd-xs border-white/30 bg-white/15 text-inherit">{{ keyLabel('mod+S') }}</kbd></button>
        <button class="btn btn-ghost btn-sm" type="button" @click="rescan">Re-detect stack</button>
        <div class="flex-1" />
        <button v-if="!p.parkedFrom" class="btn btn-error btn-outline btn-sm" type="button" @click="unlinking = true">Unlink…</button>
      </div>
      <p v-if="p.parkedFrom" class="text-xs opacity-60">
        This site comes from the parked folder <code>{{ p.parkedFrom }}</code>. Unpark the folder in Settings to remove it.
      </p>
    </form>
  </section>
  <UnlinkDialog v-if="unlinking" :project="p" @close="unlinking = false" @done="unlinking = false" />
  <ExposeShareDialog v-if="sharing" :site-id="p.id" @close="sharing = false" @started="sharing = false; navRequest = { section: 'expose', id: p.id }" />
</template>
