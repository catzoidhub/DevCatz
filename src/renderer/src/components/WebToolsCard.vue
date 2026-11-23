<script setup lang="ts">
import { computed, ref } from 'vue';
import type { DbServiceState, WebToolId } from '@shared/types';
import { attempt, herd, state } from '../store';
import { WEB_TOOL_LOGO, WEB_TOOL_TILE } from '../logos';
import TaskStepper from './TaskStepper.vue';
import WebToolDialog from './WebToolDialog.vue';
import WebToolAutoStop from './WebToolAutoStop.vue';

/**
 * Web tools for this service's engine (TODO §48): phpMyAdmin / Adminer / pgweb / Redis Commander with their address,
 * version, Open, Start / Stop, Update, Settings (name, port, PHP / Node.js) and Uninstall. The service header keeps only Open (DbOpenButton).
 */
const props = defineProps<{ service: DbServiceState }>();
const tools = computed(() => (state.value?.webTools ?? []).filter((t) => t.engines.includes(props.service.engine)));
const dialog = ref<{ tool: WebToolId; mode: 'install' | 'settings' } | null>(null);
const confirming = ref<WebToolId | null>(null);
const choice = computed(() => state.value?.settings.dbOpenWith?.[props.service.id] ?? 'dbcatz');

/** pgweb runs per service: this service's own address once it ran; the tool's address otherwise. */
const addressOf = (id: WebToolId) => {
  const t = tools.value.find((x) => x.id === id)!;
  return t.running.find((r) => r.serviceId === props.service.id)?.url ?? (id === 'pgweb' ? null : t.url);
};
const runningHere = (id: WebToolId) => tools.value.find((x) => x.id === id)!.running.some((r) => r.serviceId === null || r.serviceId === props.service.id);

async function open(id: WebToolId) {
  await attempt(() => herd.webToolOpen(id, props.service.id));
}
async function useForOpen(id: WebToolId) {
  await attempt(() => herd.dbSetOpenWith(props.service.id, choice.value === id ? 'dbcatz' : id));
}
async function toggle(id: WebToolId) {
  const sid = id === 'pgweb' ? props.service.id : undefined;
  await attempt(() => (runningHere(id) ? herd.webToolStop(id, sid) : herd.webToolStart(id, sid)));
}
/** pgweb needs its service running; the others serve stopped services too (and say they cannot connect). */
const canStart = (id: WebToolId) => id !== 'pgweb' || props.service.status === 'running';
async function update(id: WebToolId, name: string) {
  await attempt(() => herd.webToolUpdate(id), `${name} updated`);
}
async function uninstall(id: WebToolId) {
  confirming.value = null;
  await attempt(() => herd.webToolUninstall(id), 'Uninstalled');
}
</script>

