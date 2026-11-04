<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { words } from '@shared/platform';
import type { McatzpActivity, McatzpSetup, McatzpTarget, Settings } from '@shared/types';
import mcatzpLogo from '../assets/logos/mcatzp.svg';
import CatMood from './CatMood.vue';
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

const saveNames = (key: 'mcatzpEnvPublic' | 'mcatzpEnvSecret', text: string) => save({ [key]: text.split(/[\s,]+/).filter((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n)) });

// The program clients start: one copy per computer.
const setup = ref<McatzpSetup | null>(null);
const installing = computed(() => state.value!.mcatzpInstalling);
const percent = computed(() => (installing.value?.total ? Math.round((installing.value.received / installing.value.total) * 100) : 0));
const outdated = computed(() => {
  const [a, b] = [setup.value?.version, setup.value?.latest];
  if (!a || !b || setup.value?.source !== 'catzoid') return false;
  return a.localeCompare(b, undefined, { numeric: true }) < 0;
});
const updateHow = { homebrew: 'Homebrew', other: 'how you installed it' } as const;
async function installMcatzp() {
  const next = await attempt(() => herd.mcatzpInstall());
  if (next) setup.value = next;
  void loadTargets();
}
const targets = ref<McatzpTarget[]>([]);
const clientBusy = ref<string | null>(null);
const clientChanged = ref<string | null>(null);
const loadTargets = async () => {
  targets.value = (await attempt(() => herd.mcatzpTargets())) ?? targets.value;
};
async function addClient(t: McatzpTarget) {
  if (t.command !== null && !confirm(`${t.label} already runs MCatzP as:\n${t.command}\n\nPoint it at this copy instead?`)) return;
  clientBusy.value = t.id;
  const next = await attempt(() => herd.mcatzpAddToClient(t.id));
  clientBusy.value = null;
  if (next) {
    targets.value = next;
    clientChanged.value = t.label;
  }
}
async function removeClient(t: McatzpTarget) {
  clientBusy.value = t.id;
  const next = await attempt(() => herd.mcatzpRemoveFromClient(t.id));
  clientBusy.value = null;
  if (next) targets.value = next;
}
const cancelInstall = () => attempt(() => herd.mcatzpInstallCancel().then(() => true));

const SECTIONS = [
  { id: 'clients', label: 'Clients' },
  { id: 'access', label: 'Access' },
  { id: 'activity', label: 'Activity' },
] as const;
const section = ref<(typeof SECTIONS)[number]['id']>('clients');

const activity = ref<McatzpActivity[]>([]);
const load = async () => {
  if (on.value && section.value !== 'access') activity.value = (await attempt(() => herd.mcatzpActivity())) ?? activity.value;
};
// While this page is open only: calls come from outside DevCatz, with no state change to follow.
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  // What is on this computer first: the site may take a while.
  void attempt(() => herd.mcatzpSetup(false)).then((r) => r && !setup.value && (setup.value = r));
  void attempt(() => herd.mcatzpSetup()).then((r) => r && (setup.value = r));
  void loadTargets();
  void load();
  timer = setInterval(() => void load(), 3000);
});
onBeforeUnmount(() => clearInterval(timer));
watch(section, () => void load());
const revoke = (name: string) => attempt(() => herd.mcatzpRevoke(name).then(() => true));
async function clearLog() {
  await attempt(() => herd.mcatzpClearActivity().then(() => true));
  activity.value = [];
}
const TONE = { ok: 'text-success', refused: 'text-error', declined: 'text-warning', failed: 'text-error' } as const;
const DOT = { ok: 'status-success', refused: 'status-error', declined: 'status-warning', failed: 'status-error' } as const;
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });

/** Each approved client with what the log knows about it, the most recent first. */
const clients = computed(() => {
  const list = (s.value.mcatzpClients ?? []).map((c) => {
    const own = activity.value.filter((a) => a.client === c.name && a.action);
    return { ...c, last: own[0]?.time ?? null, calls: own.length };
  });
  return list.sort((a, b) => (b.last ?? b.approvedAt).localeCompare(a.last ?? a.approvedAt));
});

const FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'changes', label: 'Changes' },
  { id: 'problems', label: 'Problems' },
] as const;
const filter = ref<(typeof FILTERS)[number]['id']>('all');

