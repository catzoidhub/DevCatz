<script setup lang="ts">
import { currentOS, keyLabel, words } from '@shared/platform';
import { computed, ref, watch } from 'vue';
import { AI_FEATURES, AI_PROVIDERS, aiProvider, type AiFeature, type AiProvider, type AiSettingsPatch } from '@shared/types';
import AiModelPicker from './AiModelPicker.vue';
import { attempt, herd, notify, state } from '../store';

/**
 * Settings → AI (TODO §28): the provider, its API key (encrypted with the Keychain in the main process, never
 * shown again), address, model and a Test, like DBCatz's; then a switch per feature with what it sends.
 */
const ai = computed(() => state.value!.ai);
const info = computed(() => aiProvider(ai.value.provider));
const hasKey = computed(() => ai.value.keys.includes(ai.value.provider));
const needsKey = computed(() => !!info.value.keyUrl);
const editableUrl = computed(() => ai.value.provider === 'zai' || ai.value.provider === 'ollama' || ai.value.provider === 'openai-compatible');

const save = (patch: AiSettingsPatch) => attempt(() => herd.aiSetSettings(patch));

const keyInput = ref('');
const replacing = ref(false);
const modelInput = ref('');
const urlInput = ref('');
const loaded = ref<Partial<Record<AiProvider, string[]>>>({});
const loadingModels = ref(false);
const testing = ref(false);
const tested = ref<{ ok: boolean; text: string } | null>(null);

