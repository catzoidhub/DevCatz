<script setup lang="ts">
import { confirmOverwrite } from '../confirms';
import { words } from '@shared/platform';
import { isWin } from '../platform';
import { diff } from '../linediff';
import AiDocker from './AiDocker.vue';
import DockerFileDialog from './DockerFileDialog.vue';
import DockerFilesCard from './DockerFilesCard.vue';
import DoCatzButton from './DoCatzButton.vue';
import { aiOn } from '../ai';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComposeEnvPlan, DevComposePreview, DevServiceKind, DockerAction, DockerEngineId, DockerGenOptions, DockerTarget, DockerComposeFile, DockerFile, DockerService, DockerStatus, ProjectState } from '@shared/types';
import { attempt, herd, notify } from '../store';
const aiDockerOn = aiOn('docker');

/** `desktop`: an Electron / Tauri app — it ships as an installer, so only its development services run here (no deploy files). */
const props = defineProps<{ project: ProjectState; desktop?: boolean }>();
const emit = defineEmits<{ logs: [] }>();

const status = ref<DockerStatus | null>(null);
const files = ref<DockerComposeFile[]>([]);
const file = ref<string>('');
const services = ref<DockerService[]>([]);
const busy = ref<string | null>(null);

const ready = computed(() => Boolean(status.value?.daemon));

/** Same order as the main process: most recommended first. */
// Windows: OrbStack, Colima and Finch are macOS-only.
type EngineCard = { id: DockerEngineId; name: string; start: string; download: string; macOnly?: boolean };
const ENGINES: EngineCard[] = ([
  { id: 'docatz', name: 'DoCatz', start: 'Open DoCatz', download: 'https://catzoid.com/docatz/download' },
  { id: 'orbstack', name: 'OrbStack', start: 'Open OrbStack', download: 'https://orbstack.dev/download', macOnly: true },
  { id: 'docker-desktop', name: 'Docker Desktop', start: 'Open Docker Desktop', download: 'https://www.docker.com/products/docker-desktop/' },
  { id: 'colima', name: 'Colima', start: 'colima start', download: 'https://github.com/abiosoft/colima#installation', macOnly: true },
  { id: 'rancher', name: 'Rancher Desktop', start: 'Open Rancher Desktop', download: 'https://rancherdesktop.io/' },
  { id: 'podman', name: 'Podman', start: 'Start Podman', download: 'https://podman-desktop.io/downloads' },
  { id: 'finch', name: 'Finch', start: 'finch vm start', download: 'https://github.com/runfinch/finch/releases', macOnly: true },
] as EngineCard[]).filter((e) => !(isWin && e.macOnly));
const engineName = (id: DockerEngineId | null) => ENGINES.find((e) => e.id === id)?.name ?? 'Container engine';
// DoCatz has its own button (Open in DoCatz / Download & Install) in the alert: not a second one here.
const installedEngines = computed(() => ENGINES.filter((e) => e.id !== 'docatz' && status.value?.installed.includes(e.id)));
const starting = ref<DockerEngineId | null>(null);
async function start(id: DockerEngineId) {
  starting.value = id;
  await attempt(() => herd.startEngine(id));
  starting.value = null;
  void refresh();
}
const current = computed(() => files.value.find((f) => f.file === file.value) ?? null);
/** A compose file that builds the app itself: then the tab only runs it. */
const existingSetup = computed(() => files.value.some((f) => f.build && !f.generated));

