import { Engine } from './engine.js';
import { WaveView, fmtTime, fmtDb, escapeHtml } from './waveform.js';
import { SpeakerView } from './speakers.js';
import { VList } from './vlist.js';
import { createOnline } from './online.js';
import { createSettings } from './settings.js';
import { createSource } from './sources.js';
import { detectLayout, layoutChoices } from './layouts.js';
import { metaCategory, TYPES, TYPE_LABELS } from '../../shared/categorize.mjs';
import { RELEASES, unseenReleases } from './whats-new.js';
import SAFETY_DEFAULTS from '../../shared/safety.json' with { type: 'json' };

const $ = s => document.querySelector(s);
const api = window.api;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

// ------------------------------------------------------------------ prefs
// Kept in settings.json in the app's data folder. Older versions kept them in browser storage:
// those are moved over the first time this version starts.
const savedPrefs = (() => { try { return window.api.settings.load(); } catch { return null; } })();
const prefs = Object.assign(
  { volume: -6, autoplay: true, loop: false, monitor: 'stereo', lfe: false, playerH: 330, sort: { key: 'name', dir: 1 }, expanded: [] },
  savedPrefs || safeJson(() => localStorage.getItem('sf.prefs')),
);
function savePrefs() { try { window.api.settings.save(prefs); } catch {} }
function safeJson(fn) { try { return JSON.parse(fn()) || {}; } catch { return {}; } }
if (!savedPrefs) savePrefs();
// Size / count limits before big jobs need a second confirmation (shared/safety.json + your changes).
const safety = () => ({ ...SAFETY_DEFAULTS, ...(prefs.safety || {}) });
const GB = 1024 ** 3, MB = 1024 ** 2;

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
  projects: [], // [{ id, name, created, items: [{ path, size, mtime }] }]
  projIndex: new Map(), // lower-case path -> [projects]
  mode: 'library', // 'library' | 'online'
  downloads: {}, // online key -> { path, licence, creator, … } for sounds saved from the Online tab
  downloadsByPath: new Map(),
  onlineTok: 0,
  multi: new Set(), // paths of sounds picked with Ctrl / Shift click (empty = just the current row)
  anchor: -1, // where a Shift-click range starts
  countText: '',
  saveDir: null, // Soundfield search save folder for this session (null = Documents\Soundfield Downloads)
};

