<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import type { ReportKind, ReportPreview } from '@shared/types';
import CatMood from './CatMood.vue';
import { herd, reportDialog, state } from '../store';
import { fromFile, prepare, release, SHOTS_MAX, type Shot } from '../shots';

/**
 * Report a Bug / Send Feedback (Catzoid #65): the kind, a message, an email only if the user wants a reply, and
 * "Preview what is sent" (the request exactly as it leaves: version, macOS, arch, channel, a random install id —
 * scrubbed of keys, tokens, hosts and paths). Sent to the Catzoid site; queued when it cannot be reached.
 */
const KINDS: { id: ReportKind; label: string; hint: string }[] = [
  { id: 'bug', label: 'Bug', hint: 'Something does not work. What did you do, what happened, what did you expect?' },
  { id: 'idea', label: 'Idea', hint: 'What would make DevCatz better for you?' },
  { id: 'question', label: 'Question', hint: 'Ask anything about DevCatz.' },
];
const kind = ref<ReportKind>('bug');
const message = ref('');
const email = ref('');
const preview = ref<ReportPreview | null>(null);
const sending = ref(false);
const result = ref<{ ok: boolean; queued?: boolean; text: string } | null>(null);
const hint = computed(() => KINDS.find((k) => k.id === kind.value)!.hint);
// screenshots on a bug report (Catzoid #67): optional, cleaned in shots.ts, shown before they go
const shots = ref<Shot[]>([]);
const shotError = ref('');
const capturing = ref(false);
const picker = ref<HTMLInputElement | null>(null);
const sendShots = computed(() => (kind.value === 'bug' ? shots.value : []));

watch(reportDialog, (k) => {
  if (!k) {
    release(shots.value);
    shots.value = [];
    return;
  }
  kind.value = k;
  message.value = email.value = '';
  preview.value = result.value = null;
  shotError.value = '';
});

async function add(src: string) {
  shotError.value = '';
  try {
    shots.value = [...shots.value, await prepare(src)];
  } catch (e) {
    shotError.value = (e as Error).message;
  }
}
async function pick(e: Event) {
  const input = e.target as HTMLInputElement;
  for (const f of [...(input.files ?? [])].slice(0, SHOTS_MAX - shots.value.length)) {
    try {
      await add(await fromFile(f));
    } catch (err) {
      shotError.value = (err as Error).message;
    }
  }
  input.value = '';
}
/** The window without this dialog: hide it, let a frame paint, capture, show it again. */
async function capture() {
  capturing.value = true;
  await nextTick();
  await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 120))));
  try {
    const png = await herd.captureWindow();
    capturing.value = false;
    if (png) await add(`data:image/png;base64,${png}`);
  } finally {
    capturing.value = false;
  }
}
function remove(i: number) {
  release([shots.value[i]]);
  shots.value = shots.value.filter((_, j) => j !== i);
}

