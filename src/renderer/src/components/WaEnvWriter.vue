<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { WaEngine } from '@shared/types';
import { attempt, herd, notify, state } from '../store';

/**
 * .env lines that point a site at a WhatsApp engine (WHATSAPP_API_URL / KEY /
 * SESSION, the site's webhook secret): copied, or written into the site's
 * .env after a preview. With `siteId` the site is fixed; with `engine` the engine is.
 */
const props = defineProps<{ siteId?: string; engine?: WaEngine }>();

const sites = computed(() => state.value?.projects ?? []);
const engines = computed(() => (state.value?.whatsapp ?? []).filter((w) => w.installed));
const targetSite = ref(props.siteId ?? '');
const targetEngine = ref<WaEngine | ''>(props.engine ?? engines.value[0]?.engine ?? '');
watch(engines, (list) => !targetEngine.value && list[0] && (targetEngine.value = list[0].engine));
const site = computed(() => sites.value.find((p) => p.id === targetSite.value) ?? null);
const entries = ref<Record<string, string>>({});
const error = ref('');

async function load() {
  error.value = '';
  entries.value = {};
  if (!targetSite.value || !targetEngine.value) return;
  try {
    entries.value = await herd.waEnv(targetEngine.value, targetSite.value);
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}
watch(() => [targetSite.value, targetEngine.value, JSON.stringify(state.value?.whatsapp.map((w) => w.config))], load, { immediate: true });

const text = computed(() =>
  Object.entries(entries.value)
    .map(([k, v]) => `${k}=${v}`)
    .join('\n'),
);
type Plan = { added: string[]; changed: { key: string; from: string; to: string }[]; unchanged: string[] };
const plan = ref<Plan | null>(null);
watch([text, targetSite], () => (plan.value = null));
const COMMENT = 'WhatsApp (DevCatz gateway)';

async function preview() {
  if (!targetSite.value) return;
  plan.value = (await attempt(() => herd.envMerge(targetSite.value, '.env', { ...entries.value }, COMMENT, false))) ?? null;
}
async function write() {
  if (!targetSite.value) return;
  const r = await attempt(() => herd.envMerge(targetSite.value, '.env', { ...entries.value }, COMMENT, true));
  if (!r) return;
  const live = site.value?.status === 'running' || site.value?.served;
  notify('success', `${site.value?.name ?? 'Site'}: .env updated (${r.added.length} added, ${r.changed.length} changed)${live ? '. Restart the site to apply it.' : ''}`);
  plan.value = null;
}
async function copy() {
  await navigator.clipboard.writeText(text.value + '\n');
  notify('info', 'Copied. Paste it into the site’s .env (Env tab).');
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <select v-if="!siteId" v-model="targetSite" class="select select-xs w-56">
        <option value="" disabled>Choose a site…</option>
        <option v-for="p in sites" :key="p.id" :value="p.id">{{ p.name }} · {{ p.domain }}</option>
      </select>
      <select v-if="!engine" v-model="targetEngine" class="select select-xs w-36">
        <option value="" disabled>Engine…</option>
        <option v-for="w in engines" :key="w.engine" :value="w.engine">{{ w.name }}</option>
      </select>
      <span class="flex-1" />
      <button class="btn btn-ghost btn-xs" :disabled="!text" @click="copy">Copy</button>
      <button class="btn btn-xs" :disabled="!text" @click="preview">Preview changes</button>
      <button class="btn btn-primary btn-xs" :disabled="!plan || (!plan.added.length && !plan.changed.length)" title="Preview first" @click="write">Write to .env</button>
    </div>
    <div v-if="error" class="text-xs text-error">{{ error }}</div>
    <pre v-else-if="text" class="selectable overflow-x-auto rounded-box bg-base-200/70 p-3 font-mono text-xs leading-6">{{ text }}</pre>
    <p v-else-if="!engines.length" class="text-xs opacity-60">Install GOWA or WAHA on the Gateways page first.</p>
    <p v-else-if="!targetSite" class="text-xs opacity-60">Choose the site that will talk to the gateway.</p>
    <div v-if="plan" class="rounded-box border border-base-300/60 p-2 font-mono text-xs leading-6">
      <div v-for="k in plan.added" :key="'a' + k" class="text-success">+ {{ k }}={{ entries[k] || '""' }}</div>
      <div v-for="c in plan.changed" :key="'c' + c.key">
        <span class="text-error">- {{ c.key }}={{ c.from || '""' }}</span><br />
        <span class="text-success">+ {{ c.key }}={{ c.to || '""' }}</span>
      </div>
      <div v-if="plan.unchanged.length" class="opacity-50">= {{ plan.unchanged.join(', ') }} (already set)</div>
      <div v-if="!plan.added.length && !plan.changed.length" class="font-sans opacity-70">Nothing to change: the .env already has these values.</div>
    </div>
    <p class="text-xs opacity-60">
      <code>WHATSAPP_WEBHOOK_SECRET</code> is the secret of this site's webhook (empty until one is added on the Gateways page). Existing keys are replaced where they
      are; new ones go under <code># {{ COMMENT }}</code>. Nothing is written before you click Write.
    </p>
  </div>
</template>
