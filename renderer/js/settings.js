// Settings panel: one section at a time, a plain one-line description under every setting
// (more detail on hover), and a search box. Changes apply at once and are remembered in
// settings.json, so there's no Save button.
import SAFETY_DEFAULTS from '../../shared/safety.json' with { type: 'json' };

const SECTIONS = [
  ['playback', 'Playback', 'How sounds play while you audition them.'],
  ['waveform', 'Waveform', 'The waveform, its level scale and readouts.'],
  ['files', 'Saving & files', 'Where Soundfield writes files, and what it keeps.'],
  ['libraries', 'Libraries', 'Background work on your linked folders.'],
  ['search', 'Search', 'How the library search reads what you type.'],
  ['accounts', 'Accounts', 'Online services Soundfield search uses.'],
  ['safety', 'Safety', 'When Soundfield asks before big copies, deletes and downloads.'],
  ['data', 'Your data', 'Where your libraries, projects and settings are kept.'],
  ['look', 'Look & feel', 'Size, density and what opens first.'],
  ['about', 'About', 'Version, release notes and problem reports.'],
];

const KEYS = [
  ['↑ / ↓, PgUp / PgDn', 'Previous / next sound (plays when AUTO is on)'],
  ['Space', 'Play / stop'],
  ['Enter', 'Play from the start (or open a folder)'],
  ['← / →  (Shift: 5 s)', 'Jump 1 s'],
  ['- / =', 'Preview volume down / up 1 dB'],
  ['1–9 / 0', 'Solo channel n / clear solos'],
  ['L · A · B', 'Loop · auto-play · binaural on / off'],
  ['M', 'Matched loudness on / off'],
  ['[ / ]', 'Varispeed down / up a semitone'],
  ['V', 'Waveform / spectrogram'],
  ['K', 'Drop a marker at the playhead'],
  ['Ctrl+1 … 5 / Ctrl+0', 'Rate the selected sound(s) / clear the rating'],
  ['Ctrl+Z', 'Undo, while a toast offers it'],
  ['F', 'Favorite'],
  ['P', 'Add the sound you’re hearing to the project used last'],
  ['Z', 'Zoom the waveform to fit'],
  ['Ctrl+F or /', 'Search (-word excludes, "exact phrase")'],
  ['Shift-click · Ctrl-click', 'Select a range · add or remove one sound'],
  ['Ctrl+A', 'Select every listed sound (Esc clears)'],
  ['Delete', 'Move selected sounds to the Recycle Bin (you confirm first)'],
  ['Backspace', 'Up one folder (folder view)'],
  ['Ctrl+,', 'Open Settings'],
  ['Esc', 'Close a dialog · clear the selection · stop'],
];

