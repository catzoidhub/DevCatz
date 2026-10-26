<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { ProjectState, WaDelivery, WaHook } from '@shared/types';
import StatusDot from './StatusDot.vue';
import WaEnvWriter from './WaEnvWriter.vue';
import { attempt, herd, navRequest, notify, state } from '../store';
import CatMood from './CatMood.vue';

/**
 * A site's WhatsApp tab: which DevCatz engine its .env points at (or the
 * client library found), the .env lines, its webhook with the last
 * deliveries (Replay), and the ban warning.
 */
const props = defineProps<{ project: ProjectState }>();
const p = computed(() => props.project);
const info = computed(() => p.value.waInfo);
const engines = computed(() => (state.value?.whatsapp ?? []).filter((w) => w.installed));
const engine = computed(() => engines.value.find((w) => w.engine === info.value?.engine) ?? null);
const H = herd;

const hooks = ref<WaHook[]>([]);
const deliveries = ref<WaDelivery[]>([]);
async function load() {
  hooks.value = ((await herd.waHooks().catch(() => [])) ?? []).filter((h) => h.siteId === p.value.id);
  deliveries.value = hooks.value[0] ? ((await herd.waDeliveries(hooks.value[0].id, 8).catch(() => [])) ?? []) : [];
}
watch(() => [p.value.id, JSON.stringify(state.value?.whatsapp.map((w) => w.status))], load, { immediate: true });
let timer: ReturnType<typeof setInterval> | null = setInterval(load, 5000);
onBeforeUnmount(() => timer && clearInterval(timer));

async function addHook() {
  const h = await attempt(() => herd.waSetHook({ siteId: p.value.id, url: `https://${p.value.domain}/webhooks/whatsapp`, events: [], enabled: true }));
  if (h) {
    notify('success', 'Webhook added: edit its URL on the Gateways page');
    await load();
  }
}
async function replay(d: WaDelivery) {
  const r = await attempt(() => herd.waReplay(d.id));
  if (r) {
    notify(r.status && r.status < 300 ? 'success' : 'error', `Replayed ${d.event} → ${r.status ?? r.error}`);
    await load();
  }
}
const openWa = (id?: string) => (navRequest.value = { section: 'whatsapp', id });
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const STATUS = (s: number | null) => (s === null ? 'text-error' : s < 300 ? 'text-success' : s < 500 ? 'text-warning' : 'text-error');
</script>

<template>
  <section class="site-tab">
    <div class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <StatusDot :status="engine ? engine.status : 'stopped'" />
          <h2 class="flex-1">WhatsApp gateway</h2>
          <span class="badge badge-soft badge-sm" :class="engine ? 'badge-success' : 'badge-ghost'">{{ engine ? `uses ${engine.name}` : info?.engine ? 'engine not installed' : 'not pointed at DevCatz' }}</span>
        </div>
        <p class="text-sm opacity-70">
          <template v-if="engine">
            This site's .env points at <strong>{{ engine.name }}</strong> ({{ engine.apiLocal }}), {{ engine.status }}<template v-if="engine.status === 'running'">
              · {{ engine.sessions.filter((s) => s.status === 'connected').length }} phone{{ engine.sessions.filter((s) => s.status === 'connected').length === 1 ? '' : 's' }} linked</template
            >.
          </template>
          <template v-else-if="info?.keys.length">WhatsApp settings found in .env (<code>{{ info.keys.join(', ') }}</code>) but they point elsewhere. Write the lines below to use a DevCatz engine.</template>
          <template v-else>A WhatsApp client library was found (<code>{{ info?.libraries.join(', ') }}</code>). A DevCatz engine gives it an HTTP API; write the lines below.</template>
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <button v-if="engine && engine.status !== 'running'" class="btn btn-sm" @click="H.waAction(engine.engine, 'start')">Start {{ engine.name }}</button>
          <button class="btn btn-ghost btn-sm" @click="openWa(engine?.engine)">Open Gateways</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <h2>Write to .env</h2>
        <WaEnvWriter :key="p.id" :site-id="p.id" />
      </div>
    </div>

    <div class="card">
      <div class="card-body card-table">
        <div class="card-head">
          <h2>Webhook to this site</h2>
          <span class="ml-auto text-xs opacity-60">{{ hooks.length ? hooks[0].url : 'none' }}</span>
          <button v-if="!hooks.length" class="btn btn-xs" :disabled="!engines.length" @click="addHook">Add webhook</button>
          <button v-else class="btn btn-ghost btn-xs" @click="openWa(p.id)">Edit on the Gateways page</button>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <tbody>
              <tr v-for="d in deliveries" :key="d.id">
                <td class="font-mono text-xs whitespace-nowrap opacity-70">{{ when(d.at) }}</td>
                <td class="font-mono text-xs">{{ d.engine }} · {{ d.event }}</td>
                <td class="font-mono text-xs" :class="STATUS(d.status)">{{ d.status ?? d.error }} · {{ d.ms }} ms</td>
                <td class="text-right"><button class="btn btn-ghost btn-xs" @click="replay(d)">Replay</button></td>
              </tr>
              <tr v-if="!deliveries.length">
                <td colspan="4" class="py-6 text-center text-xs opacity-60">{{ hooks.length ? 'No event delivered yet.' : 'Add a webhook so incoming messages reach the site (signed with X-DevCatz-Signature).' }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="alert alert-warning alert-soft text-xs"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
      GOWA and WAHA use the WhatsApp Web protocol, which WhatsApp does not sanction: numbers can be banned. Use a test number in development and the official Cloud API in production.
    </div>
  </section>
</template>
