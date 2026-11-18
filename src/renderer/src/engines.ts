import { ref } from 'vue';
import type { DockerEngineId, DockerStatus, GwWhere } from '@shared/types';
import { herd, state } from './store';
import docatz from './assets/logos/docatz.png';
import orbstack from './assets/logos/engines/orbstack.png';
import docker from './assets/logos/engines/docker.svg';
import kiri from './assets/logos/engines/kiri.png';
import podman from './assets/logos/engines/podman.svg';
import rancher from './assets/logos/engines/rancher.svg';

/**
 * Each container engine's own icon (user, 2026-11-09: "pakai saja iconnya"), wherever an engine is offered or named:
 * the Run in choice of a Docker gateway, Site → Docker's engine buttons and links. Colima and Finch have none here
 * (a plain container mark stands in).
 */
export const ENGINE_LOGO: Partial<Record<DockerEngineId, string>> = {
  docatz,
  orbstack,
  'docker-desktop': docker,
  'docker-engine': docker,
  podman,
  rancher,
  kiri,
};

/** Its name in the state (otherEngine) → its id. */
export const ENGINE_BY_NAME: Record<string, DockerEngineId> = {
  DoCatz: 'docatz',
  OrbStack: 'orbstack',
  'Docker Desktop': 'docker-desktop',
  'Docker Engine': 'docker-engine',
  Podman: 'podman',
  'Rancher Desktop': 'rancher',
  Colima: 'colima',
  Finch: 'finch',
  Kiri: 'kiri',
};
export const ENGINE_NAME = Object.fromEntries(Object.entries(ENGINE_BY_NAME).map(([n, id]) => [id, n])) as Partial<Record<DockerEngineId, string>>;

/** One place a Docker gateway or storage container can run, for Run in and Move to. */
export interface GwPlace {
  where: GwWhere;
  id: DockerEngineId;
  name: string;
  /** The engine answers now (a stopped one is started at install / move). */
  running: boolean;
  /** Its docker context, to tell two of the same engine apart. */
  context: string;
  logo: string | null;
}

/**
 * Every engine a Docker gateway can go to (user, 2026-11-18: "kalau menginstall banyak docker app"): DoCatz first,
 * always — recommended, and offered even when it is not installed (DevCatz installs it) — then each docker context
 * DevCatz found. Filled by loadPlaces() when a form or menu that needs it opens.
 */
export const gwPlaces = ref<GwPlace[]>([]);
/** The engine the Docker tab uses now (where 'system' points). */
export const systemContext = ref<string | null>(null);

export async function loadPlaces(): Promise<void> {
  const st: DockerStatus | null = await herd.dockerStatus().catch(() => null);
  const d = state.value?.docatz;
  const out: GwPlace[] = [];
  if (d?.forGateways) out.push({ where: 'docatz', id: 'docatz', name: 'DoCatz', running: st?.docatz === 'running', context: 'docatz', logo: docatz });
  for (const e of st?.engines ?? []) {
    if (e.id === 'docatz' || !e.context || e.context.startsWith('@')) continue;
    out.push({ where: `ctx:${e.context}`, id: e.id, name: e.label ?? ENGINE_NAME[e.id] ?? e.context, running: e.running, context: e.context, logo: ENGINE_LOGO[e.id] ?? null });
  }
  // Podman / Finch by their own CLI, unless a docker context of theirs is already listed (Podman Desktop can add one).
  for (const c of st?.clis ?? []) {
    if (out.some((p) => p.id === c.id)) continue;
    out.push({ where: `cli:${c.id}`, id: c.id, name: ENGINE_NAME[c.id] ?? c.id, running: c.running, context: '', logo: ENGINE_LOGO[c.id] ?? null });
  }
  // The same engine twice (two Colima profiles …): its context tells them apart.
  for (const p of out) if (out.filter((x) => x.name === p.name).length > 1) p.name = `${p.name} (${p.context})`;
  gwPlaces.value = out;
  systemContext.value = st?.system?.context ?? (st?.engine !== 'docatz' ? st?.context : null) ?? null;
}

/** The place a stored choice stands for: 'system' (older installs) is the Docker tab's engine. */
export function placeOf(where: GwWhere | undefined): GwPlace | null {
  // The default (user, 2026-11-18): DoCatz when it is installed, else the engine the user already has, else DoCatz.
  const d = state.value?.docatz;
  const docatzHere = !!d && (d.installed || !!d.engine);
  const w = where ?? (d?.forGateways && (docatzHere || !gwPlaces.value.some((p) => p.where !== 'docatz')) ? 'docatz' : 'system');
  if (w === 'system') return gwPlaces.value.find((p) => p.context === systemContext.value) ?? gwPlaces.value.find((p) => p.where !== 'docatz') ?? null;
  return gwPlaces.value.find((p) => p.where === w) ?? null;
}
