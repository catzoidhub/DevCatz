<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { STAR } from '../icons';
import PopMenu from './PopMenu.vue';
import { groupByType, sortList, useListView } from '../listview';
import type { DbEngine, DbnginInstall, DbServiceState, ExternalDbService, StorageAction } from '@shared/types';
import StatusDot from './StatusDot.vue';
import LogView from './LogView.vue';
import TaskStepper from './TaskStepper.vue';
import DbServiceForm from './DbServiceForm.vue';
import DbRemoveDialog from './DbRemoveDialog.vue';
import DbEnvWriter from './DbEnvWriter.vue';
import DbCatzButton from './DbCatzButton.vue';
import { DB_LOGO, isActive } from '../db';
import DbImportDialog from './DbImportDialog.vue';
import { attempt, dbGroupRequest, herd, notify, state, uninstallRequest } from '../store';
import { navVisit } from '../nav';
import CatMood from './CatMood.vue';

/** Database services (like DBngin): instances on the left, the selected one's overview, connection and logs on the right. */
const ENGINE_ORDER: DbEngine[] = ['mysql', 'mariadb', 'postgresql', 'redis', 'valkey', 'mongodb', 'elasticsearch', 'sqlite'];
const ENGINE_NAMES: Record<DbEngine, string> = {
  mysql: 'MySQL',
  mariadb: 'MariaDB',
  postgresql: 'PostgreSQL',
  redis: 'Redis',
  valkey: 'Valkey',
  mongodb: 'MongoDB',
  elasticsearch: 'Elasticsearch',
  sqlite: 'SQLite',
};

