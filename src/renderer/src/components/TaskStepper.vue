<script setup lang="ts">
import { computed } from 'vue';
import type { TaskProgress } from '@shared/types';

/** Progress of a multi-step job (install / uninstall): step list, download bar and what is being worked on. */
const props = defineProps<{ task: TaskProgress; compact?: boolean; cancellable?: boolean; dismissable?: boolean }>();
const emit = defineEmits<{ cancel: []; dismiss: [] }>();
const running = computed(() => !props.task.done && !props.task.error);
const VERB: Record<TaskProgress['kind'], string> = { install: 'Install', uninstall: 'Uninstall', update: 'Update', share: 'Sharing' };
const DONE: Record<string, string> = { Installing: 'Installed', Uninstalling: 'Uninstalled', Updating: 'Updated', Sharing: 'Shared' };

const percent = computed(() => {
  const t = props.task;
  if (t.done) return 100;
  // Overall progress: finished steps + the download's share of its own step.
  const inStep = t.total ? Math.min(1, (t.received ?? 0) / t.total) : 0;
  return Math.round(((t.step + inStep) / t.steps.length) * 100);
});
const downloading = computed(() => props.task.total !== undefined && props.task.total > 0 && !props.task.done && !props.task.error);
const mb = (n?: number) => ((n ?? 0) / 1048576).toFixed(1);
const state = (i: number) =>
  props.task.error && i === props.task.step ? (props.task.cancelled ? 'cancelled' : 'failed') : i < props.task.step || props.task.done ? 'done' : i === props.task.step ? 'active' : 'todo';
</script>

<template>
  <div class="space-y-3 rounded-box border border-base-300/60 bg-base-200/40 p-3" :class="{ 'border-error/40': task.error && !task.cancelled }">
    <div class="flex items-center gap-2">
      <span v-if="task.cancelled" class="grid size-5 place-items-center rounded-full bg-base-content/20 text-[11px] font-bold">–</span>
      <span v-else-if="task.error" class="grid size-5 place-items-center rounded-full bg-error text-[11px] font-bold text-error-content">!</span>
      <span v-else-if="task.done" class="grid size-5 place-items-center rounded-full bg-success text-[11px] font-bold text-success-content">✓</span>
      <span v-else class="loading loading-spinner loading-sm text-primary" />
      <span class="flex-1 text-sm font-medium">
        {{ task.cancelled ? `${VERB[task.kind]} cancelled` : task.error ? `${VERB[task.kind]} failed` : task.done ? `${task.title.replace(/^(Installing|Uninstalling|Updating|Sharing)/, (m) => DONE[m] ?? m)}` : task.title }}
      </span>
      <span class="font-mono text-xs opacity-60">{{ percent }}%</span>
      <button v-if="cancellable && running" type="button" class="btn btn-ghost btn-xs text-error" :title="task.kind === 'share' ? 'Stop starting the tunnel' : 'Stop the install; nothing is kept'" @click="emit('cancel')">Cancel</button>
      <button v-if="dismissable && !running" type="button" class="btn btn-ghost btn-xs btn-square" title="Dismiss" @click="emit('dismiss')">✕</button>
    </div>

    <progress class="progress w-full" :class="task.cancelled ? '' : task.error ? 'progress-error' : task.done ? 'progress-success' : 'progress-primary'" :value="percent" max="100" />

    <ol v-if="!compact" class="space-y-1.5 text-xs">
      <li v-for="(name, i) in task.steps" :key="name" class="flex items-start gap-2">
        <span class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full text-[9px] font-bold"
          :class="{
            'bg-success text-success-content': state(i) === 'done',
            'bg-error text-error-content': state(i) === 'failed',
            'bg-base-content/20': state(i) === 'cancelled',
            'bg-primary/15 text-primary ring-1 ring-primary/40': state(i) === 'active',
            'bg-base-content/10 opacity-60': state(i) === 'todo',
          }"
        >
          <template v-if="state(i) === 'done'">✓</template>
          <template v-else-if="state(i) === 'failed'">!</template>
          <template v-else-if="state(i) === 'cancelled'">–</template>
          <span v-else-if="state(i) === 'active'" class="size-1.5 animate-pulse rounded-full bg-primary" />
          <template v-else>{{ i + 1 }}</template>
        </span>
        <div class="min-w-0 flex-1">
          <div :class="{ 'opacity-50': state(i) === 'todo', 'font-medium': state(i) === 'active' || state(i) === 'failed', 'text-error': state(i) === 'failed' }">
            {{ name }}
            <span v-if="state(i) === 'active' && downloading" class="ml-1 font-mono opacity-70">{{ mb(task.received) }} / {{ mb(task.total) }} MB</span>
          </div>
          <div v-if="(state(i) === 'active' || state(i) === 'failed') && task.detail" class="selectable truncate font-mono text-[11px] opacity-60" :title="task.detail">
            {{ task.detail }}
          </div>
        </div>
      </li>
    </ol>
    <div v-else class="truncate text-xs opacity-70">
      {{ task.steps[Math.min(task.step, task.steps.length - 1)] }}<template v-if="downloading"> · {{ mb(task.received) }} / {{ mb(task.total) }} MB</template>
      <template v-if="task.detail"> · <span class="font-mono">{{ task.detail }}</span></template>
    </div>

    <div v-if="task.error" class="selectable rounded-lg px-2.5 py-1.5 text-xs" :class="task.cancelled ? 'bg-base-content/5 opacity-70' : 'bg-error/10 text-error'">{{ task.error }}</div>
  </div>
</template>
