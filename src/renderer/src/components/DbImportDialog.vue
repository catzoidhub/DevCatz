<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DbImportCandidate, DbImportSource, ExternalDbService } from '@shared/types';
import CatMood from './CatMood.vue';
import { DB_LOGO, isActive } from '../db';
import { attempt, herd, notify, state } from '../store';
import { bytes } from '../monitor';

/**
 * Database → Running elsewhere → Import: copy databases from a server another app runs (DBngin, Laravel Herd,
 * Postgres.app, Homebrew, Docker …) into a DevCatz service of the same engine family — a dump of each database,
 * restored into a new one with the same name. The source is only read; nothing there changes.
 */
const props = defineProps<{ source: ExternalDbService }>();
const emit = defineEmits<{ close: [] }>();

const NAMES = { mysql: 'MySQL', mariadb: 'MariaDB', postgresql: 'PostgreSQL' } as const;
const engine = computed(() => props.source.engine as DbImportSource['engine']);
const family = (e: string) => (e === 'mariadb' ? 'mysql' : e);

/** DevCatz services the databases can go into (MySQL ↔ MariaDB, PostgreSQL ↔ PostgreSQL). */
const targets = computed(() => (state.value?.databases ?? []).filter((s) => !s.pending && family(s.engine) === family(engine.value)));
const targetId = ref<string>('');
watch(
  targets,
  (list) => {
    if (!list.some((t) => t.id === targetId.value)) targetId.value = (list.find((t) => isActive(t)) ?? list[0])?.id ?? '';
  },
  { immediate: true },
);
const target = computed(() => targets.value.find((t) => t.id === targetId.value) ?? null);
const targetUp = computed(() => !!target.value && isActive(target.value));

// What these apps use out of the box; Docker containers set their own.
const user = ref(engine.value === 'postgresql' ? (props.source.source === 'Postgres.app' ? '' : 'postgres') : 'root');
const password = ref('');
const src = computed<DbImportSource>(() => ({ engine: engine.value, port: props.source.port, user: user.value, password: password.value, label: props.source.source }));

const listing = ref(false);
const listError = ref('');
const dbs = ref<DbImportCandidate[] | null>(null);
const picked = ref<Set<string>>(new Set());
async function connect() {
  if (!target.value) return;
  listing.value = true;
  listError.value = '';
  try {
    dbs.value = await herd.dbImportList(target.value.id, src.value);
    picked.value = new Set(dbs.value.filter((d) => !d.exists).map((d) => d.name));
  } catch (e) {
    listError.value = String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    dbs.value = null;
  }
  listing.value = false;
}
function toggle(name: string) {
  const next = new Set(picked.value);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  picked.value = next;
}
const pickedBytes = computed(() => (dbs.value ?? []).filter((d) => picked.value.has(d.name)).reduce((n, d) => n + (d.bytes ?? 0), 0));