export function createSettings(ctx) {
  const { api, prefs, savePrefs, apply, toast, escapeHtml, fmtBytes, actions } = ctx;
  const ITEMS = [
    // ---------------------------------------------------------------- playback
    { section: 'playback', key: 'outputDevice', type: 'custom', def: '', render: renderDevices, label: 'Output device', desc: 'Where Soundfield plays sound, separately from the Windows default. Handy with an audio interface.', keywords: 'speakers headphones interface sound card' },
    { section: 'playback', key: 'clickPlays', type: 'toggle', def: false, label: 'Play on single click', desc: 'Clicking a sound plays it straight away. Off: a click selects it and a double-click plays it.' },
    { section: 'playback', key: 'matchLoudness', type: 'toggle', def: false, label: 'Matched loudness', desc: 'Every sound plays at the same perceived loudness while you audition, so quiet ones aren’t lost and loud ones don’t blast. Your files aren’t changed. Same as the MATCH button (key M).' },
    { section: 'playback', key: 'matchTarget', type: 'select', def: -20, number: true, label: 'Matched loudness level', desc: 'How loud matched sounds play. Sounds are never boosted past −1 dB true peak.',
      tip: '−23 LUFS is the broadcast standard (EBU R128); −16 / −14 are typical for streaming. Your volume slider still applies on top.',
      options: [[-14, '−14 LUFS (loud)'], [-16, '−16 LUFS'], [-18, '−18 LUFS'], [-20, '−20 LUFS (default)'], [-23, '−23 LUFS (broadcast)']] },
    { section: 'playback', key: 'showVarispeed', type: 'toggle', def: true, label: 'Show the varispeed (Speed) control', desc: 'Tape-style: slowing a sound down lowers its pitch, speeding it up raises it. Keys [ and ] step it a semitone. Hiding it puts playback back at normal speed.' },
    { section: 'playback', key: 'autoplay', type: 'toggle', def: true, label: 'Play while moving with the arrow keys', desc: 'Each sound plays as you step through the list with ↑ / ↓. Same as the AUTO button (key A).' },
    { section: 'playback', key: 'loop', type: 'toggle', def: false, label: 'Loop', desc: 'Repeat the sound, or the selected part of it, until you stop it (key L).' },
    { section: 'playback', key: 'monitor', type: 'select', def: 'stereo', label: 'Hear multichannel files as', desc: 'How surround, immersive and ambisonic files reach your speakers or headphones.',
      tip: 'Stereo: a standard Lo/Ro downmix. Binaural: virtual speakers around your head, for headphones. Discrete: channel n goes to output n of a multichannel interface.',
      options: [['stereo', 'Stereo (Lo/Ro downmix)'], ['binaural', 'Binaural (headphones)'], ['discrete', 'Discrete outputs (interface)']] },
    { section: 'playback', key: 'lfe', type: 'toggle', def: false, label: 'Include the LFE channel', desc: 'Mix the low-frequency effects channel into the stereo and binaural monitoring.' },
    // ---------------------------------------------------------------- waveform
    { section: 'waveform', key: 'dbFloor', type: 'select', def: -40, label: 'Level scale range', desc: 'The bottom of the dB scale beside the waveform. −40 dB shows loud material clearly; −60 dB also shows quiet tails and noise.',
      options: [[-40, '−40 … 0 dBFS'], [-60, '−60 … 0 dBFS']], number: true },
    { section: 'waveform', key: 'peakWarnDb', type: 'number', def: -1, min: -12, max: 0, step: 0.5, unit: 'dBFS', label: 'Peak warning level', desc: 'A channel’s peak readout turns red at or above this level.' },
    { section: 'waveform', key: 'specRange', type: 'number', def: 130, min: 60, max: 160, step: 5, unit: 'dB', label: 'Spectrogram level range', desc: 'How far below full scale the spectrogram shows. Also set by the slider beside SPECTRO; it stays where you leave it.' },
    { section: 'waveform', key: 'specScale', type: 'select', def: 'log', label: 'Spectrogram frequency scale', desc: 'Logarithmic gives lows and mids more room, like hearing does. Linear spaces every frequency evenly.',
      options: [['log', 'Logarithmic'], ['linear', 'Linear']] },
    { section: 'waveform', key: 'specFFT', type: 'select', def: 2048, label: 'Spectrogram detail', desc: 'Larger sizes separate close frequencies better but smear fast transients in time.',
      options: [[1024, 'Sharper timing (1024)'], [2048, 'Balanced (2048)'], [4096, 'Finer pitch (4096)']], number: true },
    { section: 'waveform', key: 'specPalette', type: 'select', def: 'audition', label: 'Spectrogram colours', desc: 'Audition is dark blue through red to yellow. Grey is plain black to white.',
      options: [['audition', 'Audition'], ['grey', 'Grey']] },
    // ---------------------------------------------------------------- saving & files
    { section: 'files', key: 'onlineSaveDir', type: 'folder', def: '', defLabel: 'Documents\\Soundfield Downloads (a folder per site)', pickTitle: 'Default folder for Soundfield search saves',
      label: 'Default save folder for Soundfield search', desc: 'Where Save puts sounds each time Soundfield starts. “Save to” in the Online tab still changes it for the current session.' },
    { section: 'files', key: 'writeCredits', type: 'toggle', def: true, label: 'Keep a Credits.txt', desc: 'Record where each downloaded sound came from, and its licence, in Credits.txt in the save folder.' },
    { section: 'files', key: 'regionDir', type: 'folder', def: '', defLabel: 'Documents\\Soundfield Regions', pickTitle: 'Folder for selections dragged into your DAW',
      label: 'Folder for dragged selections', desc: 'When you drag part of a waveform into your DAW, it’s saved here as a new WAV.' },
    { section: 'files', key: 'regionKeepDays', type: 'select', def: 0, number: true, extra: 'regions', label: 'Keep dragged selections for', desc: 'Older selection files go to the Recycle Bin, in case a DAW session still uses one. Only files Soundfield made are touched.',
      options: [[0, 'Always (never clean up)'], [7, '7 days'], [30, '30 days'], [90, '90 days']] },
    { section: 'files', key: 'previewCacheMB', type: 'number', def: 300, min: 50, max: 10000, step: 50, unit: 'MB', label: 'Preview cache size', desc: 'Online previews are kept for quick replays; the oldest are removed past this size.', extra: 'cache' },
    // ---------------------------------------------------------------- libraries
    { section: 'libraries', key: 'watchFolders', type: 'toggle', def: true, label: 'Watch folders for changes', desc: 'Sounds you add, rename or delete in your library folders show up within a few seconds. Off: they’re picked up when Soundfield starts.' },
    { section: 'libraries', key: 'backgroundSorting', type: 'toggle', def: true, label: 'Sort sounds by listening', desc: 'Sounds whose names don’t say what they are get listened to in the background to pick a category. Turn off to keep the disk quiet.' },
    { section: 'libraries', type: 'custom', render: renderHiddenFolders, label: 'Folders hidden from All sounds', desc: 'Click the eye beside a folder under Libraries to hide it. Its sounds stay listed when you open that folder.', keywords: 'hide exclude archive' },
    { section: 'libraries', type: 'custom', render: renderDupFolders, label: 'Folders left out of duplicate searches', desc: 'Right-click a folder under Libraries to add one. Click ✕ to include it again.', keywords: 'duplicates exclude' },
    // ---------------------------------------------------------------- search
    { section: 'search', key: 'searchSynonyms', type: 'toggle', def: true, label: 'Find synonyms', desc: 'Searching “gun” also finds rifle, pistol, gunshot…, listed after the exact matches. Put a word in quotes ("gun") to search for just that word.' },
    { section: 'search', key: 'searchTypos', type: 'toggle', def: true, label: 'Forgive small typos', desc: 'When no sound contains a word, close spellings that do exist are searched instead: “explsion” finds explosion.' },
    { section: 'search', type: 'custom', render: renderUserSynonyms, label: 'Your own synonyms', desc: 'One group per line, words separated by commas or =, e.g.  whoosh = swish, swoosh. Added to the built-in list.', keywords: 'words aliases' },
    { section: 'search', type: 'custom', render: renderSearchHelp, label: 'Search tricks', desc: '', keywords: 'rating stars notes markers filter' },
    // ---------------------------------------------------------------- accounts
    { section: 'accounts', type: 'custom', render: el => renderAccount(el, 'freesound'), label: 'Freesound', desc: 'A free key gives better search; connecting your account lets Save download original WAV / AIFF / FLAC files.', keywords: 'api key oauth' },
    { section: 'accounts', type: 'custom', render: el => renderAccount(el, 'teamsfx'), label: 'Team SFX', desc: 'The team’s shared sound library through Lighthouse, with your own Soundfield key: search, listen, save and add sounds.', keywords: 'lighthouse dropbox team shared key lhsk' },
    { section: 'accounts', type: 'custom', render: el => renderAccount(el, 'epidemic'), label: 'Epidemic Sound', desc: 'Your own Epidemic account key: search, previews and WAV saves through your subscription.', keywords: 'api key mcp' },
    // ---------------------------------------------------------------- safety
    { section: 'safety', key: 'safety.confirmGB', type: 'number', def: SAFETY_DEFAULTS.confirmGB, min: 1, max: 10000, step: 1, unit: 'GB', label: 'Ask twice above this size', desc: 'Copies, zips, extracts and recycles bigger than this need a second confirmation.' },
    { section: 'safety', key: 'safety.confirmFiles', type: 'number', def: SAFETY_DEFAULTS.confirmFiles, min: 10, max: 1000000, step: 100, unit: 'files', label: 'Ask twice above this many files', desc: 'Same, counted in files rather than size.' },
    { section: 'safety', key: 'safety.dragFiles', type: 'number', def: SAFETY_DEFAULTS.dragFiles, min: 1, max: 100000, step: 10, unit: 'files', label: 'Most files to drag into a DAW at once', desc: 'Bigger drags are stopped (a DAW can freeze); use a project and Materialize instead.' },
    { section: 'safety', key: 'safety.dragGB', type: 'number', def: SAFETY_DEFAULTS.dragGB, min: 1, max: 1000, step: 1, unit: 'GB', label: 'Largest drag into a DAW', desc: 'The size limit for dragged files and for a dragged waveform selection.' },
    { section: 'safety', key: 'safety.previewMB', type: 'number', def: SAFETY_DEFAULTS.previewMB, min: 10, max: 100000, step: 10, unit: 'MB', label: 'Ask before previews bigger than', desc: 'Some online “previews” are the full original file; above this, Soundfield asks before downloading.' },
    { section: 'safety', key: 'safety.saveMB', type: 'number', def: SAFETY_DEFAULTS.saveMB, min: 10, max: 100000, step: 10, unit: 'MB', label: 'Ask before saves bigger than', desc: 'Saving an online sound larger than this asks first.' },
    { section: 'safety', key: 'safety.networkDelete', type: 'select', def: SAFETY_DEFAULTS.networkDelete, label: 'Deleting on network or USB drives', desc: 'These drives have no Recycle Bin, so a delete there is permanent.',
      options: [['ask', 'Warn me, then let me delete'], ['refuse', 'Never delete there']] },
    // ---------------------------------------------------------------- your data
    { section: 'data', key: 'recentMax', type: 'number', def: 100, min: 10, max: 1000, step: 10, unit: 'sounds', label: 'Recently played keeps', desc: 'How many of the last sounds you played are listed under Recently played.', extra: 'recent' },
    { section: 'data', type: 'custom', render: renderDataDir, label: 'Data folder', desc: 'Libraries, projects, settings, caches and the problem log. Your sound files are never stored here.', keywords: 'appdata settings.json' },
    // ---------------------------------------------------------------- look & feel
    { section: 'look', key: 'startupTab', type: 'select', def: 'last', label: 'Open on start', desc: 'Which tab Soundfield shows when it starts.', options: [['last', 'The tab I used last'], ['library', 'Library'], ['online', 'Online']] },
    { section: 'look', key: 'uiZoom', type: 'select', def: 1, label: 'Interface size', desc: 'Makes all text and controls bigger or smaller.', number: true,
      options: [[0.9, '90%'], [1, '100%'], [1.1, '110%'], [1.25, '125%'], [1.5, '150%']] },
    { section: 'look', key: 'rowDensity', type: 'select', def: 'normal', label: 'List row height', desc: 'More rows on screen, or more room per row.', options: [['compact', 'Compact'], ['normal', 'Normal'], ['roomy', 'Roomy']] },
    { section: 'look', type: 'custom', render: renderKeys, label: 'Keyboard shortcuts', desc: 'Keys that work in the sound list and player.', keywords: 'keys hotkeys' },
    // ---------------------------------------------------------------- about
    { section: 'about', type: 'custom', render: renderAbout, label: 'Soundfield', desc: '', keywords: 'version build release notes whats new problem report bug log' },
  ];

  // ---------------------------------------------------------------- values
  const get = key => key.split('.').reduce((o, k) => (o == null ? undefined : o[k]), prefs);
  const value = it => { const v = get(it.key); return v === undefined ? it.def : v; };
  function set(it, v) {
    const parts = it.key.split('.');
    let o = prefs;
    for (const k of parts.slice(0, -1)) o = (o[k] && typeof o[k] === 'object') ? o[k] : (o[k] = {});
    o[parts[parts.length - 1]] = v;
    savePrefs();
    apply(it.key, v);
  }

  // ---------------------------------------------------------------- panel
  const root = document.createElement('div');
  root.id = 'settings';
  root.hidden = true;
  root.innerHTML = `<div class="set-panel" role="dialog" aria-modal="true" aria-label="Settings">
      <header class="set-head"><h2>Settings</h2>
        <input id="set-search" type="search" placeholder="Search settings" spellcheck="false" autocomplete="off">
        <button class="set-x" title="Close (Esc)" aria-label="Close">✕</button></header>
      <div class="set-body"><nav class="set-nav"></nav><section class="set-content"></section></div>
    </div>`;
  document.body.appendChild(root);
  const nav = root.querySelector('.set-nav'), content = root.querySelector('.set-content'), search = root.querySelector('#set-search');
  let current = prefs.settingsSection || 'playback';

  function renderNav(matches) {
    nav.replaceChildren(...SECTIONS.map(([id, name]) => {
      const b = document.createElement('button');
      b.textContent = name;
      b.className = 'set-nav-item' + (id === current && !matches ? ' on' : '') + (matches && !matches.has(id) ? ' dim' : '');
      b.addEventListener('click', () => { current = id; prefs.settingsSection = id; savePrefs(); search.value = ''; render(); });
      return b;
    }));
  }

  function render() {
    const q = search.value.trim().toLowerCase();
    content.replaceChildren();
    if (q) {
      const hits = ITEMS.filter(it => `${it.label} ${it.desc} ${it.tip || ''} ${it.keywords || ''} ${SECTIONS.find(s => s[0] === it.section)[1]}`.toLowerCase().includes(q));
      renderNav(new Set(hits.map(h => h.section)));
      if (!hits.length) { const p = document.createElement('p'); p.className = 'set-none'; p.textContent = `No setting matches “${search.value.trim()}”.`; content.appendChild(p); return; }
      for (const [id, name] of SECTIONS) {
        const its = hits.filter(h => h.section === id);
        if (!its.length) continue;
        const h = document.createElement('h3'); h.textContent = name; content.appendChild(h);
        its.forEach(it => content.appendChild(row(it)));
      }
      return;
    }
    renderNav(null);
    const [, name, about] = SECTIONS.find(s => s[0] === current) || SECTIONS[0];
    const h = document.createElement('h3'); h.textContent = name;
    const p = document.createElement('p'); p.className = 'set-about'; p.textContent = about;
    content.append(h, p);
    const its = ITEMS.filter(it => it.section === current);
    its.forEach(it => content.appendChild(row(it)));
    if (its.some(it => it.key)) {
      const r = document.createElement('button');
      r.className = 'set-reset';
      r.textContent = `Reset ${name} to defaults`;
      r.addEventListener('click', () => { for (const it of its) if (it.key && JSON.stringify(value(it)) !== JSON.stringify(it.def)) set(it, it.def); render(); toast(`${name} settings reset`); });
      content.appendChild(r);
    }
  }

  function row(it) {
    const el = document.createElement('div');
    el.className = 'set-row' + (it.type === 'custom' || it.type === 'folder' ? ' wide' : '');
    const text = document.createElement('div');
    text.className = 'set-text';
    text.innerHTML = `<div class="set-label">${escapeHtml(it.label)}</div>${it.desc ? `<div class="set-desc">${escapeHtml(it.desc)}</div>` : ''}`;
    if (it.tip) text.title = it.tip;
    const ctl = document.createElement('div');
    ctl.className = 'set-ctl';
    el.append(text, ctl);
    if (it.type === 'toggle') {
      const b = document.createElement('button');
      b.className = 'switch';
      b.setAttribute('role', 'switch');
      const sync = () => { const on = !!value(it); b.classList.toggle('on', on); b.setAttribute('aria-checked', String(on)); b.setAttribute('aria-label', it.label); };
      sync();
      b.addEventListener('click', () => { set(it, !value(it)); sync(); });
      ctl.appendChild(b);
    } else if (it.type === 'select') {
      const s = document.createElement('select');
      s.setAttribute('aria-label', it.label);
      for (const [v, l] of it.options) { const o = document.createElement('option'); o.value = String(v); o.textContent = l; s.appendChild(o); }
      s.value = String(value(it));
      s.addEventListener('change', () => set(it, it.number ? Number(s.value) : s.value));
      ctl.appendChild(s);
      if (it.extra === 'regions') {
        const b = document.createElement('button');
        b.className = 'set-btn';
        b.textContent = 'Open folder';
        api.regionsInfo().then(r => { b.textContent = `Open folder (${r.count.toLocaleString()} file${r.count === 1 ? '' : 's'}, ${fmtBytes(r.bytes)})`; }).catch(() => {});
        b.addEventListener('click', () => api.openRegions());
        ctl.appendChild(b);
      }
    } else if (it.type === 'number') {
      const i = document.createElement('input');
      Object.assign(i, { type: 'number', min: it.min, max: it.max, step: it.step });
      i.value = value(it);
      i.setAttribute('aria-label', it.label);
      i.addEventListener('change', () => {
        let v = Number(i.value);
        if (!Number.isFinite(v)) v = it.def;
        v = Math.max(it.min, Math.min(it.max, v));
        i.value = v;
        set(it, v);
      });
      const u = document.createElement('span'); u.className = 'set-unit'; u.textContent = it.unit || '';
      ctl.append(i, u);
      if (it.extra === 'cache') {
        const b = document.createElement('button');
        b.className = 'set-btn';
        b.textContent = 'Clear now';
        api.previewCacheSize().then(n => { b.textContent = `Clear now (${fmtBytes(n)})`; }).catch(() => {});
        b.addEventListener('click', async () => { const n = await api.clearPreviewCache(); toast(`Cleared ${fmtBytes(n)} of previews`); b.textContent = 'Clear now (0 B)'; });
        ctl.appendChild(b);
      }
      if (it.extra === 'recent') {
        const b = document.createElement('button');
        b.className = 'set-btn';
        const n = actions.recentCount();
        b.textContent = `Clear the list (${n.toLocaleString()})`;
        b.disabled = !n;
        b.addEventListener('click', () => { actions.clearRecent(); b.textContent = 'Clear the list (0)'; b.disabled = true; });
        ctl.appendChild(b);
      }
    } else if (it.type === 'folder') {
      const path = document.createElement('div');
      path.className = 'set-path';
      const sync = () => { const v = value(it); path.textContent = v || it.defLabel; path.classList.toggle('default', !v); path.title = v || it.defLabel; };
      sync();
      const pick = document.createElement('button');
      pick.className = 'set-btn';
      pick.textContent = 'Choose…';
      pick.addEventListener('click', async () => { const d = await api.pickFolder(it.pickTitle, value(it) || ''); if (d) { set(it, d); sync(); } });
      const reset = document.createElement('button');
      reset.className = 'set-btn';
      reset.textContent = 'Default';
      reset.addEventListener('click', () => { set(it, ''); sync(); });
      ctl.append(path, pick, reset);
    } else if (it.type === 'custom') {
      it.render(ctl);
    }
    return el;
  }

  // ---------------------------------------------------------------- custom rows
  async function renderDevices(el) {
    const it = ITEMS.find(x => x.key === 'outputDevice');
    let devs = [];
    try { devs = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === 'audiooutput'); } catch {}
    const def = devs.find(d => d.deviceId === 'default');
    const s = document.createElement('select');
    s.setAttribute('aria-label', it.label);
    const add = (v, l) => { const o = document.createElement('option'); o.value = v; o.textContent = l; s.appendChild(o); };
    add('', `Windows default${def ? ` (${def.label.replace(/^Default - /, '')})` : ''}`);
    for (const d of devs) if (d.deviceId !== 'default' && d.deviceId !== 'communications') add(d.deviceId, d.label || 'Unnamed device');
    const cur = value(it);
    if (cur && !devs.some(d => d.deviceId === cur)) add(cur, 'Saved device (not connected now)');
    s.value = cur;
    s.addEventListener('change', () => set(it, s.value));
    el.replaceChildren(s);
  }

  function renderHiddenFolders(el) {
    const list = actions.hiddenFolders();
    if (!list.length) { el.innerHTML = '<span class="set-muted">None. Every folder is in All sounds.</span>'; return; }
    el.replaceChildren(...list.map(h => {
      const c = document.createElement('div');
      c.className = 'set-chip';
      const t = document.createElement('span'); t.textContent = h.label;
      const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Show it in All sounds again';
      x.addEventListener('click', () => { h.show(); renderHiddenFolders(el); });
      c.append(t, x);
      return c;
    }));
  }

  function renderUserSynonyms(el) {
    const ta = document.createElement('textarea');
    ta.className = 'set-text';
    ta.rows = 4;
    ta.spellcheck = false;
    ta.placeholder = 'whoosh = swish, swoosh\nfoley feet = footsteps';
    ta.value = prefs.userSynonyms || '';
    ta.addEventListener('change', () => { prefs.userSynonyms = ta.value; savePrefs(); apply('userSynonyms', ta.value); });
    el.replaceChildren(ta);
  }

  function renderSearchHelp(el) {
    el.innerHTML = `<div class="set-muted set-tricks">
      <div><code>door -metal</code> sounds with “door” but not “metal”</div>
      <div><code>"car pass"</code> that exact phrase, no synonyms</div>
      <div><code>rating:4+</code> 4 or 5 stars · <code>rating:3</code> exactly 3 · <code>rating:2-</code> 2 or fewer · <code>rating:0</code> not rated</div>
      <div><code>has:notes</code> · <code>has:markers</code> · <code>has:rating</code> sounds you’ve added something to</div>
      <div>Your notes and marker names are searched like file names.</div></div>`;
  }

  function renderDupFolders(el) {
    const list = prefs.dupExclude || [];
    if (!list.length) { el.innerHTML = '<span class="set-muted">None. Every folder is included.</span>'; return; }
    el.replaceChildren(...list.map(f => {
      const c = document.createElement('div');
      c.className = 'set-chip';
      c.title = f;
      const t = document.createElement('span'); t.textContent = actions.prettyDir(f);
      const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Include this folder in duplicate searches again';
      x.addEventListener('click', () => { actions.setDupExcluded(f, false); renderDupFolders(el); });
      c.append(t, x);
      return c;
    }));
  }

  async function renderAccount(el, which) {
    el.innerHTML = '<span class="set-muted">Checking…</span>';
    const st = await actions.accountStatus(which).catch(() => null);
    const line = document.createElement('span');
    line.className = 'set-muted';
    if (which === 'freesound') line.innerHTML = !st || !st.hasKey ? 'No key: searched through Openverse, saves are MP3 previews.'
      : st.connected ? `<span class="set-ok">●</span> Account connected${st.user ? `: <b>${escapeHtml(st.user)}</b>` : ''}. Saves are original files.` : `<span class="set-ok">●</span> Key saved. Connect your account to save original files.`;
    else if (which === 'teamsfx') line.innerHTML = st && st.hasKey ? `<span class="set-ok">●</span> Key saved${st.syncedAt ? ` · ${st.files.toLocaleString()} sounds` : ''}.` : 'No Soundfield key yet.';
    else line.innerHTML = st && st.hasAccountKey ? '<span class="set-ok">●</span> Account key saved.' : 'No account key yet.';
    const b = document.createElement('button');
    b.className = 'set-btn';
    b.textContent = 'Set up…';
    b.addEventListener('click', async () => { await actions.openAccount(which); renderAccount(el, which); });
    el.replaceChildren(line, b);
  }

  async function renderDataDir(el) {
    const info = await api.appInfo().catch(() => ({}));
    const p = document.createElement('div'); p.className = 'set-path'; p.textContent = info.dataDir || ''; p.title = info.dataDir || '';
    const b = document.createElement('button'); b.className = 'set-btn'; b.textContent = 'Open'; b.addEventListener('click', () => api.openDataDir());
    el.replaceChildren(p, b);
  }

  function renderKeys(el) {
    const t = document.createElement('table');
    t.className = 'set-keys';
    t.innerHTML = KEYS.map(([k, a]) => `<tr><td><kbd>${escapeHtml(k)}</kbd></td><td>${escapeHtml(a)}</td></tr>`).join('');
    el.replaceChildren(t);
  }

  async function renderAbout(el) {
    const i = await api.appInfo().catch(() => ({}));
    const built = i.builtAt ? new Date(i.builtAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'running from the source folder';
    el.innerHTML = `<dl class="set-dl"><dt>Version</dt><dd>${escapeHtml(i.version || '?')}</dd><dt>Built</dt><dd>${escapeHtml(built)}${i.commit ? ` · ${escapeHtml(i.commit)}` : ''}</dd><dt>Electron</dt><dd>${escapeHtml(i.electron || '')}</dd></dl>`;
    const bar = document.createElement('div');
    bar.className = 'set-btns';
    const mk = (label, fn, title = '') => { const b = document.createElement('button'); b.className = 'set-btn'; b.textContent = label; b.title = title; b.addEventListener('click', fn); bar.appendChild(b); };
    mk('What’s new', () => actions.showAbout());
    mk('Copy problem report', async () => {
      const text = await api.problemReport();
      await api.copyText(text);
      toast('Problem report copied. Paste it into a message to Claude or a GitHub issue.', 4500);
    }, 'Copies the version, Windows version and recent errors (it may include file paths)');
    mk('GitHub', () => api.openExternal('https://github.com/ghostspectrogram/soundfield'));
    el.appendChild(bar);
  }

  // ---------------------------------------------------------------- open / close
  function open(section) {
    if (section) { current = section; search.value = ''; }
    root.hidden = false;
    render();
    setTimeout(() => search.focus(), 0);
  }
  function close() { root.hidden = true; }
  root.querySelector('.set-x').addEventListener('click', close);
  root.addEventListener('mousedown', e => { if (e.target === root) close(); });
  search.addEventListener('input', render);
  // While open, keys belong to the panel (Esc closes it; nothing reaches the player).
  document.addEventListener('keydown', e => {
    if (root.hidden || !document.querySelector('#modal').hidden) return;
    if (e.key === 'Escape') { e.preventDefault(); if (search.value) { search.value = ''; render(); } else close(); }
    e.stopPropagation();
  }, true);

  return { open, close, isOpen: () => !root.hidden, refresh: () => { if (!root.hidden) render(); } };
}