// The fields follow the chosen provider.
watch(
  () => ai.value.provider,
  () => {
    modelInput.value = ai.value.models[ai.value.provider] ?? info.value.models[0] ?? '';
    urlInput.value = ai.value.baseUrls[ai.value.provider] ?? info.value.baseUrl;
    keyInput.value = '';
    replacing.value = false;
    tested.value = null;
  },
  { immediate: true },
);
const modelList = computed(() => [...new Set([...(loaded.value[ai.value.provider] ?? []), ...info.value.models])]);
/** Per provider: model → null (works with the key) or why not; checks add up. */
const probed = ref<Partial<Record<AiProvider, Record<string, string | null>>>>({});
const probing = ref(false);
async function probe(list: string[]) {
  probing.value = true;
  const r = await attempt(() => herd.aiProbe(ai.value.provider, list));
  probing.value = false;
  if (!r) return;
  probed.value = { ...probed.value, [ai.value.provider]: { ...(probed.value[ai.value.provider] ?? {}), ...r } };
  const ok = list.filter((m) => r[m] === null);
  notify(ok.length ? 'success' : 'error', ok.length ? `${ok.length} of ${list.length} models work with this key` : `None of ${list.length} models answered with this key: ${Object.values(r).find((x) => x) ?? ''}`);
  if (ok.length && typeof r[modelInput.value] === 'string') await chooseModel(ok[0]);
}
async function chooseModel(m: string) {
  modelInput.value = m;
  const id = m.trim();
  if (id === (ai.value.models[ai.value.provider] ?? '')) return;
  await save({ models: { [ai.value.provider]: id } });
  tested.value = null;
}
async function saveKey() {
  const k = keyInput.value.trim();
  if (!k) return;
  if (await attempt(() => herd.aiSetKey(ai.value.provider, k), `${info.value.name} key saved`)) {
    keyInput.value = '';
    replacing.value = false;
    tested.value = null;
  }
}
const removeKey = () => attempt(() => herd.aiSetKey(ai.value.provider, ''), 'Key removed');
async function saveUrl() {
  const u = urlInput.value.trim();
  await save({ baseUrls: { [ai.value.provider]: u === info.value.baseUrl ? '' : u } });
  tested.value = null;
}
async function loadModels() {
  loadingModels.value = true;
  const list = await attempt(() => herd.aiModels(ai.value.provider));
  loadingModels.value = false;
  if (!list) return;
  loaded.value = { ...loaded.value, [ai.value.provider]: list };
  notify('info', list.length ? `${list.length} models from ${info.value.name}` : `${info.value.name} listed no models`);
}
async function test() {
  testing.value = true;
  tested.value = null;
  try {
    tested.value = { ok: true, text: `${await herd.aiTest()} answered` };
  } catch (e) {
    tested.value = { ok: false, text: String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') };
  }
  testing.value = false;
}
const isOn = (f: AiFeature) => !ai.value.off.includes(f);
const toggleFeature = (f: AiFeature, on: boolean) => save({ off: on ? ai.value.off.filter((x) => x !== f) : [...ai.value.off, f] });
</script>

<template>
  <div class="card">
    <div class="card-body gap-3 p-4">
      <h2 class="font-semibold">AI</h2>
      <label class="flex cursor-pointer items-start gap-3">
        <input type="checkbox" class="toggle toggle-primary toggle-sm mt-0.5" :checked="ai.enabled" @change="save({ enabled: ($event.target as HTMLInputElement).checked })" />
        <span>
          Use AI in DevCatz
          <span class="block text-xs opacity-60">Explains errors with one-click fixes, writes commit messages, helps with Docker, .env, search and webhooks, and takes plain-word commands ({{ keyLabel('mod+K') }}). Nothing is sent until you press an AI button; every one has <b>Preview what is sent</b>, and what DevCatz suggests to run waits for your click.</span>
        </span>
      </label>
    </div>
  </div>

  <div class="card" :class="{ 'opacity-60': !ai.enabled }">
    <div class="card-body gap-3 p-4">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Provider</h2>
        <span class="badge badge-ghost badge-sm" title="Change the provider, model or key in any Catzoid app and the others follow">Shared with Catzoid apps</span>
      </div>
      <div class="flex items-center gap-3">
        <span class="w-28 shrink-0 text-sm">Provider</span>
        <select class="select select-sm min-w-0 flex-1" :value="ai.provider" @change="save({ provider: ($event.target as HTMLSelectElement).value as AiProvider })">
          <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">{{ p.name }}{{ ai.keys.includes(p.id) ? ' · key saved' : '' }}</option>
        </select>
      </div>

      <div v-if="needsKey || ai.provider === 'openai-compatible'" class="flex items-start gap-3">
        <span class="w-28 shrink-0 pt-1.5 text-sm">API key</span>
        <div class="min-w-0 flex-1 space-y-1.5">
          <div v-if="hasKey && !replacing" class="flex items-center gap-2">
            <span class="input input-sm flex min-w-0 flex-1 items-center gap-2 text-xs opacity-80"><span class="status status-success status-xs shrink-0" /><span class="truncate">Saved in {{ currentOS === 'mac' ? 'the macOS Keychain' : words.secretStore }}, shared with Catzoid apps</span></span>
            <button class="btn btn-sm" @click="replacing = true">Replace</button>
            <button class="btn btn-ghost btn-sm text-error" @click="removeKey">Remove</button>
          </div>
          <form v-else class="flex items-center gap-2" @submit.prevent="saveKey">
            <input v-model="keyInput" type="password" class="input input-sm min-w-0 flex-1 font-mono text-xs" :placeholder="ai.provider === 'openai-compatible' ? 'Optional: the server’s token' : `Paste your ${info.name} API key`" autocomplete="off" spellcheck="false" />
            <button class="btn btn-primary btn-sm" :disabled="!keyInput.trim()">Save</button>
            <button v-if="replacing" type="button" class="btn btn-ghost btn-sm" @click="replacing = false; keyInput = ''">Cancel</button>
          </form>
          <p class="text-xs opacity-60">
            Kept only on this {{ words.computer }} ({{ words.secretStore }} item “Catzoid AI”), never shown again or sent anywhere but {{ info.name }}.
            <a v-if="info.keyUrl" class="link" @click="herd.openUrl(info.keyUrl)">Get a key</a>
          </p>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <span class="w-28 shrink-0 pt-1.5 text-sm">Address</span>
        <div class="min-w-0 flex-1 space-y-1.5">
          <input v-if="editableUrl" v-model="urlInput" class="input input-sm w-full font-mono text-xs" :placeholder="info.baseUrl" spellcheck="false" @change="saveUrl" @keydown.enter="saveUrl" />
          <span v-else class="input input-sm flex w-full items-center font-mono text-xs opacity-60">{{ info.baseUrl }}</span>
          <p v-if="ai.provider === 'zai'" class="text-xs opacity-60">Use a <b>Standard API key</b> (pay-as-you-go balance); GLM Coding Plan keys only work in Z.ai’s supported tools. Keys from bigmodel.cn use <code>https://open.bigmodel.cn/api/paas/v4</code>.</p>
          <p v-else-if="ai.provider === 'ollama'" class="text-xs opacity-60">Runs on this {{ words.computer }}, nothing leaves it. Install from ollama.com, then e.g. <code>ollama pull qwen2.5-coder</code>.</p>
          <p v-else-if="ai.provider === 'openai-compatible'" class="text-xs opacity-60">Any server with an OpenAI-style <code>/chat/completions</code>: LM Studio, vLLM, LiteLLM, a company gateway.</p>
        </div>
      </div>

      <div class="flex items-start gap-3">
        <span class="w-28 shrink-0 pt-1.5 text-sm">Model</span>
        <div class="min-w-0 flex-1 space-y-1.5">
          <div class="flex items-center gap-2">
            <AiModelPicker :model-value="modelInput" :models="modelList" :status="probed[ai.provider]" :checking="probing" :can-check="!needsKey || hasKey" :placeholder="info.models[0] ?? 'model id'" @update:model-value="chooseModel" @check="probe" />
            <button class="btn btn-sm" :disabled="loadingModels || (needsKey && !hasKey)" :title="needsKey && !hasKey ? 'Save the API key first' : `Ask ${info.name} for its models`" @click="loadModels"><span v-if="loadingModels" class="loading loading-spinner loading-xs" />Load models</button>
          </div>
          <p class="text-xs opacity-60">Click the field to search the list ({{ modelList.length }} models), or type any id the provider knows; <b>Check … with the key</b> marks the ones your key may use ✓ / ✗.</p>
        </div>
      </div>

      <div class="flex items-center gap-3 pt-1">
        <span class="w-28 shrink-0" />
        <button class="btn btn-sm" :disabled="testing || !ai.enabled" :title="ai.enabled ? 'Sends one tiny request' : 'Turn AI on first'" @click="test"><span v-if="testing" class="loading loading-spinner loading-xs" />Test</button>
        <span v-if="tested" class="min-w-0 text-xs" :class="tested.ok ? 'text-success' : 'text-error'">{{ tested.text }}</span>
      </div>
    </div>
  </div>

  <div class="card" :class="{ 'opacity-60': !ai.enabled }">
    <div class="card-body gap-3 p-4">
      <h2 class="font-semibold">Features</h2>
      <p class="text-xs opacity-60">Each one sends only what it needs, with secrets masked (passwords, tokens, keys, URL credentials; your home folder shows as ~). The AI buttons hide for a feature that is off.</p>
      <label v-for="f in AI_FEATURES" :key="f.id" class="flex cursor-pointer items-start gap-3 border-t border-base-300/50 pt-3">
        <input type="checkbox" class="toggle toggle-sm mt-0.5" :checked="isOn(f.id)" :disabled="!ai.enabled" @change="toggleFeature(f.id, ($event.target as HTMLInputElement).checked)" />
        <span class="min-w-0">
          <span class="font-medium">{{ f.label }}</span>
          <span class="block text-xs opacity-70">{{ f.hint }}</span>
          <span class="block text-xs opacity-50">Sends: {{ f.sends }}.</span>
        </span>
      </label>
    </div>
  </div>
</template>