/** By day, with a run of the same call folded into one row (a client polling a status is one line, not fifty). */
const groups = computed(() => {
  const out: { day: string; rows: (McatzpActivity & { key: string; name: string; count: number })[] }[] = [];
  activity.value.forEach((a, i) => {
    if (filter.value === 'changes' && a.tier !== 'change' && a.tier !== 'destructive') return;
    if (filter.value === 'problems' && a.outcome === 'ok') return;
    const d = day(a.time);
    const name = a.action ?? a.method;
    if (out.at(-1)?.day !== d) out.push({ day: d, rows: [] });
    const rows = out.at(-1)!.rows;
    const prev = rows.at(-1);
    if (prev && prev.name === name && prev.client === a.client && prev.outcome === a.outcome) prev.count++;
    else rows.push({ ...a, key: `${a.time}-${i}`, name, count: 1 });
  });
  return out;
});
</script>

<template>
  <div class="card">
    <div class="card-body gap-3 p-4">
      <div class="flex items-center gap-3">
        <img :src="mcatzpLogo" alt="" class="logo size-14 shrink-0 rounded-2xl" draggable="false" />
        <div class="min-w-0">
          <h2 class="text-lg font-semibold tracking-tight">MCatzP</h2>
          <p class="text-xs opacity-60">One connection, every cat.</p>
        </div>
      </div>
      <label class="flex cursor-pointer items-start gap-3">
        <input type="checkbox" class="toggle toggle-primary toggle-sm mt-0.5" :checked="on" @change="save({ mcatzp: ($event.target as HTMLInputElement).checked })" />
        <span>
          Let AI assistants use DevCatz through MCatzP
          <span class="block text-xs opacity-60">An MCP client you approve can read what you share (secrets masked) and ask for changes, which DevCatz confirms with you first. It reaches DevCatz through a channel only your account on this {{ words.computer }} can open. What it reads goes to that assistant's model provider.</span>
        </span>
      </label>
      <!-- Clients start this program, so it is what a client's setup points at. -->
      <div class="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-base-300/50 pt-3 text-sm">
        <div class="min-w-0 flex-1 basis-64">
          <template v-if="installing">
            <span>{{ installing.phase === 'install' ? 'Installing MCatzP…' : 'Downloading MCatzP…' }}</span>
            <progress v-if="installing.phase === 'install' || installing.total" class="progress progress-primary mt-1 block w-full" :value="installing.phase === 'install' ? 100 : percent" max="100" />
            <progress v-else class="progress progress-primary mt-1 block w-full" />
          </template>
          <template v-else-if="setup?.path">
            <span>MCatzP {{ setup.version }} is on this computer</span>
            <code class="selectable mt-0.5 block truncate text-xs opacity-60" :title="setup.path">{{ setup.path }}</code>
            <span v-if="setup.source && setup.source !== 'catzoid'" class="block text-xs opacity-60">DevCatz uses this copy. Update it with {{ updateHow[setup.source] }}.</span>
          </template>
          <template v-else-if="setup">
            <span>MCatzP is not on this computer yet</span>
            <span class="block text-xs opacity-60">
              <template v-if="setup.error">The site could not be reached: {{ setup.error }}</template>
              <template v-else-if="setup.noBuild">There is no build for this computer yet.</template>
              <template v-else>AI assistants start this small program to reach DevCatz. It goes in one place, for every Catzoid app.</template>
            </span>
          </template>
        </div>
        <button v-if="installing" class="btn btn-sm" :disabled="installing.phase === 'install'" @click="cancelInstall">Cancel</button>
        <button v-else-if="setup && !setup.path" class="btn btn-primary btn-sm" :disabled="!setup.checked || setup.noBuild" @click="installMcatzp">Install MCatzP</button>
        <button v-else-if="outdated" class="btn btn-sm" @click="installMcatzp">Update to {{ setup?.latest }}</button>
      </div>

      <template v-if="on">
        <div role="tablist" class="seg self-start">
          <button v-for="t in SECTIONS" :key="t.id" role="tab" class="seg-item" :class="{ 'is-active': section === t.id }" @click="section = t.id">{{ t.label }}</button>
        </div>

        <div v-if="section === 'clients'" class="flex flex-col gap-4">
          <div v-if="targets.length">
            <span class="label-caps mb-2 block">AI assistants</span>
            <ul class="divide-y divide-base-300/50 overflow-hidden rounded-box border border-base-300/60">
              <li v-for="t in targets" :key="t.id" class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
                <span class="status status-sm shrink-0" :class="t.current ? 'status-success' : t.command !== null ? 'status-warning' : 'opacity-30'" />
                <div class="min-w-0 flex-1 basis-48">
                  <span class="font-medium">{{ t.label }}</span>
                  <span v-if="!t.found" class="block text-xs opacity-60">Not found on this computer</span>
                  <span v-else-if="t.current" class="block text-xs opacity-60">Added, using this copy</span>
                  <span v-else-if="t.command !== null" class="block truncate text-xs opacity-60" :title="t.command">Runs another copy: {{ t.command }}</span>
                  <span v-else class="block text-xs opacity-60">Not added yet</span>
                </div>
                <button v-if="t.command !== null" class="btn btn-ghost btn-xs" :disabled="clientBusy === t.id" @click="removeClient(t)">Remove</button>
                <button v-if="t.found && !t.current" class="btn btn-sm" :disabled="!setup?.path || clientBusy === t.id" :title="setup?.path ? '' : 'Install MCatzP first'" @click="addClient(t)">
                  <span v-if="clientBusy === t.id" class="loading loading-spinner loading-xs" />{{ t.command !== null ? 'Use this copy' : `Add to ${t.label}` }}
                </button>
              </li>
            </ul>
            <p v-if="clientChanged" class="mt-2 text-xs opacity-70">Start a new session in {{ clientChanged }} so it picks up the change.</p>
          </div>

          <div>
            <span class="label-caps mb-2 block">Approved</span>
            <p v-if="!s.mcatzpClients?.length" class="text-xs opacity-60">None yet. A client asks in DevCatz the first time it connects, and shows up here once you allow it.</p>
            <ul v-else class="divide-y divide-base-300/50 overflow-hidden rounded-box border border-base-300/60">
            <li v-for="c in clients" :key="c.name" class="flex items-center gap-3 px-3 py-2.5">
              <span class="avatar-letter" aria-hidden="true">{{ c.name.slice(0, 1).toUpperCase() }}</span>
              <div class="min-w-0 flex-1">
                <p class="selectable truncate text-sm font-medium">{{ c.name }}</p>
                <p class="truncate text-xs opacity-60">Approved {{ day(c.approvedAt) }}<template v-if="c.last"> · last call {{ when(c.last) }} · {{ c.calls }} {{ c.calls === 1 ? 'call' : 'calls' }}</template></p>
              </div>
              <button class="btn btn-sm" @click="revoke(c.name)">Revoke</button>
            </li>
          </ul>
          </div>
        </div>

        <div v-else-if="section === 'access'" class="flex flex-col gap-3">
        <div>
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
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.mcatzpMessages === true" @change="save({ mcatzpMessages: ($event.target as HTMLInputElement).checked })" />
            <span>Messages<span class="block text-xs opacity-60">Caught mail and SMS, WhatsApp contacts and messages, requests through a public share. They can hold personal data, which then goes to the assistant's model provider. Off by default.</span></span>
          </label>
          <label class="flex cursor-pointer items-start gap-2 text-sm">
            <input type="checkbox" class="checkbox checkbox-sm mt-0.5" :checked="s.mcatzpChanges !== false" @change="save({ mcatzpChanges: ($event.target as HTMLInputElement).checked })" />
            <span>Let clients ask for changes<span class="block text-xs opacity-60">Starting, stopping and restarting; creating a database service or a database; installing a service or a runtime. DevCatz shows you each request first. Off: clients can only read.</span></span>
          </label>
        </div>

        <div class="space-y-2 border-t border-base-300/50 pt-3">
          <span class="label-caps block">.env variables</span>
          <p class="text-xs opacity-60">Names are always readable. Secret values only go out one at a time, after you allow it; other values are readable for shared sites. DevCatz tells them apart by the name. Correct it here, for every site, with names separated by commas.</p>
          <label class="flex items-center gap-3 text-sm">
            <span class="w-36 shrink-0 opacity-70">Not secret</span>
            <input class="input input-sm min-w-0 flex-1 font-mono text-xs" :value="(s.mcatzpEnvPublic ?? []).join(', ')" placeholder="SESSION_DRIVER, AUTH_GUARD" spellcheck="false" @change="saveNames('mcatzpEnvPublic', ($event.target as HTMLInputElement).value)" />
          </label>
          <label class="flex items-center gap-3 text-sm">
            <span class="w-36 shrink-0 opacity-70">Secret</span>
            <input class="input input-sm min-w-0 flex-1 font-mono text-xs" :value="(s.mcatzpEnvSecret ?? []).join(', ')" placeholder="INTERNAL_URL, LICENSE" spellcheck="false" @change="saveNames('mcatzpEnvSecret', ($event.target as HTMLInputElement).value)" />
          </label>
        </div>
        </div>

        <div v-else>
          <div class="mb-3 flex flex-wrap items-center gap-2">
            <div role="tablist" class="seg seg-xs">
              <button v-for="f in FILTERS" :key="f.id" role="tab" class="seg-item" :class="{ 'is-active': filter === f.id }" @click="filter = f.id">{{ f.label }}</button>
            </div>
            <span class="flex-1" />
            <button v-if="activity.length" class="btn btn-ghost btn-xs" @click="clearLog">Clear</button>
          </div>
          <div v-if="!groups.length" class="empty">
            <CatMood mood="info" class="size-14" />
            <p class="font-medium">{{ activity.length ? 'Nothing here' : 'No activity yet' }}</p>
            <p class="text-xs opacity-60">{{ activity.length ? 'No call matches this filter.' : 'Every call is listed here: names and outcomes, never what was read.' }}</p>
          </div>
          <div v-else class="log max-h-[30rem] overflow-y-auto rounded-box border border-base-300/60">
            <section v-for="g in groups" :key="g.day">
              <h3 class="log-day">{{ g.day }}</h3>
              <div v-for="r in g.rows" :key="r.key" class="log-row" :title="r.reason">
                <span class="status status-sm shrink-0" :class="DOT[r.outcome]" />
                <code class="selectable min-w-0 flex-1 truncate text-xs">{{ r.name }}<span v-if="r.count > 1" class="ml-1.5 opacity-50">×{{ r.count }}</span></code>
                <span class="flex w-20 shrink-0 justify-end">
                  <span v-if="r.tier === 'destructive'" class="badge badge-xs badge-error badge-outline">destructive</span>
                  <span v-else-if="r.tier === 'change'" class="badge badge-xs badge-ghost">change</span>
                </span>
                <span class="hidden w-24 shrink-0 truncate text-xs opacity-60 sm:block">{{ r.client }}</span>
                <span class="w-16 shrink-0 text-right text-xs font-medium" :class="TONE[r.outcome]">{{ r.outcome === 'ok' ? '' : r.outcome }}</span>
                <span class="w-14 shrink-0 text-right text-xs tabular-nums opacity-50">{{ clock(r.time) }}</span>
              </div>
            </section>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
/* MCatzP's own pink, so the page is known at a glance. */
.logo {
  box-shadow: 0 0 0 1px color-mix(in oklab, #ff8dbe 45%, transparent), 0 6px 20px color-mix(in oklab, #ff8dbe 35%, transparent);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
  padding: 2rem 1rem;
  text-align: center;
}
.avatar-letter {
  display: grid;
  width: 2.25rem;
  height: 2.25rem;
  flex-shrink: 0;
  place-items: center;
  border-radius: 0.625rem;
  background: color-mix(in oklab, #ff8dbe 18%, transparent);
  color: #ff8dbe;
  font-weight: 600;
}
.log-day {
  position: sticky;
  top: 0;
  z-index: 1;
  padding: 0.375rem 0.75rem;
  background: var(--color-base-200);
  font-size: 0.6875rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  opacity: 0.85;
  text-transform: uppercase;
}
.log-row {
  display: flex;
  align-items: center;
  gap: 0.625rem;
  padding: 0.375rem 0.75rem;
}
.log-row + .log-row {
  border-top: 1px solid color-mix(in oklab, var(--color-base-300) 45%, transparent);
}
</style>
