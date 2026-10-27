<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, ref } from 'vue';
import { attempt, herd, state } from '../store';
import TaskStepper from './TaskStepper.vue';
import dbcatzLogo from '../assets/logos/dbcatz.png';

/**
 * "Open in DBCatz": opens the database viewer app at a connection
 * (`svc:<service id>`, optionally at a database; null = its Connections tab).
 * When DBCatz is not installed, a dialog offers Download & Install — the
 * latest release from GitHub, verified, copied to /Applications — and then
 * opens the same connection.
 */
const props = withDefaults(defineProps<{ connId?: string | null; database?: string; label?: string; primary?: boolean; title?: string; size?: 'sm' | 'md' }>(), {
  connId: null,
  database: undefined,
  label: 'Open in DBCatz',
  primary: false,
  title: undefined,
  size: 'sm',
});
const asking = ref(false);
const task = computed(() => state.value?.dbcatz.task ?? null);
const installing = computed(() => !!task.value && !task.value.done && !task.value.error);
const hint = computed(() => props.title ?? (props.connId ? `Browse and edit ${props.database ? `the ${props.database} database` : 'this service'} in DBCatz` : 'Open DBCatz, the database viewer (any server, not only DevCatz services)'));

async function open() {
  const ok = await attempt(() => herd.dbcatzOpen(props.connId, props.database));
  if (ok === false) asking.value = true;
}
async function install() {
  await attempt(() => herd.dbcatzInstall(props.connId, props.database));
}
function close() {
  if (installing.value) return;
  asking.value = false;
  if (task.value) void herd.dbcatzDismiss();
}
</script>

<template>
  <button type="button" class="btn gap-2" :class="[primary ? 'btn-primary' : '', size === 'sm' ? 'btn-sm' : '']" :title="hint" @click="open">
    <img :src="dbcatzLogo" alt="" class="size-5 drop-shadow-sm" draggable="false" />{{ label }}
  </button>

  <Teleport to="body">
    <dialog v-if="asking" open class="modal modal-open" @keydown.esc="close">
      <div class="modal-box w-[30rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-4">
          <img :src="dbcatzLogo" alt="" class="size-16 shrink-0 drop-shadow-md" draggable="false" />
          <div class="min-w-0 space-y-1">
            <h3 class="text-lg font-semibold tracking-tight">DBCatz is not installed</h3>
            <p class="text-sm opacity-70">
              DBCatz is the database viewer that goes with DevCatz: it browses and edits MySQL, MariaDB, PostgreSQL, SQLite, Redis, Valkey, MongoDB and Elasticsearch, lists DevCatz's services on its own, and opens any other server too.
            </p>
          </div>
        </div>

        <TaskStepper v-if="task" :task="task" cancellable dismissable @cancel="herd.dbcatzCancelInstall()" @dismiss="close" />
        <p v-else class="rounded-box bg-base-200/60 px-3 py-2 text-xs opacity-70">
          Download & Install fetches the latest release from GitHub (checksum verified), <template v-if="words.computer === 'PC'">runs its installer (just for you, no administrator rights)</template><template v-else>puts <span class="font-mono">DBCatz.app</span> in Applications</template> and opens it{{ connId ? ' at this connection' : '' }}.
        </p>

        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="installing" @click="close">{{ task?.done ? 'Close' : 'Cancel' }}</button>
          <a v-if="!task" class="btn btn-ghost btn-sm" @click="herd.openUrl('https://github.com/catzoidhub/DBCatz/releases/latest')">Releases page</a>
          <button v-if="!task || task.error" type="button" class="btn btn-primary btn-sm gap-2" @click="install">
            <svg viewBox="0 0 20 20" class="size-4" fill="currentColor"><path d="M10 2.5a.75.75 0 0 1 .75.75v7.69l2.22-2.22a.75.75 0 1 1 1.06 1.06l-3.5 3.5a.75.75 0 0 1-1.06 0l-3.5-3.5a.75.75 0 1 1 1.06-1.06l2.22 2.22V3.25A.75.75 0 0 1 10 2.5ZM3.75 13a.75.75 0 0 1 .75.75v1.5c0 .14.11.25.25.25h10.5a.25.25 0 0 0 .25-.25v-1.5a.75.75 0 0 1 1.5 0v1.5A1.75 1.75 0 0 1 15.25 17H4.75A1.75 1.75 0 0 1 3 15.25v-1.5a.75.75 0 0 1 .75-.75Z" /></svg>{{ task?.error ? 'Try again' : 'Download & Install' }}
          </button>
        </div>
      </div>
      <div class="modal-backdrop" @click="close" />
    </dialog>
  </Teleport>
</template>
