<script setup lang="ts">
import { ref } from 'vue';

/** The name a confirmation asks for, with a small copy button (paste it into the field below). */
const props = defineProps<{ value: string }>();
const copied = ref(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  try {
    await navigator.clipboard.writeText(props.value);
  } catch {
    // Clipboard API refused (window not focused): the old way still works.
    const t = document.createElement('textarea');
    t.value = props.value;
    t.style.position = 'fixed';
    t.style.opacity = '0';
    document.body.appendChild(t);
    t.select();
    document.execCommand('copy');
    t.remove();
  }
  copied.value = true;
  clearTimeout(timer);
  timer = setTimeout(() => (copied.value = false), 1500);
}
</script>

<template>
  <span class="inline-flex items-center gap-0.5 align-middle">
    <code class="selectable rounded bg-base-200 px-1.5 py-0.5 font-semibold">{{ value }}</code>
    <button type="button" class="btn btn-ghost btn-xs btn-square" :class="{ 'text-success': copied }" :title="copied ? 'Copied' : 'Copy'" @click="copy">
      <svg v-if="copied" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-8 8a1 1 0 0 1-1.4 0l-4-4a1 1 0 1 1 1.4-1.4L8 12.6l7.3-7.3a1 1 0 0 1 1.4 0Z" clip-rule="evenodd" /></svg>
      <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M7 3.5A1.5 1.5 0 0 1 8.5 2h3.879a1.5 1.5 0 0 1 1.06.44l3.122 3.12A1.5 1.5 0 0 1 17 6.622V12.5a1.5 1.5 0 0 1-1.5 1.5h-1v-3.379a3 3 0 0 0-.879-2.121L10.5 5.379A3 3 0 0 0 8.379 4.5H7v-1Z" /><path d="M4.5 6A1.5 1.5 0 0 0 3 7.5v9A1.5 1.5 0 0 0 4.5 18h7a1.5 1.5 0 0 0 1.5-1.5v-5.879a1.5 1.5 0 0 0-.44-1.06L9.44 6.439A1.5 1.5 0 0 0 8.378 6H4.5Z" /></svg>
    </button>
  </span>
</template>
