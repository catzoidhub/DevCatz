<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ProjectState, RedisDetails } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import { DB_LOGO } from '../db';
import StatusDot from './StatusDot.vue';
import DbCatzButton from './DbCatzButton.vue';

/** Redis or Valkey of a site (shown in the Database tab): where it is, live INFO, start/stop when it is a compose service. */
const props = defineProps<{ project: ProjectState; busy: boolean }>();
const emit = defineEmits<{ action: [action: 'redis-start' | 'redis-stop'] }>();

const details = ref<RedisDetails | null>(null);
const loading = ref(false);

async function load() {
  loading.value = true;
  details.value = await herd.redisDetails(props.project.id).catch(() => null);
  loading.value = false;
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(load, 10_000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(() => props.project.redisStatus, load);

const r = () => props.project.stack.redis!;

/** Redis or Valkey: what answers INFO, else a DevCatz Valkey service on that port, else the image/client hint. */
/** A DevCatz Redis/Valkey service on the port this site uses (local address only). */
const ownService = computed(() =>
  /^(localhost|127\.0\.0\.1|::1|\[::1\])$|\.localhost$|\.test$/i.test(r().host) && !r().composeFile
    ? (state.value?.databases.find((d) => (d.engine === 'valkey' || d.engine === 'redis') && d.port === r().port && !d.pending) ?? null)
    : null,
);
const flavor = computed<'redis' | 'valkey'>(() => {
  if (details.value?.server) return details.value.server;
  return ownService.value?.engine === 'valkey' ? 'valkey' : r().flavor;
});
const title = computed(() => (flavor.value === 'valkey' ? 'Valkey' : 'Redis'));

// ---- DB index per site
const DBS = Array.from({ length: 16 }, (_, i) => i);
const isPhp = computed(() => props.project.stack.runtime === 'php');
/** The index a site really uses: DevCatz's choice, else .env (Laravel's cache connection defaults to 1). */
const dbOf = (p: ProjectState) => p.redisDb ?? p.stack.redis?.db ?? 0;
const cacheDbOf = (p: ProjectState) => (p.stack.runtime === 'php' ? (p.redisCacheDb ?? p.stack.redis?.cacheDb ?? 1) : null);
/** Laravel connections with their own index (REDIS_VISIT_DB …): DevCatz's choice, else .env / config default. */
const connsOf = (p: ProjectState) => (p.stack.runtime === 'php' ? (p.stack.redis?.connections ?? []).map((c) => ({ ...c, db: p.redisConnDbs?.[c.envKey] ?? c.db })) : []);
/** Every index a site uses on its server. */
const indexesOf = (p: ProjectState) => [...new Set([dbOf(p), cacheDbOf(p), ...connsOf(p).map((c) => c.db)].filter((x): x is number => x !== null))];
const db = computed(() => dbOf(props.project));
const cacheDb = computed(() => cacheDbOf(props.project));
const conns = computed(() => connsOf(props.project));
const sameServer = (p: ProjectState) => {
  const a = p.stack.redis;
  const b = r();
  const local = (h: string) => /^(localhost|127\.0\.0\.1|::1|\[::1\])$/i.test(h);
  return !!a && a.port === b.port && (a.host === b.host || (local(a.host) && local(b.host))) && a.composeFile === b.composeFile;
};
/** Other sites on this Redis server, per index. */
const usage = computed(() => {
  const m = new Map<number, string[]>();
  for (const p of state.value?.projects ?? []) {
    if (p.id === props.project.id || !sameServer(p)) continue;
    for (const i of indexesOf(p)) m.set(i, [...(m.get(i) ?? []), p.name]);
  }
  return m;
});
const clashes = computed(() => indexesOf(props.project).filter((i) => usage.value.has(i)).map((i) => ({ db: i, sites: usage.value.get(i)! })));
/** A custom connection on the same index as default / cache: their keys mix (and cache:clear flushes the cache one). */
const ownOverlaps = computed(() =>
  conns.value.filter((c) => c.db === db.value || c.db === cacheDb.value).map((c) => `${c.name} (${c.envKey}) shares db ${c.db} with ${c.db === cacheDb.value ? 'cache' : 'default'}`),
);
const keysIn = (i: number) => details.value?.keyspace?.find((k) => k.db === i)?.keys ?? 0;
const label = (i: number) => {
  const who = usage.value.get(i);
  return `db ${i}${who ? ` · ${who.join(', ')}` : keysIn(i) ? ` · ${keysIn(i)} keys` : ' · free'}`;
};

const saving = ref(false);
async function setDb(key: 'redisDb' | 'redisCacheDb', value: number) {
  saving.value = true;
  await attempt(() => herd.updateProject(props.project.id, { [key]: value }));
  saving.value = false;
}
async function setConnDb(envKey: string, value: number) {
  saving.value = true;
  await attempt(() => herd.updateProject(props.project.id, { redisConnDbs: { [envKey]: value } }));
  saving.value = false;
}
/**
 * Lowest indexes no other site on this server uses and that hold no keys (db 0 last: it is everyone's default):
 * one for default, and for cache and each custom connection when they clash or overlap.
 */
async function pickFree() {
  const taken = new Set([...usage.value.keys(), ...(isPhp.value ? [cacheDb.value!] : [])]);
  const next = () => {
    const i = [...DBS.slice(1), 0].find((x) => !taken.has(x) && !keysIn(x));
    if (i !== undefined) taken.add(i);
    return i;
  };
  const free = next();
  if (free === undefined) return notify('error', 'No free database index on this server');
  await setDb('redisDb', free);
  if (isPhp.value && cacheDb.value !== null && (usage.value.has(cacheDb.value) || cacheDb.value === free)) {
    const cache = next();
    if (cache !== undefined) await setDb('redisCacheDb', cache);
  }
  for (const c of conns.value) {
    if (!usage.value.has(c.db) && c.db !== free && c.db !== cacheDb.value) {
      taken.add(c.db);
      continue;
    }
    const i = next();
    if (i !== undefined) await setConnDb(c.envKey, i);
  }
}
const overridden = computed(() => props.project.redisDb !== undefined || props.project.redisCacheDb !== undefined || Object.keys(props.project.redisConnDbs ?? {}).length > 0);

type Plan = Awaited<ReturnType<typeof herd.redisWriteEnv>>;
const plan = ref<Plan | null>(null);
async function previewWrite() {
  plan.value = (await attempt(() => herd.redisWriteEnv(props.project.id, false))) ?? null;
}
async function confirmWrite() {
  const done = await attempt(() => herd.redisWriteEnv(props.project.id, true));
  plan.value = null;
  if (done) notify('success', `${title.value} database written to ${done.file}`);
}
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="flex items-center gap-2">
        <StatusDot :status="project.redisStatus" />
        <img :src="DB_LOGO[flavor]" alt="" class="size-5 rounded bg-white p-px" draggable="false" />
        <h2 class="font-semibold">{{ title }}</h2>
        <span class="badge badge-ghost badge-sm">{{ project.redisStatus }}</span>
        <span v-if="details?.version" class="badge badge-ghost badge-sm">v{{ details.version }}</span>
        <div class="flex-1" />
        <DbCatzButton v-if="ownService" :conn-id="`svc:${ownService.id}`" :database="`db${dbOf(project)}`" :title="`Browse db${dbOf(project)} of ${ownService.name} in DBCatz`" />
        <button class="btn btn-ghost btn-xs" :disabled="loading" @click="load">
          <span v-if="loading" class="loading loading-spinner loading-xs" />Refresh
        </button>
      </div>

      <div class="text-xs opacity-70">
        <template v-if="r().composeFile">
          Service <code>{{ r().service }}</code> in <code>{{ r().composeFile }}</code>
          <template v-if="r().image"> · <code>{{ r().image }}</code></template>
        </template>
        <template v-else>
          {{ r().configuredBy === 'default' ? 'Default address (no REDIS_URL / REDIS_HOST in .env)' : `From ${r().configuredBy}` }}
          · <template v-if="ownService">DevCatz service <b>{{ ownService.name }}</b></template><template v-else>managed outside DevCatz</template>
        </template>
        · <code>{{ r().host }}:{{ r().port }}</code> db {{ db }}{{ r().hasPassword ? ' · password set' : '' }}
        <template v-if="r().client"> · client <code>{{ r().client }}</code></template>
      </div>

      <div v-if="details && details.status === 'running' && !details.error" class="grid grid-cols-3 gap-2 text-center text-xs">
        <div class="rounded-box bg-base-200 p-2">
          <div class="font-mono text-sm">{{ details.memory ?? '?' }}</div>
          <div class="opacity-60">memory</div>
        </div>
        <div class="rounded-box bg-base-200 p-2">
          <div class="font-mono text-sm">{{ keysIn(db) }}</div>
          <div class="opacity-60">keys in db {{ db }}</div>
        </div>
        <div class="rounded-box bg-base-200 p-2">
          <div class="font-mono text-sm">{{ details.clients ?? 0 }}</div>
          <div class="opacity-60">clients</div>
        </div>
      </div>
      <p v-if="conns.length && details?.keyspace" class="text-xs opacity-60">
        {{ conns.map((c) => `${c.name}: db ${c.db} (${keysIn(c.db)} keys)`).join(' · ') }}
      </p>
      <p v-if="details?.keyspace?.some((k) => !indexesOf(project).includes(k.db))" class="text-xs opacity-60">
        Other databases on this server: {{ details.keyspace.filter((k) => !indexesOf(project).includes(k.db)).map((k) => `db${k.db} (${k.keys} keys)`).join(', ') }}
      </p>
      <p v-if="details?.error" class="text-xs text-warning">{{ details.error }}</p>

      <div class="space-y-2 rounded-box bg-base-200/50 p-3">
        <div class="flex flex-wrap items-end gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">Database index</span>
            <select
              class="select select-sm w-56 font-mono"
              :disabled="saving"
              :value="project.redisDb ?? -1"
              @change="setDb('redisDb', Number(($event.target as HTMLSelectElement).value))"
            >
              <option :value="-1">From .env (db {{ r().db }})</option>
              <option v-for="i in DBS" :key="i" :value="i">{{ label(i) }}</option>
            </select>
          </label>
          <label v-if="isPhp" class="block">
            <span class="label-caps mb-1 block">Cache database</span>
            <select
              class="select select-sm w-56 font-mono"
              :disabled="saving"
              :value="project.redisCacheDb ?? -1"
              @change="setDb('redisCacheDb', Number(($event.target as HTMLSelectElement).value))"
            >
              <option :value="-1">From .env (db {{ r().cacheDb ?? 1 }})</option>
              <option v-for="i in DBS" :key="i" :value="i">{{ label(i) }}</option>
            </select>
          </label>
          <label v-for="c in project.stack.redis?.connections ?? []" v-show="isPhp" :key="c.envKey" class="block">
            <span class="label-caps mb-1 block" :title="`'${c.name}' in config/database.php → env('${c.envKey}')`">{{ c.name }} <span class="normal-case opacity-60">{{ c.envKey }}</span></span>
            <select
              class="select select-sm w-56 font-mono"
              :disabled="saving"
              :value="project.redisConnDbs?.[c.envKey] ?? -1"
              @change="setConnDb(c.envKey, Number(($event.target as HTMLSelectElement).value))"
            >
              <option :value="-1">{{ c.fromEnv ? 'From .env' : 'Config default' }} (db {{ c.db }})</option>
              <option v-for="i in DBS" :key="i" :value="i">{{ label(i) }}</option>
            </select>
          </label>
          <div class="flex gap-1.5">
            <button class="btn btn-sm" :disabled="saving" title="Lowest indexes no other site uses and that are empty" @click="pickFree">Pick a free one</button>
            <button v-if="overridden" class="btn btn-ghost btn-sm" :disabled="saving" @click="previewWrite">Write to .env…</button>
          </div>
        </div>

        <p v-if="ownOverlaps.length" class="text-xs text-warning">{{ ownOverlaps.join('; ') }}: keys of both end up in one database.</p>
        <p v-if="clashes.length" class="text-xs text-warning">
          <template v-for="(c, i) in clashes" :key="c.db">{{ i ? '; ' : '' }}db {{ c.db }} is also used by {{ c.sites.join(', ') }}</template>
          — a <code>FLUSHDB</code> or <code>cache:clear</code> in one clears the others.
        </p>
        <p v-if="overridden" class="text-xs opacity-60">
          DevCatz passes <code>REDIS_DB</code>{{ isPhp ? ', REDIS_CACHE_DB' : '' }}{{ Object.keys(project.redisConnDbs ?? {}).length ? `, ${Object.keys(project.redisConnDbs ?? {}).join(', ')}` : '' }}{{ r().configuredBy === 'REDIS_URL' ? ' and the REDIS_URL path' : '' }} to {{ isPhp ? 'PHP requests right away and to' : '' }}
          the processes it starts ({{ project.status === 'running' ? 'restart the site to apply' : 'from the next start' }}). .env is unchanged, so commands run in your own terminal still use it.
        </p>

        <div v-if="plan" class="space-y-2 rounded-lg border border-base-300/70 bg-base-100 p-2.5 text-xs">
          <div class="font-medium">Changes to {{ plan.file }}</div>
          <ul class="selectable space-y-0.5 font-mono">
            <li v-for="k in plan.added" :key="k" class="text-success">+ {{ k }}</li>
            <li v-for="c in plan.changed" :key="c.key">~ {{ c.key }}: <span class="opacity-60">{{ c.from }}</span> → <span class="text-primary">{{ c.to }}</span></li>
            <li v-if="!plan.added.length && !plan.changed.length" class="opacity-60">Already set; nothing to change.</li>
          </ul>
          <div class="flex justify-end gap-1.5">
            <button class="btn btn-ghost btn-xs" @click="plan = null">Cancel</button>
            <button class="btn btn-primary btn-xs" :disabled="!plan.added.length && !plan.changed.length" @click="confirmWrite">Write</button>
          </div>
        </div>
      </div>

      <div v-if="r().composeFile" class="flex gap-2">
        <button class="btn btn-sm btn-primary" :disabled="busy || project.redisStatus === 'running'" @click="emit('action', 'redis-start')">Start</button>
        <button class="btn btn-sm" :disabled="busy || project.redisStatus === 'stopped'" @click="emit('action', 'redis-stop')">Stop</button>
      </div>
    </div>
  </div>
</template>