// ---- the copy, one database at a time
const result = ref<Record<string, 'waiting' | 'copying' | 'done' | string>>({});
const running = ref(false);
const finished = ref(false);
async function startTarget() {
  if (target.value) await attempt(() => herd.dbAction(target.value!.id, 'start').then(() => true));
}
async function run() {
  if (!target.value) return;
  running.value = true;
  const names = [...picked.value];
  result.value = Object.fromEntries(names.map((n) => [n, 'waiting']));
  let ok = 0;
  for (const name of names) {
    result.value = { ...result.value, [name]: 'copying' };
    try {
      await herd.dbImportOne(target.value.id, src.value, name);
      result.value = { ...result.value, [name]: 'done' };
      ok++;
    } catch (e) {
      result.value = { ...result.value, [name]: String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
    }
  }
  running.value = false;
  finished.value = true;
  notify(ok === names.length ? 'success' : ok ? 'info' : 'error', `${ok} of ${names.length} database${names.length === 1 ? '' : 's'} imported into ${target.value.name}`);
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!running && emit('close')">
    <div class="modal-box flex max-h-[88vh] w-[34rem] max-w-[95vw] flex-col gap-4">
      <div class="flex items-start gap-3">
        <img :src="DB_LOGO[engine]" alt="" class="size-10 shrink-0 rounded-xl bg-white p-1.5 ring-1 ring-base-content/10" draggable="false" />
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">Import from {{ source.source === 'Other' ? 'another app' : source.source }}</h3>
          <p class="text-xs opacity-70">{{ NAMES[engine] }} on port {{ source.port }}. Each database you pick is copied into a DevCatz service; the original stays as it is.</p>
        </div>
      </div>

      <!-- Into -->
      <div v-if="!targets.length" role="alert" class="alert alert-info alert-soft text-sm">
        <CatMood mood="info" class="size-7 shrink-0 -my-0.5" />
        <span>Create a {{ engine === 'postgresql' ? 'PostgreSQL' : 'MySQL or MariaDB' }} service first (+ at the top of this page), then import into it.</span>
      </div>
      <template v-else>
        <label class="flex items-center gap-3 text-sm">
          <span class="w-24 shrink-0 opacity-70">Into</span>
          <select v-model="targetId" class="select select-sm min-w-0 flex-1" :disabled="running">
            <option v-for="t in targets" :key="t.id" :value="t.id">{{ t.name }} · {{ t.engineName }} {{ t.version }} :{{ t.port }}{{ isActive(t) ? '' : ' (stopped)' }}</option>
          </select>
          <button v-if="!targetUp" class="btn btn-sm" @click="startTarget">Start it</button>
        </label>

        <!-- Credentials of the source -->
        <div class="flex items-center gap-3 text-sm">
          <span class="w-24 shrink-0 opacity-70">Sign in as</span>
          <input v-model="user" class="input input-sm w-32 font-mono" :placeholder="engine === 'postgresql' ? 'your user' : 'root'" spellcheck="false" :disabled="running" />
          <input v-model="password" type="password" class="input input-sm min-w-0 flex-1 font-mono" placeholder="password (empty for none)" autocomplete="off" :disabled="running" @keydown.enter="connect" />
          <button class="btn btn-sm" :disabled="!targetUp || listing || running" @click="connect"><span v-if="listing" class="loading loading-spinner loading-xs" />{{ dbs ? 'Refresh' : 'Connect' }}</button>
        </div>
        <p v-if="source.source === 'Postgres.app'" class="-mt-2 pl-[6.75rem] text-xs opacity-60">Postgres.app signs you in with your macOS user name and no password.</p>
        <div v-if="listError" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" /><span class="selectable">{{ listError }}</span></div>

        <!-- Databases -->
        <div v-if="dbs" class="min-h-0 flex-1 overflow-y-auto rounded-box border border-base-300/70">
          <div v-if="!dbs.length" class="p-4 text-center text-sm opacity-60">No databases of your own on this server.</div>
          <label v-for="d in dbs" :key="d.name" class="flex cursor-pointer items-center gap-3 border-b border-base-300/40 px-3 py-2 last:border-0" :class="{ 'cursor-default opacity-50': d.exists }">
            <input type="checkbox" class="checkbox checkbox-sm" :checked="picked.has(d.name)" :disabled="d.exists || running || finished" @change="toggle(d.name)" />
            <code class="min-w-0 flex-1 truncate text-sm">{{ d.name }}</code>
            <span v-if="d.exists && !result[d.name]" class="badge badge-ghost badge-sm">already in {{ target?.name }}</span>
            <template v-else-if="result[d.name]">
              <span v-if="result[d.name] === 'waiting'" class="text-xs opacity-50">waiting</span>
              <span v-else-if="result[d.name] === 'copying'" class="flex items-center gap-1.5 text-xs"><span class="loading loading-spinner loading-xs" />copying…</span>
              <span v-else-if="result[d.name] === 'done'" class="text-xs text-success">✓ imported</span>
              <span v-else class="max-w-[14rem] truncate text-xs text-error" :title="result[d.name]">✗ {{ result[d.name] }}</span>
            </template>
            <span class="w-20 text-right font-mono text-xs tabular-nums opacity-70">{{ d.bytes !== null ? bytes(d.bytes) : '' }}</span>
          </label>
        </div>
      </template>

      <div class="flex items-center gap-2">
        <span v-if="dbs && !finished" class="text-xs opacity-60">{{ picked.size }} selected{{ pickedBytes ? ` · ${bytes(pickedBytes)}` : '' }}</span>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-sm" :disabled="running" @click="emit('close')">{{ finished ? 'Close' : 'Cancel' }}</button>
        <button v-if="!finished" class="btn btn-primary btn-sm" :disabled="!dbs || !picked.size || running || !targetUp" @click="run">
          <span v-if="running" class="loading loading-spinner loading-xs" />Import {{ picked.size || '' }} database{{ picked.size === 1 ? '' : 's' }}
        </button>
      </div>
    </div>
    <div class="modal-backdrop" @click="!running && emit('close')" />
  </dialog>
</template>
