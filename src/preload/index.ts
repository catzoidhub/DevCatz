import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { API_METHODS, type AppState, type HerdApi, type LogLine, type MonitorUpdate, type S3UploadProgress } from '@shared/types';

const api = Object.fromEntries(
  API_METHODS.map((m) => [m, (...args: unknown[]) => ipcRenderer.invoke(`herd:${m}`, ...args)]),
) as unknown as HerdApi;

function on<T>(channel: string, cb: (payload: T) => void): () => void {
  // One listener that throws (e.g. returns a value the context bridge cannot clone) must not stop the others.
  const listener = (_e: Electron.IpcRendererEvent, payload: T) => {
    try {
      cb(payload);
    } catch (e) {
      console.error(`${channel} listener failed:`, e);
    }
  };
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
}

const bridge = {
  ...api,
  onState: (cb: (s: AppState) => void) => on('herd:state', cb),
  onLogs: (cb: (l: LogLine[]) => void) => on('herd:logs', cb),
  /** `sites`, `settings`, `new-site` or `site:<id>` (from the menu bar). */
  onNavigate: (cb: (target: string) => void) => on('herd:navigate', cb),
  onUploadProgress: (cb: (p: S3UploadProgress) => void) => on('herd:upload', cb),
  /** Monitoring samples while the page is open (see monitorLive). */
  onMonitor: (cb: (u: MonitorUpdate) => void) => on('herd:monitor', cb),
  /** Filesystem path of a dropped File (File.path is gone since Electron 32). */
  pathForFile: (file: File) => webUtils.getPathForFile(file),
  /** `darwin` or `win32`: Windows stage 1 hides what is macOS-only so far (Catzoid #57). */
  platform: process.platform,
  /** `arm64` or `x64`: which build of a Catzoid app fits this computer. */
  arch: process.arch,
};

export type HerdBridge = typeof bridge;

contextBridge.exposeInMainWorld('herd', bridge);
