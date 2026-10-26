<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ExposeProvider, ExposeShare } from '@shared/types';
import { attempt, herd, navRequest, state } from '../store';
import { PROVIDER_LOGO } from '../expose';
import TaskStepper from './TaskStepper.vue';
import CatMood from './CatMood.vue';

/** "Share a site": provider, which domain, basic auth, expiry; starts the tunnel. */
const props = defineProps<{ siteId?: string }>();
const emit = defineEmits<{ close: []; started: [share: ExposeShare] }>();

const sites = computed(() => state.value?.projects ?? []);
const expose = computed(() => state.value?.expose ?? null);
const form = ref({ siteId: props.siteId ?? sites.value[0]?.id ?? '', domain: '', provider: 'cloudflare' as ExposeProvider, hostname: '', subdomain: '', user: '', password: '', expiry: state.value?.settings.exposeExpiryMinutes ?? 0 });
const PROVIDERS: { id: ExposeProvider; name: string; hint: string }[] = [
  { id: 'cloudflare', name: 'Cloudflare quick', hint: 'random trycloudflare.com URL, no account' },
  { id: 'cloudflare-domain', name: 'Your Cloudflare domain', hint: 'fixed hostname on your zone' },
  { id: 'ngrok', name: 'ngrok', hint: 'your ngrok account' },
  { id: 'expose', name: 'Expose', hint: 'expose.dev' },
];
/** Why the chosen provider cannot start yet (tool or account missing), or null. */
const blocker = computed(() => {
  const e = expose.value;
  if (!e) return null;
  const p = form.value.provider;
  const tool = p === 'ngrok' ? 'ngrok' : p === 'expose' ? 'expose' : 'cloudflared';
  if (!e.tools[tool]) return { text: `${tool === 'expose' ? 'Expose' : tool} is not installed yet.`, where: 'expose' as const };
  if (p === 'cloudflare-domain' && !e.accounts.cloudflare) return { text: 'Log in to Cloudflare first.', where: 'expose' as const };
  if (p === 'ngrok' && !e.accounts.ngrok.token) return { text: 'Add your ngrok authtoken first.', where: 'settings' as const };
  if (p === 'expose' && !e.accounts.expose.token) return { text: 'Add your Expose token first.', where: 'settings' as const };
  return null;
});
const needHost = computed(() => form.value.provider === 'cloudflare-domain' && !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(form.value.hostname.trim()));
const site = computed(() => sites.value.find((p) => p.id === form.value.siteId) ?? null);
const domains = computed(() => (site.value ? [site.value.domain, ...site.value.stack.apps.map((a) => a.domain).filter((d): d is string => Boolean(d && d !== site.value!.domain))] : []));
const busy = ref(false);
/** While the tunnel starts: the domain being shared (its share in the state carries the steps), and the outcome. */
const pending = ref<{ domain: string; failed: boolean; cancelled: boolean } | null>(null);
const pendingShare = computed(() => (pending.value ? ([...(expose.value?.shares ?? [])].reverse().find((x) => x.domain === pending.value!.domain && x.task) ?? null) : null));
async function start() {
  busy.value = true;
  pending.value = { domain: form.value.domain || site.value?.domain || '', failed: false, cancelled: false };
  const share = await attempt(() =>
    herd.exposeStart({
      siteId: form.value.siteId,
      domain: form.value.domain || undefined,
      provider: form.value.provider,
      hostname: form.value.hostname || undefined,
      subdomain: form.value.subdomain || undefined,
      auth: form.value.user ? `${form.value.user}:${form.value.password}` : '',
      expiryMinutes: Number(form.value.expiry) || 0,
    }).catch((e: Error) => (/cancelled/i.test(e.message) ? null : Promise.reject(e))),
  );
  busy.value = false;
  if (share) {
    // Let the finished stepper show for a moment.
    await new Promise((r) => setTimeout(r, 700));
    emit('started', share);
  } else if (pending.value) pending.value.failed = true;
}
async function cancelStart() {
  const s = pendingShare.value;
  if (pending.value) pending.value.cancelled = true;
  if (s) await attempt(() => herd.exposeStop(s.id).then(() => true));
}
function openExpose(where: 'expose' | 'settings') {
  navRequest.value = where === 'expose' ? { section: 'expose' } : { section: 'settings', id: 'expose' };
  emit('close');
}
</script>

