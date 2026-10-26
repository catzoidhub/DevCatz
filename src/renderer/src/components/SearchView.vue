<script setup lang="ts">
import { SEARCH_LOGO } from '../logos';
import { computed, ref, watch } from 'vue';
import type { SearchIndex, SearchKind, SearchState, StorageAction } from '@shared/types';
import StatusDot from './StatusDot.vue';
import LogView from './LogView.vue';
import TaskStepper from './TaskStepper.vue';
import ServiceUninstall from './ServiceUninstall.vue';
import SearchForm from './SearchForm.vue';
import SearchEnvWriter from './SearchEnvWriter.vue';
import SearchPlayground from './SearchPlayground.vue';
import SearchKeys from './SearchKeys.vue';
import SearchTasks from './SearchTasks.vue';
import SearchBackups from './SearchBackups.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import { attempt, herd, notify, state, uninstallRequest } from '../store';
import CatMood from './CatMood.vue';

/**
 * Search engines (rail): Meilisearch, Typesense, OpenSearch, Manticore,
 * ZincSearch and Sonic, one instance each; indexes with settings, import and
 * export, a search playground, API keys, Meilisearch's task queue and
 * backups, .env lines for sites, logs; and which sites use search.
 */
const props = defineProps<{ focus?: string | null }>();
const emit = defineEmits<{ openSite: [id: string] }>();

const services = computed(() => state.value?.searchEngines ?? []);
const selectedKind = ref<SearchKind | null>(null);
const selected = computed(() => services.value.find((s) => s.kind === selectedKind.value) ?? null);
const installed = computed(() => services.value.filter((s) => s.installed));
// First installed engine, else the first kind (its install page).
watch(
  services,
  (list) => {
    if (!selectedKind.value) selectedKind.value = list.find((s) => s.installed)?.kind ?? list[0]?.kind ?? null;
  },
  { immediate: true },
);
watch(
  () => props.focus,
  (k) => k && services.value.some((s) => s.kind === k) && (selectedKind.value = k as SearchKind),
  { immediate: true },
);
const runningCount = computed(() => services.value.filter((s) => active(s)).length);
/** Header "More" menu of the selected engine. */
const moreItems = computed<MenuItem[]>(() => {
  const s = selected.value;
  if (!s?.installed) return [];
  return [
    { label: 'Open data folder', action: () => herd.searchOpenData(s.kind) },
    { label: 'Check for updates', action: checkUpdates },
    { label: 'Settings…', action: () => (form.value = { service: s, mode: 'edit' }) },
    { label: 'Uninstall…', action: () => (removing.value = s) },
  ];
});

const LOGO = SEARCH_LOGO;
type Tab = 'indexes' | 'search' | 'keys' | 'tasks' | 'backups' | 'connection' | 'sites' | 'logs';
const tab = ref<Tab>('indexes');
const tabs = computed<Tab[]>(() => {
  const f = selected.value?.features;
  return ['indexes', 'search', ...(f?.keys ? (['keys'] as Tab[]) : []), ...(f?.tasks ? (['tasks'] as Tab[]) : []), ...(f?.backups ? (['backups'] as Tab[]) : []), 'connection', 'sites', 'logs'];
});
watch(selectedKind, () => !tabs.value.includes(tab.value) && (tab.value = 'indexes'));
const form = ref<{ service: SearchState; mode: 'install' | 'edit' } | null>(null);
const busy = ref<string | null>(null);
const active = (s: SearchState) => s.status === 'running' || s.status === 'starting';
/** Newer release: download, swap the binary, restart (data and settings stay). */
async function upgrade(s: SearchState) {
  busy.value = `${s.kind}:update`;
  await attempt(() => herd.searchUpgrade(s.kind).then(() => true), `${s.name} updated`);
  busy.value = null;
}
async function checkUpdates() {
  const failed = await attempt(() => herd.servicesCheckUpdates());
  if (!failed) return;
  const s = selected.value;
  if (s && failed.includes(s.name)) notify('error', `Could not check ${s.name} for updates (offline, or GitHub's hourly limit; try again later)`);
  else notify('info', s?.update ? `${s.name} ${s.update} is available` : `${s?.name ?? 'Everything'} is up to date`);
}
const updating = (s: SearchState) => s.task?.kind === 'update' && !s.task.done && !s.task.error;
async function act(s: SearchState, action: StorageAction) {
  busy.value = `${s.kind}:${action}`;
  await attempt(() => herd.searchAction(s.kind, action));
  busy.value = null;
}

