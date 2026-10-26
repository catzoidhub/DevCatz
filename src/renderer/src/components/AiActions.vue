<script setup lang="ts">
import { ref } from 'vue';
import type { AiAction } from '@shared/types';
import ConfirmDialog from './ConfirmDialog.vue';
import DbCatzButton from './DbCatzButton.vue';
import dbcatzLogo from '../assets/logos/dbcatz.png';
import { herd, navRequest, notify, openSiteRequest, siteTabRequest, state, uninstallRequest } from '../store';
import { aiError, plain } from '../ai';

/**
 * Buttons for what the model proposed DevCatz should do. Nothing runs by itself: a click runs it, and the ones
 * that change files or data (.env, migrations, tasks, extensions, versions) ask first.
 */
const props = defineProps<{ actions: AiAction[]; siteId: string | null; /** Numbered steps with an icon, a line on what each does and its result (Ask DevCatz). */ steps?: boolean }>();
const emit = defineEmits<{ done: [action: AiAction] }>();
const busy = ref<number | null>(null);
/** Result per step (steps view). */
const results = ref<Record<number, { ok: boolean; text: string }>>({});

/** Icon per kind of action (steps view). */
const ICON: Record<string, string> = {
  play: 'M6.3 3.9A1 1 0 0 0 4.8 4.8v10.4a1 1 0 0 0 1.5.9l8.6-5.2a1 1 0 0 0 0-1.8L6.3 3.9Z',
  stop: 'M5.5 4.5h9a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1Z',
  restart: 'M15.3 7.5A6 6 0 1 0 16 11h-1.6a4.4 4.4 0 1 1-.9-3.5L11.5 9.5H17V4l-1.7 3.5Z',
  globe: 'M10 2.5a7.5 7.5 0 1 0 0 15 7.5 7.5 0 0 0 0-15Zm5.8 6.7h-2.6a11 11 0 0 0-1.4-4.9 6 6 0 0 1 4 4.9ZM10 4.1c.8 1 1.5 2.9 1.7 5.1H8.3c.2-2.2.9-4.1 1.7-5.1ZM8.2 4.3a11 11 0 0 0-1.4 4.9H4.2a6 6 0 0 1 4-4.9Zm-4 6.5h2.6c.1 1.9.6 3.6 1.4 4.9a6 6 0 0 1-4-4.9Zm5.8 5.1c-.8-1-1.5-2.9-1.7-5.1h3.4c-.2 2.2-.9 4.1-1.7 5.1Zm1.8-.2c.8-1.3 1.3-3 1.4-4.9h2.6a6 6 0 0 1-4 4.9Z',
  gear: 'M8.6 2.5h2.8l.4 2a5.7 5.7 0 0 1 1.4.8l1.9-.7 1.4 2.4-1.5 1.3a5.6 5.6 0 0 1 0 1.6l1.5 1.3-1.4 2.4-1.9-.7a5.7 5.7 0 0 1-1.4.8l-.4 2H8.6l-.4-2a5.7 5.7 0 0 1-1.4-.8l-1.9.7-1.4-2.4L5 10.8a5.6 5.6 0 0 1 0-1.6L3.5 7.9 4.9 5.5l1.9.7a5.7 5.7 0 0 1 1.4-.8l.4-2ZM10 7.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
  file: 'M5 2.5h6.5L15.5 6.5v10a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Zm6 1.5v3h3l-3-3ZM7 10h6v1.4H7V10Zm0 3h6v1.4H7V13Z',
  arrow: 'M4 10h9.2L9.6 6.4l1-1L16 10.8l-5.4 5.4-1-1 3.6-3.6H4V10Z',
  trash: 'M7.5 2.5h5l.6 1.5H16v1.5H4V4h2.9l.6-1.5ZM5.2 7h9.6l-.7 9.6a1 1 0 0 1-1 .9H6.9a1 1 0 0 1-1-.9L5.2 7Z',
  download: 'M9.2 3h1.6v7.7l2.7-2.7 1.1 1.1-4.6 4.6-4.6-4.6 1.1-1.1 2.7 2.7V3ZM4 15h12v1.6H4V15Z',
  db: 'M10 2.5c3.6 0 6 1.2 6 2.8v9.4c0 1.6-2.4 2.8-6 2.8s-6-1.2-6-2.8V5.3c0-1.6 2.4-2.8 6-2.8Zm0 1.5c-2.9 0-4.4.9-4.4 1.3S7.1 6.6 10 6.6s4.4-.9 4.4-1.3S12.9 4 10 4Zm4.4 3.2c-1 .6-2.6.9-4.4.9s-3.4-.3-4.4-.9V10c0 .4 1.5 1.3 4.4 1.3s4.4-.9 4.4-1.3V7.2Z',
  terminal: 'M3.5 4h13a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1Zm2 3.2-.9.9L7 10.5l-2.4 2.4.9.9 3.3-3.3-3.3-3.3ZM10 12.5v1.4h4.5v-1.4H10Z',
  tag: 'M3 3h6.6l7.6 7.6-6.6 6.6L3 9.6V3Zm3.2 2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z',
};
const iconOf = (k: AiAction['kind']) =>
  ({
    'site-start': 'play', 'service-start': 'play', 'site-stop': 'stop', 'service-stop': 'stop', 'site-restart': 'restart', 'service-restart': 'restart',
    'expose-start': 'globe', 'expose-stop': 'globe', 'site-setting': 'gear', 'env-set': 'file', 'open-tab': 'arrow', 'open-section': 'arrow',
    'service-uninstall': 'trash', 'install-deps': 'download', 'php-extension': 'download', 'db-task': 'db', 'stack-task': 'terminal',
    'set-node-version': 'tag', 'set-php-version': 'tag', 'set-python-version': 'tag', 'open-dbcatz': 'db',
  })[k] ?? 'arrow';