<template>
  <dialog open class="modal modal-open" @keydown.esc="!busy && emit('close')">
    <form class="modal-box w-[30rem] max-w-[95vw] space-y-4" @submit.prevent="start">
      <div>
        <h3 class="text-lg font-semibold tracking-tight">Share {{ site?.name ?? 'a site' }} on a public URL</h3>
        <p class="text-xs opacity-60">A tunnel from the provider to this Mac, through DevCatz's proxy. Stop it when you are done.</p>
      </div>
      <template v-if="pending">
        <TaskStepper v-if="pendingShare?.task" :task="pendingShare.task" :cancellable="busy" @cancel="cancelStart" />
        <div v-else-if="busy" class="flex items-center gap-2 py-6 text-sm opacity-70"><span class="loading loading-spinner loading-xs" />Starting…</div>
        <p v-if="pending.cancelled && !busy" class="text-sm opacity-70">Sharing cancelled; nothing is left running.</p>
        <p v-else-if="pending.failed && !pendingShare?.task" class="text-sm text-error">The tunnel did not start. Check the provider settings and try again.</p>
        <div class="modal-action">
          <button v-if="!busy" type="button" class="btn btn-ghost btn-sm" @click="pending = null">Back</button>
          <button v-if="!busy" type="button" class="btn btn-sm" @click="emit('close')">Close</button>
        </div>
      </template>
      <template v-else>
      <div>
        <span class="label-caps mb-1.5 block">Provider</span>
        <div class="grid grid-cols-2 gap-2">
          <button v-for="p in PROVIDERS" :key="p.id" type="button" class="flex items-center gap-2.5 rounded-box border px-3 py-2 text-left" :class="form.provider === p.id ? 'border-primary bg-primary/5' : 'border-base-300/60 hover:bg-base-200/60'" @click="form.provider = p.id">
            <img :src="PROVIDER_LOGO[p.id]" alt="" class="size-7 shrink-0 rounded-lg bg-white p-0.5 ring-1 ring-base-content/10" draggable="false" />
            <span class="min-w-0">
              <span class="block text-sm font-medium">{{ p.name }}</span>
              <span class="block text-[11px] opacity-60">{{ p.hint }}</span>
            </span>
          </button>
        </div>
      </div>
      <div v-if="blocker" class="alert alert-warning alert-soft text-sm"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
        <span class="flex-1">{{ blocker.text }}</span>
        <button type="button" class="btn btn-sm" @click="openExpose(blocker.where)">{{ blocker.where === 'expose' ? 'Expose page' : 'Settings → Expose' }}</button>
      </div>
      <label v-if="form.provider === 'cloudflare-domain'" class="block">
        <span class="label-caps mb-1.5 block">Public hostname on your zone</span>
        <input v-model="form.hostname" class="input input-sm w-full font-mono" placeholder="demo.example.com" spellcheck="false" />
        <span class="mt-1 block text-xs opacity-60">A DNS record for it is created (or overwritten) on the zone you logged in with.</span>
      </label>
      <label v-if="form.provider === 'ngrok'" class="block">
        <span class="label-caps mb-1.5 block">Reserved domain (optional)</span>
        <input v-model="form.subdomain" class="input input-sm w-full font-mono" :placeholder="expose?.accounts.ngrok.domain || 'random ….ngrok-free.app'" spellcheck="false" />
      </label>
      <label v-if="form.provider === 'expose'" class="block">
        <span class="label-caps mb-1.5 block">Subdomain or custom domain (optional)</span>
        <input v-model="form.subdomain" class="input input-sm w-full font-mono" :placeholder="expose?.accounts.expose.domain || 'random'" spellcheck="false" />
      </label>
      <label v-if="!siteId" class="block">
        <span class="label-caps mb-1.5 block">Site</span>
        <select v-model="form.siteId" class="select select-sm w-full" @change="form.domain = ''">
          <option v-for="p in sites" :key="p.id" :value="p.id">{{ p.name }} · {{ p.domain }}</option>
        </select>
      </label>
      <label v-if="domains.length > 1" class="block">
        <span class="label-caps mb-1.5 block">Domain to share</span>
        <select v-model="form.domain" class="select select-sm w-full font-mono">
          <option value="">{{ domains[0] }}</option>
          <option v-for="d in domains.slice(1)" :key="d" :value="d">{{ d }}</option>
        </select>
      </label>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="block">
          <span class="label-caps mb-1.5 block">Basic auth (optional)</span>
          <input v-model="form.user" class="input input-sm w-full" placeholder="user" autocomplete="off" spellcheck="false" />
        </label>
        <label class="block">
          <span class="label-caps mb-1.5 block">Password</span>
          <input v-model="form.password" type="password" class="input input-sm w-full" placeholder="password" autocomplete="new-password" :disabled="!form.user" />
        </label>
      </div>
      <label class="block">
        <span class="label-caps mb-1.5 block">Stops by itself after</span>
        <select v-model.number="form.expiry" class="select select-sm w-full">
          <option :value="0">Never (until you stop it)</option>
          <option :value="30">30 minutes</option>
          <option :value="60">1 hour</option>
          <option :value="240">4 hours</option>
          <option :value="1440">24 hours</option>
        </select>
      </label>
      <p class="text-xs opacity-60">
        Requests arrive with the site's own Host header ({{ form.domain || domains[0] }}), so routing and cookies work. Laravel: set <code>APP_URL</code> to the public
        URL (or trust proxies) for absolute links; Vite HMR works through the tunnel too.
      </p>
      <div class="modal-action">
        <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="busy || !form.siteId || !!blocker || needHost || (!!form.user && !form.password)">Share</button>
      </div>
      </template>
    </form>
    <div class="modal-backdrop" @click="!busy && emit('close')" />
  </dialog>
</template>
