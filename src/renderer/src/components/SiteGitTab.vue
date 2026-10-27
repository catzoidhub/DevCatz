<script setup lang="ts">
import { keyLabel, words } from '@shared/platform';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { GitFile, GitStatus, GitSyncAction, ProjectState } from '@shared/types';
import GitDiff from './GitDiff.vue';
import GitHistory from './GitHistory.vue';
import GitBranches from './GitBranches.vue';
import GitPulls from './GitPulls.vue';
import GitWorktrees from './GitWorktrees.vue';
import AiWriteButton from './AiWriteButton.vue';
import { aiOn } from '../ai';
import type { AiCommitAnswer } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import PopMenu, { type MenuItem } from './PopMenu.vue';
import { attempt, herd, navRequest, notify, state } from '../store';
import CatMood from './CatMood.vue';
import GitignoreDialog from './GitignoreDialog.vue';
/** Template alias (vue-tsc reads an imported binding inside template arrow functions as a ref). */
const H = herd;

/**
 * A site's Git tab: branch and remote with fetch / pull / push, changed files
 * with a diff, stage / unstage / discard and commit; history, branches,
 * stashes, tags and pull requests in their own sub-tabs. Long operations run
 * as site tasks (output in Logs, Cancel).
 */
const props = defineProps<{ project: ProjectState }>();
/** The .gitignore editor dialog. */
const ignoreOpen = ref(false);
const emit = defineEmits<{ logs: [] }>();
const p = computed(() => props.project);

const st = ref<GitStatus | null>(null);
const loaded = ref(false);
const error = ref('');
async function load() {
  try {
    st.value = await herd.gitStatus(p.value.id);
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  loaded.value = true;
}
void load();
// The main process refreshes the summary after every operation and every 20 s: follow it.
watch(() => JSON.stringify(p.value.git), () => void load());
const onFocus = () => void load();
onMounted(() => window.addEventListener('focus', onFocus));
onBeforeUnmount(() => window.removeEventListener('focus', onFocus));

type Sub = 'changes' | 'history' | 'branches' | 'worktrees' | 'pulls';
const sub = ref<Sub>('changes');
const busy = computed(() => p.value.dbTask);
const gitBusy = computed(() => busy.value?.startsWith('git ') || busy.value?.startsWith('fetch pull'));

async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  const r = await attempt(fn, ok);
  await load();
  return r;
}

// ---- header: sync
const remote = computed(() => st.value?.remotes.find((r) => st.value?.upstream?.startsWith(`${r.name}/`)) ?? st.value?.remotes.find((r) => r.name === 'origin') ?? st.value?.remotes[0] ?? null);
const HOST: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket' };
/** Fetch / pull / push ask first (a stray click on Push is not what anyone wants). */
const askSync = ref<GitSyncAction | null>(null);
const SYNC_WORDS: Record<GitSyncAction, { title: string; text: string; confirm: string }> = {
  fetch: { title: 'Fetch from every remote?', text: 'Downloads new commits and branches; your files do not change.', confirm: 'Fetch' },
  pull: { title: 'Pull into this branch?', text: 'Merges the upstream commits into your branch (a merge commit when needed).', confirm: 'Pull' },
  'pull-rebase': { title: 'Pull with rebase?', text: 'Your local commits are replayed on top of the upstream ones; uncommitted changes are stashed and restored.', confirm: 'Pull (rebase)' },
  push: { title: 'Push to the remote?', text: 'Your commits go to the upstream branch (sets it on the first push).', confirm: 'Push' },
  'push-force': { title: 'Force push?', text: '', confirm: 'Force push' },
};
/** The confirm dialog's OK: runs the action it asked about (read before the dialog closes). */
function confirmSync() {
  const action = askSync.value;
  askSync.value = null;
  if (action) void sync(action);
}
async function sync(action: GitSyncAction) {
  const r = await attempt(() => herd.gitSync(p.value.id, action).then(() => true));
  if (r === undefined) emit('logs');
  else notify('success', action === 'fetch' ? 'Fetched' : action.startsWith('pull') ? 'Pulled' : 'Pushed');
  await load();
}
const pullItems: MenuItem[] = [
  { label: 'Pull (merge)', hint: 'git pull --no-rebase', action: () => (askSync.value = 'pull') },
  { label: 'Pull with rebase', hint: 'git pull --rebase --autostash', action: () => (askSync.value = 'pull-rebase') },
];
const forcePush = ref(false);
const pushItems: MenuItem[] = [
  { label: 'Push', action: () => (askSync.value = 'push') },
  { label: 'Force push (with lease)…', hint: 'Overwrites the remote branch', action: () => (forcePush.value = true) },
];

