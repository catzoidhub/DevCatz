<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, ref, watch } from 'vue';
import type { UninstallPlan } from '@shared/types';
import CatMood from './CatMood.vue';
import TaskStepper from './TaskStepper.vue';
import { attempt, herd, notify, state, uninstallDialog } from '../store';

/**
 * Uninstall DevCatz (Catzoid family #55; the same dialog as DialCatz's): what goes, DevCatz's data and the shared
 * Catzoid settings as switches (the shared ones on by default only when no other Catzoid app is installed), typed
 * confirmation with the app's name, then the steps; DevCatz quits at the end.
 */
const NAME = 'DevCatz';
const plan = ref<UninstallPlan | null>(null);
const removeData = ref(false);
const removeShared = ref(false);
const typed = ref('');
const task = computed(() => state.value?.uninstall ?? null);
const busy = computed(() => !!task.value && !task.value.done && !task.value.error);
const blocked = computed(() => !plan.value || busy.value || typed.value.trim() !== NAME);

watch(uninstallDialog, async (open) => {
  if (!open) return;
  typed.value = '';
  removeData.value = false;
  plan.value = (await attempt(() => herd.uninstallPlan())) ?? null;
  removeShared.value = !!plan.value && plan.value.otherCatzoidApps.length === 0;
});

const items = computed(() => {
  const p = plan.value;
  if (!p) return [];
  return [
    { label: 'Every running site and service is stopped', detail: 'Sites, databases, storage, search, mail, WebSocket and gateways' },
    ...(p.systemFiles.length ? [{ label: 'Port forwarding and DNS files (one admin password prompt)', detail: p.systemFiles.join('\n') }] : []),
    { label: 'The DevCatz Local CA and the login item', detail: 'From your login keychain (macOS asks to confirm)' },
    p.homebrew
      ? { label: 'The app, through Homebrew', detail: 'brew uninstall --cask devcatz' }
      : { label: 'The app, to the Trash', detail: p.app ?? 'A development build: the app itself stays' },
  ];
});

async function copyName() {
  await navigator.clipboard.writeText(NAME);
  notify('success', 'Name copied');
}
const go = () => !blocked.value && attempt(() => herd.uninstall({ removeData: removeData.value, removeShared: removeShared.value }));
const close = () => !busy.value && (uninstallDialog.value = false);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="uninstallDialog" open class="modal modal-open" @keydown.esc="close">
      <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-3">
          <CatMood mood="warning" class="size-10 shrink-0" />
          <div>
            <h3 class="text-lg font-semibold tracking-tight">Uninstall DevCatz?</h3>
            <p class="text-sm opacity-70">This removes DevCatz and what it put on this Mac. It cannot be undone.</p>
          </div>
        </div>

        <TaskStepper v-if="task" :task="task" />

        <template v-else-if="plan">
          <ul class="space-y-1.5 rounded-xl border border-base-300/70 bg-base-200/40 p-3 text-sm">
            <li v-for="i in items" :key="i.label">
              <span class="font-medium">{{ i.label }}</span>
              <span class="block font-mono text-xs break-all whitespace-pre-line opacity-55">{{ i.detail }}</span>
            </li>
          </ul>
          <p class="text-xs opacity-60">Your own files stay: your projects, and database or storage folders you placed outside DevCatz's data folder.</p>

          <label class="flex cursor-pointer items-center justify-between gap-4">
            <span class="flex min-w-0 flex-col">
              <span class="label-caps">Also remove DevCatz's data</span>
              <span class="text-xs opacity-50">
                The sites list, runtimes, database and storage services with the data kept in DevCatz's folder, logs — to the Trash:
                <span class="font-mono break-all">{{ plan.dataDir }}</span>
              </span>
            </span>
            <input v-model="removeData" type="checkbox" class="toggle toggle-sm toggle-warning shrink-0" />
          </label>
          <label class="flex cursor-pointer items-center justify-between gap-4">
            <span class="flex min-w-0 flex-col">
              <span class="label-caps">Also remove the shared Catzoid settings</span>
              <span class="text-xs opacity-50">
                {{
                  plan.otherCatzoidApps.length
                    ? `Theme, AI connection and AI key are shared with ${plan.otherCatzoidApps.join(', ')}: keep them for those apps.`
                    : `Theme, AI connection and the AI key in ${words.secretStore}. No other Catzoid app is installed.`
                }}
              </span>
            </span>
            <input v-model="removeShared" type="checkbox" class="toggle toggle-sm toggle-warning shrink-0" />
          </label>

          <div class="space-y-1.5">
            <p class="flex flex-wrap items-center gap-1 text-sm">
              Type <b class="font-mono">{{ NAME }}</b>
              <button class="btn btn-ghost btn-xs btn-square" title="Copy the name" aria-label="Copy the name" @click="copyName">
                <svg class="size-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 9h-9a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-9a2 2 0 0 0-2-2ZM5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>
              </button>
              to confirm:
            </p>
            <input v-model="typed" class="input input-sm w-full font-mono" :placeholder="NAME" spellcheck="false" autocomplete="off" @keydown.enter="go" />
          </div>
        </template>
        <div v-else class="py-4 text-center"><span class="loading loading-dots" /></div>

        <p v-if="task?.done" class="text-sm opacity-70">Done. DevCatz quits now — thanks for trying it.</p>

        <div class="modal-action mt-0">
          <button class="btn btn-ghost btn-sm" :disabled="busy" @click="close">{{ task?.error ? 'Close' : 'Cancel' }}</button>
          <button v-if="!task || task.error" class="btn btn-error btn-sm" :disabled="blocked" @click="go">
            <span v-if="busy" class="loading loading-spinner loading-xs" />{{ task?.error ? 'Try again' : 'Uninstall DevCatz' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" @click="close" />
    </dialog>
  </Teleport>
</template>
