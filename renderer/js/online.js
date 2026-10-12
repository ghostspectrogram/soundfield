// The Online tab has two modes:
//   Soundfield search: sounds you can preview and save straight into Soundfield
//                      (Freesound and Wikimedia Commons, through their official APIs).
//   Website search:    sound sites that open your search in the browser, because
//                      they don't let other apps search them.
import { VList } from './vlist.js';

const enc = encodeURIComponent;
const slug = q => q.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
// terms: free = free, no credit · credit = free with credit · varies = check each sound · paid = subscription / paid · personal = not for commercial work
const SITES = [
  { group: 'free', name: 'Freesound', about: 'Huge community library of field recordings and effects.', terms: 'varies', note: 'Free. Each sound is CC0, CC BY or CC BY-NC (non-commercial): check before using. Soundfield search shows only the ones safe for any use.', url: q => `https://freesound.org/search/?q=${enc(q)}` },
  { group: 'free', name: 'Pixabay', about: 'Free sound effects and music.', terms: 'free', note: 'Pixabay Content License: free for commercial use, no credit needed.', url: q => (q ? `https://pixabay.com/sound-effects/search/${enc(q)}/` : 'https://pixabay.com/sound-effects/') },
  { group: 'free', name: 'Mixkit', about: 'Small curated set of free effects.', terms: 'free', note: 'Mixkit Sound Effects Free License: free for commercial use, no credit needed.', url: q => (q ? `https://mixkit.co/free-sound-effects/discover/${slug(q)}/` : 'https://mixkit.co/free-sound-effects/') },
  { group: 'free', name: 'Zapsplat', about: 'Large free library (free account to download).', terms: 'credit', note: 'Free with credit to Zapsplat; no credit needed on their paid plans. Their own licence, not Creative Commons.', url: q => `https://www.zapsplat.com/?s=${enc(q)}` },
  { group: 'free', name: 'Uppbeat', about: 'Free effects and music (free account).', terms: 'credit', note: 'Free plan needs credit to Uppbeat; paid plan doesn’t. Check their licence terms.', url: q => `https://uppbeat.io/sfx/search?query=${enc(q)}` },
  { group: 'free', name: 'SoundBible', about: 'Older free collection.', terms: 'varies', note: 'The licence differs per sound (public domain, CC BY, or personal use only): check each one.', url: q => `https://soundbible.com/search.php?q=${enc(q)}` },
  { group: 'free', name: 'Sound Gator', about: 'Free effects (free account to download).', terms: 'varies', note: 'Needs a free account to download. Check their licence terms.', url: q => `https://www.soundgator.com/search/?q=${enc(q)}` },
  { group: 'free', name: 'Wikimedia Commons', about: 'Archive and field recordings.', terms: 'varies', note: 'Licence differs per file. Soundfield search shows only the ones safe for any use.', url: q => `https://commons.wikimedia.org/w/index.php?title=Special:MediaSearch&type=audio&search=${enc(q)}` },
  { group: 'free', name: 'Internet Archive', about: 'Field recordings, soundscapes and sound packs.', terms: 'varies', note: 'Licence differs per upload. Soundfield search shows only the CC0 / public-domain ones.', url: q => `https://archive.org/search?query=${enc(q)}&and%5B%5D=mediatype%3A%22audio%22` },
  { group: 'free', name: '99Sounds', about: 'Free sound packs (whole-pack downloads).', terms: 'free', note: 'Royalty-free packs. Download a pack, then link its folder as a library.', url: q => `https://99sounds.org/?s=${enc(q)}` },
  { group: 'free', name: 'Sonniss GDC bundles', about: 'Huge free professional packs, released yearly.', terms: 'free', note: 'Royalty-free, commercial use allowed, no credit needed. Download the zips, then link the folder as a library.', url: () => 'https://sonniss.com/gameaudiogdc/' },
  { group: 'paid', name: 'Epidemic Sound', about: 'Your subscription.', terms: 'paid', note: 'Covered by your Epidemic subscription. Sign in on their site.', url: q => `https://www.epidemicsound.com/sound-effects/search/?term=${enc(q)}` },
  { group: 'paid', name: 'Artlist', about: 'Subscription effects library.', terms: 'paid', note: 'Needs an Artlist subscription.', url: q => `https://artlist.io/sfx/search?terms=${enc(q)}` },
  { group: 'paid', name: 'Envato Elements', about: 'Subscription library.', terms: 'paid', note: 'Needs an Envato Elements subscription.', url: q => (q ? `https://elements.envato.com/sound-effects/${slug(q)}` : 'https://elements.envato.com/sound-effects') },
  { group: 'paid', name: 'Storyblocks', about: 'Subscription library.', terms: 'paid', note: 'Needs a Storyblocks subscription.', url: q => `https://www.storyblocks.com/audio/search/${enc(q)}?media-type=sound-effects` },
  { group: 'paid', name: 'Soundsnap', about: 'Professional effects library.', terms: 'paid', note: 'Needs a Soundsnap subscription.', url: q => `https://www.soundsnap.com/search/audio?query=${enc(q)}` },
  { group: 'personal', name: 'BBC Sound Effects', about: 'The BBC archive.', terms: 'personal', note: 'Personal, educational and research use only. NOT for commercial work.', url: q => `https://sound-effects.bbcrewind.co.uk/search?q=${enc(q)}` },
];
const TERMS = {
  free: ['Free · no credit', 'ok'],
  credit: ['Free · credit needed', 'credit'],
  varies: ['Licence per sound', 'varies'],
  paid: ['Subscription', 'paid'],
  personal: ['Personal use only', 'personal'],
};
const GROUPS = [['free', 'Free sites'], ['paid', 'Subscription sites'], ['personal', 'Not for commercial work']];

