<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ProxyInput, ProxyState } from '@shared/types';
import { words } from '@shared/platform';
import { attempt, herd, state } from '../store';

/**
 * Add or change a proxy / redirect (TODO §49): a name under the default domain, and where it goes. Proxy: protocol, IP
 * or host, port (no URL to type). Redirect: the address the browser is sent to.
 */
const props = defineProps<{ entry?: ProxyState }>();
const emit = defineEmits<{ close: []; saved: [id: string] }>();
const tld = computed(() => state.value?.settings.tld || 'localhost');
const e = props.entry;

const mode = ref<'proxy' | 'redirect'>(e?.mode ?? 'proxy');
const name = ref(e?.name ?? '');
const protocol = ref<'https' | 'http'>(e?.protocol ?? 'https');
const host = ref(e?.host ?? '');
const port = ref<number | ''>(e?.port ?? '');
const insecure = ref(e ? e.insecure !== false : true);
const ownHost = ref(e?.ownHost === true);
const url = ref(e?.url ?? '');
const group = ref(e?.group ?? '');
const groups = computed(() => [...new Set((state.value?.proxies ?? []).map((p) => p.group).filter(Boolean))].sort());

// The usual ports pick the protocol until you pick one yourself.
const protocolTouched = ref(!!e);
watch(port, (p) => {
  if (protocolTouched.value) return;
  if (p === 80 || p === 8080 || p === 8000 || p === 3000) protocol.value = 'http';
  else if (p === 443 || p === 8443 || p === 8006) protocol.value = 'https';
});

const input = computed<ProxyInput>(() =>
  mode.value === 'redirect'
    ? { name: name.value, mode: 'redirect', url: url.value, group: group.value, favorite: e?.favorite }
    : { name: name.value, mode: 'proxy', protocol: protocol.value, host: host.value, port: Number(port.value), insecure: insecure.value, ownHost: ownHost.value, group: group.value, favorite: e?.favorite },
);
const errs = ref<{ name: string | null; target: string | null }>({ name: null, target: null });
// A field is only called wrong once something was typed in it.
const touched = ref({ name: !!e, target: !!e });
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  input,
  () => {
    clearTimeout(timer);
    timer = setTimeout(async () => (errs.value = (await attempt(() => herd.proxyValidate(input.value, e?.id))) ?? errs.value), 200);
  },
  { immediate: true, deep: true },
);
onBeforeUnmount(() => clearTimeout(timer));
const ready = computed(() => !errs.value.name && !errs.value.target);
const preview = computed(() => (mode.value === 'redirect' ? url.value.trim() : host.value.trim() && port.value ? `${protocol.value}://${host.value.trim()}:${port.value}` : ''));

async function save() {
  const id = await attempt(() => herd.proxySave(input.value, e?.id), e ? 'Saved' : undefined);
  if (id) emit('saved', id);
}
</script>

