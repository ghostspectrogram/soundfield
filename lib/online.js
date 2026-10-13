// Online sound search: only sources with an official search API, and only
// attribution-free sounds (CC0 / public domain) that can be used in anything.
//   Freesound          official API (free key), or via Openverse when there's no key
//   Wikimedia Commons  official API, no key
//   Internet Archive   advancedsearch + metadata APIs, no key (sound-effect / field-recording items)
//   Epidemic Sound     MCP server with your own account key (search, previews, WAV saves);
//                      Partner API with a developer key for search only, when there's no account key
// Sites without a public search API (Zapsplat, Pixabay, …) are offered as links
// that open in the browser instead of being scraped.
'use strict';
const { net } = require('electron');
const fs = require('fs');
const path = require('path');
const https = require('https');
const { Readable } = require('stream');
const { pipeline } = require('stream/promises');

const UA = 'Soundfield/0.1 (sound effects explorer; https://github.com/ghostspectrogram/soundfield)';
const FS_API = 'https://freesound.org/apiv2';

// ------------------------------------------------------------------ licences
// Codes: cc0 · pd (public domain) · by · by-sa. Anything else (non-commercial,
// no-derivatives, sampling+, unknown) is never returned.
const LICENSES = {
  cc0: { label: 'CC0', name: 'Creative Commons 0 (public domain)', credit: false },
  pd: { label: 'Public domain', name: 'Public domain', credit: false },
  by: { label: 'CC BY', name: 'Creative Commons Attribution', credit: true },
  'by-sa': { label: 'CC BY-SA', name: 'Creative Commons Attribution-ShareAlike', credit: true },
  // Not Creative Commons: covered by the user's own Epidemic Sound subscription (no credit needed).
  epidemic: { label: 'Epidemic', name: 'Epidemic Sound licence (your subscription)', credit: false },
};