// ---- identity
const idName = ref('');
const idEmail = ref('');
const idGlobal = ref(true);
watch(st, (s) => {
  if (s && !idName.value) idName.value = s.identity.name ?? '';
  if (s && !idEmail.value) idEmail.value = s.identity.email ?? '';
});
async function saveIdentity() {
  if (await act(() => herd.gitSetIdentity(p.value.id, idName.value, idEmail.value, idGlobal.value).then(() => true), 'Identity saved')) idEditing.value = false;
}
const idEditing = ref(false);

// ---- remote
const newRemote = ref({ name: 'origin', url: '' });
async function addRemote() {
  if (await act(() => herd.gitAddRemote(p.value.id, newRemote.value.name.trim(), newRemote.value.url.trim()).then(() => true), `Remote ${newRemote.value.name} added`)) newRemote.value.url = '';
}

// ---- changes
const staged = computed(() => st.value?.files.filter((f) => f.staged && !f.conflict) ?? []);
const unstaged = computed(() => st.value?.files.filter((f) => (f.unstaged || f.untracked) && !f.conflict) ?? []);
const conflicts = computed(() => st.value?.files.filter((f) => f.conflict) ?? []);
const selected = ref<{ path: string; staged: boolean } | null>(null);
const diffText = ref('');
const diffBusy = ref(false);
async function showDiff(f: GitFile, inStaged: boolean) {
  selected.value = { path: f.path, staged: inStaged };
  diffBusy.value = true;
  diffText.value = (await attempt(() => herd.gitDiff(p.value.id, f.path, inStaged))) ?? '';
  diffBusy.value = false;
}
// Keep the diff in step with the files (it may have been staged / committed).
watch(st, (s) => {
  const sel = selected.value;
  if (!sel || !s) return;
  const f = s.files.find((x) => x.path === sel.path);
  if (!f) {
    selected.value = null;
    diffText.value = '';
  } else void showDiff(f, sel.staged && f.staged ? true : !f.unstaged && f.staged);
});
const LETTER: Record<string, string> = { M: 'M', A: 'A', D: 'D', R: 'R', C: 'C', U: 'U', T: 'T', '?': 'U' };
const letterOf = (f: GitFile, inStaged: boolean) => (f.untracked ? 'U' : LETTER[inStaged ? f.index : f.worktree] ?? '•');
const toneOf = (l: string) => (l === 'A' || l === 'U' ? 'text-success' : l === 'D' ? 'text-error' : l === 'R' || l === 'C' ? 'text-info' : 'text-warning');
const name = (path: string) => path.split('/').pop();
const dir = (path: string) => path.split('/').slice(0, -1).join('/');

const stage = (files: string[]) => act(() => herd.gitStage(p.value.id, files));
const unstage = (files: string[]) => act(() => herd.gitUnstage(p.value.id, files));
const discard = (files: string[]) => act(() => herd.gitDiscard(p.value.id, files));
const open = (file: string) => attempt(() => herd.gitOpenFile(p.value.id, file));

