<script setup lang="ts">
import CatMood from './CatMood.vue';

/** A yes / no question before an action that changes or throws away work; MrCatz asks (worried when it is destructive). */
defineProps<{ title: string; text?: string; confirm: string; tone?: 'error' | 'warning' | 'primary'; busy?: boolean }>();
const emit = defineEmits<{ ok: []; cancel: [] }>();
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="emit('cancel')">
    <div class="modal-box w-[28rem] max-w-[95vw] space-y-3">
      <div class="flex items-start gap-3">
        <span class="grid size-10 shrink-0 place-items-center rounded-xl" :class="tone === 'error' || tone === 'warning' ? 'bg-error/12' : 'bg-primary/10'"><CatMood :mood="tone === 'error' || tone === 'warning' ? 'warning' : 'question'" class="size-8" /></span>
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">{{ title }}</h3>
          <p v-if="text" class="text-sm opacity-70">{{ text }}</p>
        </div>
      </div>
      <slot />
      <div class="modal-action">
        <button class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('cancel')">Cancel</button>
        <button class="btn btn-sm" :class="`btn-${tone ?? 'primary'}`" :disabled="busy" @click="emit('ok')">
          <span v-if="busy" class="loading loading-spinner loading-xs" />{{ confirm }}
        </button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!busy && emit('cancel')" />
  </dialog>
</template>
