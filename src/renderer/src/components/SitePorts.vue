<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue';
import type { ProjectState } from '@shared/types';
import { attempt, herd, notify } from '../store';
import { portWhy } from '../runtimes';

/**
 * Site Settings → Apps: each app DevCatz assigns a port to can get one of your choice. While you type, DevCatz
 * checks it (another site's app, a program listening) and warns; a port in use is not saved. In a monorepo / folder
 * site every app also has its subdomain (empty = the site's own domain); the default stays until one is picked.
 */
const props = defineProps<{ site: ProjectState }>();

interface Row {
  value: string;
  checking: boolean;
  /** null = free, a string = who uses it. */
  use: string | null;
  saving: boolean;
}
const rows = reactive<Record<string, Row>>({});
const timers: Record<string, ReturnType<typeof setTimeout>> = {};

watch(
  () => props.site.stack.apps.map((a) => `${a.dir}=${a.port}`).join(','),
  () => {
    for (const a of props.site.stack.apps) {
      const r = rows[a.dir];
      if (!r || !r.saving) rows[a.dir] = { value: String(a.port ?? ''), checking: false, use: null, saving: false };
    }
  },
  { immediate: true },
);

// v-model on a number input hands back a number: compare as text.
const changed = (dir: string, port: number | null) => !!rows[dir] && String(rows[dir].value).trim() !== String(port ?? '');
function check(dir: string, port: number | null) {
  const r = rows[dir];
  clearTimeout(timers[dir]);
  r.use = null;
  if (!changed(dir, port)) {
    r.checking = false;
    return;
  }
  r.checking = true;
  timers[dir] = setTimeout(async () => {
    const asked = String(r.value);
    const use = await herd.sitePortUse(props.site.id, dir, Number(asked)).catch((e: Error) => e.message);
    if (String(r.value) !== asked) return;
    r.use = use;
    r.checking = false;
  }, 300);
}
// ---- subdomains (sites with several apps on their own domains)
const multi = computed(() => props.site.stack.apps.filter((a) => a.domain).length > 1);
const subOf = (domain: string) => (domain === props.site.domain ? '' : domain.endsWith(`.${props.site.domain}`) ? domain.slice(0, -props.site.domain.length - 1) : domain);
const subs = reactive<Record<string, { value: string; saving: boolean }>>({});
watch(
  () => props.site.stack.apps.map((a) => `${a.dir}=${a.domain}`).join(','),
  () => {
    for (const a of props.site.stack.apps) if (!subs[a.dir]?.saving) subs[a.dir] = { value: subOf(a.domain), saving: false };
  },
  { immediate: true },
);
// Who already uses the subdomain being typed (another site, an app, a DevCatz service).
const subTaken = reactive<Record<string, string | null>>({});
const subTimers: Record<string, ReturnType<typeof setTimeout>> = {};
function checkSub(dir: string) {
  clearTimeout(subTimers[dir]);
  subTaken[dir] = null;
  const v = subs[dir].value.trim().toLowerCase();
  const d = v ? `${v}.${props.site.domain}` : props.site.domain;
  subTimers[dir] = setTimeout(async () => {
    const owner = await herd.domainOwner(d, props.site.id).catch(() => null);
    if (subs[dir].value.trim().toLowerCase() === v) subTaken[dir] = owner ? `${d} is already used by ${owner}` : null;
  }, 250);
}
const subChanged = (dir: string, domain: string) => !!subs[dir] && subs[dir].value.trim().toLowerCase() !== subOf(domain);
const custom = (dir: string) => props.site.appSubdomains?.[dir] !== undefined;
async function saveSub(dir: string, value: string | null) {
  const r = subs[dir];
  r.saving = true;
  await attempt(() => herd.setAppSubdomain(props.site.id, dir, value === null ? null : value.trim().toLowerCase()).then(() => true), value === null ? 'Back to the default address' : 'Address saved');
  r.saving = false;
}