const message = ref('');
// ✦ Write with AI: subject and body from the staged diff, in the repository's style.
const aiCommitOn = aiOn('commit');
const aiCommitReq = () => ({ siteId: p.value.id, kind: 'commit' as const });
const fillMessage = (a: AiCommitAnswer) => (message.value = a.body ? `${a.title}\n\n${a.body}` : a.title);
const amend = ref(false);
const committing = ref(false);
watch(amend, async (on) => {
  if (on && !message.value.trim() && st.value?.last) message.value = st.value.last.subject;
});
async function commit(andPush = false) {
  committing.value = true;
  const ok = await act(() => herd.gitCommit(p.value.id, message.value, amend.value).then(() => true), amend.value ? 'Commit amended' : 'Committed');
  committing.value = false;
  if (!ok) return;
  message.value = '';
  amend.value = false;
  if (andPush) askSync.value = 'push';
}

// ---- .gitignore suggestions
const ignore = ref<string[] | null>(null);
const ignorePick = ref<Set<string>>(new Set());
async function loadIgnore() {
  ignore.value = (await attempt(() => herd.gitIgnoreSuggestions(p.value.id))) ?? [];
  ignorePick.value = new Set(ignore.value.filter((l) => !l.startsWith('!') && !l.includes('vscode')));
}
async function addIgnore() {
  if (await act(() => herd.gitIgnoreAdd(p.value.id, [...ignorePick.value]).then(() => true), `${ignorePick.value.size} line(s) added to .gitignore`)) ignore.value = null;
}

// ---- operation in progress
async function operation(action: 'continue' | 'skip' | 'abort') {
  await act(() => herd.gitOperation(p.value.id, action).then(() => true), action === 'abort' ? `${st.value?.operation} aborted` : action === 'skip' ? 'Skipped' : 'Continued');
}

function openGitPage() {
  navRequest.value = { section: 'git' };
}
</script>