/** Sort and grouping of the list (⇅ menu): default = drag-and-drop order and the user's groups. */
const listView = useListView('mrcatz-herd.db.view', 'engine', 'Running services only');
const view = listView.view;
/** "Running services only" (⇅ menu): running or starting, and crashed ones so the problem stays visible. */
const live = (s: DbServiceState) => !s.pending && (isActive(s) || s.status === 'crashed');
/** Engine order, then name; a drag-and-drop order (Settings dbOrder) wins where set; or by name / engine. */
const services = computed(() => {
  const idx = new Map((state.value?.settings.dbOrder ?? []).map((id, i) => [id, i]));
  const base = [...(state.value?.databases ?? [])].sort(
    (a, b) => (idx.get(a.id) ?? 1e6) - (idx.get(b.id) ?? 1e6) || ENGINE_ORDER.indexOf(a.engine) - ENGINE_ORDER.indexOf(b.engine) || a.name.localeCompare(b.name),
  );
  return sortList(base, view.value.sort, (s) => s.name, (s) => ENGINE_NAMES[s.engine]);
});
// ---- favorites, groups and drag-and-drop, like the sites sidebar
interface Section {
  key: string;
  title: string;
  group?: string;
  collapsed?: boolean;
  items: DbServiceState[];
}
const favs = computed(() => new Set(state.value?.settings.dbFavorites ?? []));
const sections = computed<Section[]>(() => {
  const filtering = view.value.runningOnly;
  const all = filtering ? services.value.filter(live) : services.value;
  const groups = state.value?.settings.dbGroups ?? [];
  const out: Section[] = [];
  const favItems = all.filter((s) => favs.value.has(s.id));
  const c = (key: string) => listView.isCollapsed(key);
  if (favItems.length) out.push({ key: 'fav', title: 'Favorites', items: favItems, collapsed: c('fav') });
  if (view.value.group === 'type') {
    for (const [label, items] of groupByType(all, (s) => ENGINE_NAMES[s.engine])) out.push({ key: `t:${label}`, title: label, items, collapsed: c(`t:${label}`) });
    return out;
  }
  if (view.value.group === 'none') {
    out.push({ key: 'rest', title: out.length ? 'All services' : '', items: all, collapsed: c('rest') });
    return out;
  }
  const grouped = new Set<string>();
  for (const g of groups) {
    const members = new Set(g.sites);
    const items = all.filter((s) => members.has(s.id));
    items.forEach((s) => grouped.add(s.id));
    // While filtering, groups with nothing running disappear.
    if (!filtering || items.length) out.push({ key: `g:${g.name}`, title: g.name, group: g.name, collapsed: g.collapsed, items });
  }
  const rest = all.filter((s) => !grouped.has(s.id));
  if (rest.length || (!out.length && !filtering)) out.push({ key: 'rest', title: out.length ? (groups.length ? 'Other services' : 'All services') : '', items: rest, collapsed: c('rest') });
  return out;
});
const dragId = ref<string | null>(null);
const dropTarget = ref<string | null>(null);
const dropRow = ref<string | null>(null);
function onDropSection(sec: Section) {
  const id = dragId.value;
  dragId.value = null;
  dropTarget.value = null;
  if (!id) return;
  if (sec.key === 'fav') void attempt(() => herd.dbSetFavorite(id, true));
  else if (view.value.group === 'default') void attempt(() => herd.dbSetGroup(id, sec.group ?? null));
}
function onDropRow(target: DbServiceState, sec: Section) {
  const id = dragId.value;
  dragId.value = null;
  dropTarget.value = null;
  dropRow.value = null;
  if (!id || id === target.id) return;
  const order = services.value.map((s) => s.id).filter((x) => x !== id);
  order.splice(order.indexOf(target.id), 0, id);
  void attempt(async () => {
    if (view.value.sort === 'default') await herd.dbSetOrder(order);
    else notify('info', 'Sorted by name / engine: switch to the default sort (⇅) to reorder by hand');
    if (sec.key === 'fav') {
      if (!favs.value.has(id)) await herd.dbSetFavorite(id, true);
    } else if (view.value.group === 'default') {
      const current = state.value?.settings.dbGroups.find((g) => g.sites.includes(id))?.name ?? null;
      if (current !== (sec.group ?? null)) await herd.dbSetGroup(id, sec.group ?? null);
    }
  });
}
const groupDialog = ref<{ mode: 'new' | 'rename'; id?: string; from?: string; name: string } | null>(null);
watch(
  dbGroupRequest,
  (r) => {
    if (!r) return;
    groupDialog.value = r.mode === 'new' ? { mode: 'new', id: r.id, name: '' } : { mode: 'rename', from: r.from, name: r.from ?? '' };
    dbGroupRequest.value = null;
  },
  { immediate: true },
);
async function saveGroup() {
  const d = groupDialog.value;
  if (!d || !d.name.trim()) return;
  const ok = await attempt(() => (d.mode === 'new' ? herd.dbSetGroup(d.id!, d.name) : herd.dbGroupAction(d.from!, 'rename', d.name)).then(() => true));
  if (ok) groupDialog.value = null;
}
const props = defineProps<{ focus?: string | null }>();
const selectedId = ref<string | null>(props.focus ?? null);
const selected = computed(() => services.value.find((s) => s.id === selectedId.value && !s.pending) ?? null);
watch(
  () => props.focus,
  (id) => {
    if (id) selectedId.value = id;
  },
);
// Back / forward history: each service shown is a step.
watch(selectedId, (id) => navVisit({ section: 'database', item: id }), { immediate: true });
watch(
  services,
  (list) => {
    if (!selected.value) selectedId.value = list.find((s) => !s.pending)?.id ?? null;
  },
  { immediate: true },
);
const liveCount = computed(() => services.value.filter(live).length);
const running = computed(() => services.value.filter((s) => !s.pending && s.engine !== 'sqlite' && isActive(s)).length);

type Tab = 'overview' | 'connection' | 'logs';
const tab = ref<Tab>('overview');
const form = ref<{ service?: DbServiceState; engine?: DbEngine; retry?: DbServiceState } | null>(null);
const removing = ref<DbServiceState | null>(null);

// Ask DevCatz's "Uninstall …" opens this page's own dialog (with its typed confirmation); nothing is removed without it.
watch(
  uninstallRequest,
  (r) => {
    if (r?.scope !== 'db') return;
    uninstallRequest.value = null;
    const s = services.value.find((x) => x.id === r.id && !x.pending);
    if (s) {
      selectedId.value = s.id;
      removing.value = s;
    }
  },
  { immediate: true },
);
const busy = ref<string | null>(null);

