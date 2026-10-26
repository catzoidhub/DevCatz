/**
 * Small tokenizers for DevCatz's code editor (Docker tab): Dockerfile, YAML (compose files) and ignore files.
 * Each returns HTML with one <span> per token (classes `hl-*`, colours in main.css, the same palette as
 * DBCatz's editors); plain text is escaped.
 */

export type CodeLanguage = 'dockerfile' | 'yaml' | 'ignore' | 'env' | 'text';

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const span = (cls: string, s: string) => (cls ? `<span class="hl-${cls}">${esc(s)}</span>` : esc(s));

/** The language of a file by its name. */
export function languageOf(file: string): CodeLanguage {
  const name = file.split('/').pop() ?? file;
  if (/^Dockerfile|\.Dockerfile$/i.test(name)) return 'dockerfile';
  if (/\.ya?ml$/i.test(name)) return 'yaml';
  if (/ignore$/i.test(name)) return 'ignore';
  if (/^\.env/i.test(name)) return 'env';
  return 'text';
}

const DOCKER_INSTR = /^(\s*)(FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\b/i;

/** Dockerfile: comments, instructions, `AS stage`, flags (--from=…), strings, $VARS, numbers. */
function dockerfileLine(line: string, continued: boolean): string {
  if (/^\s*#/.test(line) && !continued) return span('cmt', line);
  let out = '';
  let rest = line;
  const m = !continued ? line.match(DOCKER_INSTR) : null;
  if (m) {
    out += esc(m[1]) + span('kw', m[2]);
    rest = line.slice(m[0].length);
  }
  const re = /("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\$\{[^}]*\}?|\$[A-Za-z_][A-Za-z0-9_]*)|(--[a-z-]+(?:=\S*)?)|(\bAS\b)|(\b\d+(?:\.\d+)*\b)|(&&|\|\||\\$)/g;
  let last = 0;
  let t: RegExpExecArray | null;
  while ((t = re.exec(rest))) {
    out += esc(rest.slice(last, t.index));
    last = re.lastIndex;
    const [tok, str, v, flag, as, num, op] = t;
    if (str) out += span('str', tok);
    else if (v) out += span('const', tok);
    else if (flag) out += span('op', tok);
    else if (as) out += span('kw', tok);
    else if (num) out += span('num', tok);
    else if (op) out += span('punct', tok);
    else out += esc(tok);
  }
  return out + esc(rest.slice(last));
}

/** YAML: comments, keys, list dashes, strings, numbers / booleans / null, ${VARS}, anchors. */
function yamlLine(line: string): string {
  if (/^\s*#/.test(line)) return span('cmt', line);
  let out = '';
  let rest = line;
  const key = line.match(/^(\s*)(-\s+)?((?:"[^"]*"|'[^']*'|[^\s:#][^:#]*?))(\s*:)(?=\s|$)/);
  if (key) {
    out += esc(key[1]) + (key[2] ? span('punct', key[2]) : '') + span('key', key[3]) + span('punct', key[4]);
    rest = line.slice(key[0].length);
  } else {
    const dash = line.match(/^(\s*)(-\s+)/);
    if (dash) {
      out += esc(dash[1]) + span('punct', dash[2]);
      rest = line.slice(dash[0].length);
    }
  }
  const re = /(\s#.*$)|("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\$\{[^}]*\}?|\$[A-Za-z_][A-Za-z0-9_]*)|([&*][A-Za-z0-9_-]+)|(\b(?:true|false|yes|no|null|on|off)\b|~)|(\b\d+(?:\.\d+)*(?::\d+)*\b)/gi;
  let last = 0;
  let t: RegExpExecArray | null;
  while ((t = re.exec(rest))) {
    out += esc(rest.slice(last, t.index));
    last = re.lastIndex;
    const [tok, cmt, str, v, anchor, lit, num] = t;
    if (cmt) out += span('cmt', tok);
    else if (str) out += span('str', tok);
    else if (v) out += span('const', tok);
    else if (anchor) out += span('op', tok);
    else if (lit) out += span('kw', tok);
    else if (num) out += span('num', tok);
    else out += esc(tok);
  }
  return out + esc(rest.slice(last));
}

/** .env: comments, `export`, the key, `=`, quoted strings, ${VARS}, numbers / booleans, masked values, trailing comments. */
function envLine(line: string): string {
  if (/^\s*#/.test(line)) return span('cmt', line);
  const m = line.match(/^(\s*)(export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)(\s*=\s*)(.*)$/);
  if (!m) return esc(line);
  let out = esc(m[1]) + (m[2] ? span('kw', m[2]) : '') + span('key', m[3]) + span('punct', m[4]);
  const value = m[5];
  const re = /(\s+#.*$)|("(?:[^"\\]|\\.)*"?|'[^']*'?)|(\$\{[^}]*\}?|\$[A-Za-z_][A-Za-z0-9_]*)|(•+)|(\b(?:true|false|null)\b)|(^-?\d+(?:\.\d+)?$)/gi;
  let last = 0;
  let t: RegExpExecArray | null;
  while ((t = re.exec(value))) {
    out += esc(value.slice(last, t.index));
    last = re.lastIndex;
    const [tok, cmt, str, v, dots, lit, num] = t;
    if (cmt) out += span('cmt', tok);
    else if (str) out += span('str', tok);
    else if (v) out += span('const', tok);
    else if (dots) out += span('punct', tok);
    else if (lit) out += span('kw', tok);
    else if (num) out += span('num', tok);
    else out += esc(tok);
  }
  return out + esc(value.slice(last));
}

export function highlightCode(language: CodeLanguage, src: string): string {
  if (language === 'env') return src.split('\n').map(envLine).join('\n');
  const lines = src.split('\n');
  if (language === 'dockerfile') {
    let continued = false;
    return lines
      .map((l) => {
        const html = dockerfileLine(l, continued);
        continued = /\\\s*$/.test(l);
        return html;
      })
      .join('\n');
  }
  if (language === 'yaml') return lines.map(yamlLine).join('\n');
  if (language === 'ignore') return lines.map((l) => (/^\s*#/.test(l) ? span('cmt', l) : l.startsWith('!') ? span('op', '!') + esc(l.slice(1)) : esc(l))).join('\n');
  return esc(src);
}
