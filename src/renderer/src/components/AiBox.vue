<script setup lang="ts" generic="T">
import { ref } from 'vue';
import type { AiPreview } from '@shared/types';
import AiPreviewDialog from './AiPreviewDialog.vue';
import { herd } from '../store';
import { aiError, aiToken } from '../ai';
import CatMood from './CatMood.vue';

/**
 * The frame every AI feature shares: an optional request field, Ask (⏎), Stop while it runs, Preview what is
 * sent, the model's error in plain words; the answer goes to the default slot. `run` and `preview` get the text
 * typed and a token (Stop aborts the request with it).
 */
const props = withDefaults(
  defineProps<{
    run: (prompt: string, token: string) => Promise<T>;
    preview: (prompt: string) => Promise<AiPreview>;
    /** Label of the button (Explain, Write with AI …). */
    action?: string;
    placeholder?: string;
    /** Show the request field (otherwise just the button). */
    input?: boolean;
    /** Start right away when mounted. */
    auto?: boolean;
    busyText?: string;
  }>(),
  { action: 'Ask AI', placeholder: '', input: true, auto: false, busyText: 'Asking the model…' },
);
const emit = defineEmits<{ answer: [a: T]; close: [] }>();

const prompt = ref('');
const busy = ref(false);
const error = ref('');
const answer = ref<T | null>(null) as { value: T | null };
const shown = ref<AiPreview | null>(null);
let token = '';

async function go() {
  if (busy.value) return;
  busy.value = true;
  error.value = '';
  token = aiToken();
  try {
    const a = await props.run(prompt.value, token);
    answer.value = a;
    emit('answer', a);
  } catch (e) {
    error.value = aiError(e);
  } finally {
    busy.value = false;
  }
}
const stop = () => void herd.aiCancel(token);
async function showPreview() {
  try {
    shown.value = await props.preview(prompt.value);
  } catch (e) {
    error.value = aiError(e);
  }
}
if (props.auto) void go();
defineExpose({ go, prompt });
</script>

<template>
  <div class="rounded-box border border-primary/25 bg-primary/5 p-3">
    <div class="flex items-center gap-2">
      <svg class="size-4 shrink-0 text-primary" viewBox="0 0 20 20" fill="currentColor"><path d="M10 1.5l1.6 4.4 4.4 1.6-4.4 1.6L10 13.5 8.4 9.1 4 7.5l4.4-1.6L10 1.5Zm5.5 10 .8 2.2 2.2.8-2.2.8-.8 2.2-.8-2.2-2.2-.8 2.2-.8.8-2.2ZM4.5 12l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4L2.5 14l1.4-.6.6-1.4Z" /></svg>
      <input
        v-if="input"
        v-model="prompt"
        class="input input-sm min-w-0 flex-1"
        :placeholder="placeholder"
        :disabled="busy"
        spellcheck="false"
        @keydown.enter.prevent="go"
      />
      <span v-else class="min-w-0 flex-1 text-sm opacity-70">{{ placeholder }}</span>
      <button v-if="!busy" class="btn btn-primary btn-sm" @click="go">{{ answer ? 'Ask again' : action }}</button>
      <button v-else class="btn btn-sm" @click="stop"><span class="loading loading-spinner loading-xs" />Stop</button>
      <button class="btn btn-ghost btn-sm" title="Preview what is sent" :disabled="busy" @click="showPreview">Preview</button>
      <button class="btn btn-ghost btn-sm btn-square" title="Close" @click="emit('close')">✕</button>
    </div>
    <p v-if="busy" class="mt-2 text-xs opacity-60">{{ busyText }}</p>
    <div v-if="error" class="alert alert-error mt-2 py-2 text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ error }}</div>
    <div v-if="answer && !busy" class="mt-3"><slot :answer="answer" /></div>
    <AiPreviewDialog v-if="shown" :preview="shown" @close="shown = null" />
  </div>
</template>
