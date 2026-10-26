/** "3 days ago", "2 months ago" for Free up space. */
export function ago(ms: number): string {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  const units: [number, string][] = [
    [365 * 86400, 'year'],
    [30 * 86400, 'month'],
    [7 * 86400, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [size, name] of units) {
    const n = Math.floor(s / size);
    if (n >= 1) return `${n} ${name}${n === 1 ? '' : 's'} ago`;
  }
  return 'just now';
}

/** Days since a moment (for the "not run for 30 / 90 days" filter). */
export const daysSince = (ms: number | null) => (ms ? (Date.now() - ms) / 86_400_000 : Infinity);
