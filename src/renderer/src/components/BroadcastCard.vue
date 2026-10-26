<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { BroadcastEvent, LaravelBroadcastInfo, ProjectState } from '@shared/types';
import { attempt, herd, notify } from '../store';

/**
 * Laravel broadcasting of a site: health checks, the events that broadcast
 * and the channel routes, and a test broadcast sent through the app's own
 * broadcaster; for public channels DevCatz listens too and confirms delivery.
 */
const props = defineProps<{ project: ProjectState }>();
const info = ref<LaravelBroadcastInfo | null>(null);
const loading = ref(false);
async function load() {
  loading.value = true;
  info.value = (await attempt(() => herd.laravelBroadcast(props.project.id))) ?? null;
  loading.value = false;
}
onMounted(load);
// Re-check once the site (and Reverb with it) has started or stopped.
watch(
  () => [props.project.status, props.project.reverb],
  () => setTimeout(load, 1500),
);

type Kind = 'public' | 'private' | 'presence';
const kind = ref<Kind>('public');
const channel = ref('devcatz-test');
const eventName = ref('devcatz.test');
const payload = ref('{"message": "Hello from DevCatz"}');
const sending = ref(false);
const result = ref<{ ok: boolean; text: string } | null>(null);

/** An event row fills the form: its first channel ({…} → 1) and the name Echo listens for. */
function useEvent(e: BroadcastEvent) {
  const ch = e.channels[0];
  if (ch) {
    kind.value = ch.type;
    channel.value = ch.name.replace(/\{[^}]*\}/g, '1');
  }
  eventName.value = e.as ?? e.class;
  result.value = null;
}
const echoName = computed(() => (/[\\]/.test(eventName.value) ? eventName.value : `.${eventName.value}`));

/** Subscribes to a public channel on the app's server and waits for `event`. */
function listen(ch: string, event: string): { ready: Promise<boolean>; got: Promise<number | null>; close: () => void } {
  const l = info.value?.listen;
  if (!l) return { ready: Promise.resolve(false), got: Promise.resolve(null), close: () => undefined };
  const ws = new WebSocket(`${l.ws}/app/${l.key}?protocol=7&client=devcatz&version=1.0`);
  let t0 = 0;
  let readyRes: (v: boolean) => void = () => undefined;
  let gotRes: (v: number | null) => void = () => undefined;
  const ready = new Promise<boolean>((r) => (readyRes = r));
  const got = new Promise<number | null>((r) => (gotRes = r));
  ws.onopen = () => ws.send(JSON.stringify({ event: 'pusher:subscribe', data: { channel: ch } }));
  ws.onerror = () => (readyRes(false), gotRes(null));
  ws.onmessage = (e) => {
    const m = JSON.parse(String(e.data)) as { event: string; channel?: string };
    if (m.event === 'pusher_internal:subscription_succeeded') {
      t0 = performance.now();
      readyRes(true);
    } else if (m.channel === ch && m.event === event) gotRes(Math.round(performance.now() - t0));
  };
  setTimeout(() => (readyRes(false), gotRes(null)), 6000);
  return { ready, got, close: () => ws.close() };
}

async function send() {
  sending.value = true;
  result.value = null;
  const verify = kind.value === 'public' && info.value?.listen ? listen(channel.value.trim(), eventName.value.trim()) : null;
  if (verify) await verify.ready;
  try {
    const out = await herd.laravelTestBroadcast(props.project.id, kind.value, channel.value.trim(), eventName.value.trim(), payload.value);
    if (verify) {
      const ms = await verify.got;
      result.value = ms === null ? { ok: false, text: `${out}, but DevCatz’s listener on ${channel.value} got nothing in 6 s (wrong server / key?)` } : { ok: true, text: `${out} · received by a listener in ${ms} ms` };
    } else result.value = { ok: true, text: `${out}. Private/presence channels need a signed-in user: watch it in your app (Echo.${kind.value}('${channel.value}').listen('${echoName.value}', …)).` };
  } catch (e) {
    const text = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    result.value = { ok: false, text };
    notify('error', text);
  } finally {
    verify?.close();
    sending.value = false;
  }
}
const short = (cls: string) => cls.split('\\').pop();
</script>

