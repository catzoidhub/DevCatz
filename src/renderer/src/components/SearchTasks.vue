<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { SearchState, SearchTask } from '@shared/types';
import { attempt, herd, notify } from '../store';

/**
 * Meilisearch task queue: every indexing / settings / delete job with its
 * status, duration and error; filter by status, cancel queued or running
 * tasks, clear finished ones. Refreshes every 2 s while something is queued.
 */
const props = defineProps<{ service: SearchState }>();

const STATUSES = ['', 'enqueued,processing', 'succeeded', 'failed', 'canceled'] as const;
const LABEL: Record<string, string> = { '': 'All', 'enqueued,processing': 'Queued / running', succeeded: 'Succeeded', failed: 'Failed', canceled: 'Canceled' };
const status = ref<string>('');
const tasks = ref<SearchTask[]>([]);
const next = ref<number | null>(null);
const loading = ref(false);
const open = ref<number | null>(null);

async function load(more = false) {
  loading.value = true;
  const r = await herd.searchTasks(props.service.kind, status.value, more ? next.value : null).catch(() => null);
  loading.value = false;
  if (!r) return;
  tasks.value = more ? [...tasks.value, ...r.tasks] : r.tasks;
  next.value = r.next;
}
watch(status, () => load(), { immediate: true });
const pending = computed(() => tasks.value.some((t) => t.status === 'enqueued' || t.status === 'processing'));
let timer: ReturnType<typeof setInterval> | null = setInterval(() => pending.value && load(), 2000);
onBeforeUnmount(() => timer && clearInterval(timer));

async function cancel(uids: number[]) {
  if (await attempt(() => herd.searchCancelTasks(props.service.kind, uids).then(() => true))) {
    notify('success', uids.length ? `Task ${uids[0]} canceled` : 'Queued tasks canceled');
    await load();
  }
}
async function clear() {
  if (await attempt(() => herd.searchClearTasks(props.service.kind).then(() => true))) {
    notify('success', 'Finished tasks cleared');
    await load();
  }
}
const BADGE: Record<SearchTask['status'], string> = {
  enqueued: 'badge-ghost',
  processing: 'badge-warning',
  succeeded: 'badge-success',
  failed: 'badge-error',
  canceled: 'badge-neutral',
};
const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dur = (ms: number | null) => (ms === null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(1)} s`);
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <div role="tablist" class="seg">
        <a v-for="s in STATUSES" :key="s" role="tab" class="seg-item" :class="{ 'is-active': status === s }" @click="status = s">{{ LABEL[s] }}</a>
      </div>
      <span class="flex-1" />
      <span v-if="loading" class="loading loading-spinner loading-xs" />
      <button class="btn btn-ghost btn-sm" @click="load()">Refresh</button>
      <button class="btn btn-sm" :disabled="!pending" @click="cancel([])">Cancel queued</button>
      <button class="btn btn-sm" @click="clear">Clear finished</button>
    </div>
    <div class="overflow-x-auto rounded-box border border-base-300/60">
      <table class="table table-sm">
        <thead>
          <tr><th>#</th><th>Type</th><th>Index</th><th>Status</th><th>Enqueued</th><th class="text-right">Duration</th><th></th></tr>
        </thead>
        <tbody>
          <template v-for="t in tasks" :key="t.uid">
            <tr class="cursor-pointer hover:bg-base-200/50" @click="open = open === t.uid ? null : t.uid">
              <td class="font-mono text-xs opacity-60">{{ t.uid }}</td>
              <td class="font-mono text-xs">{{ t.type }}</td>
              <td class="font-mono text-xs">{{ t.index ?? '—' }}</td>
              <td><span class="badge badge-soft badge-sm" :class="BADGE[t.status]">{{ t.status }}</span></td>
              <td class="font-mono text-xs tabular-nums">{{ time(t.enqueuedAt) }}</td>
              <td class="text-right font-mono text-xs tabular-nums">{{ dur(t.durationMs) }}</td>
              <td class="text-right">
                <button v-if="t.status === 'enqueued' || t.status === 'processing'" class="btn btn-ghost btn-xs" @click.stop="cancel([t.uid])">Cancel</button>
              </td>
            </tr>
            <tr v-if="open === t.uid">
              <td colspan="7" class="bg-base-200/40 text-xs">
                <div v-if="t.error" class="mb-1 text-error">{{ t.error }}</div>
                <div class="font-mono break-all opacity-70">{{ t.details || 'No details' }}</div>
              </td>
            </tr>
          </template>
          <tr v-if="!tasks.length">
            <td colspan="7" class="py-5 text-center text-xs opacity-60">{{ loading ? 'Loading…' : 'No tasks.' }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <div class="flex items-center gap-2">
      <button v-if="next !== null" class="btn btn-ghost btn-sm" :disabled="loading" @click="load(true)">Older tasks</button>
      <p class="text-xs opacity-60">
        Meilisearch queues every write (documents, settings, index changes) and runs them in order; failed tasks show why here. Click a task for its details.
      </p>
    </div>
  </div>
</template>
