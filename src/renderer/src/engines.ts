import type { DockerEngineId } from '@shared/types';
import docatz from './assets/logos/docatz.png';
import orbstack from './assets/logos/engines/orbstack.png';
import docker from './assets/logos/engines/docker.svg';
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
};
