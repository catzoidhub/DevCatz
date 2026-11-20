<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { DialcatzMockState } from '@shared/types';
import { attempt, herd, navRequest, notify, state } from '../store';
import dialcatzLogo from '../assets/logos/dialcatz.png';

/**
 * A DialCatz mock server (DialCatz #94) as DevCatz serves it: its domains, where they go, its own name, curl and .env
 * lines for a site. Started, stopped and given a port in DialCatz (Open in DialCatz); DevCatz only names and serves it.
 */
const props = defineProps<{ mock: DialcatzMockState }>();
const m = computed(() => props.mock);
const tld = computed(() => state.value?.settings.tld ?? 'test');

async function copy(v: string, what = 'Copied') {
  await navigator.clipboard.writeText(v).catch(() => undefined);
  notify('success', what);
}

async function openInDialcatz() {
  const ok = await attempt(() => herd.dialcatzOpenMock(m.value.key));
  if (ok === false) notify('warning', 'DialCatz is not installed on this computer any more');
}

/** The site it was made from (API tab → Create mock server), when that site is still here. */
const fromSite = computed(() => (m.value.siteId ? (state.value?.projects.find((p) => p.id === m.value.siteId) ?? null) : null));
const since = computed(() => (m.value.startedAt ? new Date(m.value.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : null));

// Its own domain name: <name>.dialcatz.<tld>, kept for this mock whenever it runs.
const name = ref(m.value.slug);
watch(() => m.value.slug, (s) => (name.value = s));
const nameOk = computed(() => /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/.test(name.value.trim()));
async function saveName() {
  if (await attempt(() => herd.mockSetDomain(m.value.key, name.value.trim()).then(() => true), 'Domain saved')) return;
  name.value = m.value.slug;
}
async function resetName() {
  await attempt(() => herd.mockSetDomain(m.value.key, null).then(() => true), `Back to ${m.value.defaultSlug}.dialcatz.${tld.value}`);
}

const curl = computed(() => `curl ${m.value.url}/`);

// .env lines for a site: one variable with the mock's URL, written after a preview.
const sites = computed(() => state.value?.projects ?? []);
const site = ref('');
const key = ref('API_BASE_URL');
const keyOk = computed(() => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key.value));
const KEYS = ['API_BASE_URL', 'API_URL', 'VITE_API_URL', 'NEXT_PUBLIC_API_URL', 'NUXT_PUBLIC_API_BASE'];
const line = computed(() => `${key.value}=${m.value.url}`);
type Plan = { added: string[]; changed: { key: string; from: string; to: string }[]; unchanged: string[] };
const plan = ref<Plan | null>(null);
watch([site, key, () => m.value.url], () => (plan.value = null));
const COMMENT = 'Mock server (DialCatz, served by DevCatz)';
async function preview() {
  if (!site.value || !keyOk.value) return;
  plan.value = (await attempt(() => herd.envMerge(site.value, '.env', { [key.value]: m.value.url }, COMMENT, false))) ?? null;
}
async function write() {
  const r = await attempt(() => herd.envMerge(site.value, '.env', { [key.value]: m.value.url }, COMMENT, true));
  if (!r) return;
  const p = sites.value.find((x) => x.id === site.value);
  notify('success', `${p?.name ?? 'Site'}: .env updated${p?.status === 'running' ? '. Restart the site to apply it.' : ''}`);
  plan.value = null;
}
</script>

