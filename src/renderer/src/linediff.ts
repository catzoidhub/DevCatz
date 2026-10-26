/** Line diff (LCS) for the preview; the files are small. */
export function diff(a: string, b: string): { t: ' ' | '+' | '-'; l: string }[] {
  const x = a.split('\n');
  const y = b.split('\n');
  const n = x.length;
  const m = y.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = x[i] === y[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: ' ' | '+' | '-'; l: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (x[i] === y[j]) (out.push({ t: ' ', l: x[i] }), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ t: '-', l: x[i++] });
    else out.push({ t: '+', l: y[j++] });
  }
  while (i < n) out.push({ t: '-', l: x[i++] });
  while (j < m) out.push({ t: '+', l: y[j++] });
  return out;
}
