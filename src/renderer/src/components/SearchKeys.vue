<script setup lang="ts">
import { onMounted, ref } from 'vue';
import type { SearchKey, SearchState } from '@shared/types';
import { attempt, herd, notify } from '../store';
import CatMood from './CatMood.vue';

/** API keys of Meilisearch / Typesense: list, create scoped keys (a search-only key for front ends), delete. */
const props = defineProps<{ service: SearchState }>();
const keys = ref<SearchKey[]>([]);
const loading = ref(false);
async function load() {
  loading.value = true;
  keys.value = (await attempt(() => herd.searchKeys(props.service.kind))) ?? [];
  loading.value = false;
}
onMounted(load);

const PRESETS: Record<string, { label: string; actions: string[] }[]> = {
  meilisearch: [
    { label: 'Search only', actions: ['search'] },
    { label: 'Documents', actions: ['documents.*', 'search'] },
    { label: 'Indexes + documents', actions: ['indexes.*', 'documents.*', 'settings.*', 'tasks.get', 'search'] },
    { label: 'Everything', actions: ['*'] },
  ],
  typesense: [
    { label: 'Search only', actions: ['documents:search'] },
    { label: 'Documents', actions: ['documents:*'] },
    { label: 'Collections + documents', actions: ['collections:*', 'documents:*'] },
    { label: 'Everything', actions: ['*'] },
  ],
};
const presets = PRESETS[props.service.kind] ?? [];
const name = ref('Front end (search only)');
const preset = ref(0);
const indexes = ref('*');
const expires = ref('');
const created = ref<SearchKey | null>(null);

async function create() {
  const k = await attempt(() =>
    herd.searchCreateKey(
      props.service.kind,
      name.value.trim(),
      presets[preset.value].actions,
      indexes.value.split(',').map((s) => s.trim()).filter(Boolean),
      expires.value ? new Date(`${expires.value}T23:59:59`).toISOString() : null,
    ),
  );
  if (!k) return;
  created.value = k;
  await load();
}
async function remove(k: SearchKey) {
  if (await attempt(() => herd.searchDeleteKey(props.service.kind, k.id).then(() => true))) {
    notify('success', `Key ${k.name ?? k.id} deleted`);
    await load();
  }
}
async function copy(v: string) {
  await navigator.clipboard.writeText(v);
  notify('info', 'Key copied');
}
</script>

<template>
  <div class="space-y-3">
    <div class="overflow-x-auto rounded-box border border-base-300/60">
      <table class="table table-sm">
        <thead>
          <tr><th>Name</th><th>Key</th><th>Actions</th><th>Indexes</th><th>Expires</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="k in keys" :key="k.id">
            <td class="text-sm">{{ k.name ?? '—' }}</td>
            <td>
              <button class="font-mono text-xs opacity-80 hover:opacity-100" :title="service.kind === 'typesense' ? 'Typesense shows only the prefix after creation' : 'Copy'" @click="copy(k.value)">
                {{ k.value.length > 18 ? `${k.value.slice(0, 14)}…` : k.value }}
              </button>
            </td>
            <td><div class="flex flex-wrap gap-1"><span v-for="a in k.actions" :key="a" class="badge badge-ghost badge-xs font-mono">{{ a }}</span></div></td>
            <td class="font-mono text-xs">{{ k.indexes.join(', ') }}</td>
            <td class="text-xs opacity-70">{{ k.expiresAt ? new Date(k.expiresAt).toLocaleDateString() : 'never' }}</td>
            <td class="text-right"><button class="btn btn-ghost btn-xs text-error" @click="remove(k)">Delete</button></td>
          </tr>
          <tr v-if="!keys.length && !loading"><td colspan="6" class="py-4 text-center text-xs opacity-60">No keys.</td></tr>
        </tbody>
      </table>
    </div>

    <div class="space-y-2 rounded-box border border-base-300/60 p-3">
      <div class="text-sm font-medium">New key</div>
      <div class="flex flex-wrap items-center gap-2">
        <input v-model="name" class="input input-sm w-56" placeholder="Name" />
        <select v-model.number="preset" class="select select-sm w-52">
          <option v-for="(p, i) in presets" :key="p.label" :value="i">{{ p.label }}</option>
        </select>
        <input v-model="indexes" class="input input-sm w-40 font-mono" placeholder="indexes: * or a, b" spellcheck="false" />
        <input v-model="expires" type="date" class="input input-sm w-40" title="Expires (optional)" />
        <button class="btn btn-primary btn-sm" @click="create">Create</button>
      </div>
      <div v-if="created" class="alert alert-success alert-soft text-sm"><CatMood mood="success" class="size-7 shrink-0 -my-0.5" />
        <div class="min-w-0 flex-1">
          <div>Key <b>{{ created.name }}</b> created{{ service.kind === 'typesense' ? ' — copy it now, Typesense will not show it again' : '' }}:</div>
          <code class="selectable break-all">{{ created.value }}</code>
        </div>
        <button class="btn btn-xs" @click="copy(created.value)">Copy</button>
      </div>
      <p class="text-xs opacity-60">A search-only key can go into front-end code (VITE_*); the {{ service.fields.key?.toLowerCase() }} stays on the server.</p>
    </div>
  </div>
</template>
