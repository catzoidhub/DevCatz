<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import type { MailSummary, ProjectState } from '@shared/types';
import StatusDot from './StatusDot.vue';
import MailEnvWriter from './MailEnvWriter.vue';
import { attempt, herd, navRequest, notify, state } from '../store';

/**
 * A site's Mail tab: whether its mailer points at DevCatz's catcher, the .env
 * lines to make it so, a test mail, and the last mails it sent.
 */
const props = defineProps<{ project: ProjectState }>();
const p = computed(() => props.project);
const mail = computed(() => state.value?.mail ?? null);
const info = computed(() => p.value.mailInfo);
const H = herd;

const recent = ref<MailSummary[]>([]);
async function load() {
  recent.value = (await herd.mailList('', p.value.id, 10).catch(() => [])) ?? [];
}
watch(() => [mail.value?.lastAt, mail.value?.count, p.value.id], load, { immediate: true });

async function sendTest() {
  if (await attempt(() => herd.mailSendTest(p.value.id).then(() => true))) notify('success', 'Test mail sent: it appears below in a moment');
}
function openMail(id?: string) {
  navRequest.value = { section: 'mail', id };
}
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
</script>

<template>
  <section class="site-tab">
    <div class="card">
      <div class="card-body">
        <div class="flex items-center gap-2">
          <StatusDot :status="mail?.running ? (info?.catcher ? 'running' : 'stopped') : 'crashed'" />
          <h2 class="flex-1">Mail catcher</h2>
          <span class="badge badge-soft badge-sm" :class="info?.catcher ? 'badge-success' : 'badge-ghost'">{{ info?.catcher ? 'this site sends here' : 'not pointed here' }}</span>
        </div>
        <p class="text-sm opacity-70">
          <template v-if="!mail?.running">The catcher is stopped: start it on the Mail page, or it starts with DevCatz (Settings → Mail).</template>
          <template v-else-if="info?.catcher">
            Mail from this site lands in DevCatz instead of a real inbox (SMTP <code>127.0.0.1:{{ mail.port }}</code>). Open the Mail page or
            <a class="link" @click="H.openUrl(mail.webUrl)">{{ mail.webUrl }}</a> to read it.
          </template>
          <template v-else-if="info?.keys.length">
            The .env points its mailer elsewhere (<code>{{ info.keys.join(', ') }}</code>). Write the lines below to catch its mail here instead.
          </template>
          <template v-else>No mail settings found in .env yet. Write the lines below so the site's mailer talks to the catcher.</template>
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <button class="btn btn-sm" :disabled="!mail?.running" @click="sendTest">Send a test mail as {{ p.name }}</button>
          <button class="btn btn-ghost btn-sm" @click="openMail()">Open Mail</button>
        </div>
      </div>
    </div>

    <div class="card">
      <div class="card-body">
        <h2>Write to .env</h2>
        <MailEnvWriter :key="p.id" :site-id="p.id" />
      </div>
    </div>

    <div class="card">
      <div class="card-body card-table">
        <div class="card-head">
          <h2>Recent mail from this site</h2>
          <span class="ml-auto text-xs opacity-60">{{ recent.length ? `last ${recent.length}` : 'none yet' }}</span>
        </div>
        <div class="overflow-x-auto">
          <table class="table table-sm">
            <tbody>
              <tr v-for="m in recent" :key="m.id" class="cursor-pointer hover:bg-base-200/50" @click="openMail(m.id)">
                <td>
                  <div class="flex items-center gap-2">
                    <span v-if="m.unread" class="size-1.5 rounded-full bg-[var(--c-mail)]" />
                    <span class="font-medium" :class="{ 'font-semibold': m.unread }">{{ m.subject || '(no subject)' }}</span>
                  </div>
                  <div class="text-xs opacity-60">to {{ m.to.map((t) => t.address).join(', ') }}</div>
                </td>
                <td class="text-right text-xs whitespace-nowrap opacity-60">{{ when(m.receivedAt) }}</td>
              </tr>
              <tr v-if="!recent.length">
                <td colspan="2" class="py-6 text-center text-xs opacity-60">Mail the site sends through the catcher shows up here.</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </section>
</template>
