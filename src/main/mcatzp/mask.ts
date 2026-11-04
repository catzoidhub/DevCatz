import { maskText, SECRET_KEY } from '../ai/devcatz';

/**
 * The AI's masking knows `KEY=value`; what goes out here is also YAML and JSON (`DB_PASSWORD: x`, `"apiKey": "x"`), so any
 * value under a secret-looking name goes too. Masks too much rather than too little.
 */
export function maskDeep(text: string): string {
  // Not across lines: in YAML a parent key ends with a colon and the next line is its child. `\\?` also reads quotes escaped by JSON.
  return maskText(text).replace(/(\\?["']?)([A-Za-z_][\w.-]*)\1([ \t]*[:=][ \t]*)(\\?["']?)([^"'\\\s,}\]]+)/g, (m, q: string, key: string, sep: string, vq: string) => (SECRET_KEY.test(key) ? `${q}${key}${q}${sep}${vq}•••` : m));
}
