<script setup lang="ts">
import { words } from '@shared/platform';
import { computed, onMounted, ref, watch } from 'vue';
import type { PhpIniSettings, RemotePhp } from '@shared/types';
import PageHeader from './PageHeader.vue';
import PhpExtensionsCard from './PhpExtensionsCard.vue';
import { ICONS } from '../icons';
import UpdateButton from './UpdateButton.vue';
import { attempt, herd, notify, state, askConfirm } from '../store';
import CatMood from './CatMood.vue';
import { isWin } from '../platform';

/** What serves PHP sites: PHP-FPM on macOS, php-cgi workers (FastCGI) on Windows. */
const FPM = isWin ? 'PHP (FastCGI)' : 'PHP-FPM';


const s = computed(() => state.value!);
/** Update badges on the tabs: newer versions of this runtime (Installed), newer tool releases (Tools). */
const versionUpdates = computed(() => s.value.updates.list.filter((u) => u.runtime === 'php').length);
const toolUpdates = computed(() => s.value.toolUpdates.filter((u) => u.page === 'php').length);
const php = computed(() => s.value.php);
const remote = ref<RemotePhp[]>([]);
const loadingRemote = ref(false);

async function loadRemote(refresh = false) {
  loadingRemote.value = true;
  const list = await attempt(() => herd.phpRemote(refresh));
  if (list) remote.value = list;
  loadingRemote.value = false;
}
onMounted(() => loadRemote());

const hasMinor = (m: string) => php.value.installed.some((i) => i.version.startsWith(`${m}.`));
/** php.net's newer release of an installed version's line that static-php.dev has not built yet (a note, not an update). */
const newer = (a: string, b: string) => {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};
const upstreamFor = (version: string) => {
  const r = remote.value.find((x) => version.startsWith(`${x.minor}.`) && x.upstream);
  return r?.upstream && newer(r.upstream.version, version) ? r.upstream : null;
};
/** Where DevCatz's PHP builds come from: php.net's Windows builds, or static-php.dev on macOS. */
const SOURCE = isWin ? "php.net's Windows builds" : 'static-php.dev';
const upstreamTitle = (u: NonNullable<RemotePhp['upstream']>, built: string) =>
  `PHP ${u.version} was released on php.net${u.date ? ` (${u.date})` : ''}${u.security ? ' with security fixes' : ''}. DevCatz installs PHP from ${SOURCE}, which ${isWin ? 'have' : 'has'} built up to ${built} so far; the update appears here once ${u.version} is built.`;
const isInstalled = (v: string) => php.value.installed.some((i) => i.version === v);
const usedBy = (version: string) => s.value.projects.filter((p) => p.stack.runtime === 'php' && p.php.version === version).map((p) => p.name);
const fpmFor = (version: string) => php.value.fpm.find((f) => f.version === version);
const phpSites = computed(() => s.value.projects.filter((p) => p.stack.runtime === 'php'));

const busy = computed(() => {
  const i = php.value.installing;
  return i && i.phase !== 'done' && i.phase !== 'error' ? i : null;
});
const percent = computed(() => (busy.value?.total ? Math.round((busy.value.received / busy.value.total) * 100) : 0));

async function install(version: string, makeDefault = false) {
  await attempt(() => herd.phpInstall(version));
  const fresh = await herd.getState();
  // A Homebrew install is asked for by minor ("7.4") and lands as e.g. 7.4.33.
  const got = fresh.php.installed.find((i) => i.version === version || i.version.startsWith(`${version}.`));
  if (!got) return;
  if (makeDefault) await attempt(() => herd.phpSetDefault(got.version));
  notify('success', `PHP ${got.version} installed`);
}
const setDefault = (version: string | null) => attempt(() => herd.phpSetDefault(version));
async function uninstall(version: string) {
  if (await askConfirm({ title: `Uninstall PHP ${version}?`, text: `Its ${words.phpServer} ${isWin ? 'workers stop' : 'pool stops'}; sites using it fall back to another installed version.`, confirm: 'Uninstall' })) await attempt(() => herd.phpUninstall(version));
}
const installComposer = () => attempt(() => herd.composerInstall(), 'Composer installed');

