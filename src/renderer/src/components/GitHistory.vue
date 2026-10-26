<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GitBranch, GitCommit, GitStatus, ProjectState } from '@shared/types';
import GitDiff from './GitDiff.vue';
import ConfirmDialog from './ConfirmDialog.vue';
import { attempt, herd, notify } from '../store';

/**
 * History of the current branch (or another one, to cherry-pick from), with
 * search, the patch of a commit, revert / reset / restore a file, and the
 * branch tools: rebase onto a branch and squash the branch's commits.
 */
const props = defineProps<{ project: ProjectState; status: GitStatus }>();
const emit = defineEmits<{ changed: []; logs: [] }>();
const id = computed(() => props.project.id);

const branches = ref<GitBranch[]>([]);
void herd.gitBranches(id.value).then((b) => (branches.value = b)).catch(() => undefined);
const others = computed(() => branches.value.filter((b) => !b.current));
/** '' = the current branch. */
const ref_ = ref('');
const search = ref('');
const commits = ref<GitCommit[]>([]);
const more = ref(false);
const loading = ref(false);
async function load(append = false) {
  loading.value = true;
  const list = (await attempt(() => herd.gitLog(id.value, search.value, append ? commits.value.length : 0, ref_.value || undefined))) ?? [];
  loading.value = false;
  commits.value = append ? [...commits.value, ...list] : list;
  more.value = list.length === 100 && !search.value.trim();
}
let timer: ReturnType<typeof setTimeout> | null = null;
watch(search, () => {
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => load(), 300);
});
watch(ref_, () => {
  open.value = null;
  void load();
});
watch(() => props.status.head, () => void load());
void load();

const open = ref<GitCommit | null>(null);
const patch = ref('');
const patchBusy = ref(false);
async function show(c: GitCommit) {
  if (open.value?.sha === c.sha) {
    open.value = null;
    return;
  }
  open.value = c;
  patchBusy.value = true;
  patch.value = (await attempt(() => herd.gitShow(id.value, c.sha))) ?? '';
  patchBusy.value = false;
}
const copy = async (t: string) => {
  await navigator.clipboard.writeText(t).catch(() => undefined);
  notify('info', `Copied ${t.slice(0, 7)}`);
};
const when = (iso: string) => {
  const d = new Date(iso);
  const days = (Date.now() - d.getTime()) / 86_400_000;
  return days < 1 ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : days < 7 ? `${Math.floor(days)}d ago` : d.toLocaleDateString();
};

async function act(fn: () => Promise<unknown>, ok: string) {
  const r = await attempt(() => fn().then(() => true), ok);
  emit('changed');
  await load();
  return r;
}

// ---- dangerous ones ask first
const confirm = ref<{ kind: 'reset' | 'revert' | 'cherry' | 'restore'; c: GitCommit } | null>(null);
const resetMode = ref<'soft' | 'mixed' | 'hard'>('mixed');
const restorePath = ref('');
const confirmBusy = ref(false);
async function doConfirm() {
  const c = confirm.value!;
  confirmBusy.value = true;
  if (c.kind === 'reset') await act(() => herd.gitReset(id.value, resetMode.value, c.c.sha), `Reset (${resetMode.value}) to ${c.c.short}`);
  else if (c.kind === 'revert') await act(() => herd.gitRevert(id.value, c.c.sha), `Reverted ${c.c.short}`);
  else if (c.kind === 'cherry') await act(() => herd.gitCherryPick(id.value, c.c.sha), `${c.c.short} applied to ${props.status.branch}`);
  else await act(() => herd.gitRestoreFile(id.value, restorePath.value.trim(), c.c.sha), `${restorePath.value} restored from ${c.c.short} (staged)`);
  confirmBusy.value = false;
  confirm.value = null;
}

// ---- rebase / squash
const onto = ref('');
watch(
  branches,
  (b) => {
    if (onto.value) return;
    const pick = ['main', 'master', 'develop', 'origin/main', 'origin/master'].find((n) => b.some((x) => x.name === n && !x.current));
    onto.value = pick ?? b.find((x) => !x.current)?.name ?? '';
  },
  { immediate: true },
);
const rebaseAsk = ref(false);
const squashAsk = ref(false);
const squashMsg = ref('');
async function rebase() {
  rebaseAsk.value = false;
  await act(() => herd.gitOperation(id.value, 'rebase', onto.value), `Rebased onto ${onto.value}`);
}
async function squash() {
  squashAsk.value = false;
  await act(() => herd.gitSquash(id.value, onto.value, squashMsg.value), 'Commits squashed into one');
}
</script>

