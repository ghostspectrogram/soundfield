// Team SFX: the team's shared sound library (the SFX folder in the team Dropbox), reached only
// through the Lighthouse service with each person's own Soundfield key (lhsk_…). Soundfield never
// talks to Dropbox, and the key is only ever sent to the Lighthouse service.
//   GET  /api/teamsfx/index[?cursor=]   the whole index, or what changed since the cursor
//   GET  /api/teamsfx/file?id=           302 to a temporary download link (~4 h)
//   POST /api/teamsfx/upload?folder=&name=   raw file, up to 150 MB
//   POST /api/teamsfx/credits            { folder, text } → that folder's CREDITS.txt
// Limits per key: index 1 a minute, 2000 downloads and 300 uploads a day.
'use strict';
const { net } = require('electron');
const fs = require('fs');
const path = require('path');

const BASE = (process.env.SF_TEAMSFX_BASE || 'https://api.lighthouseworkstation.com').replace(/\/+$/, '');
const UA = 'Soundfield (sound effects explorer)';
const UPLOAD_MAX = 150 * 1024 * 1024;
const INDEX_GAP = 65 * 1000; // the service allows one index request a minute per key
const PAGE = 100;

const MESSAGES = {
  401: 'Team SFX didn’t accept your Soundfield key. Make a new one at app.lighthouseworkstation.com → Account → Soundfield key, then paste it in Settings → Accounts → Team SFX.',
  403: 'Your Soundfield key has been turned off by the Team SFX owner.',
  404: 'That sound is no longer in Team SFX.',
  413: 'Too big for Team SFX: 150 MB per file at most.',
  429: 'Team SFX: too many requests for now. Try again in a minute.',
  503: 'Team SFX can’t reach its Dropbox right now. Try again later.',
};

function fail(message, status = 0, code = '', retryAfter = 0) {
  const e = new Error(message);
  Object.assign(e, { status, code, retryAfter });
  return e;
}

async function call(key, rel, { method = 'GET', headers = {}, body, timeout = 30000, retried = false } = {}) {
  if (!key) throw fail('Add your Soundfield key first: Settings → Accounts → Team SFX.', 401, 'no_key');
  let r;
  try {
    r = await net.fetch(BASE + rel, { method, body, cache: 'no-store', signal: AbortSignal.timeout(timeout), headers: { Authorization: `Bearer ${key}`, 'User-Agent': UA, ...headers } });
  } catch (err) {
    throw fail(err && err.name === 'TimeoutError' ? 'Team SFX didn’t answer in time. Try again later.' : 'Couldn’t reach Team SFX. Check your internet connection.', 0, 'network');
  }
  if (r.ok) return r.json();
  let j = {};
  try { j = await r.json(); } catch {}
  const wait = Number(r.headers.get('retry-after')) || 0;
  // Too many requests: wait as long as asked (if it's short), then try once more.
  if (r.status === 429 && !retried && wait > 0 && wait <= 90) {
    await new Promise(res => setTimeout(res, wait * 1000));
    return call(key, rel, { method, headers, body, timeout, retried: true });
  }
  throw fail(MESSAGES[r.status] || j.error || `Team SFX error (HTTP ${r.status})`, r.status, j.code || '', wait);
}

const fileUrl = id => `${BASE}/api/teamsfx/file?id=${encodeURIComponent(id)}`;
const authHeaders = key => ({ Authorization: `Bearer ${key}` });
// Only links to the service carry the key (the temporary download link it redirects to doesn't).
const isServiceUrl = u => typeof u === 'string' && u.startsWith(BASE + '/');

// ------------------------------------------------------------------ index
// Kept locally as { cursor, files: { id: file }, syncedAt, lastRequest }.
function emptyIndex() { return { cursor: '', files: {}, syncedAt: 0, lastRequest: 0 }; }

