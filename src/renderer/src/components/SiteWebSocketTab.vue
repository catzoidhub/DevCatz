<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { ProjectState, RealtimeLib, WsKind } from '@shared/types';
import StatusDot from './StatusDot.vue';
import WsEnvWriter from './WsEnvWriter.vue';
import BroadcastCard from './BroadcastCard.vue';
import { attempt, herd, navRequest, state } from '../store';

/**
 * A site's WebSocket tab: the real-time libraries it uses; its own server
 * (Socket.IO, ws, Channels …) on the site's domain with a live connection
 * check; Laravel Reverb run with the site; or the DevCatz server its client
 * libraries talk to, with the .env lines.
 */
const props = defineProps<{ project: ProjectState; urlSuffix: string }>();
const p = computed(() => props.project);
const servers = computed(() => state.value?.websockets ?? []);
const rt = computed(() => p.value.realtime);
const serverLibs = computed(() => rt.value.libs.filter((l) => l.role === 'server' && l.protocol !== 'reverb'));
/** Client libraries that need a DevCatz server: Echo / pusher-js are Reverb's clients when the app has Reverb. */
const clientLibs = computed(() => rt.value.libs.filter((l) => l.role === 'client' && l.protocol !== 'socketio' && !(p.value.reverb && l.protocol === 'pusher')));
const reverbClients = computed(() => rt.value.libs.filter((l) => l.role === 'client' && l.protocol === 'pusher' && p.value.reverb).map((l) => l.name));
const laravel = computed(() => p.value.stack.apps.some((a) => a.framework === 'laravel'));
const running = computed(() => p.value.status === 'running' || (p.value.stack.runtime === 'php' && p.value.served));

// ---- the site's own server: connection check through the proxy
const socketio = computed(() => rt.value.libs.some((l) => l.protocol === 'socketio'));
const defaultPath = computed(() => (socketio.value ? '/socket.io/' : rt.value.libs.some((l) => l.protocol === 'channels') ? '/ws/' : '/'));
const path = ref(p.value.wsPath || defaultPath.value);
watch(defaultPath, (d) => !p.value.wsPath && (path.value = d));
const scheme = computed(() => (p.value.secure === false ? 'ws' : 'wss'));
const endpoint = computed(() => `${scheme.value}://${p.value.domain}${p.value.secure === false ? (state.value?.httpUrlSuffix ?? '') : props.urlSuffix}${path.value}`);
const probeUrl = computed(() => (socketio.value ? `${endpoint.value.replace(/\/?$/, '/')}?EIO=4&transport=websocket` : endpoint.value));
const check = ref<{ state: 'idle' | 'checking' | 'ok' | 'fail'; ms?: number; detail?: string }>({ state: 'idle' });

let probe: WebSocket | null = null;
function test() {
  probe?.close();
  check.value = { state: 'checking' };
  const t0 = performance.now();
  const ws = new WebSocket(probeUrl.value);
  probe = ws;
  const timer = setTimeout(() => {
    ws.close();
    check.value = { state: 'fail', detail: 'No answer in 5 s' };
  }, 5000);
  ws.onopen = () => {
    const ms = Math.round(performance.now() - t0);
    if (!socketio.value) {
      clearTimeout(timer);
      check.value = { state: 'ok', ms, detail: 'Upgrade accepted' };
      ws.close();
    } else check.value = { state: 'checking', ms };
  };
  ws.onmessage = (e) => {
    // Engine.IO open packet: 0{"sid":…}
    const text = String(e.data);
    if (text.startsWith('0')) {
      clearTimeout(timer);
      let sid = '';
      try {
        sid = (JSON.parse(text.slice(1)) as { sid: string }).sid;
      } catch {
        /* not JSON */
      }
      check.value = { state: 'ok', ms: Math.round(performance.now() - t0), detail: `Engine.IO handshake${sid ? ` · sid ${sid}` : ''}` };
      ws.close();
    }
  };
  ws.onerror = () => {
    clearTimeout(timer);
    check.value = { state: 'fail', detail: running.value ? `The upgrade on ${path.value} was refused (wrong path, or the server is not up yet)` : 'The site is not running: Start it first' };
  };
}
async function savePath() {
  await attempt(() => herd.updateProject(p.value.id, { wsPath: path.value === defaultPath.value ? '' : path.value }));
  test();
}
// Checked when the tab opens and whenever the site comes up.
onMounted(() => serverLibs.value.length && running.value && test());
watch(running, (r) => r && serverLibs.value.length && setTimeout(test, 1500));
onBeforeUnmount(() => probe?.close());

