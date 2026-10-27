<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, onMounted, ref, watch } from 'vue';
import type { DbEngine, DbEngineInfo, DbServiceInput, DbServiceState, DbVersionOption, TaskProgress } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import { CONFIG_HINT, DB_LOGO, hasPassword } from '../db';
import TaskStepper from './TaskStepper.vue';
import CatMood from './CatMood.vue';
import { isWin } from '../platform';

/**
 * New database service (engine → version → settings), the settings of an
 * existing one, or `retry`: a failed create run again at once, its progress here.
 */
const props = defineProps<{ service?: DbServiceState; engine?: DbEngine; retry?: DbServiceState }>();
const emit = defineEmits<{ close: []; done: [id: string] }>();
const editing = computed(() => Boolean(props.service));

const engines = ref<DbEngineInfo[]>([]);
const engine = ref<DbEngine | null>(props.service?.engine ?? props.retry?.engine ?? props.engine ?? null);
const info = computed(() => engines.value.find((e) => e.engine === engine.value) ?? null);
const versions = ref<DbVersionOption[]>([]);
const versionsError = ref<string | null>(null);
const loadingVersions = ref(false);
const form = ref<DbServiceInput | null>(props.service ? pick(props.service) : props.retry ? pick(props.retry) : null);
/** The name follows engine/version until the user types their own. */
const nameTouched = ref(editing.value || Boolean(props.retry));
/** Settings → Database → DB domain, shared by every service. */
const dbHost = computed(() => (state.value?.settings.dbDomain ? `${state.value.settings.dbDomain}.${state.value.settings.tld}` : null));
const showPassword = ref(false);

function pick(s: DbServiceState): DbServiceInput {
  const { engine, version, name, port, socket, dataDir, configFile, disableBinLog, autoStart, user, password } = s;
  return { engine, version, name, port, socket, dataDir, configFile, disableBinLog, autoStart, user, password };
}

onMounted(async () => {
  // Try again: straight to the progress with the same settings (the failed entry gives way in submit).
  if (props.retry) void submit();
  engines.value = (await attempt(() => herd.dbEngines())) ?? [];
  if (engine.value) await loadVersions();
});

