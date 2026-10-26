<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { S3Bucket, S3Entry, S3UploadProgress, StorageState } from '@shared/types';
import { attempt, herd, notify } from '../store';

/** Buckets (create/delete, public/private) and a file browser for one running service. */
const props = defineProps<{ service: StorageState }>();
const emit = defineEmits<{ bucket: [string | null] }>();

const buckets = ref<S3Bucket[]>([]);
const bucket = ref<string | null>(null);
const prefix = ref('');
const entries = ref<S3Entry[]>([]);
const loading = ref(false);
const busy = ref(false);
const newBucket = ref('');
const running = computed(() => props.service.status === 'running');
const current = computed(() => buckets.value.find((b) => b.name === bucket.value) ?? null);
const crumbs = computed(() => {
  const parts = prefix.value.split('/').filter(Boolean);
  return parts.map((p, i) => ({ name: p, prefix: parts.slice(0, i + 1).join('/') + '/' }));
});

async function loadBuckets() {
  if (!running.value) return;
  const list = await attempt(() => herd.s3Buckets(props.service.kind));
  if (!list) return;
  buckets.value = list;
  if (!list.some((b) => b.name === bucket.value)) bucket.value = list[0]?.name ?? null;
}
async function loadEntries() {
  if (!bucket.value || !running.value) return void (entries.value = []);
  loading.value = true;
  entries.value = (await attempt(() => herd.s3List(props.service.kind, bucket.value!, prefix.value))) ?? [];
  loading.value = false;
}
onMounted(loadBuckets);

// ---- Upload progress (pushed from main) and drag & drop
const up = ref<S3UploadProgress | null>(null);
const uploading = computed(() => !!up.value && !up.value.done);
let started = 0;
const off = herd.onUploadProgress((p) => {
  if (p.kind !== props.service.kind) return;
  if (!up.value || up.value.done) started = Date.now();
  up.value = p;
});
onBeforeUnmount(off);
const upPercent = computed(() => (up.value?.total ? Math.round((up.value.sent / up.value.total) * 100) : 0));
const upSpeed = computed(() => {
  const s = (Date.now() - started) / 1000;
  return up.value && s > 0.5 ? up.value.sent / s : 0;
});
watch(() => props.service.status, (s) => s === 'running' && loadBuckets());
watch(bucket, (b) => {
  prefix.value = '';
  emit('bucket', b);
  void loadEntries();
});
watch(prefix, loadEntries);

async function run<T>(fn: () => Promise<T>): Promise<T | undefined> {
  busy.value = true;
  const r = await attempt(fn);
  busy.value = false;
  return r;
}
async function createBucket() {
  const name = newBucket.value.trim().toLowerCase();
  if (!name) return;
  if ((await run(() => herd.s3CreateBucket(props.service.kind, name).then(() => true))) === true) {
    newBucket.value = '';
    await loadBuckets();
    bucket.value = name;
  }
}
async function deleteBucket() {
  if (!bucket.value) return;
  await run(() => herd.s3DeleteBucket(props.service.kind, bucket.value!));
  await loadBuckets();
}
async function togglePublic() {
  const b = current.value;
  if (!b) return;
  if ((await run(() => herd.s3SetPublic(props.service.kind, b.name, !b.public).then(() => true))) === true) {
    notify('success', `${b.name} is now ${b.public ? 'private' : 'public (anonymous read)'}`);
    // Applied live through a bucket policy (an old SeaweedFS restarts instead; the status watcher reloads then).
    await loadBuckets();
  }
}
/** Files/folders from drag & drop, else the picker in main. */
async function upload(paths?: string[]) {
  if (!bucket.value || uploading.value) return;
  up.value = null;
  const n = await attempt(() => herd.s3Upload(props.service.kind, bucket.value!, prefix.value, paths));
  if (n) {
    notify('success', `Uploaded ${n} file${n === 1 ? '' : 's'} to ${bucket.value}/${prefix.value}`);
    setTimeout(() => up.value?.done && !up.value.error && (up.value = null), 2500);
  }
  await loadEntries();
}
const cancelUpload = () => herd.s3CancelUpload(props.service.kind);