async function showPreview() {
  preview.value = preview.value ? null : await herd.reportPreview(kind.value, message.value, email.value, sendShots.value.length);
}
async function send() {
  sending.value = true;
  result.value = null;
  try {
    const r = await herd.reportSend(kind.value, message.value, email.value, sendShots.value.map(({ type, data }) => ({ type, data })));
    result.value = r.sent
      ? { ok: true, text: 'Thanks — sent. Every report is read.' }
      : { ok: true, queued: true, text: 'The Catzoid site cannot be reached right now: DevCatz keeps it and sends it by itself as soon as it can.' };
  } catch (e) {
    result.value = { ok: false, text: (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  } finally {
    sending.value = false;
  }
}
const close = () => (reportDialog.value = null);
</script>

<template>
  <Teleport to="body">
    <dialog v-if="reportDialog" open class="modal modal-open" :class="{ invisible: capturing }" @keydown.esc="close">
      <div class="modal-box w-[34rem] max-w-[95vw] space-y-4">
        <h3 class="text-lg font-semibold tracking-tight">{{ kind === 'bug' ? 'Report a bug' : 'Send feedback' }}</h3>

        <template v-if="!result?.ok">
          <div role="tablist" class="seg seg-choice">
            <a v-for="k in KINDS" :key="k.id" role="tab" class="seg-item" :class="{ 'is-active': kind === k.id }" @click="kind = k.id">{{ k.label }}</a>
          </div>
          <label class="block space-y-1.5">
            <span class="text-xs opacity-70">{{ hint }}</span>
            <textarea v-model="message" class="textarea textarea-bordered h-36 w-full" maxlength="10000" :placeholder="kind === 'bug' ? 'Steps, what you saw, what you expected…' : 'Write here…'" />
          </label>
          <div v-if="kind === 'bug'" class="space-y-2">
            <div class="flex flex-wrap items-center gap-2">
              <span class="text-xs opacity-70">Screenshots (optional, up to {{ SHOTS_MAX }})</span>
              <span class="flex-1" />
              <button type="button" class="btn btn-ghost btn-xs" :disabled="shots.length >= SHOTS_MAX || capturing" @click="capture">Capture this window</button>
              <button type="button" class="btn btn-ghost btn-xs" :disabled="shots.length >= SHOTS_MAX" @click="picker?.click()">Attach a screenshot…</button>
              <input ref="picker" type="file" accept="image/png,image/jpeg" multiple class="hidden" @change="pick" />
            </div>
            <div v-if="shots.length" class="grid grid-cols-3 gap-2">
              <figure v-for="(sh, i) in shots" :key="sh.url" class="group relative overflow-hidden rounded-lg border border-base-300 bg-base-200/50">
                <img :src="sh.url" alt="Screenshot to send" class="aspect-[16/10] w-full object-cover object-top" />
                <figcaption class="flex justify-between px-1.5 py-0.5 font-mono text-[10px] opacity-60">
                  <span>{{ sh.width }}×{{ sh.height }}</span><span>{{ Math.max(1, Math.round(sh.bytes / 1024)) }} KB</span>
                </figcaption>
                <button type="button" class="btn btn-circle btn-xs absolute right-1 top-1 opacity-90" title="Remove" aria-label="Remove this screenshot" @click="remove(i)">✕</button>
              </figure>
            </div>
            <p v-if="shots.length" class="text-xs text-warning">
              Look at each screenshot before you send it: no .env values, keys, passwords or client data. Pictures cannot be cleaned
              like text — what you see is what goes.
            </p>
            <p v-if="shotError" class="text-xs text-error">{{ shotError }}</p>
          </div>
          <label class="block space-y-1.5">
            <span class="text-xs opacity-70">Email, only if you want a reply (optional)</span>
            <input v-model="email" type="email" class="input input-bordered input-sm w-full" placeholder="you@example.com" />
          </label>
          <p class="text-xs opacity-55">
            Sent with the DevCatz version, macOS version, chip and a random install id — never your projects, .env values, keys, hosts or paths
            (they are removed from the message too).
            <a class="link" @click="showPreview">{{ preview ? 'Hide preview' : 'Preview what is sent' }}</a>
          </p>
          <pre v-if="preview" class="selectable max-h-56 overflow-auto rounded-box bg-base-200/70 p-3 text-[11px] leading-relaxed">POST {{ preview.url }}
{{ Object.entries(preview.headers).map(([k, v]) => `${k}: ${v}`).join('\n') }}

{{ JSON.stringify(preview.body, null, 2) }}</pre>
        </template>

        <div v-if="result" role="alert" class="alert alert-soft text-sm" :class="result.ok ? (result.queued ? 'alert-info' : 'alert-success') : 'alert-error'">
          <CatMood :mood="result.ok ? (result.queued ? 'info' : 'success') : 'error'" class="size-7 shrink-0 -my-0.5" />
          <span>{{ result.text }}</span>
        </div>

        <div class="modal-action">
          <template v-if="result?.ok">
            <button type="button" class="btn btn-primary btn-sm" @click="close">Close</button>
          </template>
          <template v-else>
            <button type="button" class="btn btn-ghost btn-sm" :disabled="sending" @click="close">Cancel</button>
            <button type="button" class="btn btn-primary btn-sm" :disabled="sending || !message.trim()" @click="send">
              <span v-if="sending" class="loading loading-spinner loading-xs" />{{ result ? 'Retry' : 'Send' }}
            </button>
          </template>
        </div>
      </div>
      <div class="modal-backdrop" @click="!sending && close()" />
    </dialog>
  </Teleport>
</template>
