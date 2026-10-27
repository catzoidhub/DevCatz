<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, onMounted, ref } from 'vue';
import type { SiteDeps } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import CatMood from './CatMood.vue';
import { attempt, freeSpaceRequest, herd, notify, openSiteRequest, siteTabRequest } from '../store';
import { bytes } from '../monitor';
import { ago, daysSince } from '../depsize';

/**
 * Monitoring → Dependencies (TODO §30): every site's node_modules / vendor / .venv, largest first, with when it
 * was last used; pick the old ones and move their dependency folders to the Trash in one go. Running sites are
 * left out of the selection.
 */
const report = ref<SiteDeps[] | null>(null);
const loading = ref(false);
const age = ref<0 | 30 | 90>(0);
const picked = ref<string[]>([]);
const asking = ref(false);
const busy = ref(false);

async function load(fresh = false) {
  loading.value = true;
  const r = await attempt(() => herd.depsReport(fresh));
  loading.value = false;
  if (r) report.value = r;
}
onMounted(() => load());

const rows = computed(() => (report.value ?? []).filter((r) => r.bytes > 0 && daysSince(r.lastUsed) >= age.value));
const total = computed(() => rows.value.reduce((n, r) => n + r.bytes, 0));
const selectable = computed(() => rows.value.filter((r) => !r.running));
const pickedRows = computed(() => rows.value.filter((r) => picked.value.includes(r.siteId) && !r.running));
const pickedBytes = computed(() => pickedRows.value.reduce((n, r) => n + r.bytes, 0));
const allPicked = computed(() => selectable.value.length > 0 && selectable.value.every((r) => picked.value.includes(r.siteId)));
function toggle(id: string, on: boolean) {
  picked.value = on ? [...picked.value, id] : picked.value.filter((x) => x !== id);
}
function toggleAll(on: boolean) {
  picked.value = on ? selectable.value.map((r) => r.siteId) : [];
}
/** The site's Settings tab, scrolled to its Free up space card (remove node_modules / vendor there). */
function openSite(id: string) {
  openSiteRequest.value = id;
  siteTabRequest.value = { id, tab: 'settings' };
  freeSpaceRequest.value = id;
}
async function free() {
  busy.value = true;
  let freed = 0;
  for (const r of pickedRows.value) {
    const n = await attempt(() => herd.freeDeps(r.siteId, r.folders.map((f) => f.path)));
    if (typeof n === 'number') freed += n;
  }
  busy.value = false;
  asking.value = false;
  picked.value = [];
  if (freed) notify('success', `Freed ${bytes(freed)}: moved to the ${words.trash}`);
  await load(true);
}
</script>

<template>
  <div class="card">
    <div class="card-body gap-3 p-4">
      <div class="flex flex-wrap items-center gap-2">
        <h2 class="font-semibold">Dependencies</h2>
        <span v-if="report" class="text-xs opacity-60">· {{ bytes(total) }} in {{ rows.length }} site{{ rows.length === 1 ? '' : 's' }}</span>
        <span class="flex-1" />
        <div role="tablist" class="seg">
          <button v-for="d in [0, 30, 90] as const" :key="d" role="tab" class="seg-item" :class="{ 'is-active': age === d }" @click="age = d">{{ d ? `Not used for ${d} days` : 'All' }}</button>
        </div>
        <button class="btn btn-ghost btn-xs" :disabled="loading" title="Measure every site again" @click="load(true)">
          <span v-if="loading" class="loading loading-spinner loading-xs" />Refresh
        </button>
      </div>
      <p class="text-xs opacity-60">node_modules, Composer's vendor/ and Python venvs of your sites. On projects you are not working on they can go to the {{ words.trash }}; <b>Install dependencies</b> brings them back.</p>

      <div v-if="!report" class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Measuring every site…</div>
      <div v-else-if="!rows.length" class="flex items-center gap-3 text-sm opacity-70">
        <CatMood mood="success" class="size-8 shrink-0" />{{ age ? `No site with dependencies left unused for ${age} days.` : 'No dependency folders.' }}
      </div>
      <template v-else>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr>
                <th class="w-8"><input type="checkbox" class="checkbox checkbox-xs" :checked="allPicked" :disabled="!selectable.length" aria-label="Select every stopped site" @change="toggleAll(($event.target as HTMLInputElement).checked)" /></th>
                <th>Site</th>
                <th>Folders</th>
                <th>Last used</th>
                <th class="text-right">Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="r in rows" :key="r.siteId" :class="{ 'opacity-60': r.running }">
                <td><input type="checkbox" class="checkbox checkbox-xs" :checked="picked.includes(r.siteId)" :disabled="r.running" :title="r.running ? 'Running: stop it first' : ''" @change="toggle(r.siteId, ($event.target as HTMLInputElement).checked)" /></td>
                <td class="font-medium">
                  <button class="link link-hover text-left font-medium" :title="`Open ${r.name} → Settings → Free up space`" @click="openSite(r.siteId)">{{ r.name }}</button>
                  <span v-if="r.running" class="badge badge-soft badge-success badge-xs ml-2">running</span>
                </td>
                <td><code class="text-xs opacity-70">{{ r.folders.map((f) => f.path).join(', ') }}</code></td>
                <td class="text-xs whitespace-nowrap opacity-70">{{ r.lastUsed ? ago(r.lastUsed) : '—' }}</td>
                <td class="text-right font-mono tabular-nums">{{ bytes(r.bytes) }}</td>
                <td class="w-8 text-right">
                  <button class="btn btn-ghost btn-xs btn-square" :title="`Free up space in ${r.name} (its Settings)`" :aria-label="`Open ${r.name} settings`" @click="openSite(r.siteId)">
                    <svg viewBox="0 0 20 20" fill="currentColor" class="size-3.5"><path d="M4 10h9.2L9.6 6.4l1-1L16 10.8l-5.4 5.4-1-1 3.6-3.6H4V10Z" /></svg>
                  </button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex items-center gap-3">
          <span class="text-xs opacity-60">{{ pickedRows.length }} selected</span>
          <span class="flex-1" />
          <button class="btn btn-error btn-outline btn-sm" :disabled="!pickedRows.length" @click="asking = true">Move {{ bytes(pickedBytes) }} to the {{ words.trash }}…</button>
        </div>
      </template>
    </div>
    <ConfirmDialog
      v-if="asking"
      :title="`Free ${bytes(pickedBytes)} from ${pickedRows.length} site${pickedRows.length === 1 ? '' : 's'}?`"
      :text="`Their dependency folders go to the ${words.trash}. Project files are not touched; Install dependencies on a site brings them back.`"
      :confirm="`Move to ${words.trash}`"
      tone="error"
      :busy="busy"
      @ok="free"
      @cancel="asking = false"
    >
      <ul class="max-h-48 space-y-1 overflow-y-auto rounded-box bg-base-200/60 p-3 text-xs">
        <li v-for="r in pickedRows" :key="r.siteId" class="flex gap-3">
          <span class="min-w-0 flex-1 truncate"><b>{{ r.name }}</b> · <code>{{ r.folders.map((f) => f.path).join(', ') }}</code></span><span class="font-mono">{{ bytes(r.bytes) }}</span>
        </li>
      </ul>
    </ConfirmDialog>
  </div>
</template>