// ---- Laravel Reverb
async function toggleReverb(on: boolean) {
  await attempt(() => herd.updateProject(p.value.id, { reverb: on }));
  if (p.value.status === 'running') await attempt(() => herd.restart(p.value.id), on ? 'Reverb starts with the site' : 'Reverb stopped');
}
const reverbCheck = ref<'idle' | 'checking' | 'ok' | 'fail'>('idle');
function testReverb() {
  if (!p.value.reverbEndpoint) return;
  reverbCheck.value = 'checking';
  const ws = new WebSocket(`wss://${p.value.reverbEndpoint.domain}${props.urlSuffix}/app/devcatz-probe?protocol=7&client=js&version=8.4.0`);
  const timer = setTimeout(() => ((reverbCheck.value = 'fail'), ws.close()), 5000);
  ws.onopen = () => {
    clearTimeout(timer);
    reverbCheck.value = 'ok';
    ws.close();
  };
  ws.onerror = () => {
    clearTimeout(timer);
    reverbCheck.value = 'fail';
  };
}

// ---- a DevCatz server for the client libraries
const chosen = ref<WsKind | ''>(p.value.wsServer ?? rt.value.suggested ?? '');
const chosenServer = computed(() => servers.value.find((s) => s.kind === chosen.value) ?? null);
watch(chosen, (k) => k && k !== p.value.wsServer && void attempt(() => herd.updateProject(p.value.id, { wsServer: k })));
// Pusher clients fit both Pusher-protocol servers (Laravel apps: Reverb first).
const FITS: Record<string, WsKind[]> = { pusher: ['reverb', 'sockudo'], centrifugo: ['centrifugo'], mercure: ['mercure'], nats: ['nats'] };
const fits = (lib: RealtimeLib, k: WsKind) => FITS[lib.protocol]?.includes(k) ?? false;
function openServers() {
  navRequest.value = { section: 'websocket', id: chosen.value || rt.value.suggested || undefined };
}
const statusOf = (s: string) => (s === 'running' ? 'running' : s === 'starting' ? 'starting' : 'stopped') as 'running' | 'starting' | 'stopped';
</script>

