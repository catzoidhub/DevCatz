<script setup lang="ts">
import { STORAGE_LOGO } from '../logos';
import { computed, ref, watch } from 'vue';
import type { StorageAction, StorageKind, StorageState } from '@shared/types';
import StatusDot from './StatusDot.vue';
import StorageForm from './StorageForm.vue';
import StorageBrowser from './StorageBrowser.vue';
import LogView from './LogView.vue';
import TaskStepper from './TaskStepper.vue';
import StorageUninstall from './StorageUninstall.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import { attempt, herd, notify, state, uninstallRequest } from '../store';
import { navVisit } from '../nav';
import CatMood from './CatMood.vue';

/** Object storage: RustFS, MinIO and SeaweedFS (one instance each), buckets, connection details and logs. */
const services = computed(() => state.value?.storage ?? []);
const selectedKind = ref<StorageKind | null>(null);
const selected = computed(() => services.value.find((s) => s.kind === selectedKind.value) ?? null);
const installedServices = computed(() => services.value.filter((s) => s.installed));
const props = defineProps<{ focus?: string | null }>();
// First installed service, else the first engine (its install page).
watch(
  services,
  (list) => {
    if (!selectedKind.value) selectedKind.value = list.find((s) => s.installed)?.kind ?? list[0]?.kind ?? null;
  },
  { immediate: true },
);
watch(
  () => props.focus,
  (k) => k && services.value.some((s) => s.kind === k) && (selectedKind.value = k as StorageKind),
  { immediate: true },
);
const runningCount = computed(() => services.value.filter((s) => active(s)).length);
// Back / forward history: each service shown is a step.
watch(selectedKind, (k) => navVisit({ section: 'storage', item: k }), { immediate: true });
/** Header "More" menu of the selected service. */
const moreItems = computed<MenuItem[]>(() => {
  const s = selected.value;
  if (!s?.installed || !s.urls) return [];
  return [
    { label: 'Open API', action: () => open(s.urls!.api) },
    { label: 'Open data folder', action: () => herd.storageOpenData(s.kind) },
    { label: 'Check for updates', action: checkUpdates },
    { label: 'Settings…', action: () => (form.value = { service: s, mode: 'edit' }) },
    { label: 'Uninstall…', action: () => uninstall(s) },
  ];
});

type Tab = 'buckets' | 'connection' | 'logs';
const tab = ref<Tab>('buckets');
const form = ref<{ service: StorageState; mode: 'install' | 'edit' } | null>(null);
const busy = ref<string | null>(null);

/** Official logos (see assets/logos/SOURCES.md). */
const LOGO = STORAGE_LOGO;
const active = (s: StorageState) => s.status === 'running' || s.status === 'starting';

/** Newer release: download, swap the binary, restart (data and settings stay). */
async function upgrade(s: StorageState) {
  busy.value = `${s.kind}:update`;
  await attempt(() => herd.storageUpgrade(s.kind).then(() => true), `${s.name} updated`);
  busy.value = null;
}
async function checkUpdates() {
  const failed = await attempt(() => herd.servicesCheckUpdates());
  if (!failed) return;
  const s = selected.value;
  if (s && failed.includes(s.name)) notify('error', `Could not check ${s.name} for updates (offline, or GitHub's hourly limit; try again later)`);
  else notify('info', s?.update ? `${s.name} ${s.update} is available` : `${s?.name ?? 'Everything'} is up to date`);
}
const updating = (s: StorageState) => s.task?.kind === 'update' && !s.task.done && !s.task.error;
async function act(s: StorageState, action: StorageAction) {
  busy.value = `${s.kind}:${action}`;
  await attempt(() => herd.storageAction(s.kind, action));
  busy.value = null;
}
/** Opens the typed-confirmation dialog. */
const uninstalling = ref<StorageKind | null>(null);
const uninstall = (s: StorageState) => (uninstalling.value = s.kind);

