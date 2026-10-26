<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import type { StorageState } from '@shared/types';
import { attempt, herd, notify } from '../store';
import CopyName from './CopyName.vue';
import CatMood from './CatMood.vue';

/** Uninstall confirmation: the user types the API domain (like GitHub's "type the repo name"), so a misclick cannot remove a service. */
const props = defineProps<{ service: StorageState }>();
const emit = defineEmits<{ close: [] }>();

const host = computed(() => (props.service.urls ? new URL(props.service.urls.api).hostname : ''));
const typed = ref('');
const deleteData = ref(false);
const busy = ref(false);
const input = ref<HTMLInputElement | null>(null);
const matches = computed(() => typed.value.trim().toLowerCase() === host.value);
onMounted(() => nextTick(() => input.value?.focus()));

async function submit() {
  if (!matches.value || busy.value) return;
  busy.value = true;
  const ok = await attempt(() => herd.storageUninstall(props.service.kind, deleteData.value, typed.value).then(() => true));
  busy.value = false;
  if (!ok) return;
  notify('success', `${props.service.name} uninstalled${deleteData.value ? ' and its data deleted' : '; its data folder was kept'}`);
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[30rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl bg-error/12"><CatMood mood="warning" class="size-8" /></span>
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Uninstall {{ service.name }}?</h3>
          <p class="text-xs opacity-70">The service stops and its binary is removed. Sites using its endpoint stop working until it is installed again.</p>
        </div>
      </div>

      <div class="rounded-box bg-base-200/60 p-3 text-xs">
        <div class="label-caps mb-1">Data folder</div>
        <code class="selectable break-all">{{ service.config?.dataDir }}</code>
      </div>

      <label class="flex cursor-pointer items-start gap-2 text-sm">
        <input v-model="deleteData" type="checkbox" class="checkbox checkbox-sm checkbox-error mt-0.5" />
        <span>
          Also delete the data folder
          <span class="block text-xs opacity-60">All buckets and files in it. This cannot be undone.</span>
        </span>
      </label>

      <label class="block">
        <span class="mb-1 block text-sm">
          To confirm, type the API domain <CopyName :value="host" />
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
