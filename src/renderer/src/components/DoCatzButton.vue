<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, ref } from 'vue';
import TaskStepper from './TaskStepper.vue';
import { attempt, herd, state } from '../store';
import docatzLogo from '../assets/logos/docatz.png';

/**
 * "Open in DoCatz": DoCatz (the Catzoid container manager) opens the site's compose project — its containers, logs,
 * rebuild — or the site's containers when no file is given. Looks like "Open in DBCatz", with DoCatz's logo. When
 * DoCatz is not installed, a dialog offers Download & Install — the latest release from GitHub, verified — and then
 * opens the same place. DoCatz is also the container engine the Docker tab recommends.
 */
const props = withDefaults(
  defineProps<{ siteId: string; /** A compose file of the site (its root). */ file?: string | null; label?: string; primary?: boolean; /** Why it is off (the button is disabled), e.g. the containers run on another engine. */ disabledReason?: string | null }>(),
  { file: null, label: 'Open in DoCatz', primary: false, disabledReason: null },
);
const asking = ref(false);
const installed = computed(() => state.value?.docatz.installed ?? null);
const task = computed(() => state.value?.docatz.task ?? null);
const installing = computed(() => !!task.value && !task.value.done && !task.value.error);

async function open() {
  const ok = await attempt(() => herd.docatzOpen(props.siteId, props.file));
  if (ok === false) asking.value = true;
}
async function install() {
  await attempt(() => herd.docatzInstall(props.siteId, props.file));
}
function close() {
  if (installing.value) return;
  asking.value = false;
  if (task.value) void herd.docatzDismiss();
}
</script>

<template>
  <!-- The tooltip sits on a wrapper: a disabled button shows none. -->
  <!-- The tooltip sits on a wrapper: a disabled button shows none. -->
  <span class="inline-flex" :title="disabledReason ?? (installed === false ? `DoCatz is not installed on this ${words.computer}: click to download and install it` : file ? `Open ${file} in DoCatz: its containers, logs and images` : 'Open DoCatz: containers, images and volumes')">
    <button type="button" class="btn btn-sm gap-2" :class="{ 'btn-primary': primary }" :disabled="!!disabledReason" @click="open">
      <img :src="docatzLogo" alt="" class="size-5 drop-shadow-sm" draggable="false" />{{ label }}
    </button>
  </span>

  <Teleport to="body">
    <dialog v-if="asking" open class="modal modal-open" @keydown.esc="close">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-4">
          <img :src="docatzLogo" alt="" class="size-16 shrink-0 drop-shadow-md" draggable="false" />
          <div class="min-w-0 space-y-1">
            <h3 class="text-lg font-semibold tracking-tight">DoCatz is not installed</h3>
            <p class="text-sm opacity-70">
              DoCatz is the container manager that goes with DevCatz: a light engine for Docker and Compose, with every container, image and volume in
              one window. DevCatz runs this site's containers on it.
            </p>
          </div>
        </div>
        <TaskStepper v-if="task" :task="task" cancellable dismissable @cancel="herd.docatzCancelInstall()" @dismiss="close" />
        <p v-else class="rounded-box bg-base-200/60 px-3 py-2 text-xs opacity-70">
          Download & Install fetches the latest release from GitHub (checksum verified), <template v-if="words.computer === 'PC'">runs its installer (just for you, no administrator rights)</template><template v-else>puts <span class="font-mono">DoCatz.app</span> in Applications</template> and opens it{{ file ? ` at ${file}` : '' }}.
        </p>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="installing" @click="close">{{ task?.done ? 'Close' : 'Cancel' }}</button>
          <a v-if="!task" class="btn btn-ghost btn-sm" @click="herd.openUrl('https://github.com/catzoidhub/DoCatz/releases/latest')">Releases page</a>
          <button v-if="!task || task.error" type="button" class="btn btn-primary btn-sm gap-2" @click="install">
            <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M10 2.5a.75.75 0 0 1 .75.75v7.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V3.25A.75.75 0 0 1 10 2.5ZM3.75 13a.75.75 0 0 1 .75.75v1.5c0 .14.11.25.25.25h10.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 15.25 17H4.75A1.75 1.75 0 0 1 3 15.25v-1.5a.75.75 0 0 1 .75-.75Z" /></svg>{{ task?.error ? 'Try again' : 'Download & Install' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" @click="close" />
    </dialog>
  </Teleport>
</template>
