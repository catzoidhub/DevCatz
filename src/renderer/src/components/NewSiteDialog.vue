<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { FolderPreview, GitRepo, HerdSite, PackageManager } from '@shared/types';
import { ICONS } from '../icons';
import { attempt, cloneRequest, herd, notify, state } from '../store';
import { GIT_HOST_ICONS } from '../githosticons';
import { usesGo, usesJs } from '../runtimes';
import RuntimeInstallButton from './RuntimeInstallButton.vue';

/**
 * "Create New Site": link one project (with name, domain, Node version and
 * "start now"), clone a Git repository (then the same form), or park a
 * folder of projects.
 */
const emit = defineEmits<{ close: []; created: [id: string]; park: [] }>();

const step = ref<'choose' | 'form' | 'git' | 'herd'>('choose');

// ---- Import from Laravel Herd: a quiet link under the choices, only when Herd has sites DevCatz does not serve yet.
const herdSites = ref<HerdSite[]>([]);
const herdPick = ref<Set<string>>(new Set());
const importing = ref(false);
const herdNew = computed(() => herdSites.value.filter((x) => !x.linked).length);
onMounted(async () => (herdSites.value = (await herd.herdSites().catch(() => [])) ?? []));
function showHerd() {
  herdPick.value = new Set(herdSites.value.filter((x) => !x.linked).map((x) => x.path));
  step.value = 'herd';
}
function togglePick(path: string) {
  const next = new Set(herdPick.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  herdPick.value = next;
}
async function importHerd() {
  importing.value = true;
  let n = 0;
  let firstId = '';
  for (const path of herdPick.value) {
    const created = await attempt(() => herd.linkProject(path));
    if (created) {
      n++;
      firstId ||= created.id;
    }
  }
  importing.value = false;
  notify('success', `Imported ${n} site${n === 1 ? '' : 's'} from Laravel Herd on .${tld.value}`);
  if (firstId) emit('created', firstId);
}

// ---- Clone from Git
const git = ref({ url: '', parent: '', name: '', branch: '', shallow: false });
const nameEdited = ref(false);
const repoName = (u: string) => u.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() ?? '';
watch(
  () => git.value.url,
  (url) => {
    if (!nameEdited.value) git.value.name = slug(repoName(url));
  },
);
function openGit(preset?: { url: string; name: string; branch: string }) {
  git.value = { url: preset?.url ?? '', parent: state.value?.git.cloneDir ?? '', name: preset?.name ? slug(preset.name) : '', branch: preset?.branch ?? '', shallow: false };
  nameEdited.value = Boolean(preset?.name);
  step.value = 'git';
}
// From the Git page's "Clone as site…".
onMounted(() => {
  if (cloneRequest.value) {
    openGit(cloneRequest.value);
    cloneRequest.value = null;
  }
});
async function chooseParent() {
  const dir = await herd.pickFolder();
  if (dir) git.value.parent = dir;
}
const cloneTask = computed(() => state.value?.git.clone ?? null);
const cloning = ref(false);
async function runClone() {
  cloning.value = true;
  const g = git.value;
  const dest = await attempt(() => herd.gitClone(g.url, g.parent, g.name.trim(), g.branch.trim(), g.shallow));
  cloning.value = false;
  if (dest) await openForm(dest);
}
// Pick a repository of a connected account.
const accounts = computed(() => state.value?.git.accounts ?? []);
const repoAccount = ref('');
const repoQuery = ref('');
const repoList = ref<GitRepo[]>([]);
let repoTimer: ReturnType<typeof setTimeout> | null = null;
async function loadRepos() {
  if (!repoAccount.value) return void (repoList.value = []);
  repoList.value = ((await attempt(() => herd.gitRepos(repoAccount.value, repoQuery.value))) ?? []).slice(0, 8);
}
watch(repoAccount, () => void loadRepos());
watch(repoQuery, () => {
  if (repoTimer) clearTimeout(repoTimer);
  repoTimer = setTimeout(loadRepos, 350);
});
function pickRepo(r: GitRepo) {
  git.value.url = r.cloneHttps;
  git.value.branch = '';
  nameEdited.value = false;
  git.value.name = slug(r.name);
}
const preview = ref<FolderPreview | null>(null);
const form = ref({
  name: '',
  domain: '',
  nodeVersion: '',
  goVersion: '',
  phpVersion: '',
  packageManager: '' as '' | PackageManager,
  devCommand: '',
  managedPorts: true,
  autoStart: false,
  secure: true,
  start: true,
});
const more = ref(false);
const PMS: PackageManager[] = ['bun', 'npm', 'pnpm', 'yarn'];
const domainEdited = ref(false);
const busy = ref(false);

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close');
}
onMounted(() => window.addEventListener('keydown', onKey));
onBeforeUnmount(() => window.removeEventListener('keydown', onKey));

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63) || 'site';

