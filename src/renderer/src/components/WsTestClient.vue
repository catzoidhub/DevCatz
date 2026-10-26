<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { WsState } from '@shared/types';
import { attempt, herd, notify, state } from '../store';

/**
 * A test client for one WebSocket server, speaking its protocol from the
 * renderer: Pusher (subscribe, private/presence auth signed by DevCatz,
 * client events), Centrifugo (connect token, subscribe, publish), Mercure
 * (EventSource on topics) and NATS (SUB / PUB over WebSocket). The publish
 * box goes through the server's HTTP API instead (what a backend does).
 */
const props = defineProps<{ service: WsState }>();

type Dir = 'in' | 'out' | 'sys' | 'err';
interface Ev {
  id: number;
  t: number;
  dir: Dir;
  channel: string;
  event: string;
  data: string;
}
const events = ref<Ev[]>([]);
let seq = 0;
const max = computed(() => state.value?.settings.wsTestEvents || 200);
function log(dir: Dir, channel: string, event: string, data: unknown) {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  events.value.unshift({ id: ++seq, t: Date.now(), dir, channel, event, data: text });
  if (events.value.length > max.value) events.value.length = max.value;
}

const viaProxy = ref(state.value?.cert.caTrusted !== false);
const url = computed(() => (viaProxy.value ? props.service.urls?.ws : props.service.urls?.wsLocal) ?? '');
const status = ref<'idle' | 'connecting' | 'open' | 'closed'>('idle');
const socketId = ref('');
const subscribed = ref<string[]>([]);
const channel = ref(props.service.protocol === 'pusher' ? 'test-channel' : props.service.protocol === 'mercure' ? 'https://example.com/books/1' : 'news');
const message = ref('{"hello": "from DevCatz"}');
const eventName = ref(props.service.protocol === 'pusher' ? 'client-test' : '');

let ws: WebSocket | null = null;
let es: EventSource | null = null;
let cmdId = 0;
const nats = { sid: 0, bySubject: new Map<string, number>() };

function close() {
  ws?.close();
  es?.close();
  ws = null;
  es = null;
  status.value = 'closed';
  subscribed.value = [];
  socketId.value = '';
}
onBeforeUnmount(close);
watch(() => props.service.kind, close);

function send(obj: unknown, show = true) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  ws.send(text);
  if (show) log('out', '', '', text.trim());
}

async function connect() {
  close();
  status.value = 'connecting';
  const p = props.service.protocol;
  if (p === 'mercure') {
    // Mercure: no socket until there is a topic; subscribing (re)opens the EventSource.
    status.value = 'open';
    log('sys', '', 'ready', 'Subscribe to a topic to open the EventSource');
    return;
  }
  const target = p === 'pusher' ? `${url.value}?protocol=7&client=devcatz&version=1.0` : url.value;
  log('sys', '', 'connecting', target);
  ws = new WebSocket(target);
  ws.binaryType = 'arraybuffer';
  ws.onopen = async () => {
    status.value = 'open';
    log('sys', '', 'open', target);
    if (p === 'centrifugo') {
      const token = await herd.wsClientAuth(props.service.kind, '', '');
      send({ id: ++cmdId, connect: { token, name: 'devcatz' } });
    } else if (p === 'nats') {
      const token = props.service.config?.key;
      send(`CONNECT ${JSON.stringify({ verbose: false, pedantic: false, lang: 'devcatz', version: '1', ...(token ? { auth_token: token } : {}) })}\r\nPING\r\n`);
    }
  };
  ws.onclose = (e) => {
    status.value = 'closed';
    log('sys', '', 'closed', `code ${e.code}${e.reason ? ` · ${e.reason}` : ''}`);
  };
  ws.onerror = () => log('err', '', 'error', `Could not connect to ${target}${viaProxy.value ? ' (is DevCatz’s certificate trusted? try 127.0.0.1)' : ''}`);
  ws.onmessage = (e) => {
    const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
    if (p === 'pusher') onPusher(text);
    else if (p === 'centrifugo') for (const line of text.split('\n').filter(Boolean)) onCentrifugo(line);
    else onNats(text);
  };
}

