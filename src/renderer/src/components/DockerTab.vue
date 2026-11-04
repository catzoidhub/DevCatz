<script setup lang="ts">
import { confirmOverwrite } from '../confirms';
import { words } from '@shared/platform';
import { isWin } from '../platform';
import { diff } from '../linediff';
import AiDocker from './AiDocker.vue';
import DockerFileDialog from './DockerFileDialog.vue';
import DockerFilesCard from './DockerFilesCard.vue';
import DoCatzButton from './DoCatzButton.vue';
import docatzLogo from '../assets/logos/docatz.png';
import { aiOn } from '../ai';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ComposeEnvPlan, DevComposePreview, DevServiceKind, DockerAction, DockerEngineId, DockerGenOptions, DockerTarget, DockerComposeFile, DockerFile, DockerService, DockerStatus, ProjectState } from '@shared/types';
import { attempt, herd, loadLogs, logs, notify } from '../store';
const aiDockerOn = aiOn('docker');

/** `desktop`: an Electron / Tauri app — it ships as an installer, so only its development services run here (no deploy files). */
const props = defineProps<{ project: ProjectState; desktop?: boolean; /** Build ▾ at the top asked for this (it runs here, with its progress). */ request?: { file: string; action: 'up' | 'down' | 'start' | 'stop'; n: number } | null }>();
const emit = defineEmits<{ logs: []; git: []; handled: [] }>();

const status = ref<DockerStatus | null>(null);
const files = ref<DockerComposeFile[]>([]);
const file = ref<string>('');
const services = ref<DockerService[]>([]);
const busy = ref<string | null>(null);

const ready = computed(() => Boolean(status.value?.daemon));
/**
 * What runs, as the main process knows it (project.dockerRun): also a run started before this tab was opened again
 * or from Build ▾, so the buttons stay off until it ends. `busy` covers the moment before that state arrives.
 */
const busyKey = computed(() => busy.value ?? (props.project.dockerRun ? `${props.project.dockerRun.action}:${props.project.dockerRun.service ?? ''}` : null));

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

// ---- On DoCatz: which .env the containers get (DoCatz's own, per project), and replacing it with the project's — asked.
type DocatzEnv = Awaited<ReturnType<typeof herd.dockerDocatzEnv>>;
const docatzEnv = ref<DocatzEnv | null>(null);
async function loadDocatzEnv() {
  docatzEnv.value = status.value?.engine === 'docatz' && file.value ? ((await herd.dockerDocatzEnv(props.project.id, file.value).catch(() => null)) ?? null) : null;
}
watch(() => `${file.value}|${status.value?.engine}`, () => void loadDocatzEnv());
async function replaceDocatzEnv() {
  const e = docatzEnv.value;
  if (!e) return;
  if (!confirm(`Replace DoCatz's .env of ${e.project} with this project's .env?\n\nWhat you changed in DoCatz is lost; hosts on this computer become host.docker.internal. Run Build & Up afterwards so the containers get it.`)) return;
  if (await attempt(() => herd.dockerDocatzEnvReplace(props.project.id, file.value))) notify('success', `DoCatz's .env of ${e.project} now matches the project's .env: run Build & Up to apply it`);
  await loadDocatzEnv();
}

// ---- Progress of Build & Up / Build / Down: read from the compose output as it streams into the site's log.
const anyRunning = computed(() => services.value.some((s) => s.state === 'running'));
const run = ref<{ action: DockerAction; from: number; at: number } | null>(null);
const testCard = ref<HTMLElement | null>(null);
const now = ref(Date.now());
let tick: ReturnType<typeof setInterval> | undefined;
const elapsed = computed(() => {
  const s = run.value ? Math.max(0, Math.round((now.value - run.value.at) / 1000)) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
});
/** Per service: the BuildKit step it is at ("3/5"), then what the containers are doing; the last line as it came. */
const progress = computed(() => {
  const r = run.value;
  if (!r) return null;
  const lines = (logs.get(props.project.id) ?? []).slice(r.from).filter((l) => l.stream === 'docker' || l.stream === 'err');
  const steps = new Map<string, string>();
  const containers = new Map<string, string>();
  const stopping = r.action === 'down' || r.action === 'stop';
  let phase = stopping ? 'Stopping containers' : r.action === 'build' ? 'Building images' : 'Preparing';
  let last = '';
  for (const { text } of lines) {
    // "#7 [app stage-2 3/5] …" (several services) or "#7 [3/3] …" (one).
    const step = /^#\d+ \[(?:([\w.-]+) )?(?:[^\]]*? )?(\d+)\/(\d+)\]/.exec(text);
    if (step) {
      steps.set(step[1] ?? 'build', `${step[2]}/${step[3]}`);
      phase = 'Building images';
    }
    const c = /^\s*Container (\S+)\s+(Creating|Created|Starting|Started|Waiting|Healthy|Running|Stopping|Stopped|Removing|Removed|Error)/.exec(text);
    if (c) {
      containers.set(c[1], c[2]);
      phase = stopping ? 'Stopping containers' : 'Starting containers';
    }
    if (/^\s*Image \S+ Building/.test(text)) phase = 'Building images';
    if (text.trim()) last = text.trim();
  }
  return { phase, steps: [...steps], containers: [...containers], last };
});

