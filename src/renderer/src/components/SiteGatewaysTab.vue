<script setup lang="ts">
import { computed, ref } from 'vue';
import type { GwKind, ProjectState } from '@shared/types';
import StatusDot from './StatusDot.vue';
import SiteWhatsAppTab from './SiteWhatsAppTab.vue';
import GwEnvWriter from './GwEnvWriter.vue';
import { GW_CATEGORY_LABEL, GW_LOGO } from '../gateways';
import { attempt, herd, navRequest, state } from '../store';

/**
 * A site's Gateways tab: its WhatsApp part (when it uses one) and a card per
 * email / push / SMS gateway its .env points at, with status and the .env
 * lines; another installed gateway can be added from the bottom card.
 */
const props = defineProps<{ project: ProjectState }>();
const p = computed(() => props.project);
const gateways = computed(() => (state.value?.gateways ?? []).filter((g) => g.installed));
const used = computed(() => gateways.value.filter((g) => p.value.gwInfo?.kinds.includes(g.kind)));
const others = computed(() => gateways.value.filter((g) => !p.value.gwInfo?.kinds.includes(g.kind)));
const addKind = ref<GwKind | ''>('');
const open = (kind: GwKind) => (navRequest.value = { section: 'whatsapp', id: kind });
const H = herd;
</script>

<template>
  <section class="site-tab">
    <!-- The WhatsApp cards flow into this tab (display: contents drops the inner section box). -->
    <SiteWhatsAppTab v-if="p.waInfo" :project="p" class="!contents" />

    <div v-for="g in used" :key="g.kind" class="card">
      <div class="card-body">
        <div class="flex items-center gap-3">
          <img :src="GW_LOGO[g.kind]" alt="" class="size-9 shrink-0 rounded-xl bg-white p-1 ring-1 ring-base-content/10" draggable="false" />
          <div class="min-w-0 flex-1">
            <h2 class="flex items-center gap-2">{{ g.name }} <StatusDot :status="g.status" /></h2>
            <div class="text-xs opacity-60">{{ GW_CATEGORY_LABEL[g.category] }} · {{ g.status }}<template v-if="p.gwInfo?.keys.length"> · .env: {{ p.gwInfo.keys.filter((k) => k.toLowerCase().includes(g.kind) || (g.kind === 'jasmin' && k.startsWith('SMS_'))).join(', ') || 'mail settings' }}</template></div>
          </div>
          <button v-if="g.status !== 'running'" class="btn btn-sm" @click="attempt(() => H.gwAction(g.kind, 'start').then(() => true))">Start {{ g.name }}</button>
          <button class="btn btn-ghost btn-sm" @click="open(g.kind)">Open</button>
        </div>
        <GwEnvWriter :key="p.id + g.kind" :site-id="p.id" :kind="g.kind" />
      </div>
    </div>

    <div v-if="!p.waInfo && !used.length" class="card">
      <div class="card-body text-sm opacity-70">This site does not point at a DevCatz gateway yet. Add one below, or install one on the Gateways page.</div>
    </div>

    <div v-if="others.length" class="card">
      <div class="card-body">
        <h2>Use another gateway</h2>
        <div class="flex flex-wrap gap-2">
          <button v-for="g in others" :key="g.kind" class="btn btn-sm" :class="{ 'btn-active': addKind === g.kind }" @click="addKind = addKind === g.kind ? '' : g.kind">
            <img :src="GW_LOGO[g.kind]" alt="" class="size-4 rounded bg-white" draggable="false" />{{ g.name }}
          </button>
        </div>
        <GwEnvWriter v-if="addKind" :key="p.id + addKind" :site-id="p.id" :kind="addKind" />
      </div>
    </div>
  </section>
</template>