const FILE_TYPES = ['wav', 'aiff', 'flac', 'mp3', 'ogg'];
const LIC_NAMES = { cc0: 'Creative Commons 0 (public domain)', pd: 'Public domain', by: 'Creative Commons Attribution', 'by-sa': 'Creative Commons Attribution-ShareAlike' };
const LIC_TIPS = {
  cc0: 'CC0: use it anywhere, change it, no credit needed.',
  pd: 'Public domain: use it anywhere, change it, no credit needed.',
  by: 'CC BY: use it anywhere, including paid work. You must credit the creator (Soundfield writes the credit line to Credits.txt).',
  'by-sa': 'CC BY-SA: use it anywhere with credit, but anything you make from it must be shared under the same licence. Often impractical for film/game work.',
};

export function createOnline(ctx) {
  const { api, S, prefs, savePrefs, toast, modal, escapeHtml, fmtTime, ipcMessage, loadOnline, saveOnline, LIC_INFO } = ctx;
  const $ = s => document.querySelector(s);
  const O = { query: '', page: 1, results: [], view: [], seen: new Set(), more: {}, errors: {}, totals: {}, via: '', loading: false, tok: 0, progress: new Map(), sort: null, settings: null };

  const listEl = $('#o-list');
  listEl.tabIndex = 0;
  const list = new VList(listEl, { rowHeight: 26, render: renderRow });
  const input = $('#o-search');

  // ---------------------------------------------------------------- filters
  // File type: a multi-select like Sources. Searches re-run when it changes.
  const ftMenu = $('#dd-ftype-menu'), ftBtn = $('#dd-ftype-btn');
  if (Array.isArray(prefs.onlineTypes)) ftMenu.querySelectorAll('input').forEach(i => { i.checked = prefs.onlineTypes.includes(i.value); });
  const fileTypes = () => [...ftMenu.querySelectorAll('input:checked')].map(i => i.value);
  const ftLabel = () => {
    const t = fileTypes();
    const all = t.length === FILE_TYPES.length;
    ftBtn.querySelector('.dd-label').textContent = all ? 'File type' : t.length ? `File type: ${t.map(x => x.toUpperCase()).join(', ')}` : 'File type: none';
    ftBtn.classList.toggle('on', !all);
  };
  ftLabel();
  ftBtn.addEventListener('click', e => { e.stopPropagation(); const open = ftMenu.hidden; ftMenu.hidden = !open; ftBtn.classList.toggle('open', open); ftBtn.setAttribute('aria-expanded', open); });
  document.addEventListener('mousedown', e => { if (!ftMenu.hidden && !e.target.closest('#dd-ftype')) { ftMenu.hidden = true; ftBtn.classList.remove('open'); } });
  const ftChanged = () => { prefs.onlineTypes = fileTypes(); savePrefs(); ftLabel(); if (O.query) runSearch(true); };
  ftMenu.addEventListener('change', ftChanged);
  ftMenu.addEventListener('click', e => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    ftMenu.querySelectorAll('input').forEach(i => { i.checked = act.dataset.act === 'all' || ['wav', 'aiff', 'flac'].includes(i.value); });
    ftChanged();
  });

  const srcMenu = $('#dd-src-menu'), srcBtn = $('#dd-src-btn');
  if (Array.isArray(prefs.onlineSources)) srcMenu.querySelectorAll('input').forEach(i => { i.checked = prefs.onlineSources.includes(i.value) || !(prefs.onlineKnownSources || ['freesound', 'commons']).includes(i.value); });
  prefs.onlineKnownSources = [...srcMenu.querySelectorAll('input')].map(i => i.value);
  const sources = () => [...srcMenu.querySelectorAll('input:checked')].map(i => i.value);
  const srcLabel = () => {
    const s = sources();
    const all = srcMenu.querySelectorAll('input').length;
    srcBtn.querySelector('.dd-label').textContent = s.length === all ? 'Sources' : s.length ? `Sources: ${s.length === 1 ? srcMenu.querySelector('input:checked + span').textContent : s.length}` : 'Sources: none';
    srcBtn.classList.toggle('on', s.length !== all);
  };
  srcLabel();
  srcBtn.addEventListener('click', e => { e.stopPropagation(); const open = srcMenu.hidden; srcMenu.hidden = !open; srcBtn.classList.toggle('open', open); srcBtn.setAttribute('aria-expanded', open); });
  document.addEventListener('mousedown', e => { if (!srcMenu.hidden && !e.target.closest('#dd-src')) { srcMenu.hidden = true; srcBtn.classList.remove('open'); } });
  srcMenu.addEventListener('change', () => { prefs.onlineSources = sources(); savePrefs(); srcLabel(); if (O.query) runSearch(true); });

  $('#o-settings').addEventListener('click', settingsDialog);

  // ---------------------------------------------------------------- save folder (this session)
  // Starts at Documents\Soundfield Downloads every launch; recently used folders are remembered.
  let defaultDir = '';
  api.online.defaultDir().then(d => { defaultDir = d; renderDest(); });
  const baseName = p => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p : 'Soundfield Downloads');
  const destLabel = () => (S.saveDir ? `“${baseName(S.saveDir)}”` : 'Soundfield Downloads');
  function renderDest() {
    const b = $('#o-dest-btn');
    $('#o-dest-name').textContent = S.saveDir ? baseName(S.saveDir) : 'Soundfield Downloads';
    b.classList.toggle('custom', !!S.saveDir);
    b.title = `Saving to ${S.saveDir || (defaultDir ? defaultDir + '\\<Source>' : 'Documents\\Soundfield Downloads')}\nClick to change`;
  }
  function setSaveDir(dir, quiet) {
    S.saveDir = dir && (!defaultDir || dir.toLowerCase() !== defaultDir.toLowerCase()) ? dir : null;
    if (S.saveDir) {
      prefs.onlineRecentDirs = [S.saveDir, ...(prefs.onlineRecentDirs || []).filter(d => d.toLowerCase() !== S.saveDir.toLowerCase())].slice(0, 8);
      savePrefs();
    }
    renderDest();
    if (!quiet) toast(`Soundfield search now saves to ${S.saveDir || (defaultDir || 'Soundfield Downloads')}`, 3500);
  }
  $('#o-dest-btn').addEventListener('click', async () => {
    const recent = (prefs.onlineRecentDirs || []).filter(d => !S.saveDir || d.toLowerCase() !== S.saveDir.toLowerCase());
    const live = [];
    for (const d of recent) if (await api.exists(d)) live.push(d);
    const items = [
      { id: '', label: `Saving to: ${S.saveDir || (defaultDir ? defaultDir + '\\<Source>' : 'Soundfield Downloads')}`, enabled: false },
      { type: 'separator' },
      { id: 'pick', label: 'Choose folder…' },
      { id: 'default', label: `${S.saveDir ? '' : '✓  '}Soundfield Downloads (default)` },
    ];
    if (live.length) items.push({ type: 'separator' }, { id: '', label: 'Recent folders', enabled: false }, ...live.map((d, i) => ({ id: 'r' + i, label: d })));
    items.push({ type: 'separator' }, { id: 'reveal', label: 'Show save folder in Explorer' });
    const pick = await api.menu(items);
    if (pick === 'pick') { const d = await api.online.pickFolder(S.saveDir || defaultDir); if (d) setSaveDir(d); }
    else if (pick === 'default') setSaveDir(null);
    else if (pick === 'reveal') {
      const d = S.saveDir || defaultDir;
      if (await api.exists(d)) api.showExport(d, false); else toast('Nothing saved there yet.');
    } else if (pick && pick[0] === 'r') setSaveDir(live[Number(pick.slice(1))]);
  });

  // ---------------------------------------------------------------- Soundfield search / Website search
  const web = () => prefs.onlineMode === 'web';
  function setOMode(m) {
    prefs.onlineMode = m;
    savePrefs();
    applyOMode();
  }
  function applyOMode() {
    const w = web();
    document.getElementById('app').classList.toggle('web-search', w);
    document.querySelectorAll('#o-modes [data-omode]').forEach(b => b.classList.toggle('on', (b.dataset.omode === 'web') === w));
    $('#o-mode-hint').textContent = w
      ? 'Sound sites that open your search in your browser. Hover a site for its licence terms.'
      : 'Sounds you can preview here and save straight into Soundfield, only attribution-free (CC0 and public domain).';
    input.placeholder = w ? 'Search sound sites…  e.g.  bees' : 'Search free sound effects, then press Enter…  e.g.  bees';
    $('#o-web').hidden = !w;
    $('#o-header').hidden = w;
    listEl.hidden = w;
    if (w) renderWeb();
    render();
  }
  $('#o-modes').addEventListener('click', e => { const b = e.target.closest('[data-omode]'); if (b) setOMode(b.dataset.omode); });

  function renderWeb() {
    const q = input.value.trim();
    $('#o-web').innerHTML = GROUPS.map(([g, title]) => {
      const rows = SITES.map((s, i) => [s, i]).filter(([s]) => s.group === g);
      return `<h4>${title}</h4>` + rows.map(([s, i]) => {
        const [label, cls] = TERMS[s.terms];
        return `<div class="web-row" data-site="${i}" title="${escapeHtml(s.note)}">
          <b>${escapeHtml(s.name)}</b><span class="about">${escapeHtml(s.about)}</span>
          <span class="terms ${cls}">${label}</span>
          <button class="go">${q ? `Search “${escapeHtml(q.length > 24 ? q.slice(0, 23) + '…' : q)}”` : 'Open site'} ↗</button></div>`;
      }).join('');
    }).join('');
  }
  $('#o-web').addEventListener('click', e => {
    const row = e.target.closest('[data-site]');
    if (row) api.openExternal(SITES[Number(row.dataset.site)].url(input.value.trim()));
  });
  input.addEventListener('input', () => { if (web()) renderWeb(); });

  // ---------------------------------------------------------------- search
  async function runSearch(reset) {
    const q = reset ? input.value.trim() : O.query;
    if (!q) return;
    if (O.loading && !reset) return;
    const srcs = reset ? sources() : Object.keys(O.more).filter(k => O.more[k]);
    if (!srcs.length) { if (reset) toast('Pick at least one source (Sources ▾).'); return; }
    if (!fileTypes().length) { if (reset) toast('Pick at least one file type (File type ▾).'); return; }
    if (reset) {
      Object.assign(O, { query: q, page: 1, results: [], seen: new Set(), more: {}, errors: {}, totals: {} });
      listEl.scrollTop = 0;
      list.select(-1, false);
    } else O.page++;
    const tok = ++O.tok;
    O.loading = true;
    render();
    let res;
    try {
      res = await api.online.search({ query: q, page: O.page, sources: srcs, licenses: ['cc0', 'pd'], types: fileTypes() });
    } catch (err) {
      if (tok !== O.tok) return;
      O.loading = false;
      O.errors = { search: ipcMessage(err) };
      render();
      return;
    }
    if (tok !== O.tok) return;
    for (const r of res.results) if (!O.seen.has(r.key)) { O.seen.add(r.key); O.results.push(r); }
    for (const s of srcs) O.more[s] = !!res.more[s];
    if (reset) O.totals = res.totals || {};
    Object.assign(O.errors, res.errors);
    O.via = res.via;
    O.loading = false;
    render();
    if (reset && O.results.length && document.activeElement !== input) listEl.focus();
    if (reset) prefetch(O.results.slice(0, 2));
  }

  const anyMore = () => Object.values(O.more).some(Boolean);

  function sorted() {
    if (!O.sort) return O.results.slice();
    const { key, dir } = O.sort;
    const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
    return O.results.slice().sort((a, b) => {
      const x = a[key], y = b[key];
      return (typeof x === 'number' ? x - y : coll.compare(String(x || ''), String(y || ''))) * dir;
    });
  }

  function render() {
    O.view = sorted();
    if (O.results.length && (anyMore() || O.loading)) O.view.push({ isMore: true });
    else if (O.loading) O.view.push({ isMore: true });
    const keep = list.selected >= 0 && O.view[list.selected];
    list.setItems(O.view);
    if (keep) list.select(O.view.indexOf(keep), false);
    $('#o-empty').hidden = !!O.query || web();
    $('#o-count').textContent = O.query ? `${O.results.length.toLocaleString()}${anyMore() ? '+' : ''} found` : '';
    renderStatus();
  }

  function renderStatus() {
    const st = $('#o-status');
    if (!O.query || web()) { st.hidden = true; return; }
    const parts = [];
    const names = { freesound: 'Freesound', commons: 'Wikimedia Commons', archive: 'Internet Archive' };
    for (const [k, n] of Object.entries(O.totals)) parts.push(`${names[k] || k}: ${Number(n).toLocaleString()} match${n === 1 ? '' : 'es'}`);
    if (O.loading) parts.push('Searching…');
    for (const [k, msg] of Object.entries(O.errors)) parts.push(`<span class="err">${escapeHtml(names[k] || 'Search')}: ${escapeHtml(msg)}</span>`);
    const s = O.settings;
    if (sources().includes('freesound') && s) {
      if (!s.hasKey) parts.push('Freesound is searched through Openverse (older index, 200 searches a day), and Freesound saves are MP3 previews. <button data-x="settings">Add a free Freesound key and account</button>');
      else if (!s.connected) parts.push(`Freesound saves are MP3 previews${fileTypes().includes('mp3') ? '' : ' (the File type filter applies to the original files)'}. <button data-x="settings">Connect your account for the originals</button>`);
    }
    st.innerHTML = parts.map(p => `<span>${p}</span>`).join('');
    st.hidden = !parts.length;
  }
  $('#o-status').addEventListener('click', e => { if (e.target.closest('[data-x=settings]')) settingsDialog(); });

  // ---------------------------------------------------------------- rows
  function fmtFormat(r) {
    const bits = [];
    if (r.ext) bits.push(r.ext.toUpperCase());
    if (r.ch) bits.push(r.ch === 1 ? 'mono' : r.ch === 2 ? 'stereo' : `${r.ch} ch`);
    if (r.sr) bits.push(`${(r.sr / 1000).toFixed(r.sr % 1000 ? 1 : 0)}k`);
    return bits.join(' · ');
  }

  function renderRow(row, r) {
    if (!row._built) {
      row.innerHTML = '<div class="c-name"></div><div class="c-src"></div><div class="c-lic"></div><div class="c-dur"></div><div class="c-ofmt"></div><div class="c-by"></div><div class="c-act"></div>';
      row.draggable = true;
      row._built = true;
      row._c = [...row.children];
    }
    const c = row._c;
    row.classList.toggle('more-row', !!r.isMore);
    if (r.isMore) {
      c[0].textContent = O.loading ? 'Searching…' : 'Scroll or click to load more results';
      for (let i = 1; i < c.length; i++) c[i].textContent = '';
      c[0].title = '';
      return;
    }
    const dl = S.downloads[r.key];
    c[0].innerHTML = `${escapeHtml(r.title)}${dl ? '<span class="saved">✓ saved</span>' : ''}`;
    c[0].title = [r.title, r.pack && `Pack: ${r.pack}`, r.desc, r.tags && r.tags.length ? `Tags: ${r.tags.slice(0, 12).join(', ')}` : ''].filter(Boolean).join('\n');
    c[1].textContent = r.sourceLabel;
    const li = LIC_INFO[r.license] || { label: r.license };
    c[2].innerHTML = `<span class="lic ${escapeHtml(r.license)}">${escapeHtml(li.label)}</span>`;
    c[2].title = LIC_TIPS[r.license] || '';
    c[3].textContent = r.duration ? fmtTime(r.duration) : '';
    c[4].textContent = fmtFormat(r);
    c[5].textContent = r.creator || '';
    c[5].title = r.creator || '';
    const p = O.progress.get(r.key);
    c[6].innerHTML = dl
      ? '<button class="o-save done" title="Show in Explorer">✓ Saved</button>'
      : p
        ? `<button class="o-save busy">${p.total ? Math.round((p.got / p.total) * 100) + '%' : '…'}</button>`
        : `<button class="o-save" title="Download into ${escapeHtml(S.saveDir || 'Documents\\Soundfield Downloads')}">Save</button>`;
  }

  const itemAt = e => { const i = list.indexFromEvent(e); return i >= 0 ? [i, O.view[i]] : [-1, null]; };

  function pick(i, play) {
    const r = O.view[i];
    if (!r) return;
    if (r.isMore) { list.select(i); runSearch(false); return; }
    list.select(i);
    loadOnline(r, { play });
    prefetch([O.view[i + 1], O.view[i + 2]]);
  }

  // Quietly download previews you're likely to click next (Freesound's server is slow per file).
  let prefetchTimer = 0;
  function prefetch(rs) {
    clearTimeout(prefetchTimer);
    prefetchTimer = setTimeout(() => {
      for (const r of rs) if (r && !r.isMore && !S.downloads[r.key]) api.online.preview(r).catch(() => {});
    }, 400); // let the sound you clicked start first
  }

  listEl.addEventListener('mousedown', e => {
    if (e.button !== 0 || e.target.closest('.o-save')) return;
    const [i] = itemAt(e);
    if (i >= 0) pick(i, false); // a click only selects; double-click plays
  });
  listEl.addEventListener('dblclick', e => {
    if (e.target.closest('.o-save')) return;
    const [i, r] = itemAt(e);
    if (r && !r.isMore) { list.select(i); loadOnline(r, { play: true }); }
  });
  listEl.addEventListener('click', e => {
    const b = e.target.closest('.o-save');
    if (!b) return;
    const [, r] = itemAt(e);
    if (!r || r.isMore) return;
    const dl = S.downloads[r.key];
    if (dl) api.reveal(dl.path);
    else if (!O.progress.has(r.key)) saveOnline(r);
  });
  listEl.addEventListener('dragstart', async e => {
    e.preventDefault();
    const [, r] = itemAt(e);
    if (!r || r.isMore) return;
    const dl = S.downloads[r.key];
    if (dl) { api.startDrag(dl.path, null); return; }
    toast('Saving it first…', 20000);
    if (await saveOnline(r)) toast('Saved. Now drag it into your DAW.', 3500);
  });
  listEl.addEventListener('contextmenu', async e => {
    e.preventDefault();
    const [i, r] = itemAt(e);
    if (!r || r.isMore) return;
    list.select(i);
    loadOnline(r, { play: false });
    const dl = S.downloads[r.key];
    const pickId = await api.menu([
      { id: 'play', label: 'Play' },
      dl ? { id: 'reveal', label: 'Show saved file in Explorer' } : { id: 'save', label: 'Save to Soundfield Downloads' },
      { type: 'separator' },
      { id: 'page', label: `Open on ${r.sourceLabel}` },
      { id: 'credit', label: 'Copy credit line' },
      ...(r.creator ? [{ id: 'more', label: `More by ${r.creator}` }] : []),
    ]);
    if (pickId === 'play') loadOnline(r, { play: true });
    else if (pickId === 'save') saveOnline(r);
    else if (pickId === 'reveal') api.reveal(dl.path);
    else if (pickId === 'page') api.openExternal(r.pageUrl);
    else if (pickId === 'credit') { api.copyText(creditLine(r)); toast('Credit line copied'); }
    else if (pickId === 'more') { input.value = r.source === 'freesound' ? `${O.query} ${r.creator}` : r.creator; runSearch(true); }
  });

  // Load the next page when you scroll near the end.
  listEl.addEventListener('scroll', () => {
    if (O.loading || !anyMore()) return;
    if (listEl.scrollTop + listEl.clientHeight > listEl.scrollHeight - 26 * 8) runSearch(false);
  }, { passive: true });

  function creditLine(r) {
    return `“${r.title}” by ${r.creator || 'unknown'} (${r.pageUrl}), ${LIC_NAMES[r.license] || r.license}${r.licenseUrl ? ' ' + r.licenseUrl : ''}`;
  }

  // Sortable header.
  $('#o-header').addEventListener('click', e => {
    const h = e.target.closest('[data-sort]');
    if (!h) return;
    const key = h.dataset.sort;
    O.sort = O.sort && O.sort.key === key ? (O.sort.dir === 1 ? { key, dir: -1 } : null) : { key, dir: 1 };
    document.querySelectorAll('#o-header [data-sort]').forEach(x => x.classList.remove('asc', 'desc'));
    if (O.sort) h.classList.add(O.sort.dir === 1 ? 'asc' : 'desc');
    render();
  });

  // ---------------------------------------------------------------- keyboard (called from app.js)
  function key(e, typing) {
    const k = e.key;
    if (e.target === input) {
      if (k === 'Enter') { e.preventDefault(); if (web()) renderWeb(); else runSearch(true); return true; }
      if (k === 'Escape') { e.preventDefault(); if (input.value) { input.value = ''; if (web()) renderWeb(); } else input.blur(); return true; }
      if (web()) return false;
      if (k === 'ArrowDown' && O.view.length) { e.preventDefault(); listEl.focus(); pick(Math.max(0, list.selected), prefs.autoplay); return true; }
      return false;
    }
    if (typing || e.target.tagName === 'SELECT' || web()) return false;
    const n = O.view.length, cur = list.selected;
    const nav = d => { e.preventDefault(); if (n) pick(Math.max(0, Math.min(n - 1, (cur < 0 ? (d > 0 ? -1 : n) : cur) + d)), prefs.autoplay); return true; };
    if (k === 'ArrowDown') return nav(1);
    if (k === 'ArrowUp') return nav(-1);
    if (k === 'PageDown') return nav(list.pageSize());
    if (k === 'PageUp') return nav(-list.pageSize());
    if (k === 'Home') return nav(-n);
    if (k === 'End') return nav(n);
    if (k === 'Enter') {
      e.preventDefault();
      const r = O.view[cur];
      if (r) { if (r.isMore) runSearch(false); else loadOnline(r, { play: true }); }
      return true;
    }
    if (k.toLowerCase() === 's' && !e.ctrlKey && O.view[cur] && !O.view[cur].isMore) { saveOnline(O.view[cur]); return true; }
    return false;
  }

  // ---------------------------------------------------------------- Freesound key + account
  async function refreshSettings() {
    try { O.settings = await api.online.settings(); } catch {}
    const b = $('#o-settings');
    b.classList.toggle('on', !!(O.settings && O.settings.connected));
    b.title = !O.settings || !O.settings.hasKey ? 'Freesound: add a free API key for better search'
      : O.settings.connected ? `Freesound account connected${O.settings.user ? ` (${O.settings.user})` : ''}: saves are original files`
      : 'Freesound: connect your account to save original WAV files';
    renderStatus();
  }

  async function settingsDialog() {
    await refreshSettings();
    const s = O.settings || {};
    const acct = st => st.connected
      ? `<span class="ok">●</span><span>Account connected${st.user ? `: <b>${escapeHtml(st.user)}</b>` : ''}. Saves download the original files.</span><button data-x="disconnect">Disconnect</button>`
      : `<span>Account not connected: Freesound saves are MP3 previews.</span><button data-x="connect">Connect account…</button>`;
    const done = modal({
      title: 'Freesound',
      sub: 'A free Freesound API key gives better, up-to-date search. Connecting your Freesound account lets <b>Save</b> download the original WAV / AIFF / FLAC instead of an MP3 preview. Both are free.',
      body: `<ol>
          <li><a data-x="apply">Create your free API key</a> (sign in to Freesound). Any name and description is fine. For <i>Callback URL</i> enter <code>${escapeHtml(s.callback || 'https://freesound.org/home/app_permissions/permission_granted/')}</code> (if you already made a key with a different one, that's fine too).</li>
          <li>Copy the <b>Client secret / API key</b> and <b>Client ID</b> it shows you into the boxes below.</li>
          <li>Click <b>Connect account…</b>, sign in to Freesound in the window that opens and click <b>Authorize!</b>. Soundfield picks it up by itself.</li>
        </ol>
        <label class="field"><span>Client secret / API key</span><input name="key" placeholder="${s.hasKey ? `saved (${escapeHtml(s.keyHint)}). Paste a new one to replace it` : 'paste it here'}" spellcheck="false" autocomplete="off"></label>
        <label class="field"><span>Client ID</span><input name="cid" value="${escapeHtml(s.clientId || '')}" spellcheck="false" autocomplete="off"></label>
        <div class="acct">${acct(s)}</div>
        <a class="paste-link" data-x="paste">Got a code or a page address from Freesound instead? Paste it</a>
        <label class="field code-step" hidden style="margin-top:10px"><span>Paste the code, or the whole address of the page Freesound took you to, then click Save</span><input name="code" spellcheck="false" autocomplete="off"></label>`,
      ok: 'Save',
    });
    const card = document.querySelector('#modal .modal-card');
    card.classList.add('wide');
    const val = n => card.querySelector(`input[name=${n}]`).value.trim();
    const saveKeys = async () => {
      const patch = { clientId: val('cid') };
      if (val('key')) patch.apiKey = val('key');
      O.settings = await api.online.setKey(patch);
    };
    card.addEventListener('click', async e => {
      const x = e.target.closest('[data-x]');
      if (!x) return;
      e.preventDefault();
      if (x.dataset.x === 'apply') api.openExternal('https://freesound.org/apiv2/apply');
      else if (x.dataset.x === 'connect') {
        try {
          await saveKeys();
          x.disabled = true;
          x.textContent = 'Waiting for Freesound…';
          const st = await api.online.connect();
          if (st) {
            O.settings = st;
            card.querySelector('.acct').innerHTML = acct(st);
            toast(`Freesound account connected${st.user ? ` (${st.user})` : ''}. Saves are now original files.`, 4500);
            refreshSettings();
          } else card.querySelector('.acct').innerHTML = acct(O.settings || s);
        } catch (err) {
          toast(`Freesound: ${ipcMessage(err)}`, 6000);
          card.querySelector('.acct').innerHTML = acct(O.settings || s);
        }
      } else if (x.dataset.x === 'paste') {
        card.querySelector('.code-step').hidden = false;
        card.querySelector('input[name=code]').focus();
      } else if (x.dataset.x === 'disconnect') {
        O.settings = await api.online.disconnect();
        card.querySelector('.acct').innerHTML = acct(O.settings);
      }
    });
    const ok = await done;
    if (!ok) { refreshSettings(); return; }
    try {
      await saveKeys();
      if (val('code')) {
        O.settings = await api.online.code(val('code'));
        toast(`Freesound account connected${O.settings.user ? ` (${O.settings.user})` : ''}. Saves are now original files.`, 4500);
      } else toast(O.settings.hasKey ? 'Freesound key saved' : 'Saved');
    } catch (err) {
      toast(`Freesound: ${ipcMessage(err)}`, 6000);
    }
    await refreshSettings();
    if (O.query) runSearch(true);
  }

  // ---------------------------------------------------------------- public
  let refreshQueued = false;
  return {
    show() {
      applyOMode();
      refreshSettings();
      if (!O.query || web()) setTimeout(() => input.focus(), 0); else listEl.focus();
    },
    setMode: setOMode,
    setSaveDir,
    destLabel,
    key,
    refresh() { list.refresh(); },
    progress(p) {
      if (p.finished) O.progress.delete(p.key); else O.progress.set(p.key, p);
      if (!refreshQueued) { refreshQueued = true; requestAnimationFrame(() => { refreshQueued = false; list.refresh(); }); }
    },
    search(q) { input.value = q; if (web()) { renderWeb(); return Promise.resolve(); } return runSearch(true); }, // for testing
    get state() { return O; },
  };
}
