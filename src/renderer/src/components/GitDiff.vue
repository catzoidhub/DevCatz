<script setup lang="ts">
import { computed } from 'vue';

/** Unified diff with coloured lines (added, removed, hunk headers, file headers). */
const props = defineProps<{ text: string; empty?: string }>();

const lines = computed(() =>
  props.text.split('\n').map((l) => ({
    text: l || ' ',
    kind: l.startsWith('@@')
      ? 'hunk'
      : /^(diff --git|index |--- |\+\+\+ |new file|deleted file|similarity|rename |old mode|new mode|Binary files)/.test(l)
        ? 'meta'
        : l.startsWith('+')
          ? 'add'
          : l.startsWith('-')
            ? 'del'
            : /^(commit |Author:|AuthorDate:|Commit:|CommitDate:|Merge:)/.test(l)
              ? 'head'
              : 'ctx',
  })),
);
</script>

<template>
  <div class="git-diff selectable">
    <div v-if="!text.trim()" class="p-4 text-center text-xs opacity-60">{{ empty ?? 'No changes.' }}</div>
    <template v-else>
      <div v-for="(l, i) in lines" :key="i" class="git-diff-line" :class="`is-${l.kind}`">{{ l.text }}</div>
    </template>
  </div>
</template>

<style scoped>
.git-diff {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 11.5px;
  line-height: 1.55;
  overflow: auto;
  white-space: pre;
  tab-size: 4;
}
.git-diff-line {
  padding: 0 12px;
  min-width: max-content;
}
.is-add {
  background: oklch(from var(--color-success) l c h / 0.13);
  color: color-mix(in oklch, var(--color-success) 70%, var(--color-base-content));
}
.is-del {
  background: oklch(from var(--color-error) l c h / 0.12);
  color: color-mix(in oklch, var(--color-error) 70%, var(--color-base-content));
}
.is-hunk {
  color: var(--color-info);
  background: oklch(from var(--color-info) l c h / 0.08);
}
.is-meta {
  opacity: 0.55;
}
.is-head {
  font-weight: 600;
  opacity: 0.8;
}
</style>
