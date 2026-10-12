import { Engine } from './engine.js';
import { WaveView, fmtTime, escapeHtml } from './waveform.js';
import { SpeakerView } from './speakers.js';
import { VList } from './vlist.js';
import { createSource } from './sources.js';
import { detectLayout, layoutChoices } from './layouts.js';
import { metaCategory, TYPES, TYPE_LABELS } from '../../shared/categorize.mjs';

const $ = s => document.querySelector(s);
const api = window.api;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ------------------------------------------------------------------ prefs
const prefs = Object.assign(
  { volume: -6, autoplay: true, loop: false, monitor: 'stereo', lfe: false, playerH: 330, sort: { key: 'name', dir: 1 }, expanded: [] },
  safeJson(() => localStorage.getItem('sf.prefs')),
);
function savePrefs() { try { localStorage.setItem('sf.prefs', JSON.stringify(prefs)); } catch {} }
function safeJson(fn) { try { return JSON.parse(fn()) || {}; } catch { return {}; } }

// ------------------------------------------------------------------ state
const S = {
  libs: [],
  recs: {},
  sep: '\\',
  favorites: new Set(),
  overrides: {},
  items: [],
  view: [],
  scope: { type: 'all' },
  query: '',
  classes: new Set(),
  sr: '',
  dur: '',
  current: null,
  info: null,
  source: null,
  layout: null,
  selection: null,
  cursor: 0,
  token: 0,
  peakJob: 0,
  scans: new Map(),
  dupes: null, // { groups: [{ paths, size, wasted }], byPath: Map(path -> { g, n }), stale }
  dupProgress: null,
  trees: new Map(),
  expanded: new Set(prefs.expanded),
  analysis: {}, // libId -> { rel: type } from listening
  typeOverrides: {}, // path -> type set by the user
  types: new Set(), // active type filters
  analyzing: new Map(), // libId -> { done, total }
};

const engine = new Engine();
const wave = new WaveView({
  wrap: $('#wave-wrap'), canvas: $('#wave'), ruler: $('#ruler'), sel: $('#sel'),
  playhead: $('#playhead'), hover: $('#hover'), labels: $('#lanes-labels'),
});
const speakers = new SpeakerView($('#speakers'));
const list = new VList($('#list'), { rowHeight: 26, render: renderRow });
$('#list').tabIndex = 0;

// ------------------------------------------------------------------ items
const layoutCache = new Map();
function layoutFor(it) {
  const r = it.rec;
  const ov = S.overrides[it.path] || '';
  const fourCh = r.ch === 4 ? it.lib.fourCh || 'auto' : '';
  const ambiHint = /ambix|ambisonic|b[-_ ]?format|foa|hoa|[1-7]oa|fuma|\.amb$/i.test(r.rel) ? r.rel : '';
  const key = `${r.ch}|${r.mask || 0}|${r.ag || 0}|${r.tn ? r.tn.join('\u0001') : ''}|${ov}|${fourCh}|${ambiHint}`;
  let l = layoutCache.get(key);
  if (!l) {
    l = detectLayout(r, { path: r.rel, override: ov, fourCh: it.lib.fourCh });
    layoutCache.set(key, l);
  }
  return l;
}

function makeItem(lib, rec) {
  const sep = S.sep;
  const base = lib.path.endsWith(sep) ? lib.path : lib.path + sep;
  const slash = rec.rel.lastIndexOf('/');
  const file = rec.rel.slice(slash + 1);
  const dot = file.lastIndexOf('.');
  const it = {
    lib, rec,
    path: base + rec.rel.split('/').join(sep),
    name: dot > 0 ? file.slice(0, dot) : file,
    ext: dot > 0 ? file.slice(dot + 1).toLowerCase() : '',
    folder: slash >= 0 ? rec.rel.slice(0, slash) : '',
    zip: !!rec.zip,
  };
  assignLayout(it);
  return it;
}

function assignLayout(it) {
  if (it.zip) {
    it.layout = null;
    it.cls = 'zip';
    it.fmtLabel = 'ZIP';
  } else {
    it.layout = layoutFor(it);
    it.cls = it.layout.cls;
    it.fmtLabel = it.layout.label;
  }
  const r = it.rec;
  it.hay0 = `${r.rel} ${r.desc || ''} ${r.tn ? r.tn.join(' ') : ''} ${it.fmtLabel} ${it.lib.name}`.toLowerCase();
  it.metaType = it.zip ? null : metaCategory(r.rel, r.desc);
  assignType(it);
}

// Type priority: what you set > what the name / metadata says > what the audio sounds like.
function assignType(it) {
  let type = null, src = '';
  if (!it.zip) {
    let ov = S.typeOverrides[it.path];
    if (ov === 'music') ov = 'musical'; // from before the category list changed
    if (!TYPE_LABELS[ov]) ov = null;
    let heard = (S.analysis[it.lib.id] || {})[it.rec.rel];
    if (!TYPE_LABELS[heard]) heard = null;
    if (ov) { type = ov; src = 'you'; }
    else if (it.metaType) { type = it.metaType; src = 'name'; }
    else if (heard) { type = heard; src = 'audio'; }
  }
  it.type = type || 'unsorted';
  it.typeSrc = src;
  it.hay = it.zip ? it.hay0 : `${it.hay0} ${TYPE_LABELS[it.type].toLowerCase()}`;
}

// A stable colour per category: a few fixed, the rest spread around the hue wheel.
const FIXED_COLORS = { background: '#68d391', roomtone: '#90cdf4', voice: '#faf089', human: '#fbb6ce', footsteps: '#f687b3', musical: '#d6bcfa', unsorted: '#5c6575' };
const colorCache = {};
function typeColor(id) {
  if (colorCache[id]) return colorCache[id];
  // Golden-angle steps through the alphabetical list keep neighbours distinct.
  const i = Math.max(0, TYPES.indexOf(id));
  return (colorCache[id] = FIXED_COLORS[id] || `hsl(${Math.round((i * 137.508) % 360)}, 65%, 70%)`);
}

// The sidebar lists only the categories that have sounds, alphabetically.
function refreshTypeCounts() {
  const n = {};
  for (const it of S.items) if (!it.zip) n[it.type] = (n[it.type] || 0) + 1;
  const ids = TYPES.filter(t => n[t] || S.types.has(t));
  if (n.unsorted || S.types.has('unsorted')) ids.push('unsorted');
  const box = $('#types');
  // "All" clears the category filter but keeps the current view (e.g. Duplicates).
  const all = document.createElement('div');
  all.className = 'side-item all' + (S.types.size ? '' : ' active');
  all.dataset.type = '__all';
  all.style.setProperty('--ty', '#e3e7ee');
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  all.innerHTML = `<span class="dot"></span><span class="lbl">All</span><span class="num">${total ? total.toLocaleString() : ''}</span>`;
  box.replaceChildren(all, ...ids.map(id => {
    const el = document.createElement('div');
    el.className = 'side-item' + (S.types.has(id) ? ' active' : '');
    el.dataset.type = id;
    el.style.setProperty('--ty', typeColor(id));
    el.innerHTML = `<span class="dot"></span><span class="lbl">${escapeHtml(TYPE_LABELS[id])}</span><span class="num">${n[id] ? n[id].toLocaleString() : ''}</span>`;
    return el;
  }));
  $('#types-title').hidden = !ids.length;
}

function rebuildItems() {
  const out = [];
  for (const lib of S.libs) for (const rec of S.recs[lib.id] || []) out.push(makeItem(lib, rec));
  S.items = out;
  for (const lib of S.libs) S.trees.set(lib.id, buildTree(S.recs[lib.id] || []));
}

