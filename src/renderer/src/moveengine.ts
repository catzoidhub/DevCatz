import type { GwWhere } from '@shared/types';
import { askConfirm, attempt, state } from './store';
import { gwPlaces, placeOf } from './engines';
import type { MenuItem } from './components/PopMenu.vue';

/**
 * "Move to DoCatz" / "Move to Kiri …" for an installed Docker gateway (user, 2026-11-09; every engine 2026-11-18): its
 * containers go to another engine, its data folder stays. DoCatz first (recommended), then each other engine found
 * (gwPlaces, filled by loadPlaces() when the page opens).
 */
export function moveItems(docker: boolean, current: GwWhere | undefined, name: string, move: (to: GwWhere) => Promise<void>): MenuItem[] {
  const d = state.value?.docatz;
  if (!docker || !d) return [];
  const here = placeOf(current);
  return gwPlaces.value
    .filter((p) => p.where !== here?.where)
    .map((p) => ({
      label: `Move to ${p.name}…`,
      action: async () => {
        const toDocatz = p.where === 'docatz';
        const ok = await askConfirm({
          title: `Move ${name} to ${p.name}?`,
          text: `${name} stops, its containers and image move to ${p.name}${toDocatz ? ' (DoCatz shows it under DevCatz Services)' : ''}, and it starts again if it was running. Its data folder stays as it is.${toDocatz && !d.installed && !d.engine ? ' DoCatz is not installed: install it first.' : ''}${!toDocatz && !p.running ? ` ${p.name} is not running: DevCatz starts it.` : ''}`,
          confirm: 'Move',
          tone: 'primary',
        });
        if (ok) await attempt(() => move(p.where));
      },
    }));
}

/** The install form's line on where a Docker gateway runs, after the Run in choice (DoCatz starts its own engine). */
export function engineNote(container: GwWhere | undefined): string {
  const p = placeOf(container);
  if (!p || p.where === 'docatz') return "Runs in DoCatz's container engine, which DevCatz starts when it is stopped.";
  return p.id === 'docker-engine'
    ? 'Runs on Docker Engine (DevCatz installs and starts it when needed; Linux asks for your password).'
    : `Runs on ${p.name}, which DevCatz starts when it is stopped.`;
}
