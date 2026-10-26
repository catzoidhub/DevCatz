<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WaConfig, WaState } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import TaskStepper from './TaskStepper.vue';

/** Install (defaults, a fresh key) or edit one WhatsApp engine: port, domain label, API key, autostart. */
const props = defineProps<{ service: WaState; mode: 'install' | 'edit' }>();
const emit = defineEmits<{ close: []; done: [] }>();

const form = ref<WaConfig>({ ...(props.mode === 'edit' && props.service.config ? props.service.config : props.service.defaults) });
const show = ref(false);
const busy = ref(false);
const showProgress = ref(false);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const task = computed(() => (props.service.task?.kind === 'install' ? props.service.task : null));

function regenerate() {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  form.value.apiKey = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 24);
  show.value = true;
}
async function chooseFolder() {
  const dir = await herd.pickFolder();
  if (dir) form.value.dataDir = dir;
}
const cancelling = ref(false);
async function cancel() {
  cancelling.value = true;
  await attempt(() => herd.waCancelInstall(props.service.engine));
  cancelling.value = false;
}
async function submit() {
  busy.value = true;
  const config: WaConfig = { ...form.value, port: Number(form.value.port), domain: form.value.domain.trim().toLowerCase(), apiKey: form.value.apiKey.trim() };
  if (props.mode === 'install') showProgress.value = true;
  const ok = await attempt(() =>
    (props.mode === 'install' ? herd.waInstall(props.service.engine, config) : herd.waUpdate(props.service.engine, config))
      .then(() => true)
      .catch((e: Error) => (/cancelled/i.test(e.message) ? false : Promise.reject(e))),
  );
  busy.value = false;
  if (!ok) {
    showProgress.value = false;
    return;
  }
  notify('success', props.mode === 'install' ? `${props.service.name} installed` : `${props.service.name} settings saved${props.service.status === 'running' ? ' and restarted' : ''}`);
  if (props.mode === 'install') await new Promise((r) => setTimeout(r, 1200));
  emit('done');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[36rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div>
        <h3 class="text-lg font-semibold tracking-tight">{{ mode === 'install' ? `Install ${service.name}` : `${service.name} settings` }}</h3>
        <p class="text-xs opacity-60">{{ service.description }}</p>
      </div>

      <template v-if="!showProgress">
        <fieldset class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">API port</span>
            <input v-model.number="form.port" type="number" min="1024" max="65535" class="input input-sm w-full font-mono" required />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Domain</span>
            <div class="join w-full">
              <input v-model="form.domain" class="input input-sm join-item w-full font-mono" required spellcheck="false" pattern="[a-z0-9-]+" />
              <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">.{{ tld }}</span>
            </div>
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">{{ service.engine === 'gowa' ? 'Basic auth user' : 'Dashboard user' }}</span>
            <input v-model="form.apiUser" class="input input-sm w-full font-mono" required pattern="[A-Za-z0-9_.-]{1,40}" spellcheck="false" autocomplete="off" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">{{ service.engine === 'gowa' ? 'Basic auth password (API key)' : 'API key' }}</span>
            <div class="join w-full">
              <input v-model="form.apiKey" :type="show ? 'text' : 'password'" class="input input-sm join-item w-full font-mono" required minlength="8" spellcheck="false" autocomplete="new-password" />
              <button type="button" class="btn btn-sm join-item" @click="show = !show">{{ show ? 'Hide' : 'Show' }}</button>
              <button type="button" class="btn btn-sm join-item" title="Generate" @click="regenerate">↻</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">
              <template v-if="service.engine === 'gowa'">Basic auth <code>{{ form.apiUser || 'user' }}:&lt;key&gt;</code> on the API and the web UI.</template>
              <template v-else>Sent as <code>X-Api-Key</code>; also the dashboard and Swagger password for <code>{{ form.apiUser || 'user' }}</code>.</template>
            </span>
          </label>
        </fieldset>
        <fieldset class="space-y-3">
          <label v-if="mode === 'install'" class="block">
            <span class="label-caps mb-1 block">Data folder</span>
            <div class="join w-full">
              <input v-model="form.dataDir" class="input input-sm join-item w-full font-mono text-xs" required spellcheck="false" />
              <button type="button" class="btn btn-sm join-item" @click="chooseFolder">Choose…</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">Sessions (the linked phones) and received media live here.</span>
          </label>
          <label class="flex cursor-pointer items-center gap-3">
            <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm" />
            <span class="text-sm">Start with DevCatz</span>
          </label>
        </fieldset>
        <p class="text-xs opacity-60">
          <template v-if="service.engine === 'gowa'">The newest release is downloaded from GitHub (aldinokemal/go-whatsapp-web-multidevice), SHA-256 checked.</template>
          <template v-else>The newest <code>devlikeapro/waha</code> image is pulled with Docker (OrbStack / Docker Desktop must be running); the API is published on 127.0.0.1 only.</template>
          Unofficial gateways speak the WhatsApp Web protocol: link a test number, not one you cannot lose.
        </p>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ mode === 'install' ? 'Install' : 'Save' }}</button>
        </div>
      </template>

      <template v-else>
        <TaskStepper v-if="task" :task="task" />
        <div v-else class="flex items-center gap-2 py-6 text-sm opacity-70"><span class="loading loading-spinner loading-xs" />Starting…</div>
        <div class="modal-action">
          <button v-if="task && !task.done && !task.error" type="button" class="btn btn-ghost btn-sm" :disabled="cancelling" @click="cancel">Cancel install</button>
          <button v-else type="button" class="btn btn-sm" @click="emit('close')">Close</button>
        </div>
      </template>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
