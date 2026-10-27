<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue';
import type { MonitorEntity, MonitorKind, MonitorPoint, MonitorRange, MonitorUpdate } from '@shared/types';
import Sparkline from './Sparkline.vue';
import DepsCleanup from './DepsCleanup.vue';
import { attempt, herd, notify, state } from '../store';
import { monitorLogo } from '../logos';
import { bytes, pct, rate } from '../monitor';

/**
 * Monitoring (rail): the Mac at the top, then every site and service DevCatz
 * runs with CPU, memory, network and disk I/O, an hour of history each
 * (24 h of per-minute averages from the main process for the detail charts).
 */
const emit = defineEmits<{ open: [link: NonNullable<MonitorEntity['link']>] }>();

const latest = shallowRef<MonitorUpdate | null>(null);
/** id → points (oldest first); `system` and `total` too. Mutated in place, `tick` re-renders. */
const history = new Map<string, MonitorPoint[]>();
const tick = ref(0);
const HOUR = 3_600_000;

function push(id: string, p: MonitorPoint) {
  const h = history.get(id) ?? [];
  h.push(p);
  while (h.length && h[0].t < p.t - HOUR) h.shift();
  history.set(id, h);
}
function apply(u: MonitorUpdate) {
  latest.value = u;
  for (const e of u.entities) push(e.id, { t: u.at, cpu: e.cpu, mem: e.mem, netIn: e.netIn, netOut: e.netOut, diskRead: e.diskRead, diskWrite: e.diskWrite });
  push('total', u.total);
  push('system', { t: u.at, cpu: u.system.cpu, mem: u.system.memUsed, netIn: u.system.netIn, netOut: u.system.netOut, diskRead: 0, diskWrite: 0 });
  tick.value++;
}

let off: (() => void) | null = null;
onMounted(async () => {
  const snap = await herd.monitorSnapshot();
  for (const [id, pts] of Object.entries(snap.history)) history.set(id, [...pts]);
  latest.value = snap;
  tick.value++;
  off = herd.onMonitor(apply);
  await herd.monitorLive(true);
});
onBeforeUnmount(() => {
  off?.();
  if (longTimer) clearInterval(longTimer);
  void herd.monitorLive(false);
});

// ---- detail range: 1 h of samples here, 6 h / 24 h of per-minute averages from the main process
const range = ref<MonitorRange>('1h');
const longHist = shallowRef<Record<string, MonitorPoint[]>>({});
let longTimer: ReturnType<typeof setInterval> | null = null;
async function loadLong() {
  if (range.value !== '1h') longHist.value = await herd.monitorHistory(range.value);
}
async function setRange(r: MonitorRange) {
  range.value = r;
  if (longTimer) clearInterval(longTimer);
  longTimer = null;
  if (r === '1h') return;
  await loadLong();
  longTimer = setInterval(loadLong, 60_000);
}
const points = (id: string): MonitorPoint[] => {
  void tick.value;
  return range.value === '1h' ? (history.get(id) ?? []) : (longHist.value[id] ?? []);
};
const detail = (id: string, key: keyof Omit<MonitorPoint, 't'>) => (range.value === '1h' ? series(id, key, 60) : points(id).map((p) => p[key]));

async function exportCsv(r: MonitorRange) {
  (document.activeElement as HTMLElement | null)?.blur();
  const file = await attempt(() => herd.monitorExport(r));
  if (file) notify('success', `Saved ${file.split('/').pop()}`);
}