// ---- php.ini
const iniVersion = ref('');
/** The editor shows the default version until the user picks another one (and follows a new default). */
let pinnedIni = false;
watch(
  () => [php.value.defaultVersion, php.value.installed.map((i) => i.version).join()],
  ([def]) => {
    const exists = php.value.installed.some((i) => i.version === iniVersion.value);
    if (!exists || !pinnedIni) iniVersion.value = (def as string | null) ?? php.value.installed[0]?.version ?? '';
    if (!exists) pinnedIni = false;
  },
  { immediate: true },
);
const pickIni = (v: string) => {
  iniVersion.value = v;
  pinnedIni = v !== php.value.defaultVersion;
};
const openIni = () => attempt(() => herd.phpOpenIni(iniVersion.value));
const ini = ref<PhpIniSettings | null>(null);
const effective = ref<Record<string, string>>({});
async function loadIni() {
  if (!iniVersion.value) return;
  const r = await attempt(() => herd.phpGetIni(iniVersion.value));
  if (r) {
    ini.value = { ...r.settings };
    effective.value = r.effective;
  }
}
watch(iniVersion, loadIni, { immediate: true });
async function saveIni() {
  if (!ini.value) return;
  await attempt(() => herd.phpSetIni(iniVersion.value, { ...ini.value! }), `php.ini saved; ${FPM} ${iniVersion.value} reloaded`);
  await loadIni();
}
/** CLI-only differences (max_execution_time is always 0 on the CLI) and equivalent spellings are not "different". */
const CLI_ONLY = new Set(['max_execution_time', 'error_reporting']);
const norm = (v: string) => {
  const x = (v ?? '').trim().toLowerCase();
  return x === 'on' || x === 'true' || x === 'yes' ? '1' : x === 'off' || x === 'false' || x === 'no' || x === '' ? '0' : x;
};
function differs(key: string): boolean {
  if (!ini.value || CLI_ONLY.has(key) || effective.value[key] === undefined) return false;
  return norm(effective.value[key]) !== norm(String(ini.value[key as keyof PhpIniSettings]));
}

const FIELDS: { key: Exclude<keyof PhpIniSettings, 'extra'>; label: string; hint?: string }[] = [
  { key: 'memory_limit', label: 'memory_limit', hint: 'e.g. 512M, -1 = unlimited' },
  { key: 'upload_max_filesize', label: 'upload_max_filesize' },
  { key: 'post_max_size', label: 'post_max_size', hint: '≥ upload_max_filesize' },
  { key: 'max_execution_time', label: 'max_execution_time', hint: 'seconds, 0 = unlimited' },
  { key: 'max_input_vars', label: 'max_input_vars' },
  { key: 'display_errors', label: 'display_errors', hint: 'On / Off' },
  { key: 'error_reporting', label: 'error_reporting', hint: 'E_ALL' },
  { key: 'date.timezone', label: 'date.timezone' },
  { key: 'opcache.enable', label: 'opcache.enable', hint: '1 / 0' },
];

type Tab = 'installed' | 'ini' | 'extensions' | 'available';
const tab = ref<Tab>('installed');
</script>

