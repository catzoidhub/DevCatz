/**
 * Screenshots for Report a Bug (Catzoid #67). Every image is drawn on a canvas and exported again, so only pixels
 * leave the Mac — no metadata (location, camera, the file's name) — scaled down to at most MAX_SIDE and kept under
 * MAX_BYTES (a JPEG at a lower quality when the PNG is too big). The same file in DevCatz, DBCatz and DialCatz.
 */
import type { ReportShot } from '@shared/types';

export const SHOTS_MAX = 3;
const MAX_SIDE = 2560;
const MAX_BYTES = 2 * 1024 * 1024;

export interface Shot extends ReportShot {
  /** For the preview in the dialog. */
  url: string;
  width: number;
  height: number;
  bytes: number;
}

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That file is not an image the app can read'));
    img.src = src;
  });
}

const blobOf = (canvas: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Blob>((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('The image could not be prepared'))), type, quality));

async function base64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** A picked file or a captured window (a data: or blob: URL) → a clean, size-capped screenshot. */
export async function prepare(src: string): Promise<Shot> {
  const img = await load(src);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const width = Math.max(1, Math.round(img.naturalWidth * scale));
  const height = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#fff'; // JPEG has no transparency
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(img, 0, 0, width, height);
  let blob = await blobOf(canvas, 'image/png');
  for (const q of [0.9, 0.8, 0.7, 0.6]) {
    if (blob.size <= MAX_BYTES) break;
    blob = await blobOf(canvas, 'image/jpeg', q);
  }
  if (blob.size > MAX_BYTES) throw new Error('That screenshot is too large even when compressed — try a smaller window');
  const type = blob.type === 'image/jpeg' ? 'image/jpeg' : 'image/png';
  const data = await base64(blob);
  // a data: URL for the preview: the window's Content-Security-Policy allows data: images, not blob:
  return { type, data, url: `data:${type};base64,${data}`, width, height, bytes: blob.size };
}

/** A picked file as a data: URL, ready for prepare(). */
export function fromFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(new Error('That file could not be read'));
    r.readAsDataURL(file);
  });
}

/** Nothing to let go of with data: URLs; kept so the dialogs stay the same if that changes. */
export const release = (_shots: Shot[]) => undefined;