// ---- Pusher
function onPusher(text: string) {
  let m: { event: string; channel?: string; data?: unknown };
  try {
    m = JSON.parse(text);
  } catch {
    return log('in', '', '', text);
  }
  if (m.event === 'pusher:ping') return send({ event: 'pusher:pong', data: {} }, false);
  if (m.event === 'pusher:connection_established') {
    const d = typeof m.data === 'string' ? JSON.parse(m.data) : m.data;
    socketId.value = (d as { socket_id: string }).socket_id;
  }
  if (m.event === 'pusher_internal:subscription_succeeded' && m.channel && !subscribed.value.includes(m.channel)) subscribed.value.push(m.channel);
  log(m.event.startsWith('pusher') ? 'sys' : 'in', m.channel ?? '', m.event, m.data ?? '');
}

// ---- Centrifugo
function onCentrifugo(line: string) {
  if (line === '{}') return send('{}', false); // ping → pong
  let m: { id?: number; connect?: { client: string }; push?: { channel: string; pub?: { data: unknown }; join?: unknown; leave?: unknown }; error?: { message: string }; subscribe?: unknown };
  try {
    m = JSON.parse(line);
  } catch {
    return log('in', '', '', line);
  }
  if (m.error) return log('err', '', 'error', m.error.message);
  if (m.connect) {
    socketId.value = m.connect.client;
    return log('sys', '', 'connected', `client ${m.connect.client}`);
  }
  if (m.push?.pub) return log('in', m.push.channel, 'publication', m.push.pub.data);
  if (m.push?.join) return log('sys', m.push.channel, 'join', m.push.join);
  if (m.push?.leave) return log('sys', m.push.channel, 'leave', m.push.leave);
  log('sys', '', 'reply', line);
}

// ---- NATS
function onNats(text: string) {
  let rest = text;
  while (rest.length) {
    const nl = rest.indexOf('\r\n');
    if (nl < 0) break;
    const head = rest.slice(0, nl);
    rest = rest.slice(nl + 2);
    if (head === 'PING') send('PONG\r\n', false);
    else if (head === 'PONG' || head === '+OK') continue;
    else if (head.startsWith('INFO')) log('sys', '', 'info', head.slice(5));
    else if (head.startsWith('-ERR')) log('err', '', 'error', head.slice(5));
    else if (head.startsWith('MSG')) {
      const [, subject, , ...more] = head.split(' ');
      const len = Number(more[more.length - 1]);
      log('in', subject, 'message', rest.slice(0, len));
      rest = rest.slice(len + 2);
    }
  }
}

// ---- Mercure
function openMercure() {
  es?.close();
  if (!subscribed.value.length || !props.service.urls) return;
  const base = viaProxy.value ? props.service.urls.ws : props.service.urls.wsLocal;
  const u = new URL(base);
  for (const t of subscribed.value) u.searchParams.append('topic', t);
  es = new EventSource(u.toString());
  es.onopen = () => log('sys', '', 'open', u.toString());
  es.onerror = () => log('err', '', 'error', 'EventSource error (reconnecting)');
  es.onmessage = (e) => log('in', '', e.type, e.data);
  for (const t of mercureTypes) listenType(t);
}
/** Typed Mercure updates (`type` when publishing) arrive as named SSE events. */
const mercureTypes = new Set<string>();
function listenType(t: string) {
  es?.addEventListener(t, (e) => log('in', '', t, (e as MessageEvent).data));
}

