<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { DbOpenTool, WebToolId } from '@shared/types';
import { attempt, herd, state } from '../store';
import { WEB_TOOL_LOGO, WEB_TOOL_TILE } from '../logos';
import DbCatzButton from './DbCatzButton.vue';
import WebToolDialog from './WebToolDialog.vue';
import dbcatzLogo from '../assets/logos/dbcatz.png';

/**
 * Open for a database service (TODO §48): DBCatz by default, or the web tool picked last for this service (phpMyAdmin,
 * Adminer, pgweb). The main part opens with that one; the ▾ beside it lists the others for the service's engine, with
 * Install & open for the ones not installed. The pick is remembered per service, so the menu is needed only to change.
 */
const props = withDefaults(defineProps<{ serviceId: string; database?: string; size?: 'sm' | 'md' }>(), { database: undefined, size: 'sm' });

const svc = computed(() => state.value?.databases.find((d) => d.id === props.serviceId) ?? null);
const tools = computed(() => (state.value?.webTools ?? []).filter((t) => svc.value && t.engines.includes(svc.value.engine)));
const choice = computed<DbOpenTool>(() => {
  const c = state.value?.settings.dbOpenWith?.[props.serviceId];
  return c && c !== 'dbcatz' && tools.value.some((t) => t.id === c && t.installed) ? c : 'dbcatz';
});
const current = computed(() => (choice.value === 'dbcatz' ? null : (tools.value.find((t) => t.id === choice.value) ?? null)));

const dbcatz = ref<InstanceType<typeof DbCatzButton> | null>(null);
const installing = ref<WebToolId | null>(null);
const open = ref(false);
const root = ref<HTMLElement | null>(null);
// Closes on a click elsewhere or Esc.
const away = (e: Event) => {
  if (e instanceof KeyboardEvent ? e.key === 'Escape' : !root.value?.contains(e.target as Node)) open.value = false;
};
watch(open, (o) => {
  if (o) {
    document.addEventListener('mousedown', away, true);
    document.addEventListener('keydown', away, true);
  } else {
    document.removeEventListener('mousedown', away, true);
    document.removeEventListener('keydown', away, true);
  }
});
onBeforeUnmount(() => (open.value = false));

async function openWeb(id: WebToolId) {
  await attempt(() => herd.webToolOpen(id, props.serviceId, props.database));
}
async function pick(id: DbOpenTool) {
  open.value = false;
  const t = tools.value.find((x) => x.id === id);
  if (t && !t.installed) {
    installing.value = t.id;
    return;
  }
  if (id !== choice.value) await attempt(() => herd.dbSetOpenWith(props.serviceId, id));
  if (id === 'dbcatz') await dbcatz.value?.open();
  else await openWeb(id);
}
const hint = computed(() => (current.value ? `Open ${svc.value?.name ?? 'this service'}${props.database ? ` (${props.database})` : ''} in ${current.value.name} at ${current.value.host}` : undefined));
</script>

<template>
  <div ref="root" class="relative inline-flex">
    <DbCatzButton v-if="!current" ref="dbcatz" :join-item="tools.length > 0" :conn-id="`svc:${serviceId}`" :database="database" :size="size" />
    <template v-else>
      <!-- Kept for the menu's DBCatz entry. -->
      <DbCatzButton ref="dbcatz" hide :conn-id="`svc:${serviceId}`" :database="database" />
      <button type="button" class="btn gap-2 rounded-r-none" :class="size === 'sm' ? 'btn-sm' : ''" :title="hint" @click="openWeb(current.id)">
        <img :src="WEB_TOOL_LOGO[current.id]" alt="" class="size-5 object-contain drop-shadow-sm" :class="WEB_TOOL_TILE[current.id]" draggable="false" />Open in {{ current.name }}
      </button>
    </template>
    <button
      v-if="tools.length"
      type="button"
      class="btn rounded-l-none border-l border-l-base-content/10 px-1.5"
      :class="[size === 'sm' ? 'btn-sm' : '', open ? 'btn-active' : '']"
      title="Open with…"
      aria-label="Open with"
      :aria-expanded="open"
      @click="open = !open"
    >
      <svg viewBox="0 0 20 20" class="size-3.5 opacity-70" fill="currentColor"><path d="M5.2 7.6a.75.75 0 0 1 1.06-.02L10 11.2l3.74-3.62a.75.75 0 1 1 1.04 1.08l-4.26 4.12a.75.75 0 0 1-1.04 0L5.22 8.66a.75.75 0 0 1-.02-1.06Z" /></svg>
    </button>
    <ul v-if="open" class="menu absolute top-full right-0 z-30 mt-1 w-80 rounded-box border border-base-300/60 bg-base-100 p-1.5 shadow-lg">
      <li class="menu-title px-2 py-1 text-xs">Open with</li>
      <li>
        <a class="flex items-center gap-2.5" @click="pick('dbcatz')">
          <img :src="dbcatzLogo" alt="" class="size-6 shrink-0 drop-shadow-sm" draggable="false" />
          <span class="flex-1">DBCatz <span class="badge badge-soft badge-primary badge-xs ml-1">recommended</span></span>
          <span v-if="choice === 'dbcatz'" class="text-primary" aria-label="Open uses this">✓</span>
        </a>
      </li>
      <li v-for="t in tools" :key="t.id">
        <a class="flex items-center gap-2.5" :class="{ 'opacity-60': !!t.task && !t.task.done && !t.task.error }" @click="pick(t.id)">
          <img :src="WEB_TOOL_LOGO[t.id]" alt="" class="size-6 shrink-0 object-contain drop-shadow-sm" :class="WEB_TOOL_TILE[t.id]" draggable="false" />
          <span class="min-w-0 flex-1">
            {{ t.name }}
            <span class="block truncate font-mono text-[11px] opacity-60">{{ t.installed ? t.host : t.found ? `Use your own${t.found.label ? ` (${t.found.label})` : ''} & open…` : 'Install & open…' }}</span>
          </span>
          <span v-if="t.update" class="badge badge-info badge-xs">update</span>
          <span v-if="choice === t.id" class="text-primary" aria-label="Open uses this">✓</span>
        </a>
      </li>
    </ul>
  </div>
  <WebToolDialog v-if="installing" :tool="installing" mode="install" :service-id="serviceId" :database="database" @close="installing = null" />
</template>
