import { askConfirm, attempt, state } from './store';
import type { MenuItem } from './components/PopMenu.vue';

/**
 * "Move to DoCatz" / "Move to OrbStack …" for an installed Docker gateway (user, 2026-11-09): its containers go to the
 * other engine, its data folder stays. DoCatz is offered wherever DoCatz exists; the other engine when one is installed.
 */
export function moveItems(docker: boolean, inDocatz: boolean, name: string, move: (to: 'docatz' | 'system') => Promise<void>): MenuItem[] {
  const d = state.value?.docatz;
  if (!docker || !d) return [];
  const to: 'docatz' | 'system' | null = inDocatz ? (d.otherEngine ? 'system' : null) : d.forGateways ? 'docatz' : null;
  if (!to) return [];
  const where = to === 'docatz' ? 'DoCatz' : d.otherEngine!;
  return [
    {
      label: `Move to ${where}…`,
      action: async () => {
        const ok = await askConfirm({
          title: `Move ${name} to ${where}?`,
          text: `${name} stops, its containers and image move to ${where}${to === 'docatz' ? ' (DoCatz shows it under DevCatz Services)' : ''}, and it starts again if it was running. Its data folder stays as it is.${to === 'docatz' && !d.installed && !d.engine ? ' DoCatz is not installed: install it first.' : ''}`,
          confirm: 'Move',
          tone: 'primary',
        });
        if (ok) await attempt(() => move(to));
      },
    },
  ];
}

/** The install form's line on where a Docker gateway runs, after the Run in choice (DoCatz starts its own engine). */
export function engineNote(container: 'docatz' | 'system' | undefined): string {
  const d = state.value?.docatz;
  const where = container ?? (d?.forGateways ? 'docatz' : 'system');
  if (where === 'docatz') return "Runs in DoCatz's container engine, which DevCatz starts when it is stopped.";
  return d?.otherEngine === 'Docker Engine'
    ? 'Runs on Docker Engine (DevCatz installs and starts it when needed; Linux asks for your password).'
    : `Runs on ${d?.otherEngine ?? 'your container engine'}, which must be running.`;
}