function licenseFromUrl(u = '') {
  u = u.toLowerCase();
  if (u.includes('publicdomain/zero')) return 'cc0';
  if (u.includes('publicdomain/mark')) return 'pd';
  const m = u.match(/licenses\/([a-z+-]+)\//);
  return m ? m[1] : 'other';
}

function licenseFromCommons(code = '', short = '') {
  const c = code.toLowerCase(), s = short.toLowerCase();
  if (c === 'cc0' || s === 'cc0') return 'cc0';
  if (c === 'pd' || c.startsWith('pd-') || s.startsWith('public domain')) return 'pd';
  if (/^cc-by-sa-/.test(c)) return 'by-sa';
  if (/^cc-by-\d/.test(c)) return 'by';
  return 'other';
}

// Only attribution-free licences are ever returned, whatever the caller asks for.
const ATTRIBUTION_FREE = ['cc0', 'pd'];
const allowed = set => new Set((set || ATTRIBUTION_FREE).filter(l => ATTRIBUTION_FREE.includes(l)));

// File types: wav · aiff · flac · mp3 · ogg ('aif' and 'oga'/'opus' are folded in).
const fileType = ext => ({ aif: 'aiff', aifc: 'aiff', oga: 'ogg', opus: 'ogg' }[ext] || ext);
const FS_TYPES = { wav: ['wav'], aiff: ['aif', 'aiff'], flac: ['flac'], mp3: ['mp3'], ogg: ['ogg'] };

// ------------------------------------------------------------------ helpers
// A site that stops answering mustn't leave its part of the search spinning forever.
const SEARCH_TIMEOUT = 20000;
async function getJson(url, headers = {}, timeout = SEARCH_TIMEOUT) {
  let r;
  try {
    r = await net.fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json', ...headers }, signal: AbortSignal.timeout(timeout) });
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`${new URL(url).hostname} took too long to answer. Try again in a moment.`);
    throw e;
  }
  if (!r.ok) {
    let detail = '';
    try { const j = await r.json(); detail = j.detail || j.error || ''; } catch {}
    const err = new Error(detail || `HTTP ${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json();
}

const stripHtml = s => String(s || '').replace(/<[^>]*>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/\s+/g, ' ').trim();
const cleanTitle = s => String(s || '').replace(/\.(wav|aiff?|flac|mp3|ogg|oga|opus|m4a)\s*$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim();

function attributionText(r) {
  const lic = LICENSES[r.license];
  return `“${r.title}” by ${r.creator || 'unknown'} (${r.pageUrl}), ${lic ? lic.name : r.license}${r.licenseUrl ? ' ' + r.licenseUrl : ''}`;
}

// ------------------------------------------------------------------ Freesound (own API)
async function searchFreesound(q, page, lic, auth, types) {
  if (!lic.has('cc0')) return { results: [], more: false };
  let filter = 'license:"Creative Commons 0"';
  if (types) filter += ` type:(${[...types].flatMap(t => FS_TYPES[t] || []).join(' OR ')})`;
  const params = new URLSearchParams({
    query: q,
    filter,
    fields: 'id,name,description,tags,license,username,duration,channels,samplerate,bitdepth,filesize,type,previews,url,pack_name',
    page_size: '40',
    page: String(page),
  });
  const j = await getJson(`${FS_API}/search/?${params}`, { Authorization: `Token ${auth.apiKey}` });
  const results = (j.results || []).map(s => {
    const license = licenseFromUrl(s.license);
    return {
      key: `freesound:${s.id}`, source: 'freesound', sourceLabel: 'Freesound', id: String(s.id),
      title: cleanTitle(s.name), creator: s.username, pageUrl: s.url, license, licenseUrl: s.license,
      desc: stripHtml(s.description).slice(0, 400), tags: s.tags || [], pack: s.pack_name || '',
      duration: s.duration || 0, ch: s.channels || 0, sr: s.samplerate || 0, bits: s.bitdepth || 0,
      size: s.filesize || 0, ext: (s.type || '').toLowerCase(),
      previewUrl: s.previews && (s.previews['preview-hq-mp3'] || s.previews['preview-lq-mp3']), previewExt: 'mp3',
      original: true, // the original file is downloadable once the account is connected
    };
  }).filter(r => lic.has(r.license));
  return { results, more: !!j.next, total: j.count };
}

// ------------------------------------------------------------------ Freesound via Openverse (no key needed)
async function searchOpenverse(q, page, lic) {
  const codes = [...lic].map(l => (l === 'pd' ? 'pdm' : l));
  const params = new URLSearchParams({ q, source: 'freesound', license: codes.join(','), page_size: '20', page: String(page) });
  const j = await getJson(`https://api.openverse.org/v1/audio/?${params}`);
  const results = (j.results || []).map(a => {
    const license = a.license === 'pdm' ? 'pd' : a.license;
    const fsId = (a.foreign_landing_url || '').match(/sounds\/(\d+)/);
    const orig = (a.alt_files || [])[0] || {};
    return {
      key: fsId ? `freesound:${fsId[1]}` : `openverse:${a.id}`, source: 'freesound', sourceLabel: 'Freesound', id: fsId ? fsId[1] : a.id,
      title: cleanTitle(a.title), creator: a.creator, pageUrl: a.foreign_landing_url, license, licenseUrl: a.license_url,
      desc: '', tags: (a.tags || []).map(t => t.name), pack: (a.audio_set && a.audio_set.title) || '',
      duration: (a.duration || 0) / 1000, ch: 0, sr: orig.sample_rate || a.sample_rate || 0, bits: 0,
      size: orig.filesize || 0, ext: (orig.filetype || a.filetype || '').toLowerCase(),
      previewUrl: a.url, previewExt: (a.filetype || 'mp3').toLowerCase(),
      original: !!fsId,
    };
  }).filter(r => lic.has(r.license));
  return { results, more: page < (j.page_count || 0), total: j.result_count };
}

// ------------------------------------------------------------------ Wikimedia Commons
const COMMONS_MIME = { 'audio/x-wav': 'wav', 'audio/wav': 'wav', 'application/ogg': 'ogg', 'audio/ogg': 'ogg', 'audio/flac': 'flac', 'audio/x-flac': 'flac', 'audio/mpeg': 'mp3' };
// Commons has a huge number of word-pronunciation clips; they're never what a sound designer wants.
const PRONUNCIATION = /^(LL-Q\d|[A-Z][a-z]{1,2}(-[a-z]{2,4})?-[^ ]+\.(ogg|oga|opus|wav|mp3|flac)$)/;
// Music, speech and spoken-word recordings aren't sound effects.
const NOT_SFX = /pronunciation|lingua libre|\bmusic|\bsongs?\b|compositions|\bpoems?\b|poetry|spoken wikipedia|speeches|interviews|audio clips of|anthems|ragtime|\bworks by|recordings by|radio programs|podcasts|audiobooks|librivox|hymns|singers|musicians|albums|\bopera|\bjazz|\bblues|orchestra|symphon|sonatas?|concert|\betudes?\b|\bopus\b/i;
const NOT_SFX_TITLE = /(études?|\betudes?\b|\bop\.\s?\d+|\bsonata|\bsymphony|\bnocturne|\bprelude|\bconcerto|\bmazurka|\bwaltz)/i;

// Big WAV / FLAC originals are previewed through the MP3 copy Commons makes of every audio file.
const COMMONS_PREVIEW_MIN = 1.5 * 1024 * 1024;

async function searchCommons(q, page, lic) {
  const limit = 40;
  const params = new URLSearchParams({
    action: 'query', format: 'json', formatversion: '2', origin: '*',
    generator: 'search', gsrsearch: `${q} filetype:audio`, gsrnamespace: '6', gsrlimit: String(limit), gsroffset: String((page - 1) * limit),
    prop: 'videoinfo|categories', viprop: 'url|size|mime|extmetadata|derivatives', cllimit: 'max', clshow: '!hidden',
    viextmetadatafilter: 'LicenseShortName|License|LicenseUrl|Artist|ImageDescription|ObjectName',
  });
  const j = await getJson(`https://commons.wikimedia.org/w/api.php?${params}`);
  const pages = ((j.query && j.query.pages) || []).sort((a, b) => (a.index || 0) - (b.index || 0));
  const results = [];
  for (const p of pages) {
    const ii = p.videoinfo && p.videoinfo[0];
    if (!ii) continue;
    const ext = COMMONS_MIME[ii.mime];
    const file = p.title.replace(/^File:/, '');
    if (!ext || PRONUNCIATION.test(file)) continue;
    if ((p.categories || []).some(c => NOT_SFX.test(c.title)) || NOT_SFX_TITLE.test(file)) continue;
    if (/\bvoice\b/i.test(file) && !/voice|vocal|speech|talk/i.test(q)) continue; // recordings of someone speaking
    const md = ii.extmetadata || {};
    const val = k => (md[k] && md[k].value) || '';
    const desc = stripHtml(val('ImageDescription'));
    if (/pronunciation/i.test(desc) && (ii.duration || 0) < 6) continue;
    const license = licenseFromCommons(val('License'), val('LicenseShortName'));
    if (!lic.has(license)) continue;
    const original = ii.url.split('?')[0];
    const mp3 = (ext === 'wav' || ext === 'flac') && (ii.size || 0) > COMMONS_PREVIEW_MIN && (ii.derivatives || []).find(d => d.transcodekey === 'mp3' && /^https:\/\//.test(d.src || ''));
    results.push({
      key: `commons:${p.pageid}`, source: 'commons', sourceLabel: 'Wikimedia Commons', id: String(p.pageid),
      title: cleanTitle(stripHtml(val('ObjectName')) || file), creator: stripHtml(val('Artist')) || 'unknown',
      pageUrl: ii.descriptionurl, license, licenseUrl: val('LicenseUrl'),
      desc: desc.slice(0, 400), tags: [], pack: '',
      duration: ii.duration || 0, ch: 0, sr: 0, bits: 0, size: ii.size || 0, ext,
      previewUrl: mp3 ? mp3.src.split('?')[0] : original, previewExt: mp3 ? 'mp3' : ext, previewIsOriginal: !mp3,
      downloadUrl: original, original: true,
    });
  }
  return { results, more: !!j.continue };
}

// ------------------------------------------------------------------ Internet Archive
// Items are uploads (a single recording or a whole pack); each item's audio files become results.
// Licences are what the uploader declared, so only explicit CC0 / public-domain items are used.
const IA = 'https://archive.org';
const IA_AUDIO = { wav: 'wav', wave: 'wav', flac: 'flac', aif: 'aiff', aiff: 'aiff', mp3: 'mp3', ogg: 'ogg' };
const IA_FILES_PER_ITEM = 12;

function licenseFromArchive(u = '') {
  u = u.toLowerCase();
  if (u.includes('publicdomain/zero')) return 'cc0';
  if (u.includes('publicdomain/mark') || u.includes('licenses/publicdomain')) return 'pd';
  return 'other';
}
const iaLength = v => {
  if (v == null) return 0;
  const s = String(v);
  if (s.includes(':')) return s.split(':').reduce((t, x) => t * 60 + Number(x || 0), 0);
  return Number(s) || 0;
};
const iaUrl = (id, name) => `${IA}/download/${encodeURIComponent(id)}/${name.split('/').map(encodeURIComponent).join('/')}`;

async function iaJson(url, timeout) {
  try { return await getJson(url, {}, timeout); }
  catch (e) { if (e.status >= 500) { await new Promise(r => setTimeout(r, 800)); return getJson(url, {}, timeout); } throw e; } // it's often briefly busy
}
// One item's file list now and then stalls for 20+ s; that item is skipped rather than holding up the page.
const IA_FILES_TIMEOUT = 6000;

async function searchArchive(q, page, lic) {
  const terms = q.replace(/[+\-&|!(){}[\]^"~*?:\\/]/g, ' ').split(/\s+/).filter(Boolean);
  if (!terms.length) return { results: [], more: false };
  const query = `(${terms.join(' AND ')}) AND mediatype:audio AND licenseurl:*publicdomain* AND (subject:"sound effects" OR subject:sfx OR subject:"field recording" OR subject:soundscape OR subject:foley OR subject:ambience) AND -collection:librivoxaudio`;
  const params = new URLSearchParams({ q: query, rows: '12', page: String(page), output: 'json' });
  for (const f of ['identifier', 'title', 'creator', 'licenseurl', 'subject', 'description']) params.append('fl[]', f);
  const j = await iaJson(`${IA}/advancedsearch.php?${params}`);
  const docs = (j.response && j.response.docs) || [];
  const total = (j.response && j.response.numFound) || 0;
  const lower = terms.map(t => t.toLowerCase());
  // Every item's file list at once (one page is only 12 items).
  const lists = await Promise.all(docs.map(d => iaJson(`${IA}/metadata/${encodeURIComponent(d.identifier)}/files`, IA_FILES_TIMEOUT).catch(() => null)));
  const results = [];
  docs.forEach((d, k) => {
    const license = licenseFromArchive(d.licenseurl);
    if (!lic.has(license) || !lists[k]) return;
    const files = lists[k].result || [];
    // Originals that are audio; their MP3 derivative (if any) is the quick preview.
    let originals = files.filter(f => f.source === 'original' && IA_AUDIO[(f.name.split('.').pop() || '').toLowerCase()]);
    if (!originals.length) return;
    const mp3For = new Map();
    for (const f of files) if (f.source === 'derivative' && /mp3/i.test(f.format || '') && f.original) mp3For.set(f.original, f);
    if (originals.length > IA_FILES_PER_ITEM) {
      // Big pack: the files whose names match the search first.
      const score = f => lower.filter(t => f.name.toLowerCase().includes(t)).length;
      originals = originals.map(f => [score(f), f]).sort((a, b) => b[0] - a[0]).slice(0, IA_FILES_PER_ITEM).map(x => x[1]);
    }
    const itemTitle = cleanTitle(Array.isArray(d.title) ? d.title[0] : d.title || d.identifier);
    const creator = stripHtml(Array.isArray(d.creator) ? d.creator.join(', ') : d.creator || '') || 'unknown';
    const desc = stripHtml(Array.isArray(d.description) ? d.description.join(' ') : d.description || '').slice(0, 400);
    const subjects = Array.isArray(d.subject) ? d.subject : d.subject ? [d.subject] : [];
    for (const f of originals) {
      const ext = IA_AUDIO[(f.name.split('.').pop() || '').toLowerCase()];
      const prev = mp3For.get(f.name) || (ext === 'mp3' ? f : null);
      const fileTitle = cleanTitle(f.title || f.name.split('/').pop());
      // Copies of Freesound sounds share Freesound's key, so they aren't listed twice.
      const fsId = /^soundica-fs-(\d+)/.exec(d.identifier);
      results.push({
        key: fsId && originals.length === 1 ? `freesound:${fsId[1]}` : `archive:${d.identifier}/${f.name}`,
        source: 'archive', sourceLabel: 'Internet Archive', id: d.identifier,
        title: originals.length > 1 ? fileTitle : itemTitle, creator,
        pageUrl: `${IA}/details/${encodeURIComponent(d.identifier)}`, license, licenseUrl: Array.isArray(d.licenseurl) ? d.licenseurl[0] : d.licenseurl,
        desc: stripHtml(f.comment || '') || desc, tags: subjects.slice(0, 20), pack: originals.length > 1 ? itemTitle : '',
        duration: iaLength(f.length || (prev && prev.length)), ch: 0, sr: 0, bits: 0, size: Number(f.size) || 0, ext,
        previewUrl: iaUrl(d.identifier, (prev || f).name), previewExt: prev ? 'mp3' : ext, previewSize: Number((prev || f).size) || 0,
        previewIsOriginal: !prev || prev === f,
        downloadUrl: iaUrl(d.identifier, f.name),
        original: true,
      });
    }
  });
  return { results, more: page * 12 < total, total };
}

// ------------------------------------------------------------------ Epidemic Sound (official Partner API)
// The developer key is used for search only (searches aren't counted). Its download endpoint
// would count every preview against the developer plan, so previews and saves go through the
// MCP server with the person's own account key instead (see below).
const EPI_API = 'https://api.epidemicsound.com/v0';
const EPI_PAGE = 40; // the API allows up to 60

async function searchEpidemic(q, page, auth) {
  if (!auth || !auth.apiKey) {
    const e = new Error('Set up Epidemic Sound first: add your Epidemic account key (Epidemic button in the top bar).');
    e.status = 401;
    throw e;
  }
  const params = new URLSearchParams({ term: q.slice(0, 500), limit: String(EPI_PAGE), offset: String((page - 1) * EPI_PAGE), sort: 'best-match', order: 'desc' });
  // A developer key needs a user id; an anonymous, stable one is used.
  const j = await getJson(`${EPI_API}/sound-effects/search?${params}`, { Authorization: 'Bearer ' + auth.apiKey, 'x-partner-user-id': 'soundfield-desktop' });
  const list = j.soundEffects || [];
  const results = list.map(s => ({
    key: `epidemic:${s.id}`, source: 'epidemic', sourceLabel: 'Epidemic Sound', id: s.id,
    title: s.title, creator: 'Epidemic Sound',
    pageUrl: `https://www.epidemicsound.com/sound-effects/search/?term=${encodeURIComponent(s.title)}`,
    license: 'epidemic', licenseUrl: 'https://www.epidemicsound.com/licensing/',
    desc: '', tags: [], pack: s.title.split(',').slice(0, 2).map(x => x.trim()).join(' / '),
    duration: Number(s.length) || 0, ch: 0, sr: 0, bits: 0, size: 0, ext: 'wav', // saves are WAV (previews MP3)
    previewUrl: '', previewExt: 'mp3', signed: true, original: true,
  }));
  // Semantic search never runs dry, so stop after a few pages rather than paging forever.
  return { results, more: !!(j.links && j.links.next) && page < 5 };
}

// ------------------------------------------------------------------ Epidemic Sound MCP server
// Previews and saves go through Epidemic's official MCP server with the person's OWN account
// key (epidemicsound.com → Account → API keys), so they're covered by their subscription and
// nothing is counted. It's JSON-RPC over HTTP; answers may come back as server-sent events.
const MCP_URL = 'https://www.epidemicsound.com/a/mcp-service/mcp';
const mcpSessions = new Map(); // account key -> session id
let rpcId = 1;

async function mcpPost(key, body, sid) {
  let r, text;
  try {
    r = await net.fetch(MCP_URL, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: {
        Authorization: 'Bearer ' + key, 'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream', 'User-Agent': UA,
        ...(sid ? { 'Mcp-Session-Id': sid } : {}),
      },
      signal: AbortSignal.timeout(SEARCH_TIMEOUT + 10000),
    });
    text = await r.text();
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error('Epidemic Sound took too long to answer. Try again in a moment.');
    throw e;
  }
  if (!r.ok) {
    const e = new Error(r.status === 401 || r.status === 403 ? 'Epidemic Sound didn’t accept your account key. Check it under the Epidemic button.' : `Epidemic Sound: HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  let msg = null;
  if ((r.headers.get('content-type') || '').includes('text/event-stream')) {
    for (const line of text.split(/\r?\n/)) {
      if (!line.startsWith('data:')) continue;
      try { const j = JSON.parse(line.slice(5).trim()); if (j && j.id === body.id) msg = j; } catch {}
    }
  } else if (text) {
    try { msg = JSON.parse(text); } catch {}
  }
  return { msg, sid: r.headers.get('mcp-session-id') };
}

async function mcpSession(key) {
  if (mcpSessions.has(key)) return mcpSessions.get(key);
  const init = { jsonrpc: '2.0', id: rpcId++, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'Soundfield', version: '0.1' } } };
  const { msg, sid } = await mcpPost(key, init);
  if (!msg || msg.error) throw new Error((msg && msg.error && msg.error.message) || 'Couldn’t connect to Epidemic Sound');
  try { await mcpPost(key, { jsonrpc: '2.0', method: 'notifications/initialized' }, sid); } catch {}
  mcpSessions.set(key, sid || '');
  return sid || '';
}

async function mcpCall(key, method, params, retry = true) {
  const sid = await mcpSession(key);
  try {
    const { msg } = await mcpPost(key, { jsonrpc: '2.0', id: rpcId++, method, params }, sid);
    if (!msg) throw new Error('No answer from Epidemic Sound');
    if (msg.error) throw new Error(msg.error.message || 'Epidemic Sound error');
    return msg.result;
  } catch (e) {
    // Sessions expire: start a new one once.
    if (retry && (e.status === 400 || e.status === 404)) { mcpSessions.delete(key); return mcpCall(key, method, params, false); }
    throw e;
  }
}

// Calls one tool; its answer is a JSON string inside the result.
async function mcpTool(key, name, args) {
  const res = await mcpCall(key, 'tools/call', { name, arguments: args });
  const t = res && Array.isArray(res.content) && res.content[0] && res.content[0].text;
  if (res && res.isError) {
    let code = '';
    try { const j = JSON.parse(t); code = (j.errors && j.errors[0] && j.errors[0].extensions && j.errors[0].extensions.code) || ''; } catch {}
    if (code === 'FORBIDDEN') {
      const e = new Error('Your Epidemic account isn’t allowed to download this sound. Make sure the account key comes from the Epidemic account that has your subscription, and that the plan includes sound effects (check under the Epidemic button).');
      e.status = 403;
      throw e;
    }
    throw new Error(String(t || 'Epidemic Sound error').slice(0, 300));
  }
  try { return JSON.parse(t); } catch { return t; }
}

const findString = (o, k) => {
  if (!o || typeof o !== 'object') return null;
  if (typeof o[k] === 'string') return o[k];
  for (const v of Object.values(o)) { const f = findString(v, k); if (f) return f; }
  return null;
};

// A signed URL for one sound effect file: fileType 'WAV' or 'MP3'.
async function epidemicAssetUrl(id, fileType, key) {
  const out = await mcpTool(key, 'DownloadSoundEffect', { id, options: { fileType } });
  const url = (out && out.data && out.data.soundEffectDownload && out.data.soundEffectDownload.assetUrl) || findString(out, 'assetUrl');
  if (!url || !/^https:\/\//.test(url)) throw new Error(typeof out === 'string' ? out.slice(0, 200) : 'Epidemic Sound returned no file');
  return url;
}

// Search through the MCP server with the account key. Results carry a low-quality MP3 link
// for quick previews, so listening doesn't need a download call at all.
const EPI_MCP_PAGE = 40;
const mcpCursors = new Map(); // search term -> [cursor for page 1 (none), page 2, …]

async function searchEpidemicMcp(q, page, key) {
  const term = q.slice(0, 500);
  const cursors = mcpCursors.get(term) || [null];
  if (page === 1) {
    mcpCursors.delete(term);
    mcpCursors.set(term, cursors.slice(0, 1));
    if (mcpCursors.size > 50) mcpCursors.delete(mcpCursors.keys().next().value); // forget old searches
  }
  const after = cursors[page - 1];
  if (page > 1 && !after) return { results: [], more: false };
  const out = await mcpTool(key, 'SearchSoundEffects', { query: { term }, first: EPI_MCP_PAGE, ...(after ? { after } : {}) });
  const se = out && out.data && out.data.soundEffects;
  if (!se) throw new Error(typeof out === 'string' ? out.slice(0, 200) : 'Epidemic Sound search failed');
  const info = se.pageInfo || {};
  if (info.hasNextPage && info.endCursor) (mcpCursors.get(term) || [null])[page] = info.endCursor;
  const results = (se.nodes || []).map(n => n.soundEffect).filter(Boolean).map(s => {
    const a = s.audioFile || {};
    return {
      key: `epidemic:${s.id}`, source: 'epidemic', sourceLabel: 'Epidemic Sound', id: s.id,
      title: s.title, creator: 'Epidemic Sound',
      pageUrl: `https://www.epidemicsound.com/sound-effects/search/?term=${encodeURIComponent(s.title)}`,
      license: 'epidemic', licenseUrl: 'https://www.epidemicsound.com/licensing/',
      desc: '', tags: (s.tags || []).map(t => t.displayName).filter(Boolean), pack: String(s.title || '').split(',').slice(0, 2).map(x => x.trim()).join(' / '),
      duration: (a.durationInMilliseconds || 0) / 1000, ch: 0, sr: 0, bits: 0, size: 0, ext: 'wav', // saves are WAV
      previewUrl: /^https:\/\//.test(a.lqmp3Url || '') ? a.lqmp3Url : '', previewExt: 'mp3', signed: true, original: true,
    };
  });
  // Semantic search never runs dry, so stop after a few pages.
  return { results, more: !!(info.hasNextPage && info.endCursor) && page < 5 };
}

// Checks an account key without downloading anything.
async function epidemicCheckKey(key) {
  mcpSessions.delete(key);
  const r = await mcpCall(key, 'tools/list', {});
  return ((r && r.tools) || []).map(t => t.name);
}

// ------------------------------------------------------------------ search (all sources)
async function search({ query, page = 1, sources = ['freesound', 'commons'], licenses, types }, auth) {
  const q = String(query || '').trim();
  const lic = allowed(licenses);
  // Empty or every type = no type filter.
  const typeSet = Array.isArray(types) && types.length && types.length < Object.keys(FS_TYPES).length ? new Set(types) : null;
  const jobs = [];
  if (sources.includes('freesound')) jobs.push(['freesound', auth.apiKey ? searchFreesound(q, page, lic, auth, typeSet) : searchOpenverse(q, page, lic)]);
  if (sources.includes('commons')) jobs.push(['commons', searchCommons(q, page, lic)]);
  if (sources.includes('archive')) jobs.push(['archive', searchArchive(q, page, lic)]);
  if (sources.includes('epidemic')) {
    const ep = auth.epidemic || {};
    // Your account key (MCP) when it's set; otherwise the developer key (Partner API).
    jobs.push(['epidemic', ep.accountKey ? searchEpidemicMcp(q, page, ep.accountKey) : searchEpidemic(q, page, ep)]);
  }
  const out = { results: [], more: {}, totals: {}, errors: {}, via: auth.apiKey ? 'freesound' : 'openverse' };
  const settled = await Promise.allSettled(jobs.map(j => j[1]));
  const lists = [];
  settled.forEach((s, i) => {
    const src = jobs[i][0];
    if (s.status === 'fulfilled') {
      for (const r of s.value.results) r.ext = fileType(r.ext);
      lists.push(typeSet ? s.value.results.filter(r => typeSet.has(r.ext)) : s.value.results);
      out.more[src] = s.value.more;
      if (s.value.total != null) out.totals[src] = s.value.total;
    }
    else {
      const e = s.reason || {};
      out.errors[src] = e.status === 429 ? 'Too many searches for now. Try again in a minute' + (src === 'freesound' && !auth.apiKey ? ', or add a free Freesound key for higher limits.' : '.')
        : e.status === 401 ? (src === 'epidemic' ? e.message.startsWith('Set up') || e.message.includes('account key') ? e.message : 'Epidemic Sound didn’t accept the developer key. Add your Epidemic account key under the Epidemic button instead.' : 'Freesound rejected the API key. Check it in Freesound settings.')
        : e.status === 403 && src === 'epidemic' ? 'Epidemic Sound: this account or key has no access to sound effects.'
        : e.message || 'Search failed';
    }
  });
  // Interleave sources so the best hits from each come first.
  for (let i = 0; lists.some(l => i < l.length); i++) for (const l of lists) if (i < l.length) out.results.push(l[i]);
  return out;
}

// ------------------------------------------------------------------ files
async function download(url, dest, headers = {}, onProgress) {
  // The file is kept by us, so Chromium's own disk cache would only hold a second copy.
  const get = () => net.fetch(url, { headers: { 'User-Agent': UA, ...headers }, cache: 'no-store' });
  let r = await get();
  for (let tries = 0; r.status >= 500 && tries < 2; tries++) { // busy server: try again shortly
    await r.arrayBuffer().catch(() => {});
    await new Promise(res => setTimeout(res, 800));
    r = await get();
  }
  if (!r.ok) { const e = new Error(`Download failed (HTTP ${r.status})`); e.status = r.status; throw e; }
  const total = Number(r.headers.get('content-length')) || 0;
  const tmp = `${dest}.${process.pid}.part`;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  let got = 0;
  const body = Readable.fromWeb(r.body);
  if (onProgress) body.on('data', c => { got += c.length; onProgress(got, total); });
  try {
    await pipeline(body, fs.createWriteStream(tmp));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
  return { dest, type: r.headers.get('content-type') || '' };
}

// Freesound's preview server limits each connection to roughly 50–80 KB/s, so a file is
// fetched as many byte ranges at once and stitched together: about N times faster.
// Node's https is used rather than Chromium's network stack, which allows only
// 6 connections per site. sizeHint is an estimate; the last range is open-ended so a
// bigger file still arrives whole. Falls back to a plain download if anything is off.
const rangeAgent = new https.Agent({ keepAlive: true, maxSockets: 32 });

function getRange(url, from, to, onData, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { agent: rangeAgent, headers: { 'User-Agent': UA, Range: `bytes=${from}-${to == null ? '' : to}` } }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
        res.resume();
        resolve(getRange(new URL(res.headers.location, url).href, from, to, onData, redirects - 1));
        return;
      }
      if (res.statusCode === 416) { res.resume(); resolve(null); return; } // starts past the end
      if (res.statusCode >= 500 && redirects > 0) { // busy server (Internet Archive often is): try again shortly
        res.resume();
        setTimeout(() => resolve(getRange(url, from, to, onData, redirects - 1)), 700);
        return;
      }
      const m = /bytes (\d+)-(\d+)\/(\d+)/.exec(res.headers['content-range'] || '');
      if (res.statusCode !== 206 || !m) { res.destroy(); reject(NO_RANGES); return; }
      let pos = Number(m[1]);
      const start = pos;
      res.on('data', chunk => { onData(chunk, pos); pos += chunk.length; });
      res.on('end', () => resolve({ start, end: pos, total: Number(m[3]) }));
      res.on('error', reject);
    });
    req.setTimeout(30000, () => req.destroy(new Error('Download timed out')));
    req.on('error', reject);
  });
}
const NO_RANGES = new Error('ranges not supported');

