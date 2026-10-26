/**
 * The web inbox served on https://mail.<tld> (and reachable on a phone through
 * Expose): one static page talking to the catcher's JSON API.
 */
export const WEB_INBOX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Mail · DevCatz</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f6f9; --fg: #1b1b22; --muted: #6b6b7a; --card: #fff; --line: #e3e3ea; --accent: #6d5dfc; --unread: #4f46e5; }
  @media (prefers-color-scheme: dark) { :root { --bg: #17171c; --fg: #ececf1; --muted: #9a9aa8; --card: #1f1f26; --line: #2c2c36; } }
  * { box-sizing: border-box; }
  body { margin: 0; font: 14px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif; background: var(--bg); color: var(--fg); display: flex; flex-direction: column; height: 100vh; }
  header { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--line); background: var(--card); position: sticky; top: 0; }
  header h1 { font-size: 15px; margin: 0; }
  header input { flex: 1; min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--fg); font: inherit; }
  header .count { color: var(--muted); font-size: 12px; white-space: nowrap; }
  main { display: grid; grid-template-columns: minmax(260px, 360px) 1fr; flex: 1; min-height: 0; }
  #list { overflow: auto; border-right: 1px solid var(--line); }
  .row { padding: 10px 14px; border-bottom: 1px solid var(--line); cursor: pointer; }
  .row:hover, .row.active { background: color-mix(in srgb, var(--accent) 10%, var(--card)); }
  .row .s { display: flex; justify-content: space-between; gap: 8px; }
  .row .subj { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.unread .subj::before { content: ''; display: inline-block; width: 7px; height: 7px; border-radius: 50%; background: var(--unread); margin-right: 7px; vertical-align: 1px; }
  .row .meta { color: var(--muted); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row .time { color: var(--muted); font-size: 11px; white-space: nowrap; }
  .site { display: inline-block; font-size: 10px; padding: 0 6px; border-radius: 999px; background: color-mix(in srgb, var(--accent) 18%, transparent); color: var(--accent); margin-left: 6px; }
  #view { display: flex; flex-direction: column; min-height: 0; }
  #view .head { padding: 12px 16px; border-bottom: 1px solid var(--line); background: var(--card); }
  #view h2 { margin: 0 0 4px; font-size: 16px; }
  #view .kv { color: var(--muted); font-size: 12px; }
  #view .tabs { display: flex; gap: 4px; margin-top: 8px; }
  #view .tabs button { font: inherit; font-size: 12px; padding: 4px 10px; border: 1px solid var(--line); background: var(--bg); color: var(--fg); border-radius: 999px; cursor: pointer; }
  #view .tabs button.on { background: var(--accent); color: #fff; border-color: var(--accent); }
  #body { flex: 1; min-height: 0; background: #fff; }
  #body iframe { width: 100%; height: 100%; border: 0; background: #fff; }
  #body pre { margin: 0; padding: 16px; white-space: pre-wrap; word-break: break-word; font: 12px/1.6 ui-monospace, Menlo, monospace; color: #1b1b22; height: 100%; overflow: auto; }
  .empty { display: grid; place-items: center; height: 100%; color: var(--muted); }
  .att a { font-size: 12px; margin-right: 10px; color: var(--accent); }
  @media (max-width: 720px) {
    main { grid-template-columns: 1fr; }
    #view { position: fixed; inset: 0; background: var(--bg); transform: translateX(100%); transition: transform .2s; z-index: 2; }
    #view.open { transform: none; }
    #back { display: inline-block !important; }
  }
  #back { display: none; font: inherit; border: 0; background: none; color: var(--accent); padding: 0; margin-bottom: 6px; cursor: pointer; }
</style>
</head>
<body>
<header>
  <h1>Mail</h1>
  <input id="q" placeholder="Search subject, address, site" autocomplete="off">
  <span class="count" id="count"></span>
</header>
<main>
  <div id="list"></div>
  <div id="view"><div class="empty">Select a mail</div></div>
</main>
<script>
const $ = (s) => document.querySelector(s);
let list = [], current = null, tab = 'html', q = '';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const when = (iso) => { const d = new Date(iso); const day = 864e5; return Date.now() - d < day ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };
const addr = (a) => a ? (a.name ? a.name + ' <' + a.address + '>' : a.address) : '';
async function load() {
  const r = await fetch('/api/messages?q=' + encodeURIComponent(q) + '&limit=200');
  list = await r.json();
  $('#count').textContent = list.length + ' mail' + (list.length === 1 ? '' : 's');
  $('#list').innerHTML = list.map((m) => '<div class="row' + (m.unread ? ' unread' : '') + (current && current.id === m.id ? ' active' : '') + '" data-id="' + m.id + '">' +
    '<div class="s"><span class="subj">' + esc(m.subject || '(no subject)') + '</span><span class="time">' + when(m.receivedAt) + '</span></div>' +
    '<div class="meta">' + esc(addr(m.from)) + ' → ' + esc(m.to.map(addr).join(', ')) + (m.siteName ? '<span class="site">' + esc(m.siteName) + '</span>' : '') + '</div></div>').join('') || '<div class="empty" style="height:200px">No mail yet</div>';
}
async function open(id) {
  const r = await fetch('/api/messages/' + id);
  current = await r.json();
  tab = current.html ? 'html' : 'text';
  render();
  load();
}
function render() {
  const m = current; if (!m) return;
  const v = $('#view'); v.classList.add('open');
  v.innerHTML = '<div class="head"><button id="back">‹ Inbox</button><h2>' + esc(m.subject || '(no subject)') + '</h2>' +
    '<div class="kv">From ' + esc(addr(m.from)) + ' · To ' + esc(m.to.map(addr).join(', ')) + (m.cc.length ? ' · Cc ' + esc(m.cc.map(addr).join(', ')) : '') + ' · ' + new Date(m.receivedAt).toLocaleString() + (m.siteName ? '<span class="site">' + esc(m.siteName) + '</span>' : '') + '</div>' +
    (m.attachmentList.length ? '<div class="att">' + m.attachmentList.map((a) => '<a href="/api/messages/' + m.id + '/attachments/' + a.id + '" download="' + esc(a.filename) + '">⤓ ' + esc(a.filename) + '</a>').join('') + '</div>' : '') +
    '<div class="tabs">' + ['html', 'text', 'raw'].filter((t) => t !== 'html' || m.html).map((t) => '<button data-tab="' + t + '" class="' + (tab === t ? 'on' : '') + '">' + t.toUpperCase() + '</button>').join('') + '</div></div><div id="body"></div>';
  const body = $('#body');
  if (tab === 'html') { const f = document.createElement('iframe'); f.setAttribute('sandbox', ''); f.srcdoc = m.html; body.appendChild(f); }
  else if (tab === 'text') body.innerHTML = '<pre>' + esc(m.text || '(no text part)') + '</pre>';
  else fetch('/api/messages/' + m.id + '/raw').then((r) => r.text()).then((t) => (body.innerHTML = '<pre>' + esc(t) + '</pre>'));
  v.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => { tab = b.dataset.tab; render(); }));
  $('#back').onclick = () => v.classList.remove('open');
}
$('#list').addEventListener('click', (e) => { const row = e.target.closest('.row'); if (row) open(row.dataset.id); });
let t; $('#q').addEventListener('input', (e) => { q = e.target.value; clearTimeout(t); t = setTimeout(load, 200); });
load(); setInterval(load, 4000);
</script>
</body>
</html>`;
