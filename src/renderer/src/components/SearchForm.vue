<script setup lang="ts">
import { computed, ref } from 'vue';
import type { SearchConfig, SearchState } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import TaskStepper from './TaskStepper.vue';

/** Install (defaults, a fresh key) or edit one search engine: ports, domain, key, heap, origins, data folder, autostart. */
const props = defineProps<{ service: SearchState; mode: 'install' | 'edit' }>();
const emit = defineEmits<{ close: []; done: [] }>();

const form = ref<SearchConfig>({ ...(props.mode === 'edit' && props.service.config ? props.service.config : props.service.defaults) });
const f = computed(() => props.service.fields);
const show = ref(false);
const busy = ref(false);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const showProgress = ref(false);
const task = computed(() => (props.service.task?.kind === 'install' ? props.service.task : null));

function regenerate() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  form.value.key = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 32);
  show.value = true;
}
async function chooseFolder() {
  const dir = await herd.pickFolder();
  if (dir) form.value.dataDir = dir;
}
const cancelling = ref(false);
async function cancel() {
  cancelling.value = true;
  await attempt(() => herd.searchCancelInstall(props.service.kind));
  cancelling.value = false;
}

async function submit() {
  busy.value = true;
  const config: SearchConfig = {
    ...form.value,
    port: Number(form.value.port),
    extraPort: Number(form.value.extraPort) || 0,
    memoryMb: Number(form.value.memoryMb) || 512,
    domain: form.value.domain.trim().toLowerCase(),
    allowedOrigins: form.value.allowedOrigins.trim() || '*',
  };
  if (props.mode === 'install') showProgress.value = true;
  const ok = await attempt(() =>
    (props.mode === 'install' ? herd.searchInstall(props.service.kind, config) : herd.searchUpdate(props.service.kind, config))
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
            <span class="label-caps mb-1 block">{{ service.features.http ? 'HTTP port' : 'TCP port' }}</span>
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
            <span v-if="!service.features.http" class="mt-1 block text-xs opacity-60">
              Sonic speaks its own TCP protocol, so nothing is proxied: the label names the service (and is what you type to uninstall it); backends use 127.0.0.1.
            </span>
            <span v-else class="mt-1 block text-xs opacity-60">
              <code>https://{{ form.domain }}.{{ tld }}</code> through DevCatz's proxy{{ service.kind === 'meilisearch' ? ' (the mini dashboard is at its root)' : '' }}; backends use 127.0.0.1.
            </span>
          </label>
        </fieldset>

        <fieldset class="grid grid-cols-2 gap-3">
          <label v-if="f.key" class="col-span-2 block">
            <span class="label-caps mb-1 block">{{ f.key }}</span>
            <div class="join w-full">
              <input v-model="form.key" :type="show ? 'text' : 'password'" class="input input-sm join-item w-full font-mono" required minlength="16" spellcheck="false" autocomplete="new-password" />
              <button type="button" class="btn btn-sm join-item" @click="show = !show">{{ show ? 'Hide' : 'Show' }}</button>
              <button type="button" class="btn btn-sm join-item" title="Generate" @click="regenerate">↻</button>
            </div>
            <span class="mt-1 block text-xs opacity-60">
              <template v-if="service.kind === 'zincsearch'">Password of the <code>admin</code> user (backends only; ZincSearch has no search-only keys).</template>
              <template v-else-if="service.kind === 'sonic'">Sonic Channel password (backends only).</template>
              <template v-else>Backends use it; front ends get a search-only key (Keys tab / .env lines).</template>
            </span>
          </label>
          <p v-else class="col-span-2 text-xs opacity-60">No authentication: {{ service.name }} listens on 127.0.0.1 only (and through DevCatz's proxy).</p>
          <label v-if="f.memory" class="block">
            <span class="label-caps mb-1 block">Java heap (MB)</span>
            <input v-model.number="form.memoryMb" type="number" min="256" max="32768" step="128" class="input input-sm w-full font-mono" required />
          </label>
          <label v-if="service.kind !== 'sonic' && service.kind !== 'zincsearch'" class="block" :class="{ 'col-span-2': !f.memory }">
            <span class="label-caps mb-1 block">Allowed origins (CORS)</span>
            <input v-model="form.allowedOrigins" class="input input-sm w-full font-mono" placeholder="*" spellcheck="false" />
          </label>
        </fieldset>

        <fieldset class="space-y-3">
          <label class="block">
            <span class="label-caps mb-1 block">Data folder</span>
            <div class="join w-full">
              <input v-model="form.dataDir" class="input input-sm join-item w-full font-mono text-xs" required spellcheck="false" />
              <button type="button" class="btn btn-sm join-item" @click="chooseFolder">Choose…</button>
            </div>
          </label>
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm toggle-primary" />
            Start automatically when DevCatz launches
          </label>
        </fieldset>
        <p v-if="mode === 'install'" class="text-xs opacity-60">
          <template v-if="service.kind === 'opensearch'">OpenSearch has no macOS build: DevCatz runs its core distribution (SHA-512 checked) on Eclipse Temurin 21 (SHA-256 checked), about 300 MB.</template>
          <template v-else-if="service.kind === 'typesense'">From dl.typesense.org; the binary’s MD5 shipped in the tarball is checked.</template>
          <template v-else-if="service.kind === 'manticore'">From repo.manticoresearch.com (macOS build, over HTTPS).</template>
          <template v-else-if="service.kind === 'sonic'">Sonic publishes no macOS build: DevCatz downloads Homebrew's (from ghcr.io, SHA-256 from formulae.brew.sh); Homebrew itself is not needed.</template>
          <template v-else>The official build is downloaded from GitHub and its SHA-256 checked.</template>
        </p>
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
