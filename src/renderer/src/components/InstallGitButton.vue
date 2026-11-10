<script setup lang="ts">
import { ref } from 'vue';
import { herd, notify } from '../store';

/**
 * "Install Git" next to every "git is missing" note (user, 2026-11-10; the same button in DevCatz and DialCatz):
 * the OS's own way — Apple's installer on a Mac, winget on Windows (or the download page), the package manager
 * through the password dialog on Linux. The git version in the state refreshes after it; `installed` lets the place
 * refresh what else it shows.
 */
const emit = defineEmits<{ installed: [] }>();
const busy = ref(false);

async function install() {
  busy.value = true;
  try {
    const r = await herd.gitInstall();
    if (r.ok) {
      notify('success', `Git ${r.version ?? ''} installed`.replace('  ', ' '));
      emit('installed');
    } else if (r.cancelled) notify('info', 'Git was not installed: the password prompt was closed');
    else notify(r.opened ? 'info' : 'error', r.message ?? 'Git could not be installed');
  } catch (e) {
    notify('error', (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <button class="btn btn-primary btn-xs gap-1.5" :disabled="busy" title="Install Git the way this computer installs it, with its own prompt" @click="install">
    <span v-if="busy" class="loading loading-spinner loading-xs" />{{ busy ? 'Installing Git…' : 'Install Git' }}
  </button>
</template>
