<script setup lang="ts">
import { ref } from 'vue';
import type { SearchBackup, SearchState } from '@shared/types';
import { attempt, herd, notify } from '../store';

/**
 * Meilisearch backups: dumps (portable across versions, re-indexed on import)
 * and snapshots (an exact copy of the database, same version only), created
 * through the API into the data folder; restore, show in Finder, delete.
 */
const props = defineProps<{ service: SearchState }>();

const list = ref<SearchBackup[]>([]);
const busy = ref<string | null>(null);
async function load() {
  list.value = (await herd.searchBackups(props.service.kind).catch(() => [])) ?? [];
}
void load();

async function create(type: 'dump' | 'snapshot') {
  busy.value = type;
  const ok = await attempt(() => herd.searchCreateBackup(props.service.kind, type).then(() => true));
  busy.value = null;
  if (ok) notify('success', type === 'dump' ? 'Dump created' : 'Snapshot created');
  await load();
}
const restoring = ref<SearchBackup | null>(null);
async function restore() {
  const b = restoring.value!;
  restoring.value = null;
  busy.value = 'restore';
  const ok = await attempt(() => herd.searchRestoreBackup(props.service.kind, b.file).then(() => true));
  busy.value = null;
  if (ok) notify('success', `Restoring ${b.name}: Meilisearch imports it while starting`);
}
const deleting = ref<SearchBackup | null>(null);
async function remove() {
  const b = deleting.value!;
  deleting.value = null;
  if (await attempt(() => herd.searchDeleteBackup(props.service.kind, b.file).then(() => true))) await load();
}
const size = (n: number) => (n > 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <button class="btn btn-primary btn-sm" :disabled="!!busy || service.status !== 'running'" @click="create('dump')">
        <span v-if="busy === 'dump'" class="loading loading-spinner loading-xs" />Create dump
      </button>
      <button class="btn btn-sm" :disabled="!!busy || service.status !== 'running'" @click="create('snapshot')">
        <span v-if="busy === 'snapshot'" class="loading loading-spinner loading-xs" />Create snapshot
      </button>
      <span class="flex-1" />
      <button class="btn btn-ghost btn-sm" @click="load">Refresh</button>
    </div>
    <div class="overflow-x-auto rounded-box border border-base-300/60">
      <table class="table table-sm">
        <thead>
          <tr><th>File</th><th>Type</th><th class="text-right">Size</th><th>Created</th><th></th></tr>
        </thead>
        <tbody>
          <tr v-for="b in list" :key="b.file">
            <td class="font-mono text-xs">{{ b.name }}</td>
            <td><span class="badge badge-ghost badge-sm">{{ b.kind }}</span></td>
            <td class="text-right font-mono text-xs tabular-nums">{{ size(b.sizeBytes) }}</td>
            <td class="text-xs">{{ new Date(b.createdAt).toLocaleString() }}</td>
            <td class="text-right whitespace-nowrap">
              <button class="btn btn-ghost btn-xs" :disabled="!!busy" @click="restoring = b">Restore…</button>
              <button class="btn btn-ghost btn-xs" @click="herd.searchRevealBackup(service.kind, b.file)">Show in Finder</button>
              <button class="btn btn-ghost btn-xs text-error" @click="deleting = b">Delete</button>
            </td>
          </tr>
          <tr v-if="!list.length">
            <td colspan="5" class="py-5 text-center text-xs opacity-60">No dumps or snapshots yet.</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p class="text-xs opacity-60">
      <b>Dump</b>: documents, settings and keys in a portable file (works across Meilisearch versions; indexes are rebuilt on import). <b>Snapshot</b>: an exact copy of
      the database (fast to restore, same Meilisearch version). Both are saved in the data folder.
    </p>

    <dialog v-if="restoring" open class="modal modal-open" @keydown.esc="restoring = null">
      <div class="modal-box w-[28rem] space-y-3">
        <h3 class="text-lg font-semibold">Restore {{ restoring.name }}?</h3>
        <p class="text-sm opacity-70">
          Meilisearch stops, the current database is moved aside (<code>data.ms.before-restore-…</code> in the data folder, nothing is deleted) and it starts again with
          this {{ restoring.kind }} imported. Large dumps take a while to index.
        </p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="restoring = null">Cancel</button>
          <button class="btn btn-warning btn-sm" @click="restore">Restore</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="restoring = null" />
    </dialog>
    <dialog v-if="deleting" open class="modal modal-open" @keydown.esc="deleting = null">
      <div class="modal-box w-[26rem] space-y-3">
        <h3 class="text-lg font-semibold">Delete {{ deleting.name }}?</h3>
        <p class="text-sm opacity-70">The file is removed from the data folder.</p>
        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" @click="deleting = null">Cancel</button>
          <button class="btn btn-error btn-sm" @click="remove">Delete</button>
        </div>
      </div>
      <div class="modal-backdrop" @click="deleting = null" />
    </dialog>
  </div>
</template>