async function refresh() {
  status.value = await herd.dockerStatus().catch(() => null);
  files.value = await herd.dockerFiles(props.project.id).catch(() => []);
  if (!files.value.some((f) => f.file === file.value)) file.value = files.value.find((f) => f.build)?.file ?? files.value[0]?.file ?? '';
  services.value = ready.value && file.value ? await herd.dockerServices(props.project.id, file.value).catch(() => []) : [];
}
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void refresh();
  timer = setInterval(() => void refresh(), 4000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(file, () => void refresh());

async function compose(action: DockerAction, service?: string) {
  if (!file.value) return;
  busy.value = `${action}:${service ?? ''}`;
  if (action === 'logs') emit('logs');
  else if (action === 'up' || action === 'build') notify('info', 'Building… the output streams into the Logs tab.');
  const ok = await attempt(() => herd.dockerCompose(props.project.id, file.value, action, service).then(() => true));
  busy.value = null;
  if (ok && action === 'up') notify('success', 'Containers are up. OrbStack serves them at the URLs below.');
  await refresh();
}

// ---------------------------------------------------------------- generator
type Preview = { files: (DockerFile & { pick: boolean; orig: string })[]; composeFile: string; project: string; options: DockerGenOptions; mrcatzDetected: boolean };
const preview = ref<Preview | null>(null);
const laravel = computed(() => props.project.stack.apps.some((a) => a.framework === 'laravel'));
/** Files changed in the preview (by hand or with AI), written as they are. */
const edited = computed(() => Object.fromEntries((preview.value?.files ?? []).filter((f) => f.content !== f.orig).map((f) => [f.path, f.content])));
/** The preview file open in the dialog. */
const openPath = ref<string | null>(null);
const openFile = computed(() => preview.value?.files.find((f) => f.path === openPath.value) ?? null);
/** Bumped after writing, so the Docker files card reloads. */
const filesVersion = ref(0);
async function generate(options: Partial<DockerGenOptions> = {}) {
  // Changing an option regenerates every file: edits would be lost.
  if (Object.keys(edited.value).length && !confirm('Regenerating replaces the files you edited in the preview. Go on?')) return;
  const r = await attempt(() => herd.dockerGenerate(props.project.id, options));
  if (!r) return;
  // New files are picked; existing ones only when the user ticks them (never overwritten silently).
  preview.value = { ...r, files: r.files.map((f) => ({ ...f, pick: f.current === null, orig: f.content })) };
}
/** Target switch resets the other options to that target's defaults. */
const setTarget = (target: DockerTarget) => generate({ target });
const setEnvFile = (envFile: 'docker' | 'project') => preview.value && generate({ ...preview.value.options, envFile });
const setOption = (key: 'withServices' | 'worker' | 'scheduler' | 'split' | 'mrcatzDatatable' | 'dokployNetwork', on: boolean) => preview.value && generate({ ...preview.value.options, [key]: on });
async function write() {
  const pv = preview.value;
  if (!pv) return;
  const picked = pv.files.filter((f) => f.pick && !f.same);
  const existing = picked.filter((f) => f.current !== null).map((f) => f.path);
  if (existing.length && !(await confirmOverwrite(existing))) return;
  const written = await attempt(() =>
    herd.dockerWrite(
      props.project.id,
      // A plain copy: IPC cannot clone Vue's reactive proxies ("An object could not be cloned").
      { ...pv.options },
      picked.map((f) => f.path),
      picked.filter((f) => f.current !== null).map((f) => f.path),
      { ...edited.value },
    ),
  );
  if (written?.length) {
    notify('success', `Wrote ${written.join(', ')}`);
    preview.value = null;
    await refresh();
    file.value = pv.composeFile;
    filesVersion.value++;
  }
}


// ------------------------------------------------- which engine: DoCatz or the system's context
/** Runs on DoCatz while its engine runs (default), or on the system's current context (Settings key dockerEngine). */
async function useEngine(which: 'docatz' | 'system') {
  await attempt(() => herd.updateSettings({ dockerEngine: which }));
  await refresh();
  const now: DockerStatus | null = status.value;
  notify('success', which === 'docatz' ? 'Containers now run on DoCatz' : `Containers now run on ${engineName(now?.engine ?? null)}`);
}

// ------------------------------------------------- start with the app, .env
/** The compose file whose services start and stop with the site. */
const withApp = computed(() => props.project.composeWithApp ?? null);
async function setWithApp(on: boolean) {
  await attempt(() => herd.updateProject(props.project.id, { composeWithApp: on ? file.value : '', composeOffered: true }));
}
/** Asked once per site: its compose file is there, nothing starts with it yet. */
const offerWithApp = computed(() => !!files.value.length && !withApp.value && !props.project.composeOffered);
const dismissOffer = () => attempt(() => herd.updateProject(props.project.id, { composeOffered: true }));

const envPlan = ref<ComposeEnvPlan | null>(null);
async function previewEnv() {
  envPlan.value = (await attempt(() => herd.dockerComposeEnv(props.project.id, file.value, false))) ?? null;
}
async function writeEnv() {
  const done = await attempt(() => herd.dockerComposeEnv(props.project.id, file.value, true));
  envPlan.value = null;
  if (done) notify('success', `Services written to ${done.file}`);
}

// ---------------------------------------------------- development services
const dev = ref<DevComposePreview | null>(null);
const devContent = ref('');
const devOpen = ref(false);
async function devPreview(services?: DevServiceKind[]) {
  const r = await attempt(() => herd.dockerDevPreview(props.project.id, services));
  if (!r) return;
  dev.value = r;
  devContent.value = r.content;
}
const toggleDev = (kind: DevServiceKind, on: boolean) => {
  const picked = (dev.value?.services ?? []).filter((x) => (x.kind === kind ? on : x.picked)).map((x) => x.kind);
  // MySQL and MariaDB share port 3306 inside: one of them.
  void devPreview(on && (kind === 'mysql' || kind === 'mariadb') ? picked.filter((k) => k !== (kind === 'mysql' ? 'mariadb' : 'mysql')) : picked);
};
async function devWrite() {
  const pv = dev.value;
  if (!pv) return;
  if (pv.current !== null && pv.current !== devContent.value && !(await confirmOverwrite([pv.path]))) return;
  const picked = pv.services.filter((x) => x.picked).map((x) => x.kind);
  const path = await attempt(() => herd.dockerDevWrite(props.project.id, picked, devContent.value !== pv.content ? devContent.value : undefined));
  if (!path) return;
  dev.value = null;
  notify('success', `Wrote ${path}; its services now start with the ${props.desktop ? 'app' : 'site'}.`);
  await refresh();
  file.value = path;
  filesVersion.value++;
  void previewEnv();
}

const stateClass = (s: string) => (s === 'running' ? 'badge-success' : s === 'exited' || s === 'dead' ? 'badge-error' : 'badge-ghost');
</script>

<template>
  <div class="space-y-5">
    <!-- ✦ AI: explain the last Docker output, adjust a Docker file (Settings → AI). -->
    <AiDocker v-if="aiDockerOn" :site-id="project.id" />
    <!-- Availability -->
    <div v-if="!status" class="text-xs opacity-60"><span class="loading loading-spinner loading-xs" /> Checking Docker…</div>
    <div v-else-if="!ready" role="alert" class="alert items-start">
      <div class="flex-1 space-y-1">
        <div class="font-medium">{{ installedEngines.length ? 'No container engine is running' : 'No container engine installed' }}</div>
        <div class="text-xs opacity-70">
          <template v-if="installedEngines.length">
            Start one of them, or use <b>DoCatz</b>; this tab re-checks every few seconds.
            <span v-if="status.error" class="block font-mono opacity-60">{{ status.error }}</span>
          </template>
          <template v-else>
            <b>DoCatz</b>, the Catzoid container manager, is recommended: a light engine for Docker and Compose, and every container, image and volume
            in one window. Any other Docker-compatible engine works too; containers are published on <code>127.0.0.1</code> ports.
          </template>
        </div>
        <div class="flex flex-wrap items-center gap-1.5 pt-1">
          <DoCatzButton :site-id="project.id" :file="file || null" primary />
          <button v-for="e in installedEngines" :key="e.id" class="btn btn-sm" :disabled="!!starting" @click="start(e.id)">
            <span v-if="starting === e.id" class="loading loading-spinner loading-xs" />{{ e.start }}
          </button>
          <template v-if="!installedEngines.length">
            <span class="ml-1 text-xs opacity-60">or</span>
            <a v-for="e in ENGINES.filter((x) => x.id !== 'docatz')" :key="e.id" class="link link-hover text-xs opacity-70" @click="herd.openUrl(e.download)">{{ e.name }}</a>
          </template>
        </div>
      </div>
    </div>
    <!-- Engines: DoCatz first, then the system's current context; the one in use is marked, another one is a click away. -->
    <div v-else class="flex items-start gap-3">
      <ul class="min-w-0 flex-1 space-y-1 text-xs">
        <li v-for="e in status.engines.length ? status.engines : [{ id: status.engine ?? 'other', context: status.context ?? '', running: true, used: true }]" :key="e.id + e.context" class="flex flex-wrap items-center gap-x-2 gap-y-0.5" :class="{ 'opacity-60': !e.used }">
          <span class="status" :class="e.running ? 'status-success' : 'status-neutral'" />
          <span :class="{ 'font-medium': e.used }">{{ engineName(e.id) }} {{ e.running ? 'running' : 'stopped' }}</span>
          <template v-if="e.context">· context <code>{{ e.context }}</code></template>
          <template v-if="e.used">
            <span class="badge badge-primary badge-soft badge-xs">in use</span>
            <template v-if="!status.orbLocal">· containers on <code>127.0.0.1</code> ports</template>
          </template>
          <template v-else-if="e.running">·</template>
          <a v-if="!e.used && e.running" class="link link-hover" :title="`Run this site's containers on ${engineName(e.id)}`" @click="useEngine(e.id === 'docatz' ? 'docatz' : 'system')">use {{ engineName(e.id) }}</a>
          <span v-else-if="e.id === 'docatz'">· start its engine in DoCatz to run containers there</span>
        </li>
      </ul>
      <DoCatzButton v-if="!files.length" :site-id="project.id" />
    </div>

    <!-- Compose -->
    <div v-if="files.length" class="card">
      <div class="card-body">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="flex-1 font-semibold">Containers</h2>
          <DoCatzButton v-if="file" :site-id="project.id" :file="file" />
          <select v-model="file" class="select select-sm w-auto">
            <option v-for="f in files" :key="f.file" :value="f.file">{{ f.file }}{{ f.generated ? ' (generated)' : f.build ? '' : ' (no app build)' }}</option>
          </select>
        </div>
        <div class="flex flex-wrap gap-1.5">
          <button class="btn btn-primary btn-sm" :disabled="!ready || !!busy" @click="compose('up')">
            <span v-if="busy === 'up:'" class="loading loading-spinner loading-xs" />{{ current?.build ? 'Build & Up' : 'Up' }}
          </button>
          <button class="btn btn-sm" :disabled="!ready || !!busy" @click="compose('down')"><span v-if="busy === 'down:'" class="loading loading-spinner loading-xs" />Down</button>
          <button class="btn btn-sm" :disabled="!ready || !!busy || !services.length" @click="compose('restart')">Restart</button>
          <button class="btn btn-sm" :disabled="!ready || !!busy" @click="compose('build')"><span v-if="busy === 'build:'" class="loading loading-spinner loading-xs" />Build only</button>
          <button class="btn btn-sm btn-ghost" :disabled="!ready || !services.length" @click="compose('logs')">Logs</button>
        </div>
        <p class="text-xs opacity-60">
          <code>docker compose -f {{ file }}{{ current?.project ? ` -p ${current.project}` : '' }}</code>; output goes to the Logs tab.
        </p>
        <div v-if="offerWithApp" role="alert" class="alert alert-info alert-soft items-start py-2 text-xs">
          <div class="flex-1">
            Start the services of <code>{{ file }}</code> when you start this {{ desktop ? 'app' : 'site' }}, and stop them with it?
            The {{ desktop ? 'app' : 'site' }} then finds its database ready.
          </div>
          <button class="btn btn-primary btn-xs" @click="setWithApp(true)">Yes</button>
          <button class="btn btn-ghost btn-xs" @click="dismissOffer">No thanks</button>
        </div>
        <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
          <label class="flex cursor-pointer items-center gap-2" :title="`Start: docker compose up -d --wait before the ${desktop ? 'app' : 'site'}. Stop: docker compose stop (containers and data stay).`">
            <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="withApp === file" @change="setWithApp(($event.target as HTMLInputElement).checked)" />
            Start with the {{ desktop ? 'app' : 'site' }}
          </label>
          <span v-if="withApp && withApp !== file" class="text-xs opacity-60"><code>{{ withApp }}</code> starts with it now</span>
          <button class="btn btn-ghost btn-xs" title="Point .env at these services: 127.0.0.1 and their published ports" @click="previewEnv">Use in .env…</button>
        </div>
        <div v-if="envPlan" class="space-y-2 rounded-lg border border-base-300/70 bg-base-100 p-2.5 text-xs">
          <div class="font-medium">
            Changes to {{ envPlan.file }}
            <span class="font-normal opacity-60">from {{ envPlan.sources.map((s) => `${s.service} (:${s.port})`).join(', ') }}</span>
          </div>
          <ul class="space-y-0.5 font-mono">
            <li v-for="k in envPlan.added" :key="k" class="text-success">+ {{ k }}</li>
            <li v-for="c in envPlan.changed" :key="c.key">~ {{ c.key }}: <span class="opacity-60">{{ c.from }}</span> → <span class="text-primary">{{ c.to }}</span></li>
            <li v-if="!envPlan.added.length && !envPlan.changed.length" class="opacity-60">Already set; nothing to change.</li>
          </ul>
          <div class="flex justify-end gap-1.5">
            <button class="btn btn-ghost btn-xs" @click="envPlan = null">Cancel</button>
            <button class="btn btn-primary btn-xs" :disabled="!envPlan.added.length && !envPlan.changed.length" @click="writeEnv">Write</button>
          </div>
        </div>
        <div v-if="services.length" class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead><tr><th>Service</th><th>State</th><th>URL</th><th class="text-right"></th></tr></thead>
            <tbody>
              <tr v-for="s in services" :key="s.service">
                <td class="font-medium">{{ s.service }}</td>
                <td>
                  <span class="badge badge-sm" :class="stateClass(s.state)">{{ s.state }}</span>
                  <span v-if="s.health" class="ml-1 text-xs opacity-60">{{ s.health }}</span>
                  <div class="text-xs opacity-50">{{ s.status }}</div>
                </td>
                <td>
                  <a v-if="s.url" class="link link-primary text-xs" @click="herd.openUrl(s.url!)">{{ s.url.replace(/^https?:\/\//, '') }}</a>
                  <span v-else class="text-xs opacity-50">not published</span>
                  <div v-if="s.published.length" class="text-xs opacity-50">ports {{ s.published.join(', ') }}</div>
                </td>
                <td class="whitespace-nowrap text-right">
                  <button class="btn btn-ghost btn-xs" :disabled="!!busy" @click="compose('restart', s.service)">Restart</button>
                  <button class="btn btn-ghost btn-xs" @click="compose('logs', s.service)">Logs</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else-if="ready" class="text-xs opacity-60">No containers yet. <template v-if="current?.build"><b>Build &amp; Up</b> builds the images and starts them.</template><template v-else><b>Up</b> starts them{{ withApp === file ? `, and so does Start` : '' }}.</template></p>
      </div>
    </div>

    <!-- The site's own Docker files: code editor, ⌘S saves. -->
    <DockerFilesCard :site-id="project.id" :version="filesVersion" />

    <!-- Development services: compose.dev.yaml, the app keeps running on this computer. -->
    <div class="card">
      <div class="card-body">
        <h2 class="font-semibold">Development services</h2>
        <p class="text-xs opacity-70">
          The database, Redis, mail or search this {{ desktop ? 'app' : 'site' }} talks to, in containers: <code>compose.dev.yaml</code>, each service on
          <code>127.0.0.1</code>. The {{ desktop ? 'app' : 'site' }} itself keeps running here (no Dockerfile); the services start and stop with it, and
          <b>Use in .env</b> points it at them. DevCatz can also run these services without Docker ({{ desktop ? 'Database tab' : 'Database and Settings' }}).
        </p>
        <div v-if="!dev" class="flex flex-wrap gap-1.5">
          <button class="btn btn-sm" @click="devPreview()">{{ files.some((f) => f.file === 'compose.dev.yaml') ? 'Change compose.dev.yaml…' : 'Create compose.dev.yaml…' }}</button>
        </div>
        <div v-else class="space-y-2">
          <div class="flex flex-wrap gap-x-5 gap-y-2 rounded-box bg-base-200/50 px-4 py-3 text-sm">
            <label v-for="x in dev.services" :key="x.kind" class="flex cursor-pointer items-center gap-2">
              <input type="checkbox" class="checkbox checkbox-sm" :checked="x.picked" @change="toggleDev(x.kind, ($event.target as HTMLInputElement).checked)" />
              {{ x.name }}<span v-if="x.suggested" class="badge badge-ghost badge-xs" title="This project seems to use it">used</span>
            </label>
          </div>
          <div class="rounded-box border border-base-300/60">
            <div class="flex items-center gap-2 px-3 py-2">
              <code class="flex-1 text-xs">{{ dev.path }}</code>
              <span v-if="dev.current === null" class="badge badge-success badge-xs">new</span>
              <span v-else-if="dev.current === devContent" class="badge badge-ghost badge-xs">unchanged</span>
              <span v-else class="badge badge-warning badge-xs">exists · differs</span>
              <span v-if="devContent !== dev.content" class="badge badge-primary badge-soft badge-xs">edited</span>
              <button class="btn btn-ghost btn-xs" @click="devOpen = true">Open</button>
            </div>
          </div>
          <DockerFileDialog v-if="devOpen" v-model="devContent" :file="dev.path" :site-id="project.id" :original="dev.current" @save="devOpen = false" @close="devOpen = false">
            <template #note><span class="text-xs opacity-60">Passwords come from your .env (DATABASE_URL / DB_*), else defaults for development.</span></template>
            <template #save-hint>keeps your changes (written with Write)</template>
            <template #actions>
              <button v-if="devContent !== dev.content" class="btn btn-ghost btn-sm" @click="devContent = dev.content">Reset</button>
              <button class="btn btn-primary btn-sm" @click="devOpen = false">Done</button>
            </template>
          </DockerFileDialog>
          <div class="flex items-center gap-2">
            <button class="btn btn-primary btn-sm" :disabled="dev.current === devContent" @click="devWrite">Write</button>
            <button class="btn btn-ghost btn-sm" @click="dev = null">Cancel</button>
            <span class="text-xs opacity-60">then it starts with the {{ desktop ? 'app' : 'site' }}, and .env is offered</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Generator (deploy files): not for desktop apps, which ship as installers. -->
    <div v-if="!desktop" class="card">
      <div class="card-body">
        <h2 class="font-semibold">{{ files.some((f) => f.generated) ? 'Regenerate Docker files' : 'Generate Docker files' }}</h2>
        <p v-if="existingSetup" class="text-xs opacity-70">
          This project already has its own Docker setup ({{ files.filter((f) => f.build && !f.generated).map((f) => f.file).join(', ') }}); use it above.
          Generating is still possible and never overwrites without asking.
        </p>
        <p v-else class="text-xs opacity-70">
          <b>Local test</b> or <b>Production</b> (Dokploy/Coolify) setup for the detected stack: a multi-stage <code>Dockerfile</code> per app, a compose file with the database and Redis this
          site uses, <code>.dockerignore</code> and <code>.env.docker</code> (your <code>.env</code> with hosts pointed at the containers). Preview first;
          existing files are only replaced when you tick them.
        </p>
        <div v-if="!preview" class="flex flex-wrap gap-1.5">
          <button class="btn btn-sm" @click="setTarget('local')">Local test…</button>
          <button class="btn btn-sm" @click="setTarget('production')">Production (Dokploy)…</button>
        </div>

        <div v-if="preview" class="space-y-2">
          <!-- Options: one labelled row each, like Settings. -->
          <div class="grid grid-cols-[7.5rem_1fr] items-center gap-x-5 gap-y-4 rounded-box bg-base-200/50 px-5 py-4 text-sm">
            <span class="label-caps">Target</span>
            <div role="tablist" class="seg seg-choice justify-self-start">
              <a role="tab" class="seg-item" :class="{ 'is-active': preview.options.target === 'local' }" :aria-selected="preview.options.target === 'local'" @click="setTarget('local')">Local test</a>
              <a role="tab" class="seg-item" :class="{ 'is-active': preview.options.target === 'production' }" :aria-selected="preview.options.target === 'production'" @click="setTarget('production')">Production (Dokploy)</a>
            </div>

            <span class="label-caps" title="Where the containers get their environment from">Environment</span>
            <div role="tablist" class="seg seg-choice justify-self-start">
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': preview.options.envFile === 'docker' }" :aria-selected="preview.options.envFile === 'docker'" @click="setEnvFile('docker')">.env.docker</a>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': preview.options.envFile === 'project' }" :aria-selected="preview.options.envFile === 'project'" @click="setEnvFile('project')">Project .env</a>
            </div>

            <span class="label-caps self-start pt-0.5">Include</span>
            <div class="flex flex-wrap gap-x-6 gap-y-3">
              <label class="flex cursor-pointer items-center gap-2">
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.withServices" @change="setOption('withServices', ($event.target as HTMLInputElement).checked)" />
                Database &amp; Redis containers
              </label>
              <template v-if="laravel">
                <label class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.worker" @change="setOption('worker', ($event.target as HTMLInputElement).checked)" />
                  Queue worker
                </label>
                <label class="flex cursor-pointer items-center gap-2">
                  <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.scheduler" @change="setOption('scheduler', ($event.target as HTMLInputElement).checked)" />
                  Scheduler
                </label>
              </template>
              <label
                class="flex cursor-pointer items-center gap-2"
                title="Laravel: vendor/mrcatz views for Tailwind in the assets stage + intl/gd/bcmath/exif. Nuxt: nuxt prepare before the build. Go: every command in ./cmd as a static binary, migrate up before the API, local replace checkouts as build contexts. See datatable.catzoid.tech/docs/deployment/docker"
              >
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.mrcatzDatatable" @change="setOption('mrcatzDatatable', ($event.target as HTMLInputElement).checked)" />
                Use MrCatz DataTable
                <span v-if="preview.options.mrcatzDatatable && !preview.mrcatzDetected" class="text-xs text-warning" title="No mrcatz/* (composer), @mrcatz/datatable-* (npm) or mrcatz-go-datatables (go.mod) package found; vendor/mrcatz is not copied">(not installed here)</span>
              </label>
            </div>

            <template v-if="preview.options.target === 'production'">
              <span class="label-caps self-start pt-0.5">Deploy</span>
              <div class="flex flex-wrap gap-x-6 gap-y-3">
                <label class="flex cursor-pointer items-center gap-2" title="Joins Dokploy's external dokploy-network so Traefik can route the domain">
                  <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.dokployNetwork" @change="setOption('dokployNetwork', ($event.target as HTMLInputElement).checked)" />
                  dokploy-network
                </label>
                <label class="flex cursor-pointer items-center gap-2" title="docker-compose.app.yml, docker-compose.worker.yml, … each deployed as its own service">
                  <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.split" @change="setOption('split', ($event.target as HTMLInputElement).checked)" />
                  One compose file per service
                </label>
              </div>
            </template>
          </div>
          <p class="text-xs opacity-60">
            <template v-if="preview.options.target === 'production'">
              For Dokploy / Coolify: no published ports.
              <template v-if="preview.options.envFile === 'project'">The environment (DB_HOST, REDIS_HOST, APP_KEY, …) is read from <code>.env</code>, the file the platform writes from its Environment settings.</template>
              <template v-else>The environment comes from the generated <code>.env.docker</code> (deploy it with the app; it holds secrets, keep it out of git).</template> Point the platform's compose path at
              <code>{{ preview.composeFile }}</code> and attach the domain to the web service.
            </template>
            <template v-else-if="preview.options.envFile === 'docker'">
              Runs here with your engine; <code>.env.docker</code> is your <code>.env</code> with hosts pointed at the containers.
            </template>
            <template v-else>
              Runs here with your engine and reads your project's <code>.env</code> directly; only what must differ inside a container (database/Redis
              hosts, app URLs) is overridden under <code>environment:</code> in the compose file.
            </template>
          </p>
          <p v-if="preview.options.target === 'local' && !preview.options.withServices" class="text-xs opacity-60">
            Database and Redis stay on this {{ words.computer }} (DevCatz services or your own): <code>127.0.0.1</code>/<code>localhost</code> hosts become
            <code>host.docker.internal</code> inside the containers.
          </p>
          <div v-for="f in preview.files" :key="f.path" class="rounded-box border border-base-300/60">
            <div class="flex items-center gap-2 px-3 py-2">
              <input v-model="f.pick" type="checkbox" class="checkbox checkbox-sm" :disabled="f.same" />
              <code class="flex-1 text-xs">{{ f.path }}</code>
              <span v-if="f.current === null" class="badge badge-success badge-xs">new</span>
              <span v-else-if="f.same" class="badge badge-ghost badge-xs">unchanged</span>
              <span v-else class="badge badge-warning badge-xs">exists · differs</span>
              <span v-if="f.content !== f.orig" class="badge badge-primary badge-soft badge-xs" title="Changed in the preview: written as you see it">edited</span>
              <button class="btn btn-ghost btn-xs" @click="openPath = f.path">Open</button>
            </div>
          </div>
          <DockerFileDialog v-if="openFile" v-model="openFile.content" :file="openFile.path" :site-id="project.id" :original="openFile.current" @save="openPath = null" @close="openPath = null">
            <template #note>
              <span class="text-xs opacity-60">{{ openFile.current === null ? 'New file: edit it before writing if you like.' : openFile.same ? 'Same as the file on disk.' : 'Diff shows what changes on disk.' }}</span>
            </template>
            <template #save-hint>keeps your changes (written with Write selected files)</template>
            <template #actions>
              <button v-if="openFile.content !== openFile.orig" class="btn btn-ghost btn-sm" title="Back to the generated version" @click="openFile.content = openFile.orig">Reset</button>
              <button class="btn btn-primary btn-sm" @click="openPath = null">Done</button>
            </template>
          </DockerFileDialog>
          <div class="flex items-center gap-2">
            <button class="btn btn-primary btn-sm" :disabled="!preview.files.some((f) => f.pick && !f.same)" @click="write">Write selected files</button>
            <button class="btn btn-ghost btn-sm" @click="preview = null">Cancel</button>
            <span class="text-xs opacity-60">
              Compose project <code>{{ preview.project }}</code>
              <template v-if="status?.orbLocal && preview.options.target === 'local'">→ <code>https://&lt;service&gt;.{{ preview.project }}.orb.local</code></template>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
