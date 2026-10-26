<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AiSearchAnswer, AiTurn, SearchIndex, SearchResult, SearchState } from '@shared/types';
import { attempt, herd, notify } from '../store';
import AiBox from './AiBox.vue';
import { aiOn, plain } from '../ai';
import CatMood from './CatMood.vue';

/**
 * Search playground of one engine: query with filter, sort and facets,
 * highlighted results, facet counts, and documents viewed, edited (upsert)
 * or deleted. Each engine's own filter / sort syntax is passed through.
 */
const props = defineProps<{ service: SearchState; indexes: SearchIndex[]; index: string }>();
const emit = defineEmits<{ changed: [] }>();

const current = ref(props.index || props.indexes[0]?.name || '');
watch(
  () => props.index,
  (i) => i && (current.value = i),
);
watch(
  () => props.indexes,
  (l) => !l.some((i) => i.name === current.value) && (current.value = l[0]?.name ?? ''),
);
const q = ref('');
const filter = ref('');
const sort = ref('');
const facets = ref('');

// ✦ Ask AI: plain words → the engine's query, filter and sort, filled in and run (follow-ups keep the thread).
const aiSearchOn = aiOn('search');
const aiOpen = ref(false);
const aiHistory = ref<AiTurn[]>([]);
const aiReq = (prompt: string) => ({ kind: props.service.kind, index: current.value, prompt, history: plain(aiHistory.value) });
const aiRun = (prompt: string, token: string) => herd.aiSearch(aiReq(prompt), token).then((a) => (aiHistory.value = [...aiHistory.value, { role: 'user', text: prompt }, { role: 'assistant', text: JSON.stringify(a) }], a));
const aiPreview = (prompt: string) => herd.aiPreviewSearch(aiReq(prompt));
function aiApply(a: AiSearchAnswer) {
  q.value = a.query;
  filter.value = a.filter;
  sort.value = a.sort;
  void run();
}
const limit = ref(20);
const page = ref(0);
const result = ref<SearchResult | null>(null);
const error = ref('');
const busy = ref(false);

const SYNTAX: Record<SearchState['kind'], { filter: string; sort: string; facets: string }> = {
  meilisearch: { filter: 'genre = horror AND year > 2000', sort: 'year:desc', facets: 'genre, year' },
  typesense: { filter: 'year:>2000 && genre:=horror', sort: 'year:desc', facets: 'genre' },
  opensearch: { filter: 'genre:horror AND year:>2000', sort: 'year:desc', facets: 'genre.keyword' },
  manticore: { filter: 'year > 2000', sort: 'year DESC', facets: 'genre' },
  zincsearch: { filter: 'genre:horror AND year:>2000', sort: 'year:desc', facets: 'genre' },
  sonic: { filter: '', sort: '', facets: '' },
};
const hint = computed(() => SYNTAX[props.service.kind]);

let timer: ReturnType<typeof setTimeout> | null = null;
async function run() {
  if (!current.value) return;
  busy.value = true;
  error.value = '';
  try {
    result.value = await herd.searchQuery(props.service.kind, {
      index: current.value,
      q: q.value,
      filter: filter.value,
      sort: sort.value,
      facets: facets.value.split(',').map((f) => f.trim()).filter(Boolean),
      limit: limit.value,
      offset: page.value * limit.value,
    });
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    result.value = null;
  } finally {
    busy.value = false;
  }
}
// Search as you type (debounced); other fields on Enter / the button.
watch(q, () => {
  page.value = 0;
  if (timer) clearTimeout(timer);
  timer = setTimeout(run, 250);
});
watch(current, () => {
  page.value = 0;
  void run();
}, { immediate: true });
const pages = computed(() => (result.value ? Math.max(1, Math.ceil(result.value.total / limit.value)) : 1));

const open = ref<string | null>(null);
const editing = ref<{ id: string | null; text: string } | null>(null);
function edit(doc: Record<string, unknown> | null, id: string | null) {
  editing.value = { id, text: JSON.stringify(doc ?? { id: '', title: '' }, null, 2) };
}
async function save() {
  if (!editing.value) return;
  const n = await attempt(() => herd.searchUpsert(props.service.kind, current.value, editing.value!.text));
  if (n === undefined) return;
  notify('success', `${n} document${n === 1 ? '' : 's'} saved`);
  editing.value = null;
  emit('changed');
  await run();
}
async function remove(id: string) {
  if (!(await attempt(() => herd.searchDeleteDoc(props.service.kind, current.value, id).then(() => true)))) return;
  notify('success', `Document ${id} deleted`);
  emit('changed');
  await run();
}
/** Highlight HTML from the main process carries only <mark>/<em>/<b>; everything else is escaped here. */
const safe = (html: string) => html.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/&lt;(\/?(mark|em|b))>/g, '<$1>');
const preview = (doc: Record<string, unknown>) =>
  Object.entries(doc)
    .filter(([, v]) => v !== null && typeof v !== 'object')
    .slice(0, 4)
    .map(([k, v]) => `${k}: ${String(v).slice(0, 80)}`)
    .join(' · ');
</script>

