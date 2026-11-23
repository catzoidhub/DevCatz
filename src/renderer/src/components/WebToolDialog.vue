<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue';
import type { WebToolId } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import { WEB_TOOL_LOGO, WEB_TOOL_TILE } from '../logos';
import TaskStepper from './TaskStepper.vue';

/**
 * Install phpMyAdmin / Adminer / pgweb / Redis Commander (TODO §48), or change an installed one: its name under the
 * default domain, its port and the PHP / Node.js version it runs on (with Install PHP / Node.js when there is none
 * yet). Opened from a
 * database service's Open menu (then it opens that service once installed) or from the Web tools card.
 */
const props = defineProps<{ tool: WebToolId; mode: 'install' | 'settings'; serviceId?: string; database?: string }>();
const emit = defineEmits<{ close: [] }>();

const t = computed(() => state.value?.webTools.find((x) => x.id === props.tool) ?? null);
const tld = computed(() => state.value?.settings.tld || 'localhost');
/** The runtime it runs on (PHP for phpMyAdmin / Adminer, Node.js for Redis Commander), null for pgweb. */
const kind = computed(() => t.value?.runtime ?? null);
const rtName = computed(() => (kind.value === 'node' ? 'Node.js' : 'PHP'));
const rtState = computed(() => (kind.value === 'node' ? state.value?.node : state.value?.php) ?? null);
const phps = computed(() => (rtState.value?.installed ?? []) as { version: string }[]);
const phpInstalling = computed(() => rtState.value?.installing ?? null);
const rtDefault = computed(() => rtState.value?.defaultVersion ?? null);

const domain = ref(props.mode === 'settings' ? (t.value?.domain ?? props.tool) : (t.value?.defaults.domain ?? props.tool));
const port = ref<number>(props.mode === 'settings' ? (t.value?.port ?? 0) : (t.value?.defaults.port ?? 0));
const php = ref<string>(t.value?.runtimeVersion ?? rtDefault.value ?? phps.value[0]?.version ?? '');
// The first PHP installed from here becomes the choice.
watch(phps, (list) => {
  if (!php.value || !list.some((p) => p.version === php.value)) php.value = rtDefault.value ?? list[0]?.version ?? '';
});

const errs = ref<{ domain: string | null; port: string | null }>({ domain: null, port: null });
let timer: ReturnType<typeof setTimeout> | undefined;
watch(
  [domain, port],
  () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      errs.value = (await attempt(() => herd.webToolCheck(props.tool, { domain: domain.value, port: Number(port.value) }))) ?? errs.value;
    }, 250);
  },
  { immediate: true },
);
onBeforeUnmount(() => clearTimeout(timer));

const task = computed(() => t.value?.task ?? null);
const working = computed(() => !!task.value && !task.value.done && !task.value.error);
const needPhp = computed(() => !!kind.value && !phps.value.length);
const ready = computed(() => !errs.value.domain && !errs.value.port && !!domain.value && !!port.value && (!kind.value || !!php.value));
const changed = computed(() => props.mode === 'install' || domain.value !== t.value?.domain || Number(port.value) !== t.value?.port || (!!kind.value && php.value !== t.value?.runtimeVersion));
/** phpMyAdmin 5.2 is made for PHP up to 8.3; newer PHP runs it with its deprecation notices kept out of the pages. */
const pmaNote = computed(() => props.tool === 'phpmyadmin' && /^8\.(4|5|6|7|8|9)|^9\./.test(php.value));

async function installPhp() {
  if (kind.value === 'node') {
    // The newest LTS: what DevCatz's Node.js page recommends.
    const remote = (await attempt(() => herd.nodeRemote())) ?? [];
    const pick = remote.find((r) => r.lts) ?? remote[0];
    if (!pick) return notify('error', 'No Node.js release found');
    return void (await attempt(() => herd.nodeInstall(pick.version)));
  }
  const remote = (await attempt(() => herd.phpRemote())) ?? [];
  const pick = remote.find((r) => !r.via);
  if (!pick) return notify('error', 'No PHP build found for this computer');
  await attempt(() => herd.phpInstall(pick.version));
}

async function submit() {
  const opts = { domain: domain.value.trim(), port: Number(port.value), runtime: kind.value ? php.value : null };
  if (props.mode === 'install') {
    const r = await attempt(() => herd.webToolInstall(props.tool, opts, props.serviceId ? { serviceId: props.serviceId, database: props.database } : undefined).then(() => true));
    if (r) emit('close');
  } else if (await attempt(() => herd.webToolConfigure(props.tool, opts).then(() => true), 'Saved')) emit('close');
}
function close() {
  if (working.value) return;
  if (task.value) void herd.webToolCancel(props.tool);
  emit('close');
}
</script>