async function act(s: DbServiceState, action: StorageAction) {
  busy.value = `${s.id}:${action}`;
  await attempt(() => herd.dbAction(s.id, action));
  busy.value = null;
}
/** A failed create in the list: run it again with the same settings, its progress in the create window. */
const retry = (s: DbServiceState) => (form.value = { retry: s });
const siteName = (id: string) => state.value?.projects.find((p) => p.id === id)?.name ?? id;
const unlink = (siteId: string) => attempt(() => herd.updateProject(siteId, { dbService: '' }));

// ---- servers outside DevCatz
const external = ref<ExternalDbService[]>([]);
const dbngin = ref<DbnginInstall[]>([]);
const detecting = ref(false);
async function detect() {
  detecting.value = true;
  const r = await herd.dbDetect().catch(() => null);
  if (r) {
    external.value = r.running;
    dbngin.value = r.dbngin;
  }
  detecting.value = false;
}
onMounted(detect);
/** Running elsewhere → Import…: copy that server's databases into a DevCatz service. */
const importing = ref<ExternalDbService | null>(null);
const importable = (e: ExternalDbService) => e.engine === 'mysql' || e.engine === 'mariadb' || e.engine === 'postgresql';

/** A DevCatz instance whose port another server already holds. */
const clashWith = (s: DbServiceState) => external.value.find((e) => e.port === s.port && s.engine !== 'sqlite' && !isActive(s));

