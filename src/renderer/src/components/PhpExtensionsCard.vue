<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { PhpExtensions } from '@shared/types';
import { attempt, herd, notify, state } from '../store';
import CatMood from './CatMood.vue';
import { isWin } from '../platform';

/** PECL extensions for one PHP version: the catalog, any package by name, built ones with on/off, and what is compiled in. */
const props = defineProps<{ version: string }>();

const data = ref<PhpExtensions | null>(null);
async function load() {
  if (!props.version) return;
  const r = await attempt(() => herd.phpExtensions(props.version));
  if (r) data.value = r;
}
watch(() => props.version, load, { immediate: true });
// Changes made elsewhere (a terminal, another window) show up when DevCatz is focused again.
onMounted(() => window.addEventListener('focus', load));
onBeforeUnmount(() => window.removeEventListener('focus', load));

const task = computed(() => state.value?.php.extTask ?? null);
const running = computed(() => task.value && task.value.phase !== 'done' && task.value.phase !== 'error');
// Reload the list once a build ends.
watch(
  () => task.value?.phase,
  (p, old) => {
    if ((p === 'done' || p === 'error') && old && old !== 'done' && old !== 'error') void load();
  },
);

const has = (pkg: string) => data.value?.installed.find((e) => e.pkg === pkg || e.module === pkg) ?? null;
const isBuiltin = (pkg: string) => data.value?.builtin.some((m) => m.toLowerCase() === pkg.toLowerCase()) ?? false;

const custom = ref('');
const showLog = ref(false);
const showBuiltin = ref(false);
// Windows installs ready-made DLLs: no toolkit, libraries or build steps.
const PHASES: Record<string, string> = isWin ? { download: 'Download', verify: 'Check' } : { toolkit: 'Toolkit', deps: 'Libraries', download: 'Download', build: 'Build', verify: 'Check' };
const showBundled = ref(false);
const bundledOn = computed(() => data.value?.bundled.filter((e) => e.enabled).length ?? 0);

async function install(pkg: string) {
  pkg = pkg.trim();
  if (!pkg) return;
  showLog.value = false;
  if (await attempt(() => herd.phpExtInstall(props.version, pkg).then(() => true))) {
    notify('success', `${pkg} installed for PHP ${props.version}; ${isWin ? 'PHP restarted' : 'PHP-FPM reloaded'}`);
    custom.value = '';
  }
}
async function toggle(module: string, on: boolean) {
  await attempt(() => herd.phpExtSetEnabled(props.version, module, on));
  await load();
}
async function remove(module: string) {
  await attempt(() => herd.phpExtRemove(props.version, module), `${module} removed from PHP ${props.version}`);
  await load();
}
</script>

