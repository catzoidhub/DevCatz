<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, onMounted, ref } from 'vue';
import type { AboutInfo } from '@shared/types';
import { attempt, herd, notify, reportDialog, state, uninstallDialog, updateDialog } from '../store';
import devcatzLogo from '../assets/logos/devcatz.svg';
import dbcatzLogo from '../assets/logos/dbcatz.png';
import dialcatzLogo from '../assets/logos/dialcatz.png';
import docatzLogo from '../assets/logos/docatz.png';

/**
 * Settings → About (Catzoid family #62; the app menu's About DevCatz opens it): the app, its slogan and version, the
 * Catzoid family, and links built from the shared site address (Catzoid/shared.json `site`), so they follow
 * dev.catzoid.tech → catzoid.com without a rebuild. GitHub points at the current repo until the public one (#52).
 * Check for Updates (#54), Report a bug / Send feedback (#65) and Uninstall DevCatz (#55) live here too.
 */
const SLOGAN = 'Finally, someone herds the cats.';
const REPO = 'https://github.com/catzoidhub/DevCatz';
const LICENCE = { name: 'GPL-3.0', url: 'https://www.gnu.org/licenses/gpl-3.0.html' };

const info = ref<AboutInfo | null>(null);
onMounted(async () => (info.value = (await attempt(() => herd.aboutInfo())) ?? null));

const arch = computed(() => (info.value?.arch === 'arm64' ? 'Apple silicon' : info.value?.arch === 'x64' ? 'Intel' : (info.value?.arch ?? '')));
const host = computed(() => (info.value ? new URL(info.value.site).host : ''));
const links = computed(() => {
  const site = info.value?.site;
  if (!site) return [];
  const v = info.value!.version;
  return [
    { label: 'DevCatz website', url: `${site}/devcatz` },
    { label: 'Docs', url: `${site}/docs` },
    { label: "What's new", url: `${REPO}/releases/tag/v${v}` },
    { label: 'GitHub', url: REPO },
    { label: 'Third-party licences', url: 'app:licenses' }, // the list shipped inside the app; also on <site>/legal/licences
  ];
});
const FAMILY: { name: string; logo: string; what: string; soon?: boolean }[] = [
  { name: 'DevCatz', logo: devcatzLogo, what: 'local dev environment' },
  { name: 'DBCatz', logo: dbcatzLogo, what: 'database viewer' },
  { name: 'DialCatz', logo: dialcatzLogo, what: 'API client' },
  { name: 'DoCatz', logo: docatzLogo, what: 'container manager', soon: true },
];

const u = computed(() => state.value?.appUpdate ?? null);
// as DBCatz and DialCatz: the dialog opens at once and shows the check (Looking… / up to date / the new version)
function checkForUpdates() {
  updateDialog.value = true;
  if (!['available', 'downloading', 'downloaded'].includes(u.value?.status ?? '')) void attempt(() => herd.appUpdateCheck());
}

function copyDetails() {
  const i = info.value;
  if (!i) return;
  void navigator.clipboard.writeText(`DevCatz ${i.version} (${i.arch})\n${words.os} ${i.macos}\nElectron ${i.electron} · Chromium ${i.chrome} · Node.js ${i.node}`);
  notify('success', 'Version details copied');
}
</script>

