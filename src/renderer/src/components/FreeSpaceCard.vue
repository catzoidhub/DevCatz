<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import type { SiteDeps } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import CatMood from './CatMood.vue';
import { attempt, freeSpaceRequest, herd } from '../store';
import { bytes } from '../monitor';
import { ago } from '../depsize';

/**
 * Site Settings → Free up space (TODO §30): the site's dependency folders (node_modules, vendor, .venv) with their
 * size; tick and move them to the Trash on an old project. "Install dependencies" brings them back.
 */
const props = defineProps<{ siteId: string; running: boolean }>();
const info = ref<SiteDeps | null>(null);
const loading = ref(false);
const picked = ref<string[]>([]);
const asking = ref(false);
const busy = ref(false);

async function load(fresh = false) {
  loading.value = true;
  const r = await attempt(() => herd.siteDeps(props.siteId, fresh));
  loading.value = false;
  if (!r) return;
  info.value = r;
  picked.value = r.folders.map((f) => f.path);
}
onMounted(() => load());

// Monitor → Dependencies sent us here: bring the card into view and flash it.
const card = ref<HTMLElement | null>(null);
const flash = ref(false);
watch(
  [freeSpaceRequest, card],
  async ([id, el]) => {
    if (!id || id !== props.siteId || !el) return;
    freeSpaceRequest.value = null;
    await nextTick();
    setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'center' }), 120);
    flash.value = true;
    setTimeout(() => (flash.value = false), 1800);
  },
  { immediate: true },
);
watch(() => props.siteId, () => load());

const pickedBytes = computed(() => (info.value?.folders ?? []).filter((f) => picked.value.includes(f.path)).reduce((n, f) => n + f.bytes, 0));
function toggle(path: string, on: boolean) {
  picked.value = on ? [...picked.value, path] : picked.value.filter((x) => x !== path);
}
async function free() {
  busy.value = true;
  const freed = await attempt(() => herd.freeDeps(props.siteId, [...picked.value]));
  busy.value = false;
  asking.value = false;
  if (freed !== undefined && freed !== null) await load(true);
}
</script>

<template>
  <div ref="card" class="card transition-shadow duration-500" :class="{ 'ring-2 ring-primary/70': flash }">
    <div class="card-body gap-3 p-4">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Free up space</h2>
        <span v-if="info" class="text-xs opacity-60">· {{ info.lastUsed ? `last used ${ago(info.lastUsed)}` : 'never started here' }}</span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs" :disabled="loading" title="Measure again" @click="load(true)">
          <span v-if="loading" class="loading loading-spinner loading-xs" />Refresh
        </button>
      </div>
      <p class="text-xs opacity-60">Dependency folders can be thrown away on a project you are not working on and installed again any time with <b>Install dependencies</b>. They go to the {{ words.trash }}, so they can be put back.</p>

      <div v-if="loading && !info" class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Measuring…</div>
      <div v-else-if="info && !info.folders.length" class="flex items-center gap-3 text-sm opacity-70">
        <CatMood mood="success" class="size-8 shrink-0" />No dependency folders: nothing to free here.
      </div>
      <template v-else-if="info">
        <label v-for="f in info.folders" :key="f.path" class="flex cursor-pointer items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
          <input type="checkbox" class="checkbox checkbox-sm" :checked="picked.includes(f.path)" :disabled="running" @change="toggle(f.path, ($event.target as HTMLInputElement).checked)" />
          <code class="min-w-0 flex-1 truncate text-xs">{{ f.path }}</code>
          <span class="badge badge-ghost badge-sm">{{ f.kind === 'venv' ? 'Python venv' : f.kind === 'vendor' ? 'Composer' : f.kind === 'target' ? 'Cargo build' : 'npm / bun' }}</span>
          <span class="w-20 text-right font-mono text-sm tabular-nums">{{ bytes(f.bytes) }}</span>
        </label>
        <div class="flex items-center gap-3 pt-1">
          <span class="text-sm">Total <b class="font-mono">{{ bytes(info.bytes) }}</b></span>
          <span class="flex-1" />
          <span v-if="running" class="text-xs opacity-60">Stop the site first</span>
          <button class="btn btn-error btn-outline btn-sm" :disabled="running || !picked.length" @click="asking = true">Move {{ bytes(pickedBytes) }} to the {{ words.trash }}…</button>
        </div>
      </template>
    </div>
    <ConfirmDialog
      v-if="asking && info"
      :title="`Free ${bytes(pickedBytes)} from ${info.name}?`"
      :text="`These folders go to the ${words.trash}. The project files are not touched; Install dependencies brings them back.`"
      :confirm="`Move to ${words.trash}`"
      tone="error"
      :busy="busy"
      @ok="free"
      @cancel="asking = false"
    >
      <ul class="space-y-1 rounded-box bg-base-200/60 p-3 text-xs">
        <li v-for="f in info.folders.filter((x) => picked.includes(x.path))" :key="f.path" class="flex gap-3">
          <code class="min-w-0 flex-1 truncate">{{ f.path }}</code><span class="font-mono">{{ bytes(f.bytes) }}</span>
        </li>
      </ul>
    </ConfirmDialog>
  </div>
</template>
