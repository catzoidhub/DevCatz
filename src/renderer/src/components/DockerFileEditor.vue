<script setup lang="ts">
import { computed, ref } from 'vue';
import type { AiDockerEditAnswer } from '@shared/types';
import CodeEditor from './CodeEditor.vue';
import AiBox from './AiBox.vue';
import { herd } from '../store';
import { aiOn } from '../ai';
import { diff } from '../linediff';
import { languageOf } from '../highlight';

/**
 * A Docker file in the Docker tab: a code editor (highlighted, editable, ⌘S emits save), Diff against
 * `original`, and ✦ Edit with AI — the model's version lands in the editor, where it can still be changed.
 */
const props = defineProps<{ modelValue: string; file: string; siteId: string; original: string | null; readonly?: boolean; /** In a dialog: a taller editor. */ big?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: [] }>();
const showDiff = ref(false);
const changed = computed(() => props.original !== null && props.modelValue !== props.original);
const lines = computed(() => (props.original !== null ? diff(props.original, props.modelValue) : []));

const aiDockerOn = aiOn('docker');
const aiOpen = ref(false);
const aiNote = ref('');
const req = (prompt: string) => ({ siteId: props.siteId, file: props.file, content: props.modelValue, prompt });
const run = (prompt: string, token: string) => herd.aiDockerEdit(req(prompt), token);
const preview = (prompt: string) => herd.aiPreviewDockerEdit(req(prompt));
function applyAi(a: AiDockerEditAnswer) {
  emit('update:modelValue', a.content);
  aiNote.value = a.explanation;
  if (props.original !== null) showDiff.value = true;
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <slot name="before" />
      <span class="flex-1" />
      <button v-if="original !== null" class="btn btn-ghost btn-xs" :class="{ 'btn-active': showDiff }" :disabled="!changed" :title="changed ? 'Show the changes' : 'No changes yet'" @click="showDiff = !showDiff">Diff</button>
      <button v-if="aiDockerOn && !readonly && !aiOpen" class="btn btn-xs" title="Change this file from plain words; the result lands in the editor" @click="aiOpen = true">✦ Edit with AI</button>
      <slot name="actions" />
    </div>
    <AiBox v-if="aiOpen" :key="file" :run="run" :preview="preview" action="Change it" placeholder="e.g. “add ImageMagick”, “use Node 22”, “run as a non-root user”" busy-text="Writing the new file…" @answer="(a) => applyAi(a as AiDockerEditAnswer)" @close="(aiOpen = false), (aiNote = '')">
      <template #default>
        <p class="text-xs opacity-80">{{ aiNote }} <span class="opacity-60">It is in the editor below: check it, change it if you like, then save.</span></p>
      </template>
    </AiBox>
    <pre v-if="showDiff && changed" :class="big ? 'max-h-[62vh]' : 'max-h-80'" class="overflow-auto rounded-box border border-base-300/60 bg-base-200/60 p-3 text-xs"><span
      v-for="(d, i) in lines"
      :key="i"
      class="block"
      :class="d.t === '+' ? 'text-success' : d.t === '-' ? 'text-error' : 'opacity-60'"
    >{{ d.t }} {{ d.l }}</span></pre>
    <CodeEditor v-else :model-value="modelValue" :language="languageOf(file)" :readonly="readonly" :min-rows="big ? 22 : 8" :max-height="big ? '62vh' : '32rem'" @update:model-value="(v) => emit('update:modelValue', v)" @save="emit('save')" />
  </div>
</template>
