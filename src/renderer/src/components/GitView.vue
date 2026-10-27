<script setup lang="ts">
import { currentOS, words } from '@shared/platform';
import { computed, reactive, ref, watch } from 'vue';
import type { GitAccount, GitHostKind, GitRepo, GitSshKey, ProjectState } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import StatusDot from './StatusDot.vue';
import { GIT_HOST_ICONS } from '../githosticons';
import { attempt, cloneRequest, herd, notify, siteTabRequest, state } from '../store';
import CatMood from './CatMood.vue';

/**
 * Git (rail): connected hosting accounts (GitHub, GitLab, Gitea / Forgejo,
 * Bitbucket, self-hosted too) with their repositories to clone, SSH keys,
 * and every site's branch and changes at a glance.
 */
const emit = defineEmits<{ openSite: [id: string] }>();
const H = herd;

type View = { kind: 'sites' } | { kind: 'keys' } | { kind: 'add' } | { kind: 'account'; id: string };
const view = ref<View>({ kind: 'sites' });
const accounts = computed(() => state.value?.git.accounts ?? []);
const account = computed(() => (view.value.kind === 'account' ? (accounts.value.find((a) => a.id === (view.value as { id: string }).id) ?? null) : null));
watch(accounts, (list) => view.value.kind === 'account' && !account.value && (view.value = list[0] ? { kind: 'account', id: list[0].id } : { kind: 'sites' }));

const NAME: Record<GitHostKind, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea / Forgejo', bitbucket: 'Bitbucket' };
const DEFAULT_URL: Record<GitHostKind, string> = { github: 'https://github.com', gitlab: 'https://gitlab.com', gitea: 'https://codeberg.org', bitbucket: 'https://bitbucket.org' };
const host = (u: string) => u.replace(/^https?:\/\//, '');

// ---- add account
const form = ref({ kind: 'github' as GitHostKind, baseUrl: DEFAULT_URL.github, username: '', token: '' });
watch(
  () => form.value.kind,
  (k, old) => {
    if (!form.value.baseUrl || form.value.baseUrl === DEFAULT_URL[old]) form.value.baseUrl = DEFAULT_URL[k];
  },
);
/** Where to make a token, with the scopes DevCatz needs. */
const tokenUrl = computed(() => {
  const b = form.value.baseUrl.replace(/\/+$/, '');
  switch (form.value.kind) {
    case 'github':
      return `${b}/settings/tokens/new?description=DevCatz&scopes=repo,read:org,admin:public_key,workflow`;
    case 'gitlab':
      return `${b}/-/user_settings/personal_access_tokens?name=DevCatz&scopes=api,read_user,write_repository`;
    case 'gitea':
      return `${b}/user/settings/applications`;
    default:
      return /bitbucket\.org/.test(b) ? 'https://id.atlassian.com/manage-profile/security/api-tokens' : `${b}/plugins/servlet/access-tokens/manage`;
  }
});
const scopes = computed(
  () =>
    ({
      github: 'Classic token with repo, read:org, admin:public_key (fine-grained: Contents, Pull requests, Metadata).',
      gitlab: 'Scopes api, read_user, write_repository.',
      gitea: 'Scopes repository (read & write), user (read & write for SSH keys).',
      bitbucket: 'Bitbucket Cloud: your username (or Atlassian email) and an API token / app password with repository and pull request access.',
    })[form.value.kind],
);
const adding = ref(false);
async function add() {
  adding.value = true;
  const a = await attempt(() => herd.gitAddAccount(form.value.kind, form.value.baseUrl, form.value.token, form.value.username));
  adding.value = false;
  if (!a) return;
  notify('success', `${NAME[a.kind]} connected as ${a.username}`);
  form.value.token = '';
  view.value = { kind: 'account', id: a.id };
}
const removing = ref<GitAccount | null>(null);
async function remove() {
  const a = removing.value!;
  removing.value = null;
  await attempt(() => herd.gitRemoveAccount(a.id).then(() => true), `${NAME[a.kind]} account removed`);
}

// ---- repositories
const repos = ref<GitRepo[]>([]);
const repoQuery = ref('');
const reposBusy = ref(false);
const reposError = ref('');
async function loadRepos() {
  const a = account.value;
  if (!a) return;
  reposBusy.value = true;
  try {
    repos.value = await herd.gitRepos(a.id, repoQuery.value);
    reposError.value = '';
  } catch (e) {
    reposError.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    repos.value = [];
  }
  reposBusy.value = false;
}
let timer: ReturnType<typeof setTimeout> | null = null;
watch(repoQuery, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(loadRepos, 350);
});
watch(account, (a, b) => a && a.id !== b?.id && ((repoQuery.value = ''), void loadRepos()), { immediate: true });
const useSsh = ref(false);
function clone(r: GitRepo) {
  cloneRequest.value = { url: useSsh.value && r.cloneSsh ? r.cloneSsh : r.cloneHttps, name: r.name, branch: r.defaultBranch ?? '' };
}
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString() : '');