// ------------------------------------------------------------------ filtering
function parseQuery(q) {
  const inc = [], exc = [];
  for (const m of q.toLowerCase().match(/"[^"]+"|\S+/g) || []) {
    const t = m.replace(/^-?"|"$/g, '').replace(/^"/, '');
    if (m.startsWith('-') && m.length > 1) exc.push(m.slice(1).replace(/"/g, ''));
    else if (t) inc.push(t);
  }
  return { inc, exc };
}

function applyFilters({ keepScroll = false } = {}) {
  const { inc, exc } = parseQuery(S.query);
  const sc = S.scope;
  const cls = S.classes;
  const sr = S.sr ? Number(S.sr) : 0;
  let dmin = -1, dmax = Infinity;
  if (S.dur) { const [a, b] = S.dur.split('-'); dmin = Number(a); dmax = b ? Number(b) : Infinity; }
  // Folder browsing: subfolders + this folder's own sounds. Any search or filter
  // looks through everything inside the current folder instead, like Explorer.
  const searching = !!(inc.length || exc.length || cls.size || S.types.size || sr || S.dur);
  const browse = browsing() && !searching;
  const out = [];
  for (const it of S.items) {
    if (sc.type === 'fav' && !S.favorites.has(it.path)) continue;
    if (sc.type === 'dups' && (S.dupChooser || !(S.dupes && S.dupes.byPath.has(it.path)))) continue;
    if (sc.type === 'folder') {
      if (it.lib.id !== sc.lib) continue;
      if (sc.prefix && it.folder !== sc.prefix && !it.folder.startsWith(sc.prefix + '/')) continue;
    }
    if (browse && (sc.type === 'all' || it.folder !== (sc.prefix || ''))) continue;
    if (cls.size && !cls.has(it.cls)) continue;
    if (S.types.size && (it.zip || !S.types.has(it.type))) continue;
    if (!it.zip) {
      if (sr && (sr === 192000 ? it.rec.sr < 176400 : it.rec.sr !== sr)) continue;
      if (S.dur && !(it.rec.dur >= dmin && it.rec.dur <= dmax)) continue;
    } else if (sr || S.dur) continue;
    let ok = true;
    for (const t of inc) if (!it.hay.includes(t)) { ok = false; break; }
    if (!ok) continue;
    for (const t of exc) if (it.hay.includes(t)) { ok = false; break; }
    if (ok) out.push(it);
  }
  if (sc.type === 'dups' && S.dupes) {
    // Keep copies together, biggest space savings first.
    const bp = S.dupes.byPath;
    out.sort((a, b) => bp.get(a.path).g - bp.get(b.path).g || collator.compare(a.path, b.path));
  } else sortItems(out);
  const folders = browse ? folderRows(sc) : [];
  const view = folders.length ? folders.concat(out) : out;
  S.view = view;
  renderDupBanner();
  renderCrumbs(searching);
  if (!keepScroll) $('#list').scrollTop = 0;
  list.setItems(view);
  const idx = S.current ? view.indexOf(S.current) : -1;
  list.select(idx, false);
  $('#count').textContent = (folders.length ? `${folders.length.toLocaleString()} folder${folders.length === 1 ? '' : 's'} · ` : '') +
    `${out.length.toLocaleString()} of ${S.items.length.toLocaleString()}`;
  $('#n-all').textContent = S.items.length.toLocaleString();
  $('#n-fav').textContent = S.favorites.size ? S.favorites.size.toLocaleString() : '';
  $('#empty').hidden = S.libs.length > 0;
  refreshTypeCounts();
}

function sortItems(arr) {
  const { key, dir } = prefs.sort;
  const by = {
    name: (a, b) => collator.compare(a.name, b.name),
    type: (a, b) => (a.type === 'unsorted') - (b.type === 'unsorted') || collator.compare(TYPE_LABELS[a.type] || '', TYPE_LABELS[b.type] || ''),
    fmt: (a, b) => (a.rec.ch || 0) - (b.rec.ch || 0) || collator.compare(a.fmtLabel, b.fmtLabel),
    ch: (a, b) => (a.rec.ch || 0) - (b.rec.ch || 0),
    dur: (a, b) => (a.rec.dur || 0) - (b.rec.dur || 0),
    sr: (a, b) => (a.rec.sr || 0) - (b.rec.sr || 0),
    bits: (a, b) => (a.rec.bits || 0) - (b.rec.bits || 0),
    desc: (a, b) => collator.compare(a.rec.desc || '￿', b.rec.desc || '￿'),
    lib: (a, b) => collator.compare(a.lib.name + '/' + a.folder, b.lib.name + '/' + b.folder) || collator.compare(a.name, b.name),
  }[key] || ((a, b) => collator.compare(a.name, b.name));
  arr.sort((a, b) => by(a, b) * dir || collator.compare(a.name, b.name));
  document.querySelectorAll('#list-header [data-sort]').forEach(h => {
    h.classList.toggle('asc', h.dataset.sort === key && dir === 1);
    h.classList.toggle('desc', h.dataset.sort === key && dir === -1);
  });
}

// ------------------------------------------------------------------ folder browsing
const browsing = () => prefs.showFolders && (S.scope.type === 'all' || S.scope.type === 'folder');

// Rows for the subfolders of the current location (libraries at the top level).
function folderRows(sc) {
  if (sc.type === 'all') {
    return S.libs.map(lib => ({ isFolder: true, lib, prefix: '', name: lib.name, count: (S.trees.get(lib.id) || {}).count || 0, path: lib.path }));
  }
  const lib = S.libs.find(l => l.id === sc.lib);
  let node = lib && S.trees.get(lib.id);
  if (!node) return [];
  if (sc.prefix) for (const part of sc.prefix.split('/')) { node = node.children.get(part); if (!node) return []; }
  return [...node.children.values()]
    .sort((a, b) => collator.compare(a.name, b.name))
    .map(k => ({ isFolder: true, lib, prefix: k.path, name: k.name, count: k.count, path: folderPath(lib, k.path) }));
}

function openFolder(lib, prefix) {
  S.scope = lib ? { type: 'folder', lib: lib.id, prefix } : { type: 'all' };
  if (lib) {
    // Reveal it in the sidebar tree too.
    S.expanded.add(lib.id + ':');
    let acc = '';
    for (const part of prefix ? prefix.split('/').slice(0, -1) : []) { acc = acc ? acc + '/' + part : part; S.expanded.add(lib.id + ':' + acc); }
    prefs.expanded = [...S.expanded];
    savePrefs();
  }
  renderTree();
  applyFilters();
}

function goUp() {
  const sc = S.scope;
  if (sc.type !== 'folder') return;
  const lib = S.libs.find(l => l.id === sc.lib);
  if (!sc.prefix) openFolder(null);
  else openFolder(lib, sc.prefix.includes('/') ? sc.prefix.slice(0, sc.prefix.lastIndexOf('/')) : '');
}

function renderCrumbs(searching) {
  const el = $('#crumbs');
  if (!browsing()) { el.hidden = true; return; }
  el.hidden = false;
  const sc = S.scope;
  const parts = [{ label: 'All libraries', lib: null, prefix: '' }];
  if (sc.type === 'folder') {
    const lib = S.libs.find(l => l.id === sc.lib);
    if (lib) {
      parts.push({ label: lib.name, lib, prefix: '' });
      let acc = '';
      for (const p of sc.prefix ? sc.prefix.split('/') : []) { acc = acc ? acc + '/' + p : p; parts.push({ label: p, lib, prefix: acc }); }
    }
  }
  el.replaceChildren();
  const up = document.createElement('button');
  up.className = 'up';
  up.textContent = '↑ Up';
  up.title = 'Up one folder (Backspace)';
  up.disabled = sc.type !== 'folder';
  up.addEventListener('click', goUp);
  el.appendChild(up);
  parts.forEach((p, i) => {
    if (i) { const s = document.createElement('span'); s.className = 'sep'; s.textContent = '›'; el.appendChild(s); }
    const c = document.createElement('span');
    c.className = 'crumb' + (i === parts.length - 1 ? ' here' : '');
    c.textContent = p.label;
    if (i < parts.length - 1) c.addEventListener('click', () => openFolder(p.lib, p.prefix));
    el.appendChild(c);
  });
  if (searching) {
    const n = document.createElement('span');
    n.className = 'note';
    n.textContent = '· showing matches from all folders inside';
    el.appendChild(n);
  }
}

function renderFolderRow(row, it) {
  const c = row._c;
  row.classList.add('folder-row');
  row.classList.remove('dup-b', 'dup-first');
  c[0].firstChild.classList.remove('on');
  c[1].innerHTML = `<span class="fico"></span>${escapeHtml(it.name)}`;
  c[1].title = it.path;
  c[2].firstChild.className = 'fmt';
  c[2].firstChild.textContent = '';
  c[3].className = 'c-type';
  c[3].textContent = '';
  c[3].title = '';
  for (const k of [4, 5, 6, 7]) c[k].textContent = '';
  c[8].textContent = `${it.count.toLocaleString()} sound${it.count === 1 ? '' : 's'}`;
  c[8].title = '';
  c[9].textContent = it.prefix ? `${it.lib.name} / ${it.prefix}` : it.lib.name;
  c[9].title = it.path;
}

// ------------------------------------------------------------------ list rows
function renderRow(row, it) {
  if (!row._built) {
    row.innerHTML = '<div class="c-fav"><span class="star">★</span></div><div class="c-name"></div><div class="c-fmt"><span class="fmt"></span></div><div class="c-type"></div><div class="c-ch"></div><div class="c-dur"></div><div class="c-sr"></div><div class="c-bits"></div><div class="c-desc"></div><div class="c-lib"></div>';
    row.draggable = true;
    row._built = true;
    row._c = [...row.children];
  }
  if (it.isFolder) { renderFolderRow(row, it); return; }
  row.classList.remove('folder-row');
  const c = row._c, r = it.rec;
  c[0].firstChild.classList.toggle('on', S.favorites.has(it.path));
  const dup = S.scope.type === 'dups' && S.dupes ? S.dupes.byPath.get(it.path) : null;
  row.classList.toggle('dup-b', !!dup && dup.g % 2 === 1);
  row.classList.toggle('dup-first', !!dup && dup.first);
  c[1].innerHTML = `${escapeHtml(it.name)}<span class="ext">.${escapeHtml(it.ext)}</span>${dup ? `<span class="dupn">${dup.n} copies</span>` : ''}`;
  c[1].title = it.path;
  const f = c[2].firstChild;
  f.className = 'fmt ' + it.cls;
  f.textContent = it.fmtLabel;
  const t = c[3];
  if (it.zip) { t.className = 'c-type'; t.textContent = ''; t.title = ''; }
  else {
    const pending = it.type === 'unsorted' && S.analyzing.has(it.lib.id) && it.rec.codec !== 'decode';
    t.className = `c-type${pending ? ' pending' : ''}`;
    t.style.setProperty('--ty', typeColor(it.type));
    t.innerHTML = pending ? 'listening…' : `<span class="tdot"></span>${TYPE_LABELS[it.type]}${it.typeSrc === 'you' ? '<span class="tsrc">✎</span>' : ''}`;
    t.title = it.typeSrc === 'you' ? 'Set by you' : it.typeSrc === 'name' ? 'From the file name / metadata' : it.typeSrc === 'audio' ? 'From listening to the audio' : 'Not sorted yet (right-click → Category)';
  }
  if (it.zip) {
    c[4].textContent = '';
    c[5].textContent = `${r.zip} files`;
    c[6].textContent = '';
    c[7].textContent = '';
    c[8].textContent = `Archive · ${fmtBytes(r.zb || r.size)} of audio`;
  } else {
    c[4].textContent = r.ch || '';
    c[5].textContent = r.dur ? fmtTime(r.dur) : '';
    c[6].textContent = r.sr ? (r.sr / 1000).toFixed(r.sr % 1000 ? 1 : 0) + 'k' : '';
    c[7].textContent = r.bits ? (r.codec === 'float' ? r.bits + 'f' : r.bits) : r.codec === 'decode' ? it.ext : '';
    c[8].textContent = r.desc || '';
  }
  c[8].title = r.desc || '';
  c[9].textContent = it.folder ? `${it.lib.name} / ${it.folder}` : it.lib.name;
  c[9].title = c[9].textContent;
}

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}

// ------------------------------------------------------------------ selection / loading
async function selectIndex(i, { play = prefs.autoplay, scroll = true } = {}) {
  if (i < 0 || i >= S.view.length) return;
  list.select(i, scroll);
  const it = S.view[i];
  if (it.isFolder) return; // folders are opened with double-click / Enter
  if (S.playOnLoad && S.playOnLoad !== it) S.playOnLoad = null;
  if (S.current === it) { if (play && !engine.playing) startPlay(); return; }
  S.current = it;
  const token = ++S.token;
  engine.stop();
  S.selection = null;
  S.cursor = 0;
  S.source = null;
  S.info = null;
  $('#zip-panel').hidden = true;
  $('#drag-handle').classList.toggle('disabled', false);

  if (it.zip) {
    showZip(it);
    S.layout = null;
    wave.clear();
    speakers.setLayout(null);
    fillLayoutSelect();
    renderMeta();
    return;
  }

  const info = await api.probe(it.path);
  if (token !== S.token) return;
  if (!info) {
    S.layout = null;
    wave.clear('Can’t read this file. Is the drive connected?');
    speakers.setLayout(null);
    fillLayoutSelect();
    renderMeta();
    return;
  }
  S.info = info;
  let layout = it.layout;
  if (info.ch !== layout.ch) layout = detectLayout({ ...it.rec, ch: info.ch }, { path: it.rec.rel, override: S.overrides[it.path], fourCh: it.lib.fourCh });
  const source = createSource(it.path, info);
  S.source = source;
  S.layout = layout;
  setWaveFile(source, layout);
  renderMeta();

  if (!source.streaming) {
    wave.message = 'Decoding…';
    try { await source.open(); } catch (err) {
      if (token === S.token) wave.clear('This file couldn’t be decoded.');
      return;
    }
    if (token !== S.token) return;
    if (source.ch !== layout.ch) {
      layout = detectLayout({ ...it.rec, ch: source.ch }, { path: it.rec.rel, override: S.overrides[it.path], fourCh: it.lib.fourCh });
      S.layout = layout;
    }
    setWaveFile(source, layout);
    renderMeta();
  }
  engine.setSource(source, layout);
  if (play || S.playOnLoad === it) { S.playOnLoad = null; startPlay(); }

  const job = ++S.peakJob;
  const peaks = await source.peaks(job, p => { if (token === S.token) wave.setPeaks(p); }).catch(() => null);
  if (token === S.token && peaks) wave.setPeaks(peaks);
}

function setWaveFile(source, layout) {
  wave.setFile({ frames: source.frames, sr: source.sr, layout });
  wave.rawProvider = (s, n) => source.readFrames(s, n);
  speakers.setLayout(layout);
  speakers.setMuteSolo([], []);
  fillLayoutSelect();
  $('#t-dur').textContent = fmtTime(source.frames / source.sr, true);
}

function showZip(it) {
  const p = $('#zip-panel');
  const folderName = it.name;
  p.innerHTML = `<div class="zip-card">
    <div class="zip-icon">🗜</div>
    <h3>${escapeHtml(it.name)}.${escapeHtml(it.ext)}</h3>
    <div>${it.rec.zip.toLocaleString()} audio file${it.rec.zip === 1 ? '' : 's'} · ${fmtBytes(it.rec.zb || 0)} uncompressed · ${fmtBytes(it.rec.size)} zipped</div>
    <div class="actions">
      <button data-x="here">Extract here</button>
      <button data-x="folder" class="primary">Extract to “${escapeHtml(folderName)}”</button>
    </div></div>`;
  p.hidden = false;
  p.querySelectorAll('[data-x]').forEach(b => b.addEventListener('click', () => extract(it, b.dataset.x)));
  $('#drag-handle').classList.add('disabled');
}

async function extract(it, mode) {
  toast(`Extracting ${it.name}…`, 60000);
  try {
    const dest = await api.extractZip(it.path, mode, it.lib.id);
    toast(`Extracted to ${dest}. Adding the new sounds…`);
  } catch (err) {
    toast(`Couldn’t extract: ${err.message || err}`, 6000);
  }
}

// ------------------------------------------------------------------ playback
function startPlay(from) {
  if (!S.source || !S.layout) return;
  const sel = S.selection;
  let f = from != null ? from : sel ? sel.start : S.cursor;
  if (!sel && f >= S.source.frames - 1) f = 0;
  engine.play({ from: f, region: sel, loop: prefs.loop });
}

function togglePlay() {
  if (engine.playing) engine.stop();
  else if (S.current && !S.current.zip) startPlay();
}

engine.on('state', s => {
  $('#player').classList.toggle('playing', s.playing);
  updateMonitorHint();
  if (s.ended && !S.selection) S.cursor = 0;
});
engine.on('error', () => toast('Playback error: the file may have moved or the drive was disconnected.'));

wave.on('seek', (frame, inSelection) => {
  if (!S.source) return;
  if (!inSelection) S.selection = null;
  S.cursor = frame;
  startPlay(frame);
});
wave.on('select', sel => {
  S.selection = sel;
  if (sel) { S.cursor = sel.start; startPlay(sel.start); }
});
wave.on('dragRegion', sel => {
  if (!S.current) return;
  const pcm = S.info && (S.info.codec === 'pcm' || S.info.codec === 'float');
  api.startDrag(S.current.path, sel && pcm ? sel : null);
});
wave.on('mutesolo', (mute, solo) => {
  engine.setMuteSolo(mute, solo);
  speakers.setMuteSolo(mute, solo);
});
speakers.onPick = i => wave.soloOnly(i);

// Animation loop: playhead, clock, meters.
let lastT = performance.now();
let quietFrames = 0;
function tick(t) {
  const dt = Math.min(0.1, (t - lastT) / 1000);
  lastT = t;
  if (S.source) {
    const pos = engine.playing ? engine.position() : S.cursor;
    wave.setPlayhead(engine.playing || S.cursor > 0 ? pos : null);
    $('#t-pos').textContent = fmtTime(pos / S.source.sr, true);
  }
  const fresh = engine.playing && performance.now() - (engine.metersAt || 0) < 150;
  if (fresh) quietFrames = 0; else quietFrames++;
  if (quietFrames < 90) {
    wave.setMeters(fresh ? engine.meters : null, dt);
    speakers.update(fresh ? engine.meters : null, fresh ? engine.iv : null, dt);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// ------------------------------------------------------------------ meta panel + layout menu
function renderMeta() {
  const el = $('#file-meta');
  const it = S.current;
  if (!it) { el.innerHTML = ''; return; }
  const r = it.rec, info = S.info;
  const L = S.layout;
  const rows = [];
  if (!it.zip) {
    const ch = info ? info.ch : r.ch;
    rows.push(['Format', L ? `${L.label}${L.ambi ? (L.ambi.fuma ? ' · FuMa' : ' · AmbiX') : ''} · ${ch} ch` : `${ch} ch`]);
    const sr = info ? info.sr : r.sr;
    rows.push(['Rate', `${(sr / 1000).toFixed(sr % 1000 ? 1 : 0)} kHz`]);
    const bits = info ? info.bits : r.bits;
    const codec = info ? info.codec : r.codec;
    rows.push(['Depth', bits ? `${bits}-bit ${codec === 'float' ? 'float' : 'PCM'}` : it.ext.toUpperCase()]);
    rows.push(['Length', fmtTime(info ? info.frames / info.sr : r.dur, true)]);
    if (info && info.mask) rows.push(['Mask', '0x' + info.mask.toString(16).toUpperCase()]);
    if (L && L.chans.length && !L.ambi) rows.push(['Order', L.chans.map(c => c.role === c.label ? c.role : c.label).join(' ')]);
  }
  if (!it.zip) rows.push(['Category', TYPE_LABELS[it.type] + ({ you: ' · set by you', name: ' · from name', audio: ' · from audio' }[it.typeSrc] || '')]);
  rows.push(['Size', fmtBytes(r.size)]);
  rows.push(['Folder', `${it.lib.name}${it.folder ? ' / ' + it.folder : ''}`]);
  el.innerHTML = `<div class="fname">${escapeHtml(it.name)}.${escapeHtml(it.ext)}</div>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${escapeHtml(v)}</dd>`).join('')}</dl>
    ${r.desc ? `<div class="desc">${escapeHtml(r.desc)}</div>` : ''}`;
}

function fillLayoutSelect() {
  const sel = $('#layout-sel');
  const L = S.layout;
  sel.innerHTML = '';
  sel.disabled = !L;
  if (!L) return;
  const ov = S.current && S.overrides[S.current.path];
  const auto = document.createElement('option');
  auto.value = '';
  auto.textContent = `Auto (${L.label}${L.ambi ? (L.ambi.fuma ? ' FuMa' : ' AmbiX') : ''})`;
  if (ov) auto.textContent = 'Auto';
  sel.appendChild(auto);
  for (const c of layoutChoices(L.ch)) {
    const o = document.createElement('option');
    o.value = c.id;
    o.textContent = c.label;
    sel.appendChild(o);
  }
  sel.value = ov || '';
}

$('#layout-sel').addEventListener('change', async e => {
  const it = S.current;
  if (!it || it.zip) return;
  const id = e.target.value;
  if (id) S.overrides[it.path] = id; else delete S.overrides[it.path];
  api.setOverride(it.path, id || null);
  assignLayout(it);
  let layout = it.layout;
  if (S.info && S.info.ch !== layout.ch) layout = detectLayout({ ...it.rec, ch: S.info.ch }, { path: it.rec.rel, override: id, fourCh: it.lib.fourCh });
  S.layout = layout;
  wave.setLayout(layout);
  speakers.setLayout(layout);
  engine.setLayout(layout);
  fillLayoutSelect();
  renderMeta();
  list.refresh();
});

// ------------------------------------------------------------------ transport controls
const vol = $('#volume');
function setVolume(db, save = true) {
  db = Math.max(-60, Math.min(12, Math.round(db * 2) / 2));
  prefs.volume = db;
  vol.value = db;
  vol.style.setProperty('--fill', `${((db + 60) / 72) * 100}%`);
  $('#vol-db').textContent = db <= -60 ? '−∞ dB' : `${db > 0 ? '+' : ''}${db.toFixed(1)} dB`;
  $('#vol-db').classList.toggle('hot', db > 0);
  $('#vol-waves').style.opacity = db <= -60 ? 0.15 : db < -30 ? 0.5 : 1;
  engine.setVolume(db);
  if (save) savePrefs();
}
vol.addEventListener('input', () => setVolume(Number(vol.value)));
vol.addEventListener('dblclick', () => setVolume(0));
vol.addEventListener('wheel', e => { e.preventDefault(); setVolume(prefs.volume + (e.deltaY < 0 ? 1 : -1)); }, { passive: false });

function setToggle(id, on) { $(id).classList.toggle('on', on); }
$('#btn-play').addEventListener('click', togglePlay);
$('#btn-loop').addEventListener('click', () => { prefs.loop = !prefs.loop; setToggle('#btn-loop', prefs.loop); engine.setLoop(prefs.loop); savePrefs(); });
$('#btn-auto').addEventListener('click', () => { prefs.autoplay = !prefs.autoplay; setToggle('#btn-auto', prefs.autoplay); savePrefs(); });
$('#btn-folders').addEventListener('click', () => {
  prefs.showFolders = !prefs.showFolders;
  setToggle('#btn-folders', prefs.showFolders);
  savePrefs();
  applyFilters();
});
$('#btn-lfe').addEventListener('click', () => { prefs.lfe = !prefs.lfe; setToggle('#btn-lfe', prefs.lfe); engine.setLfe(prefs.lfe); savePrefs(); });
$('#monitor').addEventListener('change', e => { prefs.monitor = e.target.value; engine.setMode(prefs.monitor); savePrefs(); updateMonitorHint(); });
$('#btn-reveal').addEventListener('click', () => S.current && api.reveal(S.current.path));
$('#drag-handle').addEventListener('dragstart', e => {
  e.preventDefault();
  if (!S.current || S.current.zip) return;
  const pcm = S.info && (S.info.codec === 'pcm' || S.info.codec === 'float');
  api.startDrag(S.current.path, S.selection && pcm ? S.selection : null);
});

function updateMonitorHint() {
  const o = $('#monitor').querySelector('[value="discrete"]');
  o.textContent = `Discrete outputs (${engine.deviceChannels} ch device)`;
}

// ------------------------------------------------------------------ list interactions
const listEl = $('#list');
listEl.addEventListener('mousedown', e => {
  const i = list.indexFromEvent(e);
  if (i < 0) return;
  if (e.target.classList.contains('star')) return;
  if (e.button === 0) selectIndex(i, { play: false }); // a click only selects; double-click plays
});
listEl.addEventListener('click', e => {
  if (!e.target.classList.contains('star')) return;
  const i = list.indexFromEvent(e);
  if (i >= 0 && !S.view[i].isFolder) toggleFavorite(S.view[i]);
});
listEl.addEventListener('dblclick', e => {
  const i = list.indexFromEvent(e);
  if (i < 0) return;
  const it = S.view[i];
  if (it.isFolder) openFolder(it.lib, it.prefix);
  else if (!it.zip) {
    S.selection = null;
    wave.setSelection(null);
    // Play from the top; if the file is still loading, play as soon as it's ready.
    if (S.current === it && S.source) startPlay(0);
    else { S.playOnLoad = it; if (S.current !== it) selectIndex(i, { play: false }); }
  }
});
listEl.addEventListener('dragstart', e => {
  const i = list.indexFromEvent(e);
  e.preventDefault();
  if (i >= 0 && !S.view[i].zip && !S.view[i].isFolder) api.startDrag(S.view[i].path, null);
});
listEl.addEventListener('contextmenu', async e => {
  e.preventDefault();
  const i = list.indexFromEvent(e);
  if (i < 0) return;
  const it = S.view[i];
  if (it.isFolder) {
    list.select(i, false);
    const pick = await api.menu([{ id: 'open', label: 'Open' }, { id: 'reveal', label: 'Show in Explorer' }, { id: 'copy', label: 'Copy path' }]);
    if (pick === 'open') openFolder(it.lib, it.prefix);
    else if (pick === 'reveal') api.reveal(it.path);
    else if (pick === 'copy') { api.copyText(it.path); toast('Path copied'); }
    return;
  }
  if (S.current !== it) selectIndex(i, { play: false });
  const fav = S.favorites.has(it.path);
  const items = it.zip
    ? [{ id: 'x-folder', label: `Extract to “${it.name}”` }, { id: 'x-here', label: 'Extract here' }, { type: 'separator' }]
    : [{ id: 'play', label: 'Play' }, { id: 'fav', label: fav ? 'Remove from favorites' : 'Add to favorites' }, { type: 'separator' }];
  items.push({ id: 'reveal', label: 'Show in Explorer' }, { id: 'copy', label: 'Copy path' });
  if (!it.zip) {
    items.push({ type: 'separator' });
    // Category submenu, split alphabetically so it fits on screen.
    const groups = [['A–C', /^[a-c]/i], ['D–F', /^[d-f]/i], ['G–L', /^[g-l]/i], ['M–R', /^[m-r]/i], ['S–Z', /^[s-z]/i]];
    const opt = ty => ({ id: 'type:' + ty, label: `${it.type === ty ? '✓  ' : ''}${TYPE_LABELS[ty]}` });
    const sub = groups.map(([label, re]) => ({ label, submenu: TYPES.filter(ty => re.test(TYPE_LABELS[ty])).map(opt) }));
    if (it.typeSrc === 'you') sub.push({ type: 'separator' }, { id: 'type:', label: 'Automatic (undo my choice)' });
    items.push({ label: `Category: ${TYPE_LABELS[it.type]}`, submenu: sub });
  }
  const dupInfo = S.dupes && S.dupes.byPath.get(it.path);
  items.push({ type: 'separator' });
  if (dupInfo) items.push({ id: 'keep', label: `Keep this one, recycle the other ${dupInfo.n - 1} cop${dupInfo.n === 2 ? 'y' : 'ies'}` });
  if (!it.zip) {
    // Duplicate-search exclusions for this sound's folder (or a parent).
    items.push({ type: 'separator' });
    const chain = folderChain(it);
    const cover = excludingFolder(it.path);
    if (cover) {
      items.push({ id: 'dupinc:' + cover, label: cover === chain[0].dir ? 'Re-include this sound’s folder in duplicates' : `Re-include “${prettyDir(cover)}” in duplicates` });
    } else {
      items.push({ id: 'dupx:' + chain[0].dir, label: 'Exclude contents of this sound’s folder from duplicates' });
      if (chain.length > 1) items.push({ label: 'Exclude a parent folder from duplicates', submenu: chain.slice(1).map(c => ({ id: 'dupx:' + c.dir, label: c.label })) });
    }
    if (S.scope.type === 'dups' && prefs.dupExclude.length) {
      items.push({
        label: `Excluded folders (${prefs.dupExclude.length})`,
        submenu: [
          { id: '', label: 'Click one to re-include it', enabled: false }, { type: 'separator' },
          ...prefs.dupExclude.map(f => ({ id: 'dupinc:' + f, label: prettyDir(f) })),
          { type: 'separator' }, { id: 'dupincall', label: 'Re-include all' },
        ],
      });
    }
  }
  items.push({ type: 'separator' }, { id: 'trash', label: 'Move to Recycle Bin' });
  const pick = await api.menu(items);
  if (pick && pick.startsWith('dupx:')) { setDupExcluded(pick.slice(5), true); return; }
  if (pick && pick.startsWith('dupinc:')) { setDupExcluded(pick.slice(7), false); return; }
  if (pick === 'dupincall') { includeAllDupFolders(); return; }
  if (pick && pick.startsWith('type:')) {
    const ty = pick.slice(5) || null;
    if (ty) S.typeOverrides[it.path] = ty; else delete S.typeOverrides[it.path];
    api.setType([it.path], ty);
    assignType(it);
    renderMeta();
    if (S.types.size) applyFilters({ keepScroll: true }); else { list.refresh(); refreshTypeCounts(); }
    return;
  }
  if (pick === 'keep') {
    const others = S.dupes.groups[dupInfo.g].paths.filter(p => p !== it.path);
    recycle(others, `Keeping: ${it.path}`);
    return;
  }
  if (pick === 'trash') { recycle([it.path]); return; }
  if (pick === 'x-folder') extract(it, 'folder');
  else if (pick === 'x-here') extract(it, 'here');
  else if (pick === 'play') { S.selection = null; wave.setSelection(null); startPlay(0); }
  else if (pick === 'fav') toggleFavorite(it);
  else if (pick === 'reveal') api.reveal(it.path);
  else if (pick === 'copy') { api.copyText(it.path); toast('Path copied'); }
});
// ------------------------------------------------------------------ duplicates
// Two ways to look: 'audio' (identical audio data, checked on disk in the
// background) or 'name' (same file name, ignoring case and extension; instant).
function showDupChooser() {
  S.dupChooser = true;
  applyFilters();
}

async function findDupes(mode) {
  S.dupChooser = false;
  S.dupMode = mode;
  if (mode === 'name') {
    setDupes(nameGroups(), 'name');
    applyFilters();
    return;
  }
  if (S.dupProgress) return;
  S.dupes = null;
  S.dupesRaw = null;
  S.dupProgress ={ stage: 'Looking for duplicates', done: 0, total: 0 };
  renderScanStatus();
  applyFilters();
  try {
    const groups = await api.findDupes();
    if (groups && S.dupMode === 'audio') setDupes(groups, 'audio');
  } catch (err) {
    toast(`Duplicate search failed: ${err.message || err}`, 5000);
  } finally {
    S.dupProgress = null;
    renderScanStatus();
    if (S.scope.type === 'dups') applyFilters();
  }
}

function nameKey(it) {
  return it.name.trim().toLowerCase();
}

function nameGroups() {
  const m = new Map();
  for (const it of S.items) {
    if (it.zip) continue;
    const k = nameKey(it);
    let g = m.get(k);
    if (!g) m.set(k, (g = []));
    g.push(it);
  }
  return [...m.values()]
    .filter(g => g.length > 1)
    .map(g => {
      const sizes = g.map(it => it.rec.size || 0).sort((a, b) => b - a);
      return { paths: g.map(it => it.path), size: sizes[0], wasted: sizes.slice(1).reduce((s, x) => s + x, 0), name: g[0].name };
    })
    .sort((a, b) => b.paths.length - a.paths.length || collator.compare(a.name, b.name));
}

// Raw search results are kept in S.dupesRaw; S.dupes is what's shown after
// leaving out excluded folders, so exclusions apply without searching again.
function setDupes(groups, mode, stale = false) {
  S.dupesRaw = { groups, mode, stale };
  buildDupes();
}

function buildDupes() {
  const raw = S.dupesRaw;
  if (!raw) { S.dupes = null; return; }
  const byPath = new Map();
  const groups = raw.groups
    .map(g => {
      const paths = g.paths.filter(p => !isDupExcluded(p));
      return paths.length === g.paths.length ? g : { ...g, paths, wasted: g.size * Math.max(0, paths.length - 1) };
    })
    .filter(g => g.paths.length > 1);
  groups.forEach((grp, g) => {
    // First row of each group is the first in the sorted (path) order.
    [...grp.paths].sort(collator.compare).forEach((p, k) => byPath.set(p, { g, n: grp.paths.length, first: k === 0 }));
  });
  S.dupes = { groups, byPath, stale: raw.stale, mode: raw.mode };
  $('#n-dup').textContent = groups.length ? groups.length.toLocaleString() : '';
}

// Bring the duplicate groups up to date after files were added or removed.
function pruneDupes() {
  const raw = S.dupesRaw;
  if (!raw) return;
  if (raw.mode === 'name') { setDupes(nameGroups(), 'name'); return; }
  const live = new Set(S.items.map(it => it.path));
  const groups = raw.groups
    .map(g => ({ ...g, paths: g.paths.filter(p => live.has(p)) }))
    .map(g => ({ ...g, wasted: g.size * Math.max(0, g.paths.length - 1) }));
  setDupes(groups, 'audio', raw.stale);
}

// ------------------------------------------------------------------ duplicate exclusions
// Folders (absolute paths) whose files are ignored by both duplicate searches.
prefs.dupExclude = Array.isArray(prefs.dupExclude) ? prefs.dupExclude : [];

function folderPath(lib, prefix) {
  if (!prefix) return lib.path;
  const base = lib.path.endsWith(S.sep) ? lib.path : lib.path + S.sep;
  return base + prefix.split('/').join(S.sep);
}

function isDupExcluded(path) {
  if (!prefs.dupExclude.length) return false;
  const p = path.toLowerCase();
  return prefs.dupExclude.some(f => { const d = f.toLowerCase(); return p.startsWith(d.endsWith(S.sep) ? d : d + S.sep); });
}

function setDupExcluded(folder, on) {
  const low = folder.toLowerCase();
  prefs.dupExclude = prefs.dupExclude.filter(f => f.toLowerCase() !== low);
  if (on) prefs.dupExclude.push(folder);
  savePrefs();
  buildDupes();
  renderTree();
  applyFilters({ keepScroll: true });
  const name = folder.split(S.sep).filter(Boolean).pop() || folder;
  toast(on ? `“${name}” is now left out of duplicate searches` : `“${name}” is included in duplicate searches again`);
}

// Every listed copy except the first one shown in each group.
function extraCopies() {
  if (S.scope.type !== 'dups' || !S.dupes) return [];
  const seen = new Set(), extra = [];
  for (const it of S.view) {
    const d = S.dupes.byPath.get(it.path);
    if (!d) continue;
    if (seen.has(d.g)) extra.push(it); else seen.add(d.g);
  }
  return extra;
}

async function recycleExtraCopies() {
  const extra = extraCopies();
  if (!extra.length) return;
  const groups = new Set(extra.map(it => S.dupes.byPath.get(it.path).g)).size;
  const bytes = extra.reduce((s, it) => s + (it.rec.size || 0), 0);
  let detail = `Keeping the first sound listed in each of ${groups.toLocaleString()} duplicate group${groups === 1 ? '' : 's'}; ${fmtBytes(bytes)} will be freed.`;
  if (prefs.dupExclude.length) detail += `\nFiles in the ${prefs.dupExclude.length} excluded folder${prefs.dupExclude.length === 1 ? '' : 's'} are not touched.`;
  if (S.dupes.mode === 'name') detail += '\n\n⚠ These were matched by NAME only. Same-named files can be different sounds.';
  detail += '\nYou can restore them from the Recycle Bin.';
  await recycle(extra.map(it => it.path), detail);
}

api.on('trash:progress', p => {
  S.trashProgress = p.finished ? null : p;
  renderScanStatus();
});

function includeAllDupFolders() {
  prefs.dupExclude = [];
  savePrefs();
  buildDupes();
  renderTree();
  applyFilters({ keepScroll: true });
  toast('All folders are included in duplicate searches again');
}

// The excluded folder that covers this path (itself or a parent), if any.
function excludingFolder(path) {
  const p = path.toLowerCase();
  return prefs.dupExclude.find(f => { const d = f.toLowerCase(); return p.startsWith(d.endsWith(S.sep) ? d : d + S.sep); }) || null;
}

// A sound's folder and its parents up to the library root: [{ dir, label }].
function folderChain(it) {
  const out = [];
  const parts = it.folder ? it.folder.split('/') : [];
  for (let n = parts.length; n >= 0; n--) {
    const prefix = parts.slice(0, n).join('/');
    out.push({ dir: folderPath(it.lib, prefix), label: n ? `${parts[n - 1]}${n > 1 ? '  (' + parts.slice(0, n - 1).join(' / ') + ')' : ''}` : `${it.lib.name} (whole library)` });
  }
  return out;
}

// "Library / sub / folder" for an absolute folder path.
function prettyDir(dir) {
  const low = dir.toLowerCase();
  for (const lib of S.libs) {
    const root = lib.path.toLowerCase();
    if (low === root) return lib.name;
    const base = root.endsWith(S.sep) ? root : root + S.sep;
    if (low.startsWith(base)) return `${lib.name} / ${dir.slice(base.length).split(S.sep).join(' / ')}`;
  }
  return dir;
}

// Chips listing excluded folders under the duplicates banner; ✕ re-includes.
function renderDupExcluded(show) {
  const el = $('#dup-excluded');
  if (!show || !prefs.dupExclude.length) { el.hidden = true; return; }
  el.hidden = false;
  el.replaceChildren();
  const lbl = document.createElement('span');
  lbl.className = 'xlbl';
  lbl.textContent = 'Left out of duplicates:';
  el.appendChild(lbl);
  for (const f of prefs.dupExclude) {
    const chip = document.createElement('span');
    chip.className = 'xchip';
    chip.title = f;
    chip.innerHTML = `<span class="ic">⊘</span>${escapeHtml(prettyDir(f))}<button title="Re-include this folder">✕</button>`;
    chip.querySelector('button').addEventListener('click', () => setDupExcluded(f, false));
    el.appendChild(chip);
  }
  if (prefs.dupExclude.length > 1) {
    const all = document.createElement('button');
    all.className = 'xall';
    all.textContent = 'Re-include all';
    all.addEventListener('click', includeAllDupFolders);
    el.appendChild(all);
  }
}

function renderDupBanner() {
  const b = $('#dup-banner');
  const chooser = $('#dup-chooser');
  const inDups = S.scope.type === 'dups';
  chooser.hidden = !(inDups && S.dupChooser);
  renderDupExcluded(inDups && !S.dupChooser);
  if (!inDups || S.dupChooser) { b.hidden = true; return; }
  b.hidden = false;
  if (S.dupProgress) { b.innerHTML = '<span>Comparing audio content across your libraries…</span>'; return; }
  if (!S.dupes) { b.innerHTML = ''; return; }
  const { groups: g, mode } = S.dupes;
  const wasted = g.reduce((s, x) => s + x.wasted, 0);
  const extra = extraCopies();
  const bulk = extra.length
    ? `<button id="dup-bulk" class="danger" title="For every group listed, keep the first sound and move the other copies to the Recycle Bin">Recycle extra copies (${extra.length.toLocaleString()} · ${fmtBytes(extra.reduce((s, it) => s + (it.rec.size || 0), 0))})</button>`
    : '';
  const again = bulk + '<button id="dup-again">Check again</button><button id="dup-new">New search…</button>';
  if (!g.length) {
    b.innerHTML = `<span>${mode === 'name' ? 'No duplicate file names found.' : 'No duplicate audio found.'}</span>${again}`;
  } else if (mode === 'name') {
    b.innerHTML = `<span><b>${g.length.toLocaleString()}</b> file name${g.length === 1 ? '' : 's'} used more than once</span>
      <span class="warn">Same name doesn’t always mean same sound: listen before recycling.</span>${again}`;
  } else {
    b.innerHTML = `<span><b>${g.length.toLocaleString()}</b> sound${g.length === 1 ? '' : 's'} with identical copies · <b>${fmtBytes(wasted)}</b> could be freed${S.dupes.stale ? ' · libraries changed since this check' : ''}</span>
      <span>Right-click a file → <i>Keep this one</i> to recycle its other copies.</span>${again}`;
  }
  b.querySelector('#dup-again').addEventListener('click', () => findDupes(mode));
  const bb = b.querySelector('#dup-bulk');
  if (bb) bb.addEventListener('click', recycleExtraCopies);
  b.querySelector('#dup-new').addEventListener('click', showDupChooser);
}

$('#dup-chooser').addEventListener('click', e => {
  const opt = e.target.closest('[data-mode]');
  if (opt) findDupes(opt.dataset.mode);
});


async function recycle(paths, detail) {
  const playingGone = S.current && paths.includes(S.current.path);
  if (playingGone) engine.stop();
  const done = await api.trash(paths, detail);
  if (!done.length) return;
  const gone = new Set(done);
  S.items = S.items.filter(it => !gone.has(it.path));
  for (const p of done) S.favorites.delete(p);
  if (S.current && gone.has(S.current.path)) {
    S.current = null;
    S.source = null;
    S.layout = null;
    wave.clear('Moved to the Recycle Bin');
    speakers.setLayout(null);
    fillLayoutSelect();
    renderMeta();
  }
  pruneDupes();
  applyFilters({ keepScroll: true });
  toast(`Moved ${done.length} file${done.length === 1 ? '' : 's'} to the Recycle Bin`);
}

function toggleFavorite(it) {
  if (!it || it.zip) return;
  const on = !S.favorites.has(it.path);
  if (on) S.favorites.add(it.path); else S.favorites.delete(it.path);
  api.setFavorite(it.path, on);
  $('#n-fav').textContent = S.favorites.size ? S.favorites.size.toLocaleString() : '';
  if (S.scope.type === 'fav') applyFilters({ keepScroll: true }); else list.refresh();
}

document.querySelectorAll('#list-header [data-sort]').forEach(h => h.addEventListener('click', () => {
  const k = h.dataset.sort;
  prefs.sort = { key: k, dir: prefs.sort.key === k ? -prefs.sort.dir : 1 };
  savePrefs();
  applyFilters({ keepScroll: false });
  if (S.current) { const i = S.view.indexOf(S.current); if (i >= 0) list.select(i, true); }
}));

// ------------------------------------------------------------------ resizable columns
// Like Explorer: drag a header divider to resize (columns to the right shift
// over, the list scrolls sideways if needed), double-click it to fit.
const COLS = [
  { key: 'fav', w: 30, fixed: true },
  { key: 'name', w: 320, min: 120 },
  { key: 'fmt', w: 78, min: 56 },
  { key: 'type', w: 120, min: 60 },
  { key: 'ch', w: 44, min: 34 },
  { key: 'dur', w: 74, min: 50 },
  { key: 'sr', w: 62, min: 44 },
  { key: 'bits', w: 48, min: 38 },
  { key: 'desc', w: 360, min: 80 },
  { key: 'lib', w: 260, min: 80 },
];
prefs.cols = Object.assign({}, prefs.cols);
const colWidth = c => (c.fixed ? c.w : Math.max(c.min, prefs.cols[c.key] || c.w));

function applyCols() {
  const widths = COLS.map(colWidth);
  const center = $('#center');
  center.style.setProperty('--cols', widths.map(w => w + 'px').join(' '));
  center.style.setProperty('--row-w', widths.reduce((a, b) => a + b, 0) + 8 + 'px');
}

// Text each column shows for an item, for "size to fit".
const colText = {
  name: it => `${it.name}.${it.ext}`,
  fmt: it => it.fmtLabel,
  type: it => (it.zip ? '' : TYPE_LABELS[it.type]),
  ch: it => String(it.rec.ch || ''),
  dur: it => (it.zip ? `${it.rec.zip} files` : it.rec.dur ? fmtTime(it.rec.dur) : ''),
  sr: it => (it.rec.sr ? (it.rec.sr / 1000).toFixed(it.rec.sr % 1000 ? 1 : 0) + 'k' : ''),
  bits: it => String(it.rec.bits || ''),
  desc: it => it.rec.desc || '',
  lib: it => (it.folder ? `${it.lib.name} / ${it.folder}` : it.lib.name),
};
const colExtra = { fmt: 18, type: 16 }; // badge padding / colour dot
const measureCtx = document.createElement('canvas').getContext('2d');

function fitWidth(c) {
  const family = getComputedStyle(document.body).fontFamily;
  const headerEl = $(`#list-header .c-${c.key}`);
  measureCtx.font = `600 11px ${family}`;
  let best = headerEl ? measureCtx.measureText(headerEl.textContent.toUpperCase()).width * 1.08 + 22 : 0;
  measureCtx.font = `${c.key === 'name' ? '500 ' : ''}${c.key === 'lib' ? 12 : c.key === 'fmt' ? 11 : 13}px ${family}`;
  const items = S.view.length > 40000 ? S.view.slice(0, 40000) : S.view;
  const seen = new Set();
  for (const it of items) {
    const t = it.isFolder ? (c.key === 'name' ? it.name + 'xxx' : '') : colText[c.key](it);
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const wpx = measureCtx.measureText(t).width;
    if (wpx > best) best = wpx;
  }
  return Math.min(1200, Math.ceil(best + 16 + (colExtra[c.key] || 0)));
}

function setColWidth(c, w, save = true) {
  prefs.cols[c.key] = Math.max(c.min, Math.round(w));
  applyCols();
  if (save) savePrefs();
}

(() => {
  const header = $('#list-header');
  const cells = [...header.children];
  COLS.forEach((c, i) => {
    if (c.fixed) return;
    const h = document.createElement('span');
    h.className = 'col-resize';
    h.title = 'Drag to resize · Double-click to fit';
    cells[i].appendChild(h);
    h.addEventListener('click', e => e.stopPropagation());
    h.addEventListener('dblclick', e => { e.stopPropagation(); setColWidth(c, fitWidth(c)); });
    h.addEventListener('mousedown', e => {
      if (e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const x0 = e.clientX, w0 = colWidth(c);
      h.classList.add('drag');
      document.body.classList.add('col-resizing');
      const move = ev => setColWidth(c, w0 + ev.clientX - x0, false);
      const up = () => {
        h.classList.remove('drag');
        document.body.classList.remove('col-resizing');
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
        savePrefs();
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  });

  header.addEventListener('contextmenu', async e => {
    e.preventDefault();
    const i = cells.findIndex(cell => cell.contains(e.target));
    const c = COLS[i];
    const items = [];
    if (c && !c.fixed) items.push({ id: 'fit', label: 'Size column to fit' });
    items.push({ id: 'fitall', label: 'Size all columns to fit' }, { type: 'separator' }, { id: 'reset', label: 'Reset column widths' });
    const pick = await api.menu(items);
    if (pick === 'fit') setColWidth(c, fitWidth(c));
    else if (pick === 'fitall') { for (const col of COLS) if (!col.fixed) prefs.cols[col.key] = Math.max(col.min, fitWidth(col)); applyCols(); savePrefs(); }
    else if (pick === 'reset') { prefs.cols = {}; applyCols(); savePrefs(); }
  });

  // Keep the header lined up with the list when it scrolls sideways.
  const listBox = $('#list');
  listBox.addEventListener('scroll', () => { header.style.transform = `translateX(${-listBox.scrollLeft}px)`; }, { passive: true });
  applyCols();
})();

// ------------------------------------------------------------------ search + filters
let searchTimer = 0;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { S.query = e.target.value.trim(); applyFilters(); }, 70);
});
// "Sound Type" multi-select dropdown (Mono / Stereo / Surround / …).
(() => {
  const btn = $('#dd-type-btn'), menu = $('#dd-type-menu');
  const boxes = [...menu.querySelectorAll('input[type=checkbox]')];
  const names = Object.fromEntries(boxes.map(b => [b.value, b.nextElementSibling.textContent]));
  const sync = () => {
    boxes.forEach(b => { b.checked = S.classes.has(b.value); });
    const sel = boxes.filter(b => b.checked).map(b => names[b.value]);
    btn.querySelector('.dd-label').textContent = !sel.length ? 'Sound Type' : sel.length === 1 ? `Sound Type: ${sel[0]}` : `Sound Type: ${sel.length} selected`;
    btn.classList.toggle('on', sel.length > 0);
    btn.title = sel.length ? `Showing: ${sel.join(', ')}` : 'Filter by channel format (pick any number)';
  };
  const open = on => {
    menu.hidden = !on;
    btn.setAttribute('aria-expanded', String(on));
    btn.classList.toggle('open', on);
  };
  btn.addEventListener('click', () => open(menu.hidden));
  menu.addEventListener('change', e => {
    const b = e.target;
    if (b.checked) S.classes.add(b.value); else S.classes.delete(b.value);
    sync();
    applyFilters();
  });
  menu.addEventListener('click', e => {
    const act = e.target.dataset && e.target.dataset.act;
    if (!act) return;
    S.classes.clear();
    if (act === 'all') boxes.forEach(b => S.classes.add(b.value));
    sync();
    applyFilters();
  });
  document.addEventListener('mousedown', e => { if (!menu.hidden && !$('#dd-type').contains(e.target)) open(false); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !menu.hidden) { e.stopPropagation(); open(false); btn.focus(); } }, true);
  sync();
})();
$('#f-sr').addEventListener('change', e => { S.sr = e.target.value; applyFilters(); });
// Length filter: presets are "min-max" in seconds; "custom" shows from/to boxes.
// Accepts 90, 90s, 1:30, 1:02:00, 10m, 1.5m, 2h. Empty = no limit.
function parseLength(text) {
  const t = String(text).trim().toLowerCase();
  if (!t) return null;
  if (/^\d+(:\d{1,2}){1,2}(\.\d+)?$/.test(t)) return t.split(':').reduce((acc, p) => acc * 60 + Number(p), 0);
  const m = t.match(/^(\d+(?:\.\d+)?)\s*(h|hr|hrs|hours?|m|min|mins|minutes?|s|sec|secs|seconds?)?$/);
  if (!m) return NaN;
  const n = Number(m[1]), u = (m[2] || 's')[0];
  return u === 'h' ? n * 3600 : u === 'm' ? n * 60 : n;
}
function applyCustomLength() {
  const minEl = $('#dur-min'), maxEl = $('#dur-max');
  const a = parseLength(minEl.value), b = parseLength(maxEl.value);
  minEl.classList.toggle('bad', Number.isNaN(a));
  maxEl.classList.toggle('bad', Number.isNaN(b));
  if (Number.isNaN(a) || Number.isNaN(b)) return;
  S.dur = a == null && b == null ? '' : `${a ?? 0}-${b ?? ''}`;
  applyFilters();
}
$('#f-dur').addEventListener('change', e => {
  const custom = e.target.value === 'custom';
  $('#dur-custom').hidden = !custom;
  if (custom) { applyCustomLength(); $('#dur-min').focus(); return; }
  S.dur = e.target.value;
  applyFilters();
});
let durTimer = 0;
for (const id of ['#dur-min', '#dur-max']) {
  $(id).addEventListener('input', () => { clearTimeout(durTimer); durTimer = setTimeout(applyCustomLength, 250); });
  $(id).addEventListener('keydown', e => { if (e.key === 'Enter') { clearTimeout(durTimer); applyCustomLength(); e.target.blur(); } });
}

// ------------------------------------------------------------------ sidebar tree
function buildTree(recs) {
  const root = { name: '', path: '', children: new Map(), count: 0 };
  for (const r of recs) {
    root.count++;
    const slash = r.rel.lastIndexOf('/');
    if (slash < 0) continue;
    let node = root, acc = '';
    for (const part of r.rel.slice(0, slash).split('/')) {
      acc = acc ? acc + '/' + part : part;
      let n = node.children.get(part);
      if (!n) { n = { name: part, path: acc, children: new Map(), count: 0 }; node.children.set(part, n); }
      n.count++;
      node = n;
    }
  }
  return root;
}

function renderTree() {
  const el = $('#lib-tree');
  const frag = document.createDocumentFragment();
  const sc = S.scope;
  const row = (cls, depth, label, count, key, scope, hasKids, extra = '') => {
    const d = document.createElement('div');
    d.className = 'tree-row ' + cls;
    d.style.paddingLeft = 8 + depth * 14 + 'px';
    const open = S.expanded.has(key);
    d.innerHTML = `<span class="tw ${hasKids ? '' : 'leaf'}">${open ? '▾' : '▸'}</span><span class="lbl">${escapeHtml(label)}</span>${extra}<span class="num">${count ? count.toLocaleString() : ''}</span>`;
    d.dataset.key = key;
    d._scope = scope;
    if (sc.type === 'folder' && sc.lib === scope.lib && sc.prefix === scope.prefix) d.classList.add('active');
    frag.appendChild(d);
    return open;
  };
  // ⊘ marks folders left out of duplicate searches (dimmed when inherited from a parent).
  const exclMark = (lib, prefix) => {
    const dir = folderPath(lib, prefix);
    if (prefs.dupExclude.some(f => f.toLowerCase() === dir.toLowerCase())) return '<span class="excl" title="Excluded from duplicate searches">⊘</span>';
    if (isDupExcluded(dir + S.sep + 'x')) return '<span class="excl inherited" title="Inside an excluded folder">⊘</span>';
    return '';
  };
  const walk = (lib, node, depth) => {
    const kids = [...node.children.values()].sort((a, b) => collator.compare(a.name, b.name));
    for (const k of kids) {
      const key = lib.id + ':' + k.path;
      if (row('', depth, k.name, k.count, key, { type: 'folder', lib: lib.id, prefix: k.path }, k.children.size > 0, exclMark(lib, k.path))) walk(lib, k, depth + 1);
    }
  };
  for (const lib of S.libs) {
    const tree = S.trees.get(lib.id) || { children: new Map(), count: 0 };
    const scanning = S.scans.has(lib.id);
    const extra = exclMark(lib, '') + (scanning ? '<span class="spin" title="Scanning"></span>' : '') + (lib.offline ? '<span class="badge-off" title="Folder not reachable">offline</span>' : '');
    const key = lib.id + ':';
    const open = row('lib' + (lib.offline ? ' offline' : ''), 0, lib.name, tree.count, key, { type: 'folder', lib: lib.id, prefix: '' }, tree.children.size > 0, extra);
    if (open) walk(lib, tree, 1);
  }
  el.replaceChildren(frag);
  document.querySelectorAll('.side-item[data-scope]').forEach(s => s.classList.toggle('active', s.dataset.scope === sc.type));
}

$('#lib-tree').addEventListener('click', e => {
  const r = e.target.closest('.tree-row');
  if (!r) return;
  if (e.target.classList.contains('tw')) {
    const k = r.dataset.key;
    if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k);
    prefs.expanded = [...S.expanded];
    savePrefs();
    renderTree();
    return;
  }
  S.scope = r._scope;
  renderTree();
  applyFilters();
});
$('#lib-tree').addEventListener('dblclick', e => {
  const r = e.target.closest('.tree-row');
  if (!r || e.target.classList.contains('tw')) return;
  const k = r.dataset.key;
  if (S.expanded.has(k)) S.expanded.delete(k); else S.expanded.add(k);
  renderTree();
});
$('#lib-tree').addEventListener('contextmenu', async e => {
  e.preventDefault();
  const r = e.target.closest('.tree-row');
  if (!r) return;
  const sc = r._scope;
  const lib = S.libs.find(l => l.id === sc.lib);
  if (!lib) return;
  const dir = folderPath(lib, sc.prefix);
  const items = [{ id: 'reveal', label: 'Show in Explorer' }, { type: 'separator' }];
  const exact = prefs.dupExclude.some(f => f.toLowerCase() === dir.toLowerCase());
  if (exact) items.push({ id: 'dupinc', label: 'Include in duplicate search' });
  else if (isDupExcluded(dir + S.sep + 'x')) items.push({ id: '', label: 'Excluded from duplicates (a parent folder is)', enabled: false });
  else items.push({ id: 'dupx', label: 'Exclude from duplicate search' });
  if (!sc.prefix) {
    const f = lib.fourCh || 'auto';
    const mark = v => (f === v ? '✓  ' : '     ');
    items.push(
      { id: 'rescan', label: 'Rescan library' },
      { type: 'separator' },
      { id: '4-auto', label: mark('auto') + '4-channel files: auto-detect' },
      { id: '4-quad', label: mark('quad') + '4-channel files: Quad' },
      { id: '4-ambix', label: mark('ambix') + '4-channel files: Ambisonic (AmbiX)' },
      { id: '4-fuma', label: mark('fuma') + '4-channel files: Ambisonic (FuMa)' },
      { type: 'separator' },
      { id: 'remove', label: 'Remove library (files are not touched)' },
    );
  }
  const pick = await api.menu(items);
  if (pick === 'reveal') api.reveal(dir);
  else if (pick === 'dupx') setDupExcluded(dir, true);
  else if (pick === 'dupinc') setDupExcluded(dir, false);
  else if (pick === 'rescan') api.rescan(lib.id);
  else if (pick && pick.startsWith('4-')) {
    const upd = await api.updateLibrary(lib.id, { fourCh: pick.slice(2) });
    if (upd) {
      lib.fourCh = upd.fourCh;
      for (const it of S.items) if (it.lib === lib) assignLayout(it);
      applyFilters({ keepScroll: true });
    }
  } else if (pick === 'remove') {
    await api.removeLibrary(lib.id);
    S.libs = S.libs.filter(l => l !== lib);
    delete S.recs[lib.id];
    S.trees.delete(lib.id);
    S.items = S.items.filter(it => it.lib !== lib);
    pruneDupes();
    if (S.scope.lib === lib.id) S.scope = { type: 'all' };
    if (S.current && S.current.lib === lib) { S.current = null; engine.stop(); wave.clear(); renderMeta(); }
    renderTree();
    applyFilters();
  }
});
$('#types').addEventListener('click', e => {
  const s = e.target.closest('.side-item');
  if (!s) return;
  const ty = s.dataset.type;
  if (ty === '__all') S.types.clear();
  else if (e.ctrlKey || e.shiftKey) { if (S.types.has(ty)) S.types.delete(ty); else S.types.add(ty); }
  else if (S.types.size === 1 && S.types.has(ty)) S.types.clear();
  else { S.types.clear(); S.types.add(ty); }
  applyFilters();
});
document.querySelectorAll('.side-item[data-scope]').forEach(s => s.addEventListener('click', () => {
  const type = s.dataset.scope;
  S.scope = { type };
  if (type === 'dups') S.dupChooser = true;
  renderTree();
  applyFilters();
}));

async function addLibrary() {
  const added = await api.addLibraries();
  if (!added.length) return;
  for (const l of added) { S.libs.push(l); S.recs[l.id] = []; S.trees.set(l.id, buildTree([])); }
  renderTree();
  applyFilters();
}
$('#add-lib').addEventListener('click', addLibrary);
$('#empty-add').addEventListener('click', addLibrary);

// ------------------------------------------------------------------ scanning events
api.on('dupes:progress', p => {
  if (!S.dupProgress) return;
  S.dupProgress = p;
  renderScanStatus();
});
api.on('scan:progress', p => {
  if (p.phase === 'end') { S.scans.delete(p.id); if (S.dupesRaw) S.dupesRaw.stale = true; if (S.dupes) S.dupes.stale = true; }
  else S.scans.set(p.id, p);
  renderScanStatus();
  if (p.phase === 'start' || p.phase === 'end') renderTree();
});
api.on('lib:updated', ({ lib, records }) => {
  let l = S.libs.find(x => x.id === lib.id);
  if (!l) return;
  Object.assign(l, lib);
  S.recs[lib.id] = records;
  S.trees.set(lib.id, buildTree(records));
  const curPath = S.current && S.current.path;
  S.items = S.items.filter(it => it.lib !== l).concat(records.map(r => makeItem(l, r)));
  if (curPath) {
    const again = S.items.find(it => it.path === curPath);
    if (again) S.current = again;
  }
  pruneDupes();
  renderTree();
  applyFilters({ keepScroll: true });
});
api.on('analysis:update', ({ id, map, done, total, finished }) => {
  const a = (S.analysis[id] ||= {});
  Object.assign(a, map);
  if (finished) S.analyzing.delete(id); else if (total) S.analyzing.set(id, { done, total });
  if (Object.keys(map).length || finished) {
    for (const it of S.items) if (it.lib.id === id) assignType(it);
    if (S.types.size) applyFilters({ keepScroll: true }); else { list.refresh(); refreshTypeCounts(); }
    if (S.current && S.current.lib.id === id) renderMeta();
  }
  renderScanStatus();
});
api.on('lib:status', lib => {
  const l = S.libs.find(x => x.id === lib.id);
  if (l) { Object.assign(l, lib); renderTree(); }
});

function renderScanStatus() {
  const el = $('#scan-status');
  const first = [...S.scans.values()][0];
  if (S.trashProgress) {
    const t = S.trashProgress;
    el.innerHTML = `Moving to Recycle Bin: ${t.done.toLocaleString()} / ${t.total.toLocaleString()}<div class="bar"><i style="width:${(t.done / t.total) * 100}%"></i></div>`;
    return;
  }
  if (!first && !S.dupProgress && S.analyzing.size) {
    const [id, a] = [...S.analyzing][0];
    const lib = S.libs.find(l => l.id === id);
    el.innerHTML = `Listening to sort ${lib ? escapeHtml(lib.name) : ''}: ${a.done.toLocaleString()} / ${a.total.toLocaleString()}<div class="bar"><i style="width:${a.total ? (a.done / a.total) * 100 : 0}%"></i></div>`;
    return;
  }
  if (!first && S.dupProgress) {
    const d = S.dupProgress;
    const pct = d.total ? (d.done / d.total) * 100 : 5;
    el.innerHTML = `${escapeHtml(d.stage)}…<div class="bar"><i style="width:${pct}%"></i></div>`;
    return;
  }
  if (!first) { el.innerHTML = ''; return; }
  const lib = S.libs.find(l => l.id === first.id);
  const name = lib ? escapeHtml(lib.name) : '';
  if (first.phase === 'probe' && first.total) {
    const pct = (first.done / first.total) * 100;
    el.innerHTML = `Indexing ${name}: ${first.done.toLocaleString()} / ${first.total.toLocaleString()}<div class="bar"><i style="width:${pct}%"></i></div>`;
  } else if (first.phase === 'walk') {
    el.innerHTML = `Scanning ${name}: ${first.done.toLocaleString()} audio files found<div class="bar"><i style="width:8%"></i></div>`;
  } else {
    el.innerHTML = `Checking ${name}…`;
  }
}

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', e => {
  const typing = !!(e.target.matches && e.target.matches('input[type=search], input[type=text]'));
  const k = e.key;
  if ((e.ctrlKey && k.toLowerCase() === 'f') || (k === '/' && !typing)) { e.preventDefault(); $('#search').focus(); $('#search').select(); return; }
  const cur = list.selected;
  const nav = d => { e.preventDefault(); selectIndex(Math.max(0, Math.min(S.view.length - 1, (cur < 0 ? (d > 0 ? -1 : S.view.length) : cur) + d))); };
  if (k === 'ArrowDown') return nav(1);
  if (k === 'ArrowUp') return nav(-1);
  if (k === 'PageDown') return nav(list.pageSize());
  if (k === 'PageUp') return nav(-list.pageSize());
  if (k === 'Enter') {
    e.preventDefault();
    if (typing) $('#search').blur();
    const row = S.view[cur];
    if (row && row.isFolder) openFolder(row.lib, row.prefix);
    else if (cur < 0 && S.view.length) selectIndex(0);
    else { S.selection = null; wave.setSelection(null); startPlay(0); }
    return;
  }
  if (k === 'Backspace' && !typing && browsing() && e.target.tagName !== 'SELECT') { e.preventDefault(); goUp(); return; }
  if (k === 'Escape') {
    if (typing && e.target.value) { e.target.value = ''; S.query = ''; applyFilters(); return; }
    if (S.selection) { S.selection = null; wave.setSelection(null); } else engine.stop();
    if (typing) e.target.blur();
    return;
  }
  if (typing || e.target.tagName === 'SELECT') return;
  if (k === ' ') { e.preventDefault(); togglePlay(); return; }
  if (k === 'Home') return nav(-S.view.length);
  if (k === 'End') return nav(S.view.length);
  if (k === 'ArrowRight' || k === 'ArrowLeft') {
    e.preventDefault();
    if (!S.source) return;
    const step = S.source.sr * (e.shiftKey ? 5 : 1) * (k === 'ArrowRight' ? 1 : -1);
    const p = Math.max(0, Math.min(S.source.frames - 1, (engine.playing ? engine.position() : S.cursor) + step));
    S.cursor = p;
    if (engine.playing) startPlay(p);
    return;
  }
  const lk = k.toLowerCase();
  if (lk === 'l') $('#btn-loop').click();
  else if (lk === 'a') $('#btn-auto').click();
  else if (lk === 'f') toggleFavorite(S.current);
  else if (lk === 'z') wave.fit();
  else if (lk === 'b') { $('#monitor').value = prefs.monitor === 'binaural' ? 'stereo' : 'binaural'; $('#monitor').dispatchEvent(new Event('change')); toast(`Monitor: ${$('#monitor').selectedOptions[0].textContent}`); }
  else if (k === '-' || k === '_') setVolume(prefs.volume - 1);
  else if (k === '=' || k === '+') setVolume(prefs.volume + 1);
  else if (/^[1-9]$/.test(k) && S.layout && Number(k) <= S.layout.ch) wave.soloOnly(Number(k) - 1);
  else if (k === '0' && S.layout) { wave.solo.length = 0; wave.mute.length = 0; wave.refreshMS(); engine.setMuteSolo([], []); speakers.setMuteSolo([], []); }
});

