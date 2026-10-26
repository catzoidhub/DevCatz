<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue';

/** Title bar for full-page panels (Settings, Node.js) with a close button; Esc closes too. */
/** `closable: false` for top-level sections (Settings in the rail): no Close button, no Esc. */
const props = withDefaults(defineProps<{ title: string; closable?: boolean; icon?: string; iconViewBox?: string; tint?: string }>(), {
  closable: true,
  tint: 'projects',
  iconViewBox: '0 0 20 20',
});
const emit = defineEmits<{ close: [] }>();

function onKey(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (props.closable && e.key === 'Escape' && !(t && ['INPUT', 'SELECT', 'TEXTAREA'].includes(t.tagName))) emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));
</script>

<template>
  <header class="drag flex items-start gap-3 border-b border-base-300/60 px-6 pt-5 pb-4">
    <div class="min-w-0 flex-1">
      <!-- Icon and title on one line, centred on each other; the slot (tabs, text) goes below. -->
      <div class="flex items-center gap-3">
        <span v-if="icon" class="grid size-9 shrink-0 place-items-center rounded-xl" :style="{ color: `var(--c-${tint})`, background: `color-mix(in oklch, var(--c-${tint}) 16%, transparent)` }">
          <svg class="size-5" :viewBox="iconViewBox" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="icon" /></svg>
        </span>
        <h1 class="text-lg font-semibold tracking-tight">{{ title }}</h1>
      </div>
      <slot />
    </div>
    <button v-if="closable" class="btn btn-ghost btn-sm gap-1" title="Close (Esc)" @click="emit('close')">
      <svg class="size-4" viewBox="0 0 20 20" fill="currentColor">
        <path d="M6.28 5.22a.75.75 0 0 0-1.06 1.06L8.94 10l-3.72 3.72a.75.75 0 1 0 1.06 1.06L10 11.06l3.72 3.72a.75.75 0 1 0 1.06-1.06L11.06 10l3.72-3.72a.75.75 0 0 0-1.06-1.06L10 8.94 6.28 5.22Z" />
      </svg>
      Close
    </button>
  </header>
</template>
