<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { ProjectState, SearchIndex, SearchKind } from '@shared/types';
import StatusDot from './StatusDot.vue';
import SearchEnvWriter from './SearchEnvWriter.vue';
import { attempt, herd, navRequest, notify, state } from '../store';
import CatMood from './CatMood.vue';

/**
 * A site's Search Engine tab: the search libraries it uses, the DevCatz
 * engine its .env points at (status, its indexes, Write to .env), and for
 * Laravel Scout the Searchable models with import / flush / sync.
 */
const props = defineProps<{ project: ProjectState }>();
const p = computed(() => props.project);
const info = computed(() => p.value.search);
const engines = computed(() => state.value?.searchEngines ?? []);
const chosen = ref<SearchKind | ''>(p.value.searchEngine ?? info.value.suggested ?? '');
const engine = computed(() => engines.value.find((e) => e.kind === chosen.value) ?? null);
watch(chosen, (k) => k && k !== p.value.searchEngine && void attempt(() => herd.updateProject(p.value.id, { searchEngine: k })));
const fits = (k: SearchKind) => info.value.libs.some((l) => l.engine === k) || info.value.scoutDriver === k;

// The engine's indexes (the site's own are usually prefixed, e.g. SCOUT_PREFIX or the model's table).
const indexes = ref<SearchIndex[]>([]);
async function loadIndexes() {
  indexes.value = engine.value?.status === 'running' ? ((await herd.searchIndexes(engine.value.kind).catch(() => [])) ?? []) : [];
}
watch(() => [chosen.value, engine.value?.status], loadIndexes, { immediate: true });

// ---- Scout
const model = ref(info.value.searchable[0] ?? '');
const running = ref<string | null>(null);
async function scout(command: 'import' | 'flush' | 'sync') {
  running.value = command;
  const out = await attempt(() => herd.scoutCommand(p.value.id, command, command === 'sync' ? null : model.value));
  running.value = null;
  if (out !== undefined) {
    notify('success', out);
    await loadIndexes();
  }
}
const short = (cls: string) => cls.split('\\').pop();
const driverMismatch = computed(() => info.value.scout && engine.value && info.value.scoutDriver && info.value.scoutDriver !== engine.value.kind);
function openEngine() {
  navRequest.value = { section: 'search', id: chosen.value || undefined };
}
</script>

<template>
  <section class="site-tab">
    <div class="card">
      <div class="card-body">
        <h2 class="font-semibold">Search libraries</h2>
        <div class="flex flex-wrap gap-1.5">
          <span v-for="l in info.libs" :key="l.name" class="badge gap-1" :class="l.engine === 'scout' ? 'badge-primary badge-soft' : 'badge-ghost'" :title="`Found in ${l.source}`">{{ l.name }}</span>
        </div>
        <p v-if="info.scout" class="text-xs opacity-70">
          Laravel Scout · driver <code>{{ info.scoutDriver ?? '(not set: SCOUT_DRIVER)' }}</code>
          <template v-if="info.scoutDriver === 'meilisearch' && !info.libs.some((l) => l.engine === 'meilisearch')"> — needs <code>composer require meilisearch/meilisearch-php</code></template>
          <template v-if="info.scoutDriver === 'typesense' && !info.libs.some((l) => l.engine === 'typesense')"> — needs <code>composer require typesense/typesense-php</code></template>
        </p>
      </div>
    </div>

    <!-- Engine -->
    <div class="card">
      <div class="card-body">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot v-if="engine?.installed" :status="engine.status" />
          <h2 class="flex-1 font-semibold">Search engine</h2>
          <select v-model="chosen" class="select select-xs w-48">
            <option value="" disabled>Choose an engine…</option>
            <option v-for="e in engines" :key="e.kind" :value="e.kind">{{ e.name }}{{ e.installed ? '' : ' (not installed)' }}{{ fits(e.kind) ? ' ✓' : '' }}</option>
          </select>
        </div>
        <template v-if="engine">
          <div v-if="!engine.installed" class="flex items-center gap-2 text-sm">
            <span class="flex-1 opacity-70">{{ engine.name }} is not installed yet.</span>
            <button class="btn btn-primary btn-xs" @click="openEngine">Install on the Search page</button>
          </div>
          <template v-else>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <code class="selectable rounded-md bg-base-200/70 px-2 py-1">{{ engine.urls?.http }}</code>
              <span class="opacity-60">{{ engine.status }} · 127.0.0.1:{{ engine.config?.port }}</span>
              <span class="flex-1" />
              <button class="btn btn-ghost btn-xs" @click="openEngine">Indexes &amp; playground</button>
            </div>
            <div v-if="driverMismatch" class="alert alert-warning alert-soft text-xs"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />SCOUT_DRIVER is {{ info.scoutDriver }}; Write to .env switches it to {{ engine.kind }}.</div>
            <SearchEnvWriter :key="p.id + engine.kind" :source="engine.kind" :site-id="p.id" :label="engine.name" />
            <div v-if="indexes.length">
              <span class="label-caps mb-1 block">Indexes on {{ engine.name }}</span>
              <div class="flex flex-wrap gap-1">
                <span v-for="i in indexes" :key="i.name" class="badge badge-ghost badge-sm font-mono">{{ i.name }} · {{ i.docs }}</span>
              </div>
            </div>
          </template>
        </template>
      </div>
    </div>

    <!-- Scout -->
    <div v-if="info.scout" class="card">
      <div class="card-body">
        <h2 class="font-semibold">Laravel Scout</h2>
        <div v-if="info.searchable.length" class="flex flex-wrap items-center gap-2">
          <select v-model="model" class="select select-sm w-64 font-mono">
            <option v-for="m in info.searchable" :key="m" :value="m">{{ short(m) }}</option>
          </select>
          <button class="btn btn-sm" :disabled="!!running" @click="scout('import')"><span v-if="running === 'import'" class="loading loading-spinner loading-xs" />scout:import</button>
          <button class="btn btn-sm btn-ghost text-error" :disabled="!!running" @click="scout('flush')"><span v-if="running === 'flush'" class="loading loading-spinner loading-xs" />scout:flush</button>
          <button class="btn btn-sm btn-ghost" :disabled="!!running" title="Pushes index settings from config/scout.php (filterable / sortable attributes)" @click="scout('sync')">
            <span v-if="running === 'sync'" class="loading loading-spinner loading-xs" />sync-index-settings
          </button>
        </div>
        <p v-else class="text-xs opacity-70">No model uses the <code>Searchable</code> trait yet (app/Models).</p>
        <p class="text-xs opacity-60">Runs with this site's PHP and its .env (write the lines above first); output in the Logs tab.</p>
      </div>
    </div>
  </section>
</template>