<template>
  <div class="card">
    <div class="card-body gap-4">
      <div class="flex items-center gap-2">
        <h2 class="flex-1 font-semibold">Broadcasting</h2>
        <span v-if="info?.connection" class="badge badge-ghost badge-sm font-mono">{{ info.connection }}</span>
        <button class="btn btn-ghost btn-xs" :disabled="loading" @click="load"><span v-if="loading" class="loading loading-spinner loading-xs" />Re-check</button>
      </div>

      <template v-if="info">
        <!-- Health checks -->
        <ul class="space-y-1 text-sm">
          <li v-for="c in info.checks" :key="c.id" class="flex items-start gap-2">
            <span class="mt-0.5 w-4 shrink-0 text-center" :class="c.ok === true ? 'text-success' : c.ok === false ? 'text-error' : 'opacity-40'">{{ c.ok === true ? '✓' : c.ok === false ? '✕' : '–' }}</span>
            <span class="w-52 shrink-0">{{ c.label }}</span>
            <span class="min-w-0 text-xs opacity-70">{{ c.detail }}</span>
          </li>
        </ul>
        <div v-if="info.queueHint" class="alert alert-soft text-xs">
          Some events use ShouldBroadcast (queued): they are sent only while a queue worker runs. Turn on the queue worker in Settings, or use ShouldBroadcastNow.
        </div>

        <!-- Events -->
        <div>
          <span class="label-caps mb-1 block">Events that broadcast</span>
          <div v-if="info.events.length" class="overflow-x-auto rounded-box border border-base-300/60">
            <table class="table table-sm">
              <thead>
                <tr><th>Event</th><th>Channels</th><th>Echo listens for</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="e in info.events" :key="e.class" class="cursor-pointer hover:bg-base-200/50" title="Fill the test form" @click="useEvent(e)">
                  <td>
                    <div class="font-mono text-xs">{{ short(e.class) }}</div>
                    <div class="text-[11px] opacity-50">{{ e.file }}</div>
                  </td>
                  <td>
                    <div class="flex flex-wrap gap-1">
                      <span v-for="c in e.channels" :key="c.name" class="badge badge-xs font-mono" :class="c.type === 'public' ? 'badge-ghost' : 'badge-primary badge-soft'">{{ c.type === 'public' ? '' : `${c.type} ` }}{{ c.name }}</span>
                      <span v-if="!e.channels.length" class="text-xs opacity-50">dynamic</span>
                    </div>
                  </td>
                  <td class="font-mono text-xs">{{ e.as ? `.${e.as}` : short(e.class) }}</td>
                  <td><span class="badge badge-xs" :class="e.now ? 'badge-success badge-soft' : 'badge-ghost'">{{ e.now ? 'now' : 'queued' }}</span></td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-else class="text-xs opacity-60">No ShouldBroadcast events in app/ yet (<code>php artisan make:event</code>).</p>
        </div>
        <div v-if="info.channels.length">
          <span class="label-caps mb-1 block">Channel routes (routes/channels.php)</span>
          <div class="flex flex-wrap gap-1">
            <span v-for="c in info.channels" :key="c.name" class="badge badge-primary badge-soft badge-sm font-mono">{{ c.type }} {{ c.name }}</span>
          </div>
        </div>

        <!-- Test broadcast -->
        <div class="space-y-2 rounded-box border border-base-300/60 p-3">
          <div class="text-sm font-medium">Test broadcast</div>
          <div class="flex flex-wrap items-center gap-2">
            <div class="seg">
              <a v-for="k in ['public', 'private', 'presence'] as Kind[]" :key="k" class="seg-item" :class="{ 'is-active': kind === k }" @click="kind = k">{{ k }}</a>
            </div>
            <input v-model="channel" class="input input-sm w-48 font-mono" placeholder="channel" spellcheck="false" />
            <input v-model="eventName" class="input input-sm w-48 font-mono" placeholder="event name" spellcheck="false" />
          </div>
          <textarea v-model="payload" rows="2" class="textarea textarea-sm w-full font-mono" spellcheck="false" />
          <div class="flex flex-wrap items-center gap-2">
            <button class="btn btn-primary btn-sm" :disabled="sending || !channel.trim() || !eventName.trim()" @click="send">
              <span v-if="sending" class="loading loading-spinner loading-xs" />Send test broadcast
            </button>
            <span class="text-xs opacity-60">
              Through the app's own broadcaster (<code>Broadcast::{{ kind === 'public' ? 'on' : kind }}(…)->as(…)->sendNow()</code>); Echo:
              <code>.listen('{{ echoName }}', …)</code>
            </span>
          </div>
          <div v-if="result" class="text-xs" :class="result.ok ? 'text-success' : 'text-error'">{{ result.text }}</div>
        </div>
      </template>
      <div v-else-if="loading" class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Reading the app…</div>
    </div>
  </div>
</template>
