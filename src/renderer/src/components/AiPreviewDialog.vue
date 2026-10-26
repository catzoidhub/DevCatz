<script setup lang="ts">
import type { AiPreview } from '@shared/types';

/** "Preview what is sent": the exact system prompt and messages of a request, nothing sent yet. */
defineProps<{ preview: AiPreview }>();
const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('close')">
    <div class="modal-box flex max-h-[85vh] w-[46rem] max-w-[95vw] flex-col gap-3">
      <h3 class="text-lg font-semibold tracking-tight">What is sent to {{ preview.provider }} · {{ preview.model }}</h3>
      <p class="text-xs opacity-60">Exactly this, nothing more: the instructions with what DevCatz knows (system), then the conversation. Secrets are masked as •••.</p>
      <div class="min-h-0 flex-1 space-y-3 overflow-y-auto">
        <div>
          <div class="label-caps mb-1">System</div>
          <pre class="selectable rounded-box bg-base-200/70 p-3 font-mono text-xs whitespace-pre-wrap">{{ preview.system }}</pre>
        </div>
        <div v-for="(m, i) in preview.messages" :key="i">
          <div class="label-caps mb-1">{{ m.role === 'user' ? 'You' : 'Earlier answer' }}</div>
          <pre class="selectable rounded-box bg-base-200/70 p-3 font-mono text-xs whitespace-pre-wrap">{{ m.text }}</pre>
        </div>
      </div>
      <div class="modal-action mt-0">
        <button class="btn btn-sm" @click="emit('close')">Close</button>
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>
