<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WsConfig, WsState } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import TaskStepper from './TaskStepper.vue';

/** Install (defaults, fresh keys) or edit one WebSocket server. */
const props = defineProps<{ service: WsState; mode: 'install' | 'edit' }>();
const emit = defineEmits<{ close: []; done: [] }>();

const form = ref<WsConfig>({ ...(props.mode === 'edit' && props.service.config ? props.service.config : props.service.defaults) });
const f = computed(() => props.service.fields);
const show = ref(false);
const busy = ref(false);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const showProgress = ref(false);
const task = computed(() => (props.service.task?.kind === 'install' ? props.service.task : null));

function random(n = 32) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, n);
}
function regenerate(field: 'key' | 'secret') {
  form.value[field] = random(props.service.kind === 'mercure' ? 40 : 24);
  show.value = true;
}
async function chooseFolder() {
  const dir = await herd.pickFolder();
  if (dir) form.value.dataDir = dir;
}
const cancelling = ref(false);
async function cancel() {
  cancelling.value = true;
  await attempt(() => herd.wsCancelInstall(props.service.kind));
  cancelling.value = false;
}

async function submit() {
  busy.value = true;
  const config: WsConfig = {
    ...form.value,
    port: Number(form.value.port),
    extraPort: Number(form.value.extraPort) || 0,
    domain: form.value.domain.trim().toLowerCase(),
    allowedOrigins: form.value.allowedOrigins.trim() || '*',
  };
  if (props.mode === 'install') showProgress.value = true;
  const ok = await attempt(() =>
    (props.mode === 'install' ? herd.wsInstall(props.service.kind, config) : herd.wsUpdate(props.service.kind, config))
      .then(() => true)
      .catch((e: Error) => (/Install cancelled/.test(e.message) ? false : Promise.reject(e))),
  );
  busy.value = false;
  if (!ok) return;
  notify('success', props.mode === 'install' ? `${props.service.name} installed` : `${props.service.name} settings saved${props.service.status === 'running' ? ' and restarted' : ''}`);
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
      </div>

      <template v-if="!showProgress">
        <fieldset class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">{{ service.kind === 'nats' ? 'WebSocket port' : 'Port' }}</span>
            <input v-model.number="form.port" type="number" min="1024" max="65535" class="input input-sm w-full font-mono" required />
          </label>
          <label v-if="f.extraPort" class="block">
            <span class="label-caps mb-1 block">{{ f.extraPort }}</span>
            <input v-model.number="form.extraPort" type="number" min="1024" max="65535" class="input input-sm w-full font-mono" required />
          </label>
          <label class="col-span-2 block">
            <span class="label-caps mb-1 block">Domain</span>
            <div class="join w-full">
              <input v-model="form.domain" class="input input-sm join-item w-full font-mono" required spellcheck="false" />
              <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">.{{ tld }}</span>
            </div>
            <span class="mt-1 block text-xs opacity-60">
              Clients connect to <code>{{ service.kind === 'mercure' ? 'https' : 'wss' }}://{{ form.domain }}.{{ tld }}</code> through DevCatz's HTTPS proxy<template v-if="service.kind === 'nats'">; monitoring on 127.0.0.1:{{ Number(form.port) + 1 }}</template>.
            </span>
          </label>
        </fieldset>

        <fieldset class="grid grid-cols-2 gap-3">
          <label v-if="f.appId" class="block">
            <span class="label-caps mb-1 block">{{ f.appId }}</span>
            <input v-model="form.appId" class="input input-sm w-full font-mono" required spellcheck="false" autocomplete="off" />
          </label>
          <label v-if="f.key" class="block" :class="{ 'col-span-2': !f.appId }">
            <span class="label-caps mb-1 block">{{ f.key }}</span>
            <div class="join w-full">
              <input v-model="form.key" :type="show || service.kind === 'sockudo' ? 'text' : 'password'" class="input input-sm join-item w-full font-mono" :required="service.kind !== 'nats'" spellcheck="false" autocomplete="off" />
              <button type="button" class="btn btn-sm join-item" title="Generate" @click="regenerate('key')">↻</button>
            </div>
          </label>
          <label v-if="f.secret" class="col-span-2 block">
            <span class="label-caps mb-1 block">{{ f.secret }}</span>
            <div class="join w-full">
              <input v-model="form.secret" :type="show ? 'text' : 'password'" class="input input-sm join-item w-full font-mono" required minlength="8" spellcheck="false" autocomplete="new-password" />
              <button type="button" class="btn btn-sm join-item" @click="show = !show">{{ show ? 'Hide' : 'Show' }}</button>
              <button type="button" class="btn btn-sm join-item" title="Generate" @click="regenerate('secret')">↻</button>
            </div>
          </label>
          <label class="col-span-2 block">
            <span class="label-caps mb-1 block">Allowed origins</span>
            <input v-model="form.allowedOrigins" class="input input-sm w-full font-mono" placeholder="*" spellcheck="false" />
            <span class="mt-1 block text-xs opacity-60">Space or comma separated, e.g. <code>https://shop.{{ tld }}</code>; <code>*</code> = any (fine on this Mac).</span>
          </label>
        </fieldset>

        <fieldset class="space-y-3">
          <label class="block">
            <span class="label-caps mb-1 block">Data folder</span>
            <div class="join w-full">
              <input v-model="form.dataDir" class="input input-sm join-item w-full font-mono text-xs" required spellcheck="false" />
              <button type="button" class="btn btn-sm join-item" @click="chooseFolder">Choose…</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">Its config file is written here on every start{{ service.kind === 'nats' ? ' (JetStream data too)' : '' }}.</span>
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm toggle-primary" />
            Start automatically when DevCatz launches
          </label>
        </fieldset>
        <p v-if="mode === 'install'" class="text-xs opacity-60">The official build is downloaded from GitHub and its SHA-256 checked.</p>
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
