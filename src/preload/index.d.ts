import type { HerdBridge } from './index';

declare global {
  interface Window {
    herd: HerdBridge;
  }
}
