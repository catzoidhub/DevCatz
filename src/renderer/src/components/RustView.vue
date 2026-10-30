<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import type { RemoteRust, RustToolId } from '@shared/types';
import PageHeader from './PageHeader.vue';
import { STACK_ICONS } from '../stackicons';
import { attempt, herd, notify, state, runtimeTabRequest, askConfirm } from '../store';
import CatMood from './CatMood.vue';
import ConfirmDialog from './ConfirmDialog.vue';

/**
 * Rust through rustup in its standard place (~/.rustup, ~/.cargo): toolchains, the WebAssembly target, and the CLIs
 * Rust frameworks run with (trunk, dx, cargo-leptos, cargo-tauri), plus Solana and Anchor for Anchor programs.
 */

const s = computed(() => state.value!);
/** Update badges on the tabs: newer versions of this runtime (Installed), newer tool releases (Tools). */
// uv and rustup keep their own versions current: no version updates tracked here.
const versionUpdates = computed(() => 0);
const toolUpdates = computed(() => s.value.toolUpdates.filter((u) => u.page === 'rust').length);
const b = computed(() => s.value.rust);
const remote = ref<RemoteRust[]>([]);
const loadingRemote = ref(false);

async function loadRemote(refresh = false) {
  loadingRemote.value = true;
  const list = await attempt(() => herd.rustRemote(refresh));
  if (list) remote.value = list;
  loadingRemote.value = false;
}
onMounted(() => loadRemote());

const rustSites = computed(() => s.value.projects.filter((p) => p.stack.apps.some((a) => a.framework === 'rust' || a.library === 'tauri')));
const usedBy = (channel: string) => rustSites.value.filter((p) => p.rust.toolchain && (channel === p.rust.toolchain || channel.startsWith(`${p.rust.toolchain}-`))).map((p) => p.name);
const isInstalled = (name: string) => b.value.toolchains.some((t) => t.channel === name || t.channel.startsWith(`${name}-`));
const wasm = computed(() => b.value.targets.includes('wasm32-unknown-unknown'));
/** Sites that need a tool (or the wasm32 target) that is not installed. */
const neededBy = (id: RustToolId | 'wasm32') => rustSites.value.filter((p) => p.rust.needs.includes(id)).map((p) => p.name);

const busy = computed(() => {
  const i = b.value.installing;
  return i && i.phase !== 'done' && i.phase !== 'error' ? i : null;
});
const percent = computed(() => (busy.value?.total ? Math.round((busy.value.received / busy.value.total) * 100) : 0));

async function installRust() {
  if (await attempt(() => herd.rustInstall().then(() => true))) {
    notify('success', 'Rust installed');
    await loadRemote();
  }
}
async function installToolchain(name: string) {
  if (await attempt(() => herd.rustToolchainInstall(name).then(() => true))) notify('success', `Rust ${name} installed`);
}
async function addWasm() {
  if (await attempt(() => herd.rustTargetAdd('wasm32-unknown-unknown').then(() => true))) notify('success', 'WebAssembly target added');
}
async function installTool(id: RustToolId, label: string, update = false) {
  if (await attempt(() => herd.rustToolInstall(id).then(() => true))) notify('success', `${label} ${update ? 'updated' : 'installed'}`);
  if (update) await herd.rustToolsCheck();
}
const setDefault = (name: string) => attempt(() => herd.rustSetDefault(name));
async function uninstall(name: string) {
  if (await askConfirm({ title: `Uninstall the Rust toolchain ${name}?`, text: `rustup removes it; projects that ask for it in rust-toolchain.toml download it again on their next build.`, confirm: 'Uninstall' })) await attempt(() => herd.rustToolchainUninstall(name));
}

type Tab = 'installed' | 'available' | 'tools';
const tab = ref<Tab>('installed');
// The tool-update notification opens the Tools tab.
watch(runtimeTabRequest, (t) => {
  if (t === 'tools') {
    tab.value = 'tools';
    runtimeTabRequest.value = null;
  }
}, { immediate: true });
const checking = ref(false);
const askUninstall = ref<{ id: RustToolId; label: string } | null>(null);
async function uninstallTool(t: { id: RustToolId; label: string }) {
  askUninstall.value = null;
  await attempt(() => herd.rustToolUninstall(t.id), `${t.label} removed`);
}
async function checkTools() {
  checking.value = true;
  await attempt(() => herd.rustToolsCheck());
  checking.value = false;
}
</script>

