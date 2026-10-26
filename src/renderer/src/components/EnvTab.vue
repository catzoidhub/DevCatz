<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { EnvFileInfo, ProjectState } from '@shared/types';
import { attempt, herd, notify } from '../store';
import AiEnv from './AiEnv.vue';
import CodeEditor from './CodeEditor.vue';
import { aiOn } from '../ai';
import CatMood from './CatMood.vue';
/** ✦ Check with AI (Settings → AI). */
const aiEnvOn = aiOn('env');
const aiEnvOpen = ref(false);

/** The site's .env files: create, edit, lock (values hidden, read-only), like Dokploy's environment page. */
const props = defineProps<{ project: ProjectState }>();

const files = ref<EnvFileInfo[]>([]);
const selected = ref('.env');
const content = ref('');
const saved = ref('');
const mtime = ref<number | null>(null);
const changedOnDisk = ref(false);
/** Locked by default: values stay hidden until the user unlocks them. */
const locked = computed(() => props.project.envLocked !== false);
const current = computed(() => files.value.find((f) => f.path === selected.value) ?? null);
const dirty = computed(() => content.value !== saved.value);

async function loadList() {
  files.value = (await herd.envFiles(props.project.id).catch(() => [])) ?? [];
  if (!files.value.some((f) => f.path === selected.value)) selected.value = files.value[0]?.path ?? '.env';
}
async function loadFile() {
  if (!current.value?.exists) {
    content.value = saved.value = '';
    mtime.value = null;
    return;
  }
  const r = await attempt(() => herd.envRead(props.project.id, selected.value));
  if (!r) return;
  content.value = saved.value = r.content;
  mtime.value = r.mtime;
  changedOnDisk.value = false;
}

/** Picks up edits made elsewhere (editor, artisan key:generate): reload when clean, warn when not. */
async function poll() {
  await loadList();
  const f = current.value;
  if (!f?.exists || mtime.value === null || Math.abs(f.mtime - mtime.value) < 2) return;
  if (dirty.value) changedOnDisk.value = true;
  else await loadFile();
}

let timer: ReturnType<typeof setInterval> | undefined;
onMounted(async () => {
  await loadList();
  await loadFile();
  timer = setInterval(() => void poll(), 3000);
  window.addEventListener('keydown', onKey);
});
onBeforeUnmount(() => {
  clearInterval(timer);
  window.removeEventListener('keydown', onKey);
});
watch(selected, () => void loadFile());

function pick(path: string) {
  if (path === selected.value) return;
  if (dirty.value && !confirm(`Discard the unsaved changes to ${selected.value}?`)) return;
  selected.value = path;
}

async function save() {
  if (locked.value || !dirty.value) return;
  const at = await attempt(() => herd.envWrite(props.project.id, selected.value, content.value, mtime.value));
  if (at === undefined) return;
  saved.value = content.value;
  mtime.value = at;
  changedOnDisk.value = false;
  notify('success', `Saved ${selected.value}${props.project.status === 'running' ? '. Restart the site to apply it.' : ''}`);
  void loadList();
}
function onKey(e: KeyboardEvent) {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') {
    e.preventDefault();
    void save();
  }
}

async function create() {
  const ok = await attempt(() => herd.envCreate(props.project.id, selected.value).then(() => true));
  if (!ok) return;
  notify('success', `Created ${selected.value}${current.value?.example ? ` from ${current.value.example}` : ''}`);
  await loadList();
  await loadFile();
}

// Laravel: a new APP_KEY with `php artisan key:generate` (the site's PHP), then the file is read again.
const laravel = computed(() => props.project.stack.apps.some((a) => a.framework === 'laravel'));
const noKey = computed(() => !/^\s*APP_KEY\s*=\s*\S/m.test(saved.value));
const generating = ref(false);
async function generateKey() {
  if (!noKey.value && !confirm('Replace APP_KEY? Sessions, encrypted values and signed URLs made with the old key stop working.')) return;
  generating.value = true;
  const ok = await attempt(() => herd.envKeyGenerate(props.project.id).then(() => true));
  generating.value = false;
  if (!ok) return;
  notify('success', 'New APP_KEY written to .env');
  await loadFile();
}

async function setLocked(on: boolean) {
  if (on && dirty.value && !confirm('Lock without saving your changes?')) return;
  if (on) content.value = saved.value;
  await attempt(() => herd.updateProject(props.project.id, { envLocked: on }));
}

/** Locked view: keys and comments stay readable, values are masked. */
const masked = computed(() =>
  saved.value.split('\n').map((line) => {
    const m = line.match(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=)(.*)$/);
    if (!m) return { kind: line.trim().startsWith('#') ? 'comment' : 'text', key: line, value: '' };
    return { kind: 'pair', key: m[1], value: m[2].trim() ? '•'.repeat(Math.min(24, Math.max(8, m[2].trim().length))) : '' };
  }),
);

/** The masked lines as text, for the read-only editor (keys and comments coloured, values as •••). */
const maskedText = computed(() => masked.value.map((l) => (l.kind === 'pair' ? `${l.key}${l.value}` : l.key)).join('\n'));

