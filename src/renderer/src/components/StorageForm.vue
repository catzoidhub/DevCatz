<script setup lang="ts">
import { isWin } from '../platform';
import { computed, ref } from 'vue';
import type { StorageConfig, StorageState } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import TaskStepper from './TaskStepper.vue';
import RunInPicker from './RunInPicker.vue';
import { gwPlaces, placeOf } from '../engines';

/** Install (defaults) or edit (current settings) one object storage service. */
const props = defineProps<{ service: StorageState; mode: 'install' | 'edit' }>();
const emit = defineEmits<{ close: []; done: [] }>();

const form = ref<StorageConfig>({ ...(props.mode === 'edit' && props.service.config ? props.service.config : props.service.defaults) });
// Garage's Web UI is on unless it was turned off (installs from before the switch have no value).
if (props.service.kind === 'garage') form.value.webUi = form.value.webUi !== false;
// Older installs have no binaryDir: show the folder the binary really is in.
if (props.mode === 'edit' && !form.value.binaryDir && !form.value.binaryPath && props.service.binary) {
  form.value.binaryDir = props.service.binary.replace(/\/[^/]+$/, '');
}
const binarySource = ref<'download' | 'existing'>(form.value.binaryPath ? 'existing' : 'download');
const showSecret = ref(false);
const REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-southeast-3', 'ap-northeast-1', 'ap-south-1'];
if (!form.value.region) form.value.region = state.value?.settings.s3Region || 'us-east-1';
const busy = ref(false);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
/** After Install: the form gives way to the step list until it finishes (or fails: back to the form to fix and retry). */
const showProgress = ref(false);
const task = computed(() => (props.service.task?.kind === 'install' ? props.service.task : null));

async function chooseFolder() {
  const dir = await herd.pickFolder();
  if (dir) form.value.dataDir = dir;
}
async function chooseBinaryDir() {
  const dir = await herd.pickFolder();
  if (dir) form.value.binaryDir = dir;
}
async function chooseBinary() {
  const file = await herd.pickFile(`${props.service.name} server binary`);
  if (file) form.value.binaryPath = file;
}
function generate() {
  // Garage takes a 64-digit hexadecimal secret only.
  if (props.service.kind === 'garage') {
    form.value.secretKey = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, '0')).join('');
    showSecret.value = true;
    return;
  }
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  form.value.secretKey = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 24);
  showSecret.value = true;
}

/** Garage has a console only with the optional Web UI. */
const showConsole = computed(() => props.service.kind !== 'garage' || form.value.webUi !== false);
/** What the second port / domain is called: a console, Ceph's dashboard. */
const consoleWord = computed(() => (props.service.consoleKind === 'dashboard' ? 'Dashboard' : 'Console'));
/** Where its containers run: DoCatz (default wherever it exists) or the system's engine. */
const engineWord = computed(() => {
  const p = placeOf(form.value.docker?.container);
  return p ? p.name : gwPlaces.value.length ? 'Docker' : 'DoCatz';
});
/** The Run in choice writes here; the form starts from the defaults' docker object. */
const runIn = computed({
  get: () => form.value.docker?.container,
  set: (v) => (form.value.docker = { image: form.value.docker?.image ?? '', container: v ?? 'docatz' }),
});

const cancelling = ref(false);
async function cancel() {
  cancelling.value = true;
  await attempt(() => herd.storageCancelInstall(props.service.kind));
  cancelling.value = false;
}