// The domain follows the name until it is edited by hand.
watch(
  () => form.value.name,
  (name) => {
    if (!domainEdited.value) form.value.domain = slug(name);
  },
);

async function chooseFolder() {
  const dir = await herd.pickFolder();
  if (dir) await openForm(dir);
}

/** A runtime was installed from here: look at the folder again (the Auto versions, Start). */
async function refreshPreview() {
  if (!preview.value) return;
  const p = await attempt(() => herd.inspectFolder(preview.value!.path));
  if (p) preview.value = p;
}

async function openForm(dir: string) {
  const p = await attempt(() => herd.inspectFolder(dir));
  if (!p) return;
  if (p.alreadyLinked) {
    notify('info', `${p.name} is already a site`);
    return;
  }
  preview.value = p;
  domainEdited.value = false;
  form.value = {
    name: p.name,
    domain: p.domain.slice(0, -(tld.value.length + 1)),
    nodeVersion: '',
    goVersion: '',
    phpVersion: '',
    packageManager: '',
    devCommand: '',
    managedPorts: true,
    autoStart: false,
    secure: true,
    start: true,
  };
  more.value = false;
  step.value = 'form';
}

const installed = computed(() => state.value?.node.installed ?? []);
const tld = computed(() => state.value?.settings.tld ?? 'localhost');
const isNode = computed(() => (preview.value ? usesJs(preview.value.stack) : false));
const isPhp = computed(() => preview.value?.stack.runtime === 'php');
const phpInstalled = computed(() => state.value?.php.installed ?? []);
const isGo = computed(() => (preview.value ? usesGo(preview.value.stack) : false));
const goInstalled = computed(() => state.value?.go.installed ?? []);

const FRAMEWORK: Record<string, string> = {
  nuxt: 'Nuxt', next: 'Next.js', 'vite-vue': 'Vue + Vite',
  'vite-react': 'React + Vite', 'tanstack-start': 'TanStack Start', vite: 'Vite', astro: 'Astro', sveltekit: 'SvelteKit',
  nestjs: 'NestJS', express: 'Node server', node: 'Node', go: 'Go', laravel: 'Laravel', php: 'PHP',
};
const summary = computed(() => {
  const s = preview.value?.stack;
  if (!s) return '';
  const parts = [s.packageManager ?? '', s.monorepo ? 'monorepo' : '', ...s.apps.map((a) => FRAMEWORK[a.framework])];
  if (s.prismaDir !== null) parts.push('Prisma');
  if (s.database) parts.push(s.database.engine);
  return parts.filter(Boolean).join(' · ');
});

const run = (pm: PackageManager) => (pm === 'yarn' ? 'yarn dev' : `${pm} run dev`);
/** The detected dev command, following a package manager override. */
const defaultDevCommand = computed(() => {
  const s = preview.value?.stack;
  if (!s?.devCommand) return null;
  const from = s.detectedPackageManager;
  const to = form.value.packageManager;
  return from && to ? s.devCommand.replace(run(from), run(to)) : s.devCommand;
});
/** What "More settings" changes from the defaults, shown while it is collapsed. */
const moreSummary = computed(() =>
  [
    form.value.packageManager && form.value.packageManager,
    form.value.devCommand.trim() && 'custom dev command',
    !form.value.managedPorts && 'ports from .env',
    !form.value.secure && 'http',
    form.value.autoStart && 'auto-start',
  ]
    .filter(Boolean)
    .join(' · '),
);

