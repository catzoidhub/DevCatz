import type { MonitorEntity, SearchKind, StorageKind, WaEngine, WsKind, DbServiceState } from '@shared/types';
import rustfsLogo from './assets/logos/rustfs.png';
import minioLogo from './assets/logos/minio.png';
import seaweedfsLogo from './assets/logos/seaweedfs.png';
import meiliLogo from './assets/logos/meilisearch.png';
import typesenseLogo from './assets/logos/typesense.png';
import opensearchLogo from './assets/logos/opensearch.png';
import manticoreLogo from './assets/logos/manticore.png';
import zincLogo from './assets/logos/zincsearch.png';
import sonicLogo from './assets/logos/sonic.png';
import reverbLogo from './assets/logos/reverb.png';
import sockudoLogo from './assets/logos/sockudo.png';
import centrifugoLogo from './assets/logos/centrifugo.png';
import mercureLogo from './assets/logos/mercure.png';
import natsLogo from './assets/logos/nats.png';
import gowaLogo from './assets/logos/gowa.png';
import wahaLogo from './assets/logos/waha.png';
import devcatzLogo from './assets/logos/devcatz.svg';
import { DB_LOGO } from './db';
import { GW_LOGO } from './gateways';

/** Official marks of the services DevCatz runs (sources in assets/logos/SOURCES.md), shared by every page that shows them. */
export const STORAGE_LOGO: Record<StorageKind, string> = { rustfs: rustfsLogo, minio: minioLogo, seaweedfs: seaweedfsLogo };
export const SEARCH_LOGO: Record<SearchKind, string> = { meilisearch: meiliLogo, typesense: typesenseLogo, opensearch: opensearchLogo, manticore: manticoreLogo, zincsearch: zincLogo, sonic: sonicLogo };
export const WS_LOGO: Record<WsKind, string> = { reverb: reverbLogo, sockudo: sockudoLogo, centrifugo: centrifugoLogo, mercure: mercureLogo, nats: natsLogo };
export const WA_LOGO: Record<WaEngine, string> = { gowa: gowaLogo, waha: wahaLogo };
export const DEVCATZ_LOGO = devcatzLogo;

/** The logo of a Monitoring row, from the engine named in its id (`storage:rustfs`, `ws:reverb` …); null when there is none. */
export function monitorLogo(e: MonitorEntity, databases: DbServiceState[]): string | null {
  const [, key = ''] = /^[^:]+:(.*)$/.exec(e.id) ?? [];
  const pick = <K extends string>(map: Record<K, string>) => (key in map ? map[key as K] : null);
  switch (e.kind) {
    case 'database': {
      const d = databases.find((x) => x.id === (e.link?.id ?? key));
      return d ? DB_LOGO[d.engine] : null;
    }
    case 'storage':
      return pick(STORAGE_LOGO);
    case 'search':
      return pick(SEARCH_LOGO);
    case 'websocket':
      return pick(WS_LOGO);
    case 'whatsapp':
      return pick(WA_LOGO);
    case 'gateway':
      return pick(GW_LOGO);
    case 'devcatz':
      return DEVCATZ_LOGO;
    default:
      return null;
  }
}
