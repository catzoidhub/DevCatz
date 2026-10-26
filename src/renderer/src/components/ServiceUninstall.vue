<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import { attempt, notify } from '../store';
import CopyName from './CopyName.vue';
import CatMood from './CatMood.vue';

/**
 * Uninstall confirmation for a service (WebSocket server, search engine): the
 * user types its domain, like Storage's, so a misclick cannot remove it.
 * `run(deleteData, typed)` does the uninstall (the main process checks the domain again).
 */
const props = defineProps<{
  name: string;
  /** Domain to type, e.g. meilisearch.localhost. */
  host: string;
  dataDir: string;
  /** What the data folder holds, e.g. "All indexes and documents". */
  dataWhat: string;
  /** Who loses access, e.g. "Sites using it lose their search". */
  impact: string;
  run: (deleteData: boolean, typed: string) => Promise<void>;
}>();
const emit = defineEmits<{ close: [] }>();

const typed = ref('');
const deleteData = ref(false);
const busy = ref(false);
const input = ref<HTMLInputElement | null>(null);
const matches = computed(() => typed.value.trim().toLowerCase() === props.host);
onMounted(() => nextTick(() => input.value?.focus()));

async function submit() {
  if (!matches.value || busy.value) return;
  busy.value = true;
  const ok = await attempt(() => props.run(deleteData.value, typed.value).then(() => true));
  busy.value = false;
  if (!ok) return;
  notify('success', `${props.name} uninstalled${deleteData.value ? ' and its data deleted' : '; its data folder was kept'}`);
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[30rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-error/12"><CatMood mood="warning" class="size-8" /></span>
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Uninstall {{ name }}?</h3>
          <p class="text-xs opacity-70">It stops and its binaries are removed. {{ impact }}</p>
        </div>
      </div>

      <div class="rounded-box bg-base-200/60 p-3 text-xs">
        <div class="label-caps mb-1">Data folder</div>
        <code class="selectable break-all">{{ dataDir }}</code>
      </div>

      <label class="flex cursor-pointer items-start gap-2 text-sm">
        <input v-model="deleteData" type="checkbox" class="checkbox checkbox-sm checkbox-error mt-0.5" />
        <span>
          Also delete the data folder
          <span class="block text-xs opacity-60">{{ dataWhat }}. This cannot be undone.</span>
        </span>
      </label>

      <label class="block">
        <span class="mb-1 block text-sm">
          To confirm, type the domain <CopyName :value="host" />
        </span>
        <input
          ref="input"
          v-model="typed"
          class="input input-sm w-full font-mono"
          :class="{ 'input-error': typed && !matches, 'input-success': matches }"
          :placeholder="host"
          spellcheck="false"
          autocomplete="off"
          autocapitalize="off"
        />
      </label>

      <div class="modal-action mt-2">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="!matches || busy">
          <span v-if="busy" class="loading loading-spinner loading-xs" />
          {{ deleteData ? 'Uninstall and delete data' : 'Uninstall' }}
        </button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