const dragging = ref(0);
const hasFiles = (e: DragEvent) => !!e.dataTransfer?.types.includes('Files');
function onDragEnter(e: DragEvent) {
  if (hasFiles(e)) dragging.value++;
}
function onDragOver(e: DragEvent) {
  if (!hasFiles(e)) return;
  e.preventDefault();
  e.dataTransfer!.dropEffect = uploading.value ? 'none' : 'copy';
}
function onDrop(e: DragEvent) {
  dragging.value = 0;
  if (!hasFiles(e)) return;
  e.preventDefault();
  const paths = [...(e.dataTransfer?.files ?? [])].map((f) => herd.pathForFile(f)).filter(Boolean);
  if (paths.length) void upload(paths);
}
async function mkdir() {
  const name = prompt('Folder name')?.trim().replace(/^\/+|\/+$/g, '');
  if (!name) return;
  await run(() => herd.s3MkDir(props.service.kind, bucket.value!, prefix.value + name + '/'));
  await loadEntries();
}
async function download(e: S3Entry) {
  const path = await run(() => herd.s3Download(props.service.kind, bucket.value!, e.key));
  if (path) notify('success', `Saved to ${path}`);
}
async function remove(e: S3Entry) {
  await run(() => herd.s3Delete(props.service.kind, bucket.value!, e.key));
  await loadEntries();
}
function publicUrl(e: S3Entry) {
  return `${props.service.urls!.api}/${bucket.value}/${e.key.split('/').map(encodeURIComponent).join('/')}`;
}
async function copyUrl(e: S3Entry) {
  await navigator.clipboard.writeText(publicUrl(e));
  notify('info', current.value?.public ? 'Public URL copied' : 'URL copied (the bucket is private: it needs a signed request)');
}
const name = (e: S3Entry) => e.key.slice(prefix.value.length).replace(/\/$/, '');
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const when = (s: string | null) => (s ? new Date(s).toLocaleString() : '');
</script>