async function downloadRanges(url, dest, sizeHint, onProgress) {
  const parts = Math.max(2, Math.min(16, Math.ceil(sizeHint / (96 * 1024))));
  const step = Math.ceil(sizeHint / parts);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.part`;
  const fd = fs.openSync(tmp, 'w');
  let got = 0, total = 0, closed = false;
  try {
    const spans = (await Promise.all(Array.from({ length: parts }, (_, k) =>
      getRange(url, k * step, k === parts - 1 ? null : (k + 1) * step - 1, (chunk, pos) => {
        if (closed) return; // another range failed; the rest are ignored
        fs.writeSync(fd, chunk, 0, chunk.length, pos);
        got += chunk.length;
        if (onProgress) onProgress(got, total || sizeHint);
      }).then(sp => { if (sp) total = sp.total; return sp; })))).filter(Boolean);
    closed = true;
    fs.closeSync(fd);
    // Every byte must have arrived.
    spans.sort((a, b) => a.start - b.start);
    let covered = 0;
    for (const sp of spans) { if (sp.start > covered) break; covered = Math.max(covered, sp.end); }
    if (!total || covered < total) throw NO_RANGES;
    fs.truncateSync(tmp, total);
    fs.renameSync(tmp, dest);
    return { dest, type: '' };
  } catch (e) {
    if (!closed) { closed = true; try { fs.closeSync(fd); } catch {} }
    try { fs.unlinkSync(tmp); } catch {}
    if (e === NO_RANGES) return download(url, dest, {}, onProgress);
    throw e;
  }
}

function safeName(s) {
  return String(s || 'sound').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '').slice(0, 120).trim() || 'sound';
}

function uniquePath(dir, base, ext) {
  let p = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(p); n++) p = path.join(dir, `${base} (${n}).${ext}`);
  return p;
}

module.exports = { LICENSES, search, epidemicAssetUrl, epidemicCheckKey, download, downloadRanges, attributionText, safeName, uniquePath, FS_API, UA };
