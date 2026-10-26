<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue';
import type { ExposeTool } from '@shared/types';
import { attempt, herd, notify } from '../store';
import CopyName from './CopyName.vue';

/** Uninstall confirmation for a tunnel tool: the user types its name, like a service's domain, so a misclick cannot remove it. */
const props = defineProps<{ tool: ExposeTool; name: string; version: string; logo: string }>();
const emit = defineEmits<{ close: [] }>();

const typed = ref('');
const busy = ref(false);
const input = ref<HTMLInputElement | null>(null);
const matches = computed(() => typed.value.trim().toLowerCase() === props.name.toLowerCase());
onMounted(() => nextTick(() => input.value?.focus()));

async function submit() {
  if (!matches.value || busy.value) return;
  busy.value = true;
  const ok = await attempt(() => herd.exposeUninstall(props.tool, typed.value).then(() => true));
  busy.value = false;
  if (!ok) return;
  notify('success', `${props.name} removed; tokens and logins were kept`);
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[30rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div class="flex items-start gap-3">
        <img :src="logo" alt="" class="size-9 shrink-0 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
        <div>
          <h3 class="text-lg font-semibold tracking-tight">Uninstall {{ name }} {{ version }}?</h3>
          <p class="text-xs opacity-70">Its binary is deleted. Tokens and the Cloudflare login are kept, so it can be installed again any time.</p>
        </div>
      </div>
      <label class="block">
        <span class="mb-1 block text-sm">To confirm, type <CopyName :value="name" /></span>
        <input ref="input" v-model="typed" class="input input-sm w-full font-mono" :class="{ 'input-error': typed && !matches, 'input-success': matches }" :placeholder="name" spellcheck="false" autocomplete="off" autocapitalize="off" />
      </label>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-error btn-sm" :disabled="!matches || busy"><span v-if="busy" class="loading loading-spinner loading-xs" />Uninstall</button>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
