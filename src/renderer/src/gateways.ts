import type { GwCategory, GwKind } from '@shared/types';
import stalwartLogo from './assets/logos/stalwart.png';
import postalLogo from './assets/logos/postal.png';
import ntfyLogo from './assets/logos/ntfy.png';
import gotifyLogo from './assets/logos/gotify.png';
import jasminLogo from './assets/logos/jasmin.png';
import telegramLogo from './assets/logos/telegram.png';

/** Official marks of the email / push / SMS gateways (sources in assets/logos/SOURCES.md). */
export const GW_LOGO: Record<GwKind, string> = { stalwart: stalwartLogo, postal: postalLogo, ntfy: ntfyLogo, gotify: gotifyLogo, jasmin: jasminLogo, telegram: telegramLogo };
export const GW_CATEGORY_LABEL: Record<GwCategory, string> = { email: 'Email', push: 'Push notifications', sms: 'SMS', telegram: 'Telegram' };
export const GW_CATEGORIES: GwCategory[] = ['telegram', 'email', 'push', 'sms'];