// ------------------------------------------------------------------ splitter
(() => {
  const sp = $('#splitter');
  const apply = h => {
    h = Math.max(200, Math.min(window.innerHeight - 220, h));
    prefs.playerH = h;
    document.documentElement.style.setProperty('--player-h', h + 'px');
  };
  apply(prefs.playerH);
  sp.addEventListener('mousedown', e => {
    e.preventDefault();
    sp.classList.add('drag');
    const move = ev => apply(window.innerHeight - ev.clientY - 2);
    const up = () => { sp.classList.remove('drag'); window.removeEventListener('mousemove', move); window.removeEventListener('mouseup', up); savePrefs(); };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
})();

// ------------------------------------------------------------------ sidebar sections
// Drag the bar above "Libraries" to give Categories more or less room;
// click a section header to collapse it.
(() => {
  const side = $('#sidebar'), types = $('#types'), split = $('#side-split');
  const DEFAULT_H = 220;
  const apply = () => {
    side.style.setProperty('--types-h', (prefs.typesH || DEFAULT_H) + 'px');
    side.classList.toggle('types-collapsed', !!prefs.typesCollapsed);
    side.classList.toggle('libs-collapsed', !!prefs.libsCollapsed);
  };
  const clampH = h => {
    const room = side.clientHeight - types.getBoundingClientRect().top + side.getBoundingClientRect().top - 140; // leave room for Libraries
    return Math.round(Math.max(40, Math.min(Math.max(40, room), h)));
  };
  split.addEventListener('mousedown', e => {
    if (e.button !== 0) return;
    e.preventDefault();
    const y0 = e.clientY, h0 = types.getBoundingClientRect().height;
    split.classList.add('drag');
    document.body.style.cursor = 'row-resize';
    const move = ev => { prefs.typesH = clampH(h0 + ev.clientY - y0); apply(); };
    const up = () => {
      split.classList.remove('drag');
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      savePrefs();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  });
  split.addEventListener('dblclick', () => { prefs.typesH = DEFAULT_H; apply(); savePrefs(); });
  $('#types-title').addEventListener('click', () => { prefs.typesCollapsed = !prefs.typesCollapsed; apply(); savePrefs(); });
  $('#libs-title').addEventListener('click', e => {
    if (e.target.closest('#add-lib')) return;
    prefs.libsCollapsed = !prefs.libsCollapsed;
    apply();
    savePrefs();
  });
  apply();
})();

// ------------------------------------------------------------------ toast
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ boot
async function boot() {
  setVolume(prefs.volume, false);
  setToggle('#btn-loop', prefs.loop);
  setToggle('#btn-auto', prefs.autoplay);
  setToggle('#btn-folders', !!prefs.showFolders);
  setToggle('#btn-lfe', prefs.lfe);
  $('#monitor').value = prefs.monitor;
  engine.mode = prefs.monitor;
  engine.lfe = prefs.lfe;
  engine.loop = prefs.loop;
  updateMonitorHint();
  wave.clear('Select a sound to see its waveform');
  fillLayoutSelect();

  const st = await api.getState();
  S.libs = st.libs;
  S.recs = st.records;
  S.sep = st.sep;
  S.favorites = new Set(st.favorites);
  S.overrides = st.overrides || {};
  S.analysis = st.analysis || {};
  S.typeOverrides = st.typeOverrides || {};
  rebuildItems();
  renderTree();
  applyFilters();
  if (S.libs.length) listEl.focus();
  window.__sf = { S, engine, wave, selectIndex, applyFilters, setDupExcluded, prefs, openFolder, goUp, folderChain, excludingFolder, extraCopies }; // handy for debugging (F12)
}
boot();
