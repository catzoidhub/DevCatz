<script setup lang="ts">
import { computed } from 'vue';
import type { ProjectState, StackTask } from '@shared/types';
import { attempt, herd } from '../store';
import { toolMark } from '../datamarks';
import StackMark from './StackMark.vue';

/** The site's framework and data-library commands (spark, Yii, Symfony console, Doctrine, Django, Alembic, Knex, Drizzle, Sequelize, Kysely …) as buttons, each group with its mark. */
const props = defineProps<{ project: ProjectState; busy: boolean }>();
const emit = defineEmits<{ logs: [] }>();

const groups = computed(() => {
  const m = new Map<string, StackTask[]>();
  for (const t of props.project.stack.tasks ?? []) m.set(t.tool, [...(m.get(t.tool) ?? []), t]);
  return [...m];
});

async function run(t: StackTask) {
  let name: string | undefined;
  if (t.needsName) {
    name = prompt(`${t.tool} ${t.label.replace('…', '')}: name`, t.namePlaceholder ?? '')?.trim();
    if (!name) return;
  }
  if (t.danger && !confirm(`Run "${t.label}" (${t.tool}) for ${props.project.name}?`)) return;
  emit('logs');
  await attempt(() => herd.stackTask(props.project.id, t.id, name));
}
</script>

<template>
  <div v-if="groups.length" class="card">
    <div class="card-body">
      <h2 class="font-semibold">Commands</h2>
      <div v-for="[tool, list] in groups" :key="tool" class="flex flex-wrap items-center gap-2">
        <span class="flex w-32 shrink-0 items-center gap-2 text-sm font-medium">
          <StackMark v-if="toolMark(tool)" :icon="toolMark(tool)!" :label="tool" class="size-4 shrink-0" />
          <span v-else class="size-4 shrink-0" />
          <span class="truncate">{{ tool }}</span>
        </span>
        <button
          v-for="t in list"
          :key="t.id"
          class="btn btn-sm"
          :class="{ 'btn-error btn-outline': t.danger }"
          :disabled="busy"
          :title="t.command"
          @click="run(t)"
        >
          {{ t.label }}
        </button>
      </div>
      <p class="text-xs opacity-60">Runs in the project (or the app's) folder with this site's PHP / Python / Node and package manager; output appears in the Logs tab.</p>
    </div>
  </div>
</template>