<template>
  <div v-if="tools.length" class="card">
    <div class="card-body">
      <h2>Web tools</h2>
      <p class="text-xs opacity-60">
        Browser tools for this {{ service.engineName }} service, each at its own address; they sign in by themselves. DBCatz stays the recommended app.
        The ▾ next to Open picks which one Open uses.
      </p>
      <div class="divide-y divide-base-300/60">
        <div v-for="t in tools" :key="t.id" class="space-y-2 py-3 first:pt-1 last:pb-0">
          <div class="flex flex-wrap items-center gap-3">
            <img :src="WEB_TOOL_LOGO[t.id]" alt="" class="size-8 shrink-0 object-contain drop-shadow-sm" :class="WEB_TOOL_TILE[t.id]" draggable="false" />
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-2 font-medium">
                {{ t.name }}
                <span v-if="t.installed" class="font-mono text-xs font-normal opacity-60">{{ t.version }}</span>
                <span v-if="t.external" class="badge badge-ghost badge-xs" :title="t.external.path">your own{{ t.external.label ? ` · ${t.external.label}` : '' }}</span>
                <span v-if="t.installed && runningHere(t.id)" class="status status-success status-sm" title="Running" />
                <span v-if="choice === t.id" class="badge badge-soft badge-primary badge-xs">Open uses this</span>
                <span v-if="t.update" class="badge badge-info badge-xs">{{ t.update }} available</span>
              </div>
              <div class="text-xs opacity-60">
                <template v-if="t.installed">
                  <a v-if="addressOf(t.id)" class="link link-hover font-mono" @click="open(t.id)">{{ addressOf(t.id)!.replace(/^https:\/\//, '') }}</a>
                  <span v-else class="font-mono">&lt;service&gt;.{{ t.host }}</span>
                  · :{{ t.running.find((r) => r.serviceId === service.id)?.port ?? t.port }}<template v-if="t.runtime && t.runtimeVersion"> · {{ t.runtime === 'php' ? 'PHP' : 'Node.js' }} {{ t.runtimeVersion }}</template>
                </template>
                <template v-else-if="t.found">Found on this computer{{ t.found.label ? ` (${t.found.label})` : '' }}{{ t.found.version ? ` · ${t.found.version}` : '' }}</template>
                <template v-else>{{ t.description }}</template>
              </div>
            </div>
            <div class="flex shrink-0 flex-wrap items-center gap-1.5">
              <template v-if="t.installed">
                <button class="btn btn-sm" @click="open(t.id)">Open</button>
                <button class="btn btn-ghost btn-sm" :disabled="!runningHere(t.id) && !canStart(t.id)" :title="!canStart(t.id) ? `Start ${service.name} first` : undefined" @click="toggle(t.id)">{{ runningHere(t.id) ? 'Stop' : 'Start' }}</button>
                <button v-if="t.update" class="btn btn-sm" :disabled="!!t.task && !t.task.done && !t.task.error" @click="update(t.id, t.name)">Update</button>
                <div class="dropdown dropdown-end">
                  <button tabindex="0" class="btn btn-ghost btn-sm btn-square" title="More" aria-label="More">⋯</button>
                  <ul tabindex="0" class="dropdown-content menu z-30 mt-1 w-56 rounded-box border border-base-300/60 bg-base-100 p-1.5 shadow-lg">
                    <li><a @click="useForOpen(t.id)">{{ choice === t.id ? 'Open with DBCatz again' : 'Use for Open' }}</a></li>
                    <li><a @click="dialog = { tool: t.id, mode: 'settings' }">Address, port{{ t.runtime ? (t.runtime === 'php' ? ', PHP' : ', Node.js') : '' }}…</a></li>
                    <li><a class="text-error" @click="confirming = t.id">{{ t.external ? 'Stop using…' : 'Uninstall…' }}</a></li>
                  </ul>
                </div>
              </template>
              <button v-else class="btn btn-sm" :disabled="!!t.task && !t.task.done && !t.task.error" @click="dialog = { tool: t.id, mode: 'install' }">{{ t.found ? 'Add…' : 'Install…' }}</button>
            </div>
          </div>
          <WebToolAutoStop v-if="t.installed && t.autoStop !== null" :tool="t" />
          <TaskStepper v-if="t.task && !dialog" :task="t.task" compact cancellable dismissable @cancel="herd.webToolCancel(t.id)" @dismiss="herd.webToolCancel(t.id)" />
          <div v-if="confirming === t.id" role="alert" class="alert alert-warning alert-soft flex flex-wrap items-center gap-2 text-sm">
            <span v-if="t.external" class="flex-1">Stop using your {{ t.name }} here? {{ t.host }} goes; its files and every database stay as they are.</span>
            <span v-else class="flex-1">Uninstall {{ t.name }}? Its files and {{ t.host }} go; every database stays as it is.</span>
            <button class="btn btn-ghost btn-xs" @click="confirming = null">Keep</button>
            <button class="btn btn-error btn-xs" @click="uninstall(t.id)">{{ t.external ? 'Stop using' : 'Uninstall' }}</button>
          </div>
        </div>
      </div>
    </div>
  </div>
  <WebToolDialog v-if="dialog" :tool="dialog.tool" :mode="dialog.mode" @close="dialog = null" />
</template>