<template>
  <section class="site-tab">
    <div v-if="!loaded" class="flex items-center gap-2 text-sm opacity-60"><span class="loading loading-spinner loading-sm" />Reading the repository…</div>

    <div v-else-if="error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ error }}</div>

    <!-- Not a repository -->
    <div v-else-if="!st" class="mx-auto max-w-lg space-y-3 pt-8 text-center">
      <div class="text-lg font-semibold">Not a Git repository</div>
      <p class="text-sm opacity-70">Start tracking this site's history: DevCatz runs <code>git init -b main</code> in {{ p.path }}, then you can commit and connect a remote.</p>
      <button class="btn btn-primary btn-sm" @click="act(() => H.gitInit(p.id).then(() => true), 'Repository created')">Initialize repository</button>
      <p v-if="state?.git.version === null" class="text-xs text-warning">git is not installed: run <code class="selectable">xcode-select --install</code> in Terminal.</p>
    </div>

    <template v-else>
      <!-- Header -->
      <div class="card">
        <div class="card-body">
          <div class="flex flex-wrap items-center gap-2">
            <span class="badge badge-lg gap-1.5 font-mono" :title="st.head ?? 'no commits yet'">
              <svg class="size-3.5 text-[var(--c-git)]" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M6 2a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm0 1.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM6 13a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm0 1.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM14 3.5a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5Zm0 1.3a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4ZM5.35 7h1.3v6h-1.3ZM14.65 8.5v.5c0 2.2-1.8 4-4 4H6.65v-1.3h4c1.48 0 2.7-1.22 2.7-2.7v-.5Z" /></svg>
              {{ st.branch ?? `detached @ ${st.head?.slice(0, 7)}` }}
            </span>
            <span v-if="st.upstream" class="font-mono text-xs opacity-60">→ {{ st.upstream }}</span>
            <span v-else-if="st.branch && st.remotes.length" class="text-xs opacity-60">not pushed yet</span>
            <span v-if="st.ahead" class="badge badge-soft badge-info badge-sm" :title="`${st.ahead} commit(s) to push`">↑ {{ st.ahead }}</span>
            <span v-if="st.behind" class="badge badge-soft badge-warning badge-sm" :title="`${st.behind} commit(s) to pull`">↓ {{ st.behind }}</span>
            <span class="flex-1" />
            <button class="btn btn-ghost btn-sm font-mono" title="Edit the files Git leaves out" @click="ignoreOpen = true">.gitignore</button>
            <span v-if="busy" class="flex items-center gap-1.5 text-xs opacity-70"><span class="loading loading-spinner loading-xs" />{{ busy }}…</span>
            <button v-if="gitBusy" class="btn btn-ghost btn-xs" @click="H.gitCancel(p.id)">Cancel</button>
            <template v-if="st.remotes.length">
              <button class="btn btn-sm" :disabled="!!busy" title="git fetch --prune (every remote)" @click="askSync = 'fetch'">Fetch</button>
              <div class="join">
                <button class="btn btn-sm join-item" :disabled="!!busy || !st.upstream" @click="askSync = 'pull'">Pull<span v-if="st.behind" class="opacity-60">&nbsp;{{ st.behind }}</span></button>
                <PopMenu :items="pullItems" align="end" :width="260"><button class="btn btn-sm join-item px-2" :disabled="!!busy || !st.upstream">▾</button></PopMenu>
              </div>
              <div class="join">
                <button class="btn btn-sm join-item" :class="{ 'btn-primary': st.ahead || (!st.upstream && st.head) }" :disabled="!!busy || !st.branch" @click="askSync = 'push'">
                  Push<span v-if="st.ahead">&nbsp;{{ st.ahead }}</span>
                </button>
                <PopMenu :items="pushItems" align="end" :width="260"><button class="btn btn-sm join-item px-2" :class="{ 'btn-primary': st.ahead }" :disabled="!!busy || !st.branch">▾</button></PopMenu>
              </div>
            </template>
            <button class="btn btn-ghost btn-sm btn-square" title="Refresh" @click="load">↻</button>
          </div>
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs opacity-70">
            <span v-for="r in st.remotes" :key="r.name" class="font-mono">
              {{ r.name }}: <a v-if="r.webUrl" class="link link-hover" @click="H.openUrl(r.webUrl)">{{ r.webUrl.replace(/^https:\/\//, '') }}</a><template v-else>{{ r.url }}</template>
              <span v-if="r.kind && !r.accountId" class="ml-1 opacity-70">(<a class="link" @click="openGitPage">connect {{ HOST[r.kind] }}</a> for pull requests)</span>
            </span>
            <span v-if="st.last">Last: <span class="font-mono">{{ st.last.short }}</span> {{ st.last.subject }} · {{ st.last.author }}</span>
            <span v-if="st.stashes">{{ st.stashes }} stash{{ st.stashes === 1 ? '' : 'es' }}</span>
            <span v-if="st.identity.email && !idEditing">as {{ st.identity.name }} &lt;{{ st.identity.email }}&gt; <a class="link" @click="idEditing = true">change</a></span>
          </div>
        </div>
      </div>

      <!-- Merge / rebase / cherry-pick in progress -->
      <div v-if="st.operation || conflicts.length" role="alert" class="alert alert-warning items-start text-sm"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />
        <div class="flex-1 space-y-2">
          <div v-if="st.operation" class="font-semibold">A {{ st.operation }} is in progress<template v-if="st.conflicts"> · {{ st.conflicts }} conflicted file{{ st.conflicts === 1 ? '' : 's' }}</template></div>
          <div v-else class="font-semibold">{{ conflicts.length }} conflicted file{{ conflicts.length === 1 ? '' : 's' }} (from applying a stash)</div>
          <ul v-if="conflicts.length" class="space-y-1">
            <li v-for="f in conflicts" :key="f.path" class="flex items-center gap-2">
              <code class="flex-1 truncate">{{ f.path }}</code>
              <button class="btn btn-xs" @click="open(f.path)">Open in editor</button>
              <button class="btn btn-xs" title="Stage it: the conflict is fixed" @click="stage([f.path])">Mark resolved</button>
            </li>
          </ul>
          <p class="text-xs opacity-80">
            Fix each file (remove the &lt;&lt;&lt;&lt;&lt;&lt;&lt; / ======= / &gt;&gt;&gt;&gt;&gt;&gt;&gt; markers), mark it resolved<template v-if="st.operation">, then Continue. Abort goes back to before it started.</template
            ><template v-else>. The stash is kept until you drop it (Branches &amp; tags → Stashes).</template>
          </p>
          <div v-if="st.operation" class="flex gap-2">
            <button class="btn btn-primary btn-sm" :disabled="!!st.conflicts" @click="operation('continue')">Continue</button>
            <button v-if="st.operation !== 'merge'" class="btn btn-sm" @click="operation('skip')">Skip this commit</button>
            <button class="btn btn-sm btn-ghost" @click="operation('abort')">Abort {{ st.operation }}</button>
          </div>
        </div>
      </div>

      <!-- Identity -->
      <div v-if="!st.identity.email || idEditing" class="card border-warning/50">
        <form class="card-body gap-2" @submit.prevent="saveIdentity">
          <div class="font-semibold">{{ st.identity.email ? 'Commit identity' : 'Who are you? Git needs a name and email for commits' }}</div>
          <div class="flex flex-wrap items-center gap-2">
            <input v-model="idName" class="input input-sm w-48" placeholder="Your name" />
            <input v-model="idEmail" class="input input-sm w-64" placeholder="you@example.com" type="email" />
            <label class="flex items-center gap-1.5 text-xs"><input v-model="idGlobal" type="checkbox" class="checkbox checkbox-xs" />for every repository (--global)</label>
            <button class="btn btn-primary btn-sm">Save</button>
            <button v-if="idEditing" type="button" class="btn btn-ghost btn-sm" @click="idEditing = false">Cancel</button>
          </div>
        </form>
      </div>

      <!-- No remote yet -->
      <div v-if="!st.remotes.length" class="card">
        <form class="card-body gap-2" @submit.prevent="addRemote">
          <div class="font-semibold">No remote</div>
          <p class="text-xs opacity-70">Create an empty repository on GitHub / GitLab / Gitea / Bitbucket and paste its URL to push this site there.</p>
          <div class="flex flex-wrap items-center gap-2">
            <input v-model="newRemote.name" class="input input-sm w-28 font-mono" />
            <input v-model="newRemote.url" class="input input-sm min-w-72 flex-1 font-mono" placeholder="git@github.com:you/repo.git or https://…" spellcheck="false" />
            <button class="btn btn-sm" :disabled="!newRemote.url.trim()">Add remote</button>
          </div>
        </form>
      </div>

      <div role="tablist" class="seg -mb-3 self-start">
        <a v-for="t in ['changes', 'history', 'branches', 'worktrees', 'pulls'] as Sub[]" :key="t" role="tab" class="seg-item" :class="{ 'is-active': sub === t }" @click="sub = t">
          {{ t === 'changes' ? `Changes${st.changed ? ` (${st.changed})` : ''}` : t === 'pulls' ? (remote?.kind === 'gitlab' ? 'Merge requests' : 'Pull requests') : t === 'branches' ? 'Branches & tags' : t === 'worktrees' ? 'Worktrees' : 'History' }}
        </a>
      </div>

      <!-- Changes -->
      <div v-if="sub === 'changes'" class="grid min-h-[28rem] flex-1 gap-4 lg:grid-cols-[minmax(16rem,22rem)_1fr]">
        <div class="flex min-h-0 flex-col gap-3">
          <div class="rounded-box border border-base-300/60">
            <div class="flex items-center gap-2 border-b border-base-300/60 px-3 py-2">
              <span class="label-caps flex-1">Staged · {{ staged.length }}</span>
              <button class="btn btn-ghost btn-xs" :disabled="!staged.length" @click="unstage(staged.map((f) => f.path))">Unstage all</button>
            </div>
            <ul class="max-h-56 overflow-y-auto py-1">
              <li v-for="f in staged" :key="'s' + f.path" class="git-file" :class="{ 'is-active': selected?.path === f.path && selected.staged }" @click="showDiff(f, true)">
                <span class="w-3 font-mono text-[11px] font-bold" :class="toneOf(letterOf(f, true))">{{ letterOf(f, true) }}</span>
                <span class="min-w-0 flex-1 truncate" :title="f.path"><span>{{ name(f.path) }}</span> <span class="text-[11px] opacity-50">{{ dir(f.path) }}</span></span>
                <button class="git-file-btn" title="Unstage" @click.stop="unstage([f.path])">−</button>
              </li>
              <li v-if="!staged.length" class="px-3 py-2 text-xs opacity-50">Nothing staged.</li>
            </ul>
          </div>
          <div class="rounded-box border border-base-300/60">
            <div class="flex items-center gap-2 border-b border-base-300/60 px-3 py-2">
              <span class="label-caps flex-1">Changes · {{ unstaged.length }}</span>
              <button class="btn btn-ghost btn-xs" :disabled="!unstaged.length" @click="discard(unstaged.map((f) => f.path))">Discard all</button>
              <button class="btn btn-ghost btn-xs" :disabled="!unstaged.length" @click="stage(unstaged.map((f) => f.path))">Stage all</button>
            </div>
            <ul class="max-h-72 overflow-y-auto py-1">
              <li v-for="f in unstaged" :key="'u' + f.path" class="git-file" :class="{ 'is-active': selected?.path === f.path && !selected.staged }" @click="showDiff(f, false)">
                <span class="w-3 font-mono text-[11px] font-bold" :class="toneOf(letterOf(f, false))">{{ letterOf(f, false) }}</span>
                <span class="min-w-0 flex-1 truncate" :title="f.path"><span>{{ name(f.path) }}</span> <span class="text-[11px] opacity-50">{{ dir(f.path) }}</span></span>
                <button class="git-file-btn" title="Open in editor" @click.stop="open(f.path)">↗</button>
                <button class="git-file-btn" title="Discard changes" @click.stop="discard([f.path])">↺</button>
                <button class="git-file-btn" title="Stage" @click.stop="stage([f.path])">+</button>
              </li>
              <li v-if="!unstaged.length" class="px-3 py-2 text-xs opacity-50">Working tree clean.</li>
            </ul>
          </div>

          <!-- Commit -->
          <form class="space-y-2" @submit.prevent="commit()">
            <textarea
              v-model="message"
              rows="3"
              class="textarea textarea-sm w-full"
              :placeholder="staged.length ? 'Commit message (first line = summary)' : 'Stage files, then write a message'"
              @keydown.meta.enter.prevent="commit()"
            />
            <div class="flex flex-wrap items-center gap-2">
              <AiWriteButton v-if="aiCommitOn" :run="(t: string) => H.aiCommit(aiCommitReq(), t)" :preview="() => H.aiPreviewCommit(aiCommitReq())" :disabled="!staged.length" title="Write the message with AI from the staged changes" @done="fillMessage" />
              <label class="flex items-center gap-1.5 text-xs" title="Replace the last commit (message and staged changes)"><input v-model="amend" type="checkbox" class="checkbox checkbox-xs" />Amend last commit</label>
              <span class="flex-1" />
              <button class="btn btn-primary btn-sm" :disabled="committing || !!busy || (!staged.length && !amend) || (!message.trim() && !amend)">
                <span v-if="committing" class="loading loading-spinner loading-xs" />Commit{{ staged.length ? ` ${staged.length}` : '' }}
              </button>
              <button v-if="st.remotes.length" type="button" class="btn btn-sm" :disabled="committing || !!busy || (!staged.length && !amend) || (!message.trim() && !amend)" title="Commit, then push" @click="commit(true)">
                Commit &amp; Push
              </button>
            </div>
            <p class="text-[11px] opacity-50">{{ keyLabel('mod+↩') }} commits.</p>
          </form>

          <!-- .gitignore -->
          <div class="rounded-box border border-base-300/60 p-3 text-xs">
            <div class="flex items-center gap-2">
              <span class="flex-1 font-medium">.gitignore</span>
              <button v-if="ignore === null" class="btn btn-ghost btn-xs" @click="loadIgnore">Suggest lines</button>
              <button class="btn btn-xs" title="Open .gitignore in an editor (or add one)" @click="ignoreOpen = true">Edit…</button>
            </div>
            <template v-if="ignore">
              <p v-if="!ignore.length" class="mt-1 opacity-60">Nothing to add for this stack.</p>
              <template v-else>
                <label v-for="l in ignore" :key="l" class="mt-1 flex items-center gap-2 font-mono">
                  <input type="checkbox" class="checkbox checkbox-xs" :checked="ignorePick.has(l)" @change="ignorePick.has(l) ? ignorePick.delete(l) : ignorePick.add(l); ignorePick = new Set(ignorePick)" />{{ l }}
                </label>
                <button class="btn btn-xs mt-2" :disabled="!ignorePick.size" @click="addIgnore">Add {{ ignorePick.size }} line(s)</button>
              </template>
            </template>
          </div>
        </div>

        <div class="flex min-h-0 flex-col rounded-box border border-base-300/60">
          <div class="flex items-center gap-2 border-b border-base-300/60 px-3 py-2 text-xs">
            <span class="min-w-0 flex-1 truncate font-mono">{{ selected ? selected.path : 'Select a file to see its changes' }}</span>
            <span v-if="selected" class="badge badge-ghost badge-xs">{{ selected.staged ? 'staged' : 'working tree' }}</span>
            <button v-if="selected" class="btn btn-ghost btn-xs" @click="open(selected.path)">Open in editor</button>
          </div>
          <div v-if="diffBusy" class="p-4 text-xs opacity-60">Loading…</div>
          <GitDiff v-else-if="selected" class="min-h-0 flex-1" :text="diffText" empty="No textual changes (mode change or binary file)." />
        </div>
      </div>

      <GitHistory v-else-if="sub === 'history'" :key="p.id + 'h'" :project="p" :status="st" @changed="load" @logs="emit('logs')" />
      <GitBranches v-else-if="sub === 'branches'" :key="p.id + 'b'" :project="p" :status="st" @changed="load" @logs="emit('logs')" />
      <GitWorktrees v-else-if="sub === 'worktrees'" :key="p.id + 'w'" :project="p" :status="st" @changed="load" @logs="emit('logs')" />
      <GitPulls v-else-if="sub === 'pulls'" :key="p.id + 'p'" :project="p" :status="st" :remote="remote" @changed="load" @logs="emit('logs')" />
    </template>

    <ConfirmDialog
      v-if="askSync && askSync !== 'push-force'"
      :title="SYNC_WORDS[askSync].title"
      :text="`${SYNC_WORDS[askSync].text}${st?.upstream ? ` Remote: ${st.upstream}.` : ''}`"
      :confirm="SYNC_WORDS[askSync].confirm"
      @cancel="askSync = null"
      @ok="confirmSync"
    />
    <ConfirmDialog
      v-if="forcePush"
      title="Force push?"
      :text="`The remote ${st?.upstream ?? 'branch'} is replaced by your ${st?.branch}. --force-with-lease refuses if someone pushed since your last fetch.`"
      confirm="Force push"
      tone="warning"
      @cancel="forcePush = false"
      @ok="forcePush = false; sync('push-force')"
    />
    <GitignoreDialog v-if="ignoreOpen" :site-id="p.id" :site-name="p.name" @close="ignoreOpen = false" @saved="ignore = null" />
  </section>
</template>


<style scoped>
.git-file {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 3px 8px 3px 12px;
  cursor: pointer;
  font-size: 12.5px;
}
.git-file:hover,
.git-file.is-active {
  background: oklch(from var(--color-base-content) l c h / 0.06);
}
.git-file.is-active {
  box-shadow: inset 2px 0 0 var(--c-git);
}
.git-file-btn {
  width: 20px;
  height: 20px;
  border-radius: 5px;
  font-size: 13px;
  line-height: 1;
  opacity: 0;
}
.git-file:hover .git-file-btn {
  opacity: 0.7;
}
.git-file-btn:hover {
  opacity: 1 !important;
  background: oklch(from var(--color-base-content) l c h / 0.1);
}
</style>
