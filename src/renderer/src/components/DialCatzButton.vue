<script setup lang="ts">
import { computed, ref } from 'vue';
import TaskStepper from './TaskStepper.vue';
import { attempt, herd, state } from '../store';
import dialcatzLogo from '../assets/logos/dialcatz.png';

/**
 * "Open in DialCatz": DialCatz (the Catzoid API client) opens its "From DevCatz" import for this site — an
 * environment with the site's URL and .env variable names, and its routes (Laravel's route list, else the site's
 * OpenAPI). Looks like "Open in DBCatz", with DialCatz's logo. When DialCatz is not installed, a dialog offers
 * Download & Install — the latest release from GitHub, verified, copied to /Applications — and then opens the site.
 */
const props = withDefaults(defineProps<{ siteId: string; label?: string; /** Why it cannot import yet (the button is off). */ disabledReason?: string | null }>(), { label: 'Open in DialCatz', disabledReason: null });
const asking = ref(false);
const installed = computed(() => state.value?.dialcatz.installed ?? null);
const task = computed(() => state.value?.dialcatz.task ?? null);
const installing = computed(() => !!task.value && !task.value.done && !task.value.error);

async function open() {
  const ok = await attempt(() => herd.dialcatzOpen(props.siteId));
  if (ok === false) asking.value = true;
}
async function install() {
  await attempt(() => herd.dialcatzInstall(props.siteId));
}
function close() {
  if (installing.value) return;
  asking.value = false;
  if (task.value) void herd.dialcatzDismiss();
}
</script>

<template>
  <!-- The tooltip sits on a wrapper: a disabled button shows none. -->
  <span class="inline-flex" :title="disabledReason ?? (installed === false ? 'DialCatz is not installed on this Mac: click to download and install it' : 'Open this site in DialCatz: an environment for it and its routes, to call its API')">
    <button type="button" class="btn btn-sm gap-2" :disabled="!!disabledReason" @click="open">
      <img :src="dialcatzLogo" alt="" class="size-5 drop-shadow-sm" draggable="false" />{{ label }}
    </button>
  </span>

  <Teleport to="body">
    <dialog v-if="asking" open class="modal modal-open" @keydown.esc="close">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-4">
          <img :src="dialcatzLogo" alt="" class="size-16 shrink-0 drop-shadow-md" draggable="false" />
          <div class="min-w-0 space-y-1">
            <h3 class="text-lg font-semibold tracking-tight">DialCatz is not installed</h3>
            <p class="text-sm opacity-70">
              DialCatz is the API client that goes with DevCatz: it turns a site into an environment and imports its routes, so its API is one click away.
            </p>
          </div>
        </div>
        <TaskStepper v-if="task" :task="task" cancellable dismissable @cancel="herd.dialcatzCancelInstall()" @dismiss="close" />
        <p v-else class="rounded-box bg-base-200/60 px-3 py-2 text-xs opacity-70">
          Download & Install fetches the latest release from GitHub (checksum verified), puts <span class="font-mono">DialCatz.app</span> in Applications and opens it at this site.
        </p>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="installing" @click="close">{{ task?.done ? 'Close' : 'Cancel' }}</button>
          <a v-if="!task" class="btn btn-ghost btn-sm" @click="herd.openUrl('https://github.com/catzoidhub/DialCatz/releases/latest')">Releases page</a>
          <button v-if="!task || task.error" type="button" class="btn btn-primary btn-sm gap-2" @click="install">
            <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M10 2.5a.75.75 0 0 1 .75.75v7.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V3.25A.75.75 0 0 1 10 2.5ZM3.75 13a.75.75 0 0 1 .75.75v1.5c0 .14.11.25.25.25h10.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 15.25 17H4.75A1.75 1.75 0 0 1 3 15.25v-1.5a.75.75 0 0 1 .75-.75Z" /></svg>{{ task?.error ? 'Try again' : 'Download & Install' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" @click="close" />
    </dialog>
  </Teleport>
</template>