/** Last N minutes of a series for sparklines (whole hour in the detail view). */
const series = (id: string, key: keyof Omit<MonitorPoint, 't'>, minutes = 10) => {
  void tick.value;
  const h = history.get(id) ?? [];
  const from = (latest.value?.at ?? Date.now()) - minutes * 60_000;
  return h.filter((p) => p.t >= from).map((p) => p[key]);
};
const peak = (vals: number[]) => (vals.length ? Math.max(...vals) : 0);
/** Left edge of the detail chart: how old its first point is (the history may be shorter than the range). */
const since = (id: string) => {
  const h = points(id);
  if (!h.length || !latest.value) return '';
  const span = range.value === '1h' ? HOUR : range.value === '6h' ? 6 * HOUR : 24 * HOUR;
  const s = Math.round((latest.value.at - Math.max(h[0].t, latest.value.at - span)) / 1000);
  return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${(s / 3600).toFixed(1)} h ago`;
};

// ---- system cards
const sys = computed(() => latest.value?.system ?? null);
const total = computed(() => latest.value?.total ?? null);
const cores = computed(() => sys.value?.cores || 1);
/** DevCatz's share on the same 0–100 scale as the Mac's CPU (process % is per core). */
const ownCpu = computed(() => (total.value?.cpu ?? 0) / cores.value);
const memPct = computed(() => (sys.value?.memTotal ? (sys.value.memUsed / sys.value.memTotal) * 100 : 0));
const diskUsedPct = computed(() => (sys.value?.diskTotal ? ((sys.value.diskTotal - sys.value.diskFree) / sys.value.diskTotal) * 100 : 0));
const dataOnDisk = computed(() => (latest.value?.entities ?? []).reduce((n, e) => n + (e.disk ?? 0), 0));
const binariesOnDisk = computed(() => (latest.value?.entities ?? []).reduce((n, e) => n + (e.binaries ?? 0), 0));

// ---- table
type Filter = 'all' | 'site' | 'services' | 'container' | 'devcatz';
const filter = ref<Filter>('all');
const showStopped = ref(false);
type SortKey = 'name' | 'cpu' | 'mem' | 'net' | 'io' | 'disk';
const sortKey = ref<SortKey>('cpu');
const SERVICES: MonitorKind[] = ['php', 'database', 'storage', 'websocket', 'search'];
const rows = computed(() => {
  void tick.value;
  let list = latest.value?.entities ?? [];
  if (filter.value === 'site') list = list.filter((e) => e.kind === 'site');
  else if (filter.value === 'services') list = list.filter((e) => SERVICES.includes(e.kind));
  else if (filter.value === 'container') list = list.filter((e) => e.kind === 'container');
  else if (filter.value === 'devcatz') list = list.filter((e) => e.kind === 'devcatz');
  if (!showStopped.value) list = list.filter((e) => e.active);
  const by: Record<SortKey, (e: MonitorEntity) => number | string> = {
    name: (e) => e.name.toLowerCase(),
    cpu: (e) => -e.cpu,
    mem: (e) => -e.mem,
    net: (e) => -(e.netIn + e.netOut),
    io: (e) => -(e.diskRead + e.diskWrite),
    disk: (e) => -((e.disk ?? 0) + (e.binaries ?? 0)),
  };
  const f = by[sortKey.value];
  return [...list].sort((a, b) => {
    const x = f(a);
    const y = f(b);
    return x < y ? -1 : x > y ? 1 : a.name.localeCompare(b.name);
  });
});
const counts = computed(() => {
  const l = latest.value?.entities ?? [];
  const on = (k: (e: MonitorEntity) => boolean) => l.filter((e) => k(e) && (showStopped.value || e.active)).length;
  return {
    all: on(() => true),
    site: on((e) => e.kind === 'site'),
    services: on((e) => SERVICES.includes(e.kind)),
    container: on((e) => e.kind === 'container'),
    devcatz: on((e) => e.kind === 'devcatz'),
  };
});
const expanded = ref<string | null>(null);

const KIND_LABEL: Record<MonitorKind, string> = {
  site: 'Site',
  php: words.phpServer,
  database: 'Database',
  storage: 'Storage',
  websocket: 'WebSocket',
  search: 'Search',
  whatsapp: 'WhatsApp',
  gateway: 'Gateway',
  container: 'Container',
  devcatz: 'DevCatz',
};
const KIND_COLOR: Record<MonitorKind, string> = {
  site: 'var(--c-projects)',
  php: 'oklch(62% 0.13 275)',
  database: 'var(--c-database)',
  storage: 'var(--c-storage)',
  websocket: 'var(--c-websocket)',
  search: 'var(--c-search)',
  whatsapp: 'var(--c-whatsapp)',
  gateway: 'var(--c-whatsapp)',
  container: 'oklch(65% 0.13 240)',
  devcatz: 'var(--c-monitoring)',
};
/** Every service with an official mark shows it (databases, storage, search, WebSocket, WhatsApp, gateways, DevCatz). */
const logoOf = (e: MonitorEntity) => monitorLogo(e, state.value?.databases ?? []);

const minutesShown = 10;
</script>

<template>
  <section class="flex min-w-0 flex-1 flex-col bg-base-100">
    <!-- No page header (like Projects); the top strip moves the window and holds back / forward. -->
    <div class="drag title-strip h-11 shrink-0"><span class="nav-hole" aria-hidden="true" /></div>
    <div class="flex-1 space-y-5 overflow-y-auto px-6 pb-6">
      <div class="flex flex-wrap items-center gap-2">
        <span class="label-caps">This Mac</span>
        <span class="badge badge-soft badge-sm badge-success gap-1">
          <span class="status status-success status-xs animate-pulse" />Live · every {{ latest?.interval ?? '…' }} s
        </span>
        <span class="flex-1" />
        <span v-if="total" class="text-xs opacity-60">
          Everything DevCatz runs: <b class="font-mono" :title="`${pct(total.cpu)} of one core = ${pct(total.cpu / cores)} of this Mac's ${cores} cores`">{{ pct(total.cpu / cores) }}</b> of this Mac's CPU
          <span class="opacity-70">({{ pct(total.cpu) }} of one core)</span> · <b class="font-mono">{{ bytes(total.mem) }}</b> memory
        </span>
      </div>

      <!-- Mac overview -->
      <div v-if="sys" class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="card">
          <div class="card-body gap-1 p-4">
            <span class="label-caps">CPU</span>
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-2xl font-semibold tabular-nums">{{ pct(sys.cpu) }}</span>
              <span class="text-xs opacity-60">{{ sys.cores }} cores · load {{ sys.load[0].toFixed(2) }}</span>
            </div>
            <Sparkline :values="series('system', 'cpu')" :values2="series('total', 'cpu').map((v) => v / cores)" :max="100" color="var(--c-projects)" color2="var(--c-monitoring)" :height="40" />
            <span class="text-xs opacity-60"><span style="color: var(--c-monitoring)">- -</span> DevCatz {{ pct(ownCpu) }} of it</span>
          </div>
        </div>
        <div class="card">
          <div class="card-body gap-1 p-4">
            <div class="flex items-center gap-2">
              <span class="label-caps">Memory</span>
              <span
                v-if="sys.memPressure"
                class="badge badge-soft badge-xs"
                :class="sys.memPressure === 'normal' ? 'badge-success' : sys.memPressure === 'warn' ? 'badge-warning' : 'badge-error'"
                :title="`${words.os} memory pressure`"
              >
                {{ sys.memPressure }}
              </span>
            </div>
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-2xl font-semibold tabular-nums">{{ bytes(sys.memUsed) }}</span>
              <span class="text-xs opacity-60">of {{ bytes(sys.memTotal, 0) }} · {{ Math.round(memPct) }}%</span>
            </div>
            <Sparkline :values="series('system', 'mem')" :values2="series('total', 'mem')" :max="sys.memTotal" color="var(--c-database)" color2="var(--c-monitoring)" :height="40" />
            <span class="text-xs opacity-60">
              <span style="color: var(--c-monitoring)">- -</span> DevCatz {{ bytes(total?.mem ?? 0) }}<template v-if="sys.swapUsed"> · swap {{ bytes(sys.swapUsed) }}</template>
            </span>
          </div>
        </div>
        <div class="card">
          <div class="card-body gap-1 p-4">
            <span class="label-caps">Disk</span>
            <div class="flex items-baseline gap-2">
              <span class="font-mono text-2xl font-semibold tabular-nums">{{ bytes(sys.diskFree) }}</span>
              <span class="text-xs opacity-60">free of {{ bytes(sys.diskTotal, 0) }}</span>
            </div>
            <progress class="progress my-3 w-full" :class="diskUsedPct > 90 ? 'progress-error' : diskUsedPct > 75 ? 'progress-warning' : 'progress-success'" :value="diskUsedPct" max="100" />
            <span class="text-xs opacity-60">Data of DevCatz’s services: {{ bytes(dataOnDisk) }}<template v-if="binariesOnDisk"> · installed builds: {{ bytes(binariesOnDisk) }}</template></span>
          </div>
        </div>
        <div class="card">
          <div class="card-body gap-1 p-4">
            <span class="label-caps">Network</span>
            <div class="flex items-baseline gap-3 font-mono tabular-nums">
              <span class="text-lg font-semibold" title="In">↓ {{ rate(sys.netIn) }}</span>
              <span class="text-sm opacity-70" title="Out">↑ {{ rate(sys.netOut) }}</span>
            </div>
            <Sparkline :values="series('system', 'netIn')" :values2="series('system', 'netOut')" :floor="10240" color="var(--c-storage)" color2="var(--c-websocket)" :height="40" />
            <span class="text-xs opacity-60">All apps on this Mac · <span style="color: var(--c-websocket)">- -</span> out</span>
          </div>
        </div>
      </div>
      <div v-else class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Measuring…</div>

      <!-- Sites and services -->
      <div class="flex flex-wrap items-center gap-2">
        <div role="tablist" class="seg">
          <a
            v-for="f in [
              { id: 'all', label: 'All' },
              { id: 'site', label: 'Sites' },
              { id: 'services', label: 'Services' },
              { id: 'container', label: 'Containers' },
              { id: 'devcatz', label: 'DevCatz' },
            ] as { id: Filter; label: string }[]"
            :key="f.id"
            role="tab"
            class="seg-item"
            :class="{ 'is-active': filter === f.id }"
            @click="filter = f.id"
          >
            {{ f.label }} <span class="ml-1 text-[10px] opacity-60">{{ counts[f.id] }}</span>
          </a>
        </div>
        <label class="flex cursor-pointer items-center gap-2 text-xs">
          <input v-model="showStopped" type="checkbox" class="toggle toggle-xs toggle-primary" />Show stopped
        </label>
        <span class="flex-1" />
        <span class="text-xs opacity-50">Charts: last {{ minutesShown }} min · click a row for more</span>
        <div class="dropdown dropdown-end">
          <div tabindex="0" role="button" class="btn btn-xs">Export CSV</div>
          <ul tabindex="0" class="dropdown-content menu z-10 mt-1 w-60 rounded-box whitespace-nowrap bg-base-100 p-1 shadow">
            <li><a @click="exportCsv('1h')">Last hour (every sample)</a></li>
            <li><a @click="exportCsv('6h')">Last 6 hours (per minute)</a></li>
            <li><a @click="exportCsv('24h')">Last 24 hours (per minute)</a></li>
          </ul>
        </div>
      </div>

      <div class="overflow-x-auto rounded-box border border-base-300/60">
        <table class="table table-sm">
          <thead>
            <tr class="select-none">
              <th class="cursor-pointer" @click="sortKey = 'name'">Name {{ sortKey === 'name' ? '↑' : '' }}</th>
              <th class="w-44 cursor-pointer" title="Per core, like Activity Monitor: 100% = one core busy (this Mac has more), so a row can go above 100%" @click="sortKey = 'cpu'">CPU <span class="normal-case opacity-60">(of one core)</span> {{ sortKey === 'cpu' ? '↓' : '' }}</th>
              <th class="w-44 cursor-pointer" @click="sortKey = 'mem'">Memory {{ sortKey === 'mem' ? '↓' : '' }}</th>
              <th class="cursor-pointer whitespace-nowrap" @click="sortKey = 'net'">Network ↓ / ↑ {{ sortKey === 'net' ? '↓' : '' }}</th>
              <th class="cursor-pointer whitespace-nowrap" @click="sortKey = 'io'">Disk I/O R / W {{ sortKey === 'io' ? '↓' : '' }}</th>
              <th class="cursor-pointer whitespace-nowrap text-right" @click="sortKey = 'disk'">On disk {{ sortKey === 'disk' ? '↓' : '' }}</th>
            </tr>
          </thead>
          <tbody>
            <template v-for="e in rows" :key="e.id">
              <tr class="cursor-pointer hover:bg-base-200/50" :class="{ 'opacity-50': !e.active, 'bg-base-200/60': expanded === e.id }" @click="expanded = expanded === e.id ? null : e.id">
                <td class="max-w-0 min-w-56">
                  <div class="flex items-center gap-2">
                    <img v-if="logoOf(e)" :src="logoOf(e)!" alt="" class="size-5 shrink-0 rounded bg-white object-contain p-px" draggable="false" />
                    <span v-else class="size-2.5 shrink-0 rounded-full" :style="{ background: KIND_COLOR[e.kind] }" />
                    <div class="min-w-0">
                      <div class="flex items-center gap-1.5">
                        <span class="truncate font-medium">{{ e.name }}</span>
                        <span class="badge badge-ghost badge-xs shrink-0">{{ KIND_LABEL[e.kind] }}</span>
                      </div>
                      <div class="truncate text-[11px] opacity-55">{{ e.detail }}<template v-if="e.active"> · {{ e.processes }} process{{ e.processes === 1 ? '' : 'es' }}</template><template v-if="e.ports.length"> · :{{ e.ports.join(', :') }}</template><template v-if="e.connections"> · {{ e.connections }} conn</template></div>
                    </div>
                  </div>
                </td>
                <td>
                  <div class="font-mono text-xs tabular-nums">{{ pct(e.cpu) }}</div>
                  <Sparkline :values="series(e.id, 'cpu')" :floor="5" color="var(--c-projects)" :height="18" />
                </td>
                <td>
                  <div class="font-mono text-xs tabular-nums">{{ bytes(e.mem) }}</div>
                  <Sparkline :values="series(e.id, 'mem')" color="var(--c-database)" :height="18" />
                </td>
                <td class="font-mono text-xs whitespace-nowrap tabular-nums">{{ rate(e.netIn) }} <span class="opacity-50">/</span> {{ rate(e.netOut) }}</td>
                <td class="font-mono text-xs whitespace-nowrap tabular-nums">
                  <template v-if="latest?.capabilities.blockIo || e.kind === 'container'">{{ rate(e.diskRead) }} <span class="opacity-50">/</span> {{ rate(e.diskWrite) }}</template>
                  <span v-else class="opacity-40" :title="latest?.capabilities.blockIoHint ?? ''">—</span>
                </td>
                <td class="text-right font-mono text-xs whitespace-nowrap tabular-nums">
                  <div>{{ e.disk === null ? '—' : bytes(e.disk) }}</div>
                  <div v-if="e.binaries !== null" class="text-[10px] opacity-55" title="The installed build (binaries), apart from its data">+ {{ bytes(e.binaries) }} installed</div>
                </td>
              </tr>
              <!-- Detail: the hour -->
              <tr v-if="expanded === e.id" class="bg-base-200/30">
                <td colspan="6">
                  <div class="grid gap-4 py-2 sm:grid-cols-2 xl:grid-cols-4">
                    <div v-for="m in [
                      { key: 'cpu', label: 'CPU', color: 'var(--c-projects)', fmt: pct, floor: 5 },
                      { key: 'mem', label: 'Memory', color: 'var(--c-database)', fmt: bytes, floor: 0 },
                      { key: 'netIn', key2: 'netOut', label: 'Network in / out', color: 'var(--c-storage)', fmt: rate, floor: 1024 },
                      { key: 'diskRead', key2: 'diskWrite', label: 'Disk read / write', color: 'var(--c-search)', fmt: rate, floor: 1024 },
                    ] as { key: 'cpu' | 'mem' | 'netIn' | 'diskRead'; key2?: 'netOut' | 'diskWrite'; label: string; color: string; fmt: (n: number) => string; floor: number }[]" :key="m.key">
                      <div class="flex items-baseline justify-between text-xs">
                        <span class="label-caps">{{ m.label }}</span>
                        <span class="font-mono opacity-60">peak {{ m.fmt(peak(detail(e.id, m.key))) }}</span>
                      </div>
                      <Sparkline :values="detail(e.id, m.key)" :values2="m.key2 ? detail(e.id, m.key2) : undefined" :floor="m.floor" :color="m.color" color2="var(--c-websocket)" :height="56" />
                      <div class="flex justify-between text-[10px] opacity-50"><span>{{ since(e.id) }}</span><span>now</span></div>
                    </div>
                  </div>
                  <div class="flex items-center gap-2 pb-1 text-xs">
                    <div role="tablist" class="seg" @click.stop>
                      <a v-for="r in ['1h', '6h', '24h'] as MonitorRange[]" :key="r" role="tab" class="seg-item" :class="{ 'is-active': range === r }" @click="setRange(r)">{{ r }}</a>
                    </div>
                    <span class="opacity-60">
                      {{ points(e.id).length }} {{ range === '1h' ? 'samples' : 'minutes' }} · {{ e.processes }} process{{ e.processes === 1 ? '' : 'es' }}
                      <template v-if="e.ports.length"> · listening on {{ e.ports.join(', ') }}</template>
                      <template v-if="e.active"> · {{ e.connections }} open connection{{ e.connections === 1 ? '' : 's' }}</template>
                    </span>
                    <span class="flex-1" />
                    <button v-if="e.link" class="btn btn-xs" @click.stop="emit('open', e.link)">Open {{ e.link.section === 'projects' ? 'site' : e.link.section }}</button>
                  </div>
                </td>
              </tr>
            </template>
            <tr v-if="!rows.length">
              <td colspan="6" class="py-6 text-center text-xs opacity-60">
                {{ filter === 'container' && !latest?.capabilities.docker ? 'Docker / OrbStack is not running.' : 'Nothing running here. Tick “Show stopped” to see everything.' }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <p class="text-xs opacity-60">
        CPU is per core (100% = one core busy); memory is each process tree’s footprint, like Activity Monitor. {{ words.phpServer }} pools are shared by the PHP sites listed
        under them.
        <template v-if="latest?.capabilities.blockIoHint"><br /><span class="text-warning">{{ latest.capabilities.blockIoHint }}</span></template>
        <br />Alerts and the sampling rate: Settings → Monitoring.
      </p>

      <!-- Free up space: dependency folders of old projects (TODO §30), at the bottom of the page -->
      <DepsCleanup />
    </div>
  </section>
</template>
