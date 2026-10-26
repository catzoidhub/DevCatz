<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GitBranch, GitStatus, ProjectState, WorktreeCheck, WorktreeCreateOptions, WorktreeInfo } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import { attempt, herd, notify, openSiteRequest, state } from '../store';
import CatMood from './CatMood.vue';

/**
 * Git worktrees of a site's repository: each one can run as its own site (a child of this one, on
 * `<branch>.<site>.localhost` with its own ports), side by side with the others. New worktree… makes one;
 * worktrees made elsewhere (Claude Code, agents, `git worktree add`) are listed with "Add as site".
 */
const props = defineProps<{ project: ProjectState; status: GitStatus }>();
const emit = defineEmits<{ changed: []; logs: [] }>();
const p = computed(() => props.project);
const parent = computed(() => (p.value.worktreeOf ? (state.value?.projects.find((x) => x.id === p.value.worktreeOf) ?? null) : null));
/** The site the worktrees hang under (this one, or this worktree's parent). */
const owner = computed(() => parent.value ?? p.value);

const items = ref<WorktreeInfo[]>([]);
const defaultFolder = ref('');
const error = ref('');
async function load() {
  try {
    const r = await herd.worktreeList(p.value.id);
    items.value = r.items;
    defaultFolder.value = r.defaultFolder;
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}
void load();
// Sites come and go (added, removed) and the branch moves: follow them.
watch(() => [state.value?.projects.length, props.status.branch], () => void load());

const siteOf = (id: string | null) => (id ? (state.value?.projects.find((x) => x.id === id) ?? null) : null);
const prunable = computed(() => items.value.some((w) => w.prunable));
const shortPath = (path: string) => path.replace(/^\/Users\/[^/]+/, '~');

// ---- New worktree…
const branches = ref<GitBranch[]>([]);
const form = ref<(WorktreeCreateOptions & { open: boolean }) | null>(null);
const busy = ref(false);
async function openForm() {
  branches.value = await herd.gitBranches(p.value.id).catch(() => []);
  form.value = { open: true, branch: '', create: true, from: props.status.branch ?? '', folder: '', deps: 'clone', database: 'shared' };
}
/** Branches without a worktree yet (git refuses a branch checked out elsewhere); remote ones by their short name. */
const free = computed(() => {
  const used = new Set(items.value.map((w) => w.branch));
  const names = branches.value.map((b) => (b.remote ? b.name.replace(/^[^/]+\//, '') : b.name)).filter((n) => n !== 'HEAD' && !used.has(n));
  return [...new Set(names)];
});
const locals = computed(() => branches.value.filter((b) => !b.remote).map((b) => b.name));
const dbName = computed(() => owner.value.stack.database?.database ?? null);
const canCopyDb = computed(() => Boolean(owner.value.dbService || owner.value.stack.database?.engine === 'sqlite'));
async function create() {
  const f = form.value;
  if (!f || !f.branch.trim()) return;
  busy.value = true;
  const { open: _, ...options } = f;
  const id = await attempt(() => herd.worktreeCreate(p.value.id, { ...options, branch: f.branch.trim() }));
  busy.value = false;
  if (!id) return;
  form.value = null;
  notify('success', `Worktree ${f.branch.trim()} is a site now`);
  emit('changed');
  await load();
  openSiteRequest.value = id;
}

async function pickFolder() {
  const dir = await herd.pickFolder();
  if (dir && form.value) form.value.folder = dir;
}

async function addAsSite(w: WorktreeInfo) {
  const id = await attempt(() => herd.worktreeAdd(p.value.id, w.sitePath), `${w.branch ?? 'Worktree'} added as a site`);
  await load();
  if (id) openSiteRequest.value = id;
}
async function prune() {
  await attempt(() => herd.worktreePrune(p.value.id), 'Missing worktrees forgotten');
  await load();
}

// ---- Remove worktree (this site is one)
const removing = ref<(WorktreeCheck & { drop: boolean }) | null>(null);
async function askRemove() {
  const c = await attempt(() => herd.worktreeCheck(p.value.id));
  if (c) removing.value = { ...c, drop: Boolean(c.database) };
}
const loses = computed(() => {
  const r = removing.value;
  if (!r) return '';
  const parts = [r.changed ? `${r.changed} uncommitted change${r.changed === 1 ? '' : 's'}` : '', r.unpushed ? `${r.unpushed} commit${r.unpushed === 1 ? '' : 's'} not pushed` : ''].filter(Boolean);
  return parts.join(' and ');
});
async function doRemove() {
  const r = removing.value!;
  busy.value = true;
  const back = parent.value?.id ?? null;
  const ok = await attempt(() => herd.worktreeRemove(p.value.id, Boolean(r.changed || r.unpushed), r.drop).then(() => true), 'Worktree removed');
  busy.value = false;
  removing.value = null;
  if (ok && back) openSiteRequest.value = back;
}

const autoAdd = computed(() => state.value?.settings.worktreeAutoAdd ?? false);
const setAutoAdd = (on: boolean) => attempt(() => herd.updateSettings({ worktreeAutoAdd: on }));
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- This site is a worktree -->
    <div v-if="parent" class="card border-primary/30">
      <div class="card-body flex-row flex-wrap items-center gap-3 p-4">
        <svg class="size-5 shrink-0 text-primary" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M5 3.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM2 5a3 3 0 1 1 3.75 2.9v4.2A3 3 0 1 1 4.25 12.1V7.9A3 3 0 0 1 2 5Zm13-1.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3ZM12 5a3 3 0 1 1 3.75 2.9V9a3 3 0 0 1-3 3H8.56l1.22 1.22a.75.75 0 1 1-1.06 1.06l-2.5-2.5a.75.75 0 0 1 0-1.06l2.5-2.5a.75.75 0 1 1 1.06 1.06L8.56 10.5h4.19a1.5 1.5 0 0 0 1.5-1.5V7.9A3 3 0 0 1 12 5ZM5 13.5a1.5 1.5 0 1 0 0 3 1.5 1.5 0 0 0 0-3Z" clip-rule="evenodd" /></svg>
        <div class="min-w-0 flex-1">
          <div class="font-medium">Worktree of {{ parent.name }}<span v-if="status.branch"> on <span class="font-mono">{{ status.branch }}</span></span></div>
          <div class="text-xs opacity-60">Its own folder, domain and ports; it shares the repository's history and branches with {{ parent.name }}.</div>
        </div>
        <button class="btn btn-sm" @click="openSiteRequest = parent.id">Open {{ parent.name }}</button>
        <button class="btn btn-sm btn-error btn-outline" :disabled="busy" @click="askRemove">Remove worktree…</button>
      </div>
    </div>

    <div class="card">
      <div class="card-body gap-3 p-4">
        <div class="flex flex-wrap items-center gap-2">
          <h2 class="font-semibold">Worktrees</h2>
          <span class="text-xs opacity-60">Several branches of {{ owner.name }} running side by side, each on its own domain.</span>
          <span class="flex-1" />
          <button v-if="prunable" class="btn btn-ghost btn-sm" title="git worktree prune" @click="prune">Forget missing</button>
          <button class="btn btn-primary btn-sm" @click="openForm">New worktree…</button>
        </div>
        <div v-if="error" class="alert alert-warning text-sm"><CatMood mood="warning" class="size-7 shrink-0 -my-0.5" />{{ error }}</div>
        <div v-else class="overflow-x-auto">
          <table class="table table-sm">
            <thead>
              <tr><th>Branch</th><th>Folder</th><th class="text-right">Site</th></tr>
            </thead>
            <tbody>
              <tr v-for="w in items" :key="w.path" :class="{ 'opacity-60': w.prunable }">
                <td class="font-mono">
                  {{ w.branch ?? (w.head ? `detached ${w.head.slice(0, 7)}` : '—') }}
                  <span v-if="w.main" class="badge badge-ghost badge-xs ml-1">main</span>
                  <span v-if="w.locked" class="badge badge-ghost badge-xs ml-1">locked</span>
                </td>
                <td class="max-w-0 w-full"><span class="block truncate font-mono text-xs opacity-70" :title="w.path">{{ shortPath(w.path) }}</span></td>
                <td class="whitespace-nowrap text-right">
                  <span v-if="w.prunable" class="badge badge-warning badge-soft badge-sm">folder missing</span>
                  <span v-else-if="w.siteId === p.id" class="badge badge-primary badge-soft badge-sm">this site</span>
                  <button v-else-if="w.siteId" class="btn btn-ghost btn-xs" :title="siteOf(w.siteId)?.domain" @click="openSiteRequest = w.siteId">{{ siteOf(w.siteId)?.domain ?? 'Open' }} →</button>
                  <button v-else class="btn btn-xs" @click="addAsSite(w)">Add as site</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <label class="flex cursor-pointer items-start gap-2 text-sm">
          <input type="checkbox" class="toggle toggle-sm mt-0.5" :checked="autoAdd" @change="setAutoAdd(($event.target as HTMLInputElement).checked)" />
          <span>
            Add new worktrees as sites automatically
            <span class="block text-xs opacity-60">For every site: worktrees made by Claude Code, other agents or <span class="font-mono">git worktree add</span> get their own preview URL, with a notification.</span>
          </span>
        </label>
      </div>
    </div>

    <!-- New worktree… -->
    <dialog v-if="form" open class="modal modal-open" @keydown.esc="!busy && (form = null)">
      <form class="modal-box w-[34rem] max-w-[95vw] space-y-3" @submit.prevent="create">
        <h3 class="text-lg font-semibold tracking-tight">New worktree of {{ owner.name }}</h3>
        <div role="tablist" class="seg">
          <a role="tab" class="seg-item" :class="{ 'is-active': form.create }" @click="form.create = true">New branch</a>
          <a role="tab" class="seg-item" :class="{ 'is-active': !form.create }" @click="form.create = false">Existing branch</a>
        </div>
        <label class="block space-y-1">
          <span class="text-xs font-medium opacity-70">Branch</span>
          <input v-model="form.branch" class="input input-sm w-full font-mono" :list="form.create ? undefined : 'wt-branches'" :placeholder="form.create ? 'feat/login' : 'Pick or type a branch'" spellcheck="false" autofocus />
          <datalist id="wt-branches"><option v-for="b in free" :key="b" :value="b" /></datalist>
        </label>
        <label v-if="form.create" class="block space-y-1">
          <span class="text-xs font-medium opacity-70">Start from</span>
          <select v-model="form.from" class="select select-sm w-full font-mono">
            <option v-for="b in locals" :key="b" :value="b">{{ b }}</option>
          </select>
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium opacity-70">Folder (the worktree goes in a subfolder named after the branch)</span>
          <div class="flex gap-2">
            <input v-model="form.folder" class="input input-sm flex-1 font-mono text-xs" :placeholder="shortPath(defaultFolder)" spellcheck="false" />
            <button type="button" class="btn btn-sm" @click="pickFolder">Choose…</button>
          </div>
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium opacity-70">Dependencies (node_modules, vendor)</span>
          <select v-model="form.deps" class="select select-sm w-full">
            <option value="clone">Clone from {{ owner.name }} — instant, no extra disk (APFS)</option>
            <option value="install">Install fresh</option>
            <option value="none">Leave out</option>
          </select>
        </label>
        <label class="block space-y-1">
          <span class="text-xs font-medium opacity-70">Database</span>
          <select v-model="form.database" class="select select-sm w-full">
            <option value="shared">Share {{ owner.name }}'s database{{ dbName ? ` (${dbName})` : '' }}</option>
            <option value="copy" :disabled="!canCopyDb">Its own copy{{ dbName ? ` (${dbName}_…)` : '' }}{{ canCopyDb ? '' : ' — link a DevCatz database service first' }}</option>
          </select>
          <span v-if="form.database === 'copy'" class="block text-xs opacity-60">Copied from {{ dbName ?? 'the site' }}, then the branch's migrations run on it; schema changes stay off {{ owner.name }}'s data.</span>
        </label>
        <p class="text-xs opacity-60">
          The .env files are copied with the domain changed to <span class="font-mono">{{ form.branch ? `${form.branch.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}.${owner.domain}` : `<branch>.${owner.domain}` }}</span>;
          queue worker, scheduler and Reverb stay off so jobs are not run twice.
        </p>
        <div class="modal-action">
          <button type="button" class="btn btn-ghost btn-sm" :disabled="busy" @click="form = null">Cancel</button>
          <button class="btn btn-primary btn-sm" :disabled="busy || !form.branch.trim()"><span v-if="busy" class="loading loading-spinner loading-xs" />Create worktree</button>
        </div>
      </form>
      <div class="modal-backdrop" @click="!busy && (form = null)" />
    </dialog>

    <ConfirmDialog
      v-if="removing"
      :title="`Remove the ${removing.branch ?? ''} worktree?`"
      :text="
        loses
          ? `It has ${loses}: they are thrown away with the folder. The branch itself stays in the repository.`
          : 'Its folder and this site go; the branch stays in the repository.'
      "
      :confirm="loses ? 'Throw away & remove' : 'Remove worktree'"
      tone="error"
      :busy="busy"
      @ok="doRemove"
      @cancel="removing = null"
    >
      <label v-if="removing.database" class="flex cursor-pointer items-center gap-2 text-sm">
        <input v-model="removing.drop" type="checkbox" class="checkbox checkbox-sm" />
        Also drop its database <span class="font-mono">{{ removing.database }}</span>
      </label>
    </ConfirmDialog>
  </div>
</template>