async function create() {
  if (!preview.value) return;
  busy.value = true;
  const p = await attempt(() =>
    herd.linkProject(preview.value!.path, {
      name: form.value.name.trim() || preview.value!.name,
      domain: form.value.domain.trim(),
      nodeVersion: (isNode.value && form.value.nodeVersion) || undefined,
      goVersion: (isGo.value && form.value.goVersion) || undefined,
      phpVersion: (isPhp.value && form.value.phpVersion) || undefined,
      packageManager: form.value.packageManager || undefined,
      devCommand: form.value.devCommand.trim() || undefined,
      managedPorts: form.value.managedPorts,
      autoStart: form.value.autoStart,
      secure: form.value.secure,
      start: form.value.start && !preview.value!.stack.depsMissing && !(isGo.value && !goInstalled.value.length),
    }),
  );
  busy.value = false;
  if (!p) return;
  notify('success', `Created ${p.name} → ${p.domain}`);
  emit('created', p.id);
}
</script>

<template>
  <div class="no-drag fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6" @mousedown.self="emit('close')">
    <div class="max-h-[calc(100vh-3rem)] w-full max-w-lg overflow-y-auto rounded-box border border-base-300 bg-base-100 p-5 shadow-2xl" role="dialog" aria-label="Create new site">
      <h2 class="text-base font-semibold">Create New Site</h2>

      <!-- Step 1 -->
      <template v-if="step === 'choose'">
        <p class="mt-1 text-xs opacity-60">DevCatz detects the stack, dev command and ports, and serves it on <code>https://&lt;name&gt;.{{ tld }}</code>.</p>
        <div class="mt-4 space-y-2">
          <button class="flex w-full items-start gap-3 rounded-box border border-base-300 p-3 text-left transition hover:border-primary/60 hover:bg-base-200" @click="chooseFolder">
            <svg class="mt-0.5 size-5 shrink-0 text-primary" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.link" /></svg>
            <span>
              <span class="block font-medium">Link a project folder…</span>
              <span class="block text-xs opacity-60">Choose the folder, then set its name, domain and Node.js version.</span>
            </span>
          </button>
          <button class="flex w-full items-start gap-3 rounded-box border border-base-300 p-3 text-left transition hover:border-primary/60 hover:bg-base-200" @click="openGit()">
            <svg class="mt-0.5 size-5 shrink-0" viewBox="0 0 24 24" :style="{ color: GIT_HOST_ICONS.git.color }"><path :d="GIT_HOST_ICONS.git.d" fill="currentColor" /></svg>
            <span>
              <span class="block font-medium">Clone from Git…</span>
              <span class="block text-xs opacity-60">A repository of your GitHub / GitLab / Gitea / Bitbucket account, or any clone URL.</span>
            </span>
          </button>
          <button class="flex w-full items-start gap-3 rounded-box border border-base-300 p-3 text-left transition hover:border-primary/60 hover:bg-base-200" @click="emit('park')">
            <svg class="mt-0.5 size-5 shrink-0 text-primary" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" :d="ICONS.folder" /></svg>
            <span>
              <span class="block font-medium">Park a folder of projects…</span>
              <span class="block text-xs opacity-60">Every project inside becomes a site, now and when you add more later.</span>
            </span>
          </button>
        </div>
        <div class="mt-4 flex items-center gap-2">
          <button v-if="herdNew" class="link link-hover text-xs opacity-60 hover:opacity-90" @click="showHerd">Import {{ herdNew }} site{{ herdNew === 1 ? '' : 's' }} from Laravel Herd…</button>
          <span class="flex-1" />
          <button class="btn btn-ghost btn-sm" @click="emit('close')">Cancel</button>
        </div>
      </template>

      <!-- Import from Laravel Herd -->
      <div v-else-if="step === 'herd'" class="mt-3 space-y-3">
        <p class="text-xs opacity-70">Laravel Herd's linked and parked sites. DevCatz serves the ones you pick on .{{ tld }}; Herd itself is not changed.</p>
        <ul class="max-h-72 space-y-1 overflow-y-auto rounded-box border border-base-300 p-2">
          <li v-for="x in herdSites" :key="x.path">
            <label class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 hover:bg-base-200" :class="{ 'opacity-50': x.linked }">
              <input type="checkbox" class="checkbox checkbox-xs" :checked="herdPick.has(x.path)" :disabled="x.linked" @change="togglePick(x.path)" />
              <span class="flex-1 truncate">{{ x.name }}</span>
              <span class="badge badge-ghost badge-xs">{{ x.linked ? 'already added' : x.via }}</span>
            </label>
          </li>
        </ul>
        <div class="flex justify-end gap-2">
          <button class="btn btn-ghost btn-sm" @click="step = 'choose'">Back</button>
          <button class="btn btn-primary btn-sm" :disabled="!herdPick.size || importing" @click="importHerd">
            <span v-if="importing" class="loading loading-spinner loading-xs" />Import {{ herdPick.size }} site{{ herdPick.size === 1 ? '' : 's' }}
          </button>
        </div>
      </div>

      <!-- Clone from Git -->
      <form v-else-if="step === 'git'" class="mt-3 space-y-3" @submit.prevent="runClone">
        <label class="block">
            <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Repository URL</span>
            <input v-model="git.url" class="input input-sm w-full font-mono" placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git" spellcheck="false" autofocus />
          </label>
          <div v-if="accounts.length" class="rounded-box border border-base-300 p-2">
            <div class="flex gap-2">
              <select v-model="repoAccount" class="select select-xs w-44">
                <option value="">Your repositories…</option>
                <option v-for="a in accounts" :key="a.id" :value="a.id">{{ a.username }} · {{ a.baseUrl.replace(/^https?:\/\//, '') }}</option>
              </select>
              <input v-if="repoAccount" v-model="repoQuery" class="input input-xs flex-1" placeholder="Search" />
            </div>
            <ul v-if="repoList.length" class="mt-1 max-h-40 overflow-y-auto">
              <li v-for="r in repoList" :key="r.fullName">
                <a class="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs hover:bg-base-200" @click="pickRepo(r)">
                  <span class="flex-1 truncate font-mono">{{ r.fullName }}</span>
                  <span v-if="r.private" class="badge badge-ghost badge-xs">private</span>
                </a>
              </li>
            </ul>
          </div>
          <p v-else class="text-xs opacity-60">Public repositories need no account. Connect GitHub / GitLab / Gitea / Bitbucket on the Git page for private ones.</p>

        <div class="grid grid-cols-[1fr_auto] gap-2">
          <label class="block">
            <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Into folder</span>
            <div class="join w-full">
              <input v-model="git.parent" class="input input-sm join-item w-full font-mono text-xs" spellcheck="false" />
              <button type="button" class="btn btn-sm join-item" @click="chooseParent">Choose…</button>
            </div>
          </label>
          <label class="block">
            <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Name</span>
            <input v-model="git.name" class="input input-sm w-36 font-mono" spellcheck="false" @input="nameEdited = true" />
          </label>
        </div>
        <div class="flex flex-wrap items-center gap-3">
          <input v-model="git.branch" class="input input-sm w-44 font-mono" placeholder="branch or tag (optional)" spellcheck="false" />
          <label class="flex items-center gap-1.5 text-xs" title="Only the latest commit (faster for big repositories); fetch the rest later"><input v-model="git.shallow" type="checkbox" class="checkbox checkbox-xs" />Shallow (latest commit only)</label>
        </div>
        <p class="text-xs opacity-60"><code>{{ git.parent }}/{{ git.name || '…' }}</code>, then the usual site form (stack detected, name, domain, start).</p>

        <div v-if="cloneTask && (cloning || cloneTask.error)" class="max-h-40 overflow-y-auto rounded-box bg-base-200 p-2 font-mono text-[11px] leading-snug">
          <div v-for="(l, i) in cloneTask.lines.slice(-12)" :key="i" class="truncate">{{ l }}</div>
          <div v-if="cloneTask.error" class="text-error">{{ cloneTask.error }}</div>
        </div>

        <div class="flex justify-end gap-2">
          <button v-if="cloning" type="button" class="btn btn-ghost btn-sm" @click="herd.gitCancelClone()">Cancel clone</button>
          <button v-else type="button" class="btn btn-ghost btn-sm" @click="step = 'choose'">Back</button>
          <button class="btn btn-primary btn-sm" :disabled="cloning || !git.parent || !git.name.trim() || !git.url.trim()">
            <span v-if="cloning" class="loading loading-spinner loading-xs" />Clone
          </button>
        </div>
      </form>

      <!-- Step 2 -->
      <form v-else-if="preview" class="mt-3 space-y-4" @submit.prevent="create">
        <div class="rounded-box bg-base-200 px-3 py-2 text-xs">
          <div class="truncate font-mono opacity-80" :title="preview.path">{{ preview.path }}</div>
          <div class="mt-0.5 opacity-60">{{ summary || 'No dev server detected' }}</div>
        </div>

        <label class="block">
          <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Project name</span>
          <input v-model="form.name" class="input input-sm w-full" autofocus />
        </label>

        <label class="block">
          <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Domain</span>
          <div class="join w-full">
            <input v-model="form.domain" class="input input-sm join-item w-full font-mono" @input="domainEdited = true" />
            <span class="join-item flex items-center rounded-r-field border border-base-300 bg-base-200 px-3 font-mono text-xs">.{{ tld }}</span>
          </div>
          <span v-if="preview.stack.apps.length > 1" class="text-xs opacity-60">
            Other apps: {{ preview.stack.apps.slice(1).map((a) => `${a.dir.split('/').pop()}.${slug(form.domain)}.${tld}`).join(', ') }}
          </span>
        </label>

        <div>
          <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Protocol</span>
          <div class="join">
            <button type="button" class="btn btn-sm join-item" :class="{ 'btn-active btn-primary': form.secure }" @click="form.secure = true">HTTPS</button>
            <button type="button" class="btn btn-sm join-item" :class="{ 'btn-active btn-primary': !form.secure }" @click="form.secure = false">HTTP</button>
          </div>
          <span class="ml-2 text-xs opacity-60">{{ form.secure ? 'https' : 'http' }}://{{ slug(form.domain || preview.name) }}.{{ tld }}</span>
        </div>

        <label v-if="isPhp" class="block">
          <span class="mb-1 block text-xs font-semibold uppercase opacity-60">PHP version</span>
          <select v-model="form.phpVersion" class="select select-sm w-full">
            <option value="">
              Auto: {{ preview.autoPhp.version ?? 'not installed' }}
              ({{ preview.autoPhp.spec ? `composer.json asks for ${preview.autoPhp.spec}` : 'default version' }})
            </option>
            <option v-for="v in phpInstalled" :key="v.version" :value="v.version">{{ v.version }}{{ v.source === 'herd' ? ' (Laravel Herd)' : '' }}</option>
          </select>
          <span v-if="!phpInstalled.length || preview.autoPhp.missing" class="flex flex-wrap items-center gap-2 text-xs text-warning">
            {{ !phpInstalled.length ? 'PHP is not installed yet.' : `composer.json asks for PHP ${preview.autoPhp.spec}, which is not installed.` }}
            <RuntimeInstallButton kind="php" :spec="preview.autoPhp.spec" @installed="refreshPreview" />
          </span>
          <span v-else class="text-xs opacity-60">Served by PHP-FPM, always on; Start only runs Vite / queue / scheduler.</span>
        </label>

        <label v-if="isGo" class="block">
          <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Go version</span>
          <select v-model="form.goVersion" class="select select-sm w-full">
            <option value="">
              Auto: {{ preview.autoGo.version ?? 'not installed' }}
              ({{ preview.autoGo.spec ? `go.mod asks for ${preview.autoGo.spec}` : 'default version' }})
            </option>
            <option v-for="v in goInstalled" :key="v.version" :value="v.version">{{ v.version }}{{ v.source === 'system' ? ' (your own)' : '' }}</option>
          </select>
          <span v-if="!goInstalled.length || preview.autoGo.missing" class="flex flex-wrap items-center gap-2 text-xs text-warning">
            {{ !goInstalled.length ? 'Go is not installed yet.' : `go.mod asks for Go ${preview.autoGo.spec}.` }}
            <RuntimeInstallButton kind="go" :spec="preview.autoGo.spec" @installed="refreshPreview" />
          </span>
        </label>

        <label v-if="isNode" class="block">
          <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Node.js version</span>
          <select v-model="form.nodeVersion" class="select select-sm w-full">
            <option value="">
              Auto: {{ preview.autoNode.version ?? 'shell node' }}
              ({{ preview.autoNode.spec ? `project asks for ${preview.autoNode.spec}` : 'default version' }})
            </option>
            <option v-for="v in installed" :key="v.version" :value="v.version">{{ v.version }}{{ v.source === 'herd' ? ' (Laravel Herd)' : '' }}</option>
          </select>
          <span v-if="!preview.autoNode.version || preview.autoNode.missing" class="flex flex-wrap items-center gap-2 text-xs text-warning">
            {{ !preview.autoNode.version ? 'Node.js is not installed yet.' : `The project asks for Node ${preview.autoNode.spec}, which is not installed.` }}
            <RuntimeInstallButton kind="node" :spec="preview.autoNode.spec" @installed="refreshPreview" />
          </span>
        </label>

        <label class="flex cursor-pointer items-center gap-2">
          <input v-model="form.start" type="checkbox" class="toggle toggle-sm toggle-primary" :disabled="preview.stack.depsMissing || (isGo && !goInstalled.length)" />
          <span>Start the dev server now</span>
        </label>
        <p v-if="preview.stack.depsMissing" class="text-xs text-warning">
          Dependencies are not installed yet; after creating, use “Install dependencies” on the site page, then Start.
        </p>

        <!-- More settings -->
        <div class="rounded-box border border-base-300">
          <button type="button" class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm font-medium" @click="more = !more">
            <svg class="size-4 transition-transform" :class="{ 'rotate-90': more }" viewBox="0 0 20 20" fill="currentColor">
              <path fill-rule="evenodd" clip-rule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.17 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" />
            </svg>
            More settings
            <span v-if="!more && moreSummary" class="truncate text-xs font-normal opacity-60">{{ moreSummary }}</span>
          </button>
          <div v-if="more" class="space-y-4 border-t border-base-300 px-3 pt-3 pb-3">
            <label v-if="isNode" class="block">
              <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Package manager</span>
              <select v-model="form.packageManager" class="select select-sm w-full">
                <option value="">Auto: {{ preview.stack.detectedPackageManager }} (from the lockfile)</option>
                <option v-for="pm in PMS" :key="pm" :value="pm">{{ pm }}</option>
              </select>
            </label>
            <label class="block">
              <span class="mb-1 block text-xs font-semibold uppercase opacity-60">Dev command</span>
              <input v-model="form.devCommand" class="input input-sm w-full font-mono" :placeholder="defaultDevCommand ?? 'e.g. bun run dev'" />
              <span class="text-xs opacity-60">Leave empty to use the detected command.</span>
            </label>
            <label class="flex cursor-pointer items-start gap-2">
              <input v-model="form.managedPorts" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
              <span>
                Let DevCatz assign dev ports
                <span class="block text-xs opacity-60">Each app gets its own port (4100+), so sites never collide; .env keeps its production values.</span>
              </span>
            </label>
            <label class="flex cursor-pointer items-start gap-2">
              <input v-model="form.autoStart" type="checkbox" class="toggle toggle-sm toggle-primary mt-0.5" />
              <span>
                Start automatically when DevCatz launches
                <span class="block text-xs opacity-60">Used when "Start all sites on launch" is off in Settings.</span>
              </span>
            </label>
          </div>
        </div>

        <div class="flex justify-end gap-2">
          <button type="button" class="btn btn-ghost btn-sm" @click="step = 'choose'">Back</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="busy || !form.name.trim()">
            <span v-if="busy" class="loading loading-spinner loading-xs" />Create site
          </button>
        </div>
      </form>
    </div>
  </div>
</template>