<template>
  <PageHeader title="Rust" :closable="false" tint="runtimes" :icon="STACK_ICONS.rust.d" icon-view-box="0 0 24 24">
    <p class="text-xs opacity-60">
      Managed with <a class="link" @click="herd.openUrl('https://rustup.rs')">rustup</a> in its usual place (<code>~/.rustup</code>, <code>~/.cargo</code>), so your editor and
      terminal use the same toolchains. A project’s <code>rust-toolchain.toml</code> picks its own.
    </p>
    <div role="tablist" class="seg no-drag mt-3">
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'installed' }" @click="tab = 'installed'">Installed<span v-if="versionUpdates" class="badge badge-info badge-xs ml-1" title="A newer version is out">{{ versionUpdates }}</span></a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'available' }" @click="tab = 'available'">Available</a>
      <a role="tab" class="seg-item" :class="{ 'is-active': tab === 'tools' }" @click="tab = 'tools'">Tools<span v-if="toolUpdates" class="badge badge-info badge-xs ml-1" title="Tool updates available">{{ toolUpdates }}</span></a>
    </div>
  </PageHeader>

  <section class="site-tab">
    <div v-if="!b.rustup" role="alert" class="alert flex flex-wrap">
      <div class="min-w-48 flex-1">
        <div class="font-medium">Rust is not installed yet</div>
        <div class="text-xs opacity-80">
          DevCatz downloads rustup-init from rust-lang.org (SHA-256 checked) and installs the stable toolchain, the standard way. {{ rustSites.length }} Rust site(s) linked.
        </div>
      </div>
      <button class="btn btn-sm btn-primary shrink-0" :disabled="!!busy" @click="installRust">Install Rust</button>
    </div>
    <div v-else-if="b.linkerMissing" role="alert" class="alert alert-warning flex flex-wrap"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
      <div class="min-w-48 flex-1">
        <div class="font-medium">The Xcode Command Line Tools are missing</div>
        <div class="text-xs opacity-80">Rust links programs with their linker: run <code class="selectable">xcode-select --install</code> in Terminal, then come back.</div>
      </div>
    </div>

    <!-- Progress -->
    <div v-if="busy" class="alert">
      <span class="loading loading-spinner loading-sm" />
      <div class="min-w-0 flex-1">
        <div class="text-sm">
          Installing {{ busy.version }}…
          <span v-if="busy.total" class="opacity-60">{{ (busy.received / 1048576).toFixed(1) }} / {{ (busy.total / 1048576).toFixed(1) }} MB</span>
        </div>
        <div v-if="busy.detail && !busy.total" class="truncate font-mono text-xs opacity-60">{{ busy.detail }}</div>
        <progress class="progress progress-primary w-full" :value="busy.total ? percent : undefined" max="100" />
      </div>
      <button class="btn btn-ghost btn-sm" title="Stop the download / install" @click="herd.installCancel('rust')">Cancel</button>
    </div>
    <div v-else-if="b.installing?.phase === 'error'" class="alert alert-error text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />Installing {{ b.installing.version }} failed: {{ b.installing.error }}</div>

    <template v-if="tab === 'installed'">
      <div class="card">
        <div class="card-body">
          <h2 class="font-semibold">Toolchains</h2>
          <div class="overflow-x-auto rounded-box border border-base-300/60">
            <table class="table table-sm">
              <thead>
                <tr><th>Toolchain</th><th>rustc</th><th>Used by</th><th class="text-right">Actions</th></tr>
              </thead>
              <tbody>
                <tr v-for="t in b.toolchains" :key="t.name">
                  <td class="whitespace-nowrap">
                    <span class="font-mono">{{ t.channel }}</span>
                    <span v-if="t.isDefault" class="badge badge-primary badge-soft badge-sm ml-1.5">default</span>
                  </td>
                  <td class="font-mono text-xs">{{ t.version ?? '?' }}</td>
                  <td class="text-xs opacity-70">{{ usedBy(t.channel).join(', ') || '—' }}</td>
                  <td class="text-right whitespace-nowrap">
                    <button v-if="!t.isDefault" class="btn btn-xs btn-ghost" @click="setDefault(t.name)">Make default</button>
                    <button v-if="!t.isDefault" class="btn btn-xs btn-ghost text-error" @click="uninstall(t.name)">Uninstall</button>
                  </td>
                </tr>
                <tr v-if="!b.toolchains.length">
                  <td colspan="4" class="text-center opacity-60">{{ b.rustup ? 'None yet.' : 'Install Rust first.' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
          <div v-if="b.rustup" class="flex flex-wrap items-center gap-2 text-xs">
            <span class="opacity-70">WebAssembly target (Yew, Leptos, Dioxus, Sycamore):</span>
            <span v-if="wasm" class="badge badge-success badge-soft badge-sm">wasm32-unknown-unknown</span>
            <button v-else class="btn btn-xs" :disabled="!!busy" @click="addWasm">Add wasm32-unknown-unknown</button>
          </div>
        </div>
      </div>
    </template>

    <template v-if="tab === 'available'">
      <div v-if="b.rustup" class="card">
        <div class="card-body">
          <div class="flex items-center gap-2">
            <h2 class="flex-1 font-semibold">Available</h2>
            <button class="btn btn-ghost btn-xs" :disabled="loadingRemote" @click="loadRemote(true)">
              <span v-if="loadingRemote" class="loading loading-spinner loading-xs" />Refresh
            </button>
          </div>
          <div class="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            <div v-for="r in remote" :key="r.name" class="flex items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
              <div class="min-w-0 flex-1">
                <div class="font-medium">{{ /^\d/.test(r.name) ? `Rust ${r.name}` : r.name }}</div>
                <div class="truncate text-xs opacity-60">{{ r.note ?? 'a pinned release' }}</div>
              </div>
              <span v-if="isInstalled(r.name)" class="text-xs opacity-60">installed</span>
              <button v-else class="btn btn-xs shrink-0" :disabled="!!busy" @click="installToolchain(r.name)">Install</button>
            </div>
          </div>
        </div>
      </div>
      <div v-else class="text-sm opacity-60">Install Rust first.</div>
    </template>

    <template v-if="tab === 'tools'">
      <div class="card">
        <div class="card-body">
          <div class="flex flex-wrap items-center gap-2">
            <h2 class="flex-1 font-semibold">Framework tools</h2>
            <button class="btn btn-ghost btn-xs" :disabled="checking || !!busy" title="Ask crates.io and GitHub for the newest releases" @click="checkTools">
              <span v-if="checking" class="loading loading-spinner loading-xs" />Check for updates
            </button>
          </div>
          <p class="text-xs opacity-60">
            Prebuilt through cargo-binstall where the project publishes one (else compiled by cargo). Solana comes from Anza’s installer, Anchor from avm (compiled once: a few
            minutes).
          </p>
          <div class="grid gap-2 lg:grid-cols-2">
            <div v-for="t in b.tools" :key="t.id" class="flex flex-wrap items-center gap-3 rounded-box border border-base-300/60 px-3 py-2">
              <div class="min-w-48 flex-1">
                <div class="flex flex-wrap items-center gap-1.5">
                  <span class="font-medium">{{ t.label }}</span>
                  <span v-if="t.installed" class="badge badge-ghost badge-sm font-mono">{{ t.version }}</span>
                  <span v-if="t.update" class="badge badge-info badge-soft badge-sm font-mono" :title="`${t.latest} is out`">→ {{ t.latest }}</span>
                  <span v-if="neededBy(t.id).length" class="badge badge-warning badge-soft badge-sm" :title="neededBy(t.id).join(', ')">needed by {{ neededBy(t.id).length }} site{{ neededBy(t.id).length === 1 ? '' : 's' }}</span>
                </div>
                <div class="text-xs opacity-60">{{ t.why }}</div>
              </div>
              <div v-if="t.installed" class="flex shrink-0 items-center gap-1">
                <button v-if="t.update" class="btn btn-primary btn-xs" :disabled="!!busy || !b.rustup" @click="installTool(t.id, t.label, true)">Update</button>
                <span v-else class="text-xs opacity-60">installed</span>
                <button
                  class="btn btn-ghost btn-xs text-error"
                  :disabled="!!busy"
                  @click="askUninstall = { id: t.id, label: t.label }"
                >
                  Remove
                </button>
              </div>
              <button
                v-else
                class="btn btn-xs shrink-0"
                :class="{ 'btn-primary': neededBy(t.id).length }"
                :disabled="!!busy || !b.rustup || (t.id === 'anchor' && !b.tools.find((x) => x.id === 'solana')?.installed)"
                :title="t.id === 'anchor' && !b.tools.find((x) => x.id === 'solana')?.installed ? 'Install the Solana CLI first' : ''"
                @click="installTool(t.id, t.label)"
              >
                Install
              </button>
            </div>
          </div>
          <p class="text-xs opacity-60">Installed into <code class="selectable">~/.cargo/bin</code> (Solana: <code>~/.local/share/solana</code>); new terminals find them too.</p>
        </div>
      </div>
    </template>
    <ConfirmDialog
      v-if="askUninstall"
      :title="`Remove ${askUninstall.label}?`"
      :text="
        askUninstall.id === 'solana'
          ? 'Moves Solana’s install folder (~/.local/share/solana/install) to the Trash; anchor test and the local validator stop working.'
          : askUninstall.id === 'anchor'
            ? 'Removes avm and moves its folder (~/.avm, every Anchor version) to the Trash.'
            : 'cargo uninstall removes it from ~/.cargo/bin; sites and terminals will not find it any more.'
      "
      confirm="Remove"
      tone="error"
      @ok="uninstallTool(askUninstall)"
      @cancel="askUninstall = null"
    />
  </section>
</template>