const yesNo = (b: boolean) => (b ? 'Yes' : 'No');
const openBinaries = (id: string) => attempt(() => herd.dbOpenBinaries(id));
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <!-- Instances (same shell as the Projects sidebar) -->
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip flex h-14 items-end justify-end gap-1 px-3 pb-2">
        <span class="nav-hole" aria-hidden="true" />
        <DbCatzButton primary label="DBCatz" />
        <button class="btn btn-ghost btn-sm btn-square" title="New database service" @click="form = {}">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
        </button>
      </div>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">Services</span>
        <span v-if="running && !view.runningOnly" class="badge badge-success badge-soft badge-xs">{{ running }} running</span>
        <button
          v-if="view.runningOnly"
          class="badge badge-primary badge-soft badge-xs gap-1"
          :title="`Showing the ${liveCount} running services of ${services.length}: click to show all`"
          @click="listView.setRunningOnly(false)"
        >Running · {{ liveCount }} of {{ services.length }} <span class="opacity-70">✕</span></button>
        <span class="flex-1" />
        <PopMenu :items="listView.items.value" align="end" :width="260">
          <button class="btn btn-ghost btn-xs btn-square" :class="{ 'text-primary': listView.custom.value }" title="Sort and group">
            <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M2.5 5.25A.75.75 0 0 1 3.25 4.5h13.5a.75.75 0 0 1 0 1.5H3.25a.75.75 0 0 1-.75-.75Zm2 4A.75.75 0 0 1 5.25 8.5h9.5a.75.75 0 0 1 0 1.5h-9.5a.75.75 0 0 1-.75-.75Zm2 4a.75.75 0 0 1 .75-.75h5.5a.75.75 0 0 1 0 1.5h-5.5a.75.75 0 0 1-.75-.75Z" /></svg>
          </button>
        </PopMenu>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap overflow-y-auto px-2" @dragend="dropTarget = null; dropRow = null">
        <template v-for="sec in sections" :key="sec.key">
          <li
            v-if="sec.title"
            class="menu-title mt-1 flex-row items-center gap-1 rounded-md px-3 py-1 text-xs"
            :class="{ 'bg-primary/15': dropTarget === sec.key }"
            @dragover.prevent="dropTarget = sec.key"
            @dragleave="dropTarget = dropTarget === sec.key ? null : dropTarget"
            @drop.prevent="onDropSection(sec)"
            @contextmenu.prevent="sec.group && herd.dbGroupMenu(sec.group)"
          >
            <button class="flex flex-1 items-center gap-1 text-left" @click="sec.group ? herd.dbGroupAction(sec.group, 'toggle') : listView.toggle(sec.key)">
              <svg class="size-3 transition-transform" :class="{ '-rotate-90': sec.collapsed }" viewBox="0 0 20 20" fill="currentColor"><path d="M5.2 7.2a.75.75 0 0 1 1.06 0L10 10.94l3.74-3.74a.75.75 0 1 1 1.06 1.06l-4.27 4.27a.75.75 0 0 1-1.06 0L5.2 8.26a.75.75 0 0 1 0-1.06Z" /></svg>
              <svg v-if="sec.key === 'fav'" class="size-3 text-warning" viewBox="0 0 20 20" fill="currentColor"><path :d="STAR" /></svg>
              <span class="truncate">{{ sec.title }}</span>
            </button>
            <span class="opacity-60">{{ sec.items.length }}</span>
          </li>
          <template v-if="!sec.collapsed">
            <li
              v-for="s in sec.items"
              :key="sec.key + s.id"
              :draggable="!s.pending"
              :class="{ 'drop-before': dropRow === s.id && dragId !== s.id }"
              @dragstart="dragId = s.id"
              @dragover.prevent.stop="dropRow = s.id"
              @dragleave="dropRow = dropRow === s.id ? null : dropRow"
              @drop.prevent.stop="onDropRow(s, sec)"
              @contextmenu.prevent="!s.pending && herd.dbMenu(s.id)"
            >
          <a :class="{ 'menu-active': s.id === selectedId && !s.pending, 'opacity-80': s.pending }" @click="!s.pending && ((selectedId = s.id), (tab = tab === 'logs' ? 'logs' : 'overview'))">
            <img :src="DB_LOGO[s.engine]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="truncate font-medium">{{ s.name }}</span>
                <svg v-if="favs.has(s.id) && sec.key !== 'fav'" class="size-3 shrink-0 text-warning" viewBox="0 0 20 20" fill="currentColor"><path :d="STAR" /></svg>
              </div>
              <div class="truncate font-mono text-[11px] opacity-60">
                {{ s.version }}<template v-if="s.engine !== 'sqlite'"> · :{{ s.port }}</template>
              </div>
              <div v-if="s.pending && s.task" class="mt-1">
                <progress class="progress h-1 w-full" :class="s.task.error ? 'progress-error' : 'progress-primary'" :value="s.task.error ? 100 : s.task.step" :max="s.task.steps.length" />
                <div class="truncate text-[10px]" :class="s.task.error ? 'text-error' : 'opacity-60'">{{ s.task.error ?? s.task.steps[s.task.step] }}</div>
              </div>
            </div>
            <span v-if="s.pending && s.task?.error" class="flex shrink-0 items-center gap-0.5">
              <button class="btn btn-ghost btn-xs btn-square" title="Try again with the same settings" @click.stop="retry(s)">
                <svg class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M15.3 5.3A7 7 0 1 0 17 10h-2a5 5 0 1 1-1.2-3.3L11.5 9H17V3.5l-1.7 1.8Z" clip-rule="evenodd" /></svg>
              </button>
              <button class="btn btn-ghost btn-xs btn-square" title="Dismiss" @click.stop="herd.dbDismiss(s.id)">✕</button>
            </span>
            <span v-else-if="s.pending" class="loading loading-spinner loading-xs" />
            <template v-else-if="s.engine !== 'sqlite'">
              <StatusDot :status="s.status" />
              <button
                class="btn btn-ghost btn-xs btn-square"
                :title="isActive(s) ? 'Stop' : 'Start'"
                :disabled="!!busy || s.status === 'stopping'"
                @click.stop="act(s, isActive(s) ? 'stop' : 'start')"
              >
                <svg v-if="isActive(s)" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
                <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.9l8-4.9a1 1 0 0 0 0-1.8l-8-4.9Z" /></svg>
              </button>
            </template>
            <span v-else class="badge badge-ghost badge-xs">files</span>
          </a>
            </li>
            <li v-if="sec.group && !sec.items.length" class="px-3 py-1 text-xs opacity-50">Drop services here</li>
          </template>
        </template>
        <li v-if="!services.length" class="px-3 py-3 text-xs opacity-60">No services yet. Create one with +.</li>
        <li v-else-if="view.runningOnly && !liveCount" class="px-3 py-6 text-center text-xs">
          <span class="opacity-60">No running services.</span>
          <button class="btn btn-ghost btn-xs mx-auto mt-1" @click="listView.setRunningOnly(false)">Show all services</button>
        </li>
      </ul>

      <!-- Servers outside DevCatz -->
      <div class="border-t border-base-300/60 p-3 text-xs">
        <div class="mb-1.5 flex items-center gap-2">
          <span class="label-caps">Running elsewhere</span>
          <span class="flex-1" />
          <button class="btn btn-ghost btn-xs btn-square" title="Look again" :disabled="detecting" @click="detect">
            <span v-if="detecting" class="loading loading-spinner loading-xs" /><template v-else>↻</template>
          </button>
        </div>
        <ul v-if="external.length" class="space-y-1">
          <li v-for="e in external" :key="`${e.pid}:${e.port}`" class="flex items-center gap-2" :title="e.path ?? e.process">
            <img v-if="e.engine" :src="DB_LOGO[e.engine]" alt="" class="size-4 rounded bg-white p-px" draggable="false" />
            <span class="truncate">{{ e.engine ? ENGINE_NAMES[e.engine] : e.process }}</span>
            <span class="badge badge-ghost badge-xs">{{ e.source }}</span>
            <span class="ml-auto font-mono opacity-70">:{{ e.port }}</span>
            <button v-if="importable(e)" class="btn btn-ghost btn-xs" :title="`Copy databases from this server into a DevCatz service (${e.source} is not changed)`" @click="importing = e">Import…</button>
          </li>
        </ul>
        <p v-else class="opacity-60">{{ detecting ? 'Looking…' : 'No other database servers are listening.' }}</p>
        <p v-if="dbngin.length" class="mt-1.5 opacity-60" :title="dbngin.map((d) => `${ENGINE_NAMES[d.engine]} ${d.version}`).join(', ')">
          DBngin has {{ dbngin.map((d) => `${ENGINE_NAMES[d.engine]} ${d.version}`).join(', ') }} installed.
        </p>
      </div>
    </aside>
    <DbImportDialog v-if="importing" :source="importing" @close="importing = null" />

    <!-- Selected -->
    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <div v-if="!services.length" class="drag flex-1 overflow-y-auto p-6">
      <div class="mx-auto max-w-2xl space-y-4 pt-10 text-center">
        <h2 class="text-lg font-semibold">Create your first database service</h2>
        <p class="text-sm opacity-70">Pick an engine. DevCatz downloads the version you choose and runs it on its own port and data folder.</p>
        <div class="grid grid-cols-4 gap-3 pt-2">
          <button
            v-for="e in ENGINE_ORDER"
            :key="e"
            class="flex flex-col items-center gap-2 rounded-box border border-base-300/70 bg-base-100 p-4 text-sm transition hover:-translate-y-0.5 hover:ring-1 hover:ring-[var(--c-database)]/50"
            @click="form = { engine: e }"
          >
            <img :src="DB_LOGO[e]" alt="" class="size-11 rounded-xl bg-white p-2 ring-1 ring-base-content/10" draggable="false" />
            {{ ENGINE_NAMES[e] }}
          </button>
        </div>
      </div>
      </div>

      <template v-else-if="selected">
      <!-- Header (window drag area, like a site's) -->
      <header class="drag border-b border-base-300/60 px-6 pt-5 pb-3">
        <div class="flex flex-wrap items-center gap-3">
          <img :src="DB_LOGO[selected.engine]" alt="" class="size-11 rounded-xl bg-white p-1.5 ring-1 ring-base-content/10" draggable="false" />
          <div class="min-w-0">
            <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
              {{ selected.name }}
              <template v-if="selected.engine !== 'sqlite'">
                <StatusDot :status="selected.status" />
                <span class="badge badge-soft badge-sm" :class="selected.status === 'running' ? 'badge-success' : selected.status === 'starting' ? 'badge-warning' : selected.status === 'crashed' ? 'badge-error' : 'badge-ghost'">
                  {{ selected.status }}
                </span>
              </template>
            </h2>
            <div class="font-mono text-xs opacity-60">
              {{ selected.engineName }} {{ selected.version }}<template v-if="selected.engine !== 'sqlite'"> · {{ selected.host ?? '127.0.0.1' }}:{{ selected.port }}</template>
            </div>
          </div>
          <span class="flex-1" />
          <template v-if="selected.engine !== 'sqlite'">
            <button v-if="!isActive(selected)" class="btn btn-primary btn-sm" :disabled="!!busy" @click="act(selected, 'start')">
              <span v-if="busy === `${selected.id}:start`" class="loading loading-spinner loading-xs" />Start
            </button>
            <button v-else class="btn btn-sm" :disabled="!!busy || selected.status === 'stopping'" @click="act(selected, 'stop')">
              <span v-if="busy === `${selected.id}:stop`" class="loading loading-spinner loading-xs" />Stop
            </button>
            <button class="btn btn-sm" :disabled="!!busy || !isActive(selected)" @click="act(selected, 'restart')">Restart</button>
          </template>
          <DbCatzButton :conn-id="`svc:${selected.id}`" />
        </div>
        <div role="tablist" class="seg no-drag mt-3">
          <a v-for="t in ['overview', 'connection', 'logs'] as Tab[]" :key="t" role="tab" class="seg-item" :class="{ 'is-active': tab === t }" @click="tab = t">{{ t }}</a>
        </div>
      </header>

      <div class="flex-1 space-y-4 overflow-y-auto p-6">

        <div v-if="selected.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ selected.error }}</div>
        <div v-else-if="clashWith(selected)" role="alert" class="alert alert-warning alert-soft text-sm"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
          Port {{ selected.port }} is held by {{ clashWith(selected)!.source }} ({{ clashWith(selected)!.process }}). Stop it there or change this service’s port.
        </div>
        <TaskStepper v-if="selected.task" :task="selected.task" compact />

        <!-- Overview -->
        <template v-if="tab === 'overview'">
          <div class="card">
            <div class="card-body">
              <div class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                <div><span class="label-caps block">Version</span><code>{{ selected.version }}</code></div>
                <div v-if="selected.engine !== 'sqlite'"><span class="label-caps block">Port</span><code>{{ selected.port }}</code></div>
                <div v-if="selected.engine !== 'sqlite'">
                  <span class="label-caps block">Address</span>
                  <code class="selectable">{{ selected.host ?? '127.0.0.1' }}:{{ selected.port }}</code>
                  <span v-if="!selected.host" class="ml-1 text-xs opacity-50">(DB domain: Settings → Database)</span>
                </div>
                <div v-if="selected.resolvedSocket"><span class="label-caps block">Socket</span><code class="selectable break-all">{{ selected.resolvedSocket }}</code></div>
                <div class="sm:col-span-2">
                  <span class="label-caps block">{{ selected.engine === 'sqlite' ? 'Database folder' : 'Data path' }}</span>
                  <code class="selectable break-all">{{ selected.resolvedDataDir }}</code>
                </div>
                <div v-if="selected.engine !== 'sqlite'" class="sm:col-span-2">
                  <span class="label-caps block">Config file</span>
                  <code v-if="selected.configFile" class="selectable break-all">{{ selected.configFile }}</code>
                  <span v-else class="text-xs opacity-60">None (DevCatz’s defaults)</span>
                </div>
                <div v-if="selected.engine === 'mysql' || selected.engine === 'mariadb'">
                  <span class="label-caps block">Binary log</span>{{ selected.disableBinLog ? 'Disabled' : 'Enabled' }}
                </div>
                <div v-if="selected.engine !== 'sqlite'"><span class="label-caps block">Starts with DevCatz</span>{{ yesNo(selected.autoStart) }}</div>
                <div v-if="selected.user"><span class="label-caps block">User</span><code>{{ selected.user }}</code> · {{ selected.password ? 'password set' : 'no password' }}</div>
                <div class="sm:col-span-2">
                  <span class="label-caps block">Server binaries</span>
                  <code v-if="selected.binaryRoot" class="selectable break-all">{{ selected.binaryRoot }}</code>
                  <span v-else class="text-xs text-warning">Not installed: open Settings and save to install {{ selected.engineName }} {{ selected.version }}.</span>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-1.5 border-t border-base-300/60 pt-3">
                <button class="btn btn-sm" @click="herd.dbOpenData(selected.id)">Show database files</button>
                <button class="btn btn-sm" :disabled="!selected.binaryRoot" @click="openBinaries(selected.id)">Show database server binaries</button>
                <button class="btn btn-sm" @click="form = { service: selected }">Settings…</button>
                <span class="flex-1" />
                <button class="btn btn-ghost btn-sm text-error" @click="removing = selected">Remove…</button>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-body gap-2">
              <h3 class="font-semibold">Linked sites</h3>
              <p class="text-xs opacity-60">A linked site starts this service when it starts, and manages it from its Database tab. Link one from the Connection tab.</p>
              <div v-if="selected.linkedSites.length" class="flex flex-wrap gap-1.5">
                <span v-for="id in selected.linkedSites" :key="id" class="badge badge-ghost gap-1">
                  {{ siteName(id) }}
                  <button class="opacity-60 hover:opacity-100" title="Unlink" @click="unlink(id)">✕</button>
                </span>
              </div>
              <span v-else class="text-xs opacity-50">None yet.</span>
            </div>
          </div>
        </template>

        <div v-else-if="tab === 'connection'" class="card">
          <div class="card-body p-4">
            <DbEnvWriter :key="selected.id" :service="selected" />
          </div>
        </div>

        <div v-else class="h-[30rem]">
          <LogView v-if="selected.engine !== 'sqlite'" :key="selected.id" :project-id="`db:${selected.id}`" />
          <p v-else class="text-sm opacity-60">SQLite has no server, so there is nothing to log.</p>
        </div>
      </div>
      </template>
      <div v-else class="drag flex flex-1 items-center justify-center text-sm opacity-60">Select a service</div>
    </main>
  </div>

  <DbServiceForm
    v-if="form"
    :service="form.service ? services.find((s) => s.id === form!.service!.id) : undefined"
    :engine="form.engine"
    :retry="form.retry"
    @close="form = null"
    @done="(id) => ((form = null), (selectedId = id))"
  />
  <DbRemoveDialog v-if="removing" :service="removing" @close="removing = null" @done="(removing = null), (selectedId = null)" />
  <dialog v-if="groupDialog" open class="modal modal-open" @keydown.esc="groupDialog = null">
    <form class="modal-box w-80 space-y-3" @submit.prevent="saveGroup">
      <h3 class="font-semibold">{{ groupDialog.mode === 'new' ? 'New group' : 'Rename group' }}</h3>
      <input v-model="groupDialog.name" class="input input-sm w-full" placeholder="e.g. Project X" maxlength="40" autofocus />
      <div v-if="groupDialog.mode === 'new' && state?.settings.dbGroups.length" class="flex flex-wrap gap-1">
        <button v-for="g in state!.settings.dbGroups" :key="g.name" type="button" class="btn btn-xs" @click="groupDialog.name = g.name">{{ g.name }}</button>
      </div>
      <div class="modal-action mt-2">
        <button type="button" class="btn btn-sm btn-ghost" @click="groupDialog = null">Cancel</button>
        <button class="btn btn-sm btn-primary" :disabled="!groupDialog.name.trim()">{{ groupDialog.mode === 'new' ? 'Create & move' : 'Rename' }}</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="groupDialog = null" />
  </dialog>
</template>