async function subscribe() {
  const ch = channel.value.trim();
  if (!ch) return;
  const p = props.service.protocol;
  if (p === 'pusher') {
    let auth: { auth?: string; channel_data?: string } = {};
    if (ch.startsWith('private-') || ch.startsWith('presence-')) {
      const r = await attempt(() => herd.wsClientAuth(props.service.kind, socketId.value, ch));
      if (!r) return;
      auth = JSON.parse(r);
    }
    send({ event: 'pusher:subscribe', data: { channel: ch, ...auth } });
  } else if (p === 'centrifugo') {
    send({ id: ++cmdId, subscribe: { channel: ch } });
    if (!subscribed.value.includes(ch)) subscribed.value.push(ch);
  } else if (p === 'nats') {
    const sid = ++nats.sid;
    nats.bySubject.set(ch, sid);
    send(`SUB ${ch} ${sid}\r\n`);
    if (!subscribed.value.includes(ch)) subscribed.value.push(ch);
  } else {
    if (!subscribed.value.includes(ch)) subscribed.value.push(ch);
    openMercure();
  }
}
function unsubscribe(ch: string) {
  const p = props.service.protocol;
  if (p === 'pusher') send({ event: 'pusher:unsubscribe', data: { channel: ch } });
  else if (p === 'centrifugo') send({ id: ++cmdId, unsubscribe: { channel: ch } });
  else if (p === 'nats') send(`UNSUB ${nats.bySubject.get(ch)}\r\n`);
  subscribed.value = subscribed.value.filter((c) => c !== ch);
  if (p === 'mercure') openMercure();
}

/** Sends from the client itself (Pusher client events need a private/presence channel). */
function sendFromClient() {
  const ch = channel.value.trim();
  const p = props.service.protocol;
  let data: unknown = message.value;
  try {
    data = JSON.parse(message.value);
  } catch {
    /* text */
  }
  if (p === 'pusher') {
    if (!/^(private|presence)-/.test(ch)) return notify('info', 'Pusher client events need a private- or presence- channel (and client messages enabled). Use Publish via the API instead.');
    send({ event: eventName.value.startsWith('client-') ? eventName.value : `client-${eventName.value}`, channel: ch, data });
  } else if (p === 'centrifugo') send({ id: ++cmdId, publish: { channel: ch, data: typeof data === 'object' ? data : { text: data } } });
  else if (p === 'nats') {
    const payload = new TextEncoder().encode(message.value);
    send(`PUB ${ch} ${payload.length}\r\n${message.value}\r\n`);
  } else notify('info', 'Mercure clients only subscribe; publish through the API.');
}
async function publishApi() {
  const type = eventName.value.trim();
  if (props.service.protocol === 'mercure' && type && !mercureTypes.has(type)) {
    mercureTypes.add(type);
    listenType(type);
  }
  const ok = await attempt(() => herd.wsPublish(props.service.kind, channel.value.trim(), eventName.value.trim(), message.value).then(() => true));
  if (ok) log('out', channel.value.trim(), `${eventName.value || 'publish'} (API)`, message.value);
}