<template>
  <PageHeader title="PHP" :closable="false" tint="runtimes" :icon="ICONS.php">
    <p class="text-xs opacity-60">
      <template v-if="isWin">
        Official PHP builds from php.net's Windows downloads (NTS x64, Laravel's usual extensions turned on). PHP sites are served by a few
        php-cgi workers per version (FastCGI), always on.
      </template>
      <template v-else>
        Static PHP builds from static-php.dev (CLI + FPM, Laravel's usual extensions). PHP sites are served by one PHP-FPM pool per
        version, always on; PHP installed by other tools such as Homebrew (e.g. 7.4 for older apps) is usable too.
      </template>
    </p>
    <div class="no-drag mt-3 flex flex-wrap items-center gap-3">
      <div role="tablist" class="seg">
        <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'installed' }" @click="tab = 'installed'">Installed<span v-if="versionUpdates" class="badge badge-info badge-xs ml-1" title="A newer version is out">{{ versionUpdates }}</span></a>
        <a role="tab" class="seg-item normal-case" :class="{ 'is-active': tab === 'ini' }" @click="tab = 'ini'">php.ini</a>
        <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'extensions' }" @click="tab = 'extensions'">Extensions</a>
        <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'available' }" @click="tab = 'available'">Available</a>
      </div>
      <span class="flex-1" />
      <!-- One version for the php.ini and Extensions tabs (they edit the same install). -->
      <label v-if="(tab === 'ini' || tab === 'extensions') && php.installed.length" class="flex items-center gap-2 rounded-box border border-primary/40 bg-primary/10 py-1 pr-1 pl-3">
        <span class="label-caps text-primary">PHP version</span>
        <select :value="iniVersion" class="select select-sm select-primary w-40 font-mono" @change="pickIni(($event.target as HTMLSelectElement).value)">
          <option v-for="v in php.installed" :key="v.version" :value="v.version">{{ v.version }}{{ v.source === 'herd' ? ' · Herd' : v.source === 'homebrew' ? ' · Homebrew' : '' }}</option>
        </select>
      </label>
    </div>
  </PageHeader>

  <section class="site-tab">
    <div v-if="!php.installed.some((i) => i.source === 'mrcatz')" role="alert" class="alert flex flex-wrap">
      <div class="min-w-48 flex-1">
        <div class="font-medium">No PHP installed by DevCatz yet</div>
        <div class="text-xs opacity-80">
          {{ phpSites.length }} PHP site(s).
          <template v-if="php.installed.length">PHP {{ php.installed[0].version }} (installed by another tool) is used meanwhile.</template>
        </div>
      </div>
      <button v-if="remote.find((r) => r.minor === '8.4')" class="btn btn-sm btn-primary shrink-0" :disabled="!!busy" @click="install(remote.find((r) => r.minor === '8.4')!.version, true)">
        Install PHP {{ remote.find((r) => r.minor === '8.4')!.version }}
      </button>
    </div>

    <template v-if="tab === 'installed'">
    <!-- Installed -->
    <div class="card">
      <div class="card-body">
        <h2 class="font-semibold">Installed</h2>
        <div class="overflow-x-auto rounded-box border border-base-300/60">
          <table class="table table-sm">
            <thead>
              <tr><th>Version</th><th></th><th>{{ FPM }}</th><th>Used by</th><th class="text-right">Actions</th></tr>
            </thead>
            <tbody>
              <tr v-for="v in php.installed" :key="v.version + v.source">
                <td class="whitespace-nowrap">
                  <div class="font-mono">{{ v.version }}</div>
                  <div v-if="upstreamFor(v.version)" class="mt-0.5 flex items-center gap-1 text-[11px] text-warning" :title="upstreamTitle(upstreamFor(v.version)!, remote.find((r) => v.version.startsWith(`${r.minor}.`))?.version ?? v.version)">
                    <svg viewBox="0 0 20 20" class="size-3 shrink-0" fill="currentColor"><path fill-rule="evenodd" d="M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Zm-7-4a1 1 0 1 1-2 0 1 1 0 0 1 2 0ZM9 9a.75.75 0 0 0 0 1.5h.25v3.25a.75.75 0 0 0 1.5 0V9.75A.75.75 0 0 0 10 9H9Z" clip-rule="evenodd" /></svg>
                    {{ upstreamFor(v.version)!.version }} on php.net, not built yet
                  </div>
                </td>
                <td>
                  <div class="flex flex-wrap items-center gap-1">
                  <span v-if="php.defaultVersion === v.version" class="badge badge-primary badge-soft badge-sm whitespace-nowrap">default</span>
                  <span v-if="v.source === 'herd'" class="badge badge-ghost badge-sm whitespace-nowrap">Laravel Herd</span>
                  <span v-if="v.source === 'homebrew'" class="badge badge-ghost badge-sm whitespace-nowrap" title="Installed with Homebrew; update or remove it with brew">Homebrew</span>
                  </div>
                </td>
                <td>
                  <span v-if="fpmFor(v.version)" class="badge badge-sm" :class="fpmFor(v.version)!.running ? 'badge-success' : 'badge-error'" :title="fpmFor(v.version)!.error ?? ''">
                    {{ fpmFor(v.version)!.running ? 'running' : 'down' }}
                  </span>
                  <span v-else class="text-xs opacity-50">idle</span>
                </td>
                <td class="text-xs opacity-70">{{ usedBy(v.version).join(', ') || '—' }}</td>
                <td class="text-right whitespace-nowrap">
                  <UpdateButton runtime="php" :version="v.version" />
                  <button v-if="php.defaultVersion !== v.version" class="btn btn-xs btn-ghost" @click="setDefault(v.version)">Make default</button>
                  <button v-if="v.source === 'mrcatz'" class="btn btn-xs btn-ghost text-error" @click="uninstall(v.version)">Uninstall</button>
                </td>
              </tr>
              <tr v-if="!php.installed.length">
                <td colspan="5" class="text-center opacity-60">None yet.</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div class="flex flex-wrap items-center gap-3 text-xs">
          <span class="opacity-70">Composer:</span>
          <span v-if="php.composer" class="badge badge-success badge-sm">installed</span>
          <button v-else class="btn btn-xs" @click="installComposer">Install Composer</button>
          <span class="opacity-60">(<code>php</code> and <code>composer</code> shims live next to the Node.js ones)</span>
        </div>
      </div>
    </div>

    </template>
    <!-- Progress -->
    <div v-if="busy" class="alert">
      <span class="loading loading-spinner loading-sm" />
      <div class="flex-1">
        <div class="text-sm">
          {{ busy.phase === 'extract' ? 'Unpacking' : 'Downloading' }} {{ busy.version === 'composer' ? 'Composer' : `PHP ${busy.version}` }}…
          <span v-if="busy.detail" class="block truncate font-mono text-xs opacity-60">{{ busy.detail }}</span>
          <span v-else-if="busy.total" class="opacity-60">{{ (busy.received / 1048576).toFixed(1) }} / {{ (busy.total / 1048576).toFixed(1) }} MB</span>
        </div>
        <progress v-if="busy.detail" class="progress progress-primary w-full" />
        <progress v-else class="progress progress-primary w-full" :value="busy.phase === 'extract' ? 100 : percent" max="100" />
      </div>
      <button class="btn btn-ghost btn-sm" title="Stop the download / install" @click="herd.installCancel(busy.version === 'composer' ? 'composer' : 'php')">Cancel</button>
    </div>
    <div v-else-if="php.installing?.phase === 'error'" class="alert alert-error text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />
      Installing {{ php.installing.version }} failed: {{ php.installing.error }}
    </div>

    <template v-if="tab === 'ini'">
    <!-- php.ini -->
    <div v-if="php.installed.length && ini" class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 font-semibold">php.ini <span class="font-normal opacity-60">· PHP {{ iniVersion }}</span></h2>
          <button class="btn btn-ghost btn-xs" title="Open this version's php.ini folder (php.ini + conf.d) in your editor" @click="openIni">Open php.ini</button>
        </div>
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <label v-for="f in FIELDS" :key="f.key" class="block">
            <span class="mb-1 flex items-center gap-1 font-mono text-xs opacity-70">
              {{ f.label }}
              <span v-if="differs(f.key)" class="badge badge-warning badge-xs" title="Value PHP reports right now (saved but not yet active?)">now {{ effective[f.key] || '""' }}</span>
            </span>
            <input v-model="ini[f.key]" class="input input-sm w-full font-mono" :placeholder="f.hint" />
          </label>
        </div>
        <label class="block">
          <span class="mb-1 block text-xs opacity-70">Other directives (one per line)</span>
          <textarea v-model="ini.extra" rows="3" class="textarea textarea-sm w-full font-mono" placeholder="xdebug.mode = debug" />
        </label>
        <div class="flex items-center gap-2">
          <button class="btn btn-primary btn-sm" @click="saveIni">Save &amp; reload {{ FPM }}</button>
          <span class="text-xs opacity-60">Validated with <code>php</code> before saving; written to <code>conf.d/99-mrcatz.ini</code> (the bundled php.ini is untouched).</span>
        </div>
      </div>
    </div>

    </template>
    <template v-if="tab === 'extensions'">
    <!-- Extensions (same version as the php.ini editor) -->
    <PhpExtensionsCard v-if="iniVersion" :version="iniVersion" />

    </template>
    <template v-if="tab === 'available'">
    <!-- Available -->
    <div class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <h2 class="flex-1 font-semibold">Available</h2>
          <button class="btn btn-ghost btn-xs" :disabled="loadingRemote" @click="loadRemote(true)">
            <span v-if="loadingRemote" class="loading loading-spinner loading-xs" />Refresh
          </button>
        </div>
        <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
          <div v-for="(r, i) in remote" :key="r.version" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
            <div class="min-w-0 flex-1">
              <div class="font-medium">
                PHP {{ r.minor }}
                <span v-if="i === 0" class="badge badge-success badge-xs ml-1">latest</span>
              </div>
              <div v-if="r.via === 'homebrew'" class="text-xs opacity-60" title="static-php.dev builds PHP 8 only; this one comes from the shivammathur/php Homebrew tap">via Homebrew</div>
              <div v-else class="font-mono text-xs opacity-60">{{ r.version }}</div>
              <div v-if="r.upstream" class="mt-1.5 text-[11px]" :title="upstreamTitle(r.upstream, r.version)">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-medium text-warning">php.net: {{ r.upstream.version }}</span>
                  <span class="opacity-55">· {{ r.upstream.date }}</span>
                  <span v-if="r.upstream.security" class="badge badge-warning badge-soft badge-xs">security</span>
                </div>
                <div class="mt-0.5 opacity-55">not built by {{ SOURCE }} yet</div>
              </div>
            </div>
            <span v-if="r.via === 'homebrew' ? hasMinor(r.minor) : isInstalled(r.version)" class="text-xs opacity-60">installed</span>
            <button v-else class="btn btn-xs" :disabled="!!busy" @click="install(r.version)">Install</button>
          </div>
        </div>
        <p v-if="!isWin" class="text-xs opacity-60">
          PHP 7.x and 5.6 are not built by static-php.dev; <b>Install</b> runs <code>brew install shivammathur/php/php@7.x</code> (needs Homebrew) and
          DevCatz then uses Homebrew's PHP and PHP-FPM like its own.
        </p>
        <p v-if="remote.some((r) => r.upstream)" class="text-xs text-warning">
          php.net has newer releases than {{ SOURCE }} {{ isWin ? 'have' : 'has' }} built so far. DevCatz installs PHP from {{ SOURCE }} only; the newer
          versions show here, and as updates under Installed, once they are built.
        </p>
        <p v-if="isWin" class="text-xs opacity-60">
          Every download is checked against the SHA-256 that php.net publishes for it (<code>releases.json</code>); the digest is recorded in
          <code>SHA256SUMS</code> next to the binaries.
        </p>
        <p v-else class="text-xs opacity-60">static-php.dev publishes no checksums: downloads use HTTPS, the binary must report the expected version, and the SHA-256 is recorded in <code>SHA256SUMS</code> next to it.</p>
      </div>
    </div>
    </template>
  </section>
</template>