/** Picking another engine while versions load: the older answer is dropped (it would fill in the wrong engine). */
let loadSeq = 0;
async function loadVersions() {
  if (!engine.value) return;
  const seq = ++loadSeq;
  const want = engine.value;
  loadingVersions.value = true;
  versionsError.value = null;
  let list: DbVersionOption[] = [];
  let error: string | null = null;
  try {
    list = await herd.dbVersions(want);
  } catch (err) {
    error = (err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  if (seq !== loadSeq) return;
  versions.value = list;
  versionsError.value = error;
  loadingVersions.value = false;
  if (!editing.value && !props.retry && list.length) await applyDefaults(list[0].version, seq);
}

async function chooseEngine(e: DbEngine) {
  if (e === engine.value) return;
  engine.value = e;
  form.value = null;
  nameTouched.value = false;
  await loadVersions();
}

/** Defaults for this engine/version (name, free port); keeps what the user already typed. */
async function applyDefaults(version: string, seq = loadSeq) {
  const d = await attempt(() => herd.dbDefaults(engine.value!, version));
  if (!d || seq !== loadSeq) return;
  if (!form.value) form.value = d;
  else {
    form.value.version = version;
    if (!nameTouched.value) form.value.name = d.name;
  }
}
watch(
  () => form.value?.version,
  (v, old) => {
    if (v && old && v !== old && !editing.value) void applyDefaults(v);
  },
);

const selectedVersion = computed(() => versions.value.find((v) => v.version === form.value?.version) ?? null);
const isSql = computed(() => engine.value === 'mysql' || engine.value === 'mariadb');
const majorChange = computed(
  () => editing.value && engine.value === 'postgresql' && props.service && form.value && props.service.version.split('.')[0] !== form.value.version.split('.')[0],
);
const defaultData = computed(() => {
  const root = state.value?.settings.dbDataRoot;
  return [root || [words.appData, 'DevCatz', 'db-services', 'data'].join(words.sep), props.service?.id ?? '<id>'].join(words.sep);
});

async function chooseData() {
  const dir = await herd.pickFolder();
  if (dir && form.value) form.value.dataDir = dir;
}
async function chooseConfig() {
  const file = await herd.pickFile(`${info.value?.name ?? ''} config file (${CONFIG_HINT[engine.value!]})`);
  if (file && form.value) form.value.configFile = file;
}

// ---- submit + progress
const busy = ref(false);
const showProgress = ref(false);
/** The instance being created (pending in the list while it installs). */
const pending = computed(() =>
  editing.value
    ? (state.value?.databases.find((d) => d.id === props.service!.id) ?? null)
    : (state.value?.databases.find((d) => d.pending && d.name === form.value?.name.trim()) ?? null),
);
/**
 * The live task, or the last one seen: a cancelled create leaves the list at
 * once, and the form still has to show where it stopped (and offer Close / Back).
 */
const lastTask = ref<TaskProgress | null>(null);
watch(
  () => pending.value?.task,
  (t) => {
    if (t) lastTask.value = t;
  },
);
// A cancel wins over the list: the rejection can arrive before the state that drops the pending entry.
const task = computed(() => (lastTask.value?.cancelled ? lastTask.value : (pending.value?.task ?? (showProgress.value ? lastTask.value : null))));

async function submit() {
  if (!form.value || !engine.value) return;
  // A failed earlier attempt with this name: drop it before trying again.
  if (!editing.value && pending.value?.task?.error) await herd.dbDismiss(pending.value.id);
  busy.value = true;
  lastTask.value = null;
  const input: DbServiceInput = {
    ...form.value,
    engine: engine.value,
    port: Number(form.value.port) || 0,
    name: form.value.name.trim(),
  };
  const needsInstall = !selectedVersion.value?.installed && engine.value !== 'sqlite';
  if (!editing.value || needsInstall) showProgress.value = true;
  const id = await attempt(() =>
    (editing.value ? herd.dbUpdate(props.service!.id, input).then(() => props.service!.id) : herd.dbCreate(input)).catch((e: Error) => {
      // Cancelling is not an error worth a toast: the step list says it.
      if (!/Cancelled/.test(e.message)) return Promise.reject(e);
      lastTask.value = { ...(lastTask.value ?? { kind: 'install', title: `Creating ${input.name}`, steps: [], step: 0 }), cancelled: true, error: 'Cancelled; nothing was kept.', received: undefined, total: undefined };
      return undefined;
    }),
  );
  busy.value = false;
  // A failure the main process could not report through the task (e.g. a refused port) still gets the form back.
  // (cast: TS narrows lastTask to null after the reset above, not seeing the catch set it)
  if (!id && showProgress.value && !task.value?.error && !(lastTask.value as TaskProgress | null)?.cancelled) showProgress.value = false;
  if (!id) return; // the step list shows where it failed
  notify('success', editing.value ? `${input.name} saved` : `${input.name} created`);
  if (showProgress.value) await new Promise((r) => setTimeout(r, 900));
  emit('done', id);
}
const cancelling = ref(false);
async function cancel() {
  if (!pending.value) return;
  cancelling.value = true;
  await attempt(() => herd.dbCancelCreate(pending.value!.id));
  cancelling.value = false;
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[40rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div class="flex items-center gap-3">
        <img v-if="engine" :src="DB_LOGO[engine]" alt="" class="size-10 shrink-0 rounded-xl bg-white p-1.5 ring-1 ring-base-content/10" draggable="false" />
        <div class="min-w-0">
          <h3 class="text-lg font-semibold tracking-tight">{{ editing ? `${service!.name} settings` : engine ? `New ${info?.name ?? ''} service` : 'New database service' }}</h3>
          <p class="text-xs opacity-60">{{ info?.description ?? 'Pick an engine; each instance gets its own version, port and data folder.' }}</p>
        </div>
      </div>

      <!-- 1. Engine -->
      <div v-if="!editing && !showProgress" class="grid grid-cols-4 gap-2">
        <button
          v-for="e in engines"
          :key="e.engine"
          type="button"
          class="flex flex-col items-center gap-1.5 rounded-box border p-2.5 text-xs transition"
          :class="e.engine === engine ? 'border-[var(--c-database)] bg-[var(--c-database)]/10 font-semibold' : 'border-base-300/70 hover:bg-base-200'"
          @click="chooseEngine(e.engine)"
        >
          <img :src="DB_LOGO[e.engine]" alt="" class="size-8 rounded-lg bg-white p-1" draggable="false" />
          {{ e.name }}
        </button>
      </div>

      <template v-if="engine && !showProgress">
        <div v-if="info?.requirement" role="alert" class="alert alert-warning text-xs"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />{{ info.requirement }}</div>

        <!-- 2. Version + name -->
        <fieldset class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">Version</span>
            <select v-if="form" v-model="form.version" class="select select-sm w-full font-mono" :disabled="loadingVersions">
              <option v-for="v in versions" :key="v.version" :value="v.version">
                {{ v.label }}{{ v.label !== v.version ? ` · ${v.version}` : '' }}{{ v.installed ? ' · installed' : '' }}
              </option>
            </select>
            <div v-else class="flex h-8 items-center gap-2 text-xs opacity-70">
              <span v-if="loadingVersions" class="loading loading-spinner loading-xs" />{{ loadingVersions ? 'Loading versions…' : '' }}
            </div>
            <span v-if="versionsError" class="mt-1 block text-xs text-error">{{ versionsError }}</span>
            <span v-else-if="selectedVersion && !selectedVersion.installed" class="mt-1 block text-xs opacity-60">
              {{ selectedVersion.source === 'homebrew' ? `Installed with Homebrew (${selectedVersion.note})` : selectedVersion.source === 'source' ? 'Downloaded and compiled (about a minute)' : 'Downloaded and checksum-verified' }}
            </span>
            <span v-if="majorChange" class="mt-1 block text-xs text-warning">A PostgreSQL data folder only runs with the major version that created it.</span>
          </label>
          <label v-if="form" class="block">
            <span class="label-caps mb-1 block">Name</span>
            <input v-model="form.name" class="input input-sm w-full" required spellcheck="false" @input="nameTouched = true" />
          </label>
        </fieldset>

        <template v-if="form">
          <!-- 3. Port + socket -->
          <fieldset v-if="engine !== 'sqlite'" class="grid grid-cols-2 gap-3">
            <label class="block">
              <span class="label-caps mb-1 block">Port</span>
              <input v-model.number="form.port" type="number" min="1" max="65535" class="input input-sm w-full font-mono" required />
              <span class="mt-1 block text-xs opacity-60">
                {{ dbHost ? `Reachable at ${dbHost}:${form.port || '…'} or 127.0.0.1` : '127.0.0.1 only (a DB domain can be set in Settings → Database)' }}<template v-if="engine === 'elasticsearch'">; transport port {{ Number(form.port) + 100 }}</template>.
              </span>
            </label>
            <!-- Windows: TCP only, no Unix sockets. -->
            <label v-if="isSql && !isWin" class="block">
              <span class="label-caps mb-1 block">Socket path <span class="normal-case opacity-60">(optional)</span></span>
              <input v-model="form.socket" class="input input-sm w-full font-mono text-xs" :placeholder="`/tmp/devcatz-${engine}-${form.port}.sock`" spellcheck="false" />
            </label>
          </fieldset>

          <!-- 4. Folders -->
          <fieldset class="space-y-3">
            <label class="block">
              <span class="label-caps mb-1 block">{{ engine === 'sqlite' ? 'Database folder' : 'Data path' }}</span>
              <div class="join w-full">
                <input v-model="form.dataDir" class="input input-sm join-item w-full font-mono text-xs" :placeholder="defaultData" spellcheck="false" />
                <button type="button" class="btn btn-sm join-item" @click="chooseData">Choose…</button>
                <button v-if="form.dataDir" type="button" class="btn btn-sm join-item" title="Use the default location" @click="form.dataDir = ''">Default</button>
              </div>
              <span class="mt-1 block text-xs opacity-60">
                Empty = the default location{{ engine === 'sqlite' ? ' (.sqlite files go here)' : '' }}.
                <template v-if="editing">Pointing at another folder starts from the data there (or a new, empty server).</template>
              </span>
            </label>
            <label v-if="engine !== 'sqlite'" class="block">
              <span class="label-caps mb-1 block">Config file <span class="normal-case opacity-60">(optional, {{ CONFIG_HINT[engine] }})</span></span>
              <div class="join w-full">
                <input v-model="form.configFile" class="input input-sm join-item w-full font-mono text-xs" placeholder="None: DevCatz’s defaults" spellcheck="false" />
                <button type="button" class="btn btn-sm join-item" @click="chooseConfig">Choose…</button>
                <button v-if="form.configFile" type="button" class="btn btn-sm join-item" @click="form.configFile = ''">Clear</button>
              </div>
              <span class="mt-1 block text-xs opacity-60">Port, data folder{{ isSql && !isWin ? ', socket' : '' }} and 127.0.0.1 from this form still apply on top of it.</span>
            </label>
          </fieldset>

          <!-- 5. Credentials -->
          <fieldset v-if="engine !== 'sqlite'" class="grid grid-cols-2 gap-3">
            <label v-if="form.user" class="block">
              <span class="label-caps mb-1 block">User</span>
              <input :value="form.user" class="input input-sm w-full font-mono" readonly />
            </label>
            <label v-if="hasPassword(engine)" class="block">
              <span class="label-caps mb-1 block">Password</span>
              <div class="join w-full">
                <input
                  v-model="form.password"
                  :type="showPassword ? 'text' : 'password'"
                  class="input input-sm join-item w-full font-mono"
                  placeholder="No password"
                  spellcheck="false"
                  autocomplete="new-password"
                />
                <button type="button" class="btn btn-sm join-item" @click="showPassword = !showPassword">{{ showPassword ? 'Hide' : 'Show' }}</button>
              </div>
            </label>
            <p class="col-span-2 -mt-1 text-xs opacity-60">
              <template v-if="engine === 'mongodb' || engine === 'elasticsearch'">No authentication (local development); it listens on 127.0.0.1 only.</template>
              <template v-else-if="engine === 'redis' || engine === 'valkey'">Optional <code>requirepass</code>; empty = no password.</template>
              <template v-else-if="editing">The password is changed inside the running server.</template>
              <template v-else>Default <code>{{ form.user }}</code> without a password{{ engine === 'postgresql' ? ' (a postgres role is created too)' : '' }}.</template>
            </p>
          </fieldset>

          <!-- 6. Options -->
          <fieldset class="space-y-2">
            <label v-if="isSql" class="flex cursor-pointer items-center gap-2 text-sm">
              <input v-model="form.disableBinLog" type="checkbox" class="toggle toggle-sm toggle-primary" />
              Disable the binary log <span class="text-xs opacity-60">(saves disk; no replication)</span>
            </label>
            <label v-if="engine !== 'sqlite'" class="flex cursor-pointer items-center gap-2 text-sm">
              <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm toggle-primary" />
              Start automatically when DevCatz launches
            </label>
          </fieldset>
          <p v-if="info" class="text-xs opacity-50">Builds: {{ info.sourceNote }}.</p>
        </template>
      </template>

      <TaskStepper v-else-if="showProgress && task" :task="task" :cancellable="!editing" @cancel="cancel" />
      <div v-else-if="showProgress" class="flex items-center gap-2 text-sm opacity-70"><span class="loading loading-spinner loading-sm" />Working…</div>

      <div class="modal-action mt-2">
        <template v-if="showProgress && !busy && task?.error">
          <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">Close</button>
          <button type="button" class="btn btn-sm" @click="showProgress = false">Back to settings</button>
          <button class="btn btn-primary btn-sm">Try again</button>
        </template>
        <template v-else-if="showProgress && busy && !editing">
          <button type="button" class="btn btn-sm btn-error btn-outline" :disabled="cancelling" @click="cancel">
            <span v-if="cancelling" class="loading loading-spinner loading-xs" />Cancel
          </button>
        </template>
        <template v-else-if="!showProgress">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy || !form || !!info?.requirement && !selectedVersion?.installed">
            <span v-if="busy" class="loading loading-spinner loading-xs" />
            {{ editing ? 'Save' : selectedVersion && !selectedVersion.installed && engine !== 'sqlite' ? 'Install & create' : 'Create' }}
          </button>
        </template>
      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
