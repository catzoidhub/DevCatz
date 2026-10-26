<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { GitBranch, GitStash, GitStatus, GitTag, ProjectState } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import { attempt, herd } from '../store';
/** Template alias (vue-tsc reads an imported binding inside template arrow functions as a ref). */
const H = herd;

/** Branches (local and remote), stashes and tags of a site's repository. */
const props = defineProps<{ project: ProjectState; status: GitStatus }>();
const emit = defineEmits<{ changed: []; logs: [] }>();
const id = computed(() => props.project.id);

const branches = ref<GitBranch[]>([]);
const stashes = ref<GitStash[]>([]);
const tags = ref<GitTag[]>([]);
async function load() {
  [branches.value, stashes.value, tags.value] = await Promise.all([
    herd.gitBranches(id.value).catch(() => []),
    herd.gitStashes(id.value).catch(() => []),
    herd.gitTags(id.value).catch(() => []),
  ]);
}
void load();
watch(() => [props.status.head, props.status.branch, props.status.stashes], () => void load());

const local = computed(() => branches.value.filter((b) => !b.remote));
const remote = computed(() => branches.value.filter((b) => b.remote && !local.value.some((l) => l.upstream === b.name)));
const showRemote = ref(false);

async function act(fn: () => Promise<unknown>, ok: string) {
  const r = await attempt(() => fn().then(() => true), ok);
  emit('changed');
  await load();
  return r;
}

const newName = ref('');
const from = ref('');
async function create() {
  if (await act(() => herd.gitBranch(id.value, 'create', newName.value.trim(), from.value || undefined), `Switched to new branch ${newName.value.trim()}`)) {
    newName.value = '';
    from.value = '';
  }
}
const confirm = ref<{ kind: 'delete' | 'merge'; b: GitBranch } | null>(null);
async function doConfirm() {
  const c = confirm.value!;
  confirm.value = null;
  if (c.kind === 'merge') await act(() => herd.gitBranch(id.value, 'merge', c.b.name), `${c.b.name} merged into ${props.status.branch}`);
  else {
    const ok = await attempt(() => herd.gitBranch(id.value, 'delete', c.b.name).then(() => true), `Branch ${c.b.name} deleted`);
    // Not merged anywhere: ask again for -D.
    if (ok === undefined) forceDelete.value = c.b;
    await load();
  }
}
const forceDelete = ref<GitBranch | null>(null);

const stashMsg = ref('');
const dropStash = ref<GitStash | null>(null);
const tagName = ref('');
const tagMsg = ref('');
const deleteTag = ref<GitTag | null>(null);
const when = (iso: string) => (iso ? new Date(iso).toLocaleDateString() : '');
</script>