// Ask DevCatz's "Uninstall …" opens this page's own dialog (with its typed confirmation); nothing is removed without it.
watch(
  uninstallRequest,
  (r) => {
    if (r?.scope !== 'storage') return;
    uninstallRequest.value = null;
    const s = services.value.find((x) => x.kind === r.id && x.installed);
    if (s) {
      selectedKind.value = s.kind;
      uninstalling.value = s.kind;
    }
  },
  { immediate: true },
);
function open(url: string) {
  herd.openUrl(url);
}

// ---- connection (.env) snippets
const bucketForEnv = ref('');
const endpointKind = ref<'domain' | 'local' | 'docker'>(state.value?.settings.s3EnvEndpoint ?? 'domain');
const region = computed(() => selected.value?.config?.region || state.value?.settings.s3Region || 'us-east-1');
const flavor = ref<'laravel' | 'node'>('laravel');
const endpoint = computed(() => {
  const s = selected.value;
  if (!s?.urls || !s.config) return '';
  if (endpointKind.value === 'domain') return s.urls.api;
  if (endpointKind.value === 'local') return s.urls.apiLocal;
  return `http://host.docker.internal:${s.config.apiPort}`;
});
const envText = computed(() => {
  const s = selected.value;
  if (!s?.config) return '';
  const b = bucketForEnv.value || 'my-bucket';
  const url = `${endpoint.value}/${b}`;
  return flavor.value === 'laravel'
    ? [
        'FILESYSTEM_DISK=s3',
        `AWS_ACCESS_KEY_ID=${s.config.accessKey}`,
        `AWS_SECRET_ACCESS_KEY=${s.config.secretKey}`,
        `AWS_DEFAULT_REGION=${region.value}`,
        `AWS_BUCKET=${b}`,
        `AWS_ENDPOINT=${endpoint.value}`,
        `AWS_URL=${url}`,
        'AWS_USE_PATH_STYLE_ENDPOINT=true',
      ].join('\n')
    : [
        `S3_ENDPOINT=${endpoint.value}`,
        `S3_REGION=${region.value}`,
        `S3_BUCKET=${b}`,
        `S3_ACCESS_KEY=${s.config.accessKey}`,
        `S3_SECRET_KEY=${s.config.secretKey}`,
        'S3_FORCE_PATH_STYLE=true',
        `S3_PUBLIC_URL=${url}`,
      ].join('\n');
});
// ---- write into a site's .env (preview first)
type Plan = { added: string[]; changed: { key: string; from: string; to: string }[]; unchanged: string[] };
const sites = computed(() => state.value?.projects ?? []);
const targetSite = ref('');
const plan = ref<Plan | null>(null);
const entries = computed(() =>
  Object.fromEntries(
    envText.value
      .split('\n')
      .filter((l) => l.includes('='))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  ),
);
// The preview goes stale when the options change.
watch([envText, targetSite], () => (plan.value = null));
async function previewWrite() {
  if (!targetSite.value || !selected.value) return;
  plan.value = (await attempt(() => herd.envMerge(targetSite.value, '.env', { ...entries.value }, `S3 (DevCatz ${selected.value!.name})`, false))) ?? null;
}
async function write() {
  if (!targetSite.value || !selected.value) return;
  const r = await attempt(() => herd.envMerge(targetSite.value, '.env', { ...entries.value }, `S3 (DevCatz ${selected.value!.name})`, true));
  if (!r) return;
  const site = sites.value.find((p) => p.id === targetSite.value);
  notify('success', `${site?.name ?? 'Site'}: .env updated (${r.added.length} added, ${r.changed.length} changed)${site?.status === 'running' ? '. Restart the site to apply it.' : ''}`);
  plan.value = null;
}
const mask = (k: string, v: string) => (/SECRET|PASSWORD/i.test(k) ? '••••••••' : v || '""');