<template>
  <Teleport to="body">
    <dialog open class="modal modal-open" @keydown.esc="emit('close')">
      <form class="modal-box w-[34rem] max-w-[95vw] space-y-5" @submit.prevent="ready && save()">
        <div class="space-y-1">
          <h3 class="text-lg font-semibold tracking-tight">{{ e ? `Edit ${e.name}` : 'Add a proxy' }}</h3>
          <p class="text-sm opacity-70">A name on this {{ words.computer }} for a server elsewhere, so its address needs no remembering.</p>
        </div>

        <fieldset class="min-w-0">
          <span class="label-caps mb-1 block">What it does</span>
          <div class="grid gap-2 sm:grid-cols-2">
            <button
              v-for="m in [
                { id: 'proxy', title: 'Proxy', text: 'The name stays in the address bar; DevCatz forwards to an IP and port.' },
                { id: 'redirect', title: 'Redirect', text: 'The browser goes on to the real address; logins stay there.' },
              ] as const"
              :key="m.id"
              type="button"
              class="flex min-w-0 items-start gap-3 rounded-box border px-3 py-2.5 text-left transition-colors"
              :class="mode === m.id ? 'border-primary bg-primary/5' : 'border-base-300/60 hover:bg-base-200/60'"
              @click="mode = m.id"
            >
              <input type="radio" class="radio radio-primary radio-sm mt-0.5" :checked="mode === m.id" tabindex="-1" />
              <span class="min-w-0 flex-1">
                <span class="block text-sm font-medium">{{ m.title }}</span>
                <span class="block text-xs opacity-60">{{ m.text }}</span>
              </span>
            </button>
          </div>
        </fieldset>

        <label class="block min-w-0">
          <span class="label-caps mb-1 block">Name</span>
          <div class="join flex">
            <span class="join-item flex shrink-0 items-center border border-base-300 bg-base-200 px-2.5 font-mono text-xs opacity-70">https://</span>
            <input v-model="name" class="input input-sm join-item min-w-0 flex-1 font-mono" :class="{ 'input-error': touched.name && errs.name }" placeholder="proxmox-prod" spellcheck="false" autocapitalize="off" autofocus @input="touched.name = true" />
            <span class="join-item flex shrink-0 items-center border border-base-300 bg-base-200 px-2.5 font-mono text-xs opacity-70">.{{ tld }}</span>
          </div>
          <span v-if="touched.name && errs.name" class="mt-1 block text-xs text-error">{{ errs.name }}</span>
        </label>

        <!-- Proxy: protocol, host, port -->
        <fieldset v-if="mode === 'proxy'" class="min-w-0 space-y-3">
          <div class="grid gap-3 sm:grid-cols-[7rem_1fr_7rem]">
            <label class="block">
              <span class="label-caps mb-1 block">Protocol</span>
              <select v-model="protocol" class="select select-sm w-full" @change="protocolTouched = true">
                <option value="https">HTTPS</option>
                <option value="http">HTTP</option>
              </select>
            </label>
            <label class="block min-w-0">
              <span class="label-caps mb-1 block">IP or host</span>
              <input v-model="host" class="input input-sm w-full font-mono" :class="{ 'input-error': touched.target && errs.target }" placeholder="10.10.10.10" spellcheck="false" autocapitalize="off" @input="touched.target = true" />
            </label>
            <label class="block">
              <span class="label-caps mb-1 block">Port</span>
              <input v-model.number="port" type="number" min="1" max="65535" class="input input-sm w-full font-mono" :class="{ 'input-error': touched.target && errs.target }" placeholder="8443" @input="touched.target = true" />
            </label>
          </div>
          <span v-if="touched.target && errs.target" class="block text-xs text-error">{{ errs.target }}</span>
          <label v-if="protocol === 'https'" class="flex cursor-pointer items-start gap-2.5 text-sm">
            <input v-model="insecure" type="checkbox" class="checkbox checkbox-sm checkbox-primary mt-0.5" />
            <span>The server uses its own certificate <span class="block text-xs opacity-60">Self-signed, as Proxmox, routers and NAS boxes have: DevCatz does not check it. Your browser still gets DevCatz's trusted certificate.</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2.5 text-sm">
            <input v-model="ownHost" type="checkbox" class="checkbox checkbox-sm checkbox-primary mt-0.5" />
            <span>Send this name as the Host <span class="block text-xs opacity-60">Off (the usual): the server sees its own address as the Host. On: it sees {{ name || 'name' }}.{{ tld }}, for servers that pick a site by name.</span></span>
          </label>
        </fieldset>

        <!-- Redirect: the address -->
        <label v-else class="block min-w-0">
          <span class="label-caps mb-1 block">Goes to</span>
          <input v-model="url" class="input input-sm w-full font-mono" :class="{ 'input-error': touched.target && errs.target }" placeholder="https://dokploy.example.com" spellcheck="false" autocapitalize="off" @input="touched.target = true" />
          <span v-if="touched.target && errs.target" class="mt-1 block text-xs text-error">{{ errs.target }}</span>
          <span v-else class="mt-1 block text-xs opacity-60">The path you ask for is kept: {{ name || 'name' }}.{{ tld }}/projects opens /projects there.</span>
        </label>

        <label class="block">
          <span class="label-caps mb-1 block">Group <span class="normal-case opacity-60">(optional)</span></span>
          <input v-model="group" list="proxy-groups" class="input input-sm w-60" placeholder="Production" maxlength="40" />
          <datalist id="proxy-groups"><option v-for="g in groups" :key="g" :value="g" /></datalist>
        </label>

        <p v-if="ready && preview" class="rounded-box bg-base-200/70 px-3 py-2 font-mono text-xs">
          https://{{ name }}.{{ tld }} <span class="font-sans opacity-60">{{ mode === 'proxy' ? 'forwards to' : 'redirects to' }}</span> {{ preview }}
        </p>

        <div class="modal-action mt-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="!ready">{{ e ? 'Save' : 'Add' }}</button>
        </div>
      </form>
    </dialog>
  </Teleport>
</template>
