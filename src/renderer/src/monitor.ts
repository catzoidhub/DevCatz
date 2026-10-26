/** Formatting for the Monitoring page. */
export function bytes(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = Math.max(0, n);
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : v < 10 ? digits : 0)} ${u[i]}`;
}
export const rate = (n: number) => (n < 1 ? '0 B/s' : `${bytes(n)}/s`);
export const pct = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)}%`;