<template>
  <div class="space-y-3">
    <div v-if="!indexes.length" class="text-sm opacity-60">No indexes yet: create one on the Indexes tab.</div>
    <template v-else>
      <div class="flex flex-wrap items-center gap-2">
        <select v-model="current" class="select select-sm w-48 font-mono">
          <option v-for="i in indexes" :key="i.name" :value="i.name">{{ i.name }} ({{ i.docs }})</option>
        </select>
        <label class="search-box min-w-0 flex-1">
          <svg class="size-3.5 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>
          <input v-model="q" type="text" placeholder="Search…" spellcheck="false" />
        </label>
        <button class="btn btn-sm" @click="edit(null, null)">Add document</button>
        <button v-if="aiSearchOn && !aiOpen" class="btn btn-sm" title="Describe what to find; the query, filter and sort are filled in" @click="aiOpen = true">✦ Ask AI</button>
      </div>
      <AiBox v-if="aiOpen" :key="current" :run="aiRun" :preview="aiPreview" action="Search" placeholder="e.g. “dramas after 2010, newest first”" busy-text="Writing the search…" @answer="(a) => aiApply(a as AiSearchAnswer)" @close="(aiOpen = false), (aiHistory = [])">
        <template #default="{ answer }">
          <p class="text-xs opacity-80">{{ (answer as AiSearchAnswer).explanation }}</p>
        </template>
      </AiBox>
      <div v-if="service.features.filters" class="grid gap-2 sm:grid-cols-[1fr_10rem_12rem_5rem]">
        <input v-model="filter" class="input input-sm font-mono" :placeholder="`Filter: ${hint.filter}`" spellcheck="false" @keydown.enter="run" />
        <input v-model="sort" class="input input-sm font-mono" :placeholder="`Sort: ${hint.sort}`" spellcheck="false" @keydown.enter="run" />
        <input v-model="facets" class="input input-sm font-mono" :placeholder="`Facets: ${hint.facets}`" spellcheck="false" @keydown.enter="run" />
        <select v-model.number="limit" class="select select-sm" @change="run">
          <option v-for="n in [10, 20, 50, 100]" :key="n" :value="n">{{ n }}</option>
        </select>
      </div>
      <p v-if="service.kind === 'meilisearch'" class="text-xs opacity-60">Meilisearch filters and sorts only on attributes listed as filterable / sortable (Indexes → Settings).</p>
      <p v-else-if="service.kind === 'sonic'" class="text-xs opacity-60">
        Sonic ranks ids for words (typo-tolerant once its word graph is rebuilt, a few seconds after an import): no filters, sorting or facets. The documents shown come
        from DevCatz's copy next to Sonic.
      </p>

      <div v-if="error" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ error }}</div>
      <template v-else-if="result">
        <div class="flex items-center gap-2 text-xs opacity-70">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          <span>{{ result.total }} hit{{ result.total === 1 ? '' : 's' }}<template v-if="result.ms !== null"> · {{ result.ms }} ms</template></span>
          <span class="flex-1" />
          <button class="btn btn-ghost btn-xs" :disabled="page === 0" @click="(page--, run())">‹</button>
          <span>{{ page + 1 }} / {{ pages }}</span>
          <button class="btn btn-ghost btn-xs" :disabled="page + 1 >= pages" @click="(page++, run())">›</button>
        </div>
        <div v-if="Object.keys(result.facets).length" class="flex flex-wrap gap-3 rounded-box bg-base-200/50 p-2 text-xs">
          <div v-for="(counts, field) in result.facets" :key="field">
            <span class="label-caps">{{ field }}</span>
            <span v-for="(n, value) in counts" :key="value" class="badge badge-ghost badge-sm ml-1 font-mono">{{ value }} · {{ n }}</span>
          </div>
        </div>
        <div class="divide-y divide-base-300/50 rounded-box border border-base-300/60">
          <div v-for="h in result.hits" :key="h.id" class="p-2.5">
            <div class="flex items-start gap-2">
              <code class="shrink-0 text-xs opacity-60">#{{ h.id }}</code>
              <div class="min-w-0 flex-1 text-sm">
                <template v-if="Object.keys(h.highlight).length">
                  <!-- eslint-disable-next-line vue/no-v-html -->
                  <div v-for="(html, field) in h.highlight" :key="field" class="search-hl truncate"><span class="text-xs opacity-50">{{ field }}:</span> <span v-html="safe(html)" /></div>
                </template>
                <div v-else class="truncate text-xs opacity-80">{{ preview(h.doc) }}</div>
              </div>
              <button class="btn btn-ghost btn-xs" @click="open = open === h.id ? null : h.id">{{ open === h.id ? 'Hide' : 'JSON' }}</button>
              <button class="btn btn-ghost btn-xs" @click="edit(h.doc, h.id)">Edit</button>
              <button class="btn btn-ghost btn-xs text-error" @click="remove(h.id)">Delete</button>
            </div>
            <pre v-if="open === h.id" class="selectable mt-2 max-h-72 overflow-auto rounded-md bg-base-200/70 p-2 font-mono text-xs">{{ JSON.stringify(h.doc, null, 2) }}</pre>
          </div>
          <div v-if="!result.hits.length" class="p-5 text-center text-xs opacity-60">No hits.</div>
        </div>
      </template>
    </template>

    <dialog v-if="editing" open class="modal modal-open" @keydown.esc="editing = null">
      <div class="modal-box w-[40rem] max-w-[95vw] space-y-3">
        <h3 class="font-semibold">{{ editing.id ? `Edit #${editing.id}` : 'Add documents' }} <span class="font-normal opacity-60">· {{ current }}</span></h3>
        <textarea v-model="editing.text" rows="14" class="textarea textarea-sm w-full font-mono" spellcheck="false" />
        <p class="text-xs opacity-60">One object, a JSON array or NDJSON; saved as add-or-replace by id{{ service.kind === 'manticore' ? ' (numeric ids)' : '' }}.</p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="editing = null">Cancel</button>
          <button class="btn btn-primary btn-sm" @click="save">Save</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="editing = null" />
    </dialog>
  </div>
</template>

<style scoped>
.search-hl :deep(mark),
.search-hl :deep(em),
.search-hl :deep(b) {
  background: color-mix(in oklch, var(--c-search) 30%, transparent);
  color: inherit;
  border-radius: 3px;
  padding: 0 1px;
  font-style: normal;
}
</style>
