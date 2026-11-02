<script setup lang="ts">
import { computed } from 'vue';
import TaskStepper from './TaskStepper.vue';
import { attempt, herd, state } from '../store';
import docatzLogo from '../assets/logos/docatz.png';

/**
 * Windows, a Docker gateway's page when DoCatz is not on this PC at all (no app, no DoCatz data): the gateways run in
 * DoCatz there, so DoCatz comes first — Download & Install (latest release, checksum verified, per-user installer),
 * then DoCatz opens at this gateway and Install in DoCatz goes on as usual.
 */
const props = defineProps<{ kind: string; name: string }>();
const task = computed(() => state.value?.docatz.task ?? null);
const installing = computed(() => !!task.value && !task.value.done && !task.value.error);
</script>

<template>
  <div class="card border border-base-300/60 bg-base-200/40">
    <div class="card-body gap-3 p-4">
      <div class="flex items-start gap-3">
        <img :src="docatzLogo" alt="" class="size-10 shrink-0 drop-shadow-sm" draggable="false" />
        <div class="min-w-0 space-y-1">
          <h3 class="font-semibold">DoCatz is not installed</h3>
          <p class="text-xs opacity-70">
            On Windows {{ props.name }} runs in DoCatz, the container manager that goes with DevCatz (its engine runs in WSL 2). Install DoCatz first, then Install in DoCatz.
          </p>
        </div>
      </div>
      <TaskStepper v-if="task" :task="task" cancellable dismissable @cancel="herd.docatzCancelInstall()" @dismiss="herd.docatzDismiss()" />
      <p v-else class="text-xs opacity-60">Download & Install fetches DoCatz's latest release from GitHub (checksum verified), runs its installer just for you (no administrator rights) and opens it.</p>
      <div class="flex flex-wrap gap-2">
        <button v-if="!task || task.error" type="button" class="btn btn-primary btn-sm gap-2" :disabled="installing" @click="attempt(() => herd.docatzInstallGateway(props.kind))">
          <img :src="docatzLogo" alt="" class="size-5 drop-shadow-sm" draggable="false" />{{ task?.error ? 'Try again' : 'Download & Install DoCatz' }}
        </button>
        <a v-if="!installing" class="btn btn-ghost btn-sm" @click="herd.openUrl('https://github.com/catzoidhub/DoCatz/releases/latest')">Releases page</a>
      </div>
    </div>
  </div>
</template>
