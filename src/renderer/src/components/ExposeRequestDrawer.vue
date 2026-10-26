<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { AiWebhookAnswer, ExposeRequest } from '@shared/types';
import { herd, notify } from '../store';
import AiBox from './AiBox.vue';
import { aiOn } from '../ai';

/**
 * One request of a share, in a panel that slides in from the right: status,
 * method and path, timing, then Request / Response tabs with headers and the
 * body (JSON pretty-printed). Replay sends it to the site again.
 */
const props = defineProps<{ request: ExposeRequest; canReplay: boolean; shareId?: string }>();
// ✦ AI tab: who sent this request and a handler for the site's framework (Settings → AI).
const aiWebhookOn = aiOn('webhook');
const aiReq = (prompt: string) => ({ shareId: props.shareId!, requestId: props.request.id, prompt });
const aiRun = (prompt: string, token: string) => herd.aiWebhook(aiReq(prompt), token);
const aiPreview = (prompt: string) => herd.aiPreviewWebhook(aiReq(prompt));
const emit = defineEmits<{ close: []; replay: [r: ExposeRequest] }>();

const tab = ref<'request' | 'response' | 'ai'>('request');
const r = computed(() => props.request);
const METHOD: Record<string, string> = { GET: 'badge-info', POST: 'badge-success', PUT: 'badge-warning', PATCH: 'badge-warning', DELETE: 'badge-error' };
const statusClass = (s: number | null) => (s === null ? 'badge-ghost' : s < 300 ? 'badge-success' : s < 400 ? 'badge-info' : s < 500 ? 'badge-warning' : 'badge-error');
const STATUS_TEXT: Record<number, string> = { 101: 'Switching Protocols', 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 405: 'Method Not Allowed', 419: 'Page Expired', 422: 'Unprocessable', 429: 'Too Many Requests', 500: 'Server Error', 502: 'Bad Gateway', 503: 'Unavailable' };

