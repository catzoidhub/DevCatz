/** Minimal ANSI SGR → HTML (colors, bold, dim); everything else is stripped. */
const COLORS = ['#6b7280', '#ef4444', '#22c55e', '#eab308', '#3b82f6', '#a855f7', '#06b6d4', '#d1d5db'];
const BRIGHT = ['#9ca3af', '#f87171', '#4ade80', '#facc15', '#60a5fa', '#c084fc', '#22d3ee', '#f9fafb'];

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function ansiToHtml(input: string): string {
  let out = '';
  let open = false;
  let style: Record<string, string> = {};
  const parts = input.split(/\x1b\[([\d;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 0) {
      // Drop other escape sequences (cursor moves, OSC links).
      const text = parts[i].replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '').replace(/\x1b\[[\d;?]*[A-Za-z]/g, '');
      out += escape(text);
      continue;
    }
    const codes = parts[i] === '' ? [0] : parts[i].split(';').map(Number);
    for (let j = 0; j < codes.length; j++) {
      const c = codes[j];
      if (c === 0) style = {};
      else if (c === 1) style['font-weight'] = '600';
      else if (c === 2) style.opacity = '0.6';
      else if (c === 22) delete style['font-weight'], delete style.opacity;
      else if (c >= 30 && c <= 37) style.color = COLORS[c - 30];
      else if (c >= 90 && c <= 97) style.color = BRIGHT[c - 90];
      else if (c === 39) delete style.color;
      else if (c === 38 && codes[j + 1] === 5) {
        const n = codes[j + 2];
        if (n < 8) style.color = COLORS[n];
        else if (n < 16) style.color = BRIGHT[n - 8];
        j += 2;
      } else if (c === 38 && codes[j + 1] === 2) {
        style.color = `rgb(${codes[j + 2]},${codes[j + 3]},${codes[j + 4]})`;
        j += 4;
      }
    }
    if (open) out += '</span>';
    const css = Object.entries(style).map(([k, v]) => `${k}:${v}`).join(';');
    open = css.length > 0;
    if (open) out += `<span style="${css}">`;
  }
  if (open) out += '</span>';
  return out;
}
