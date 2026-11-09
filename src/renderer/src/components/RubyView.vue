<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { RemoteRuby } from '@shared/types';
import { words } from '@shared/platform';
import PageHeader from './PageHeader.vue';
import { STACK_ICONS } from '../stackicons';
import { isWin } from '../platform';
import { attempt, herd, notify, state, askConfirm } from '../store';
import CatMood from './CatMood.vue';
import GitConnectButton from './GitConnectButton.vue';

/** Ruby versions (TODO §37): rv for 3.2 and newer (prebuilt, seconds), ruby-build for older ones (compiled, minutes). */

const s = computed(() => state.value!);
const b = computed(() => s.value.ruby);
const remote = ref<RemoteRuby[]>([]);
const loadingRemote = ref(false);

async function loadRemote() {
  if (!b.value.rv) return;
  loadingRemote.value = true;
  const list = await attempt(() => herd.rubyRemote());
  if (list) remote.value = list;
  loadingRemote.value = false;
}
onMounted(loadRemote);

const isInstalled = (v: string) => b.value.installed.some((i) => i.version === v && i.source === 'mrcatz');
const rbSites = computed(() => s.value.projects.filter((p) => p.stack.runtime === 'ruby' || p.stack.subRuntimes?.includes('ruby')));
const usedBy = (version: string) => rbSites.value.filter((p) => p.ruby.version === version).map((p) => p.name);

const busy = computed(() => {
  const i = b.value.installing;
  return i && i.phase !== 'done' && i.phase !== 'error' ? i : null;
});
const percent = computed(() => (busy.value?.total ? Math.round((busy.value.received / busy.value.total) * 100) : 0));

async function installRv() {
  if (await attempt(() => herd.rvInstall().then(() => true))) {
    notify('success', 'rv installed');
    await loadRemote();
  }
}
async function install(r: RemoteRuby) {
  if (r.via === 'ruby-build') {
    const ok = await askConfirm({
      title: `Compile Ruby ${r.version}?`,
      text: `Ruby ${r.minor} has no prebuilt build, so ruby-build compiles it here. That takes several minutes and needs ${words.buildTools}${
        isWin ? '' : ' and OpenSSL / libyaml'
      } (DevCatz asks for what is missing).`,
      confirm: 'Compile',
      tone: 'primary',
    });
    if (!ok) return;
  }
  if (await attempt(() => herd.rubyInstall(r.version, r.via).then(() => true))) notify('success', `Ruby ${r.version} installed`);
}
const setDefault = (version: string | null) => attempt(() => herd.rubySetDefault(version));
async function uninstall(version: string) {
  const sites = usedBy(version);
  if (
    await askConfirm({
      title: `Uninstall Ruby ${version}?`,
      text: `Its gems go with it (they live inside that Ruby).${sites.length ? ` ${sites.join(', ')} use it: they need another Ruby and "Install dependencies" again.` : ''}`,
      confirm: 'Uninstall',
    })
  )
    await attempt(() => herd.rubyUninstall(version));
}

type Tab = 'installed' | 'available';
const tab = ref<Tab>('installed');
</script>