// ---- the .env holding the app's port variable (API_PORT=8080): write the new port there too
const envOf = reactive<Record<string, { files: string[]; keys: string[]; locked: boolean } | null>>({});
const writeEnv = reactive<Record<string, boolean>>({});
watch(
  () => `${props.site.id}|${props.site.envLocked}|${props.site.stack.apps.map((a) => a.dir + a.portVars.join()).join(',')}`,
  async () => {
    for (const a of props.site.stack.apps) {
      if (!a.managedPort) continue;
      const r = await herd.appPortEnv(props.site.id, a.dir).catch(() => null);
      envOf[a.dir] = r;
      if (writeEnv[a.dir] === undefined || r?.locked) writeEnv[a.dir] = !!r && !r.locked;
    }
  },
  { immediate: true },
);

/** Generate: the next port no other site uses and nothing listens on. */
const generating = ref<string | null>(null);
async function generate(dir: string, port: number | null) {
  generating.value = dir;
  const free = await attempt(() => herd.freePortFor(props.site.id, dir));
  generating.value = null;
  if (!free) return;
  rows[dir].value = String(free);
  check(dir, port);
}

async function save(dir: string) {
  const r = rows[dir];
  r.saving = true;
  const changed = await attempt(() => herd.setSitePort(props.site.id, dir, Number(r.value), !!writeEnv[dir]));
  r.saving = false;
  if (!changed) return check(dir, null);
  const env = changed.length ? `; .env: ${changed.join(', ')}` : '';
  notify('success', `Port ${r.value} saved${env}${props.site.status === 'running' ? ' — restart the site to use it' : ''}`);
}
</script>

