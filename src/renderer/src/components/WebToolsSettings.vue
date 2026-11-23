<script setup lang="ts">
import { computed, ref } from 'vue';
import type { WebToolId } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import { DB_LOGO } from '../db';
import { WEB_TOOL_LOGO, WEB_TOOL_TILE } from '../logos';
import TaskStepper from './TaskStepper.vue';
import WebToolDialog from './WebToolDialog.vue';
import WebToolAutoStop from './WebToolAutoStop.vue';

/** Settings → Database → Web tools (TODO §48): every web tool in one table, installed or not, with its actions. */
const tools = computed(() => state.value?.webTools ?? []);
const dialog = ref<{ tool: WebToolId; mode: 'install' | 'settings' } | null>(null);
const confirming = ref<WebToolId | null>(null);
const checking = ref(false);
const busy = (t: { task: { done?: boolean; error?: string } | null }) => !!t.task && !t.task.done && !t.task.error;

async function checkUpdates() {
  checking.value = true;
  const failed = await attempt(() => herd.webToolsCheckUpdates());
  checking.value = false;
  if (failed?.length) notify('warning', `Could not check ${failed.join(', ')}`);
  else if (failed) notify('success', tools.value.some((t) => t.update) ? 'Updates found' : 'Everything is up to date');
}
async function toggle(id: WebToolId, running: boolean) {
  // pgweb / mongo-express start per service (Open or the service's Web tools card); here they can only be stopped, all at once.
  await attempt(() => (running ? herd.webToolStop(id) : herd.webToolStart(id)));
}
async function update(id: WebToolId, name: string) {
  await attempt(() => herd.webToolUpdate(id), `${name} updated`);
}
async function uninstall(id: WebToolId) {
  confirming.value = null;
  await attempt(() => herd.webToolUninstall(id), 'Uninstalled');
}
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Web tools</h2>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs" :disabled="checking || !tools.some((t) => t.installed)" @click="checkUpdates">
          <span v-if="checking" class="loading loading-spinner loading-xs" />Check for updates
        </button>
      </div>
      <p class="text-xs opacity-60">
        Browser tools for the database services, each at its own address; they sign in by themselves. Open on a service uses the one picked last
        there (▾ next to Open); DBCatz stays the recommended app. pgweb and mongo-express run once per service, started by Open.
      </p>
      <div class="overflow-x-auto rounded-box border border-base-300/60">
        <table class="table table-sm">
          <thead>
            <tr><th>Tool</th><th>Opens</th><th>Version</th><th>Address</th><th class="text-right"></th></tr>
          </thead>
          <tbody>
            <template v-for="t in tools" :key="t.id">
              <tr>
                <td class="whitespace-nowrap">
                  <div class="flex items-center gap-2">
                    <img :src="WEB_TOOL_LOGO[t.id]" alt="" class="size-6 object-contain" :class="WEB_TOOL_TILE[t.id]" draggable="false" />
                    <span class="font-medium">{{ t.name }}</span>
                    <span v-if="t.running.length" class="status status-success status-sm" title="Running" />
                  </div>
                </td>
                <td class="whitespace-nowrap">
                  <img v-for="e in t.engines" :key="e" :src="DB_LOGO[e]" :alt="e" :title="e" class="mr-1 inline size-4 rounded bg-white p-px" draggable="false" />
                </td>
                <td class="font-mono text-xs whitespace-nowrap">
                  <template v-if="t.installed">
                    {{ t.version }}<span v-if="t.update" class="badge badge-info badge-xs ml-1.5">{{ t.update }}</span>
                    <span v-if="t.external" class="block font-sans text-[11px] opacity-60" :title="t.external.path">your own{{ t.external.label ? ` · ${t.external.label}` : '' }}</span>
                  </template>
                  <span v-else class="badge badge-ghost badge-sm font-sans">not installed</span>
                </td>
                <td class="font-mono text-xs">
                  <template v-if="t.installed">
                    {{ t.perService ? `<service>.${t.host}` : t.host }} · :{{ t.port }}<span v-if="t.runtime && t.runtimeVersion" class="font-sans opacity-60"> · {{ t.runtime === 'php' ? 'PHP' : 'Node.js' }} {{ t.runtimeVersion }}</span>
                  </template>
                  <span v-else-if="t.found" class="font-sans opacity-60" :title="t.found.path">Found on this computer{{ t.found.label ? ` (${t.found.label})` : '' }}{{ t.found.version ? ` · ${t.found.version}` : '' }}</span>
                  <span v-else class="font-sans opacity-60">{{ t.blocked ?? t.description }}</span>
                </td>
                <td class="text-right whitespace-nowrap">
                  <template v-if="t.installed">
                    <button v-if="t.update" class="btn btn-xs" :disabled="busy(t)" @click="update(t.id, t.name)">Update</button>
                    <button
                      v-if="!t.perService || t.running.length"
                      class="btn btn-ghost btn-xs"
                      :disabled="busy(t)"
                      :title="t.perService ? `Stops ${t.name} of every service` : undefined"
                      @click="toggle(t.id, t.running.length > 0)"
                    >
                      {{ t.running.length ? (t.perService && t.running.length > 1 ? `Stop all (${t.running.length})` : 'Stop') : 'Start' }}
                    </button>
                    <button class="btn btn-ghost btn-xs" :disabled="busy(t)" @click="dialog = { tool: t.id, mode: 'settings' }">Settings…</button>
                    <button class="btn btn-ghost btn-xs text-error" :disabled="busy(t)" @click="confirming = t.id">{{ t.external ? 'Stop using' : 'Uninstall' }}</button>
                  </template>
                  <button v-else class="btn btn-xs" :disabled="busy(t)" @click="dialog = { tool: t.id, mode: 'install' }">{{ t.found ? 'Add…' : 'Install…' }}</button>
                </td>
              </tr>
              <tr v-if="t.installed && t.autoStop !== null">
                <td colspan="5" class="pt-0">
                  <WebToolAutoStop :tool="t" />
                </td>
              </tr>
              <tr v-if="(t.task && !dialog) || confirming === t.id">
                <td colspan="5">
                  <TaskStepper v-if="t.task && !dialog" :task="t.task" compact cancellable dismissable @cancel="herd.webToolCancel(t.id)" @dismiss="herd.webToolCancel(t.id)" />
                  <div v-if="confirming === t.id" role="alert" class="alert alert-warning alert-soft flex flex-wrap items-center gap-2 text-sm">
                    <span v-if="t.external" class="flex-1">Stop using your {{ t.name }} here? {{ t.host }} goes; its files and every database stay as they are.</span>
                    <span v-else class="flex-1">Uninstall {{ t.name }}? Its files and {{ t.host }} go; every database stays as it is.</span>
                    <button class="btn btn-ghost btn-xs" @click="confirming = null">Keep</button>
                    <button class="btn btn-error btn-xs" @click="uninstall(t.id)">{{ t.external ? 'Stop using' : 'Uninstall' }}</button>
                  </div>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
  <WebToolDialog v-if="dialog" :tool="dialog.tool" :mode="dialog.mode" @close="dialog = null" />
</template>
