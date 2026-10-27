<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, nextTick, onMounted, ref } from 'vue';
import { aiProvider, type AiAction, type AiAskAnswer, type AiPreview, type AiTurn } from '@shared/types';
import AiActions from './AiActions.vue';
import askMark from '../assets/logos/ask-catzoid.svg';
import CatMood from './CatMood.vue';
import AiPreviewDialog from './AiPreviewDialog.vue';
import { herd, state } from '../store';
import { aiError, aiToken, plain } from '../ai';

/**
 * Ask DevCatz (⌘K, TODO §28): say in plain words what DevCatz should do ("start shop and its database", "turn on
 * RustFS"); the model answers with DevCatz actions shown as steps you run one by one, or just answers a question.
 * Only site / service names, domains, status and stacks are sent — no code, no .env.
 */
const emit = defineEmits<{ close: [] }>();

/** The conversation as shown: what you asked, then the answer (or the error). */
interface Exchange {
  prompt: string;
  answer: AiAskAnswer | null;
  error: string;
}
const thread = ref<Exchange[]>([]);
const history = ref<AiTurn[]>([]);
const prompt = ref('');
const busy = ref(false);
const shown = ref<AiPreview | null>(null);
const input = ref<HTMLTextAreaElement | null>(null);
const scroller = ref<HTMLElement | null>(null);
let token = '';

const model = computed(() => {
  const ai = state.value?.ai;
  if (!ai) return '';
  const info = aiProvider(ai.provider);
  return `${info.name} · ${ai.models[ai.provider] || info.models[0] || '?'}`;
});
const SUGGESTIONS = ['Start every stopped site', 'Turn on RustFS', 'Which services are running?', 'Share my site on a public URL'];

const req = (p: string) => ({ prompt: p, history: plain(history.value) });
const scrollDown = () => nextTick(() => scroller.value?.scrollTo({ top: scroller.value.scrollHeight, behavior: 'smooth' }));

async function send(text = prompt.value) {
  const p = text.trim();
  if (!p || busy.value) return;
  prompt.value = '';
  const ex: Exchange = { prompt: p, answer: null, error: '' };
  thread.value = [...thread.value, ex];
  busy.value = true;
  token = aiToken();
  scrollDown();
  try {
    const a = await herd.aiAsk(req(p), token);
    ex.answer = a;
    history.value = [...history.value, { role: 'user', text: p }, { role: 'assistant', text: JSON.stringify(a) }];
  } catch (e) {
    ex.error = aiError(e);
  } finally {
    busy.value = false;
    thread.value = [...thread.value];
    scrollDown();
    void nextTick(() => input.value?.focus());
  }
}
const stop = () => void herd.aiCancel(token);
async function showPreview() {
  try {
    shown.value = await herd.aiPreviewAsk(req(prompt.value || '…'));
  } catch (e) {
    thread.value = [...thread.value, { prompt: prompt.value || 'Preview', answer: null, error: aiError(e) }];
  }
}
function reset() {
  thread.value = [];
  history.value = [];
  input.value?.focus();
}
/** Steps that take you to another screen close the palette, so that screen (or its dialog) is in front. */
function done(a: AiAction) {
  if (['open-tab', 'open-section', 'service-uninstall'].includes(a.kind)) emit('close');
}
function keydown(e: KeyboardEvent) {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    void send();
  }
}
onMounted(() => input.value?.focus());
</script>

<template>
  <dialog open class="modal modal-open items-start pt-[10vh]" @keydown.esc="emit('close')">
    <div class="ask-panel modal-box flex max-h-[76vh] w-[42rem] max-w-[94vw] flex-col p-0">
      <!-- Header -->
      <header class="flex items-center gap-3 px-5 pt-4 pb-3">
        <span class="ask-mark" aria-hidden="true"><span><img :src="askMark" alt="" /></span></span>
        <div class="min-w-0 flex-1">
          <h3 class="text-[15px] leading-tight font-semibold tracking-tight">Ask DevCatz</h3>
          <p class="truncate text-xs opacity-55">{{ model }}</p>
        </div>
        <button v-if="thread.length" class="btn btn-ghost btn-xs" title="Start a new conversation" :disabled="busy" @click="reset">New chat</button>
        <button class="btn btn-ghost btn-xs" title="See exactly what is sent, nothing is sent" :disabled="busy" @click="showPreview">Preview</button>
        <button class="btn btn-ghost btn-xs btn-square" title="Close (Esc)" aria-label="Close" @click="emit('close')">✕</button>
      </header>

      <!-- Conversation -->
      <div ref="scroller" class="min-h-0 flex-1 overflow-y-auto px-5">
        <div v-if="!thread.length" class="pt-2 pb-5">
          <p class="text-sm opacity-70">Say what you want in plain words: DevCatz works out the steps, and nothing runs until you press <b>Run</b>.</p>
          <div class="mt-3 flex flex-wrap gap-2">
            <button v-for="s in SUGGESTIONS" :key="s" class="ask-chip" @click="send(s)">{{ s }}</button>
          </div>
        </div>

        <div v-for="(ex, i) in thread" :key="i" class="space-y-3 pb-5">
          <div class="flex justify-end">
            <div class="ask-bubble selectable">{{ ex.prompt }}</div>
          </div>
          <div class="flex gap-3">
            <span class="ask-avatar" aria-hidden="true"><img :src="askMark" alt="" /></span>
            <div class="min-w-0 flex-1 space-y-3 pt-0.5">
              <div v-if="!ex.answer && !ex.error" class="ask-thinking"><span /><span /><span /><em>Working out the steps…</em></div>
              <div v-else-if="ex.error" class="ask-error selectable flex items-start gap-2"><CatMood mood="error" class="size-6 shrink-0" /><span class="min-w-0">{{ ex.error }}</span></div>
              <template v-else-if="ex.answer">
                <p class="selectable text-sm leading-relaxed">{{ ex.answer.explanation }}</p>
                <AiActions v-if="ex.answer.actions.length" steps :actions="ex.answer.actions" :site-id="null" @done="done" />
              </template>
            </div>
          </div>
        </div>
      </div>

      <!-- Composer -->
      <footer class="px-4 pt-1 pb-4">
        <div class="ask-composer">
          <textarea
            ref="input"
            v-model="prompt"
            rows="1"
            class="ask-input"
            :placeholder="thread.length ? 'Ask a follow-up…' : 'What should DevCatz do? e.g. “start shop and its database”'"
            :disabled="busy"
            spellcheck="false"
            @keydown="keydown"
          />
          <button v-if="busy" class="ask-send is-stop" title="Stop" aria-label="Stop" @click="stop">
            <svg viewBox="0 0 20 20" fill="currentColor"><rect x="5.5" y="5.5" width="9" height="9" rx="1.5" /></svg>
          </button>
          <button v-else class="ask-send" :disabled="!prompt.trim()" title="Send (⏎)" aria-label="Send" @click="send()">
            <svg viewBox="0 0 20 20" fill="currentColor"><path d="M10 3.5 4.6 8.9l1.1 1.1 3.5-3.5V16.5h1.6V6.5l3.5 3.5 1.1-1.1L10 3.5Z" /></svg>
          </button>
        </div>
        <p class="mt-2 px-1 text-[11px] opacity-45">⏎ send · {{ keyLabel('shift+⏎') }} new line · Esc close · secrets are masked before anything is sent</p>
      </footer>
    </div>
    <div class="modal-backdrop" @click="emit('close')" />
    <AiPreviewDialog v-if="shown" :preview="shown" @close="shown = null" />
  </dialog>
</template>