<template>
  <div class="card">
    <div class="card-body items-center gap-5 py-8 text-center">
      <img :src="devcatzLogo" alt="" class="size-24 drop-shadow-md" draggable="false" />
      <div class="space-y-1.5">
        <h2 class="text-2xl font-semibold tracking-tight">DevCatz</h2>
        <p class="text-sm italic opacity-70">{{ SLOGAN }}</p>
        <p class="selectable text-sm opacity-60">
          Version {{ info?.version ?? '…' }}<template v-if="arch"> · {{ arch }}</template>
        </p>
      </div>
      <div class="flex flex-wrap justify-center gap-1.5">
        <button v-for="l in links" :key="l.label" class="btn btn-ghost btn-sm" @click="herd.openUrl(l.url)">{{ l.label }}</button>
      </div>
      <div class="flex flex-wrap justify-center gap-2">
        <button
          v-if="u?.status === 'available' || u?.status === 'downloading' || u?.status === 'downloaded'"
          class="btn btn-primary btn-sm"
          @click="updateDialog = true"
        >
          {{ u.status === 'downloaded' ? 'Restart to update' : `Update to ${u.version}` }}
        </button>
        <button v-else class="btn btn-sm" @click="checkForUpdates">Check for Updates</button>
        <button class="btn btn-sm" @click="reportDialog = 'bug'">Report a bug</button>
        <button class="btn btn-sm" @click="reportDialog = 'idea'">Send feedback</button>
      </div>
      <p class="text-xs opacity-55">
        Free and open source under the
        <a class="link" @click="herd.openUrl(LICENCE.url)">{{ LICENCE.name }}</a> licence.
      </p>
    </div>
  </div>

  <div class="card">
    <div class="card-body gap-3">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Part of the Catzoid family</h2>
        <span class="flex-1" />
        <button v-if="info" class="btn btn-ghost btn-xs" @click="herd.openUrl(info.site)">{{ host }}</button>
      </div>
      <ul class="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
        <li v-for="f in FAMILY" :key="f.name" class="flex items-center gap-2.5 rounded-box border border-base-300/60 bg-base-200/40 px-3 py-2">
          <img :src="f.logo" alt="" class="size-8 shrink-0" draggable="false" />
          <span class="min-w-0">
            <span class="flex items-center gap-1.5 text-sm font-medium leading-tight">{{ f.name }}<span v-if="f.soon" class="badge badge-ghost badge-xs">soon</span></span>
            <span class="block text-[11px] leading-tight opacity-55">{{ f.what }}</span>
          </span>
        </li>
      </ul>
      <p class="text-xs opacity-55">Links follow the Catzoid site address shared by the Catzoid apps ({{ host || '…' }}).</p>
    </div>
  </div>

  <div class="card">
    <div class="card-body gap-3">
      <div class="flex items-center gap-2">
        <h2 class="font-semibold">Details</h2>
        <span class="flex-1" />
        <button class="btn btn-ghost btn-xs" :disabled="!info" @click="copyDetails">Copy</button>
      </div>
      <dl v-if="info" class="selectable grid grid-cols-[auto_1fr] gap-x-6 gap-y-1.5 text-sm">
        <dt class="opacity-60">{{ words.os }}</dt><dd class="font-mono text-xs leading-5">{{ info.macos }}</dd>
        <dt class="opacity-60">Electron</dt><dd class="font-mono text-xs leading-5">{{ info.electron }}</dd>
        <dt class="opacity-60">Chromium</dt><dd class="font-mono text-xs leading-5">{{ info.chrome }}</dd>
        <dt class="opacity-60">Node.js</dt><dd class="font-mono text-xs leading-5">{{ info.node }}</dd>
        <dt class="opacity-60">Data folder</dt><dd class="font-mono text-xs leading-5 break-all">{{ info.dataDir }}</dd>
      </dl>
    </div>
  </div>

  <div class="card">
    <div class="card-body flex-row flex-wrap items-center gap-3">
      <div class="min-w-0 flex-1">
        <h2 class="font-semibold">Uninstall DevCatz</h2>
        <p class="text-xs opacity-60">Stops everything, removes what DevCatz put on this {{ words.computer }} (port forwarding{{ words.computer === 'Mac' ? ', DNS files' : '' }}, its certificate authority) and {{ words.computer === 'PC' ? 'runs its uninstaller' : 'moves it to the Trash' }}. Your projects stay.</p>
      </div>
      <button class="btn btn-sm btn-outline btn-error" @click="uninstallDialog = true">Uninstall DevCatz…</button>
    </div>
  </div>
</template>
