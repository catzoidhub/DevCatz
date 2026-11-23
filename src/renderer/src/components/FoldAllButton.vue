<script setup lang="ts">
/** Collapse all / expand all of a sidebar list's sections (as in DBCatz and DoCatz): one button that flips. */
defineProps<{ anyOpen: boolean }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button class="btn btn-ghost btn-xs btn-square" :title="anyOpen ? 'Collapse all: only the section names' : 'Expand all: every section open'" @click="$emit('toggle')">
    <svg v-if="anyOpen" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5.22 2.22a.75.75 0 0 1 1.06 0L10 5.94l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0L5.22 3.28a.75.75 0 0 1 0-1.06Zm0 15.56a.75.75 0 0 0 1.06 0L10 14.06l3.72 3.72a.75.75 0 1 0 1.06-1.06l-4.25-4.25a.75.75 0 0 0-1.06 0l-4.25 4.25a.75.75 0 0 0 0 1.06Z" clip-rule="evenodd" /></svg>
    <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 2.75a.75.75 0 0 1 .53.22l4.25 4.25a.75.75 0 1 1-1.06 1.06L10 4.56 6.28 8.28a.75.75 0 0 1-1.06-1.06l4.25-4.25a.75.75 0 0 1 .53-.22Zm-4.78 9.97a.75.75 0 0 1 1.06 0L10 16.44l3.72-3.72a.75.75 0 1 1 1.06 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0l-4.25-4.25a.75.75 0 0 1 0-1.06Z" clip-rule="evenodd" /></svg>
  </button>
</template>
