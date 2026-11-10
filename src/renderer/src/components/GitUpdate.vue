<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { herd, notify, state } from '../store';

/**
 * "<version> available [Update Git]" next to the git version when a newer git is out (user, 2026-11-10; the same in
 * DevCatz and DialCatz). Looked up from where git came (winget, the package manager, Homebrew, Software Update for
 * Apple's git); the main process keeps the answer for 6 hours. Nothing shows while up to date.
 */
const info = ref<Awaited<ReturnType<typeof herd.gitUpdateCheck>> | null>(null);
const busy = ref(false);

async function check(force = false) {
  info.value = await herd.gitUpdateCheck(force).catch(() => null);
}
onMounted(() => void check());
watch(() => state.value?.git.version, (v, old) => v && old !== undefined && v !== old && void check(true));

async function update() {
  busy.value = true;
  try {
    const r = await herd.gitUpdate();
    if (r.ok) notify('success', `Git updated to ${r.version}`);
    else if (r.cancelled) notify('info', 'Git was not updated: the password prompt was closed');
    else notify(r.opened ? 'info' : 'error', r.message ?? 'Git could not be updated');
  } catch (e) {
    notify('error', (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
  } finally {
    busy.value = false;
    await check(true);
  }
}
</script>

<template>
  <span v-if="info?.latest" class="inline-flex flex-wrap items-center gap-2">
    <span class="text-info">{{ info.what === 'git' ? `git ${info.latest}` : `Command Line Tools ${info.latest}` }} available</span>
    <button class="btn btn-primary btn-xs gap-1.5" :disabled="busy" title="Update Git the way it was installed, with this computer's own prompt" @click="update">
      <span v-if="busy" class="loading loading-spinner loading-xs" />{{ busy ? 'Updating Git…' : 'Update Git' }}
    </button>
  </span>
</template>
