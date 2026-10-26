import type { ExposeProvider, ExposeTool } from '@shared/types';
import cloudflareLogo from './assets/logos/cloudflare.png';
import ngrokLogo from './assets/logos/ngrok.png';
import exposeLogo from './assets/logos/expose.png';

/** Official marks of the tunnel tools and providers (sources in assets/logos/SOURCES.md). */
export const TOOL_LOGO: Record<ExposeTool, string> = { cloudflared: cloudflareLogo, ngrok: ngrokLogo, expose: exposeLogo };
export const PROVIDER_LOGO: Record<ExposeProvider, string> = { cloudflare: cloudflareLogo, 'cloudflare-domain': cloudflareLogo, ngrok: ngrokLogo, expose: exposeLogo };
export const PROVIDER_NAME: Record<ExposeProvider, string> = { cloudflare: 'Cloudflare quick tunnel', 'cloudflare-domain': 'Your Cloudflare domain', ngrok: 'ngrok', expose: 'Expose' };