// Fetches what changed (or everything) unless the last request was under a minute ago.
async function sync(key, state, { force = false } = {}) {
  state = state && state.files ? state : emptyIndex();
  if (!force && Date.now() - (state.lastRequest || 0) < INDEX_GAP) return { state, changed: false };
  state.lastRequest = Date.now();
  const res = await call(key, '/api/teamsfx/index' + (state.cursor ? `?cursor=${encodeURIComponent(state.cursor)}` : ''), { timeout: 120000 });
  if (res.reset || !state.cursor) state.files = {};
  let changed = !!res.reset;
  for (const f of res.files || []) if (f && f.id) { state.files[f.id] = f; changed = true; }
  for (const id of res.deleted || []) if (state.files[id]) { delete state.files[id]; changed = true; }
  state.cursor = res.cursor || state.cursor;
  state.syncedAt = Date.now();
  return { state, changed };
}

// ------------------------------------------------------------------ search
const extOf = name => (path.extname(name || '').slice(1).toLowerCase() || 'wav');
const titleOf = name => String(name || '').replace(/\.[a-z0-9]{2,5}$/i, '');
// Free-text licences from CREDITS.txt: CC0 / public domain / a subscription need no credit line.
const needsCredit = f => !!f.credits && !/\b(cc0|public domain|epidemic)\b/i.test(f.licence || '');

function toResult(f) {
  const ext = extOf(f.name);
  return {
    key: `teamsfx:${f.id}:${f.rev || ''}`, source: 'teamsfx', sourceLabel: 'Team SFX', id: f.id, rev: f.rev || '',
    title: titleOf(f.name), creator: f.credits || 'Team SFX', pageUrl: '', license: 'team',
    licenseText: f.licence || '', credits: f.credits || '', credit: needsCredit(f),
    desc: f.folder || '', tags: Array.isArray(f.tags) ? f.tags : [], pack: f.folder || '', category: f.category || null,
    duration: f.duration || 0, ch: f.channels || 0, sr: f.sampleRate || 0, bits: 0, size: f.size || 0, ext,
    loudnessLufs: f.loudnessLufs == null ? null : f.loudnessLufs,
    // Previews are the original file (cached by id + rev), so saving reuses the preview.
    previewUrl: fileUrl(f.id), previewExt: ext, previewIsOriginal: true, previewSize: f.size || 0,
    downloadUrl: fileUrl(f.id), original: true,
  };
}

// Every word must appear in the name, folder, tags or category; name matches rank first.
function search(state, query, page = 1, typeSet = null) {
  const words = String(query || '').toLowerCase().match(/[^\s"]+/g) || [];
  const hits = [];
  for (const f of Object.values((state && state.files) || {})) {
    if (typeSet && !typeSet.has(extOf(f.name).replace(/^aif$/, 'aiff'))) continue;
    const name = String(f.name || '').toLowerCase();
    const hay = `${name} ${String(f.folder || '').toLowerCase()} ${(f.tags || []).join(' ').toLowerCase()} ${f.category || ''}`;
    let score = 0, ok = true;
    for (const w of words) {
      if (!hay.includes(w)) { ok = false; break; }
      if (name.includes(w)) score += 2; else score += 1;
    }
    if (ok) hits.push([score, f]);
  }
  hits.sort((a, b) => b[0] - a[0] || String(a[1].path).localeCompare(String(b[1].path), undefined, { numeric: true }));
  const from = (page - 1) * PAGE;
  return { results: hits.slice(from, from + PAGE).map(h => toResult(h[1])), more: hits.length > from + PAGE, total: hits.length };
}

// ------------------------------------------------------------------ adding sounds
// folder is relative to SFX ("Drop here/Rain pack"); the service refuses ".." and absolute paths.
const cleanFolder = folder => String(folder || '').replace(/\\/g, '/').split('/').map(s => s.trim()).filter(s => s && s !== '.' && s !== '..').join('/');

async function upload(key, folder, file) {
  const st = fs.statSync(file);
  if (st.size > UPLOAD_MAX) throw fail(MESSAGES[413], 413, 'too_big');
  const q = `folder=${encodeURIComponent(cleanFolder(folder))}&name=${encodeURIComponent(path.basename(file))}`;
  return call(key, `/api/teamsfx/upload?${q}`, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: fs.readFileSync(file), timeout: 15 * 60 * 1000 });
}

const setCredits = (key, folder, text) => call(key, '/api/teamsfx/credits', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder: cleanFolder(folder), text: String(text || '') }),
});

module.exports = { BASE, UPLOAD_MAX, emptyIndex, sync, search, toResult, upload, setCredits, fileUrl, authHeaders, isServiceUrl, cleanFolder };
