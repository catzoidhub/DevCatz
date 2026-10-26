<script setup lang="ts">
import DockerFileEditor from './DockerFileEditor.vue';

/**
 * A Docker file opened from the Docker tab: a large dialog with the code editor (Diff, ✦ Edit with AI, ⌘S),
 * a note on the left of the footer and the file's own buttons on the right. Esc or the backdrop closes it.
 */
defineProps<{ modelValue: string; file: string; siteId: string; original: string | null; dirty?: boolean }>();
const emit = defineEmits<{ 'update:modelValue': [value: string]; save: []; close: [] }>();
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc.stop="emit('close')">
    <div class="modal-box flex max-h-[90vh] w-[64rem] max-w-[95vw] flex-col gap-3">
      <div class="flex items-center gap-2">
        <h3 class="font-mono text-base font-semibold">{{ file }}</h3>
        <span v-if="dirty" class="badge badge-warning badge-soft badge-sm">unsaved</span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-sm btn-square" title="Close (Esc)" @click="emit('close')">✕</button>
      </div>
      <div class="min-h-0 flex-1 overflow-y-auto">
        <DockerFileEditor :model-value="modelValue" :file="file" :site-id="siteId" :original="original" big @update:model-value="(v) => emit('update:modelValue', v)" @save="emit('save')">
          <template #before><slot name="note" /></template>
        </DockerFileEditor>
      </div>
      <div class="flex items-center gap-2">
        <span class="text-xs opacity-60"><kbd class="kbd kbd-xs">⌘S</kbd> <slot name="save-hint">saves</slot> · <kbd class="kbd kbd-xs">Esc</kbd> closes</span>
        <span class="flex-1" />
        <slot name="actions" />
      </div>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
  </dialog>
</template>