// ---- SSH keys
const keys = ref<GitSshKey[]>([]);
const keyEmail = ref('');
const keyTarget = ref<Record<string, string>>({});
async function loadKeys() {
  keys.value = (await herd.gitSshKeys().catch(() => [])) ?? [];
}
watch(view, (v) => v.kind === 'keys' && void loadKeys(), { immediate: true });
async function generate() {
  const k = await attempt(() => herd.gitSshGenerate(keyEmail.value));
  if (k) {
    notify('success', `Key created: ${k.path}`);
    await loadKeys();
  }
}
async function upload(k: GitSshKey) {
  const id = keyTarget.value[k.path] ?? accounts.value[0]?.id;
  if (!id) return;
  const a = accounts.value.find((x) => x.id === id)!;
  await attempt(() => herd.gitSshAddToAccount(id, k.path, `DevCatz · ${k.comment || 'this Mac'}`).then(() => true), `Key added to ${NAME[a.kind]} (${a.username})`);
}
async function copy(t: string) {
  await navigator.clipboard.writeText(t).catch(() => undefined);
  notify('info', 'Public key copied');
}

// ---- sites
const sites = computed<ProjectState[]>(() => state.value?.projects ?? []);
const repoSites = computed(() => sites.value.filter((p) => p.git));
const plainSites = computed(() => sites.value.filter((p) => !p.git));
function openSiteGit(id: string) {
  siteTabRequest.value = { id, tab: 'git' };
  emit('openSite', id);
}
const ICON = (k: GitHostKind) => GIT_HOST_ICONS[k];
/** Avatars that failed to load show the host's mark instead. */
const broken = reactive(new Set<string>());
</script>