<template>
  <Teleport to="body">
    <dialog open class="modal modal-open" @keydown.esc="close">
      <div v-if="t" class="modal-box w-[32rem] max-w-[95vw] space-y-4">
        <div class="flex items-start gap-4">
          <img :src="WEB_TOOL_LOGO[t.id]" alt="" class="size-14 shrink-0 object-contain drop-shadow-sm" :class="WEB_TOOL_TILE[t.id]" draggable="false" />
          <div class="min-w-0 space-y-1">
            <h3 class="text-lg font-semibold tracking-tight">{{ mode === 'install' ? `Install ${t.name}` : `${t.name} settings` }}</h3>
            <p class="text-sm opacity-70">{{ t.description }}</p>
            <p v-if="mode === 'install'" class="text-xs opacity-60">
              The latest release from <a class="link" @click="herd.openUrl(t.sourceUrl)">{{ t.sourceUrl.replace(/^https:\/\//, '') }}</a>, SHA-256 checked. It signs in to DevCatz's
              services by itself; DBCatz stays the recommended app.
            </p>
          </div>
        </div>

        <TaskStepper v-if="task" :task="task" cancellable dismissable @cancel="herd.webToolCancel(tool)" @dismiss="herd.webToolCancel(tool)" />

        <template v-if="!working">
          <label class="block space-y-1">
            <span class="label-caps">Address</span>
            <div class="join flex">
              <span class="join-item flex shrink-0 items-center border border-base-300 bg-base-200 px-2.5 font-mono text-xs opacity-70">https://</span>
              <input v-model="domain" class="input input-sm join-item min-w-0 flex-1 font-mono" :class="{ 'input-error': errs.domain }" spellcheck="false" autocapitalize="off" />
              <span class="join-item flex shrink-0 items-center border border-base-300 bg-base-200 px-2.5 font-mono text-xs opacity-70">.{{ tld }}</span>
            </div>
            <span v-if="errs.domain" class="text-xs text-error">{{ errs.domain }}</span>
            <span v-else-if="tool === 'pgweb'" class="text-xs opacity-60">Each PostgreSQL service gets its own name under it: <code>&lt;service&gt;.{{ domain }}.{{ tld }}</code> (and <code>{{ domain }}.{{ tld }}</code> while you have one).</span>
          </label>

          <label class="block space-y-1">
            <span class="label-caps">Port</span>
            <input v-model.number="port" type="number" min="1024" max="65535" class="input input-sm w-36 font-mono" :class="{ 'input-error': errs.port }" />
            <span v-if="errs.port" class="block text-xs text-error">{{ errs.port }}</span>
            <span v-else class="block text-xs opacity-60">On 127.0.0.1 only.<template v-if="tool === 'pgweb'"> The first PostgreSQL service uses it, the next ones the following free ports.</template></span>
          </label>

          <div v-if="kind" class="space-y-1">
            <span class="label-caps block">{{ rtName }}</span>
            <template v-if="!needPhp">
              <select v-model="php" class="select select-sm w-56">
                <option v-for="p in phps" :key="p.version" :value="p.version">{{ rtName }} {{ p.version }}{{ p.version === rtDefault ? ' (default)' : '' }}</option>
              </select>
              <span v-if="pmaNote" class="block text-xs opacity-60">phpMyAdmin 5.2 is made for PHP up to 8.3. It runs on newer PHP too; its deprecation notices stay out of the pages.</span>
            </template>
            <div v-else class="flex flex-wrap items-center gap-2 rounded-box bg-base-200/70 p-3 text-sm">
              <span class="flex-1">{{ t.name }} runs on {{ rtName }}, and no {{ rtName }} is installed yet.</span>
              <button v-if="!phpInstalling || phpInstalling.error" class="btn btn-sm" @click="installPhp">Install {{ rtName }}</button>
              <span v-else class="flex items-center gap-2 text-xs opacity-70"><span class="loading loading-spinner loading-xs" />Installing {{ rtName }} {{ phpInstalling.version }}…</span>
              <span v-if="phpInstalling?.error" class="w-full text-xs text-error">{{ phpInstalling.error }}</span>
            </div>
          </div>
        </template>

        <div class="modal-action">
          <button class="btn btn-ghost btn-sm" :disabled="working" @click="close">{{ task?.error ? 'Close' : 'Cancel' }}</button>
          <button v-if="!working" class="btn btn-primary btn-sm" :disabled="!ready || !changed" @click="submit">
            {{ mode === 'install' ? (serviceId ? 'Install & open' : 'Install') : 'Save' }}
          </button>
        </div>
      </div>
    </dialog>
  </Teleport>
</template>