<template>
  <PageHeader title="Ruby" :closable="false" tint="runtimes" :icon="STACK_ICONS.ruby.d" icon-view-box="0 0 24 24">
    <p class="text-xs opacity-60">
      Managed with <a class="link" @click="herd.openUrl('https://rv.dev')">rv</a>: prebuilt Rubies (3.2 and newer) in DevCatz’s folder in seconds;
      <template v-if="!isWin">older ones are compiled with <a class="link" @click="herd.openUrl('https://github.com/rbenv/ruby-build')">ruby-build</a>.</template>
      Each Ruby keeps its own gems; a site’s gems come from its Gemfile with <code>bundle install</code>.
    </p>
    <div role="tablist" class="seg no-drag mt-3">
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'installed' }" @click="tab = 'installed'">Installed</a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'available' }" @click="tab = 'available'">Available</a>
    </div>
  </PageHeader>

  <section class="site-tab">
    <div v-if="!b.rv" role="alert" class="alert flex flex-wrap">
      <div class="min-w-48 flex-1">
        <div class="font-medium">rv is not installed yet</div>
        <div class="text-xs opacity-80">
          DevCatz downloads rv (one small program by the Bundler / RubyGems team, SHA-256 checked); it then installs Rubies. {{ rbSites.length }} Ruby site(s) linked.
        </div>
      </div>
      <button class="btn btn-sm btn-primary shrink-0" :disabled="!!busy" @click="installRv">Install rv</button>
    </div>

    <!-- Progress -->
    <div v-if="busy" class="alert">
      <span class="loading loading-spinner loading-sm" />
      <div class="flex-1">
        <div class="text-sm">
          Installing {{ /^(rv|ruby-build)/.test(busy.version) ? busy.version : `Ruby ${busy.version}` }}…
          <span v-if="busy.total" class="opacity-60">{{ (busy.received / 1048576).toFixed(1) }} / {{ (busy.total / 1048576).toFixed(1) }} MB</span>
          <span v-else-if="busy.detail" class="font-mono text-xs opacity-60">{{ busy.detail }}</span>
        </div>
        <progress class="progress progress-primary w-full" :value="busy.total ? percent : undefined" max="100" />
      </div>
      <button class="btn btn-ghost btn-sm" title="Stop the download / install" @click="herd.installCancel('ruby')">Cancel</button>
    </div>
    <div v-else-if="b.installing?.phase === 'error'" class="alert alert-error text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />Installing {{ b.installing.version }} failed: {{ b.installing.error }}<GitConnectButton :text="b.installing.error" /></div>

    <template v-if="tab === 'installed'">
      <div class="card">
        <div class="card-body">
          <div class="flex items-center gap-2">
            <h2 class="flex-1 font-semibold">Installed</h2>
            <span v-if="b.rv" class="badge badge-ghost badge-sm font-mono">rv {{ b.rv }}</span>
          </div>
          <div class="overflow-x-auto rounded-box border border-base-300/60">
            <table class="table table-sm">
              <thead>
                <tr><th>Version</th><th></th><th>Used by</th><th class="text-right">Actions</th></tr>
              </thead>
              <tbody>
                <tr v-for="v in b.installed" :key="v.version + v.source">
                  <td class="font-mono whitespace-nowrap">{{ v.version }}</td>
                  <td>
                    <div class="flex flex-wrap items-center gap-1">
                      <span v-if="b.defaultVersion === v.version" class="badge badge-primary badge-soft badge-sm whitespace-nowrap">default</span>
                      <span v-if="v.source === 'system'" class="badge badge-ghost badge-sm whitespace-nowrap" :title="v.path">your own</span>
                    </div>
                  </td>
                  <td class="text-xs opacity-70">{{ usedBy(v.version).join(', ') || '—' }}</td>
                  <td class="text-right whitespace-nowrap">
                    <button v-if="b.defaultVersion !== v.version && v.source === 'mrcatz'" class="btn btn-xs btn-ghost" @click="setDefault(v.version)">Make default</button>
                    <button v-if="v.source === 'mrcatz'" class="btn btn-xs btn-ghost text-error" @click="uninstall(v.version)">Uninstall</button>
                  </td>
                </tr>
                <tr v-if="!b.installed.length">
                  <td colspan="4" class="text-center opacity-60">{{ b.rv ? 'None yet: install one from Available.' : 'Install rv first.' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p class="text-xs opacity-60">
            A site runs with the Ruby it asks for (<code>.ruby-version</code>, <code>.tool-versions</code> or the Gemfile’s <code>ruby</code>), else the default.
          </p>
          <p class="text-xs opacity-60">
            <code>ruby</code>, <code>gem</code>, <code>bundle</code>, <code>irb</code>, <code>rake</code> and <code>rv</code> for your terminal: shims for the default version next to
            the Node.js ones (Node.js → Terminal).
          </p>
        </div>
      </div>
    </template>
    <template v-if="tab === 'available'">
      <div v-if="b.rv" class="card">
        <div class="card-body">
          <div class="flex items-center gap-2">
            <h2 class="flex-1 font-semibold">Available</h2>
            <button class="btn btn-ghost btn-xs" :disabled="loadingRemote" @click="loadRemote">
              <span v-if="loadingRemote" class="loading loading-spinner loading-xs" />Refresh
            </button>
          </div>
          <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <div v-for="(r, i) in remote" :key="r.minor" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="font-medium">
                  Ruby {{ r.minor }}
                  <span v-if="i === 0" class="badge badge-success badge-xs ml-1">latest</span>
                  <span v-if="r.via === 'ruby-build'" class="badge badge-ghost badge-xs ml-1" title="No prebuilt build: compiled here, takes minutes">compiled</span>
                </div>
                <div class="font-mono text-xs opacity-60">{{ r.version }}</div>
              </div>
              <span v-if="isInstalled(r.version)" class="text-xs opacity-60">installed</span>
              <button v-else class="btn btn-xs" :disabled="!!busy" @click="install(r)">Install</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="alert text-sm">Install rv first (above): it lists and installs the Rubies.</div>
    </template>
  </section>
</template>