const engine = new Engine();
const wave = new WaveView({
  wrap: $('#wave-wrap'), canvas: $('#wave'), ruler: $('#ruler'), sel: $('#sel'),
  playhead: $('#playhead'), hover: $('#hover'), labels: $('#lanes-labels'), dbscale: $('#dbscale'),
});
wave.on('levels', () => renderMeta());
const speakers = new SpeakerView($('#speakers'));
const list = new VList($('#list'), { rowHeight: 26, render: renderRow, isSelected: i => (S.multi.size ? !!S.view[i] && S.multi.has(S.view[i].path) : i === list.selected) });
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
  // A project only needs its own sounds looked at, not the whole library.
  const pool = sc.type === 'proj' ? projectItems(projectById(sc.id)) : S.items;
  for (const it of pool) {
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
  // A project also lists the sounds it can no longer find, so they can be relinked or removed.
  if (sc.type === 'proj') {
    const p = projectById(sc.id);
    if (p && !(cls.size || S.types.size || sr || S.dur)) {
      for (const r of missingRefs(p)) {
        const m = missingItem(r);
        if (inc.every(t => m.hay.includes(t)) && !exc.some(t => m.hay.includes(t))) out.push(m);
      }
    }
  }
  const folders = browse ? folderRows(sc) : [];
  const view = folders.length ? folders.concat(out) : out;
  S.view = view;
  renderDupBanner();
  renderProjBanner();
  document.querySelectorAll('.proj-row[data-id]').forEach(r => r.classList.toggle('active', sc.type === 'proj' && sc.id === r.dataset.id));
  renderCrumbs(searching);
  if (!keepScroll) $('#list').scrollTop = 0;
  if (S.multi.size) { const inView = new Set(view.map(it => it.path)); for (const p of [...S.multi]) if (!inView.has(p)) S.multi.delete(p); }
  if (!keepScroll) S.anchor = -1;
  list.setItems(view);
  const idx = S.current ? view.indexOf(S.current) : -1;
  list.select(idx, false);
  S.countText = (folders.length ? `${folders.length.toLocaleString()} folder${folders.length === 1 ? '' : 's'} · ` : '') +
    `${out.length.toLocaleString()} of ${S.items.length.toLocaleString()}`;
  updateSelCount();
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

function renderMissingRow(row, it) {
  const c = row._c;
  row.classList.remove('folder-row', 'dup-b', 'dup-first');
  row.classList.add('missing-row');
  c[0].firstChild.classList.remove('on');
  c[1].innerHTML = `${escapeHtml(it.name)}<span class="ext">.${escapeHtml(it.ext)}</span><span class="missb">missing</span>`;
  c[1].title = `Not found: ${it.path}\nRight-click → Relink, or use “Relink missing” above.`;
  c[2].firstChild.className = 'fmt';
  c[2].firstChild.textContent = '';
  c[3].className = 'c-type';
  c[3].textContent = '';
  c[3].title = '';
  for (const k of [4, 5, 6, 7]) c[k].textContent = '';
  c[8].textContent = 'Moved, renamed or deleted since it was added';
  c[8].title = '';
  c[9].textContent = it.lib.path;
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
  if (it.isFolder) { row.classList.remove('missing-row'); renderFolderRow(row, it); return; }
  if (it.isMissing) { renderMissingRow(row, it); return; }
  row.classList.remove('folder-row', 'missing-row');
  const c = row._c, r = it.rec;
  c[0].firstChild.classList.toggle('on', S.favorites.has(it.path));
  const dup = S.scope.type === 'dups' && S.dupes ? S.dupes.byPath.get(it.path) : null;
  row.classList.toggle('dup-b', !!dup && dup.g % 2 === 1);
  row.classList.toggle('dup-first', !!dup && dup.first);
  // Project badge (hidden while viewing a project: every row there belongs to it).
  const projs = S.scope.type === 'proj' ? null : S.projIndex.get(lowPath(it.path));
  const projTag = projs && projs.length
    ? `<span class="projn" title="In project${projs.length > 1 ? 's' : ''}: ${escapeHtml(projs.map(p => p.name).join(', '))}">▣ ${escapeHtml(projs.length > 1 ? `${projs.length} projects` : projs[0].name)}</span>`
    : '';
  c[1].innerHTML = `${escapeHtml(it.name)}<span class="ext">.${escapeHtml(it.ext)}</span>${dup ? `<span class="dupn">${dup.n} copies</span>` : ''}${projTag}`;
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
  if (it.isMissing) {
    S.current = null;
    engine.stop();
    S.source = null;
    S.layout = null;
    wave.clear('This sound has moved or been deleted. Use “Relink missing” to find it again.');
    speakers.setLayout(null);
    fillLayoutSelect();
    $('#file-meta').innerHTML = `<div class="fname">${escapeHtml(it.name)}.${escapeHtml(it.ext)}</div><dl><dt>Was at</dt><dd>${escapeHtml(it.path)}</dd></dl>`;
    return;
  }
  return loadItem(it, { play });
}

// Loads a sound into the player (library row, or an online result once its file is local).
async function loadItem(it, { play = false } = {}) {
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
    const r = await api.extractZip(it.path, mode, it.lib.id);
    if (!r) { toast('Extract cancelled'); return; }
    toast(`Extracted to ${r.dest}. Adding the new sounds…${r.skipped ? ` ${r.skipped.toLocaleString()} file(s) already there were kept, not overwritten.` : ''}`, r.skipped ? 6000 : 2600);
  } catch (err) {
    toast(`Couldn’t extract: ${ipcMessage(err)}`, 6000);
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
  if (S.current.online) { onlineDrag(); return; }
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
    // How loud it is, measured from the waveform before you play it.
    if (wave.levels) {
      rows.push(['Peak', `${fmtDb(wave.levels.peak)} dBFS`]);
      rows.push(['RMS', `${fmtDb(wave.levels.rms)} dBFS`]);
    }
    if (info && info.mask) rows.push(['Mask', '0x' + info.mask.toString(16).toUpperCase()]);
    if (L && L.chans.length && !L.ambi) rows.push(['Order', L.chans.map(c => c.role === c.label ? c.role : c.label).join(' ')]);
  }
  // Where an online sound (or a downloaded one) came from, and what its licence asks.
  const o = it.online || S.downloadsByPath.get(lowPath(it.path));
  if (o) {
    const lic = LIC_INFO[o.license] || { label: o.license, credit: true };
    rows.push(['Licence', `${lic.label} · ${lic.credit ? 'credit the creator' : 'no credit needed'}`]);
    rows.push(['By', o.creator || 'unknown']);
    rows.push(['Source', o.sourceLabel]);
    if (it.online) {
      const dl = S.downloads[o.key];
      rows.push(['Playing', it.path === (dl && dl.path) ? 'Your saved copy' : o.previewIsOriginal ? 'Original file' : 'Preview (MP3)']);
      if (o.pack) rows.push(['Pack', o.pack]);
    } else if (o.quality === 'preview') rows.push(['Quality', 'Preview (MP3)']);
  } else {
    if (!it.zip) rows.push(['Category', TYPE_LABELS[it.type] + ({ you: ' · set by you', name: ' · from name', audio: ' · from audio' }[it.typeSrc] || '')]);
  }
  if (r.size) rows.push(['Size', fmtBytes(r.size)]);
  if (!it.online) rows.push(['Folder', `${it.lib.name}${it.folder ? ' / ' + it.folder : ''}`]);
  el.innerHTML = `<div class="fname">${escapeHtml(it.name)}${it.online ? '' : '.' + escapeHtml(it.ext)}</div>
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
$('#btn-reveal').addEventListener('click', () => {
  if (!S.current) return;
  if (!S.current.online) { api.reveal(S.current.path); return; }
  const dl = S.downloads[S.current.online.key];
  if (dl) api.reveal(dl.path); else toast('Not saved yet. Click Save to download it into Soundfield Downloads.');
});
$('#drag-handle').addEventListener('dragstart', e => {
  e.preventDefault();
  if (!S.current || S.current.zip) return;
  if (S.current.online) { onlineDrag(); return; }
  const pcm = S.info && (S.info.codec === 'pcm' || S.info.codec === 'float');
  api.startDrag(S.current.path, S.selection && pcm ? S.selection : null);
});

function updateMonitorHint() {
  const o = $('#monitor').querySelector('[value="discrete"]');
  o.textContent = `Discrete outputs (${engine.deviceChannels} ch device)`;
}

// ------------------------------------------------------------------ multi-selection
// Click selects one sound; Ctrl-click adds/removes; Shift-click selects everything between
// the last clicked sound and this one; Ctrl+A selects all listed. Folder rows are never selected.
const selectable = it => !!it && !it.isFolder && !it.isMissing;

function selectedItems() {
  if (S.multi.size) return S.view.filter(it => selectable(it) && S.multi.has(it.path));
  const it = S.view[list.selected];
  return selectable(it) ? [it] : [];
}

function setMulti(items) {
  S.multi = new Set(items.filter(selectable).map(it => it.path));
  if (S.multi.size < 2) S.multi.clear();
  list.refresh();
  updateSelCount();
}

function selectRange(a, b) {
  const lo = Math.max(0, Math.min(a, b)), hi = Math.min(S.view.length - 1, Math.max(a, b));
  setMulti(S.view.slice(lo, hi + 1));
}

function updateSelCount() {
  const n = S.multi.size;
  const bytes = n ? selectedItems().reduce((t, it) => t + (it.rec.size || 0), 0) : 0;
  $('#count').textContent = (n ? `${n.toLocaleString()} selected (${fmtBytes(bytes)}) · ` : '') + S.countText;
}

function recycleSelected() {
  const items = selectedItems();
  if (!items.length) return;
  const bytes = items.reduce((t, it) => t + (it.rec.size || 0), 0);
  recycle(items.map(it => it.path), `${items.length.toLocaleString()} file${items.length === 1 ? '' : 's'} · ${fmtBytes(bytes)}. You can restore them from the Recycle Bin.`);
}

// ------------------------------------------------------------------ list interactions
const listEl = $('#list');
listEl.addEventListener('mousedown', e => {
  const i = list.indexFromEvent(e);
  if (i < 0) return;
  if (e.target.classList.contains('star')) return;
  if (e.button !== 0) return;
  const it = S.view[i];
  if (e.shiftKey) {
    // Everything between the last clicked sound and this one.
    const from = S.anchor >= 0 ? S.anchor : list.selected >= 0 ? list.selected : i;
    selectRange(from, i);
    if (selectable(it)) selectIndex(i, { play: false }); else list.select(i, false);
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    // Add or remove one sound.
    if (!S.multi.size) { const cur = S.view[list.selected]; if (selectable(cur)) S.multi.add(cur.path); }
    if (S.multi.has(it.path)) S.multi.delete(it.path); else if (selectable(it)) S.multi.add(it.path);
    S.anchor = i;
    list.selected = i;
    list.refresh();
    updateSelCount();
    return;
  }
  S.anchor = i;
  if (S.multi.size) setMulti([]);
  selectIndex(i, { play: !!prefs.clickPlays }); // by default a click only selects and double-click plays (Settings → Playback)
});
listEl.addEventListener('click', e => {
  if (!e.target.classList.contains('star')) return;
  const i = list.indexFromEvent(e);
  if (i >= 0 && !S.view[i].isFolder && !S.view[i].isMissing) toggleFavorite(S.view[i]);
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
  if (i < 0) return;
  // Dragging one of several selected sounds drags all of them (within the drag limits: a DAW
  // can freeze, or copy a huge amount, when hundreds of files land on it at once).
  if (S.multi.size > 1 && S.multi.has(S.view[i].path)) {
    const files = selectedItems().filter(x => !x.zip), bytes = sumBytes(files), s = safety();
    if (files.length > s.dragFiles || bytes > s.dragGB * GB) {
      toast(`That's ${files.length.toLocaleString()} files (${fmtBytes(bytes)}), over the drag limit of ${s.dragFiles} files / ${s.dragGB} GB. Add them to a project and use Materialize instead.`, 6000);
      return;
    }
    api.startDrag(files.map(x => x.path), null);
    return;
  }
  if (!S.view[i].zip && !S.view[i].isFolder && !S.view[i].isMissing) api.startDrag(S.view[i].path, null);
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
  const curProj = S.scope.type === 'proj' ? projectById(S.scope.id) : null;
  if (it.isMissing) {
    list.select(i, false);
    const pick = await api.menu([
      { id: 'relink', label: 'Relink missing files', enabled: !!curProj },
      { id: 'remove', label: 'Remove from this project', enabled: !!curProj },
      { type: 'separator' },
      { id: 'copy', label: 'Copy old path' },
    ]);
    if (pick === 'relink') relinkProject(curProj);
    else if (pick === 'remove') removeFromProject(curProj, [it.path]);
    else if (pick === 'copy') { api.copyText(it.path); toast('Path copied'); }
    return;
  }
  if (S.multi.size > 1 && S.multi.has(it.path)) {
    const sel = selectedItems();
    const n = sel.length;
    const bytes = sel.reduce((t, x) => t + (x.rec.size || 0), 0);
    const projSub = [...S.projects].sort((a, b) => collator.compare(a.name, b.name)).map(p => ({ id: 'mproj:' + p.id, label: p.name }));
    if (projSub.length) projSub.push({ type: 'separator' });
    projSub.push({ id: 'mproj:new', label: 'New project…' });
    const pick = await api.menu([
      { id: '', label: `${n.toLocaleString()} sounds selected (${fmtBytes(bytes)})`, enabled: false },
      { type: 'separator' },
      { label: `Add ${n.toLocaleString()} to project`, submenu: projSub },
      { id: 'mcopy', label: `Copy ${n.toLocaleString()} paths` },
      { id: 'mclear', label: 'Clear selection' },
      { type: 'separator' },
      { id: 'mtrash', label: `Move ${n.toLocaleString()} files to Recycle Bin   (Del)` },
    ]);
    if (pick === 'mtrash') recycleSelected();
    else if (pick === 'mclear') setMulti([]);
    else if (pick === 'mcopy') { api.copyText(sel.map(x => x.path).join('\r\n')); toast(`${n} paths copied`); }
    else if (pick === 'mproj:new') newProject(sel.filter(x => !x.zip));
    else if (pick && pick.startsWith('mproj:')) { const p = projectById(pick.slice(6)); if (p) addToProject(p, sel.filter(x => !x.zip)); }
    return;
  }
  if (S.multi.size) setMulti([]);
  S.anchor = i;
  if (S.current !== it) selectIndex(i, { play: false });
  const fav = S.favorites.has(it.path);
  const items = it.zip
    ? [{ id: 'x-folder', label: `Extract to “${it.name}”` }, { id: 'x-here', label: 'Extract here' }, { type: 'separator' }]
    : [{ id: 'play', label: 'Play' }, { id: 'fav', label: fav ? 'Remove from favorites' : 'Add to favorites' }, projectMenu(it),
      ...(curProj ? [{ id: 'proj:remove', label: `Remove from “${curProj.name}”` }] : []), { type: 'separator' }];
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
  items.push({ type: 'separator' }, { id: 'trash', label: 'Move to Recycle Bin   (Del)' });
  const pick = await api.menu(items);
  if (pick === 'proj:new') { newProject([it]); return; }
  if (pick === 'proj:remove') { removeFromProject(curProj, [it.path]); return; }
  if (pick && pick.startsWith('proj:')) { const p = projectById(pick.slice(5)); if (p) addToProject(p, [it]); return; }
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
  // Comparing audio reads files from disk: say how much first when it's a lot.
  const est = await api.dupesEstimate().catch(() => null);
  if (est && est.bytes > est.confirmGB * GB) {
    const ok = await modal({
      title: 'Compare audio across your libraries?',
      sub: `${est.files.toLocaleString()} sounds share a format and length with another one, so their audio has to be compared. That can mean reading up to <b>${fmtBytes(est.bytes)}</b> from disk, which takes a while on large or network drives. You can cancel while it runs.`,
      ok: 'Compare them',
    });
    if (!ok) { S.dupChooser = true; applyFilters(); return; }
  }
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
  const items = [{ id: 'reveal', label: 'Show in Explorer' },
    { id: 'savehere', label: S.saveDir && S.saveDir.toLowerCase() === dir.toLowerCase() ? '✓  Soundfield search saves here' : 'Save Soundfield search downloads here' },
    { type: 'separator' }];
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
  else if (pick === 'savehere') onlineUI.setSaveDir(dir);
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
// Right-click a category: add every sound in it (or just the ones listed) to a project.
$('#types').addEventListener('contextmenu', async e => {
  e.preventDefault();
  const s = e.target.closest('.side-item');
  if (!s) return;
  const ty = s.dataset.type;
  const all = ty === '__all';
  const label = all ? 'All sounds' : TYPE_LABELS[ty];
  const inCat = it => !it.zip && (all || it.type === ty);
  const items = S.items.filter(inCat);
  const listed = S.view.filter(it => selectable(it) && inCat(it));
  const projSub = prefix => {
    const sub = [...S.projects].sort((a, b) => collator.compare(a.name, b.name)).map(p => ({ id: prefix + p.id, label: p.name }));
    if (sub.length) sub.push({ type: 'separator' });
    sub.push({ id: prefix + 'new', label: 'New project…' });
    return sub;
  };
  const menu = [
    { id: '', label: `${label}: ${items.length.toLocaleString()} sound${items.length === 1 ? '' : 's'} · ${fmtBytes(sumBytes(items))}`, enabled: false },
    { type: 'separator' },
    { label: `Add all ${items.length.toLocaleString()} to project`, submenu: projSub('all:') },
  ];
  // A search or filter is narrowing the list: offer just what's showing too.
  if (listed.length && listed.length !== items.length) menu.push({ label: `Add the ${listed.length.toLocaleString()} listed to project`, submenu: projSub('listed:') });
  if (!all) menu.push({ type: 'separator' }, { id: 'show', label: `Show only ${label}` });
  const pick = await api.menu(menu);
  if (!pick) return;
  if (pick === 'show') { S.types.clear(); S.types.add(ty); applyFilters(); return; }
  const [which, id] = pick.split(':');
  const chosen = which === 'listed' ? listed : items;
  if (!chosen.length) return;
  const bytes = sumBytes(chosen);
  if (chosen.length > 2000 || bytes > safety().confirmGB * GB) {
    const ok = await modal({
      title: `Add ${chosen.length.toLocaleString()} sounds (${fmtBytes(bytes)})?`,
      sub: `That's ${which === 'listed' ? 'every listed sound' : 'every sound'} in “${escapeHtml(label)}”. Nothing is moved or copied: the project just lists them. Materializing the project later would copy <b>${fmtBytes(bytes)}</b>.`,
      ok: 'Add them',
    });
    if (!ok) return;
  }
  if (id === 'new') newProject(chosen);
  else { const p = projectById(id); if (p) addToProject(p, chosen); }
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
  if (p.phase === 'end') {
    S.scans.delete(p.id);
    if (p.changed !== false) { if (S.dupesRaw) S.dupesRaw.stale = true; if (S.dupes) S.dupes.stale = true; }
  }
  else S.scans.set(p.id, p);
  renderScanStatus();
  if (p.phase === 'start' || p.phase === 'end') renderTree();
});
api.on('lib:updated', ({ lib, records }) => {
  let l = S.libs.find(x => x.id === lib.id);
  if (!l) { l = { ...lib }; S.libs.push(l); } // added by the app itself (e.g. Online downloads)
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
  renderProjects();
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
  if (S.exportProgress) {
    const x = S.exportProgress;
    const pct = x.totalBytes ? (x.bytes / x.totalBytes) * 100 : x.total ? (x.done / x.total) * 100 : 0;
    el.innerHTML = `${x.mode === 'zip' ? 'Zipping' : 'Materializing'} “${escapeHtml(x.name)}”: ${x.done.toLocaleString()} / ${x.total.toLocaleString()}${x.totalBytes ? ` · ${fmtBytes(x.bytes)} of ${fmtBytes(x.totalBytes)}` : ''}<button class="st-cancel" data-cancel="export">Cancel</button><div class="bar"><i style="width:${pct}%"></i></div>`;
    return;
  }
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
    el.innerHTML = `${escapeHtml(d.stage)}…<button class="st-cancel" data-cancel="dupes">Cancel</button><div class="bar"><i style="width:${pct}%"></i></div>`;
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

$('#scan-status').addEventListener('click', async e => {
  const b = e.target.closest('[data-cancel]');
  if (!b) return;
  b.disabled = true;
  if (b.dataset.cancel === 'export') api.cancelExport();
  else if (b.dataset.cancel === 'dupes' && await api.cancelDupes()) toast('Duplicate search cancelled');
});

// ------------------------------------------------------------------ keyboard
document.addEventListener('keydown', e => {
  const typing = !!(e.target.matches && e.target.matches('input[type=search], input[type=text]'));
  const k = e.key;
  const searchBox = S.mode === 'online' ? $('#o-search') : $('#search');
  if ((e.ctrlKey && k.toLowerCase() === 'f') || (k === '/' && !typing)) { e.preventDefault(); searchBox.focus(); searchBox.select(); return; }
  if (S.mode === 'online' && onlineUI.key(e, typing)) return; // list navigation, Enter, Escape in the Online tab
  const libKeys = S.mode !== 'online';
  const cur = list.selected;
  const nav = d => {
    e.preventDefault();
    const t = Math.max(0, Math.min(S.view.length - 1, (cur < 0 ? (d > 0 ? -1 : S.view.length) : cur) + d));
    if (e.shiftKey) { if (S.anchor < 0) S.anchor = cur < 0 ? t : cur; selectRange(S.anchor, t); }
    else { S.anchor = t; if (S.multi.size) setMulti([]); }
    selectIndex(t);
  };
  if (libKeys && !typing && e.ctrlKey && !e.altKey && k.toLowerCase() === 'a' && e.target.tagName !== 'SELECT') { e.preventDefault(); setMulti(S.view); return; }
  if (libKeys && !typing && k === 'Delete' && e.target.tagName !== 'SELECT') { e.preventDefault(); recycleSelected(); return; }
  if (libKeys && k === 'ArrowDown') return nav(1);
  if (libKeys && k === 'ArrowUp') return nav(-1);
  if (libKeys && k === 'PageDown') return nav(list.pageSize());
  if (libKeys && k === 'PageUp') return nav(-list.pageSize());
  if (libKeys && k === 'Enter') {
    e.preventDefault();
    if (typing) $('#search').blur();
    const row = S.view[cur];
    if (row && row.isFolder) openFolder(row.lib, row.prefix);
    else if (cur < 0 && S.view.length) selectIndex(0);
    else { S.selection = null; wave.setSelection(null); startPlay(0); }
    return;
  }
  if (libKeys && k === 'Backspace' && !typing && browsing() && e.target.tagName !== 'SELECT') { e.preventDefault(); goUp(); return; }
  if (k === 'Escape') {
    if (libKeys && typing && e.target.value) { e.target.value = ''; S.query = ''; applyFilters(); return; }
    if (libKeys && !typing && S.multi.size) { setMulti([]); return; }
    if (S.selection) { S.selection = null; wave.setSelection(null); } else engine.stop();
    if (typing) e.target.blur();
    return;
  }
  if (typing || e.target.tagName === 'SELECT') return;
  if (k === ' ') { e.preventDefault(); togglePlay(); return; }
  if (libKeys && k === 'Home') return nav(-S.view.length);
  if (libKeys && k === 'End') return nav(S.view.length);
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
  else if (lk === 'f' && !(S.current && S.current.online)) toggleFavorite(S.current);
  else if (lk === 'p' && S.current && S.current.online) toast('Save it first, then add it to a project from your library.');
  else if (lk === 'p' && S.current && !S.current.zip) {
    // Quick-add the sound being previewed to the project used last.
    const p = projectById(prefs.lastProject);
    if (p) addToProject(p, [S.current]); else newProject([S.current]);
  }
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
const SIDEBAR_TYPES_H = 220;
function applySidebarPrefs() {
  const side = $('#sidebar');
  side.style.setProperty('--types-h', (prefs.typesH || SIDEBAR_TYPES_H) + 'px');
  side.classList.toggle('types-collapsed', !!prefs.typesCollapsed);
  side.classList.toggle('libs-collapsed', !!prefs.libsCollapsed);
  side.classList.toggle('proj-collapsed', !!prefs.projCollapsed);
}
(() => {
  const side = $('#sidebar'), types = $('#types'), split = $('#side-split');
  const DEFAULT_H = SIDEBAR_TYPES_H;
  const apply = applySidebarPrefs;
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

// ------------------------------------------------------------------ projects
// Virtual project folders: each holds references ({ path, size, mtime }) to
// sounds, never copies. Zip / Materialize turn them into real files.
const lowPath = p => p.toLowerCase();

function rebuildProjIndex() {
  S.projIndex = new Map();
  for (const p of S.projects) for (const r of p.items) {
    const k = lowPath(r.path);
    if (!S.projIndex.has(k)) S.projIndex.set(k, []);
    S.projIndex.get(k).push(p);
  }
}

function saveProjects() {
  rebuildProjIndex();
  api.saveProjects(S.projects);
  renderProjects();
}

const projectById = id => S.projects.find(p => p.id === id);
// Lower-case path -> item, rebuilt only when the item list changes (it's always replaced, never edited).
let byPathCache = { items: null, map: null };
function itemsByPath() {
  if (byPathCache.items !== S.items) {
    const m = new Map();
    for (const it of S.items) if (!it.zip) m.set(lowPath(it.path), it);
    byPathCache = { items: S.items, map: m };
  }
  return byPathCache.map;
}
// Total size of a project's sounds (what a Materialize would copy); missing files count their last known size.
function projectBytes(p) {
  const byPath = itemsByPath();
  let bytes = 0, present = 0;
  for (const r of p.items) { const it = byPath.get(lowPath(r.path)); if (it) { bytes += it.rec.size || 0; present++; } }
  return { bytes, present };
}
const sumBytes = items => items.reduce((t, it) => t + ((it.rec && it.rec.size) || 0), 0);

// The project's sounds that are in a linked library.
function projectItems(p) {
  if (!p) return [];
  const byPath = itemsByPath(), out = [];
  for (const r of p.items) { const it = byPath.get(lowPath(r.path)); if (it) out.push(it); }
  return out;
}

// References whose file isn't in any linked library (moved, renamed, deleted or library removed).
function missingRefs(p, byPath = itemsByPath()) {
  return p.items.filter(r => !byPath.has(lowPath(r.path)));
}

const missingCache = new Map();
function missingItem(ref) {
  let m = missingCache.get(ref.path);
  if (m) return m;
  const file = ref.path.split(/[\\/]/).pop();
  const dot = file.lastIndexOf('.');
  const dir = ref.path.slice(0, ref.path.length - file.length - 1);
  m = {
    isMissing: true, path: ref.path, name: dot > 0 ? file.slice(0, dot) : file, ext: dot > 0 ? file.slice(dot + 1) : '',
    folder: '', lib: { id: '', name: dir, path: dir }, rec: { rel: file, size: ref.size || 0, dur: 0, ch: 0, sr: 0, bits: 0 },
    cls: 'multi', fmtLabel: '', type: 'unsorted', typeSrc: '', hay: file.toLowerCase(),
  };
  missingCache.set(ref.path, m);
  return m;
}

function renderProjects() {
  const box = $('#projects');
  const counts = itemsByPath();
  box.replaceChildren();
  if (!S.projects.length) {
    const e = document.createElement('div');
    e.className = 'proj-empty';
    e.textContent = 'Click + to start a project, then add sounds to it. Nothing is moved or copied.';
    box.appendChild(e);
    return;
  }
  for (const p of [...S.projects].sort((a, b) => collator.compare(a.name, b.name))) {
    const miss = missingRefs(p, counts).length;
    const row = document.createElement('div');
    row.className = 'proj-row' + (S.scope.type === 'proj' && S.scope.id === p.id ? ' active' : '');
    row.dataset.id = p.id;
    row.title = `${p.name}: ${p.items.length} sound${p.items.length === 1 ? '' : 's'} · ${fmtBytes(projectBytes(p).bytes)} if materialized${miss ? ` · ${miss} missing` : ''}. Drop sounds here to add them.`;
    row.innerHTML = `<span class="pico"></span><span class="lbl">${escapeHtml(p.name)}</span>${miss ? `<span class="miss">${miss} missing</span>` : ''}<span class="num">${p.items.length ? p.items.length.toLocaleString() : ''}</span>`;
    box.appendChild(row);
  }
}

function openProject(p) {
  S.scope = { type: 'proj', id: p.id };
  renderTree();
  renderProjects();
  applyFilters();
}

// Inline name editor in the Projects list; resolves with the name or null.
function askName(initial = '', anchorRow = null) {
  return new Promise(resolve => {
    const box = $('#projects');
    const row = anchorRow || document.createElement('div');
    const old = anchorRow ? row.innerHTML : null;
    if (!anchorRow) { row.className = 'proj-row'; box.prepend(row); box.querySelector('.proj-empty')?.remove(); }
    row.innerHTML = '<span class="pico"></span><input type="text" spellcheck="false" placeholder="Project name">';
    const input = row.querySelector('input');
    input.value = initial;
    input.focus();
    input.select();
    let done = false;
    const finish = val => {
      if (done) return;
      done = true;
      if (!anchorRow) row.remove(); else row.innerHTML = old;
      resolve(val && val.trim() ? val.trim().slice(0, 120) : null);
    };
    input.addEventListener('keydown', e => {
      e.stopPropagation();
      if (e.key === 'Enter') finish(input.value);
      else if (e.key === 'Escape') finish(null);
    });
    input.addEventListener('blur', () => finish(input.value));
  });
}

async function newProject(initialItems = []) {
  if (prefs.projCollapsed) { prefs.projCollapsed = false; applySidebarPrefs(); }
  const name = await askName(uniqueProjectName('New project'));
  if (!name) return null;
  const p = { id: Math.random().toString(36).slice(2, 10), name, created: Date.now(), items: [] };
  S.projects.push(p);
  prefs.lastProject = p.id;
  savePrefs();
  if (initialItems.length) addToProject(p, initialItems); else saveProjects();
  return p;
}

function uniqueProjectName(base) {
  const names = new Set(S.projects.map(p => p.name.toLowerCase()));
  let n = base;
  for (let i = 2; names.has(n.toLowerCase()); i++) n = `${base} ${i}`;
  return n;
}

function addToProject(p, items, quiet = false) {
  const have = new Set(p.items.map(r => lowPath(r.path)));
  let added = 0;
  for (const it of items) {
    if (!it || it.zip || it.isFolder || it.isMissing) continue;
    const k = lowPath(it.path);
    if (have.has(k)) continue;
    have.add(k);
    p.items.push({ path: it.path, size: it.rec.size || 0, mtime: it.rec.mtime || 0 });
    added++;
  }
  prefs.lastProject = p.id;
  savePrefs();
  saveProjects();
  if (S.scope.type === 'proj' && S.scope.id === p.id) applyFilters({ keepScroll: true }); else list.refresh();
  if (!quiet) toast(added ? `Added ${added.toLocaleString()} sound${added === 1 ? '' : 's'} to “${p.name}”` : `Already in “${p.name}”`);
  return added;
}

function removeFromProject(p, paths) {
  const gone = new Set(paths.map(lowPath));
  p.items = p.items.filter(r => !gone.has(lowPath(r.path)));
  saveProjects();
  applyFilters({ keepScroll: true });
  toast(`Removed ${paths.length} from “${p.name}”`);
}

// Find moved / renamed files again: same file name and size somewhere in the libraries.
function relinkProject(p) {
  const byPath = itemsByPath();
  const byName = new Map();
  for (const it of byPath.values()) {
    const k = `${it.name}.${it.ext}`.toLowerCase();
    if (!byName.has(k)) byName.set(k, []);
    byName.get(k).push(it);
  }
  let fixed = 0, left = 0;
  for (const r of p.items) {
    if (byPath.has(lowPath(r.path))) continue;
    const cands = byName.get(r.path.split(/[\\/]/).pop().toLowerCase()) || [];
    const sameSize = cands.filter(c => r.size && c.rec.size === r.size);
    const pick = sameSize.length >= 1 ? sameSize[0] : cands.length === 1 && !r.size ? cands[0] : null;
    if (pick && !p.items.some(o => o !== r && lowPath(o.path) === lowPath(pick.path))) {
      r.path = pick.path; r.size = pick.rec.size; r.mtime = pick.rec.mtime || 0; fixed++;
    } else left++;
  }
  saveProjects();
  applyFilters({ keepScroll: true });
  toast(fixed ? `Relinked ${fixed} file${fixed === 1 ? '' : 's'}${left ? ` · ${left} still missing` : ''}` : left ? `Couldn’t find ${left} missing file${left === 1 ? '' : 's'} in your libraries` : 'Nothing is missing');
}

// Small modal dialog. fields: HTML; resolves with the card element (to read inputs) or null.
// cancel: null leaves out the Cancel button (for notices with a single Close / OK).
function modal({ title, sub = '', body = '', ok = 'OK', okClass = 'primary', cancel = 'Cancel' }) {
  return new Promise(resolve => {
    const m = $('#modal');
    m.innerHTML = `<div class="modal-card" role="dialog" aria-modal="true"><h3>${escapeHtml(title)}</h3>${sub ? `<p class="sub">${sub}</p>` : ''}${body}
      <div class="modal-actions">${cancel === null ? '' : `<button data-a="cancel">${escapeHtml(cancel)}</button>`}<button data-a="ok" class="${okClass}">${escapeHtml(ok)}</button></div></div>`;
    m.hidden = false;
    const card = m.querySelector('.modal-card');
    const close = val => { m.hidden = true; m.innerHTML = ''; document.removeEventListener('keydown', onKey, true); resolve(val); };
    const onKey = e => {
      if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); close(null); }
      else if (e.key === 'Enter' && e.target.tagName !== 'BUTTON') { e.stopPropagation(); e.preventDefault(); close(card); }
      else e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    m.addEventListener('mousedown', e => { if (e.target === m) close(null); }, { once: true });
    card.querySelector('[data-a=cancel]')?.addEventListener('click', () => close(null));
    card.querySelector('[data-a=ok]').addEventListener('click', () => close(card));
    card.querySelector('[data-a=ok]').focus();
  });
}

async function exportProject(p, mode) {
  const byPath = itemsByPath();
  const present = p.items.filter(r => byPath.has(lowPath(r.path))).length;
  const miss = p.items.length - present;
  if (!p.items.length) { toast(`“${p.name}” is empty. Add some sounds first.`); return; }
  const zip = mode === 'zip';
  const size = fmtBytes(projectBytes(p).bytes);
  const card = await modal({
    title: zip ? `Zip “${p.name}”` : `Materialize “${p.name}”`,
    sub: (zip
      ? `Packs ${present.toLocaleString()} sound${present === 1 ? '' : 's'} (<b>${size}</b>) into one .zip file. Your original files stay where they are.`
      : `Copies ${present.toLocaleString()} sound${present === 1 ? '' : 's'} (<b>${size}</b>) into a new folder called “${escapeHtml(p.name)}”. Your original files are never moved or deleted.`)
      + ` The free space on the drive you pick is checked first.`
      + (miss ? ` <span style="color:var(--warn)">${miss} missing file${miss === 1 ? '' : 's'} will be skipped and listed at the end.</span>` : ''),
    body: `<fieldset><legend>Folder layout</legend>
        <label><input type="radio" name="layout" value="flat" ${prefs.exportLayout !== 'keep' ? 'checked' : ''}><span>All in one folder<small>Same-named files become “name (2).wav” instead of overwriting.</small></span></label>
        <label><input type="radio" name="layout" value="keep" ${prefs.exportLayout === 'keep' ? 'checked' : ''}><span>Keep library folders<small>Library / sub-folder / file, like the originals.</small></span></label>
      </fieldset>
      <fieldset><legend>Extras</legend>
        <label><input type="checkbox" name="manifest" ${prefs.exportManifest !== false ? 'checked' : ''}><span>Include a list of original file locations</span></label>
        ${zip ? '' : `<label><input type="checkbox" name="repoint" ${prefs.exportRepoint ? 'checked' : ''}><span>Point this project at the new copies<small>The new folder is added as a library so the copies show up here.</small></span></label>`}
      </fieldset>`,
    ok: zip ? 'Choose where to save…' : 'Choose destination…',
  });
  if (!card) return;
  const layout = card.querySelector('input[name=layout]:checked').value;
  const manifest = card.querySelector('input[name=manifest]').checked;
  const repoint = !zip && card.querySelector('input[name=repoint]').checked;
  prefs.exportLayout = layout; prefs.exportManifest = manifest; if (!zip) prefs.exportRepoint = repoint;
  savePrefs();
  const items = p.items.map(r => {
    const it = byPath.get(lowPath(r.path));
    return { path: r.path, rel: it ? `${it.lib.name}/${it.rec.rel}` : r.path.split(/[\\/]/).pop(), size: it ? it.rec.size || 0 : 0 };
  });
  let result;
  try {
    result = await api.exportProject({ mode: zip ? 'zip' : 'copy', name: p.name, items, layout, manifest, repoint });
  } catch (err) {
    toast(`${zip ? 'Zip' : 'Materialize'} failed: ${err.message || err}`, 6000);
    return;
  }
  if (!result) return; // cancelled before it started
  if (result.cancelled) { toast(`${zip ? 'Zip' : 'Materialize'} cancelled. The half-finished ${zip ? 'zip' : 'folder'} was removed.`, 4500); return; }
  // Remember where it went, so the project's menu can show it in Explorer later.
  p.exports = [{ mode: zip ? 'zip' : 'copy', dest: result.dest, at: Date.now(), count: result.count },
    ...(p.exports || []).filter(x => lowPath(x.dest) !== lowPath(result.dest))].slice(0, 12);
  saveProjects();
  renderProjBanner();
  if (repoint && result.copies.length) {
    const map = new Map(result.copies.map(c => [lowPath(c.from), c.to]));
    for (const r of p.items) { const to = map.get(lowPath(r.path)); if (to) r.path = to; }
    if (result.newLibrary && !S.libs.some(l => l.id === result.newLibrary.id)) {
      S.libs.push(result.newLibrary);
      S.recs[result.newLibrary.id] = [];
      S.trees.set(result.newLibrary.id, buildTree([]));
      renderTree();
    }
    saveProjects();
    applyFilters({ keepScroll: true });
  }
}

async function deleteProject(p) {
  const card = await modal({
    title: `Delete project “${p.name}”?`,
    sub: `Only the project is deleted. The ${p.items.length.toLocaleString()} sound${p.items.length === 1 ? '' : 's'} in it stay exactly where they are.`,
    ok: 'Delete project', okClass: 'danger',
  });
  if (!card) return;
  S.projects = S.projects.filter(x => x !== p);
  if (S.scope.type === 'proj' && S.scope.id === p.id) S.scope = { type: 'all' };
  if (prefs.lastProject === p.id) { prefs.lastProject = null; savePrefs(); }
  saveProjects();
  renderTree();
  applyFilters();
}

// Names of the search / filters currently narrowing the list.
function activeFilters() {
  const f = [];
  if (S.query) f.push('the search');
  if (S.types.size) f.push(S.types.size === 1 ? `the ${TYPE_LABELS[[...S.types][0]]} category` : 'categories');
  if (S.classes.size) f.push('Sound Type');
  if (S.sr) f.push('rate');
  if (S.dur) f.push('length');
  return f.length ? f : ['filters'];
}

// Clears the search box and every filter (category, Sound Type, rate, length).
function clearAllFilters() {
  S.query = '';
  $('#search').value = '';
  S.types.clear();
  S.sr = '';
  $('#f-sr').value = '';
  S.dur = '';
  $('#f-dur').value = '';
  $('#dur-custom').hidden = true;
  if (S.classes.size) $('#dd-type-menu [data-act="none"]').click(); // also redraws the Sound Type button
  applyFilters();
}

function renderProjBanner() {
  const b = $('#proj-banner');
  const p = S.scope.type === 'proj' ? projectById(S.scope.id) : null;
  if (!p) { b.hidden = true; return; }
  b.hidden = false;
  const miss = missingRefs(p).length;
  // A search or filter still applies inside a project: say how many of its sounds it hides.
  const listed = S.view.filter(it => !it.isMissing && !it.isFolder).length;
  const hidden = Math.max(0, p.items.length - miss - listed);
  const size = projectBytes(p).bytes;
  b.innerHTML = `<span>Project <b>${escapeHtml(p.name)}</b> · ${p.items.length.toLocaleString()} sound${p.items.length === 1 ? '' : 's'} · <b title="How much disk space a Materialize (or Zip) of this project would take">${fmtBytes(size)}</b>${miss ? ` · <span class="warn">${miss} missing</span>` : ''}${hidden ? ` · <span class="warn">${hidden.toLocaleString()} hidden by ${activeFilters().join(', ')}</span>` : ''}</span>
    ${hidden ? '<button data-a="clearf" title="Clear the search and every filter so the whole project is listed">Show all</button>' : ''}
    <span class="grow">${p.items.length ? '' : 'This project is empty. Right-click sounds → <i>Add to project</i>, right-click a category → <i>Add all to project</i>, drag sounds onto the project, or press <b>P</b> while previewing.'}</span>
    ${miss ? '<button data-a="relink" title="Find moved or renamed files again by name and size">Relink missing</button>' : ''}
    ${(p.exports || []).length ? '<button data-a="where" title="Open a folder or zip this project was materialized / zipped to">Show exports ▾</button>' : ''}
    <button data-a="zip" title="Pack every sound into one .zip">Zip…</button>
    <button data-a="mat" class="primary" title="Copy every sound into a real folder">Materialize…</button>`;
  b.querySelector('[data-a=zip]').addEventListener('click', () => exportProject(p, 'zip'));
  b.querySelector('[data-a=mat]').addEventListener('click', () => exportProject(p, 'copy'));
  b.querySelector('[data-a=relink]')?.addEventListener('click', () => relinkProject(p));
  b.querySelector('[data-a=clearf]')?.addEventListener('click', clearAllFilters);
  b.querySelector('[data-a=where]')?.addEventListener('click', async () => {
    const pick = await api.menu(exportsMenu(p));
    if (pick) openExport(p, pick);
  });
}

// "Show in Explorer" entries for the folders / zips a project was materialized or zipped to.
function exportsMenu(p) {
  const fmt = t => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const list = p.exports || [];
  const sub = list.map((x, i) => ({ id: 'exp:' + i, label: `${x.mode === 'zip' ? 'Zip' : 'Folder'}: ${x.dest}   (${fmt(x.at)})` }));
  if (sub.length) sub.push({ type: 'separator' }, { id: 'exp:clear', label: 'Clear this list (files are not touched)' });
  return sub;
}

async function openExport(p, pick) {
  if (pick === 'exp:clear') { p.exports = []; saveProjects(); renderProjBanner(); return; }
  const x = (p.exports || [])[Number(pick.slice(4))];
  if (!x) return;
  const ok = await api.showExport(x.dest, x.mode === 'zip');
  if (!ok) toast(`Couldn’t find ${x.dest}. It may have been moved, renamed or deleted.`, 5000);
}

// "Add to project ▸" submenu entries.
function projectMenu(it) {
  const inIt = new Set((S.projIndex.get(lowPath(it.path)) || []).map(p => p.id));
  const sub = [...S.projects].sort((a, b) => collator.compare(a.name, b.name))
    .map(p => ({ id: 'proj:' + p.id, label: `${inIt.has(p.id) ? '✓  ' : ''}${p.name}`, enabled: !inIt.has(p.id) }));
  if (sub.length) sub.push({ type: 'separator' });
  sub.push({ id: 'proj:new', label: 'New project…' });
  return { label: 'Add to project', submenu: sub };
}

(() => {
  const box = $('#projects');
  $('#add-proj').addEventListener('click', e => { e.stopPropagation(); newProject(); });
  $('#proj-title').addEventListener('click', e => {
    if (e.target.closest('#add-proj')) return;
    prefs.projCollapsed = !prefs.projCollapsed;
    applySidebarPrefs();
    savePrefs();
  });
  box.addEventListener('click', e => {
    const row = e.target.closest('.proj-row[data-id]');
    if (row && !e.target.closest('input')) openProject(projectById(row.dataset.id));
  });
  box.addEventListener('contextmenu', async e => {
    e.preventDefault();
    const row = e.target.closest('.proj-row[data-id]');
    if (!row) return;
    const p = projectById(row.dataset.id);
    const viewingOther = !(S.scope.type === 'proj' && S.scope.id === p.id);
    const listed = viewingOther ? S.view.filter(it => !it.zip && !it.isFolder && !it.isMissing) : [];
    const items = [
      { id: 'open', label: 'Open' },
      { id: 'rename', label: 'Rename…' },
      { type: 'separator' },
      { id: 'zip', label: 'Zip…', enabled: p.items.length > 0 },
      { id: 'mat', label: 'Materialize…', enabled: p.items.length > 0 },
      { id: 'relink', label: 'Relink missing files', enabled: missingRefs(p).length > 0 },
    ];
    if ((p.exports || []).length) {
      const latest = p.exports.find(x => x.mode === 'copy') || p.exports[0];
      items.push({ type: 'separator' },
        { id: 'exp:' + p.exports.indexOf(latest), label: latest.mode === 'zip' ? 'Show zip in Explorer' : 'Show materialized folder in Explorer' });
      if (p.exports.length > 1) items.push({ label: 'All exports', submenu: exportsMenu(p) });
    }
    if (listed.length) items.push({ type: 'separator' }, { id: 'addall', label: `Add all ${listed.length.toLocaleString()} listed sounds` });
    items.push({ type: 'separator' }, { id: 'del', label: 'Delete project (sounds are not touched)' });
    const pick = await api.menu(items);
    if (pick === 'open') openProject(p);
    else if (pick === 'rename') { const n = await askName(p.name, row); if (n) { p.name = n; saveProjects(); renderProjBanner(); } else renderProjects(); }
    else if (pick === 'zip') exportProject(p, 'zip');
    else if (pick === 'mat') exportProject(p, 'copy');
    else if (pick === 'relink') relinkProject(p);
    else if (pick === 'addall') addToProject(p, listed);
    else if (pick === 'del') deleteProject(p);
    else if (pick && pick.startsWith('exp:')) openExport(p, pick);
  });
  // Drop sounds (dragged from the list, or from Explorer) onto a project.
  const rowAt = e => e.target.closest && e.target.closest('.proj-row[data-id]');
  box.addEventListener('dragover', e => {
    const row = rowAt(e);
    if (!row || !e.dataTransfer.types.includes('Files')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    box.querySelectorAll('.proj-row.drop').forEach(r => r !== row && r.classList.remove('drop'));
    row.classList.add('drop');
  });
  box.addEventListener('dragleave', e => { const row = rowAt(e); if (row && !row.contains(e.relatedTarget)) row.classList.remove('drop'); });
  box.addEventListener('drop', e => {
    const row = rowAt(e);
    if (!row) return;
    e.preventDefault();
    row.classList.remove('drop');
    const byPath = itemsByPath();
    const found = [], outside = [];
    for (const f of e.dataTransfer.files) {
      const p = api.pathForFile(f);
      if (!p) continue;
      const it = byPath.get(lowPath(p));
      if (it) found.push(it); else outside.push(p);
    }
    const p = projectById(row.dataset.id);
    if (found.length) addToProject(p, found, !!outside.length);
    if (outside.length) toast(`${found.length ? `Added ${found.length} · ` : ''}${outside.length} file${outside.length === 1 ? ' isn’t' : 's aren’t'} in a linked library, so ${outside.length === 1 ? 'it' : 'they'} can’t be added. Link the folder under Libraries first.`, 5000);
  });
  // Don't let a stray drop anywhere else navigate the window.
  window.addEventListener('dragover', e => { if (!rowAt(e)) e.preventDefault(); });
  window.addEventListener('drop', e => { if (!rowAt(e)) e.preventDefault(); });
})();

api.on('export:progress', p => {
  S.exportProgress = p.finished ? null : p;
  renderScanStatus();
});

// ------------------------------------------------------------------ online tab
const LIC_INFO = { cc0: { label: 'CC0', credit: false }, pd: { label: 'Public domain', credit: false }, epidemic: { label: 'Epidemic', credit: false }, by: { label: 'CC BY', credit: true }, 'by-sa': { label: 'CC BY-SA', credit: true } };
const ipcMessage = err => String((err && err.message) || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

// How much listening to a result downloads (0 = unknown, usually a small MP3 preview).
const previewBytes = r => r.previewSize || (r.previewIsOriginal ? r.size || 0 : 0);

function setDownloads(map) {
  S.downloads = map || {};
  S.downloadsByPath = new Map(Object.values(S.downloads).map(d => [lowPath(d.path), d]));
}

// A player item for an online result whose file (preview or saved copy) is now on disk.
function onlineItem(r, file) {
  const ext = file.slice(file.lastIndexOf('.') + 1).toLowerCase();
  const it = {
    lib: { id: 'online', name: r.sourceLabel, path: '', fourCh: 'auto' },
    rec: { rel: `${r.title}.${ext}`, size: 0, ch: r.ch || 2, sr: r.sr || 0, bits: r.bits || 0, dur: r.duration || 0, desc: r.desc || '' },
    path: file, name: r.title, ext, folder: '', zip: false, online: r,
  };
  assignLayout(it);
  return it;
}

// Plays your saved copy if there is one, otherwise fetches the preview, then loads it into the player.
async function loadOnline(r, { play = false } = {}) {
  if (S.current && S.current.online && S.current.online.key === r.key) {
    if (play && S.source) { S.selection = null; wave.setSelection(null); startPlay(0); }
    else if (play) S.playOnLoad = S.current;
    return;
  }
  const tok = ++S.onlineTok;
  S.token++; // drop any load still in flight
  engine.stop();
  S.current = null; S.source = null; S.layout = null; S.info = null; S.selection = null;
  $('#zip-panel').hidden = true;
  S.loadingKey = r.key;
  wave.clear('Loading preview…');
  speakers.setLayout(null);
  fillLayoutSelect();
  $('#file-meta').innerHTML = `<div class="fname">${escapeHtml(r.title)}</div>`;
  let file = null;
  const dl = S.downloads[r.key];
  if (dl && await api.probe(dl.path).catch(() => null)) file = dl.path;
  // Some "previews" are the full original (Internet Archive recordings can be several GB): ask first.
  const pb = previewBytes(r);
  if (!file && pb > safety().previewMB * MB) {
    const ok = await modal({
      title: `Download ${fmtBytes(pb)} to listen?`,
      sub: `There's no small preview of “${escapeHtml(r.title)}”: listening means downloading the whole ${fmtBytes(pb)} file first. It's kept in Soundfield's preview cache, so Save won't download it again.`,
      ok: 'Download and listen',
    });
    if (tok !== S.onlineTok) return;
    if (!ok) { wave.clear(`Preview not downloaded (${fmtBytes(pb)})`); S.loadingKey = null; return; }
  }
  try { if (!file) file = await api.online.preview(r); }
  catch (err) {
    if (tok === S.onlineTok) wave.clear('Couldn’t load the preview. Check your internet connection.');
    return;
  }
  if (tok !== S.onlineTok) return;
  S.loadingKey = null;
  await loadItem(onlineItem(r, file), { play });
}

// Downloads into Documents\Soundfield Downloads (credited in Credits.txt).
async function saveOnline(r) {
  if (r.size > safety().saveMB * MB && !S.downloads[r.key]) {
    const ok = await modal({
      title: `Save a ${fmtBytes(r.size)} file?`,
      sub: `“${escapeHtml(r.title)}” is ${fmtBytes(r.size)}. It goes into ${escapeHtml(onlineUI.destLabel())}; the free space there is checked first.`,
      ok: 'Save it',
    });
    if (!ok) return null;
  }
  try {
    const entry = await api.online.download(r, S.saveDir);
    if (entry && entry.cancelled) return null; // didn't fit (Soundfield already said so)
    S.downloads[r.key] = entry;
    setDownloads(S.downloads);
    onlineUI.refresh();
    if (S.current && S.current.online && S.current.online.key === r.key) renderMeta();
    if (!entry.already) {
      toast(`Saved “${r.title}” to ${onlineUI.destLabel()}${entry.quality === 'preview' ? ' · preview quality (connect a Freesound account for originals)' : ''}`, 5000);
    }
    return entry;
  } catch (err) {
    toast(`Couldn’t save “${r.title}”: ${ipcMessage(err)}`, 6000);
    return null;
  }
}

// Dragging an online sound into a DAW needs a real file, so it's saved first.
async function onlineDrag() {
  const r = S.current.online;
  const dl = S.downloads[r.key];
  if (dl) { api.startDrag(dl.path, null); return; }
  toast('Saving it first…', 20000);
  if (await saveOnline(r)) toast('Saved. Now drag it into your DAW.', 3500);
}

function setMode(mode) {
  S.mode = mode;
  $('#app').classList.toggle('online', mode === 'online');
  $('#online').hidden = mode !== 'online';
  $('#online-bar').hidden = mode !== 'online';
  for (const b of document.querySelectorAll('#tabs button')) b.classList.toggle('on', b.dataset.mode === mode);
  prefs.mode = mode;
  savePrefs();
  if (mode === 'online') onlineUI.show(); else listEl.focus();
}

const onlineUI = createOnline({ api, S, prefs, savePrefs, toast, modal, escapeHtml, fmtTime, fmtBytes, ipcMessage, loadOnline, saveOnline, LIC_INFO, previewBytes });
document.querySelectorAll('#tabs button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
// Anything picked in the sidebar belongs to the library.
$('#sidebar').addEventListener('click', e => {
  if (S.mode === 'online' && e.target.closest('.side-item, .tree-row, .proj-row')) setMode('library');
}, true);
api.on('online:progress', p => onlineUI.progress(p));
api.on('app:toast', msg => toast(String(msg), 6000));
api.on('preview:progress', p => {
  if (p.key !== S.loadingKey || S.current || !p.total) return;
  wave.clear(`Loading preview… ${Math.min(99, Math.round((p.got / p.total) * 100))}%`);
});

// ------------------------------------------------------------------ settings
const ROW_H = { compact: 22, normal: 26, roomy: 32 };
function applyRowDensity() {
  const h = ROW_H[prefs.rowDensity] || 26;
  document.documentElement.style.setProperty('--row-h', h + 'px');
  list.setRowHeight(h);
  onlineUI.setRowHeight(h);
}
// Applies a setting changed in the Settings panel (it has already been saved in prefs).
function applySetting(key, v) {
  switch (key) {
    case 'autoplay': setToggle('#btn-auto', !!v); break;
    case 'loop': setToggle('#btn-loop', !!v); engine.setLoop(!!v); break;
    case 'lfe': setToggle('#btn-lfe', !!v); engine.setLfe(!!v); break;
    case 'monitor': $('#monitor').value = v; engine.setMode(v); updateMonitorHint(); break;
    case 'dbFloor': wave.setDbFloor(v); break;
    case 'peakWarnDb': wave.setPeakWarn(v); break;
    case 'uiZoom': api.setZoom(v); break;
    case 'rowDensity': applyRowDensity(); break;
    case 'onlineSaveDir': onlineUI.setSaveDir(v || null, true); break;
    case 'outputDevice': engine.setSink(v).then(ok => { if (!ok) toast('That output device can’t be used right now; playing through the Windows default.', 5000); }); break;
  }
}

// The saved output device, if it's connected; otherwise the Windows default (the choice is kept
// for when it's plugged back in).
async function applyOutputDevice() {
  const id = prefs.outputDevice;
  if (!id) return;
  let devs = [];
  try { devs = await navigator.mediaDevices.enumerateDevices(); } catch {}
  const d = devs.find(x => x.kind === 'audiooutput' && x.deviceId === id);
  if (d) engine.setSink(id);
  else toast('Your chosen output device isn’t connected, so Soundfield is using the Windows default.', 5000);
}
const settingsUI = createSettings({
  api, prefs, savePrefs, apply: applySetting, toast, escapeHtml, fmtBytes,
  actions: {
    prettyDir, setDupExcluded, showAbout,
    accountStatus: which => onlineUI.accountStatus(which),
    openAccount: which => onlineUI.openAccount(which),
  },
});
$('#btn-settings').addEventListener('click', () => settingsUI.open());
document.addEventListener('keydown', e => { if (e.ctrlKey && e.key === ',') { e.preventDefault(); settingsUI.open(); } });

// Problems in this window go to the problem log (Settings → About → Copy problem report).
window.addEventListener('error', e => api.logProblem(`${e.message} at ${e.filename}:${e.lineno}`));
window.addEventListener('unhandledrejection', e => api.logProblem(`Unhandled: ${(e.reason && (e.reason.stack || e.reason.message)) || e.reason}`));

// ------------------------------------------------------------------ toast
let toastTimer = 0;
function toast(msg, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}

// ------------------------------------------------------------------ about + what's new
const releaseHtml = rs => rs.map(r => `<div class="wn"><div class="wn-v">${escapeHtml(r.version)}<span>${escapeHtml(r.date)}</span></div>
  <ul>${r.items.map(i => `<li>${escapeHtml(i)}</li>`).join('')}</ul></div>`).join('');

let appInfo = null;
const getAppInfo = async () => (appInfo ||= await api.appInfo().catch(() => null));

async function showAbout() {
  const info = await getAppInfo() || {};
  const built = info.builtAt ? new Date(info.builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not a packaged build (running from the source folder)';
  const card = modal({
    title: 'About Soundfield',
    body: `<dl class="about">
        <dt>Version</dt><dd>${escapeHtml(info.version || '?')}</dd>
        <dt>Built</dt><dd>${escapeHtml(built)}</dd>
        ${info.commit ? `<dt>Code</dt><dd>${escapeHtml(info.commit)}</dd>` : ''}
        <dt>Data folder</dt><dd>${escapeHtml(info.dataDir || '')} · <a data-x="data">Open</a></dd>
        <dt>Project</dt><dd><a data-x="gh">github.com/ghostspectrogram/soundfield</a></dd>
      </dl>
      <h4 class="wn-h">What’s new</h4><div class="wn-list">${releaseHtml(RELEASES)}</div>`,
    ok: 'Close', cancel: null,
  });
  const el = document.querySelector('#modal .modal-card');
  el.classList.add('wide');
  el.addEventListener('click', e => {
    const x = e.target.closest('[data-x]');
    if (!x) return;
    if (x.dataset.x === 'data') api.openDataDir();
    else if (x.dataset.x === 'gh') api.openExternal('https://github.com/ghostspectrogram/soundfield');
  });
  await card;
}
$('.brand').addEventListener('click', showAbout);
$('.brand').title = 'About Soundfield: version and what’s new';

// Once per update: what changed since the version you last opened.
async function showWhatsNew() {
  const info = await getAppInfo();
  if (!info || prefs.lastSeenVersion === info.version) return;
  const rs = unseenReleases(prefs.lastSeenVersion).filter(r => r.items.length);
  prefs.lastSeenVersion = info.version;
  savePrefs();
  if (!rs.length) return;
  const card = modal({ title: `What’s new in Soundfield ${info.version}`, body: `<div class="wn-list">${releaseHtml(rs)}</div>`, ok: 'Got it', cancel: null });
  document.querySelector('#modal .modal-card').classList.add('wide');
  await card;
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
  S.projects = Array.isArray(st.projects) ? st.projects : [];
  setDownloads(st.downloads);
  rebuildProjIndex();
  applySidebarPrefs();
  rebuildItems();
  renderTree();
  renderProjects();
  applyFilters();
  if (S.libs.length) listEl.focus();
  const start = prefs.startupTab || 'last';
  if (start === 'online' || (start === 'last' && prefs.mode === 'online')) setMode('online');
  // Settings that shape the view.
  wave.setDbFloor(prefs.dbFloor);
  if (prefs.peakWarnDb != null) wave.setPeakWarn(prefs.peakWarnDb);
  if (prefs.uiZoom && prefs.uiZoom !== 1) api.setZoom(prefs.uiZoom);
  if (prefs.rowDensity && prefs.rowDensity !== 'normal') applyRowDensity();
  if (prefs.onlineSaveDir) onlineUI.setSaveDir(prefs.onlineSaveDir, true);
  applyOutputDevice();
  window.__sf = { S, engine, wave, selectIndex, applyFilters, setDupExcluded, prefs, savePrefs, openFolder, goUp, folderChain, excludingFolder, extraCopies,
    addToProject, removeFromProject, relinkProject, openProject, projectById, exportProject, renderProjects, saveProjects, setMode, onlineUI, loadOnline,
    findDupes, showAbout, settingsUI, applySetting, bootMs: Math.round(performance.now()) }; // handy for debugging (F12) and used by tools/test.js
  showWhatsNew();
}
boot();