const cancelling = ref(false);
async function cancelRun() {
  cancelling.value = true;
  await attempt(() => herd.dockerCancel(props.project.id));
}

async function compose(action: DockerAction, service?: string) {
  if (!file.value) return;
  if (action !== 'logs' && busyKey.value) return notify('info', 'Docker Compose is still running for this site: wait for it, or Cancel it');
  busy.value = `${action}:${service ?? ''}`;
  if (action === 'logs') emit('logs');
  else {
    await loadLogs(props.project.id).catch(() => undefined);
    run.value = { action, from: logs.get(props.project.id)?.length ?? 0, at: Date.now() };
    now.value = Date.now();
    tick = setInterval(() => (now.value = Date.now()), 1000);
  }
  const ok = await attempt(() => herd.dockerCompose(props.project.id, file.value, action, service).then(() => true).catch((e: Error) => {
    if (cancelling.value || /Cancelled/.test(e.message)) return false; // asked for: not an error
    throw e;
  }));
  busy.value = null;
  clearInterval(tick);
  run.value = null;
  if (cancelling.value) notify('info', `${action === 'up' ? 'Build & Up' : action} cancelled`);
  const wasCancelled = cancelling.value;
  cancelling.value = false;
  if (ok && action === 'up') notify('success', status.value?.orbLocal || status.value?.docatzNames ? `Containers are up. ${status.value?.docatzNames ? 'DoCatz' : 'OrbStack'} serves them at the URLs below.` : 'Containers are up.');
  if (ok === undefined && action !== 'logs' && !wasCancelled) emit('logs');
  await refresh();
  void loadDocatzEnv();
}
onBeforeUnmount(() => clearInterval(tick));
// A run this tab did not start (opened again while it builds): its progress panel, until the main process says it ended.
watch(
  () => props.project.dockerRun?.at ?? 0,
  async (at) => {
    const r = props.project.dockerRun;
    if (r && !run.value) {
      file.value = r.file;
      await loadLogs(props.project.id).catch(() => undefined);
      const all = logs.get(props.project.id) ?? [];
      const from = all.findIndex((l) => l.time >= r.at - 1000);
      run.value = { action: r.action, from: from < 0 ? all.length : from, at: r.at };
      clearInterval(tick);
      now.value = Date.now();
      tick = setInterval(() => (now.value = Date.now()), 1000);
    } else if (!at && run.value && !busy.value) {
      clearInterval(tick);
      run.value = null;
      cancelling.value = false;
      await refresh();
    }
  },
  { immediate: true },
);
// A request from Build ▾: select its file, wait until the engine is known, then run it like the buttons here.
watch(
  () => props.request?.n,
  async () => {
    const r = props.request;
    if (!r) return;
    emit('handled');
    for (let i = 0; i < 50 && (!status.value || !files.value.length); i++) await new Promise((res) => setTimeout(res, 200));
    if (!files.value.some((f) => f.file === r.file)) return notify('error', `${r.file} not found`);
    file.value = r.file;
    await nextTick();
    testCard.value?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    await compose(r.action);
  },
  { immediate: true },
);

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
  // New files are ticked — unless the project has its own Docker setup: then nothing is (a second compose file next
  // to the one Dokploy uses, Dockerfiles nothing builds); the user ticks what they want after comparing.
  preview.value = { ...r, files: r.files.map((f) => ({ ...f, pick: f.current === null && !existingSetup.value, orig: f.content })) };
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
/** The choices of the Engine card: what dockerStatus found, or the one engine that answers. */
const engineOptions = computed(() => {
  const st = status.value;
  if (!st) return [];
  return st.engines.length ? st.engines : [{ id: st.engine ?? ('other' as DockerEngineId), context: st.context ?? '', running: true, used: true }];
});
/** A click on an engine: use it; one that is not running is started first (its app, colima start …). */
async function pickEngine(e: { id: DockerEngineId; running: boolean }) {
  if (!e.running) await start(e.id);
  await useEngine(e.id === 'docatz' ? 'docatz' : 'system');
}
/** Open in DoCatz is off while the containers run on another engine (OrbStack …): DoCatz would not show them. */
const notOnDocatz = computed(() => (status.value?.daemon && status.value.engine !== 'docatz' ? `The containers run on ${engineName(status.value.engine)}: pick DoCatz in step 1 to see them in DoCatz` : null));
async function useEngine(which: 'docatz' | 'system') {
  await attempt(() => herd.updateSettings({ dockerEngine: which }));
  await refresh();
  const now: DockerStatus | null = status.value;
  notify('success', which === 'docatz' ? 'Containers now run on DoCatz' : `Containers now run on ${engineName(now?.engine ?? null)}`);
}