<template>
  <section class="site-tab">
    <!-- Detected -->
    <div class="card">
      <div class="card-body">
        <h2 class="font-semibold">Real-time libraries</h2>
        <div v-if="rt.libs.length" class="flex flex-wrap gap-1.5">
          <span v-for="l in rt.libs" :key="l.name" class="badge gap-1" :class="l.role === 'server' ? 'badge-primary badge-soft' : 'badge-ghost'" :title="`Found in ${l.source}`">
            {{ l.name }}<span class="text-[10px] opacity-60">{{ l.role }}</span>
          </span>
        </div>
        <p v-else class="text-xs opacity-60">
          None found in this site's manifests. Add Socket.IO / ws (Node), Laravel Reverb or Echo, Django Channels, gorilla/websocket … and DevCatz picks it up.
        </p>
      </div>
    </div>

    <!-- The site's own WebSocket server -->
    <div v-if="serverLibs.length" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <StatusDot :status="check.state === 'ok' ? 'running' : check.state === 'checking' ? 'starting' : check.state === 'fail' ? 'crashed' : 'stopped'" />
          <h2 class="flex-1 font-semibold">{{ serverLibs.map((l) => l.name).join(' + ') }} on the site's domain</h2>
          <span v-if="check.state === 'ok'" class="badge badge-success badge-soft badge-sm">connected · {{ check.ms }} ms</span>
          <span v-else-if="check.state === 'fail'" class="badge badge-error badge-soft badge-sm">not reachable</span>
          <span v-else-if="check.state === 'checking'" class="loading loading-spinner loading-xs" />
        </div>
        <p class="text-xs opacity-70">
          The site's own server handles the WebSocket; DevCatz's proxy passes the upgrade on <code>{{ p.domain }}</code> (TLS at the proxy), so the browser uses the same
          origin as the page{{ socketio ? ': io() with no URL just works' : '' }}.
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <code class="selectable min-w-0 flex-1 truncate rounded-md bg-base-200/70 px-2 py-1 text-xs">{{ endpoint }}</code>
          <input v-model="path" class="input input-xs w-36 font-mono" title="Path of the WebSocket endpoint" spellcheck="false" @keydown.enter="savePath" />
          <button class="btn btn-xs" :disabled="check.state === 'checking'" @click="path !== (p.wsPath || defaultPath) ? savePath() : test()">Test connection</button>
        </div>
        <div v-if="check.detail" class="text-xs" :class="check.state === 'fail' ? 'text-error' : 'opacity-60'">{{ check.detail }}</div>
      </div>
    </div>

    <!-- Laravel Reverb -->
    <div v-if="laravel" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <StatusDot v-if="p.reverb" :status="p.status === 'running' ? 'running' : 'stopped'" />
          <h2 class="flex-1 font-semibold">Laravel Reverb</h2>
          <label class="flex cursor-pointer items-center gap-2 text-sm" :class="{ 'opacity-50': !rt.reverb && !p.reverb }">
            <input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="!!p.reverb" :disabled="!rt.reverb && !p.reverb" @change="toggleReverb(($event.target as HTMLInputElement).checked)" />
            Run with the site
          </label>
        </div>
        <p v-if="!rt.reverb" class="text-xs opacity-70">
          Not installed in this app: <code class="selectable">php artisan install:broadcasting</code> (Laravel 11+) adds Reverb and Echo. Or, with no package to run, point
          it at DevCatz’s shared Laravel Reverb (or Sockudo) below.
        </p>
        <template v-else-if="p.reverb && p.reverbEndpoint">
          <p class="text-xs opacity-70">
            Start runs <code>php artisan reverb:start</code> on 127.0.0.1:{{ p.reverbEndpoint.port }} next to Vite / queue. Laravel publishes to it directly
            (REVERB_HOST=127.0.0.1, no TLS); browsers{{ reverbClients.length ? ` (${reverbClients.join(', ')})` : '' }} connect to
            <code>wss://{{ p.reverbEndpoint.domain }}</code> (VITE_REVERB_*). Rebuild or restart Vite after writing .env.
          </p>
          <div class="flex items-center gap-2">
            <button class="btn btn-xs" :disabled="p.status !== 'running'" @click="testReverb">Test connection</button>
            <span v-if="reverbCheck === 'ok'" class="badge badge-success badge-soft badge-sm">connected</span>
            <span v-else-if="reverbCheck === 'fail'" class="badge badge-error badge-soft badge-sm">not reachable</span>
            <span v-else-if="reverbCheck === 'checking'" class="loading loading-spinner loading-xs" />
          </div>
          <WsEnvWriter :key="p.id + 'reverb'" source="site-reverb" :site-id="p.id" label="Reverb" />
        </template>
        <p v-else class="text-xs opacity-70">
          Turn it on: DevCatz gives this app's Reverb a port and <code>wss://reverb.{{ p.domain }}</code>, and writes REVERB_* into .env. Or leave it off and use DevCatz’s
          shared Laravel Reverb below (one server for every site).
        </p>
      </div>
    </div>

    <!-- Laravel: events, channels, checks, test broadcast -->
    <BroadcastCard v-if="laravel" :key="p.id + 'bc'" :project="p" />

    <!-- Client libraries → a DevCatz server -->
    <div v-if="clientLibs.length || p.wsServer || (laravel && !p.reverb)" class="card">
      <div class="card-body">
        <div class="flex flex-wrap items-center gap-2">
          <StatusDot v-if="chosenServer?.installed" :status="statusOf(chosenServer.status)" />
          <h2 class="flex-1 font-semibold">Server for {{ clientLibs.map((l) => l.name).join(', ') || 'this site' }}</h2>
          <select v-model="chosen" class="select select-xs w-44">
            <option value="" disabled>Choose a server…</option>
            <option v-for="s in servers" :key="s.kind" :value="s.kind">
              {{ s.name }}{{ s.installed ? '' : ' (not installed)' }}{{ clientLibs.some((l) => fits(l, s.kind)) ? ' ✓' : '' }}
            </option>
          </select>
        </div>
        <template v-if="chosenServer">
          <div v-if="!chosenServer.installed" class="flex items-center gap-2 text-sm">
            <span class="flex-1 opacity-70">{{ chosenServer.name }} is not installed yet.</span>
            <button class="btn btn-primary btn-xs" @click="openServers">Install on the WebSocket page</button>
          </div>
          <template v-else>
            <div class="flex flex-wrap items-center gap-2 text-xs">
              <code class="selectable rounded-md bg-base-200/70 px-2 py-1">{{ chosenServer.urls?.ws }}</code>
              <span class="opacity-60">{{ chosenServer.status }}</span>
              <span class="flex-1" />
              <button class="btn btn-ghost btn-xs" @click="openServers">Inspector &amp; test client</button>
            </div>
            <WsEnvWriter :key="p.id + chosenServer.kind" :source="chosenServer.kind" :site-id="p.id" :label="chosenServer.name" />
          </template>
        </template>
      </div>
    </div>
  </section>
</template>