const filter = ref('');
const shown = computed(() => {
  const q = filter.value.trim().toLowerCase();
  return q ? events.value.filter((e) => `${e.channel} ${e.event} ${e.data}`.toLowerCase().includes(q)) : events.value;
});
const time = (t: number) => new Date(t).toLocaleTimeString('en-GB', { hour12: false }) + '.' + String(t % 1000).padStart(3, '0');
const DIR: Record<Dir, string> = { in: '↓', out: '↑', sys: '•', err: '!' };
const placeholder = computed(() =>
  ({ pusher: 'private-orders.1 / presence-room', centrifugo: 'news', mercure: 'https://example.com/books/1', nats: 'orders.created' })[props.service.protocol],
);
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-2">
      <div class="seg">
        <a class="seg-item normal-case" :class="{ 'is-active': viaProxy }" title="Through DevCatz's HTTPS proxy, like a browser on the site would" @click="viaProxy = true">wss:// domain</a>
        <a class="seg-item normal-case" :class="{ 'is-active': !viaProxy }" title="Straight to the port" @click="viaProxy = false">127.0.0.1</a>
      </div>
      <code class="min-w-0 flex-1 truncate text-xs opacity-70" :title="url">{{ url }}</code>
      <span class="badge badge-sm" :class="status === 'open' ? 'badge-success badge-soft' : status === 'connecting' ? 'badge-warning badge-soft' : 'badge-ghost'">{{ status }}</span>
      <button v-if="status !== 'open'" class="btn btn-primary btn-xs" :disabled="service.status !== 'running'" @click="connect">Connect</button>
      <button v-else class="btn btn-xs" @click="close">Disconnect</button>
    </div>
    <div v-if="socketId" class="text-xs opacity-60">{{ service.protocol === 'pusher' ? 'Socket ID' : 'Client' }}: <code class="selectable">{{ socketId }}</code></div>

    <div class="grid gap-2 sm:grid-cols-[1fr_auto]">
      <input v-model="channel" class="input input-sm w-full font-mono" :placeholder="placeholder" spellcheck="false" @keydown.enter="subscribe" />
      <button class="btn btn-sm" :disabled="status !== 'open'" @click="subscribe">{{ service.protocol === 'mercure' ? 'Subscribe to topic' : 'Subscribe' }}</button>
    </div>
    <div v-if="subscribed.length" class="flex flex-wrap gap-1">
      <span v-for="c in subscribed" :key="c" class="badge badge-primary badge-soft gap-1 font-mono">{{ c }}<button class="opacity-60 hover:opacity-100" title="Unsubscribe" @click="unsubscribe(c)">×</button></span>
    </div>

    <div class="grid gap-2 sm:grid-cols-[10rem_1fr]">
      <input v-if="service.protocol === 'pusher' || service.protocol === 'mercure'" v-model="eventName" class="input input-sm font-mono" :placeholder="service.protocol === 'pusher' ? 'event name' : 'type (optional)'" spellcheck="false" />
      <textarea v-model="message" rows="2" class="textarea textarea-sm w-full font-mono" :class="{ 'sm:col-span-2': !(service.protocol === 'pusher' || service.protocol === 'mercure') }" spellcheck="false" />
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <button v-if="service.protocol !== 'mercure'" class="btn btn-xs" :disabled="status !== 'open'" @click="sendFromClient">Send from this client</button>
      <button class="btn btn-primary btn-xs" :disabled="service.status !== 'running'" title="Through the server's HTTP API, as your backend would" @click="publishApi">Publish via API</button>
      <span class="flex-1" />
      <input v-model="filter" class="input input-xs w-44" placeholder="Filter events" />
      <button class="btn btn-ghost btn-xs" @click="events = []">Clear</button>
    </div>

    <div class="max-h-80 overflow-y-auto rounded-box border border-base-300/60 font-mono text-xs">
      <div v-for="e in shown" :key="e.id" class="flex gap-2 border-b border-base-300/40 px-2 py-1 last:border-0" :class="{ 'text-error': e.dir === 'err', 'opacity-60': e.dir === 'sys' }">
        <span class="shrink-0 opacity-50">{{ time(e.t) }}</span>
        <span class="w-3 shrink-0" :class="e.dir === 'in' ? 'text-success' : e.dir === 'out' ? 'text-info' : ''">{{ DIR[e.dir] }}</span>
        <span v-if="e.channel" class="shrink-0 text-primary">{{ e.channel }}</span>
        <span v-if="e.event" class="shrink-0 opacity-80">{{ e.event }}</span>
        <span class="selectable min-w-0 break-all">{{ e.data }}</span>
      </div>
      <div v-if="!shown.length" class="p-4 text-center font-sans opacity-50">{{ events.length ? 'No event matches.' : 'Connect, subscribe, then publish: events show up here.' }}</div>
    </div>
  </div>
</template>
