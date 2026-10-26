<script setup lang="ts">
import { computed, ref } from 'vue';
import type { GwConfig, GwState } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import { GW_LOGO } from '../gateways';
import TaskStepper from './TaskStepper.vue';

/** Install (defaults, a fresh password) or edit one email / push / SMS gateway: ports, domain label, login, autostart. */
const props = defineProps<{ service: GwState; mode: 'install' | 'edit' }>();
const emit = defineEmits<{ close: []; done: [] }>();

const base = props.mode === 'edit' && props.service.config ? props.service.config : props.service.defaults;
const form = ref<GwConfig>({ ...base, ports: { ...base.ports }, secrets: { ...base.secrets } });
const show = ref(false);
const busy = ref(false);
const showProgress = ref(false);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const task = computed(() => (props.service.task?.kind === 'install' ? props.service.task : null));
const H = herd;

function regenerate() {
  const bytes = crypto.getRandomValues(new Uint8Array(18));
  form.value.password = btoa(String.fromCharCode(...bytes)).replace(/[+/=]/g, '').slice(0, 16);
  show.value = true;
}
async function chooseFolder() {
  const dir = await herd.pickFolder();
  if (dir) form.value.dataDir = dir;
}
async function submit() {
  busy.value = true;
  const ports = Object.fromEntries(Object.entries(form.value.ports).map(([k, v]) => [k, Number(v)]));
  // A plain copy: the nested `ports` / `secrets` are Vue proxies, which IPC cannot clone.
  const config: GwConfig = JSON.parse(JSON.stringify({ ...form.value, port: Number(form.value.port), ports, domain: form.value.domain.trim().toLowerCase(), user: form.value.user.trim() })) as GwConfig;
  if (props.mode === 'install') showProgress.value = true;
  const ok = await attempt(() =>
    (props.mode === 'install' ? herd.gwInstall(props.service.kind, config) : herd.gwUpdate(props.service.kind, config))
      .then(() => true)
      .catch((e: Error) => (/cancelled/i.test(e.message) ? false : Promise.reject(e))),
  );
  busy.value = false;
  if (!ok) {
    showProgress.value = false;
    return;
  }
  notify('success', props.mode === 'install' ? `${props.service.name} installed: start it to finish the setup` : `${props.service.name} settings saved${props.service.status === 'running' ? ' and restarted' : ''}`);
  if (props.mode === 'install') await new Promise((r) => setTimeout(r, 1000));
  emit('done');
}
const userLabel = computed(() => (props.service.kind === 'postal' ? 'Admin email' : props.service.kind === 'stalwart' ? 'Admin user' : props.service.kind === 'jasmin' ? 'jCli user' : 'User'));
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[38rem] max-w-[95vw] space-y-4" @submit.prevent="submit">
      <div class="flex items-start gap-3">
        <img :src="GW_LOGO[service.kind]" alt="" class="size-10 shrink-0 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
        <div>
          <h3 class="text-lg font-semibold tracking-tight">{{ mode === 'install' ? `Install ${service.name}` : `${service.name} settings` }}</h3>
          <p class="text-xs opacity-60">{{ service.description }}</p>
        </div>
      </div>

      <template v-if="!showProgress">
        <fieldset class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">{{ service.kind === 'jasmin' ? 'HTTP API port' : 'Web / API port' }}</span>
            <input v-model.number="form.port" type="number" min="1024" max="65535" class="input input-sm w-full font-mono" required />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Domain</span>
            <div class="join w-full">
              <input v-model="form.domain" class="input input-sm join-item w-full font-mono" required spellcheck="false" pattern="[a-z0-9-]+" />
              <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">.{{ tld }}</span>
            </div>
          </label>
          <label v-for="f in service.portFields" :key="f.key" class="block">
            <span class="label-caps mb-1 block">{{ f.label }}</span>
            <input v-model.number="form.ports[f.key]" type="number" min="1024" max="65535" class="input input-sm w-full font-mono" required />
          </label>
        </fieldset>
        <fieldset v-if="service.kind === 'telegram'" class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">api_id</span>
            <input v-model="form.secrets.apiId" class="input input-sm w-full font-mono" required inputmode="numeric" pattern="\d{3,12}" spellcheck="false" autocomplete="off" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">api_hash</span>
            <input v-model="form.secrets.apiHash" :type="show ? 'text' : 'password'" class="input input-sm w-full font-mono" required pattern="[0-9a-fA-F]{32}" spellcheck="false" autocomplete="off" />
          </label>
          <label class="col-span-2 block">
            <span class="label-caps mb-1 block">Bot token (optional, for the test sender and .env)</span>
            <div class="join w-full">
              <input v-model="form.secrets.botToken" :type="show ? 'text' : 'password'" class="input input-sm join-item w-full font-mono" placeholder="123456789:AA…" spellcheck="false" autocomplete="off" />
              <button type="button" class="btn btn-sm join-item" @click="show = !show">{{ show ? 'Hide' : 'Show' }}</button>
            </div>
          </label>
          <p class="col-span-2 text-xs opacity-60">
            api_id and api_hash come from <a class="link" @click="H.openUrl('https://my.telegram.org/apps')">my.telegram.org → API development tools</a> (once per Telegram account); the bot token from
            <a class="link" @click="H.openUrl('https://t.me/BotFather')">@BotFather</a>. They stay in DevCatz's settings on this Mac.
          </p>
        </fieldset>
        <fieldset v-if="service.kind !== 'jasmin' && service.kind !== 'telegram'" class="grid grid-cols-2 gap-3">
          <label class="block">
            <span class="label-caps mb-1 block">{{ userLabel }}</span>
            <input v-model="form.user" class="input input-sm w-full font-mono" required spellcheck="false" autocomplete="off" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Password</span>
            <div class="join w-full">
              <input v-model="form.password" :type="show ? 'text' : 'password'" class="input input-sm join-item w-full font-mono" required minlength="8" spellcheck="false" autocomplete="new-password" />
              <button type="button" class="btn btn-sm join-item" @click="show = !show">{{ show ? 'Hide' : 'Show' }}</button>
              <button type="button" class="btn btn-sm join-item" title="Generate" @click="regenerate">↻</button>
            </div>
          </label>
          <p class="col-span-2 text-xs opacity-60">
            <template v-if="service.kind === 'stalwart'">The web admin login; the same password is used for the <code>devcatz@devcatz.test</code> mailbox sites send from.</template>
            <template v-else-if="service.kind === 'postal'">The web UI login. The API key and SMTP password are made on the first start.</template>
            <template v-else-if="service.kind === 'ntfy'">The admin login (web app, phone app); an access token for sites is made on the first start.</template>
            <template v-else>The web UI login; an application token for sites is made on the first start.</template>
          </p>
        </fieldset>
        <fieldset class="space-y-3">
          <label v-if="mode === 'install'" class="block">
            <span class="label-caps mb-1 block">Data folder</span>
            <div class="join w-full">
              <input v-model="form.dataDir" class="input input-sm join-item w-full font-mono text-xs" required spellcheck="false" />
              <button type="button" class="btn btn-sm join-item" @click="chooseFolder">Choose…</button>
            </div>
          </label>
          <label class="flex cursor-pointer items-center gap-3">
            <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm toggle-primary" />
            <span class="text-sm">Start with DevCatz</span>
          </label>
        </fieldset>
        <p class="text-xs opacity-60">
          <template v-if="service.docker">Runs in Docker (OrbStack / Docker Desktop must be running); ports are published on 127.0.0.1 only.</template>
          <template v-else>Downloaded from GitHub releases, SHA-256 checked; listens on 127.0.0.1 only.</template>
          <template v-if="service.category === 'email'"> Outgoing mail goes to the DevCatz mail catcher, so nothing leaves this Mac.</template>
          <template v-if="service.kind === 'jasmin'"> Every SMS goes to the DevCatz SMS catcher instead of an operator.</template>
          <template v-if="mode === 'edit'"> Changing a port, the domain or the login sets the gateway up again on its next start.</template>
        </p>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy"><span v-if="busy" class="loading loading-spinner loading-xs" />{{ mode === 'install' ? 'Install' : 'Save' }}</button>
        </div>
      </template>

      <template v-else>
        <TaskStepper v-if="task" :task="task" :cancellable="!task.done && !task.error" @cancel="H.gwCancelInstall(service.kind)" />
        <div v-else class="flex items-center gap-2 py-6 text-sm opacity-70"><span class="loading loading-spinner loading-xs" />Starting…</div>
        <div class="modal-action">
          <button v-if="!task || task.done || task.error" type="button" class="btn btn-sm" @click="emit('close')">Close</button>
        </div>
      </template>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
