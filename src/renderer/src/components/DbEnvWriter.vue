<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, onMounted, ref, watch } from 'vue';
import type { DbServiceState } from '@shared/types';
import { connectionEnv, hasDatabases, type DbEnvFormat } from '@shared/dbconn';
import { attempt, herd, notify, state } from '../store';
import { isActive } from '../db';

/**
 * Connection details of a database service and its .env lines (Laravel, URL or
 * Go DSN; for this Mac or containers), copied or written into a site's .env
 * after a preview. With `siteId` the site is fixed (site Database tab).
 */
const props = defineProps<{ service: DbServiceState; siteId?: string }>();

const sites = computed(() => state.value?.projects ?? []);
const targetSite = ref(props.siteId ?? '');
const site = computed(() => sites.value.find((p) => p.id === targetSite.value) ?? null);
const format = ref<DbEnvFormat>(site.value?.stack.runtime === 'php' ? 'laravel' : site.value?.stack.runtime === 'go' ? 'go' : 'laravel');
const hostKind = ref<'local' | 'docker'>(state.value?.settings.dbEnvHost ?? 'local');
const link = ref(true);

// ---- databases on the server
const databases = ref<string[]>([]);
const database = ref('');
const newDb = ref('');
const loadingDbs = ref(false);
const withDbs = computed(() => hasDatabases(props.service.engine));
/** A name derived from the site (shop-api → shop_api), suggested for a new database. */
const siteDbName = computed(() => (site.value ? site.value.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) : ''));
async function loadDbs() {
  if (!withDbs.value) return;
  loadingDbs.value = true;
  databases.value = (await herd.dbList(props.service.id).catch(() => [])) ?? [];
  loadingDbs.value = false;
  if (!database.value || !databases.value.includes(database.value)) {
    // The database the site already uses (its .env) when the server has it, then one named after the site.
    const current = site.value?.stack.database?.database ?? null;
    database.value =
      (current && databases.value.includes(current) ? current : null) ??
      databases.value.find((d) => d === siteDbName.value) ??
      (props.service.engine === 'sqlite' ? (databases.value[0] ?? '') : siteDbName.value || databases.value[0] || '');
  }
}
onMounted(loadDbs);
watch(() => [props.service.id, props.service.status], loadDbs);
watch(siteDbName, (n) => {
  if (n && !databases.value.includes(database.value)) {
    const current = site.value?.stack.database?.database ?? null;
    database.value = current && databases.value.includes(current) ? current : n;
  }
});
async function createDb() {
  const name = newDb.value.trim() || database.value.trim();
  if (!name) return;
  const ok = await attempt(() => herd.dbCreateDatabase(props.service.id, name).then(() => true));
  if (!ok) return;
  notify('success', `${props.service.engine === 'sqlite' ? 'Database file' : 'Database'} ${name} created`);
  newDb.value = '';
  await loadDbs();
  database.value = databases.value.find((d) => d === name || d.startsWith(`${name}.`)) ?? name;
}
const exists = computed(() => !withDbs.value || props.service.engine === 'mongodb' || databases.value.includes(database.value));

// ---- the lines
// This Mac: the service's domain when it has one.
const host = computed(() => (hostKind.value === 'docker' ? 'host.docker.internal' : (props.service.host ?? '127.0.0.1')));
const conn = computed(() => ({
  engine: props.service.engine,
  host: host.value,
  port: props.service.port,
  user: props.service.user,
  password: props.service.password,
  database: props.service.engine === 'sqlite' ? (database.value ? `${props.service.resolvedDataDir}/${database.value}` : '') : database.value,
}));
const entries = computed(() => connectionEnv(conn.value, format.value));
const text = computed(() =>
  Object.entries(entries.value)
    .map(([k, v]) => `${k}=${/[\s#"'$]/.test(v) ? JSON.stringify(v) : v}`)
    .join('\n'),
);
async function copy() {
  await navigator.clipboard.writeText(text.value + '\n');
  notify('info', 'Copied');
}
const copyValue = async (v: string) => {
  await navigator.clipboard.writeText(v);
  notify('info', 'Copied');
};