/** The step's target in a few words, under its label. */
function detail(a: AiAction): string {
  const site = a.site ? state.value?.projects.find((p) => p.id === a.site)?.name : '';
  const bits = [site, a.args.service, a.args.key && a.args.value !== undefined ? `${a.args.key} = ${a.args.value || '(none)'}` : a.args.key, a.args.version, a.args.extension, a.args.task, a.args.tab, a.args.section, a.args.file && a.kind !== 'env-set' ? a.args.file : ''];
  return bits.filter(Boolean).join(' · ');
}
/** open-dbcatz: the DBCatz connection of its database service (db:<id> → svc:<id>). */
const svcOf = (a: AiAction) => {
  const id = (a.args.service ?? '').replace(/^db:/, '');
  return id ? `svc:${id}` : null;
};
const danger = (a: AiAction) => a.kind === 'service-uninstall' || (a.kind === 'db-task' && /fresh/.test(a.args.task ?? ''));
const asking = ref<{ a: AiAction; i: number } | null>(null);

const ASK: AiAction['kind'][] = ['env-set', 'db-task', 'stack-task', 'php-extension', 'set-node-version', 'set-php-version', 'set-python-version', 'install-deps', 'site-stop', 'service-stop', 'expose-start', 'site-setting'];
function describe(a: AiAction): string {
  const args = Object.entries(a.args).map(([k, v]) => `${k}: ${v}`).join(', ');
  if (a.kind === 'env-set') return `Writes ${a.args.key}=${a.args.value} into ${a.args.file || '.env'} (the old value is replaced).`;
  if (a.kind === 'expose-start') return 'Puts this site on a public URL anyone with the link can open, until you stop sharing it.';
  if (a.kind === 'site-setting') return `Changes the site setting ${a.args.key} to ${a.args.value || '(none)'}.`;
  if (a.kind === 'db-task' && /fresh/.test(a.args.task ?? '')) return 'Drops every table and runs the migrations again: the data in this database is lost.';
  return args ? `${a.kind} (${args})` : a.kind;
}
function click(a: AiAction, i: number) {
  if (ASK.includes(a.kind)) asking.value = { a, i };
  else void run(a, i);
}
async function run(a: AiAction, i: number) {
  asking.value = null;
  busy.value = i;
  try {
    const r = await herd.aiRunAction(a.site ?? props.siteId, plain(a));
    if (r.startsWith('open:')) {
      const site = a.site ?? props.siteId;
      if (site) {
        openSiteRequest.value = site;
        siteTabRequest.value = { id: site, tab: r.slice(5) };
      }
    } else if (r.startsWith('uninstall:')) {
      // The page's own uninstall dialog takes over (typed confirmation, keep or delete the data).
      const [, scope, ...id] = r.split(':');
      const SECTION = { db: 'database', storage: 'storage', ws: 'websocket', search: 'search', gateway: 'whatsapp', whatsapp: 'whatsapp' } as const;
      const sc = scope as keyof typeof SECTION;
      navRequest.value = { section: SECTION[sc], id: id.join(':') };
      uninstallRequest.value = { scope: sc, id: id.join(':') };
    } else if (r.startsWith('section:')) {
      const [, sec, ...item] = r.split(':');
      // "gateways" is the WhatsApp page's id in the rail; Projects / Monitoring have no focus.
      navRequest.value = { section: (sec === 'gateways' ? 'whatsapp' : sec) as NonNullable<typeof navRequest.value>['section'], id: item.join(':') || undefined };
    } else if (!props.steps) notify('success', r);
    if (props.steps) results.value = { ...results.value, [i]: { ok: true, text: /^(open|section|uninstall):/.test(r) ? (r.startsWith('uninstall:') ? 'Confirm in the dialog' : 'Opened') : r } };
    emit('done', a);
  } catch (e) {
    if (props.steps) results.value = { ...results.value, [i]: { ok: false, text: aiError(e) } };
    else notify('error', aiError(e));
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <ol v-if="steps && actions.length" class="ai-steps">
    <li v-for="(a, i) in actions" :key="i" class="ai-step" :class="{ 'is-done': results[i]?.ok, 'is-failed': results[i] && !results[i].ok, 'is-danger': danger(a) }">
      <span class="ai-step-icon" aria-hidden="true">
        <span v-if="busy === i" class="loading loading-spinner loading-xs" />
        <svg v-else-if="results[i]?.ok" viewBox="0 0 20 20" fill="currentColor"><path d="M8.2 13.3 4.9 10l-1.1 1.1 4.4 4.4 8-8-1.1-1.1-6.9 6.9Z" /></svg>
        <img v-else-if="a.kind === 'open-dbcatz'" :src="dbcatzLogo" alt="" class="size-6 rounded-md" draggable="false" />
        <svg v-else viewBox="0 0 20 20" fill="currentColor"><path :d="ICON[iconOf(a.kind)]" /></svg>
      </span>
      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-2">
          <span v-if="actions.length > 1" class="ai-step-num">{{ i + 1 }}</span>
          <span class="truncate text-sm font-medium">{{ a.label }}</span>
        </div>
        <div v-if="results[i]" class="mt-0.5 text-xs" :class="results[i].ok ? 'text-success' : 'text-error'">{{ results[i].text }}</div>
        <div v-else-if="detail(a)" class="mt-0.5 truncate font-mono text-[11px] opacity-55">{{ detail(a) }}</div>
      </div>
      <DbCatzButton v-if="a.kind === 'open-dbcatz'" class="shrink-0" :conn-id="svcOf(a)" :database="a.args.database || undefined" label="Open in DBCatz" primary />
      <button v-else-if="!results[i]?.ok" class="btn btn-sm shrink-0" :class="danger(a) ? 'btn-error btn-outline' : results[i] ? 'btn-ghost' : 'btn-primary'" :disabled="busy !== null" @click="click(a, i)">
        {{ results[i] ? 'Retry' : danger(a) ? 'Review…' : 'Run' }}
      </button>
    </li>
  </ol>
  <div v-else-if="actions.length" class="flex flex-wrap gap-2">
    <template v-for="(a, i) in actions" :key="i">
    <DbCatzButton v-if="a.kind === 'open-dbcatz'" :conn-id="svcOf(a)" :database="a.args.database || undefined" :label="a.label || 'Open in DBCatz'" :primary="i === 0" />
    <button v-else class="btn btn-sm" :class="i === 0 ? 'btn-primary' : ''" :disabled="busy !== null" :title="describe(a)" @click="click(a, i)">
      <span v-if="busy === i" class="loading loading-spinner loading-xs" />{{ a.label }}
    </button>
    </template>
    <ConfirmDialog
      v-if="asking && !steps"
      :title="asking.a.label"
      :text="describe(asking.a)"
      :confirm="asking.a.kind === 'db-task' && /fresh/.test(asking.a.args.task ?? '') ? 'Drop & migrate' : 'Run'"
      :tone="asking.a.kind === 'db-task' && /fresh/.test(asking.a.args.task ?? '') ? 'error' : 'primary'"
      @ok="run(asking.a, asking.i)"
      @cancel="asking = null"
    />
  </div>
  <ConfirmDialog
    v-if="asking && steps"
    :title="asking.a.label"
    :text="describe(asking.a)"
    :confirm="asking.a.kind === 'db-task' && /fresh/.test(asking.a.args.task ?? '') ? 'Drop & migrate' : 'Run'"
    :tone="asking.a.kind === 'db-task' && /fresh/.test(asking.a.args.task ?? '') ? 'error' : 'primary'"
    @ok="run(asking.a, asking.i)"
    @cancel="asking = null"
  />
</template>