/** Duplicate keys and lines that are neither KEY=value nor comments. */
const problems = computed(() => {
  const out: string[] = [];
  const seen = new Map<string, number>();
  content.value.split('\n').forEach((line, i) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return;
    const m = t.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/);
    if (!m) out.push(`Line ${i + 1}: not KEY=value`);
    else if (seen.has(m[1])) out.push(`${m[1]} is set twice (lines ${seen.get(m[1])} and ${i + 1}); the last one wins`);
    else seen.set(m[1], i + 1);
  });
  return out;
});
const varCount = computed(() => (locked.value ? saved.value : content.value).split('\n').filter((l) => /^\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.]*\s*=/.test(l)).length);
</script>

<template>
  <div class="flex min-h-0 flex-1 flex-col gap-4">
    <AiEnv v-if="aiEnvOpen" :key="selected" :site-id="project.id" :file="selected" @close="aiEnvOpen = false" @changed="loadFile" />
    <div class="flex flex-wrap items-center gap-2">
      <button v-if="aiEnvOn && !aiEnvOpen" class="btn btn-sm order-last" title="What the keys are for and which look wrong for local development; only key names are sent" @click="aiEnvOpen = true">✦ Check with AI</button>
      <div role="tablist" class="seg flex-wrap">
        <a
          v-for="f in files"
          :key="f.path"
          role="tab"
          class="seg-item normal-case font-mono"
          :class="{ 'is-active': f.path === selected, 'opacity-50': !f.exists }"
          :title="f.exists ? `${f.size} bytes` : 'Not created yet'"
          @click="pick(f.path)"
        >
          {{ f.path }}<span v-if="f.template" class="opacity-60">·template</span>
        </a>
      </div>
      <div class="flex-1" />
      <button
        v-if="laravel && selected === '.env' && current?.exists"
        class="btn btn-sm"
        :class="{ 'btn-primary': noKey }"
        :disabled="generating || dirty"
        :title="dirty ? 'Save .env first' : 'php artisan key:generate: a new APP_KEY in .env'"
        @click="generateKey"
      >
        <span v-if="generating" class="loading loading-spinner loading-xs" />{{ noKey ? 'Generate APP_KEY' : 'New APP_KEY' }}
      </button>
      <button v-if="locked" class="btn btn-sm" title="Show the values and allow editing" @click="setLocked(false)">
        <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M10 1a4.5 4.5 0 0 0-4.5 4.5V9H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-.5V5.5A4.5 4.5 0 0 0 10 1Zm3 8V5.5a3 3 0 1 0-6 0V9h6Z" clip-rule="evenodd" /></svg>
        Unlock
      </button>
      <button v-else class="btn btn-sm btn-ghost" title="Hide the values and stop editing" @click="setLocked(true)">
        <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M14.5 1A4.5 4.5 0 0 0 10 5.5V9H3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6a2 2 0 0 0-2-2h-1.5V5.5a3 3 0 1 1 6 0v2.75a.75.75 0 0 0 1.5 0V5.5A4.5 4.5 0 0 0 14.5 1Z" clip-rule="evenodd" /></svg>
        Lock
      </button>
    </div>

    <!-- Missing file -->
    <div v-if="current && !current.exists" class="rounded-box border border-dashed border-base-300 p-6 text-center">
      <div class="font-medium">{{ selected }} does not exist yet</div>
      <p class="mt-1 text-xs opacity-70">
        <template v-if="current.example">It will start as a copy of <code>{{ current.example }}</code>.</template>
        <template v-else>It will start empty.</template>
        <template v-if="selected === '.env' && project.stack.apps.some((a) => a.framework === 'laravel')"> <code>php artisan key:generate</code> sets APP_KEY afterwards.</template>
      </p>
      <button class="btn btn-primary btn-sm mt-3" @click="create">Create {{ selected }}</button>
    </div>

    <!-- Locked: masked, read-only -->
    <CodeEditor v-else-if="locked" :model-value="maskedText" language="env" readonly fill />

    <!-- Editor -->
    <template v-else>
      <CodeEditor v-model="content" language="env" fill />
      <div v-if="changedOnDisk" role="alert" class="alert alert-warning py-2 text-xs"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
        {{ selected }} changed on disk since you opened it.
        <button class="btn btn-xs" @click="loadFile">Reload (discard mine)</button>
      </div>
      <ul v-if="problems.length" class="text-xs text-warning">
        <li v-for="pr in problems.slice(0, 5)" :key="pr">{{ pr }}</li>
      </ul>
    </template>

    <div v-if="current?.exists" class="flex items-center gap-2 text-xs">
      <template v-if="!locked">
        <button class="btn btn-primary btn-sm" :disabled="!dirty" @click="save">Save <kbd class="kbd kbd-xs">⌘S</kbd></button>
        <button class="btn btn-ghost btn-sm" :disabled="!dirty" @click="content = saved">Revert</button>
      </template>
      <span class="opacity-60">
        {{ varCount }} variables<template v-if="locked"> · locked: values hidden, editing off</template><template v-else-if="dirty"> · unsaved changes</template>
      </span>
    </div>
  </div>
</template>
