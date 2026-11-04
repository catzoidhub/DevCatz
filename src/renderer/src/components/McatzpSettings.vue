<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { words } from '@shared/platform';
import type { McatzpActivity, Settings } from '@shared/types';
import mcatzpLogo from '../assets/logos/mcatzp.svg';
import { attempt, herd, state } from '../store';

/** Settings → MCatzP: the switch, what is shared, the approved clients and what they did. */
const s = computed(() => state.value!.settings);
const on = computed(() => s.value.mcatzp === true);
const sites = computed(() => [...state.value!.projects].filter((p) => !p.worktreeOf).sort((a, b) => a.name.localeCompare(b.name)));
const shared = computed(() => new Set(s.value.mcatzpSites ?? []));
const save = (patch: Partial<Settings>) => attempt(() => herd.updateSettings(patch).then(() => true));
function toggleSite(id: string, yes: boolean) {
  const next = new Set(shared.value);
  if (yes) next.add(id);
  else next.delete(id);
  void save({ mcatzpSites: [...next] });
}

const activity = ref<McatzpActivity[]>([]);
const load = async () => {
  if (on.value) activity.value = (await attempt(() => herd.mcatzpActivity())) ?? activity.value;
};
// While this page is open only: calls come from outside DevCatz, with no state change to follow.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));
const revoke = (name: string) => attempt(() => herd.mcatzpRevoke(name).then(() => true));
async function clearLog() {
  await attempt(() => herd.mcatzpClearActivity().then(() => true));
  activity.value = [];
}
const TONE = { ok: 'text-success', refused: 'text-error', declined: 'text-warning', failed: 'text-error' } as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
</script>

<template>
  <div class="card">
    <div class="card-body gap-3 p-4">
      <h2 class="flex items-center gap-2 font-semibold"><img :src="mcatzpLogo" alt="" class="size-5 rounded" draggable="false" />MCatzP</h2>
      <label class="flex cursor-pointer items-start gap-3">
        <input type="checkbox" class="toggle toggle-primary toggle-sm mt-0.5" :checked="on" @change="save({ mcatzp: ($event.target as HTMLInputElement).checked })" />
        <span>
          Let AI assistants use DevCatz through MCatzP
          <span class="block text-xs opacity-60">An MCP client you approve can read what you share below (secrets masked) and ask for changes, which DevCatz confirms with you first. It reaches DevCatz through a channel only your account on this {{ words.computer }} can open. What it reads goes to that assistant's model provider.</span>
        </span>
      </label>

      <template v-if="on">
        <div class="border-t border-base-300/50 pt-3">
          <span class="label-caps mb-2 block">Shared sites</span>
          <label class="flex cursor-pointer items-center gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm" :checked="s.mcatzpAllSites === true" @change="save({ mcatzpAllSites: ($event.target as HTMLInputElement).checked })" />
            All sites, including new ones
          </label>
          <div v-if="s.mcatzpAllSites !== true" class="mt-2 max-h-48 space-y-1 overflow-y-auto rounded-box border border-base-300/60 p-2">
            <p v-if="!sites.length" class="text-xs opacity-60">No sites yet.</p>
            <label v-for="p in sites" :key="p.id" class="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" class="checkbox checkbox-xs" :checked="shared.has(p.id)" @change="toggleSite(p.id, ($event.target as HTMLInputElement).checked)" />
              <span class="min-w-0 flex-1 truncate">{{ p.name }}</span>
              <span class="truncate text-xs opacity-50">{{ p.domain }}</span>
            </label>
          </div>
          <p v-if="s.mcatzpAllSites !== true && !shared.size" class="mt-1 text-xs opacity-60">Nothing shared yet: clients see no sites until you tick some.</p>
        </div>

        <div class="space-y-2 border-t border-base-300/50 pt-3">
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.mcatzpServices !== false" @change="save({ mcatzpServices: ($event.target as HTMLInputElement).checked })" />
            <span>Services and runtimes<span class="block text-xs opacity-60">Which databases, search engines and other services exist and whether they run; no passwords or keys.</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.mcatzpChanges !== false" @change="save({ mcatzpChanges: ($event.target as HTMLInputElement).checked })" />
            <span>Let clients ask for changes<span class="block text-xs opacity-60">Starting, stopping and restarting, creating a database service or a database. DevCatz shows you each request first. Off: clients can only read.</span></span>
          </label>
        </div>

        <div class="border-t border-base-300/50 pt-3">
          <span class="label-caps mb-2 block">Approved clients</span>
          <p v-if="!s.mcatzpClients?.length" class="text-xs opacity-60">None yet. A client asks here the first time it connects.</p>
          <div v-for="c in s.mcatzpClients" :key="c.name" class="flex items-center gap-2 py-0.5 text-sm">
            <span class="selectable min-w-0 flex-1 truncate">{{ c.name }}</span>
            <span class="text-xs opacity-50">{{ when(c.approvedAt) }}</span>
            <button class="btn btn-ghost btn-xs text-error" @click="revoke(c.name)">Revoke</button>
          </div>
        </div>

        <div class="border-t border-base-300/50 pt-3">
          <div class="mb-2 flex items-center">
            <span class="label-caps flex-1">Activity</span>
            <button v-if="activity.length" class="btn btn-ghost btn-xs" @click="clearLog">Clear</button>
          </div>
          <p v-if="!activity.length" class="text-xs opacity-60">Nothing yet. Every call is listed here: names and outcomes, not what was read.</p>
          <div v-else class="max-h-64 space-y-0.5 overflow-y-auto">
            <div v-for="(a, i) in activity" :key="i" class="flex items-baseline gap-2 text-xs" :title="a.reason">
              <span class="w-32 shrink-0 tabular-nums opacity-50">{{ when(a.time) }}</span>
              <span class="w-24 shrink-0 truncate opacity-70">{{ a.client }}</span>
              <code class="min-w-0 flex-1 truncate">{{ a.action ?? a.method }}</code>
              <span class="shrink-0 font-medium" :class="TONE[a.outcome]">{{ a.outcome }}</span>
            </div>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>