/** JSON bodies pretty-printed; everything else as is. */
const pretty = (text: string | null, type: string | undefined) => {
  if (!text) return '';
  if (!/json/i.test(type ?? '') && !/^\s*[[{]/.test(text)) return text;
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};
const reqBody = computed(() => pretty(r.value.requestBody, r.value.requestHeaders['content-type']));
const resBody = computed(() => pretty(r.value.responseBody, r.value.responseHeaders['content-type']));
const headers = (h: Record<string, string>) => Object.entries(h).sort(([a], [b]) => a.localeCompare(b));
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const size = (h: Record<string, string>, body: string | null) => {
  const n = Number(h['content-length']);
  if (Number.isFinite(n) && n > 0) return n;
  return body ? new TextEncoder().encode(body).length : 0;
};
const kb = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

async function copy(text: string, what: string) {
  await navigator.clipboard.writeText(text).catch(() => undefined);
  notify('info', `${what} copied`);
}
/** The request as a curl command against the public URL (headers that the tunnel adds are left out). */
function asCurl() {
  const skip = /^(host|content-length|cf-|cdn-loop|x-forwarded-|connection|accept-encoding|x-devcatz)/i;
  const lines = [`curl -X ${r.value.method} '${location.origin.replace(/^file:\/\/$/, '')}${r.value.path}'`];
  for (const [k, v] of headers(r.value.requestHeaders)) if (!skip.test(k)) lines.push(`  -H '${k}: ${v.replace(/'/g, "'\\''")}'`);
  if (r.value.requestBody && !r.value.requestBody.startsWith('(')) lines.push(`  --data-raw '${r.value.requestBody.replace(/'/g, "'\\''")}'`);
  return lines.join(' \\\n');
}
function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => document.addEventListener('keydown', onKey));
onBeforeUnmount(() => document.removeEventListener('keydown', onKey));
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-40 bg-black/30 backdrop-blur-[1px]" @click="emit('close')" />
    <aside class="no-drag fixed top-0 right-0 bottom-0 z-50 flex w-[38rem] max-w-[92vw] flex-col border-l border-base-300/60 bg-base-100 shadow-2xl">
      <header class="border-b border-base-300/60 px-5 pt-4 pb-3">
        <div class="flex items-center gap-2">
          <span class="badge badge-soft badge-sm font-mono font-semibold" :class="METHOD[r.method] ?? 'badge-ghost'">{{ r.method }}</span>
          <span class="badge badge-soft badge-sm font-mono" :class="statusClass(r.status)">{{ r.status ?? '—' }}<span v-if="r.status && STATUS_TEXT[r.status]" class="ml-1 font-sans font-normal opacity-80">{{ STATUS_TEXT[r.status] }}</span></span>
          <span v-if="r.replay" class="badge badge-ghost badge-sm">replay</span>
          <span class="flex-1" />
          <button class="btn btn-primary btn-xs" :disabled="r.status === 101 || !canReplay" title="Send this request to the site again" @click="emit('replay', r)">Replay</button>
          <button class="btn btn-ghost btn-xs" title="Copy as curl" @click="copy(asCurl(), 'curl command')">curl</button>
          <button class="btn btn-ghost btn-xs btn-square" title="Close (Esc)" @click="emit('close')">✕</button>
        </div>
        <div class="selectable mt-2 truncate font-mono text-sm" :title="r.path">{{ r.path }}</div>
        <div class="mt-1 flex flex-wrap gap-x-3 text-xs opacity-60">
          <span>{{ when(r.at) }}</span>
          <span v-if="r.ms !== null">{{ r.ms }} ms</span>
          <span v-if="r.ip">from {{ r.ip }}</span>
          <span v-if="r.requestHeaders['user-agent']" class="max-w-64 truncate" :title="r.requestHeaders['user-agent']">{{ r.requestHeaders['user-agent'] }}</span>
        </div>
        <div role="tablist" class="seg mt-3">
          <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'request' }" @click="tab = 'request'">Request <span class="ml-1 opacity-50">{{ kb(size(r.requestHeaders, r.requestBody)) }}</span></a>
          <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'response' }" @click="tab = 'response'">Response <span class="ml-1 opacity-50">{{ kb(size(r.responseHeaders, r.responseBody)) }}</span></a>
          <a v-if="aiWebhookOn && shareId" role="tab" class="seg-item" :class="{ 'is-active': tab === 'ai' }" title="Who sent it, what it means, and a handler for the site" @click="tab = 'ai'">✦ Handle with AI</a>
        </div>
      </header>

      <div class="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 text-xs">
        <AiBox
          v-if="tab === 'ai'"
          :key="r.id"
          :run="aiRun"
          :preview="aiPreview"
          action="Explain & write a handler"
          placeholder="Optional wishes, e.g. “store the payment in orders”"
          busy-text="Reading the request…"
          @close="tab = 'request'"
        >
          <template #default="{ answer }">
            <div class="space-y-2 text-sm">
              <p class="selectable whitespace-pre-wrap">{{ (answer as AiWebhookAnswer).explanation }}</p>
              <div v-if="(answer as AiWebhookAnswer).where" class="text-xs opacity-70">Goes in: <code>{{ (answer as AiWebhookAnswer).where }}</code></div>
              <div class="flex items-center"><span class="label-caps">{{ (answer as AiWebhookAnswer).language || 'Code' }}</span><span class="flex-1" /><button class="btn btn-ghost btn-xs" @click="copy((answer as AiWebhookAnswer).code, 'Handler')">Copy</button></div>
              <pre class="selectable max-h-[28rem] overflow-auto rounded-box bg-base-200/60 p-3 font-mono text-[11px] leading-5">{{ (answer as AiWebhookAnswer).code }}</pre>
            </div>
          </template>
        </AiBox>
        <template v-if="tab === 'request'">
          <section>
            <div class="mb-1.5 flex items-center"><span class="label-caps">Headers</span><span class="ml-2 opacity-50">{{ Object.keys(r.requestHeaders).length }}</span><span class="flex-1" /><button class="btn btn-ghost btn-xs" @click="copy(headers(r.requestHeaders).map(([k, v]) => `${k}: ${v}`).join('\n'), 'Headers')">Copy</button></div>
            <dl class="hdrs">
              <template v-for="[k, v] in headers(r.requestHeaders)" :key="k"><dt>{{ k }}</dt><dd class="selectable">{{ v }}</dd></template>
            </dl>
          </section>
          <section>
            <div class="mb-1.5 flex items-center"><span class="label-caps">Body</span><span class="flex-1" /><button v-if="reqBody" class="btn btn-ghost btn-xs" @click="copy(reqBody, 'Body')">Copy</button></div>
            <pre v-if="reqBody" class="selectable max-h-[28rem] overflow-auto rounded-box bg-base-200/60 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap">{{ reqBody }}</pre>
            <p v-else class="rounded-box bg-base-200/40 p-3 opacity-60">No body.</p>
          </section>
        </template>
        <template v-else>
          <section>
            <div class="mb-1.5 flex items-center"><span class="label-caps">Headers</span><span class="ml-2 opacity-50">{{ Object.keys(r.responseHeaders).length }}</span><span class="flex-1" /><button class="btn btn-ghost btn-xs" @click="copy(headers(r.responseHeaders).map(([k, v]) => `${k}: ${v}`).join('\n'), 'Headers')">Copy</button></div>
            <dl v-if="Object.keys(r.responseHeaders).length" class="hdrs">
              <template v-for="[k, v] in headers(r.responseHeaders)" :key="k"><dt>{{ k }}</dt><dd class="selectable">{{ v }}</dd></template>
            </dl>
            <p v-else class="rounded-box bg-base-200/40 p-3 opacity-60">{{ r.status === 101 ? 'WebSocket upgrade: the socket was piped through.' : 'No answer recorded.' }}</p>
          </section>
          <section>
            <div class="mb-1.5 flex items-center"><span class="label-caps">Body</span><span class="flex-1" /><button v-if="resBody" class="btn btn-ghost btn-xs" @click="copy(resBody, 'Body')">Copy</button></div>
            <pre v-if="resBody" class="selectable max-h-[28rem] overflow-auto rounded-box bg-base-200/60 p-3 font-mono text-[11px] leading-5 whitespace-pre-wrap">{{ resBody }}</pre>
            <p v-else class="rounded-box bg-base-200/40 p-3 opacity-60">No body.</p>
          </section>
        </template>
      </div>
    </aside>
  </Teleport>
</template>

<style scoped>
.hdrs {
  display: grid;
  grid-template-columns: minmax(8rem, max-content) 1fr;
  gap: 0.25rem 1rem;
  padding: 0.6rem 0.75rem;
  border-radius: var(--radius-box);
  background: color-mix(in oklch, var(--color-base-200) 60%, transparent);
  font-family: ui-monospace, 'SF Mono', Menlo, monospace;
  font-size: 11px;
  line-height: 1.5;
}
.hdrs dt {
  color: color-mix(in oklch, var(--color-base-content) 60%, transparent);
  overflow-wrap: anywhere;
}
.hdrs dd {
  overflow-wrap: anywhere;
}
</style>
