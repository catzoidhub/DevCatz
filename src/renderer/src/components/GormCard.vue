<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { GoDbInfo, GoDbTask, ProjectState } from '@shared/types';
import { attempt, herd } from '../store';
import { libMark, mark, toolMark } from '../datamarks';
import StackMark from './StackMark.vue';

/**
 * Database tooling of each Go module: what it is built with (GORM, ent, sqlc,
 * sqlx, Bun …), GORM's AutoMigrate, the migration tools it uses (goose,
 * golang-migrate, Atlas, dbmate, sql-migrate, tern) and its seed commands.
 */
const props = defineProps<{ project: ProjectState; busy: boolean }>();
const emit = defineEmits<{ logs: [] }>();

const infos = ref<GoDbInfo[]>([]);
const load = async () => (infos.value = (await attempt(() => herd.goDbInfo(props.project.id))) ?? []);
onMounted(load);
watch(() => props.project.stack, load);

const byTool = (info: GoDbInfo) => {
  const groups = new Map<string, GoDbTask[]>();
  for (const t of info.tasks) groups.set(t.tool, [...(groups.get(t.tool) ?? []), t]);
  return [...groups];
};
const TOOL_LINKS: Record<string, string> = {
  goose: 'https://github.com/pressly/goose',
  'golang-migrate': 'https://github.com/golang-migrate/migrate',
  Atlas: 'https://atlasgo.io',
  dbmate: 'https://github.com/amacneil/dbmate',
  'sql-migrate': 'https://github.com/rubenv/sql-migrate',
  tern: 'https://github.com/jackc/tern',
  sqlc: 'https://sqlc.dev',
  ent: 'https://entgo.io',
};
const NAMES: Record<string, string> = { gorm: 'GORM', ent: 'ent', bun: 'Bun', sqlboiler: 'SQLBoiler', sqlc: 'sqlc', sqlx: 'sqlx', squirrel: 'Squirrel', goqu: 'goqu', pgx: 'pgx', goose: 'goose', 'golang-migrate': 'golang-migrate', atlas: 'Atlas', dbmate: 'dbmate', 'sql-migrate': 'sql-migrate', tern: 'tern' };
/** The card's title: what the module uses ("sqlc · pgx · goose"), the data libraries first. */
const title = (info: GoDbInfo) => (info.libs.length ? info.libs.map((l) => NAMES[l] ?? l).join(' · ') : 'Go database');
const titleMark = (info: GoDbInfo) => libMark(info.libs[0] ?? '') ?? mark('go');

async function runTask(info: GoDbInfo, t: GoDbTask) {
  let name: string | undefined;
  if (t.needsName) {
    name = prompt(`${t.tool} ${t.label.replace('…', '')}: migration name (letters, digits, _)`, 'add_table')?.trim();
    if (!name) return;
  }
  if (t.danger && !confirm(`Run "${t.label}" (${t.tool}) on the ${props.project.name} database?`)) return;
  emit('logs');
  const ok = await attempt(() => herd.goDbTask(props.project.id, info.dir, t.id, name).then(() => true));
  if (ok && (t.needsName || t.id.endsWith('create'))) void load();
}

async function restartForAutoMigrate() {
  emit('logs');
  await attempt(() => herd.restart(props.project.id));
}
const running = computed(() => props.project.status === 'running' || props.project.status === 'starting');
</script>

<template>
  <div v-for="info in infos" :key="info.dir" class="card">
    <div class="card-body">
      <div class="flex items-center gap-2">
        <h2 class="flex flex-1 items-center gap-2 font-semibold">
          <StackMark :icon="titleMark(info)" :label="title(info)" class="size-5" />{{ title(info) }} <span class="text-xs font-normal opacity-60">{{ info.app }}<template v-if="info.dir !== '.'"> · {{ info.dir }}</template></span>
        </h2>
        <span v-if="info.engine" class="badge badge-ghost badge-sm">{{ info.engine }}</span>
      </div>

      <div v-if="info.autoMigrate.length" class="flex flex-wrap items-center gap-2 text-xs">
        <span class="badge badge-info badge-soft badge-sm">AutoMigrate</span>
        <span class="opacity-70">
          The schema follows the models every time the app starts ({{ info.autoMigrate.slice(0, 3).join(', ') }}{{ info.autoMigrate.length > 3 ? ', …' : '' }}).
        </span>
        <button class="btn btn-xs" :disabled="busy || !running" :title="running ? '' : 'Start the site first'" @click="restartForAutoMigrate">Restart to migrate</button>
      </div>

      <div v-for="[tool, tasks] in byTool(info)" :key="tool" class="flex flex-wrap items-center gap-2">
        <span class="flex w-36 shrink-0 items-center gap-2 text-sm font-medium">
          <StackMark v-if="toolMark(tool)" :icon="toolMark(tool)!" :label="tool" class="size-4 shrink-0" />
          <span v-else class="size-4 shrink-0" />
          <a v-if="TOOL_LINKS[tool]" class="link link-hover truncate" @click="herd.openUrl(TOOL_LINKS[tool])">{{ tool }}</a>
          <span v-else class="truncate">{{ tool }}</span>
        </span>
        <button
          v-for="t in tasks"
          :key="t.id"
          class="btn btn-sm"
          :class="{ 'btn-error btn-outline': t.danger }"
          :disabled="busy"
          :title="t.command"
          @click="runTask(info, t)"
        >
          {{ t.label }}
        </button>
      </div>

      <p v-if="info.migrationDir" class="text-xs opacity-60">Migrations in <code>{{ info.dir === '.' ? '' : `${info.dir}/` }}{{ info.migrationDir }}</code>.</p>
      <p v-for="h in info.hints" :key="h" class="text-xs text-warning">{{ h }}</p>
      <p v-if="!info.tasks.length && !info.autoMigrate.length" class="text-xs opacity-70">
        No migration tool found. Go ORMs have no CLI of their own: use GORM's <code>db.AutoMigrate(…)</code>, or add
        <a class="link" @click="herd.openUrl(TOOL_LINKS.goose)">goose</a>,
        <a class="link" @click="herd.openUrl(TOOL_LINKS['golang-migrate'])">golang-migrate</a> or
        <a class="link" @click="herd.openUrl(TOOL_LINKS.Atlas)">Atlas</a> (diffs GORM models into migrations, like <code>prisma migrate dev</code>).
      </p>
      <p v-else class="text-xs opacity-60">
        Runs with this site's Go toolchain and .env database; output in the Logs tab. Seeds come from <code>cmd/seed</code>, a <code>-seed</code> flag or
        Makefile targets.
      </p>
    </div>
  </div>
</template>