// ---- indexes
const indexes = ref<SearchIndex[]>([]);
const loadingIdx = ref(false);
async function loadIndexes() {
  const s = selected.value;
  if (!s?.installed || s.status !== 'running') {
    indexes.value = [];
    return;
  }
  loadingIdx.value = true;
  indexes.value = (await herd.searchIndexes(s.kind).catch(() => [])) ?? [];
  loadingIdx.value = false;
}
watch(() => [selectedKind.value, selected.value?.status], loadIndexes, { immediate: true });
const playIndex = ref('');
const newName = ref('');
const newSchema = ref('');
async function createIndex() {
  const s = selected.value!;
  const name = newName.value.trim();
  if (!name) return;
  if (await attempt(() => herd.searchCreateIndex(s.kind, name, newSchema.value).then(() => true))) {
    notify('success', `Index ${name} created`);
    newName.value = '';
    newSchema.value = '';
    await loadIndexes();
  }
}
const deleting = ref<string | null>(null);
async function deleteIndex() {
  const s = selected.value!;
  const name = deleting.value!;
  deleting.value = null;
  if (await attempt(() => herd.searchDeleteIndex(s.kind, name).then(() => true))) {
    notify('success', `Index ${name} deleted`);
    await loadIndexes();
  }
}
async function importFile(name: string) {
  const n = await attempt(() => herd.searchImportFile(selected.value!.kind, name));
  if (n) {
    notify('success', `${n} documents imported into ${name}`);
    await loadIndexes();
  }
}
const settings = ref<{ index: string; text: string; editable: boolean } | null>(null);
async function openSettings(name: string) {
  const r = await attempt(() => herd.searchGetSettings(selected.value!.kind, name));
  if (r) settings.value = { index: name, ...r };
}
async function saveSettings() {
  if (!settings.value) return;
  if (await attempt(() => herd.searchSaveSettings(selected.value!.kind, settings.value!.index, settings.value!.text).then(() => true))) {
    notify('success', `Settings of ${settings.value.index} saved`);
    settings.value = null;
  }
}
async function exportIndex(name: string, format: 'ndjson' | 'json') {
  const n = await attempt(() => herd.searchExport(selected.value!.kind, name, format));
  if (n !== undefined && n !== null) notify('success', `${n} documents of ${name} exported`);
}
const exportItems = (name: string): MenuItem[] => [
  { label: 'NDJSON (one document per line)', hint: 'Import-ready', action: () => exportIndex(name, 'ndjson') },
  { label: 'JSON array', action: () => exportIndex(name, 'json') },
];
function searchIn(name: string) {
  playIndex.value = name;
  tab.value = 'search';
}
const size = (b: number | null) => (b === null ? '—' : b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : b > 1024 ? `${(b / 1024).toFixed(0)} KB` : `${b} B`);
const schemaHint = computed(() => (selected.value?.kind === 'manticore' ? 'columns: title text, price float' : selected.value?.kind === 'meilisearch' ? 'primary key (optional): id' : ''));

// ---- uninstall
const removing = ref<SearchState | null>(null);

// Ask DevCatz's "Uninstall …" opens this page's own dialog (with its typed confirmation); nothing is removed without it.
watch(
  uninstallRequest,
  (r) => {
    if (r?.scope !== 'search') return;
    uninstallRequest.value = null;
    const s = services.value.find((x) => x.kind === r.id && x.installed);
    if (s) {
      selectedKind.value = s.kind;
      removing.value = s;
    }
  },
  { immediate: true },
);