async function copyEnv() {
  await navigator.clipboard.writeText(envText.value + '\n');
  notify('info', 'Copied. Paste it into the site’s .env (Env tab).');
}
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <!-- Engines (same shell as the Database sidebar) -->
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip h-14 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
      <div class="flex items-center gap-2 px-4 pb-1">
        <span class="label-caps">Object storage</span>
        <span v-if="runningCount" class="badge badge-success badge-soft badge-xs">{{ runningCount }} running</span>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap overflow-y-auto px-2">
        <li v-for="s in services" :key="s.kind">
          <a :class="{ 'menu-active': s.kind === selectedKind }" @click="selectedKind = s.kind">
            <img :src="LOGO[s.kind]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ s.name }}</div>
              <div class="truncate font-mono text-[11px] opacity-60">
                <template v-if="s.installed">{{ s.config?.version }} · :{{ s.config?.apiPort }}<span v-if="s.update" class="ml-1 font-sans text-warning" :title="`${s.update} available`">· update</span></template>
                <template v-else>Not installed</template>
              </div>
              <div v-if="s.task && !s.task.done" class="mt-1">
                <progress class="progress h-1 w-full" :class="s.task.error ? 'progress-error' : 'progress-primary'" :value="s.task.error ? 100 : s.task.step" :max="s.task.steps.length" />
                <div class="truncate text-[10px]" :class="s.task.error ? 'text-error' : 'opacity-60'">{{ s.task.error ?? s.task.steps[s.task.step] }}</div>
              </div>
            </div>
            <template v-if="s.installed">
              <StatusDot :status="s.status" />
              <button class="btn btn-ghost btn-xs btn-square" :title="active(s) ? 'Stop' : 'Start'" :disabled="!!busy || s.status === 'stopping'" @click.stop="act(s, active(s) ? 'stop' : 'start')">
                <svg v-if="active(s)" class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><rect x="5" y="5" width="10" height="10" rx="1.5" /></svg>
                <svg v-else class="size-3.5" viewBox="0 0 20 20" fill="currentColor"><path d="M6.3 4.2A1 1 0 0 0 5 5.1v9.8a1 1 0 0 0 1.5.9l8-4.9a1 1 0 0 0 0-1.8l-8-4.9Z" /></svg>
              </button>
            </template>
            <span v-else class="badge badge-ghost badge-xs">install</span>
          </a>
        </li>
      </ul>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <!-- Not installed: its install page -->
      <template v-if="selected && !selected.installed">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex items-center gap-3">
            <img :src="LOGO[selected.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0">
              <h2 class="text-lg font-semibold tracking-tight">{{ selected.name }}</h2>
              <div class="text-xs opacity-60">Not installed</div>
            </div>
          </div>
        </header>
        <div class="flex-1 overflow-y-auto p-6">
          <div class="mx-auto max-w-xl space-y-4 pt-6">
            <p class="text-sm opacity-70">{{ selected.description }}</p>
            <TaskStepper v-if="selected.task && !form" :task="selected.task" :cancellable="selected.task.kind === 'install'" dismissable @dismiss="herd.taskDismiss('storage', selected.kind)" @cancel="herd.storageCancelInstall(selected.kind)" />
            <button class="btn btn-primary" :disabled="!!selected.task && !selected.task.done && !selected.task.error" @click="form = { service: selected, mode: 'install' }">
              <span v-if="selected.task && !selected.task.done && !selected.task.error" class="loading loading-spinner loading-xs" />Install {{ selected.name }}…
            </button>
            <p class="text-xs opacity-60">Ports, domains, data folder and keys are chosen before the download; the official build is checksum-verified.</p>
          </div>
        </div>
      </template>

      <template v-else-if="selected?.installed && selected.config && selected.urls">
        <header class="drag border-b border-base-300/60 px-6 pt-5 pb-3">
          <div class="flex flex-wrap items-center gap-3">
            <img :src="LOGO[selected.kind]" alt="" class="size-11 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                {{ selected.name }}
                <StatusDot :status="selected.status" />
                <span class="badge badge-soft badge-sm" :class="selected.status === 'running' ? 'badge-success' : selected.status === 'starting' ? 'badge-warning' : selected.status === 'crashed' ? 'badge-error' : 'badge-ghost'">{{ selected.status }}</span>
              </h2>
              <div class="font-mono text-xs opacity-60">{{ selected.config.version }} · 127.0.0.1:{{ selected.config.apiPort }}<template v-if="selected.config.autoStart"> · starts with DevCatz</template></div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-2">
            <button v-if="selected.update" class="btn btn-warning btn-soft btn-sm" :disabled="!!busy || updating(selected)" :title="`${selected.config.version} → ${selected.update}: the data folder and settings stay`" @click="upgrade(selected)">
              <span v-if="updating(selected) || busy === `${selected.kind}:update`" class="loading loading-spinner loading-xs" />Update to {{ selected.update }}
            </button>
            <button v-if="!active(selected)" class="btn btn-primary btn-sm" :disabled="!!busy" @click="act(selected, 'start')">
              <span v-if="busy === `${selected.kind}:start`" class="loading loading-spinner loading-xs" />Start
            </button>
            <button v-else class="btn btn-sm" :disabled="!!busy || selected.status === 'stopping'" @click="act(selected, 'stop')">Stop</button>
            <button class="btn btn-sm" :disabled="!!busy || !active(selected)" @click="act(selected, 'restart')">Restart</button>
            <button class="btn btn-sm" :disabled="!active(selected)" @click="open(selected.urls.console)">Open Console</button>
            <PopMenu :items="moreItems" align="end" :width="220">
              <button class="btn btn-sm">More ▾</button>
            </PopMenu>
            </div>
          </div>
          <div role="tablist" class="seg no-drag mt-3">
            <a v-for="t in ['buckets', 'connection', 'logs'] as Tab[]" :key="t" role="tab" class="seg-item" :class="{ 'is-active': tab === t }" @click="tab = t">{{ t }}</a>
          </div>
        </header>

        <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
          <div v-if="selected.error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ selected.error }}</div>
          <TaskStepper v-if="selected.task && !form" :task="selected.task" compact dismissable @dismiss="herd.taskDismiss('storage', selected.kind)" />
          <div class="grid gap-2 sm:grid-cols-2">
            <a class="url-chip w-full" :title="`S3 API · 127.0.0.1:${selected.config.apiPort}`" @click="open(selected.urls.api)">
              <span class="badge badge-ghost badge-xs font-sans">API</span>
              <span class="truncate">{{ selected.urls.api.replace('https://', '') }}</span>
              <span class="ml-auto font-sans text-[10px] opacity-60">:{{ selected.config.apiPort }}</span>
            </a>
            <a class="url-chip w-full" :title="`Console · 127.0.0.1:${selected.config.consolePort}`" @click="open(selected.urls.console)">
              <span class="badge badge-ghost badge-xs font-sans">Console</span>
              <span class="truncate">{{ selected.urls.console.replace('https://', '') }}</span>
              <span class="ml-auto font-sans text-[10px] opacity-60">:{{ selected.config.consolePort }}</span>
            </a>
          </div>

          <StorageBrowser v-if="tab === 'buckets'" :key="selected.kind" :service="selected" @bucket="(b) => (bucketForEnv = b ?? '')" />

          <div v-else-if="tab === 'connection'" class="space-y-3">
            <div class="grid gap-2 text-sm sm:grid-cols-2">
              <div><span class="label-caps block">Endpoint (HTTPS)</span><code class="selectable">{{ selected.urls.api }}</code></div>
              <div><span class="label-caps block">Endpoint (local)</span><code class="selectable">{{ selected.urls.apiLocal }}</code></div>
              <div><span class="label-caps block">Access key</span><code class="selectable">{{ selected.config.accessKey }}</code></div>
              <div><span class="label-caps block">Secret key</span><code class="selectable">{{ selected.config.secretKey }}</code></div>
              <div><span class="label-caps block">Region</span><code>{{ region }}</code></div>
              <div><span class="label-caps block">Data folder</span><code class="selectable break-all">{{ selected.config.dataDir }}</code></div>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <div class="seg">
                <a class="seg-item" :class="{ 'is-active': flavor === 'laravel' }" @click="flavor = 'laravel'">Laravel</a>
                <a class="seg-item" :class="{ 'is-active': flavor === 'node' }" @click="flavor = 'node'">Node / Go</a>
              </div>
              <div class="seg">
                <a class="seg-item" :class="{ 'is-active': endpointKind === 'domain' }" title="Through DevCatz's HTTPS proxy (browsers, PHP with DevCatz's php.ini)" @click="endpointKind = 'domain'">HTTPS domain</a>
                <a class="seg-item" :class="{ 'is-active': endpointKind === 'local' }" title="Straight to the port: no certificate needed" @click="endpointKind = 'local'">127.0.0.1</a>
                <a class="seg-item" :class="{ 'is-active': endpointKind === 'docker' }" title="From containers" @click="endpointKind = 'docker'">Docker</a>
              </div>
              <input v-model="bucketForEnv" class="input input-xs w-36 font-mono" placeholder="bucket" spellcheck="false" />
              <span class="flex-1" />
              <button class="btn btn-primary btn-xs" @click="copyEnv">Copy .env lines</button>
            </div>
            <pre class="selectable overflow-x-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-6">{{ envText }}</pre>

            <!-- Write to a site's .env -->
            <div class="space-y-2 rounded-box border border-base-300/60 p-3">
              <div class="flex flex-wrap items-center gap-2">
                <span class="text-sm font-medium">Write to a site’s .env</span>
                <select v-model="targetSite" class="select select-xs w-56">
                  <option value="" disabled>Choose a site…</option>
                  <option v-for="p in sites" :key="p.id" :value="p.id">{{ p.name }} · {{ p.domain }}</option>
                </select>
                <button class="btn btn-xs" :disabled="!targetSite" @click="previewWrite">Preview changes</button>
                <button class="btn btn-primary btn-xs" :disabled="!plan || (!plan.added.length && !plan.changed.length)" title="Preview first" @click="write">Write</button>
              </div>
              <div v-if="plan" class="font-mono text-xs leading-6">
                <div v-for="k in plan.added" :key="'a' + k" class="text-success">+ {{ k }}={{ mask(k, entries[k]) }}</div>
                <div v-for="c in plan.changed" :key="'c' + c.key">
                  <span class="text-error">- {{ c.key }}={{ mask(c.key, c.from) }}</span><br />
                  <span class="text-success">+ {{ c.key }}={{ mask(c.key, c.to) }}</span>
                </div>
                <div v-if="plan.unchanged.length" class="opacity-50">= {{ plan.unchanged.join(', ') }} (already set)</div>
                <div v-if="!plan.added.length && !plan.changed.length" class="font-sans opacity-70">Nothing to change: the .env already has these values.</div>
              </div>
              <p class="text-xs opacity-60">Existing keys are replaced where they are; new ones are appended under <code># S3 (DevCatz {{ selected.name }})</code>. Nothing is written before you click Write. A site's own Storage tab does the same with a bucket picker.</p>
            </div>
            <p class="text-xs opacity-60">
              Public files: <code>{{ endpoint }}/&lt;bucket&gt;/&lt;key&gt;</code> once the bucket is public (Buckets tab). Node apps that call the HTTPS domain
              need DevCatz's CA (<code>NODE_EXTRA_CA_CERTS</code>) or the 127.0.0.1 endpoint.
            </p>
          </div>

          <div v-else class="min-h-[28rem] flex-1">
            <LogView :key="selected.kind" :project-id="`storage:${selected.kind}`" />
          </div>
        </div>
      </template>
    </main>
  </div>

  <StorageUninstall
    v-if="uninstalling && services.find((x) => x.kind === uninstalling)?.installed"
    :service="services.find((x) => x.kind === uninstalling)!"
    @close="uninstalling = null"
  />
  <!-- The live service (not the snapshot taken when the window opened): install progress updates it. -->
  <StorageForm v-if="form" :service="services.find((x) => x.kind === form!.service.kind) ?? form.service" :mode="form.mode" @close="form = null" @done="form = null" />
</template>
