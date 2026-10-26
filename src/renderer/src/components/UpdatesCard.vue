<script setup lang="ts">
import { computed } from 'vue';
import { attempt, herd, state, updateDialog } from '../store';

/** Settings → Updates (Catzoid #54): check automatically, Check now (last checked, installed version), channel, notify. */
const u = computed(() => state.value?.appUpdate ?? null);
const s = computed(() => state.value!.settings);
const when = computed(() => {
  const t = u.value?.lastChecked;
  if (!t) return 'not yet';
  const min = Math.round((Date.now() - t) / 60_000);
  return min < 1 ? 'just now' : min < 60 ? `${min} min ago` : new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
});
const status = computed(() => {
  const x = u.value;
  if (!x) return '';
  if (x.status === 'checking') return 'Looking…';
  if (x.status === 'none') return "You're up to date";
  if (x.status === 'available') return `DevCatz ${x.version} is available${x.version === s.value.appUpdateSkip ? ' (skipped)' : ''}`;
  if (x.status === 'downloading') return `Downloading ${x.version}… ${Math.floor(x.progress?.percent ?? 0)}%`;
  if (x.status === 'downloaded') return `DevCatz ${x.version} is ready to install`;
  if (x.status === 'error') return x.error ?? 'The check did not work';
  return '';
});
function checkNow() {
  updateDialog.value = true;
  if (!['available', 'downloading', 'downloaded'].includes(u.value?.status ?? '')) void attempt(() => herd.appUpdateCheck());
}
const prefs = (patch: Parameters<typeof herd.appUpdatePrefs>[0]) => attempt(() => herd.appUpdatePrefs(patch));
</script>

<template>
  <div v-if="u" class="card">
    <div class="card-body gap-4">
      <div class="flex flex-wrap items-center gap-3">
        <div class="min-w-0 flex-1">
          <h2 class="font-semibold">DevCatz {{ u.current }}</h2>
          <p class="text-sm opacity-60">
            <span :class="{ 'text-error': u.status === 'error', 'text-primary': u.status === 'available' || u.status === 'downloaded' }">{{ status }}</span>
            <template v-if="status"> · </template>last checked {{ when }}
          </p>
        </div>
        <button v-if="u.status === 'available' || u.status === 'downloading' || u.status === 'downloaded'" class="btn btn-primary btn-sm" @click="updateDialog = true">
          {{ u.status === 'downloaded' ? 'Restart to update' : "What's new" }}
        </button>
        <button class="btn btn-sm" :disabled="u.status === 'checking' || u.status === 'downloading'" @click="checkNow">
          <span v-if="u.status === 'checking'" class="loading loading-spinner loading-xs" />Check now
        </button>
      </div>

      <label class="flex cursor-pointer items-center justify-between gap-4">
        <span>
          <span class="block">Check for updates automatically</span>
          <span class="block text-xs opacity-60">30 seconds after DevCatz starts, then every 6 hours. Nothing downloads until you choose Update now.</span>
        </span>
        <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.appUpdateAuto" @change="prefs({ auto: ($event.target as HTMLInputElement).checked })" />
      </label>
      <label class="flex cursor-pointer items-center justify-between gap-4">
        <span>
          <span class="block">Notify me</span>
          <span class="block text-xs opacity-60">A notification once per new version (not for a version you skipped).</span>
        </span>
        <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="s.appUpdateNotify" @change="prefs({ notify: ($event.target as HTMLInputElement).checked })" />
      </label>
      <div class="flex items-center justify-between gap-4">
        <span>
          <span class="block">Channel</span>
          <span class="block text-xs opacity-60">Beta gets new versions earlier; they may have rough edges.</span>
        </span>
        <div class="join">
          <button v-for="c in ['stable', 'beta'] as const" :key="c" class="btn btn-sm join-item" :class="{ 'btn-active btn-primary': s.appUpdateChannel === c }" @click="prefs({ channel: c })">
            {{ c === 'stable' ? 'Stable' : 'Beta' }}
          </button>
        </div>
      </div>
      <p class="font-mono text-[11px] break-all opacity-45">Feed: {{ u.feed || `${state?.reports.site}/updates/devcatz/` }}</p>
    </div>
  </div>
</template>