const searchSites = computed(() => (state.value?.projects ?? []).filter((p) => p.search.libs.length));
async function copy(t: string) {
  await navigator.clipboard.writeText(t);
  notify('info', 'Copied');
}
/** Typed-domain uninstall (ServiceUninstall checks the domain, so does the main process). */
const uninstallRun = (deleteData: boolean, typed: string) => herd.searchUninstall(removing.value!.kind, deleteData, typed);
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip h-14 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">Search engines</span>
        <span v-if="runningCount" class="badge badge-success badge-soft badge-xs">{{ runningCount }} running</span>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap overflow-y-auto px-2">
        <li v-for="s in services" :key="s.kind">
          <a :class="{ 'menu-active': s.kind === selectedKind }" @click="selectedKind = s.kind">
            <img :src="LOGO[s.kind]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ s.name }}</div>
              <div class="truncate font-mono text-[11px] opacity-60">
                <template v-if="s.installed">{{ s.config?.version }} · :{{ s.config?.port }}<span v-if="s.update" class="ml-1 font-sans text-warning" :title="`${s.update} available`">· update</span></template>
                <template v-else>Not installed</template>
              </div>
              <div v-if="s.task && !s.task.done" class="mt-1">
                <progress class="progress h-1 w-full" :class="s.task.error ? 'progress-error' : 'progress-primary'" :value="s.task.error ? 100 : s.task.step" :max="s.task.steps.length" />
                <div class="truncate text-[10px]" :class="s.task.error ? 'text-error' : 'opacity-60'">{{ s.task.error ?? s.task.steps[s.task.step] }}</div>
              </div>
            </div>
            <template v-if="s.installed">
              <StatusDot :status="s.status" />
              <button class="btn btn-ghost btn-xs btn-square" :title="active(s) ? 'Stop' : 'Start'" :disabled="!!busy || s.status === 'stopping'" @click.stop="act(s, active(s) ? 'stop' : 'start')">
                <svg v-if="active(s)" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
                <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.9l8-4.9a1 1 0 0 0 0-1.8l-8-4.9Z" /></svg>
              </button>
            </template>
            <span v-else class="badge badge-ghost badge-xs">install</span>
          </a>
        </li>
      </ul>
      <div class="border-t border-base-300/60 p-3 text-xs">
        <span class="label-caps">Sites using search</span>
        <p class="mt-1 opacity-60">{{ searchSites.length ? searchSites.map((p) => p.name).join(', ') : 'none yet' }}</p>
      </div>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <template v-if="selected && !selected.installed">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex items-center gap-3">
            <img :src="LOGO[selected.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0">
              <h2 class="text-lg font-semibold tracking-tight">{{ selected.name }}</h2>
              <div class="text-xs opacity-60">Not installed</div>
            </div>
          </div>
        </header>
        <div class="flex-1 overflow-y-auto p-6">
          <div class="mx-auto max-w-xl space-y-4 pt-6">
            <p class="text-sm opacity-70">{{ selected.description }}</p>
            <TaskStepper v-if="selected.task && !form" :task="selected.task" :cancellable="selected.task.kind === 'install'" dismissable @dismiss="herd.taskDismiss('search', selected.kind)" @cancel="herd.searchCancelInstall(selected.kind)" />
            <button class="btn btn-primary" :disabled="!!selected.task && !selected.task.done && !selected.task.error" @click="form = { service: selected, mode: 'install' }">
              <span v-if="selected.task && !selected.task.done && !selected.task.error" class="loading loading-spinner loading-xs" />Install {{ selected.name }}…
            </button>
            <p class="text-xs opacity-60">
              <template v-if="selected.kind === 'opensearch'">About 300 MB: the core build runs on Eclipse Temurin 21 (no official macOS build).</template>
              <template v-else-if="selected.kind === 'sonic'">Sonic has no macOS download of its own: DevCatz fetches Homebrew's build (checksum from formulae.brew.sh), no Homebrew needed.</template>
              <template v-else>Ports, domain, key and data folder are chosen before the download; the build is checksum-verified.</template>
            </p>
          </div>
        </div>
      </template>

      <template v-else-if="selected?.installed && selected.config && selected.urls">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-3">
          <div class="flex flex-wrap items-center gap-3">
            <img :src="LOGO[selected.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {{ selected.name }}
                <StatusDot :status="selected.status" />
                <span class="badge badge-soft badge-sm" :class="selected.status === 'running' ? 'badge-success' : selected.status === 'starting' ? 'badge-warning' : selected.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ selected.status }}</span>
              </h2>
              <div class="font-mono text-xs opacity-60">{{ selected.config.version }} · 127.0.0.1:{{ selected.config.port }}<template v-if="selected.config.autoStart"> · starts with DevCatz</template></div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button v-if="selected.update" class="btn btn-warning btn-soft btn-sm" :disabled="!!busy || updating(selected)" :title="`${selected.config.version} → ${selected.update}: the data folder and settings stay`" @click="upgrade(selected)">
              <span v-if="updating(selected) || busy === `${selected.kind}:update`" class="loading loading-spinner loading-xs" />Update to {{ selected.update }}
            </button>
            <button v-if="!active(selected)" class="btn btn-primary btn-sm" :disabled="!!busy" @click="act(selected, 'start')">
              <span v-if="busy === `${selected.kind}:start`" class="loading loading-spinner loading-xs" />Start
            </button>
            <button v-else class="btn btn-sm" :disabled="!!busy || selected.status === 'stopping'" @click="act(selected, 'stop')">Stop</button>
            <button class="btn btn-sm" :disabled="!!busy || !active(selected)" @click="act(selected, 'restart')">Restart</button>
            <button v-if="selected.urls.admin" class="btn btn-sm" :disabled="selected.status !== 'running'" @click="herd.openUrl(selected.urls.admin)">Dashboard</button>
            <PopMenu :items="moreItems" align="end" :width="220">
              <button class="btn btn-sm">More ▾</button>
            </PopMenu>
            </div>
          </div>
          <div role="tablist" class="seg no-drag mt-3">
            <a v-for="t in tabs" :key="t" role="tab" class="seg-item" :class="{ 'is-active': tab === t }" @click="tab = t">{{ t }}</a>
          </div>
        </header>

        <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
          <div v-if="selected.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ selected.error }}</div>
          <TaskStepper v-if="selected.task && !form" :task="selected.task" compact dismissable @dismiss="herd.taskDismiss('search', selected.kind)" />
          <a class="url-chip w-full" :title="`127.0.0.1:${selected.config.port} · click to copy`" @click="copy(selected.urls.http)">
            <span class="badge badge-ghost badge-xs font-sans">{{ selected.features.http ? 'API' : 'TCP' }}</span>
            <span class="truncate">{{ selected.urls.http.replace(/^(https|tcp):\/\//, '') }}</span>
            <span class="ml-auto font-sans text-[10px] opacity-60">:{{ selected.config.port }}</span>
          </a>

          <div v-if="selected.status !== 'running' && tab !== 'logs' && tab !== 'connection' && tab !== 'sites'" class="alert alert-soft text-sm">
            {{ selected.name }} is {{ selected.status }}.<template v-if="selected.status === 'starting'"> {{ selected.kind === 'opensearch' ? 'OpenSearch takes 10–20 s to start.' : '' }}</template>
          </div>

          <!-- Indexes -->
          <div v-else-if="tab === 'indexes'" class="space-y-3">
            <div class="overflow-x-auto rounded-box border border-base-300/60">
              <table class="table table-sm">
                <thead>
                  <tr><th>{{ selected.kind === 'typesense' || selected.kind === 'sonic' ? 'Collection' : selected.kind === 'manticore' ? 'Table' : 'Index' }}</th><th class="text-right">Documents</th><th class="text-right">Size</th><th>Primary key</th><th></th></tr>
                </thead>
                <tbody>
                  <tr v-for="i in indexes" :key="i.name">
                    <td class="font-mono">{{ i.name }}</td>
                    <td class="text-right font-mono tabular-nums">{{ i.docs.toLocaleString() }}</td>
                    <td class="text-right font-mono text-xs tabular-nums">{{ size(i.sizeBytes) }}</td>
                    <td class="font-mono text-xs opacity-70">{{ i.primaryKey ?? '—' }}</td>
                    <td class="text-right whitespace-nowrap">
                      <button class="btn btn-ghost btn-xs" @click="searchIn(i.name)">Search</button>
                      <button class="btn btn-ghost btn-xs" @click="openSettings(i.name)">{{ selected.kind === 'manticore' ? 'Schema' : 'Settings' }}</button>
                      <button class="btn btn-ghost btn-xs" @click="importFile(i.name)">Import…</button>
                      <PopMenu :items="exportItems(i.name)" align="end" :width="240">
                        <button class="btn btn-ghost btn-xs">Export ▾</button>
                      </PopMenu>
                      <button class="btn btn-ghost btn-xs text-error" @click="deleting = i.name">Delete</button>
                    </td>
                  </tr>
                  <tr v-if="!indexes.length">
                    <td colspan="5" class="py-5 text-center text-xs opacity-60">{{ loadingIdx ? 'Loading…' : 'No indexes yet.' }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
            <form class="flex flex-wrap items-center gap-2" @submit.prevent="createIndex">
              <input v-model="newName" class="input input-sm w-48 font-mono" placeholder="new index name" spellcheck="false" />
              <input v-if="selected.features.schemaOnCreate" v-model="newSchema" class="input input-sm w-72 font-mono" :placeholder="schemaHint" spellcheck="false" />
              <button class="btn btn-sm" :disabled="!newName.trim()">Create</button>
              <button type="button" class="btn btn-ghost btn-sm" @click="loadIndexes">Refresh</button>
            </form>
            <p class="text-xs opacity-60">
              Import takes JSON (array), NDJSON or CSV (header row).
              <template v-if="selected.kind === 'typesense'"> New collections use an automatic schema (fields typed from the first documents).</template>
              <template v-if="selected.kind === 'manticore'"> Tables need their columns (SQL types: text, string, int, float, bool, json, timestamp).</template>
              <template v-if="selected.kind === 'sonic'"> Sonic indexes each document's text under its id (bucket <code>default</code>); DevCatz keeps the documents next to it so the playground and Export can show them.</template>
              <template v-if="selected.kind === 'zincsearch'"> Field types are detected from the first documents (edit them in Settings → mappings).</template>
            </p>
          </div>

          <SearchPlayground v-else-if="tab === 'search'" :key="selected.kind" :service="selected" :indexes="indexes" :index="playIndex" @changed="loadIndexes" />
          <SearchKeys v-else-if="tab === 'keys'" :key="selected.kind" :service="selected" />
          <SearchTasks v-else-if="tab === 'tasks'" :key="selected.kind + 'tasks'" :service="selected" />
          <SearchBackups v-else-if="tab === 'backups'" :key="selected.kind + 'backups'" :service="selected" />

          <div v-else-if="tab === 'connection'" class="space-y-3">
            <div class="grid gap-2 text-sm sm:grid-cols-2">
              <template v-if="selected.features.http">
                <div><span class="label-caps block">HTTPS (front ends)</span><code class="selectable">{{ selected.urls.http }}</code></div>
                <div><span class="label-caps block">Local (backends)</span><code class="selectable">{{ selected.urls.httpLocal }}</code></div>
              </template>
              <div v-else><span class="label-caps block">Sonic Channel (TCP, backends only)</span><code class="selectable">127.0.0.1:{{ selected.config.port }}</code></div>
              <div v-if="selected.kind === 'zincsearch'"><span class="label-caps block">User</span><code class="selectable">admin</code></div>
              <div v-if="selected.kind === 'zincsearch'"><span class="label-caps block">Elasticsearch API</span><code class="selectable">{{ selected.urls.httpLocal }}/es</code></div>
              <div v-if="selected.fields.key"><span class="label-caps block">{{ selected.fields.key }}</span><code class="selectable">{{ selected.config.key }}</code></div>
              <div v-if="selected.kind === 'manticore'"><span class="label-caps block">SQL (MySQL protocol)</span><code class="selectable">mysql -h127.0.0.1 -P{{ selected.config.extraPort }}</code></div>
              <div v-if="selected.urls.admin"><span class="label-caps block">Dashboard</span><code class="selectable">{{ selected.urls.admin }}</code></div>
              <div><span class="label-caps block">Data folder</span><code class="selectable break-all">{{ selected.config.dataDir }}</code></div>
            </div>
            <div class="rounded-box border border-base-300/60 p-3">
              <div class="mb-2 text-sm font-medium">.env lines for a site</div>
              <SearchEnvWriter :key="selected.kind" :source="selected.kind" :label="selected.name" />
            </div>
          </div>

          <!-- Sites -->
          <div v-else-if="tab === 'sites'" class="space-y-3">
            <div v-if="searchSites.length" class="overflow-x-auto rounded-box border border-base-300/60">
              <table class="table table-sm">
                <thead>
                  <tr><th>Site</th><th>Libraries</th><th>Engine</th><th></th></tr>
                </thead>
                <tbody>
                  <tr v-for="p in searchSites" :key="p.id">
                    <td><div class="flex items-center gap-2"><StatusDot :status="p.served ? 'running' : p.status" /><span class="font-medium">{{ p.name }}</span></div></td>
                    <td>
                      <div class="flex flex-wrap gap-1">
                        <span v-for="l in p.search.libs" :key="l.name" class="badge badge-ghost badge-sm" :title="l.source">{{ l.name }}</span>
                      </div>
                    </td>
                    <td class="text-xs">{{ services.find((s) => s.kind === (p.searchEngine ?? p.search.suggested))?.name ?? '—' }}<template v-if="p.search.scoutDriver"> · SCOUT_DRIVER={{ p.search.scoutDriver }}</template></td>
                    <td class="text-right"><button class="btn btn-ghost btn-xs" @click="emit('openSite', p.id)">Open site</button></td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-else class="text-xs opacity-60">No site uses Laravel Scout or a Meilisearch / Typesense / OpenSearch / Manticore / ZincSearch / Sonic client yet.</p>
            <p class="text-xs opacity-60">Each site's Search Engine tab picks an engine, writes its .env and runs Scout commands.</p>
          </div>

          <div v-else-if="tab === 'logs'" class="min-h-[28rem] flex-1">
            <LogView :key="selected.kind" :project-id="`search:${selected.kind}`" />
          </div>
        </div>
      </template>
    </main>
  </div>

  <SearchForm v-if="form" :service="services.find((x) => x.kind === form!.service.kind) ?? form.service" :mode="form.mode" @close="form = null" @done="form = null" />

  <dialog v-if="settings" open class="modal modal-open" @keydown.esc="settings = null">
    <div class="modal-box w-[44rem] max-w-[95vw] space-y-3">
      <h3 class="font-semibold">{{ settings.editable ? 'Settings' : 'Schema' }} <span class="font-mono font-normal opacity-60">· {{ settings.index }}</span></h3>
      <textarea v-model="settings.text" rows="18" class="textarea textarea-sm w-full font-mono" :readonly="!settings.editable" spellcheck="false" />
      <p class="text-xs opacity-60">
        <template v-if="selected?.kind === 'meilisearch'">e.g. "filterableAttributes", "sortableAttributes", "searchableAttributes", "synonyms", "stopWords", "rankingRules".</template>
        <template v-else-if="selected?.kind === 'typesense'">Add fields (with "facet": true for faceting) or drop one with { "name": …, "drop": true }.</template>
        <template v-else-if="selected?.kind === 'opensearch'">Mappings (new fields) and dynamic settings (replicas, refresh_interval) are saved.</template>
        <template v-else-if="selected?.kind === 'zincsearch'">Mappings (field types: text, keyword, numeric, bool, date; "aggregatable" for facets, "highlightable") and settings.</template>
        <template v-else-if="selected?.kind === 'sonic'">Sonic has nothing to configure per collection.</template>
        <template v-else>Manticore tables change with ALTER TABLE (SQL on port {{ selected?.config?.extraPort }}).</template>
      </p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" @click="settings = null">Close</button>
        <button v-if="settings.editable" class="btn btn-primary btn-sm" @click="saveSettings">Save</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="settings = null" />
  </dialog>

  <dialog v-if="deleting" open class="modal modal-open" @keydown.esc="deleting = null">
    <div class="modal-box w-[26rem] space-y-3">
      <h3 class="text-lg font-semibold">Delete {{ deleting }}?</h3>
      <p class="text-sm opacity-70">All its documents are removed from {{ selected?.name }}. Scout can rebuild it with scout:import.</p>
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" @click="deleting = null">Cancel</button>
        <button class="btn btn-error btn-sm" @click="deleteIndex">Delete</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="deleting = null" />
  </dialog>

  <ServiceUninstall
    v-if="removing?.config"
    :name="removing.name"
    :host="`${removing.config.domain}.${state?.settings.tld ?? 'localhost'}`"
    :data-dir="removing.config.dataDir"
    data-what="All indexes, documents and keys"
    impact="Sites using it lose their search until it is installed again."
    :run="uninstallRun"
    @close="removing = null"
  />
</template>