<template>
  <div class="flex min-h-0 min-w-0 flex-1">
    <aside class="flex w-64 shrink-0 flex-col border-r border-base-300/60 bg-base-200/80">
      <div class="drag title-strip flex h-14 shrink-0 items-end justify-end px-3 pb-2">
        <span class="nav-hole" aria-hidden="true" />
        <button class="btn btn-ghost btn-sm btn-square" title="Connect an account" @click="view = { kind: 'add' }">
          <svg class="size-4" viewBox="0 0 20 20" fill="currentColor"><path d="M10 4a1 1 0 0 1 1 1v4h4a1 1 0 1 1 0 2h-4v4a1 1 0 1 1-2 0v-4H5a1 1 0 1 1 0-2h4V5a1 1 0 0 1 1-1Z" /></svg>
        </button>
      </div>
      <ul class="menu w-full flex-1 flex-nowrap gap-1 overflow-y-auto px-2">
        <li class="menu-title px-2"><span class="label-caps">Overview</span></li>
        <li>
          <a :class="{ 'menu-active': view.kind === 'sites' }" @click="view = { kind: 'sites' }">
            <span class="grid size-7 place-items-center rounded-lg bg-base-300/70"><svg class="size-4" viewBox="0 0 24 24" :style="{ color: GIT_HOST_ICONS.git.color }"><path :d="GIT_HOST_ICONS.git.d" fill="currentColor" /></svg></span>
            <div class="min-w-0 flex-1">
              <div class="font-medium">Sites</div>
              <div class="text-[11px] opacity-60">{{ repoSites.length }} repositor{{ repoSites.length === 1 ? 'y' : 'ies' }}</div>
            </div>
          </a>
        </li>
        <li>
          <a :class="{ 'menu-active': view.kind === 'keys' }" @click="view = { kind: 'keys' }">
            <span class="grid size-7 place-items-center rounded-lg bg-base-300/70 font-mono text-[10px] font-bold">SSH</span>
            <div class="min-w-0 flex-1">
              <div class="font-medium">SSH keys</div>
              <div class="text-[11px] opacity-60">~/.ssh</div>
            </div>
          </a>
        </li>
        <li class="menu-title mt-3 px-2"><span class="label-caps">Accounts</span></li>
        <li v-for="a in accounts" :key="a.id">
          <a :class="{ 'menu-active': account?.id === a.id }" @click="view = { kind: 'account', id: a.id }">
            <img v-if="a.avatarUrl && !broken.has(a.id)" :src="a.avatarUrl" alt="" class="size-8 shrink-0 rounded-full bg-base-300/70" draggable="false" @error="broken.add(a.id)" />
            <span v-else class="grid size-8 shrink-0 place-items-center rounded-full bg-base-300/70"><svg class="size-4" viewBox="0 0 24 24" :style="{ color: ICON(a.kind).color }"><path :d="ICON(a.kind).d" fill="currentColor" /></svg></span>
            <div class="min-w-0 flex-1">
              <div class="truncate font-medium">{{ a.username }}</div>
              <div class="flex items-center gap-1 truncate text-[11px] opacity-60">
                <svg class="size-3 shrink-0" viewBox="0 0 24 24" :style="{ color: ICON(a.kind).color }"><path :d="ICON(a.kind).d" fill="currentColor" /></svg>{{ host(a.baseUrl) }}
              </div>
            </div>
          </a>
        </li>
        <li>
          <a :class="{ 'menu-active': view.kind === 'add' }" @click="view = { kind: 'add' }">
            <span class="grid size-8 shrink-0 place-items-center rounded-full border border-dashed border-base-content/30 text-base">+</span>
            <span class="opacity-80">Connect an account</span>
          </a>
        </li>
      </ul>
      <div class="border-t border-base-300/60 p-3 text-xs opacity-60">
        <template v-if="state?.git.version">git {{ state.git.version }} · your own config and credentials</template>
        <span v-else class="text-warning">git is missing: xcode-select --install</span>
      </div>
    </aside>

    <main class="flex min-w-0 flex-1 flex-col bg-base-100">
      <!-- Sites -->
      <template v-if="view.kind === 'sites'">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <h2 class="text-lg font-semibold tracking-tight">Sites</h2>
          <div class="text-xs opacity-60">Branch, changes and commits to push / pull of every site (refreshed every 20 s).</div>
        </header>
        <div class="flex-1 space-y-4 overflow-y-auto p-6">
          <div class="overflow-x-auto rounded-box border border-base-300/60">
            <table class="table table-sm">
              <thead>
                <tr><th>Site</th><th>Branch</th><th class="text-right">Changed</th><th class="text-right">Push / pull</th><th></th></tr>
              </thead>
              <tbody>
                <tr v-for="p in repoSites" :key="p.id" class="cursor-pointer hover:bg-base-200/50" @click="openSiteGit(p.id)">
                  <td><div class="flex items-center gap-2"><StatusDot :status="p.served ? 'running' : p.status" /><span class="font-medium">{{ p.name }}</span></div></td>
                  <td class="font-mono text-xs">
                    {{ p.git!.branch ?? 'detached' }}
                    <span v-if="p.git!.operation" class="badge badge-warning badge-soft badge-xs ml-1">{{ p.git!.operation }}</span>
                    <span v-if="!p.git!.upstream && p.git!.branch" class="ml-1 opacity-50">local</span>
                  </td>
                  <td class="text-right font-mono tabular-nums" :class="{ 'text-[var(--c-git)]': p.git!.changed }">{{ p.git!.changed || '—' }}</td>
                  <td class="text-right font-mono text-xs tabular-nums">
                    <span v-if="p.git!.ahead" class="text-info">↑{{ p.git!.ahead }}</span>
                    <span v-if="p.git!.behind" class="ml-1 text-warning">↓{{ p.git!.behind }}</span>
                    <span v-if="!p.git!.ahead && !p.git!.behind" class="opacity-40">—</span>
                  </td>
                  <td class="text-right"><button class="btn btn-ghost btn-xs">Open Git tab</button></td>
                </tr>
                <tr v-if="!repoSites.length">
                  <td colspan="5" class="py-5 text-center text-xs opacity-60">No site is a Git repository yet.</td>
                </tr>
              </tbody>
            </table>
          </div>
          <p v-if="plainSites.length" class="text-xs opacity-60">
            Not in Git: {{ plainSites.map((p) => p.name).join(', ') }} (Git tab → Initialize repository).
          </p>
        </div>
      </template>

      <!-- SSH keys -->
      <template v-else-if="view.kind === 'keys'">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <h2 class="text-lg font-semibold tracking-tight">SSH keys</h2>
          <div class="text-xs opacity-60">Keys in ~/.ssh, used for git@… remotes. Add one to an account so pushes over SSH work.</div>
        </header>
        <div class="flex-1 space-y-4 overflow-y-auto p-6">
          <div v-for="k in keys" :key="k.path" class="card">
            <div class="card-body gap-2">
              <div class="flex flex-wrap items-center gap-2">
                <span class="badge badge-ghost badge-sm font-mono">{{ k.type }}</span>
                <span class="font-medium">{{ k.comment || '(no comment)' }}</span>
                <span class="flex-1 truncate font-mono text-xs opacity-60">{{ k.path }}</span>
                <button class="btn btn-ghost btn-xs" @click="copy(k.publicKey)">Copy public key</button>
              </div>
              <div class="font-mono text-[11px] opacity-60">{{ k.fingerprint }}</div>
              <div v-if="accounts.length" class="flex items-center gap-2">
                <select v-model="keyTarget[k.path]" class="select select-xs w-56">
                  <option v-for="a in accounts" :key="a.id" :value="a.id">{{ NAME[a.kind] }} · {{ a.username }}</option>
                </select>
                <button class="btn btn-xs" @click="upload(k)">Add to account</button>
              </div>
            </div>
          </div>
          <p v-if="!keys.length" class="text-sm opacity-70">No SSH key yet.</p>
          <form class="card" @submit.prevent="generate">
            <div class="card-body gap-2">
              <div class="font-semibold">New key</div>
              <p class="text-xs opacity-70">
                ed25519 without a passphrase: <code>~/.ssh/id_ed25519</code> when free (ssh uses it by default), else <code>id_ed25519_devcatz</code> (add an
                <code>IdentityFile</code> line to ~/.ssh/config for it).
              </p>
              <div class="flex gap-2">
                <input v-model="keyEmail" class="input input-sm w-72" placeholder="you@example.com (key comment)" />
                <button class="btn btn-sm">Generate</button>
              </div>
            </div>
          </form>
        </div>
      </template>

      <!-- Add account -->
      <template v-else-if="view.kind === 'add'">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <h2 class="text-lg font-semibold tracking-tight">Connect an account</h2>
          <div class="text-xs opacity-60">For repositories to clone, pull requests and SSH keys. The token is encrypted with your {{ currentOS === 'mac' ? 'macOS Keychain' : words.secretStore }}.</div>
        </header>
        <form class="mx-auto w-full max-w-xl flex-1 space-y-4 overflow-y-auto p-6" @submit.prevent="add">
          <div class="grid grid-cols-4 gap-2">
            <button
              v-for="k in ['github', 'gitlab', 'gitea', 'bitbucket'] as GitHostKind[]"
              :key="k"
              type="button"
              class="flex flex-col items-center gap-1.5 rounded-box border p-3 text-xs"
              :class="form.kind === k ? 'border-[var(--c-git)] bg-[var(--c-git)]/10' : 'border-base-300/60'"
              @click="form.kind = k"
            >
              <svg class="size-6" viewBox="0 0 24 24" :style="{ color: ICON(k).color }"><path :d="ICON(k).d" fill="currentColor" /></svg>
              {{ NAME[k] }}
            </button>
          </div>
          <label class="block">
            <span class="label-caps mb-1 block">Server</span>
            <input v-model="form.baseUrl" class="input input-sm w-full font-mono" spellcheck="false" />
            <span class="mt-1 block text-xs opacity-60">Change it for a self-hosted {{ NAME[form.kind] }} (e.g. https://git.company.com).</span>
          </label>
          <label v-if="form.kind === 'bitbucket'" class="block">
            <span class="label-caps mb-1 block">Username</span>
            <input v-model="form.username" class="input input-sm w-full" spellcheck="false" />
          </label>
          <label class="block">
            <span class="label-caps mb-1 block">Personal access token</span>
            <input v-model="form.token" type="password" class="input input-sm w-full font-mono" autocomplete="off" spellcheck="false" />
            <span class="mt-1 block text-xs opacity-60">{{ scopes }} <a class="link" @click="H.openUrl(tokenUrl)">Create one ↗</a></span>
          </label>
          <button class="btn btn-primary btn-sm" :disabled="adding || !form.token.trim()"><span v-if="adding" class="loading loading-spinner loading-xs" />Connect</button>
        </form>
      </template>

      <!-- Account -->
      <template v-else-if="account">
        <header class="drag win-top border-b border-base-300/60 px-6 pt-5 pb-4">
          <div class="flex items-center gap-3">
            <img v-if="account.avatarUrl && !broken.has(account.id)" :src="account.avatarUrl" alt="" class="size-11 rounded-full bg-base-300/70" draggable="false" @error="broken.add(account.id)" />
            <span v-else class="grid size-11 place-items-center rounded-full bg-base-300/70"><svg class="size-6" viewBox="0 0 24 24" :style="{ color: ICON(account.kind).color }"><path :d="ICON(account.kind).d" fill="currentColor" /></svg></span>
            <div class="min-w-0 flex-1">
              <h2 class="flex items-center gap-2 text-lg font-semibold tracking-tight">
                <svg class="size-5" viewBox="0 0 24 24" :style="{ color: ICON(account.kind).color }"><path :d="ICON(account.kind).d" fill="currentColor" /></svg>
                {{ account.name || account.username }}
              </h2>
              <div class="text-xs opacity-60">@{{ account.username }} · {{ host(account.baseUrl) }}</div>
            </div>
            <button class="btn btn-sm no-drag" @click="H.openUrl(account.baseUrl)">Open {{ NAME[account.kind].split(' ')[0] }}</button>
            <button class="btn btn-ghost btn-sm text-error no-drag" @click="removing = account">Remove…</button>
          </div>
        </header>
        <div class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-6">
          <div class="flex items-center gap-2">
            <label class="search-box flex-1">
              <svg class="size-3.5 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>
              <input v-model="repoQuery" type="text" placeholder="Search your repositories" spellcheck="false" />
            </label>
            <label class="flex items-center gap-1.5 text-xs" title="Clone with git@… (needs an SSH key on the account)"><input v-model="useSsh" type="checkbox" class="checkbox checkbox-xs" />SSH</label>
            <span v-if="reposBusy" class="loading loading-spinner loading-xs" />
          </div>
          <div v-if="reposError" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ reposError }}</div>
          <div class="overflow-x-auto rounded-box border border-base-300/60">
            <table class="table table-sm">
              <tbody>
                <tr v-for="r in repos" :key="r.fullName">
                  <td>
                    <div class="flex items-center gap-2">
                      <a class="link link-hover font-medium" @click="H.openUrl(r.webUrl)">{{ r.fullName }}</a>
                      <span v-if="r.private" class="badge badge-ghost badge-xs">private</span>
                      <span v-if="r.fork" class="badge badge-ghost badge-xs">fork</span>
                    </div>
                    <div v-if="r.description" class="max-w-xl truncate text-xs opacity-60">{{ r.description }}</div>
                  </td>
                  <td class="text-right text-xs whitespace-nowrap opacity-60">{{ when(r.updatedAt) }}</td>
                  <td class="text-right whitespace-nowrap">
                    <button class="btn btn-sm" @click="clone(r)">Clone as site…</button>
                  </td>
                </tr>
                <tr v-if="!repos.length && !reposBusy">
                  <td colspan="3" class="py-5 text-center text-xs opacity-60">{{ repoQuery ? 'No repository matches.' : 'No repositories.' }}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      </template>
    </main>

    <ConfirmDialog
      v-if="removing"
      :title="`Remove ${NAME[removing.kind]} account ${removing.username}?`"
      text="Its token is deleted from DevCatz. Repositories and sites stay; revoke the token on the host too if you no longer need it."
      confirm="Remove"
      tone="error"
      @cancel="removing = null"
      @ok="remove"
    />
  </div>
</template>
