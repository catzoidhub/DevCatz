/**
 * GitHub's REST API for what DevCatz looks up: release lists and versions, all public data. Without a token GitHub
 * allows 60 calls an hour per address, shared with everything else behind it; with one, 5000. So the token of a connected
 * GitHub account goes along when there is one, to api.github.com only (never to a download). Answers are kept with their
 * ETag, because GitHub does not count an unchanged answer, and when the limit is reached the last answer serves.
 */
const API = 'https://api.github.com';
const KEEP = 30;

type TokenSource = () => Promise<string | null>;
let tokenSource: TokenSource = async () => null;
/** A token GitHub refused: not sent again until DevCatz restarts or the account changes. */
let refused: string | null = null;

export function setGithubToken(source: TokenSource): void {
  tokenSource = source;
}

const cache = new Map<string, { etag: string; body: string }>();

function remember(key: string, etag: string | null, body: string): void {
  if (!etag) return;
  cache.delete(key);
  cache.set(key, { etag, body });
  if (cache.size > KEEP) cache.delete(cache.keys().next().value as string);
}

/** Why GitHub said no, in words the user can act on. */
function failure(res: Response, hasToken: boolean): Error {
  const limited = res.status === 429 || (res.status === 403 && (res.headers.get('x-ratelimit-remaining') === '0' || res.headers.has('retry-after')));
  if (!limited) return new Error(`GitHub: HTTP ${res.status}`);
  const reset = Number(res.headers.get('x-ratelimit-reset'));
  const retry = Number(res.headers.get('retry-after'));
  const at = reset ? new Date(reset * 1000) : retry ? new Date(Date.now() + retry * 1000) : null;
  const when = at ? `try again at ${at.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}` : 'try again later';
  return new Error(`GitHub's limit is reached: ${when}${hasToken ? '' : ', or connect a GitHub account on the Git page for a higher limit'}`);
}

/** GET a path of GitHub's API (`/repos/owner/name/releases`), as JSON. */
export async function githubJson<T>(path: string): Promise<T> {
  if (!path.startsWith('/')) throw new Error(`Not a GitHub API path: ${path}`);
  let token = await tokenSource().catch(() => null);
  if (token === refused) token = null;
  for (;;) {
    const key = `${token ? 'token' : 'anon'} ${path}`;
    const kept = cache.get(key);
    const res = await fetch(API + path, {
      headers: {
        Accept: 'application/vnd.github+json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(kept ? { 'If-None-Match': kept.etag } : {}),
      },
    });
    if (res.status === 304 && kept) return JSON.parse(kept.body) as T;
    if (res.ok) {
      const body = await res.text();
      remember(key, res.headers.get('etag'), body);
      return JSON.parse(body) as T;
    }
    // An expired or revoked token must not break looking up a public release.
    if (res.status === 401 && token) {
      refused = token;
      token = null;
      continue;
    }
    const err = failure(res, !!token);
    if (kept && err.message.startsWith("GitHub's limit")) return JSON.parse(kept.body) as T;
    throw err;
  }
}