// ---- write to a site's .env
type Plan = { added: string[]; changed: { key: string; from: string; to: string }[]; unchanged: string[] };
const plan = ref<Plan | null>(null);
watch([text, targetSite], () => (plan.value = null));
const comment = computed(() => `Database (DevCatz ${props.service.name})`);
async function preview() {
  if (!targetSite.value) return;
  plan.value = (await attempt(() => herd.envMerge(targetSite.value, '.env', { ...entries.value }, comment.value, false))) ?? null;
}
/** Writing a database that is not on the server breaks the site ("database … does not exist"): offer to create it first. */
const missing = computed(() => withDbs.value && props.service.engine !== 'mongodb' && !!database.value && !exists.value && !loadingDbs.value);
async function write() {
  if (!targetSite.value) return;
  if (missing.value) {
    if (!confirm(`“${database.value}” does not exist on ${props.service.name} yet. Create it (empty) and write the .env?`)) return;
    await createDb();
    if (missing.value) return;
  }
  const r = await attempt(() => herd.envMerge(targetSite.value, '.env', { ...entries.value }, comment.value, true));
  if (!r) return;
  if (link.value && site.value?.dbService !== props.service.id) await attempt(() => herd.updateProject(targetSite.value, { dbService: props.service.id }));
  notify('success', `${site.value?.name ?? 'Site'}: .env updated (${r.added.length} added, ${r.changed.length} changed)${site.value?.status === 'running' ? '. Restart the site to apply it.' : ''}`);
  plan.value = null;
}
const mask = (k: string, v: string) => (/PASSWORD/i.test(k) && v && v !== 'null' ? '••••••••' : /URL|URI|DSN/.test(k) ? v.replace(/(:\/\/[^:@/]*:)[^@]*@/, '$1••••@').replace(/password=\S+/, 'password=••••') : v || '""');
</script>