<template>
  <div class="grid min-h-[28rem] flex-1 gap-4 xl:grid-cols-[minmax(22rem,1fr)_1.2fr]">
    <div class="flex min-h-0 flex-col gap-3">
      <div class="flex flex-wrap items-center gap-2">
        <select v-model="ref_" class="select select-sm w-44" title="Branch whose history is shown">
          <option value="">{{ status.branch ?? 'HEAD' }} (current)</option>
          <option v-for="b in others" :key="b.name" :value="b.name">{{ b.name }}</option>
        </select>
        <label class="search-box flex-1">
          <svg class="size-3.5 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM2 9a7 7 0 1 1 12.452 4.391l3.328 3.329a.75.75 0 1 1-1.06 1.06l-3.329-3.328A7 7 0 0 1 2 9Z" clip-rule="evenodd" /></svg>
          <input v-model="search" type="text" placeholder="Message, author or commit id" spellcheck="false" />
        </label>
        <span v-if="loading" class="loading loading-spinner loading-xs" />
      </div>
      <p v-if="ref_" class="text-xs opacity-60">History of <code>{{ ref_ }}</code>: Cherry-pick copies a commit onto {{ status.branch }}.</p>

      <ul class="h-[26rem] overflow-y-auto rounded-box border border-base-300/60">
        <li v-for="c in commits" :key="c.sha" class="commit" :class="{ 'is-active': open?.sha === c.sha }" @click="show(c)">
          <div class="flex items-center gap-2">
            <span class="min-w-0 flex-1 truncate font-medium">{{ c.subject }}</span>
            <span v-for="r in c.refs.slice(0, 3)" :key="r" class="badge badge-ghost badge-xs max-w-32 truncate font-mono">{{ r.replace('HEAD -> ', '') }}</span>
          </div>
          <div class="flex items-center gap-2 text-[11px] opacity-60">
            <span class="font-mono">{{ c.short }}</span>
            <span class="truncate">{{ c.author }}</span>
            <span class="ml-auto shrink-0">{{ when(c.date) }}</span>
          </div>
        </li>
        <li v-if="!commits.length && !loading" class="p-4 text-center text-xs opacity-60">{{ search ? 'No commit matches.' : 'No commits yet.' }}</li>
        <li v-if="more" class="p-2 text-center"><button class="btn btn-ghost btn-xs" :disabled="loading" @click="load(true)">Older commits</button></li>
      </ul>

      <!-- Branch tools -->
      <div class="rounded-box border border-base-300/60 p-3">
        <div class="mb-2 text-sm font-medium">Branch tools</div>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <span class="text-xs opacity-70">Base</span>
          <select v-model="onto" class="select select-xs w-44">
            <option v-for="b in others" :key="b.name" :value="b.name">{{ b.name }}</option>
          </select>
          <button class="btn btn-xs" :disabled="!onto || !!project.dbTask || !!status.changed" :title="status.changed ? 'Commit or stash your changes first' : ''" @click="rebaseAsk = true">Rebase onto it…</button>
          <button class="btn btn-xs" :disabled="!onto || !!project.dbTask || !!status.changed" @click="squashMsg = status.last?.subject ?? ''; squashAsk = true">Squash since it…</button>
        </div>
        <p class="mt-2 text-xs opacity-60">
          Rebase replays {{ status.branch }}'s commits on top of the base (conflicts show a walkthrough above). Squash turns the branch's commits since the base into one.
        </p>
      </div>
    </div>

    <div class="flex min-h-0 flex-col rounded-box border border-base-300/60">
      <template v-if="open">
        <div class="flex flex-wrap items-center gap-2 border-b border-base-300/60 px-3 py-2 text-xs">
          <a class="font-mono link link-hover" title="Copy the full id" @click="copy(open.sha)">{{ open.short }}</a>
          <span class="min-w-0 flex-1 truncate font-medium">{{ open.subject }}</span>
          <button v-if="ref_" class="btn btn-xs btn-primary" :disabled="!!project.dbTask" @click="confirm = { kind: 'cherry', c: open }">Cherry-pick</button>
          <template v-else>
            <button class="btn btn-xs" :disabled="!!project.dbTask" @click="confirm = { kind: 'revert', c: open }">Revert</button>
            <button class="btn btn-xs" :disabled="!!project.dbTask" @click="restorePath = ''; confirm = { kind: 'restore', c: open }">Restore a file…</button>
            <button class="btn btn-xs btn-ghost text-warning" :disabled="!!project.dbTask" @click="resetMode = 'mixed'; confirm = { kind: 'reset', c: open }">Reset to here…</button>
          </template>
        </div>
        <div v-if="patchBusy" class="p-4 text-xs opacity-60">Loading…</div>
        <GitDiff v-else class="min-h-0 flex-1" :text="patch" />
      </template>
      <div v-else class="flex flex-1 items-center justify-center p-6 text-xs opacity-60">Select a commit to see its changes.</div>
    </div>

    <ConfirmDialog
      v-if="confirm"
      :title="confirm.kind === 'reset' ? `Reset ${status.branch} to ${confirm.c.short}?` : confirm.kind === 'revert' ? `Revert ${confirm.c.short}?` : confirm.kind === 'cherry' ? `Cherry-pick ${confirm.c.short}?` : `Restore a file from ${confirm.c.short}?`"
      :text="
        confirm.kind === 'revert'
          ? 'A new commit undoes its changes; history is kept.'
          : confirm.kind === 'cherry'
            ? `Its changes are applied to ${status.branch} as a new commit.`
            : confirm.kind === 'restore'
              ? 'The file goes back to how it was in this commit (staged, so you can review it before committing).'
              : ''
      "
      :confirm="confirm.kind === 'reset' ? `Reset (${resetMode})` : confirm.kind === 'revert' ? 'Revert' : confirm.kind === 'cherry' ? 'Cherry-pick' : 'Restore'"
      :tone="confirm.kind === 'reset' && resetMode === 'hard' ? 'error' : confirm.kind === 'reset' ? 'warning' : 'primary'"
      :busy="confirmBusy"
      @cancel="confirm = null"
      @ok="doConfirm"
    >
      <div v-if="confirm.kind === 'reset'" class="space-y-1.5 text-sm">
        <label class="flex items-start gap-2"><input v-model="resetMode" type="radio" value="soft" class="radio radio-xs mt-1" /><span><b>Soft</b>: later commits undone, their changes stay staged.</span></label>
        <label class="flex items-start gap-2"><input v-model="resetMode" type="radio" value="mixed" class="radio radio-xs mt-1" /><span><b>Mixed</b>: later commits undone, changes kept in the working tree.</span></label>
        <label class="flex items-start gap-2"><input v-model="resetMode" type="radio" value="hard" class="radio radio-xs radio-error mt-1" /><span><b>Hard</b>: later commits <u>and</u> uncommitted changes are thrown away.</span></label>
      </div>
      <input v-if="confirm.kind === 'restore'" v-model="restorePath" class="input input-sm w-full font-mono" placeholder="path/in/the/repo.php" spellcheck="false" />
    </ConfirmDialog>
    <ConfirmDialog
      v-if="rebaseAsk"
      :title="`Rebase ${status.branch} onto ${onto}?`"
      text="Your branch's commits are rewritten on top of the base. Already pushed? You will need a force push (with lease) afterwards."
      confirm="Rebase"
      tone="warning"
      @cancel="rebaseAsk = false"
      @ok="rebase"
    />
    <ConfirmDialog v-if="squashAsk" :title="`Squash ${status.branch} since ${onto}?`" confirm="Squash" tone="warning" @cancel="squashAsk = false" @ok="squash">
      <p class="text-sm opacity-70">Every commit since the branch left {{ onto }} becomes one commit with this message:</p>
      <textarea v-model="squashMsg" rows="3" class="textarea textarea-sm w-full" />
    </ConfirmDialog>
  </div>
</template>

<style scoped>
.commit {
  padding: 6px 12px;
  cursor: pointer;
  border-bottom: 1px solid oklch(from var(--color-base-content) l c h / 0.05);
  font-size: 12.5px;
}
.commit:hover,
.commit.is-active {
  background: oklch(from var(--color-base-content) l c h / 0.06);
}
.commit.is-active {
  box-shadow: inset 2px 0 0 var(--c-git);
}
</style>