// ------------------------------------------------- start with the app, .env

/** .env lines for the development services (docker-compose.dev.yml), as reached from this computer. */
const DEV_FILE = 'docker-compose.dev.yml';
const envPlan = ref<ComposeEnvPlan | null>(null);
async function previewEnv() {
  envPlan.value = (await attempt(() => herd.dockerComposeEnv(props.project.id, DEV_FILE, false))) ?? null;
}
async function writeEnv() {
  const done = await attempt(() => herd.dockerComposeEnv(props.project.id, DEV_FILE, true));
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
  notify('success', `Wrote ${path}: Up starts its services.`);
  await refresh();
  file.value = path;
  filesVersion.value++;
  void previewEnv();
}

/** Step 3 runs the deploy files (generated or the project's own); the development services file is apart. */
const hasDevFile = computed(() => files.value.some((f) => f.file === DEV_FILE));
const deployFiles = computed(() => files.value.filter((f) => f.file !== DEV_FILE));
/** Development services open by themselves for a desktop app (its main use), or once the file exists. */
const devOpenSection = ref(false);
watch(
  () => props.desktop || hasDevFile.value,
  (v) => v && (devOpenSection.value = true),
  { immediate: true },
);

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
    <!-- Engine: which app runs the containers — DoCatz first (recommended), then the system's current context. -->
    <div v-else class="card">
      <div class="card-body gap-3">
        <div class="flex items-center gap-2">
          <h2 class="flex flex-1 items-center gap-2 font-semibold"><span class="step-num">1</span>Docker engine <span class="text-xs font-normal opacity-60">where your containers run while you test them</span></h2>
          <DoCatzButton v-if="!files.length" :site-id="project.id" :disabled-reason="notOnDocatz" />
        </div>
        <div role="radiogroup" aria-label="Container engine" class="grid gap-2 sm:grid-cols-2">
          <button
            v-for="e in engineOptions"
            :key="e.id + e.context"
            type="button"
            role="radio"
            :aria-checked="e.used"
            class="flex items-center gap-3 rounded-box border px-3 py-2.5 text-left transition-colors disabled:cursor-default"
            :class="e.used ? 'border-primary/70 bg-primary/5' : e.running ? 'border-base-300/60 bg-base-200/40 hover:border-primary/50 hover:bg-base-200' : 'border-base-300/60 bg-base-200/20 opacity-70'"
            :disabled="e.used || starting === e.id"
            :title="e.used ? 'This site\'s containers run here' : e.running ? `Run this site's containers on ${engineName(e.id)}` : `Start ${engineName(e.id)} and run this site's containers there`"
            @click="pickEngine(e)"
          >
            <img v-if="e.id === 'docatz'" :src="docatzLogo" alt="" class="size-8 shrink-0" draggable="false" />
            <span v-else class="grid size-8 shrink-0 place-items-center rounded-lg bg-base-100 ring-1 ring-base-content/10">
              <svg viewBox="0 0 20 20" class="size-4 opacity-70" fill="currentColor"><path d="M3 9h2v2H3V9Zm3 0h2v2H6V9Zm3 0h2v2H9V9Zm0-3h2v2H9V6Zm3 3h2v2h-2V9Zm-6-3h2v2H6V6Zm3-3h2v2H9V3ZM2 12h14.5c.6-.9 1-1.9 1.5-3l1 .5c-.4 1.3-1 2.4-1.8 3.4A8 8 0 0 1 9 17c-3.4 0-6-1.8-7-5Z" /></svg>
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-1.5 text-sm font-medium leading-tight">
                {{ engineName(e.id) }}
                <span v-if="e.id === 'docatz'" class="badge badge-ghost badge-xs">recommended</span>
              </span>
              <span class="block text-[11px] leading-tight opacity-60">
                <template v-if="e.running">running · context {{ e.context }}</template>
                <template v-else-if="starting === e.id">starting…</template>
                <template v-else>not running · click to start it</template>
              </span>
            </span>
            <span class="grid size-4 shrink-0 place-items-center rounded-full border" :class="e.used ? 'border-primary' : 'border-base-content/30'">
              <span v-if="e.used" class="size-2 rounded-full bg-primary" />
            </span>
          </button>
        </div>
        <p class="text-xs opacity-60">
          <template v-if="status.orbLocal">OrbStack gives every container an <code>https://*.orb.local</code> name.</template>
          <template v-else-if="status.docatzNames">DoCatz gives every container a name: <code>{{ status.docatzNames }}</code> — no change to your Dockerfile or compose file needed.</template>
          <template v-else>Containers are published on <code>127.0.0.1</code> ports.</template>
          <template v-if="!engineOptions.some((e) => e.id === 'docatz')"> <b>DoCatz</b>, the Catzoid container manager, is recommended: a light engine with every container, image and volume in one window.</template>
        </p>
      </div>
    </div>

    <!-- 2 · Docker files: the Dockerfile(s) and docker-compose.yml Dokploy deploys (not for desktop apps: installers). -->
    <div v-if="!desktop" class="card">
      <div class="card-body">
        <h2 class="flex items-center gap-2 font-semibold"><span class="step-num">2</span>Docker files <span class="text-xs font-normal opacity-60">the same ones Dokploy deploys later</span></h2>
        <!-- The project's own setup comes first: generated files are a standard template for the stack, not a copy of it. -->
        <div v-if="existingSetup" class="space-y-2">
          <div class="rounded-box border border-success/40 bg-success/5 px-3 py-2.5 text-sm">
            <div class="font-medium">This project has its own Docker setup</div>
            <ul class="mt-1 space-y-0.5 text-xs">
              <li v-for="f in files.filter((x) => x.build && !x.generated)" :key="f.file" class="flex flex-wrap items-center gap-x-2">
                <code>{{ f.file }}</code>
                <span class="opacity-60">{{ f.coversAll ? 'one compose file for every app of the monorepo' : f.covers.length ? `builds ${f.covers.join(', ')}` : 'builds the app' }}</span>
                <a class="link link-primary" @click="file = f.file">test it in step 3</a>
              </li>
            </ul>
            <p class="mt-1.5 text-xs opacity-70">Use these: they are the files Dokploy already deploys. Change them in the editor below.</p>
          </div>
        </div>
        <p v-else class="text-xs opacity-70">
          For the detected stack: a multi-stage <code>Dockerfile</code> per app, <code>docker-compose.yml</code> (the file Dokploy and Coolify read),
          <code>.dockerignore</code>. Preview first; existing files are only replaced when you tick them. Change them any time below.
        </p>
        <div v-if="!preview" class="flex flex-wrap items-center gap-1.5">
          <button v-if="existingSetup" class="btn btn-ghost btn-sm" title="A standard template for the detected stack, not a copy of your files: compare before writing anything" @click="setTarget('production')">Generate new files anyway…</button>
          <button v-else class="btn btn-sm" :class="{ 'btn-primary': !deployFiles.length }" @click="setTarget('production')">{{ deployFiles.some((f) => f.generated) ? 'Regenerate Docker files…' : 'Generate Docker files…' }}</button>
        </div>
        <div v-if="preview && existingSetup" role="alert" class="alert alert-warning alert-soft items-start py-2 text-xs">
          <span>
            These are DevCatz's standard files for this stack, not your own: your Dockerfiles may do more (workspaces, shared packages, smaller
            runtime images). Nothing is ticked: tick only what you really want, after comparing with <b>Open</b>.
          </span>
        </div>

        <div v-if="preview" class="space-y-2">
          <!-- Options: one labelled row each, like Settings. -->
          <div class="grid grid-cols-[7.5rem_1fr] items-center gap-x-5 gap-y-4 rounded-box bg-base-200/50 px-5 py-4 text-sm">
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
                v-if="preview.mrcatzDetected"
                class="flex cursor-pointer items-center gap-2"
                title="Laravel: vendor/mrcatz views for Tailwind in the assets stage + intl/gd/bcmath/exif. Nuxt: nuxt prepare before the build. Go: every command in ./cmd as a static binary, migrate up before the API, local replace checkouts as build contexts. See datatable.catzoid.tech/docs/deployment/docker"
              >
                <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.mrcatzDatatable" @change="setOption('mrcatzDatatable', ($event.target as HTMLInputElement).checked)" />
                MrCatz DataTable <span class="text-xs opacity-60">(found in this project)</span>
              </label>
            </div>

            <span class="label-caps" title="One docker-compose.yml, or docker-compose.app.yml, docker-compose.worker.yml … each deployed as its own service">Compose</span>
            <div role="tablist" class="seg seg-choice justify-self-start">
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': !preview.options.split }" :aria-selected="!preview.options.split" @click="setOption('split', false)">One file</a>
              <a role="tab" class="seg-item normal-case" :class="{ 'is-active': preview.options.split }" :aria-selected="preview.options.split" @click="setOption('split', true)">One file per service</a>
            </div>

            <span class="label-caps self-start pt-0.5">Dokploy</span>
            <label class="flex cursor-pointer items-center gap-2" title="Joins Dokploy's external dokploy-network so Traefik can route the domain (made here automatically for the test)">
              <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="preview.options.dokployNetwork" @change="setOption('dokployNetwork', ($event.target as HTMLInputElement).checked)" />
              dokploy-network
            </label>
          </div>
          <p class="text-xs opacity-60">
            <template v-if="preview.options.target === 'production'">
              No published ports: here {{ status?.docatzNames ? 'DoCatz' : status?.orbLocal ? 'OrbStack' : 'your engine' }} names each container, on the server Dokploy routes the domain.
              <template v-if="preview.options.envFile === 'project'">The environment (DB_HOST, REDIS_HOST, APP_KEY, …) is read from <code>.env</code>, the file the platform writes from its Environment settings.</template>
              <template v-else>The environment comes from the generated <code>.env.docker</code> (deploy it with the app; it holds secrets, keep it out of git).</template> <template v-if="preview.composeFile === 'docker-compose.yml'">
                <code>docker-compose.yml</code> is the file Dokploy and Coolify read by default: no compose path to change, just attach the domain to the
                web service.
              </template>
              <template v-else>Point the platform's compose path at <code>{{ preview.composeFile }}</code> and attach the domain to the web service.</template>
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

    <!-- Your Docker files: code editor, ⌘S saves (step 2's files and the project's own). -->
    <DockerFilesCard v-if="!desktop" :site-id="project.id" :version="filesVersion" />

    <!-- 3 · Test: Build & Up on the chosen engine, then commit and push for Dokploy. -->
    <div ref="testCard" class="card">
      <div class="card-body">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="flex flex-1 items-center gap-2 font-semibold"><span class="step-num">{{ desktop ? 2 : 3 }}</span>{{ desktop ? 'Containers' : 'Test in containers' }}</h2>
          <DoCatzButton v-if="file && files.length" :site-id="project.id" :file="file" :disabled-reason="notOnDocatz" />
          <select v-if="files.length" v-model="file" class="select select-sm w-auto" :disabled="!!busyKey && !!run">
            <option v-for="f in files" :key="f.file" :value="f.file">{{ f.file }}{{ f.coversAll ? ' · every app' : f.covers.length ? ` · ${f.covers.join(', ')}` : '' }}{{ f.generated ? ' (generated)' : f.build ? '' : ' (no app build)' }}</option>
          </select>
        </div>
        <p v-if="!files.length" class="text-xs opacity-60">{{ desktop ? 'Create the development services below first.' : 'Generate the Docker files first (step 2), or add your own docker-compose.yml.' }}</p>
        <div v-if="files.length" class="flex flex-wrap gap-1.5">
          <button class="btn btn-primary btn-sm" :disabled="!ready || !!busyKey" @click="compose('up')">
            <span v-if="busyKey === 'up:'" class="loading loading-spinner loading-xs" />{{ current?.build ? 'Build & Up' : 'Up' }}
          </button>
          <button class="btn btn-sm" :disabled="!ready || !!busyKey" @click="compose('down')"><span v-if="busyKey === 'down:'" class="loading loading-spinner loading-xs" />Down</button>
          <button v-if="anyRunning" class="btn btn-sm" :disabled="!ready || !!busyKey" title="Stop the containers and keep them: Start brings them back as they were" @click="compose('stop')"><span v-if="busyKey === 'stop:'" class="loading loading-spinner loading-xs" />Stop</button>
          <button v-else class="btn btn-sm" :disabled="!ready || !!busyKey || !services.length" :title="services.length ? 'Start the containers that exist, without building or making new ones' : 'No containers yet: Up makes them'" @click="compose('start')"><span v-if="busyKey === 'start:'" class="loading loading-spinner loading-xs" />Start</button>
          <button class="btn btn-sm" :disabled="!ready || !!busyKey || !services.length" @click="compose('restart')">Restart</button>
          <button class="btn btn-sm" :disabled="!ready || !!busyKey" @click="compose('build')"><span v-if="busyKey === 'build:'" class="loading loading-spinner loading-xs" />Build only</button>
          <button class="btn btn-sm btn-ghost" :disabled="!ready || !services.length" @click="compose('logs')">Logs</button>
        </div>
        <!-- On DoCatz: the environment its containers get — DoCatz's .env of the project (kept unless replaced, asked). -->
        <div v-if="docatzEnv && files.length" class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <span class="opacity-60">Environment:</span>
          <template v-if="docatzEnv.exists">
            <span :title="docatzEnv.path ?? ''">DoCatz's .env of <b>{{ docatzEnv.project }}</b></span>
            <span v-if="docatzEnv.same" class="badge badge-ghost badge-xs">same as the project's .env</span>
            <template v-else-if="docatzEnv.projectEnv">
              <span class="badge badge-warning badge-soft badge-xs" title="DoCatz's is the one used; the project's .env is left out">differs from the project's .env</span>
              <button class="btn btn-ghost btn-xs" @click="replaceDocatzEnv">Replace with the project's .env…</button>
            </template>
          </template>
          <span v-else-if="docatzEnv.projectEnv" class="opacity-70">the project's .env — copied to DoCatz's .env of <b>{{ docatzEnv.project }}</b> on the first Build &amp; Up (then kept, change it in DoCatz)</span>
          <span v-else class="opacity-60">none (no .env in the project)</span>
        </div>
        <!-- While it runs: phase, time, each service's build step and each container's state, the latest line. -->
        <div v-if="run && progress" class="space-y-2 rounded-box border border-primary/30 bg-primary/5 px-3 py-2.5" aria-live="polite">
          <div class="flex items-center gap-2 text-sm">
            <span class="loading loading-spinner loading-sm text-primary" />
            <span class="font-medium">{{ progress.phase }}…</span>
            <span class="font-mono text-xs opacity-60">{{ elapsed }}</span>
            <span class="flex-1" />
            <button class="btn btn-ghost btn-xs" @click="emit('logs')">Open Logs</button>
            <button class="btn btn-ghost btn-xs text-error" :disabled="cancelling" title="Stop it: compose and the builds it started (containers already made stay; Down removes them)" @click="cancelRun">
              <span v-if="cancelling" class="loading loading-spinner loading-xs" />Cancel
            </button>
          </div>
          <div v-if="progress.steps.length || progress.containers.length" class="flex flex-wrap gap-1.5 text-xs">
            <span v-for="[svc, step] in progress.steps" :key="'s' + svc" class="badge badge-ghost badge-sm font-mono">{{ svc }} · step {{ step }}</span>
            <span v-for="[name, state] in progress.containers" :key="'c' + name" class="badge badge-sm" :class="/Started|Healthy|Running/.test(state) ? 'badge-success badge-soft' : state === 'Error' ? 'badge-error badge-soft' : 'badge-ghost'">{{ name }} · {{ state.toLowerCase() }}</span>
          </div>
          <div v-if="progress.last" class="truncate font-mono text-[11px] opacity-60" :title="progress.last">{{ progress.last }}</div>
        </div>
        <p v-if="files.length" class="text-xs opacity-60">
          <code>docker compose -f {{ file }}{{ current?.project ? ` -p ${current.project}` : '' }}</code>; output goes to the Logs tab.
        </p>
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
                  <button v-if="s.state === 'running'" class="btn btn-ghost btn-xs" :disabled="!!busyKey" @click="compose('stop', s.service)">Stop</button>
                  <button v-else class="btn btn-ghost btn-xs" :disabled="!!busyKey" @click="compose('start', s.service)">Start</button>
                  <button class="btn btn-ghost btn-xs" :disabled="!!busyKey" @click="compose('restart', s.service)">Restart</button>
                  <button class="btn btn-ghost btn-xs" @click="compose('logs', s.service)">Logs</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <p v-else-if="ready && files.length" class="text-xs opacity-60">No containers yet. <template v-if="current?.build"><b>Build &amp; Up</b> builds the images and starts them.</template><template v-else><b>Up</b> starts them (also from Build ▾ at the top).</template></p>
        <div v-if="!desktop && file === 'docker-compose.yml' && services.some((x) => x.state === 'running')" class="flex flex-wrap items-center gap-2 rounded-box bg-success/10 px-3 py-2 text-xs">
          <span class="min-w-0 flex-1">
            <b>Runs well here?</b> Commit and push <code>docker-compose.yml</code> and the Dockerfiles; in Dokploy, create a Compose service from this
            repository — it reads <code>docker-compose.yml</code> as it is.
          </span>
          <button class="btn btn-xs" @click="emit('git')">Git tab</button>
        </div>
      </div>
    </div>

    <!-- Development services in Docker (optional): docker-compose.dev.yml, the app itself keeps running in DevCatz. -->
    <div class="card">
      <div class="card-body">
        <button type="button" class="flex items-center gap-2 text-left" :aria-expanded="devOpenSection" @click="devOpenSection = !devOpenSection">
          <svg viewBox="0 0 20 20" class="size-4 shrink-0 opacity-60 transition-transform" :class="{ 'rotate-90': devOpenSection }" fill="currentColor"><path fill-rule="evenodd" d="M7.2 14.8a.75.75 0 0 1 0-1.06L10.94 10 7.2 6.27a.75.75 0 1 1 1.06-1.06l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06 0Z" /></svg>
          <h2 class="flex-1 font-semibold">Development services in Docker <span v-if="!desktop" class="text-xs font-normal opacity-60">optional</span></h2>
        </button>
        <template v-if="devOpenSection">
        <p class="text-xs opacity-70">
          The database, Redis, mail or search this {{ desktop ? 'app' : 'site' }} talks to, in containers: <code>docker-compose.dev.yml</code>, each service on
          <code>127.0.0.1</code>. While you develop: the {{ desktop ? 'app' : 'site' }} itself keeps running in DevCatz (no Dockerfile); <b>Up</b> on this file starts the services, and
          <b>Use in .env</b> points it at them. DevCatz can also run these services without Docker ({{ desktop ? 'Database tab' : 'Database and Settings' }}).
        </p>
        <div v-if="!dev" class="flex flex-wrap gap-1.5">
          <button class="btn btn-sm" @click="devPreview()">{{ files.some((f) => f.file === 'docker-compose.dev.yml') ? 'Change docker-compose.dev.yml…' : 'Create docker-compose.dev.yml…' }}</button>
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
            <span class="text-xs opacity-60">then Up starts the services, and .env is offered</span>
          </div>
        </div>
        <template v-if="hasDevFile">
          <div class="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
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
        </template>
        </template>
      </div>
    </div>

  </div>
</template>