<template>
  <div class="space-y-3">
    <!-- Details -->
    <div class="grid gap-2 text-sm sm:grid-cols-3">
      <div v-if="service.engine !== 'sqlite'">
        <span class="label-caps block">Host</span>
        <code class="selectable cursor-copy" title="Copy" @click="copyValue(service.host ?? '127.0.0.1')">{{ service.host ?? '127.0.0.1' }}</code>
        <span v-if="service.host" class="ml-1 text-xs opacity-50">or 127.0.0.1</span>
      </div>
      <div v-if="service.engine !== 'sqlite'">
        <span class="label-caps block">Port</span><code class="selectable cursor-copy" title="Copy" @click="copyValue(String(service.port))">{{ service.port }}</code>
      </div>
      <div v-if="service.user">
        <span class="label-caps block">User</span><code class="selectable">{{ service.user }}</code>
      </div>
      <div v-if="service.engine !== 'sqlite' && service.engine !== 'mongodb' && service.engine !== 'elasticsearch'">
        <span class="label-caps block">Password</span>
        <code v-if="service.password" class="selectable cursor-copy" title="Copy" @click="copyValue(service.password)">••••••••</code>
        <span v-else class="text-xs opacity-60">none</span>
      </div>
      <div v-if="service.resolvedSocket" class="sm:col-span-2">
        <span class="label-caps block">Socket</span><code class="selectable cursor-copy" title="Copy" @click="copyValue(service.resolvedSocket!)">{{ service.resolvedSocket }}</code>
      </div>
      <div v-if="service.engine === 'sqlite'" class="sm:col-span-3">
        <span class="label-caps block">Folder</span><code class="selectable">{{ service.resolvedDataDir }}</code>
      </div>
    </div>

    <!-- Database -->
    <div v-if="withDbs" class="flex flex-wrap items-end gap-2">
      <label class="block">
        <span class="label-caps mb-1 block">{{ service.engine === 'sqlite' ? 'Database file' : 'Database' }}</span>
        <div class="join">
          <input v-model="database" class="input input-sm join-item w-52 font-mono" :list="`dbs-${service.id}`" spellcheck="false" :placeholder="service.engine === 'sqlite' ? 'app.sqlite' : 'database'" />
          <button type="button" class="btn btn-sm join-item" title="Reload the list" :disabled="loadingDbs" @click="loadDbs">↻</button>
        </div>
        <datalist :id="`dbs-${service.id}`">
          <option v-for="d in databases" :key="d" :value="d" />
        </datalist>
      </label>
      <button
        v-if="database && !exists && service.engine !== 'mongodb'"
        type="button"
        class="btn btn-sm"
        :disabled="service.engine !== 'sqlite' && !isActive(service)"
        :title="service.engine !== 'sqlite' && !isActive(service) ? 'Start the service first' : ''"
        @click="createDb"
      >
        Create “{{ database }}”
      </button>
      <span v-else-if="database && exists && service.engine !== 'mongodb'" class="pb-1.5 text-xs text-success">exists</span>
      <span v-if="service.engine === 'mongodb'" class="pb-1.5 text-xs opacity-60">MongoDB creates it on first write.</span>
      <span v-else-if="service.engine !== 'sqlite' && !isActive(service)" class="pb-1.5 text-xs opacity-60">Start the service to list its databases.</span>
    </div>

    <!-- Format -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="seg">
        <a class="seg-item" :class="{ 'is-active': format === 'laravel' }" @click="format = 'laravel'">Laravel</a>
        <a class="seg-item" :class="{ 'is-active': format === 'url' }" title="DATABASE_URL / REDIS_URL … (Prisma, Node, Nuxt)" @click="format = 'url'">URL</a>
        <a class="seg-item" :class="{ 'is-active': format === 'go' }" title="DSN for GORM / database/sql" @click="format = 'go'">Go</a>
      </div>
      <div v-if="service.engine !== 'sqlite'" class="seg">
        <a class="seg-item" :class="{ 'is-active': hostKind === 'local' }" :title="`Apps running on this ${words.computer}`" @click="hostKind = 'local'">This {{ words.computer }}</a>
        <a class="seg-item" :class="{ 'is-active': hostKind === 'docker' }" title="Apps in containers (host.docker.internal)" @click="hostKind = 'docker'">Docker</a>
      </div>
      <span class="flex-1" />
      <button type="button" class="btn btn-primary btn-xs" @click="copy">Copy .env lines</button>
    </div>
    <pre class="selectable overflow-x-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-6">{{ text }}</pre>

    <!-- Write -->
    <div class="space-y-2 rounded-box border border-base-300/60 p-3">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-sm font-medium">{{ siteId ? 'Write to this site’s .env' : 'Write to a site’s .env' }}</span>
        <select v-if="!siteId" v-model="targetSite" class="select select-xs w-56">
          <option value="" disabled>Choose a site…</option>
          <option v-for="p in sites" :key="p.id" :value="p.id">{{ p.name }} · {{ p.domain }}</option>
        </select>
        <button type="button" class="btn btn-xs" :disabled="!targetSite" @click="preview">Preview changes</button>
        <button type="button" class="btn btn-primary btn-xs" :disabled="!plan || (!plan.added.length && !plan.changed.length && (!link || site?.dbService === service.id))" title="Preview first" @click="write">
          Write
        </button>
      </div>
      <label v-if="targetSite && site?.dbService !== service.id" class="flex cursor-pointer items-center gap-2 text-xs">
        <input v-model="link" type="checkbox" class="checkbox checkbox-xs checkbox-primary" />
        Also link {{ site?.name }} to {{ service.name }} (it starts with the site; its Database tab manages it)
      </label>
      <div v-if="plan" class="font-mono text-xs leading-6">
        <div v-for="k in plan.added" :key="'a' + k" class="text-success">+ {{ k }}={{ mask(k, entries[k]) }}</div>
        <div v-for="c in plan.changed" :key="'c' + c.key">
          <span class="text-error">- {{ c.key }}={{ mask(c.key, c.from) }}</span><br />
          <span class="text-success">+ {{ c.key }}={{ mask(c.key, c.to) }}</span>
        </div>
        <div v-if="plan.unchanged.length" class="opacity-50">= {{ plan.unchanged.join(', ') }} (already set)</div>
        <div v-if="!plan.added.length && !plan.changed.length" class="font-sans opacity-70">Nothing to change: the .env already has these values.</div>
      </div>
      <p v-if="missing" class="text-xs text-warning">
        “{{ database }}” does not exist on {{ service.name }} yet: the site cannot connect until it is created (Write offers to create it, empty).
        <template v-if="databases.length"> Existing: {{ databases.join(', ') }}.</template>
      </p>
      <p class="text-xs opacity-60">
        Existing keys are replaced where they are; new ones are appended under <code># {{ comment }}</code>. Nothing is written before you click Write.
      </p>
    </div>
  </div>
</template>
