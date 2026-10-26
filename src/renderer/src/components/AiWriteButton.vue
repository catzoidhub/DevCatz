<script setup lang="ts" generic="T">
import { ref } from 'vue';
import type { AiPreview } from '@shared/types';
import AiPreviewDialog from './AiPreviewDialog.vue';
import { herd, notify } from '../store';
import { aiError, aiToken } from '../ai';

/** A small "✦ Write with AI" button that fills a field (commit message, PR text): Stop while it runs, ⓘ shows what is sent. */
const props = withDefaults(defineProps<{ run: (token: string) => Promise<T>; preview: () => Promise<AiPreview>; label?: string; disabled?: boolean; title?: string }>(), {
  label: '✦ Write with AI',
  disabled: false,
  title: 'Write it with AI from the changes',
});
const emit = defineEmits<{ done: [a: T] }>();
const busy = ref(false);
const shown = ref<AiPreview | null>(null);
let token = '';
async function go() {
  busy.value = true;
  token = aiToken();
  try {
    emit('done', await props.run(token));
  } catch (e) {
    const msg = aiError(e);
    if (msg !== 'Stopped') notify('error', msg);
  } finally {
    busy.value = false;
  }
}
async function showPreview() {
  try {
    shown.value = await props.preview();
  } catch (e) {
    notify('error', aiError(e));
  }
}
</script>

<template>
  <span class="inline-flex items-center gap-0.5">
    <button v-if="!busy" type="button" class="btn btn-sm" :disabled="disabled" :title="title" @click="go">{{ label }}</button>
    <button v-else type="button" class="btn btn-sm" @click="herd.aiCancel(token)"><span class="loading loading-spinner loading-xs" />Stop</button>
    <button type="button" class="btn btn-ghost btn-sm btn-square" title="Preview what is sent" :disabled="disabled || busy" @click="showPreview">ⓘ</button>
    <AiPreviewDialog v-if="shown" :preview="shown" @close="shown = null" />
  </span>
</template>
