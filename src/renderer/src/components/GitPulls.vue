<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { AiCommitAnswer, GitBranch, GitPull, GitRemote, GitStatus, ProjectState } from '@shared/types';
import { attempt, herd, navRequest, notify } from '../store';
import AiWriteButton from './AiWriteButton.vue';
import { aiOn } from '../ai';
import CatMood from './CatMood.vue';
/** ✦ Write with AI for the PR title and description. */
const aiPrOn = aiOn('commit');
/** Template alias (vue-tsc reads an imported binding inside template arrow functions as a ref). */
const H = herd;

/**
 * Pull / merge requests of the site's repository through the connected
 * account: open ones with checks and review state, open in the browser,
 * check one out; and a new one for the current branch.
 */
const props = defineProps<{ project: ProjectState; status: GitStatus; remote: GitRemote | null }>();
const emit = defineEmits<{ changed: []; logs: [] }>();
const id = computed(() => props.project.id);
const HOST: Record<string, string> = { github: 'GitHub', gitlab: 'GitLab', gitea: 'Gitea', bitbucket: 'Bitbucket' };
const word = computed(() => (props.remote?.kind === 'gitlab' ? 'merge request' : 'pull request'));

const pulls = ref<GitPull[]>([]);
const loading = ref(false);
const error = ref('');
async function load() {
  if (!props.remote?.accountId) return;
  loading.value = true;
  try {
    pulls.value = await herd.gitPulls(id.value);
    error.value = '';
  } catch (e) {
    error.value = (e as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
  loading.value = false;
}
void load();

// ---- new
const branches = ref<GitBranch[]>([]);
void herd.gitBranches(id.value).then((b) => (branches.value = b)).catch(() => undefined);
const bases = computed(() => [...new Set(branches.value.filter((b) => b.remote).map((b) => b.name.split('/').slice(1).join('/')))].filter((n) => n && n !== props.status.branch));
const form = ref({ title: '', body: '', base: '', draft: false });
watch(
  bases,
  (b) => {
    if (!form.value.base) form.value.base = ['main', 'master', 'develop'].find((n) => b.includes(n)) ?? b[0] ?? '';
  },
  { immediate: true },
);
watch(
  () => props.status.last?.subject,
  (s) => {
    if (!form.value.title && s) form.value.title = s;
  },
  { immediate: true },
);
const mine = computed(() => pulls.value.find((x) => x.head === props.status.branch) ?? null);
const creating = ref(false);
async function create() {
  creating.value = true;
  const pr = await attempt(() => herd.gitCreatePull(id.value, form.value.title, form.value.body, form.value.base, form.value.draft));
  creating.value = false;
  if (!pr) return;
  notify('success', `${word.value[0].toUpperCase()}${word.value.slice(1)} #${pr.number} opened`);
  form.value.body = '';
  herd.openUrl(pr.url);
  await load();
}
async function checkout(pr: GitPull) {
  const ok = await attempt(() => herd.gitCheckoutPull(id.value, pr).then(() => true), `Checked out #${pr.number}`);
  if (ok === undefined) emit('logs');
  emit('changed');
}
const CHECK: Record<string, string> = { success: 'text-success', failure: 'text-error', pending: 'text-warning' };
const when = (iso: string) => new Date(iso).toLocaleDateString();
</script>

<template>
  <div class="space-y-4">
    <div v-if="!remote" class="text-sm opacity-70">Add a remote first.</div>
    <div v-else-if="!remote.accountId" class="mx-auto max-w-lg space-y-3 pt-6 text-center">
      <div class="font-semibold">Connect {{ remote.kind ? HOST[remote.kind] : remote.host }} to see pull requests</div>
      <p class="text-sm opacity-70">The site pushes to <code>{{ remote.host }}/{{ remote.owner }}/{{ remote.repo }}</code>. Add an account with a personal access token on the Git page.</p>
      <button class="btn btn-primary btn-sm" @click="navRequest = { section: 'git' }">Open Git page</button>
    </div>
    <template v-else>
      <div class="flex items-center gap-2">
        <span class="flex-1 text-sm font-medium">Open {{ word }}s · {{ remote.owner }}/{{ remote.repo }}</span>
        <span v-if="loading" class="loading loading-spinner loading-xs" />
        <button class="btn btn-ghost btn-xs" @click="load">Refresh</button>
        <button v-if="remote.webUrl" class="btn btn-ghost btn-xs" @click="H.openUrl(`${remote.webUrl}/${remote.kind === 'gitlab' ? '-/merge_requests' : remote.kind === 'bitbucket' ? 'pull-requests' : 'pulls'}`)">On {{ HOST[remote.kind!] }}</button>
      </div>
      <div v-if="error" role="alert" class="alert alert-error alert-soft text-sm"><CatMood mood="error" class="size-7 shrink-0 -my-0.5" />{{ error }}</div>
      <div class="overflow-x-auto rounded-box border border-base-300/60">
        <table class="table table-sm">
          <tbody>
            <tr v-for="pr in pulls" :key="pr.number">
              <td class="w-12 font-mono text-xs opacity-60">#{{ pr.number }}</td>
              <td>
                <div class="flex items-center gap-2">
                  <span v-if="pr.checks" :class="CHECK[pr.checks]" :title="`Checks: ${pr.checks}`">●</span>
                  <a class="link link-hover font-medium" @click="H.openUrl(pr.url)">{{ pr.title }}</a>
                  <span v-if="pr.draft" class="badge badge-ghost badge-xs">draft</span>
                </div>
                <div class="text-[11px] opacity-60">
                  <span class="font-mono">{{ pr.head }} → {{ pr.base }}</span> · {{ pr.author }} · {{ when(pr.updatedAt) }}<template v-if="pr.review"> · {{ pr.review }}</template>
                </div>
              </td>
              <td class="text-right whitespace-nowrap">
                <button class="btn btn-ghost btn-xs" :disabled="!!project.dbTask || pr.head === status.branch" @click="checkout(pr)">{{ pr.head === status.branch ? 'Checked out' : 'Check out' }}</button>
              </td>
            </tr>
            <tr v-if="!pulls.length && !loading">
              <td colspan="3" class="py-5 text-center text-xs opacity-60">No open {{ word }}s.</td>
            </tr>
          </tbody>
        </table>
      </div>

      <form v-if="status.branch && !mine" class="card" @submit.prevent="create">
        <div class="card-body gap-2">
          <div class="font-semibold">New {{ word }} from <code>{{ status.branch }}</code></div>
          <div class="flex flex-wrap items-center gap-2">
            <input v-model="form.title" class="input input-sm min-w-64 flex-1" placeholder="Title" />
            <span class="text-xs opacity-60">into</span>
            <select v-model="form.base" class="select select-sm w-40">
              <option v-for="b in bases" :key="b" :value="b">{{ b }}</option>
            </select>
          </div>
          <textarea v-model="form.body" rows="4" class="textarea textarea-sm w-full" placeholder="What changes and why (Markdown)" />
          <div v-if="aiPrOn" class="flex items-center gap-2 text-xs opacity-80">
            <AiWriteButton
              :run="(t: string) => H.aiCommit({ siteId: id, kind: 'pr', base: form.base }, t)"
              :preview="() => H.aiPreviewCommit({ siteId: id, kind: 'pr', base: form.base })"
              :disabled="!form.base"
              title="Write the title and description with AI from the branch's commits and changes"
              @done="(a: AiCommitAnswer) => ((form.title = a.title), (form.body = a.body))"
            />
            <span>from the commits and changes since {{ form.base || 'the base branch' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <label class="flex items-center gap-1.5 text-xs"><input v-model="form.draft" type="checkbox" class="checkbox checkbox-xs" />Draft</label>
            <span class="flex-1 text-xs opacity-60">
              <template v-if="!status.upstream">Push {{ status.branch }} first.</template>
              <template v-else-if="status.ahead">{{ status.ahead }} commit(s) not pushed yet.</template>
            </span>
            <button class="btn btn-primary btn-sm" :disabled="creating || !form.title.trim() || !form.base || !status.upstream || !!status.ahead">
              <span v-if="creating" class="loading loading-spinner loading-xs" />Open {{ word }}
            </button>
          </div>
        </div>
      </form>
      <p v-else-if="mine" class="text-xs opacity-70">
        {{ status.branch }} already has #{{ mine.number }} open: <a class="link" @click="H.openUrl(mine.url)">{{ mine.title }}</a>. Push new commits to update it.
      </p>
    </template>
  </div>
</template>