async function submit() {
  busy.value = true;
  const config: StorageConfig = {
    ...form.value,
    apiPort: Number(form.value.apiPort),
    consolePort: Number(form.value.consolePort),
    apiDomain: form.value.apiDomain.trim().toLowerCase(),
    consoleDomain: form.value.consoleDomain.trim().toLowerCase(),
    binaryPath: binarySource.value === 'existing' ? form.value.binaryPath.trim() : '',
    binaryDir: (form.value.binaryDir ?? '').trim() || props.service.defaults.binaryDir,
    // A nested object of the form is a Vue proxy, which IPC cannot copy ("An object could not be cloned"): send a plain one.
    docker: form.value.docker ? { ...form.value.docker } : form.value.docker,
  };
  if (props.mode === 'install') showProgress.value = true;
  const ok = await attempt(() =>
    (props.mode === 'install' ? herd.storageInstall(props.service.kind, config) : herd.storageUpdate(props.service.kind, config))
      .then(() => true)
      // Cancelling is not an error worth a toast; the step list says it.
      .catch((e: Error) => (/Install cancelled/.test(e.message) ? false : Promise.reject(e))),
  );
  busy.value = false;
  if (!ok) return; // the step list shows where it failed
  notify('success', props.mode === 'install' ? `${props.service.name} installed` : `${props.service.name} settings saved`);
  // Let the finished step list show for a moment.
  if (props.mode === 'install') await new Promise((r) => setTimeout(r, 1200));
  emit('done');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[38rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div>
        <h3 class="text-lg font-semibold tracking-tight">{{ mode === 'install' ? `Install ${service.name}` : `${service.name} settings` }}</h3>
        <p class="text-xs opacity-60">{{ service.description }}</p>
        <p v-if="service.inDocker && service.needs" class="mt-1 text-xs opacity-60">{{ service.needs }}</p>
      </div>

      <template v-if="!showProgress">
      <!-- 1. Ports -->
      <fieldset class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="label-caps mb-1 block">API port</span>
          <input v-model.number="form.apiPort" type="number" min="1024" max="65535" class="input input-sm w-full font-mono" required />
        </label>
        <label v-if="showConsole" class="block">
          <span class="label-caps mb-1 block">{{ consoleWord }} port</span>
          <input v-model.number="form.consolePort" type="number" min="1024" max="65535" class="input input-sm w-full font-mono" required />
        </label>
        <p v-if="service.kind === 'garage'" class="col-span-2 -mt-1 text-xs opacity-60">
          Garage also serves public buckets as websites on port {{ Number(form.apiPort) + 2 }}, at
          <code>&lt;bucket&gt;.web.{{ form.apiDomain }}.{{ tld }}</code>.
        </p>
        <p v-if="service.kind === 'seaweedfs'" class="col-span-2 -mt-1 text-xs opacity-60">
          SeaweedFS also uses master {{ Number(form.apiPort) + 1000 }}, volume {{ Number(form.apiPort) + 2 }} and filer {{ Number(form.apiPort) + 3 }} (gRPC = +10000).
        </p>
      </fieldset>

      <!-- 2. Domains -->
      <fieldset class="grid grid-cols-2 gap-3">
        <label class="block">
          <span class="label-caps mb-1 block">API domain</span>
          <div class="join w-full">
            <input v-model="form.apiDomain" class="input input-sm join-item w-full font-mono" required spellcheck="false" />
            <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">.{{ tld }}</span>
          </div>
        </label>
        <label v-if="showConsole" class="block">
          <span class="label-caps mb-1 block">{{ consoleWord }} domain</span>
          <div class="join w-full">
            <input v-model="form.consoleDomain" class="input input-sm join-item w-full font-mono" required spellcheck="false" />
            <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">.{{ tld }}</span>
          </div>
        </label>
        <p class="col-span-2 -mt-1 text-xs opacity-60">
          HTTPS through DevCatz's proxy; the suffix follows Settings → General → Default domain. Buckets also answer on
          <code>&lt;bucket&gt;.{{ form.apiDomain }}.{{ tld }}</code>.
        </p>
      </fieldset>

      <!-- 3. Folders, binary, autostart -->
      <fieldset class="space-y-3">
        <RunInPicker v-if="service.inDocker && mode === 'install'" v-model="runIn" :kind="service.kind" :name="service.name" :movable="false" />
        <div v-if="service.inDocker" role="note" class="rounded-box bg-base-200/60 px-3 py-2.5 text-xs leading-relaxed opacity-80">
          Runs as a container of the official image in {{ engineWord }}: no program to download, and the data stays in the
          Docker volume <code>devcatz-storage-{{ service.kind }}</code>. Uninstall asks whether to delete it.
        </div>
        <label v-if="service.kind === 'garage'" class="flex cursor-pointer items-start gap-2 text-sm">
          <input v-model="form.webUi" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
          <span>
            <span class="block">Garage Web UI as the console</span>
            <span class="block text-xs opacity-60">
              A community project (khairul169/garage-webui), not made by Garage's authors: cluster status, buckets and keys in
              the browser, logged in with the S3 keys. Without it, manage buckets here in DevCatz.
            </span>
          </span>
        </label>
        <label v-if="!service.inDocker" class="block">
          <span class="label-caps mb-1 block">Data folder</span>
          <div class="join w-full">
            <input v-model="form.dataDir" class="input input-sm join-item w-full font-mono text-xs" required spellcheck="false" />
            <button type="button" class="btn btn-sm join-item" @click="chooseFolder">Choose…</button>
          </div>
        </label>
        <div v-if="!service.inDocker">
          <span class="label-caps mb-1 block">Binary</span>
          <div class="flex flex-wrap gap-4 text-sm">
            <label class="flex cursor-pointer items-center gap-2">
              <input v-model="binarySource" type="radio" value="download" class="radio radio-xs radio-primary" />
              {{ mode === 'install' ? 'Download the official build (checksum-verified)' : 'DevCatz-managed build' }}
            </label>
            <label class="flex cursor-pointer items-center gap-2">
              <input v-model="binarySource" type="radio" value="existing" class="radio radio-xs radio-primary" />
              Use an existing binary
            </label>
          </div>
          <div v-if="binarySource === 'download'" class="mt-2">
            <div class="join w-full">
              <input v-model="form.binaryDir" class="input input-sm join-item w-full font-mono text-xs" placeholder="Binary folder" spellcheck="false" />
              <button type="button" class="btn btn-sm join-item" @click="chooseBinaryDir">Choose…</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">
              {{ mode === 'install' ? 'The download goes into this folder' : 'Changing it moves the binary there' }} (<code>{{ service.kind === 'seaweedfs' ? 'weed' : service.kind }}</code>).
            </span>
          </div>
          <div v-if="binarySource === 'existing'" class="join mt-2 w-full">
            <input v-model="form.binaryPath" class="input input-sm join-item w-full font-mono text-xs" :placeholder="isWin ? 'C:\\Tools\\rustfs.exe' : '/opt/homebrew/bin/minio'" spellcheck="false" />
            <button type="button" class="btn btn-sm join-item" @click="chooseBinary">Choose…</button>
          </div>
        </div>
        <label class="flex cursor-pointer items-center gap-2 text-sm">
          <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm toggle-primary" />
          Start automatically when DevCatz launches
        </label>
      </fieldset>

      <!-- 4. Credentials + region -->
      <fieldset class="grid grid-cols-2 gap-3">
        <label class="col-span-2 block">
          <span class="label-caps mb-1 block">Region</span>
          <input v-model="form.region" class="input input-sm w-full font-mono" list="s3-regions" required spellcheck="false" />
          <datalist id="s3-regions">
            <option v-for="r in REGIONS" :key="r" :value="r" />
          </datalist>
          <span class="mt-1 block text-xs opacity-60">
            {{ service.kind === 'seaweedfs' ? 'SeaweedFS accepts any region; it is used in the .env lines.' : 'The server runs in this region; clients must sign for it (AWS_DEFAULT_REGION).' }}
            Match production, e.g. <code>ap-southeast-3</code> (Jakarta).
          </span>
        </label>
        <label class="block">
          <span class="label-caps mb-1 block">Access key (user)</span>
          <input v-model="form.accessKey" class="input input-sm w-full font-mono" required minlength="3" spellcheck="false" autocomplete="off" />
          <span v-if="service.kind === 'garage'" class="mt-1 block text-xs opacity-60">Garage's format: GK + 24 hex digits; the secret is 64 hex digits (↻ makes one).</span>
          <span v-if="service.kind === 'ceph'" class="mt-1 block text-xs opacity-60">Also the Ceph dashboard's login (user and password).</span>
        </label>
        <label class="block">
          <span class="label-caps mb-1 block">Secret key (password)</span>
          <div class="join w-full">
            <input
              v-model="form.secretKey"
              :type="showSecret ? 'text' : 'password'"
              class="input input-sm join-item w-full font-mono"
              required
              minlength="8"
              spellcheck="false"
              autocomplete="new-password"
            />
            <button type="button" class="btn btn-sm join-item" :title="showSecret ? 'Hide' : 'Show'" @click="showSecret = !showSecret">{{ showSecret ? 'Hide' : 'Show' }}</button>
            <button type="button" class="btn btn-sm join-item" title="Generate a random secret" @click="generate">↻</button>
          </div>
        </label>
        <p v-if="mode === 'edit'" class="col-span-2 -mt-1 text-xs opacity-60">
          Changing the keys of an existing data folder: MinIO/RustFS keep the old root user in their data; new keys apply to a fresh folder.
        </p>
      </fieldset>


      </template>
      <TaskStepper v-else-if="task" :task="task" cancellable @cancel="cancel" />
      <div v-else class="flex items-center gap-2 text-sm opacity-70"><span class="loading loading-spinner loading-sm" />Starting…</div>

      <div class="modal-action mt-2">
        <template v-if="showProgress && !busy && task?.error">
          <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">Close</button>
          <button type="button" class="btn btn-sm" @click="showProgress = false">Back to settings</button>
          <button class="btn btn-primary btn-sm">{{ task.cancelled ? 'Install again' : 'Retry' }}</button>
        </template>
        <template v-else-if="showProgress && busy">
          <button type="button" class="btn btn-sm btn-error btn-outline" :disabled="cancelling" @click="cancel">
            <span v-if="cancelling" class="loading loading-spinner loading-xs" />Cancel install
          </button>
        </template>
        <template v-else-if="!showProgress">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy">
            <span v-if="busy" class="loading loading-spinner loading-xs" />
            {{ mode === 'install' ? 'Install' : 'Save' }}
          </button>
        </template>

      </div>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
