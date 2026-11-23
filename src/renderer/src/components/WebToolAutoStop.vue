<script setup lang="ts">
import { ref, watch } from 'vue';
import type { WebToolState } from '@shared/types';
import { attempt, herd } from '../store';

/** pgweb's auto-stop (TODO §48): a switch and its minutes (default 30), saved as they change. */
const props = defineProps<{ tool: WebToolState }>();
const minutes = ref(props.tool.autoStopMinutes);
watch(
  () => props.tool.autoStopMinutes,
  (m) => (minutes.value = m),
);
const ok = (m: number) => Number.isInteger(m) && m >= 5 && m <= 1440;

async function setOn(on: boolean) {
  await attempt(() => herd.webToolSetAutoStop(props.tool.id, on));
}
async function saveMinutes() {
  const m = Number(minutes.value);
  if (!ok(m)) {
    minutes.value = props.tool.autoStopMinutes;
    return;
  }
  if (m !== props.tool.autoStopMinutes) await attempt(() => herd.webToolSetAutoStop(props.tool.id, props.tool.autoStop !== false, m), 'Saved');
}
</script>

<template>
  <div class="flex flex-wrap items-center gap-2 text-xs">
    <input type="checkbox" class="toggle toggle-xs toggle-primary" :checked="tool.autoStop !== false" aria-label="Stop when unused" @change="setOn(($event.target as HTMLInputElement).checked)" />
    <span class="opacity-70">Stop when unused for</span>
    <input
      v-model.number="minutes"
      type="number"
      min="5"
      max="1440"
      class="input input-xs w-16 font-mono"
      :class="{ 'input-error': !ok(Number(minutes)) }"
      :disabled="tool.autoStop === false"
      @change="saveMinutes"
      @keydown.enter="saveMinutes"
    />
    <span class="opacity-70">minutes (Open starts it again)</span>
  </div>
</template>