<template>
  <div class="grid gap-4 xl:grid-cols-2">
    <!-- Branches -->
    <div class="space-y-3 xl:row-span-2">
      <div class="overflow-x-auto rounded-box border border-base-300/60">
        <table class="table table-sm">
          <thead>
            <tr><th>Branch</th><th>Upstream</th><th>Last commit</th><th></th></tr>
          </thead>
          <tbody>
            <tr v-for="b in local" :key="b.name" :class="{ 'bg-base-200/50': b.current }">
              <td class="font-mono">
                <span v-if="b.current" class="mr-1 text-[var(--c-git)]">●</span>{{ b.name }}
              </td>
              <td class="font-mono text-xs">
                <template v-if="b.upstream">
                  {{ b.upstream }}
                  <span v-if="b.ahead" class="ml-1 text-info">↑{{ b.ahead }}</span>
                  <span v-if="b.behind" class="ml-1 text-warning">↓{{ b.behind }}</span>
                </template>
                <span v-else class="opacity-50">local only</span>
              </td>
              <td class="max-w-56 truncate text-xs" :title="b.subject">
                <span class="font-mono opacity-60">{{ b.sha }}</span> {{ b.subject }}
              </td>
              <td class="text-right whitespace-nowrap">
                <template v-if="!b.current">
                  <button class="btn btn-ghost btn-xs" :disabled="!!project.dbTask" @click="act(() => H.gitBranch(id, 'switch', b.name), `Switched to ${b.name}`)">Switch</button>
                  <button class="btn btn-ghost btn-xs" :disabled="!!project.dbTask || !status.branch" @click="confirm = { kind: 'merge', b }">Merge</button>
                  <button class="btn btn-ghost btn-xs text-error" @click="confirm = { kind: 'delete', b }">Delete</button>
                </template>
                <span v-else class="badge badge-ghost badge-xs">current</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <form class="flex flex-wrap items-center gap-2" @submit.prevent="create">
        <input v-model="newName" class="input input-sm w-52 font-mono" placeholder="feature/new-thing" spellcheck="false" />
        <select v-model="from" class="select select-sm w-44" title="Start from">
          <option value="">from {{ status.branch ?? 'HEAD' }}</option>
          <option v-for="b in branches.filter((x) => !x.current)" :key="b.name" :value="b.name">from {{ b.name }}</option>
        </select>
        <button class="btn btn-sm" :disabled="!newName.trim() || !!project.dbTask">Create &amp; switch</button>
      </form>

      <div v-if="remote.length" class="rounded-box border border-base-300/60">
        <button class="flex w-full items-center gap-2 px-3 py-2 text-left text-sm" @click="showRemote = !showRemote">
          <span class="flex-1 font-medium">Remote branches · {{ remote.length }}</span>
          <span class="text-xs opacity-60">{{ showRemote ? 'hide' : 'show' }}</span>
        </button>
        <ul v-if="showRemote" class="max-h-72 overflow-y-auto border-t border-base-300/60">
          <li v-for="b in remote" :key="b.name" class="flex items-center gap-2 px-3 py-1.5 text-xs">
            <span class="min-w-0 flex-1 truncate font-mono">{{ b.name }}</span>
            <span class="shrink-0 opacity-50">{{ when(b.date) }}</span>
            <button class="btn btn-ghost btn-xs" :disabled="!!project.dbTask" title="Local branch that tracks it" @click="act(() => H.gitBranch(id, 'switch', b.name), `Checked out ${b.name}`)">Check out</button>
          </li>
        </ul>
      </div>
    </div>

    <!-- Stashes -->
    <div class="rounded-box border border-base-300/60 p-3">
      <div class="mb-2 flex items-center gap-2">
        <span class="flex-1 text-sm font-medium">Stashes</span>
      </div>
      <form class="mb-2 flex gap-2" @submit.prevent="act(() => H.gitStash(id, 'save', stashMsg), 'Changes stashed').then((ok) => ok && (stashMsg = ''))">
        <input v-model="stashMsg" class="input input-sm flex-1" placeholder="What is this work? (optional)" />
        <button class="btn btn-sm" :disabled="!status.changed || !!project.dbTask" :title="status.changed ? 'Put your changes (also new files) aside' : 'Nothing to stash'">Stash changes</button>
      </form>
      <ul class="space-y-1">
        <li v-for="s in stashes" :key="s.ref" class="flex items-center gap-2 text-xs">
          <code class="opacity-60">{{ s.ref }}</code>
          <span class="min-w-0 flex-1 truncate">{{ s.message }}</span>
          <button class="btn btn-ghost btn-xs" @click="act(() => H.gitStash(id, 'apply', s.ref), 'Stash applied')">Apply</button>
          <button class="btn btn-ghost btn-xs" title="Apply and drop" @click="act(() => H.gitStash(id, 'pop', s.ref), 'Stash applied and dropped')">Pop</button>
          <button class="btn btn-ghost btn-xs text-error" @click="dropStash = s">Drop</button>
        </li>
        <li v-if="!stashes.length" class="text-xs opacity-50">No stashes.</li>
      </ul>
    </div>

    <!-- Tags -->
    <div class="rounded-box border border-base-300/60 p-3">
      <div class="mb-2 text-sm font-medium">Tags</div>
      <form class="mb-2 flex flex-wrap gap-2" @submit.prevent="act(() => H.gitTag(id, 'create', tagName, tagMsg), `Tag ${tagName} created`).then((ok) => ok && ((tagName = ''), (tagMsg = '')))">
        <input v-model="tagName" class="input input-sm w-32 font-mono" placeholder="v1.0.0" spellcheck="false" />
        <input v-model="tagMsg" class="input input-sm min-w-40 flex-1" placeholder="Message (annotated tag, optional)" />
        <button class="btn btn-sm" :disabled="!tagName.trim() || !status.head">Tag {{ status.last?.short ?? 'HEAD' }}</button>
      </form>
      <ul class="max-h-64 space-y-1 overflow-y-auto">
        <li v-for="t in tags" :key="t.name" class="flex items-center gap-2 text-xs">
          <code class="font-semibold">{{ t.name }}</code>
          <span class="min-w-0 flex-1 truncate opacity-60">{{ t.sha }} · {{ t.subject }}</span>
          <button v-if="status.remotes.length" class="btn btn-ghost btn-xs" :disabled="!!project.dbTask" @click="act(() => H.gitTag(id, 'push', t.name), `Tag ${t.name} pushed`)">Push</button>
          <button class="btn btn-ghost btn-xs text-error" @click="deleteTag = t">Delete</button>
        </li>
        <li v-if="!tags.length" class="text-xs opacity-50">No tags.</li>
      </ul>
    </div>

    <ConfirmDialog
      v-if="confirm"
      :title="confirm.kind === 'merge' ? `Merge ${confirm.b.name} into ${status.branch}?` : `Delete branch ${confirm.b.name}?`"
      :text="confirm.kind === 'merge' ? 'A merge commit is made unless it fast-forwards. Conflicts show a walkthrough on the Changes view.' : 'Only the local branch; refused if it is not merged anywhere.'"
      :confirm="confirm.kind === 'merge' ? 'Merge' : 'Delete'"
      :tone="confirm.kind === 'merge' ? 'primary' : 'error'"
      @cancel="confirm = null"
      @ok="doConfirm"
    />
    <ConfirmDialog
      v-if="forceDelete"
      :title="`${forceDelete.name} is not merged`"
      text="Its commits that are on no other branch are lost (git branch -D)."
      confirm="Delete anyway"
      tone="error"
      @cancel="forceDelete = null"
      @ok="act(() => H.gitBranch(id, 'force-delete', forceDelete!.name), `Branch ${forceDelete!.name} deleted`).then(() => (forceDelete = null))"
    />
    <ConfirmDialog
      v-if="dropStash"
      :title="`Drop ${dropStash.ref}?`"
      :text="`“${dropStash.message}” is thrown away.`"
      confirm="Drop"
      tone="error"
      @cancel="dropStash = null"
      @ok="act(() => H.gitStash(id, 'drop', dropStash!.ref), 'Stash dropped').then(() => (dropStash = null))"
    />
    <ConfirmDialog
      v-if="deleteTag"
      :title="`Delete tag ${deleteTag.name}?`"
      text="Only the local tag; a pushed tag stays on the remote."
      confirm="Delete"
      tone="error"
      @cancel="deleteTag = null"
      @ok="act(() => H.gitTag(id, 'delete', deleteTag!.name), `Tag ${deleteTag!.name} deleted`).then(() => (deleteTag = null))"
    />
  </div>
</template>