<template>
  <div class="space-y-2">
    <span class="label-caps block">{{ multi ? 'Apps: address and port' : 'Ports' }}</span>
    <div v-for="a in site.stack.apps" :key="a.dir" class="site-port">
      <div class="min-w-0 flex-1">
        <div class="truncate text-sm font-medium">{{ a.name }}</div>
        <div class="truncate text-xs opacity-55">
          <template v-if="a.managedPort">Assigned by DevCatz via {{ a.portFlag ? '--port' : a.portVars.join(', ') }}</template>
          <template v-else-if="portWhy(site, a)">{{ portWhy(site, a)!.title }}</template>
        </div>
      </div>
      <template v-if="a.managedPort && rows[a.dir]">
        <div class="flex flex-col items-end gap-1">
          <div class="flex items-center gap-2">
            <input
              v-model="rows[a.dir].value"
              type="number"
              min="1024"
              max="65535"
              class="input input-sm w-24 font-mono"
              :class="{ 'input-warning': rows[a.dir].use }"
              @input="check(a.dir, a.port)"
              @keydown.enter="!rows[a.dir].use && !rows[a.dir].checking && changed(a.dir, a.port) && save(a.dir)"
            />
            <button class="btn btn-ghost btn-sm" :disabled="generating === a.dir" title="Pick a free port: no other site uses it and nothing listens on it" @click="generate(a.dir, a.port)">
              <span v-if="generating === a.dir" class="loading loading-spinner loading-xs" />Generate
            </button>
            <button class="btn btn-sm" :class="changed(a.dir, a.port) && !rows[a.dir].use ? 'btn-primary' : ''" :disabled="!changed(a.dir, a.port) || rows[a.dir].checking || !!rows[a.dir].use || rows[a.dir].saving" @click="save(a.dir)">
              <span v-if="rows[a.dir].saving" class="loading loading-spinner loading-xs" />Save
            </button>
          </div>
        </div>
      </template>
      <code v-else class="rounded bg-base-200 px-2 py-1 text-xs">{{ a.port ?? '—' }}</code>
      <!-- also write it to the .env that holds the port variable -->
      <label v-if="a.managedPort && envOf[a.dir]" class="site-port-note flex cursor-pointer items-center gap-2" :class="{ 'opacity-60': envOf[a.dir]!.locked }">
        <input v-model="writeEnv[a.dir]" type="checkbox" class="toggle toggle-xs toggle-primary" :disabled="envOf[a.dir]!.locked" />
        <span>
          Also write {{ envOf[a.dir]!.keys.join(', ') }} to {{ envOf[a.dir]!.files.join(', ') }} (and the localhost URLs on the old port)
          <span v-if="envOf[a.dir]!.locked" class="opacity-70"> — the .env is locked: unlock it in the Env tab. DevCatz still gives the app this port when it starts.</span>
        </span>
      </label>
      <!-- why this app keeps its own port, and what would let DevCatz assign one -->
      <div v-if="!a.managedPort && portWhy(site, a)" class="site-port-note opacity-75">
        <template v-if="a.portSource && a.portSource.file !== 'package.json'">
          The code sets it: <code class="rounded bg-base-200 px-1.5 py-0.5">{{ a.portSource.code }}</code>
          <span class="opacity-70">({{ a.portSource.file }}:{{ a.portSource.line }})</span>. DevCatz can only give a port to an app that reads it from the environment, e.g.
          <code class="rounded bg-base-200 px-1.5 py-0.5">Number(process.env.PORT) || {{ a.port ?? 3000 }}</code>; until then it keeps {{ a.port }}.
        </template>
        <template v-else>{{ portWhy(site, a)!.detail }}</template>
      </div>
      <div v-if="a.managedPort && rows[a.dir] && changed(a.dir, a.port)" class="site-port-note" :class="rows[a.dir].checking ? 'opacity-55' : rows[a.dir].use ? 'is-warn' : 'is-ok'">
        <template v-if="rows[a.dir].checking">Checking port {{ rows[a.dir].value }}…</template>
        <template v-else-if="rows[a.dir].use">⚠ {{ rows[a.dir].use }}. Pick another port.</template>
        <template v-else>✓ Port {{ rows[a.dir].value }} is free{{ site.status === 'running' ? '; the site picks it up on restart' : '' }}</template>
      </div>
      <!-- the app's subdomain -->
      <div v-if="multi && a.domain && subs[a.dir]" class="site-port-sub">
        <div class="join min-w-0 flex-1">
          <span class="join-item flex items-center border border-base-300 bg-base-200 px-2 font-mono text-xs opacity-70">https://</span>
          <input
            v-model="subs[a.dir].value"
            class="input input-sm join-item w-36 min-w-0 font-mono"
            placeholder="(site domain)"
            spellcheck="false"
            autocapitalize="off"
            :aria-label="`Subdomain of ${a.name}`"
            :class="{ 'input-warning': subTaken[a.dir] }"
            @input="checkSub(a.dir)"
            @keydown.enter="subChanged(a.dir, a.domain) && !subTaken[a.dir] && saveSub(a.dir, subs[a.dir].value)"
          />
          <span class="join-item flex max-w-[60%] shrink-0 items-center overflow-hidden border border-base-300 bg-base-200 px-2.5 font-mono text-xs text-ellipsis whitespace-nowrap opacity-70" :title="site.domain">{{ subs[a.dir].value.trim() ? '.' : '' }}{{ site.domain }}</span>
        </div>
        <button class="btn btn-sm" :class="subChanged(a.dir, a.domain) && !subTaken[a.dir] ? 'btn-primary' : ''" :disabled="!subChanged(a.dir, a.domain) || !!subTaken[a.dir] || subs[a.dir].saving" @click="saveSub(a.dir, subs[a.dir].value)">
          <span v-if="subs[a.dir].saving" class="loading loading-spinner loading-xs" />Save
        </button>
        <button v-if="custom(a.dir)" class="btn btn-ghost btn-sm" title="Back to the default address" @click="saveSub(a.dir, null)">Default</button>
      </div>
      <div v-if="subTaken[a.dir]" class="site-port-note is-warn">⚠ {{ subTaken[a.dir] }}. Pick another one.</div>
    </div>
  </div>
</template>