<template>
  <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
    <div class="flex flex-wrap items-center gap-3">
      <img :src="dialcatzLogo" alt="" class="size-11 rounded-xl" draggable="false" />
      <div class="min-w-0 flex-1">
        <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
          {{ m.name }}
          <span class="status status-success status-md" />
          <span class="badge badge-soft badge-success badge-sm">running</span>
        </h2>
        <div class="text-xs opacity-60">
          Mock server from DialCatz · 127.0.0.1:{{ m.port }}<template v-if="since"> · since {{ since }}</template>
          <template v-if="fromSite">
            · from
            <button class="no-drag link link-hover" @click="navRequest = { section: 'projects', id: fromSite.id }">{{ fromSite.name }}</button><template v-if="m.specFile"> · <code>{{ m.specFile }}</code></template>
          </template>
        </div>
      </div>
      <div class="no-drag flex shrink-0 flex-wrap items-center gap-2">
        <button class="btn btn-primary btn-sm" @click="herd.openUrl(m.url)">Open</button>
        <button class="btn btn-sm" @click="openInDialcatz"><img :src="dialcatzLogo" alt="" class="size-4" draggable="false" />Open in DialCatz</button>
      </div>
    </div>
  </header>

  <div class="flex min-h-0 flex-1 flex-col space-y-4 overflow-y-auto p-6">
    <a class="url-chip w-full" :title="`127.0.0.1:${m.port} · click to copy`" @click="copy(m.url, 'URL copied')">
      <span class="badge badge-ghost badge-xs font-sans">HTTPS</span>
      <span class="truncate">{{ m.url.replace(/^https:\/\//, '') }}</span>
      <span class="ml-auto font-sans text-[10px] opacity-60">:{{ m.port }}</span>
    </a>

    <div class="card">
      <div class="card-body">
        <h2>Overview</h2>
        <div class="grid gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
          <div class="min-w-0">
            <span class="label-caps block">HTTPS</span>
            <div class="flex items-center gap-1"><code class="selectable truncate">{{ m.url }}</code><button class="btn btn-ghost btn-xs" @click="copy(m.url, 'URL copied')">Copy</button></div>
          </div>
          <div class="min-w-0">
            <span class="label-caps block">HTTP</span>
            <div class="flex items-center gap-1"><code class="selectable truncate">{{ m.httpUrl }}</code><button class="btn btn-ghost btn-xs" @click="copy(m.httpUrl, 'URL copied')">Copy</button></div>
          </div>
          <div class="min-w-0">
            <span class="label-caps block">Forwards to</span>
            <code class="selectable">127.0.0.1:{{ m.port }}</code>
          </div>
          <div class="min-w-0">
            <span class="label-caps block">Try it</span>
            <div class="flex items-center gap-1"><code class="selectable truncate">{{ curl }}</code><button class="btn btn-ghost btn-xs" @click="copy(curl, 'Command copied')">Copy</button></div>
          </div>
        </div>
        <p class="text-xs opacity-60">
          Both schemes answer, with no redirect: an API client calls the one it was given. The responses come from the collection's examples in DialCatz;
          stop the mock or change its port there (Open in DialCatz). This page goes away when the mock stops.
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <h2>Domain</h2>
        <div class="flex flex-wrap items-center gap-2">
          <div class="join flex w-96 max-w-full">
            <input v-model="name" class="input input-sm join-item min-w-0 flex-1 font-mono" :class="{ 'input-error': !nameOk }" placeholder="shop-api" spellcheck="false" autocapitalize="off" @keydown.enter="nameOk && name.trim() !== m.slug && saveName()" />
            <span class="join-item flex shrink-0 items-center border border-base-300 bg-base-200 px-2.5 font-mono text-xs whitespace-nowrap opacity-70">.dialcatz.{{ tld }}</span>
          </div>
          <button class="btn btn-sm" :disabled="!nameOk || name.trim() === m.slug" @click="saveName">Save</button>
          <button v-if="m.custom" class="btn btn-ghost btn-sm" @click="resetName">Use {{ m.defaultSlug }}</button>
        </div>
        <p class="text-xs" :class="nameOk ? 'opacity-60' : 'text-error'">
          <template v-if="!nameOk">Lowercase letters, digits and hyphens.</template>
          <template v-else>Kept for this mock: the next time it runs in DialCatz, it gets this name again. DialCatz's own name is {{ m.defaultSlug }}.</template>
        </p>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <h2>Write to .env</h2>
        <p class="text-xs opacity-60">Point a site's API calls at this mock while the real API is not there yet.</p>
        <div class="flex flex-wrap items-center gap-2">
          <select v-model="site" class="select select-xs w-56">
            <option value="" disabled>Choose a site…</option>
            <option v-for="p in sites" :key="p.id" :value="p.id">{{ p.name }} · {{ p.domain }}</option>
          </select>
          <input v-model="key" list="mock-env-keys" class="input input-xs w-48 font-mono" :class="{ 'input-error': !keyOk }" spellcheck="false" />
          <datalist id="mock-env-keys"><option v-for="k in KEYS" :key="k" :value="k" /></datalist>
          <span class="flex-1" />
          <button class="btn btn-ghost btn-xs" :disabled="!keyOk" @click="copy(line, 'Copied. Paste it into the site’s .env (Env tab).')">Copy</button>
          <button class="btn btn-xs" :disabled="!site || !keyOk" @click="preview">Preview changes</button>
          <button class="btn btn-primary btn-xs" :disabled="!plan || (!plan.added.length && !plan.changed.length)" title="Preview first" @click="write">Write to .env</button>
        </div>
        <pre class="selectable overflow-x-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-6">{{ line }}</pre>
        <div v-if="plan" class="rounded-box border border-base-300/60 p-2 font-mono text-xs leading-6">
          <div v-for="k in plan.added" :key="'a' + k" class="text-success">+ {{ k }}={{ m.url }}</div>
          <div v-for="c in plan.changed" :key="'c' + c.key">
            <span class="text-error">- {{ c.key }}={{ c.from || '""' }}</span><br />
            <span class="text-success">+ {{ c.key }}={{ c.to || '""' }}</span>
          </div>
          <div v-if="plan.unchanged.length" class="opacity-50">= {{ plan.unchanged.join(', ') }} (already set)</div>
          <div v-if="!plan.added.length && !plan.changed.length" class="font-sans opacity-70">Nothing to change: the .env already has this value.</div>
        </div>
        <p class="text-xs opacity-60">An existing key is replaced where it is; a new one goes under <code># {{ COMMENT }}</code>. Nothing is written before you click Write.</p>
      </div>
    </div>
  </div>
</template>