<template>
  <div class="card">
    <div class="card-body">
      <div class="flex items-center gap-2">
        <h2 class="flex-1 font-semibold">Extensions <span class="font-normal opacity-60">· PHP {{ version }}</span></h2>
        <span v-if="data && data.supported && !data.toolkit && !isWin" class="text-xs opacity-60" title="phpize and headers for this version are prepared on the first build">first build also prepares phpize (~1 min)</span>
      </div>

      <div v-if="data && !data.supported && !isWin" class="alert alert-soft text-sm">
        Extensions can be added to DevCatz’s own PHP builds (8.x). This version comes from another tool (e.g. Homebrew): use its own <code>pecl</code>.
      </div>
      <template v-else-if="data">
        <div v-if="data.problem" role="alert" class="alert alert-warning alert-soft text-sm"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />{{ data.problem }}</div>

        <!-- Build in progress / result -->
        <div v-if="task && task.version === version" class="rounded-box border border-base-300/60 p-3">
          <div class="flex items-center gap-2 text-sm">
            <span v-if="running" class="loading loading-spinner loading-sm" />
            <span v-else-if="task.phase === 'done'" class="text-success">✓</span>
            <span v-else class="text-error">✕</span>
            <span class="font-medium">{{ task.pkg }}</span>
            <span class="min-w-0 flex-1 truncate text-xs opacity-70">{{ task.phase === 'error' ? task.error : task.detail }}</span>
            <button class="btn btn-ghost btn-xs" @click="showLog = !showLog">{{ showLog ? 'Hide' : 'Show' }} log</button>
            <button v-if="!running" class="btn btn-ghost btn-xs" @click="herd.phpExtDismiss()">Dismiss</button>
          </div>
          <ul v-if="running" class="steps steps-horizontal mt-2 w-full text-[11px]">
            <li
              v-for="(label, key) in PHASES"
              :key="key"
              class="step"
              :class="{ 'step-primary': Object.keys(PHASES).indexOf(key) <= Object.keys(PHASES).indexOf(task.phase) }"
            >
              {{ label }}
            </li>
          </ul>
          <pre v-if="showLog" class="mt-2 max-h-56 overflow-auto rounded-md bg-base-200 p-2 font-mono text-[11px] leading-snug">{{ task.log.join('\n') || '…' }}</pre>
          <div v-if="task.phase === 'error'" class="mt-1 flex gap-2">
            <button class="btn btn-xs" @click="install(task.pkg)">Try again</button>
          </div>
        </div>

        <!-- Installed by DevCatz -->
        <div v-if="data.installed.length" class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Extension</th><th>Version</th><th>Enabled</th><th class="text-right"></th></tr>
            </thead>
            <tbody>
              <tr v-for="e in data.installed" :key="e.module">
                <td class="font-mono">{{ e.module }}<span v-if="e.zend" class="badge badge-ghost badge-xs ml-1">zend</span></td>
                <td class="font-mono text-xs opacity-70">{{ e.version || '—' }}</td>
                <td><input type="checkbox" class="toggle toggle-sm toggle-primary" :checked="e.enabled" @change="toggle(e.module, ($event.target as HTMLInputElement).checked)" /></td>
                <td class="text-right"><button class="btn btn-ghost btn-xs text-error" @click="remove(e.module)">Remove</button></td>
              </tr>
            </tbody>
          </table>
        </div>

        <!-- Catalog -->
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="c in data.catalog" :key="c.pkg" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5">
                <span class="font-medium">{{ c.title }}</span>
                <span v-if="c.brew && !isWin" class="badge badge-ghost badge-xs" :title="`Uses Homebrew: ${c.brew.join(', ')} (installed when missing)`">brew</span>
              </div>
              <div class="truncate text-xs opacity-60" :title="c.description">{{ isWin ? c.description.replace(/ \(long build[^)]*\)/, '') : c.description }}</div>
            </div>
            <span v-if="isBuiltin(c.pkg)" class="text-xs opacity-60" title="Compiled into this PHP">built in</span>
            <span v-else-if="has(c.pkg)" class="text-xs opacity-60">installed</span>
            <button v-else class="btn btn-xs" :disabled="!!running || !!data.problem" @click="install(c.pkg)">Install</button>
          </div>
        </div>

        <form class="flex items-center gap-2" @submit.prevent="install(custom)">
          <input v-model="custom" class="input input-sm w-56 font-mono" placeholder="Other PECL package, e.g. apfd" spellcheck="false" />
          <button class="btn btn-sm" :disabled="!custom.trim() || !!running || !!data.problem">{{ isWin ? 'Install' : 'Build &amp; install' }}</button>
          <a class="link text-xs opacity-60" @click="herd.openUrl('https://pecl.php.net/packages.php')">Browse PECL</a>
        </form>

        <!-- Windows: the extensions that come with this PHP -->
        <div v-if="data.bundled.length" class="rounded-box border border-base-300/60 p-3">
          <div class="flex items-center gap-2">
            <span class="flex-1 text-sm font-medium">Included with PHP {{ version }} <span class="font-normal opacity-60">· {{ bundledOn }} of {{ data.bundled.length }} on</span></span>
            <button class="btn btn-ghost btn-xs" @click="showBundled = !showBundled">{{ showBundled ? 'Hide' : 'Show all' }}</button>
          </div>
          <div class="mt-2 grid gap-x-4 gap-y-1 sm:grid-cols-2 xl:grid-cols-4">
            <label v-for="e in showBundled ? data.bundled : data.bundled.filter((b) => b.enabled)" :key="e.module" class="flex cursor-pointer items-center gap-2 text-sm">
              <input type="checkbox" class="toggle toggle-xs toggle-primary" :checked="e.enabled" @change="toggle(e.module, ($event.target as HTMLInputElement).checked)" />
              <span class="font-mono">{{ e.module }}</span>
            </label>
          </div>
        </div>

        <div v-if="isWin" class="text-xs opacity-60">
          PECL extensions come as ready-made DLLs from php.net's Windows builds for PHP {{ version.split('.').slice(0, 2).join('.') }} (NTS, x64) and must load into
          this PHP to be kept; each one, and each included extension, is loaded from <code>conf.d\20-&lt;name&gt;.ini</code>. A newer patch of the same minor takes them over.
          <a class="link" @click="showBuiltin = !showBuiltin">{{ showBuiltin ? 'Hide' : 'Show' }} the {{ data.builtin.length }} built-in modules</a>
        </div>
        <div v-else class="text-xs opacity-60">
          Built from PECL source with phpize for this exact PHP version and loaded from <code>conf.d/20-&lt;name&gt;.ini</code>. A newer patch of the same minor takes
          them over when installed.
          <a class="link" @click="showBuiltin = !showBuiltin">{{ showBuiltin ? 'Hide' : 'Show' }} the {{ data.builtin.length }} built-in modules</a>
        </div>
        <div v-if="showBuiltin" class="flex flex-wrap gap-1">
          <span v-for="m in data.builtin" :key="m" class="badge badge-ghost badge-sm font-mono">{{ m }}</span>
        </div>
      </template>
      <div v-else class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Reading modules…</div>
    </div>
  </div>
</template>