<template>
  <div v-if="!running" class="rounded-box border border-dashed border-base-300 p-6 text-center text-sm opacity-70">Start {{ service.name }} to manage its buckets.</div>
  <div v-else class="grid gap-4 lg:grid-cols-[15rem_1fr]">
    <!-- Buckets -->
    <div class="space-y-2">
      <div class="flex items-center justify-between">
        <span class="label-caps">Buckets</span>
        <button class="btn btn-ghost btn-xs" title="Refresh" @click="loadBuckets">↻</button>
      </div>
      <ul class="menu w-full p-0">
        <li v-for="b in buckets" :key="b.name">
          <a :class="{ 'menu-active': b.name === bucket }" @click="bucket = b.name">
            <svg class="size-4 opacity-60" viewBox="0 0 20 20" fill="currentColor"><path d="M2 3a1 1 0 0 0-1 1v1a1 1 0 0 0 1 1h16a1 1 0 0 0 1-1V4a1 1 0 0 0-1-1H2Zm0 4.5h16l-.811 7.71a2 2 0 0 1-1.99 1.79H4.802a2 2 0 0 1-1.99-1.79L2 7.5Z" /></svg>
            <span class="flex-1 truncate">{{ b.name }}</span>
            <span v-if="b.public" class="badge badge-success badge-soft badge-xs">public</span>
          </a>
        </li>
        <li v-if="!buckets.length" class="px-3 py-2 text-xs opacity-60">No buckets yet.</li>
      </ul>
      <form class="join w-full" @submit.prevent="createBucket">
        <input v-model="newBucket" class="input input-xs join-item w-full font-mono" placeholder="new-bucket" spellcheck="false" />
        <button class="btn btn-xs btn-primary join-item" :disabled="busy || !newBucket.trim()">Create</button>
      </form>
    </div>

    <!-- Objects -->
    <div v-if="current" class="min-w-0 space-y-3">
      <div class="flex flex-wrap items-center gap-2">
        <div class="breadcrumbs min-w-0 flex-1 py-0 text-sm">
          <ul>
            <li><a class="font-medium" @click="prefix = ''">{{ current.name }}</a></li>
            <li v-for="c in crumbs" :key="c.prefix"><a @click="prefix = c.prefix">{{ c.name }}</a></li>
          </ul>
        </div>
        <button class="btn btn-xs btn-primary" :disabled="busy || uploading" title="Files or folders; you can also drop them on the list" @click="upload()">Upload…</button>
        <button class="btn btn-xs" :disabled="busy" @click="mkdir">New folder</button>
        <button class="btn btn-xs" :disabled="busy" :title="current.public ? 'Anonymous users can read objects; click to make it private' : 'Allow anonymous read (public URLs)'" @click="togglePublic">
          {{ current.public ? 'Make private' : 'Make public' }}
        </button>
        <button class="btn btn-xs btn-ghost text-error" :disabled="busy" @click="deleteBucket">Delete bucket</button>
      </div>
      <div v-if="up" class="space-y-1.5 rounded-box border border-base-300/60 bg-base-200/40 p-3" :class="{ 'border-error/40': up.error && !up.cancelled }">
        <div class="flex items-center gap-2 text-sm">
          <span v-if="uploading" class="loading loading-spinner loading-xs text-primary" />
          <span v-else-if="up.error" class="grid size-4 place-items-center rounded-full text-[10px] font-bold" :class="up.cancelled ? 'bg-base-content/20' : 'bg-error text-error-content'">{{ up.cancelled ? '–' : '!' }}</span>
          <span v-else class="grid size-4 place-items-center rounded-full bg-success text-[10px] font-bold text-success-content">✓</span>
          <span class="flex-1 font-medium">
            <template v-if="uploading">Uploading {{ up.index }} of {{ up.count }}</template>
            <template v-else-if="up.error">{{ up.error }}</template>
            <template v-else>Uploaded {{ up.count }} file{{ up.count === 1 ? '' : 's' }}</template>
          </span>
          <span class="font-mono text-xs opacity-60">{{ size(up.sent) }} / {{ size(up.total) }}<template v-if="uploading && upSpeed"> · {{ size(upSpeed) }}/s</template></span>
          <button v-if="uploading" class="btn btn-ghost btn-xs text-error" @click="cancelUpload">Cancel</button>
          <button v-else class="btn btn-ghost btn-xs" title="Dismiss" @click="up = null">✕</button>
        </div>
        <progress class="progress w-full" :class="up.cancelled ? '' : up.error ? 'progress-error' : up.done ? 'progress-success' : 'progress-primary'" :value="upPercent" max="100" />
        <div v-if="uploading" class="selectable truncate font-mono text-[11px] opacity-60" :title="up.key">{{ up.key }}</div>
      </div>

      <div
        class="relative overflow-x-auto rounded-box border border-base-300/60"
        @dragenter="onDragEnter"
        @dragover="onDragOver"
        @dragleave="dragging = Math.max(0, dragging - 1)"
        @drop="onDrop"
      >
        <div
          v-if="dragging"
          class="pointer-events-none absolute inset-0 z-10 grid place-items-center rounded-box border-2 border-dashed backdrop-blur-[2px]"
          :style="{ borderColor: 'var(--c-storage)', background: 'color-mix(in oklch, var(--c-storage) 12%, transparent)' }"
        >
          <div class="text-center text-sm">
            <div class="font-semibold" :style="{ color: 'var(--c-storage)' }">{{ uploading ? 'An upload is running' : 'Drop to upload' }}</div>
            <div class="font-mono text-xs opacity-70">{{ current.name }}/{{ prefix }}</div>
          </div>
        </div>
        <table class="table table-sm">
          <thead>
            <tr><th>Name</th><th class="text-right">Size</th><th>Modified</th><th class="text-right"></th></tr>
          </thead>
          <tbody>
            <tr v-if="prefix">
              <td colspan="4"><a class="link link-hover text-xs" @click="prefix = crumbs.length > 1 ? crumbs[crumbs.length - 2].prefix : ''">↑ Up</a></td>
            </tr>
            <tr v-for="e in entries" :key="e.key">
              <td class="max-w-0">
                <a v-if="e.folder" class="flex items-center gap-2 font-medium" @click="prefix = e.key">
                  <svg class="size-4 shrink-0 text-warning" viewBox="0 0 20 20" fill="currentColor"><path d="M3.75 3A1.75 1.75 0 0 0 2 4.75v10.5c0 .966.784 1.75 1.75 1.75h12.5A1.75 1.75 0 0 0 18 15.25v-8.5A1.75 1.75 0 0 0 16.25 5h-4.836a.25.25 0 0 1-.177-.073L9.823 3.513A1.75 1.75 0 0 0 8.586 3H3.75Z" /></svg>
                  <span class="truncate">{{ name(e) }}/</span>
                </a>
                <span v-else class="flex items-center gap-2">
                  <svg class="size-4 shrink-0 opacity-50" viewBox="0 0 20 20" fill="currentColor"><path d="M3 3.5A1.5 1.5 0 0 1 4.5 2h6.879a1.5 1.5 0 0 1 1.06.44l4.122 4.12A1.5 1.5 0 0 1 17 7.622V16.5a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 3 16.5v-13Z" /></svg>
                  <span class="selectable truncate">{{ name(e) }}</span>
                </span>
              </td>
              <td class="text-right font-mono text-xs whitespace-nowrap">{{ e.folder ? '' : size(e.size) }}</td>
              <td class="text-xs whitespace-nowrap opacity-70">{{ when(e.modified) }}</td>
              <td class="text-right whitespace-nowrap">
                <template v-if="!e.folder">
                  <button class="btn btn-ghost btn-xs" title="Copy URL" @click="copyUrl(e)">URL</button>
                  <button class="btn btn-ghost btn-xs" @click="download(e)">Download</button>
                </template>
                <button class="btn btn-ghost btn-xs text-error" @click="remove(e)">Delete</button>
              </td>
            </tr>
            <tr v-if="!entries.length && !loading">
              <td colspan="4" class="py-6 text-center text-xs opacity-60">Empty. Drop files or folders here, or create a folder.</td>
            </tr>
            <tr v-if="loading">
              <td colspan="4" class="py-6 text-center"><span class="loading loading-spinner loading-sm" /></td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>
