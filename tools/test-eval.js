// Runs inside Soundfield's window (see tools/test.js). `CFG` is defined just before this script.
// Returns { results: [{ name, ok, detail }], metrics: {...} }.
(async () => {
  const results = [], metrics = {};
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const until = async (fn, ms = 20000) => { const t = Date.now(); while (Date.now() - t < ms) { try { if (await fn()) return true; } catch {} await wait(100); } return false; };
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail) });
  const near = (a, b, tol) => Math.abs(a - b) <= tol;

  if (!(await until(() => window.__sf, 15000))) return { results: [{ name: 'Soundfield starts', ok: false, detail: 'window.__sf never appeared' }], metrics };
  const sf = window.__sf, S = sf.S;
  sf.engine.setVolume(-60); // the tests play sounds; keep them silent
  metrics.bootMs = sf.bootMs;
  check('Soundfield starts', true, `${sf.bootMs} ms to ready`);

  // ---------------------------------------------------------------- speed run on a copy of real data
  if (CFG.mode === 'perf') {
    metrics.sounds = S.items.length;
    const time = (fn, n = 10) => { const t = performance.now(); for (let i = 0; i < n; i++) fn(); return +((performance.now() - t) / n).toFixed(2); };
    metrics.filterAllMs = time(() => sf.applyFilters());
    S.query = 'door'; metrics.searchMs = time(() => sf.applyFilters()); S.query = ''; sf.applyFilters();
    const big = S.projects.slice().sort((a, b) => b.items.length - a.items.length)[0];
    if (big) { sf.openProject(big); metrics.projectMs = time(() => sf.applyFilters()); metrics.projectSounds = big.items.length; S.scope = { type: 'all' }; sf.applyFilters(); }
    if (window.gc) window.gc();
    if (performance.memory) metrics.heapMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
    try { metrics.windowMB = (await window.api.testMetrics()).filter(m => m.type === 'Tab').map(m => m.mb)[0]; } catch {}
    check('Speed run finished', true, `${metrics.sounds} sounds`);
    return { results, metrics };
  }

  // ---------------------------------------------------------------- second start: things that must persist
  const info = await window.api.appInfo();
  if (CFG.mode === 'restart') {
    check('Preferences survive a restart', sf.prefs.testMarker === CFG.marker, `testMarker = ${sf.prefs.testMarker}`);
    check('What’s new shows only once', document.querySelector('#modal').hidden, document.querySelector('#modal').hidden ? 'not shown' : 'shown again');
    check('Library loads from its index at startup', S.items.length === CFG.count, `${S.items.length} of ${CFG.count}`);
    const tone = S.items.find(it => /Tone 1k/.test(it.rec.rel));
    const kept = tone && await window.api.getLoudness(tone.path, tone.rec.size, tone.rec.mtime);
    check('Loudness is remembered', kept && Math.abs(kept[0] + 23) < 0.15, kept ? `${kept[0]} LUFS` : 'not stored');
    const pack = S.items.find(it => /Pack Hit\.wav$/.test(it.rec.rel));
    const bg = pack && await window.api.getLoudness(pack.path, pack.rec.size, pack.rec.mtime);
    check('Spectrogram level range is remembered', sf.prefs.specRange === 95 && sf.wave.specRange === 95 && document.querySelector('#spec-range-in').value === '95', `${sf.prefs.specRange} dB`);
    const rainR = S.items.find(it => /Rain Ambience Loop/.test(it.rec.rel));
    check('Ratings are kept', rainR && (S.mine.sounds[rainR.path] || {}).r === 5, rainR ? `${(S.mine.sounds[rainR.path] || {}).r} stars` : 'not found');
    check('Short sounds are measured in the background', !!bg, bg ? `Pack Hit: ${bg[0]} LUFS` : 'not measured');
    return { results, metrics };
  }

  // ---------------------------------------------------------------- first start
  check('Version matches package.json', info && info.version === CFG.version, info && info.version);
  await until(() => !document.querySelector('#modal').hidden, 3000);
  const m = document.querySelector('#modal');
  const wn = !m.hidden && /What’s new/.test(m.textContent) && m.textContent.includes(CFG.version);
  check('What’s new appears after an update', wn, wn ? 'shown' : 'not shown');
  m.querySelector('[data-a=ok]')?.click();
  await wait(100);
  check('Preferences are kept in settings.json (moved from browser storage)', sf.prefs.migratedProbe === 'from-localStorage', `migratedProbe = ${sf.prefs.migratedProbe}`);

  const scanned = await until(() => S.items.length === CFG.count, 30000);
  check('Library scan finds every test file', scanned, `${S.items.length} of ${CFG.count}`);
  const byRel = rel => S.items.find(it => it.rec.rel === rel);

  for (const f of CFG.fixtures) {
    const it = byRel(f.rel), e = f.expect;
    if (!it) { check(`Indexed: ${f.rel}`, false, 'missing'); continue; }
    const ok = it.rec.ch === e.ch && it.cls === e.cls && (!e.sr || it.rec.sr === e.sr);
    check(`Format and layout: ${f.rel}`, ok, `${it.rec.ch} ch, ${it.cls}, ${it.rec.sr} Hz`);
  }
  const zip = S.items.find(it => it.zip);
  check('Zip with audio is listed', zip && zip.rec.zip === 1, zip ? `${zip.rec.zip} file inside` : 'not listed');

  // Search and filters
  const visible = () => S.view.filter(x => !x.isFolder && !x.isMissing).length;
  S.query = 'door'; sf.applyFilters();
  check('Search "door"', visible() === 2, `${visible()} found`);
  S.query = '-door'; sf.applyFilters();
  check('Search "-door" excludes', visible() === CFG.count - 2, `${visible()} found`);
  S.query = ''; S.sr = '96000'; sf.applyFilters();
  check('Rate filter 96 kHz', visible() === 1, `${visible()} found`);
  S.sr = ''; sf.applyFilters();
  metrics.filterAllMs = (() => { const t = performance.now(); for (let i = 0; i < 10; i++) sf.applyFilters(); return +((performance.now() - t) / 10).toFixed(2); })();

  // Long compressed files are decoded a piece at a time; lower the limits so the short test files are too.
  const chunkMod = await import('./js/chunked.js');
  chunkMod.CHUNKING.minSeconds = 3;
  chunkMod.CHUNKING.segSeconds = 1;

  // Levels (peak per channel) for every file with a known level
  for (const f of CFG.fixtures.filter(x => x.expect.peaks)) {
    const i = S.view.findIndex(it => it.rec && it.rec.rel === f.rel);
    if (i < 0) { check(`Peak levels: ${f.rel}`, false, 'not listed'); continue; }
    await sf.selectIndex(i, { play: false });
    const got = await until(() => sf.wave.levels && S.current && S.current.rec.rel === f.rel, 15000);
    const lv = got ? sf.wave.levels.ch.map(c => +c.peak.toFixed(4)) : [];
    const ok = got && f.expect.peaks.every((p, c) => near(lv[c], p, 0.01));
    check(`Peak levels: ${f.rel}`, ok, got ? `expected ${f.expect.peaks.join(' / ')}, got ${lv.join(' / ')}` : 'no levels');
  }

  // Piece-by-piece decoding must match decoding the whole file, across every seam.
  for (const f of CFG.fixtures.filter(x => x.chunked)) {
    const i = S.view.findIndex(it => it.rec && it.rec.rel === f.rel);
    await sf.selectIndex(i, { play: false });
    await until(() => S.current && S.current.rec.rel === f.rel && S.source && S.source.idx, 10000);
    const src = S.source;
    if (!src || !src.idx) { check(`Piece-by-piece decoding: ${f.rel}`, false, 'not decoded in pieces'); continue; }
    const bytes = await window.api.readFile(S.current.path);
    const full = await new OfflineAudioContext(1, 1, src.sr).decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    const ref = full.getChannelData(0), mine = (await src.readFrames(0, src.frames))[0];
    // A whole-file MP3 decode drops the encoder delay at the start; line the two up first.
    let lag = 0;
    if (f.chunked === 'mp3') {
      let best = Infinity;
      for (let L = 0; L <= 3000; L++) {
        let e = 0;
        for (let k = 40000; k < 44000; k += 3) e += Math.abs(mine[k + L] - ref[k]);
        if (e < best) { best = e; lag = L; }
      }
    }
    let maxErr = 0;
    const from = f.chunked === 'mp3' ? 4608 : 0, n = Math.min(ref.length, mine.length - lag);
    for (let k = from; k < n; k++) { const d = Math.abs(mine[k + lag] - ref[k]); if (d > maxErr) maxErr = d; }
    const ok = src.idx.kind === f.chunked && src.idx.segs.length >= 3 && maxErr < (f.chunked === 'mp3' ? 1e-3 : 1e-6);
    check(`Piece-by-piece decoding: ${f.rel}`, ok, `${src.idx.segs.length} pieces, offset ${lag}, largest difference ${maxErr.toExponential(1)}`);
  }

  // Loudness: a 1 kHz tone at −20 dBFS (mono) is −23.0 LUFS by definition.
  const toneF = CFG.fixtures.find(x => x.lufs != null);
  const ti = S.view.findIndex(it => it.rec && it.rec.rel === toneF.rel);
  await sf.selectIndex(ti, { play: false });
  await until(() => S.current && S.current.rec.rel === toneF.rel && S.loud && !S.loud.est, 10000);
  check('Loudness measurement (LUFS)', S.loud && near(S.loud.lufs, toneF.lufs, 0.15) && near(S.loud.tp, -20, 0.2), S.loud ? `${S.loud.lufs} LUFS, ${S.loud.tp} dBTP` : 'not measured');
  check('Loudness shows in the info panel', /LUFS/.test(document.querySelector('#file-meta').textContent));
  sf.prefs.matchTarget = -20; sf.setMatch(true);
  const g1 = sf.engine.trimDb;
  sf.prefs.matchTarget = -14; sf.applySetting('matchTarget', -14);
  const g2 = sf.engine.trimDb;
  sf.setMatch(false);
  check('Matched loudness gain', g1 === 3 && g2 === 9 && sf.engine.trimDb === 0, `+${g1} dB at −20, +${g2} dB at −14, ${sf.engine.trimDb} dB off`);
  delete sf.prefs.matchTarget;

  // Varispeed: +12 semitones plays twice as fast.
  const longI = S.view.findIndex(it => it.rec && it.rec.rel === 'Long Room Tone.wav');
  await sf.selectIndex(longI, { play: false });
  sf.setVarispeed(12, true);
  sf.engine.play({ from: 0 });
  await wait(500);
  const p0 = sf.engine.position(), t0 = performance.now();
  await wait(1000);
  const speed = (sf.engine.position() - p0) / ((performance.now() - t0) / 1000) / S.source.sr;
  sf.engine.stop(); sf.setVarispeed(0, true);
  check('Varispeed +12 st plays at double speed', speed > 1.8 && speed < 2.2 && sf.engine.rate === 1, `${speed.toFixed(2)}× speed`);

  // Spectrogram: the 1 kHz tone at −20 dBFS shows as one bright line at 1 kHz.
  await sf.selectIndex(ti, { play: false });
  sf.setSpecView(true);
  const specDone = await until(() => sf.wave.spec.overview && sf.wave.spec.overview.final, 10000);
  const ov = sf.wave.spec.overview;
  let best = 0, bestBin = 0;
  if (ov) { const col = Math.floor(ov.cols / 2) * ov.bins; for (let k = 0; k < ov.bins; k++) if (ov.data[0][col + k] > best) { best = ov.data[0][col + k]; bestBin = k; } }
  const hz = bestBin * (ov ? ov.sr / ov.N : 0), lineDb = best * 160 / 255 - 160;
  check('Spectrogram shows a tone at its frequency and level', specDone && near(hz, 1000, 30) && near(lineDb, -20, 2), ov ? `${Math.round(hz)} Hz at ${lineDb.toFixed(1)} dB, ${ov.cols} columns` : 'not computed');
  sf.wave.setView(S.source.frames * 0.5, S.source.frames * 0.5 + 4800);
  const detail = await until(() => sf.wave.spec.detail && sf.wave.spec.detail.final, 5000);
  check('Spectrogram computes detail when zoomed in', detail && sf.wave.spec.detail.end - sf.wave.spec.detail.start < S.source.frames, detail ? `${sf.wave.spec.detail.cols} columns over ${Math.round(sf.wave.spec.detail.end - sf.wave.spec.detail.start)} frames` : 'none');
  sf.wave.setView(0, S.source.frames);
  sf.setSpecView(false);
  check('Waveform view returns', !sf.wave.specOn && document.querySelector('#db-head').textContent === 'dB');

  // Quick switching while playing must not stop playback or report errors
  const errs = [];
  sf.engine.on('error', e => errs.push(String(e)));
  // Ends on the 90-second file, so it must still be playing when checked.
  const pcm = S.view.map((it, k) => [it, k]).filter(([it]) => !it.isFolder && !it.zip && it.rec && it.rec.codec !== 'decode')
    .sort((a, b) => a[0].rec.dur - b[0].rec.dur);
  for (const [, k] of pcm) { sf.selectIndex(k, { play: true }); await wait(50); }
  await wait(1200);
  const last = pcm[pcm.length - 1][0];
  const ok = errs.length === 0 && sf.engine.playing && S.current === last;
  check('Quick switching while playing', ok, `${errs.length} errors, ${sf.engine.playing ? 'playing' : 'stopped'} ${S.current && S.current.name}`);
  sf.engine.stop();

  // ---------------------------------------------------------------- your sounds
  const key = (k, o = {}) => document.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, ...o }));
  const setQuery = q => { S.query = q; sf.applyFilters(); };
  const tick = byRel('UI/Click Tick.aif'), rain = byRel('Ambience/Rain Ambience Loop.wav');
  await sf.selectIndex(S.view.indexOf(tick), { play: false });
  key('4', { ctrlKey: true });
  check('Ctrl+4 rates a sound', sf.ratingOf(tick) === 4, `${sf.ratingOf(tick)} stars`);
  document.querySelector('#f-rating').value = '4'; document.querySelector('#f-rating').dispatchEvent(new Event('change'));
  check('Rating filter (4 stars and up)', visible() === 1, `${visible()} listed`);
  document.querySelector('#f-rating').value = ''; document.querySelector('#f-rating').dispatchEvent(new Event('change'));
  setQuery('rating:4+');
  check('Search rating:4+', visible() === 1, `${visible()} found`);
  const starsIn = () => [...document.querySelectorAll('#list .row')].some(r => r.style.display !== 'none' && r.querySelectorAll('.c-rate .rs.on').length === 4);
  await until(starsIn, 3000);
  const shown = [...document.querySelectorAll('#list .row')].filter(r => r.querySelector('.c-name') && r.querySelector('.c-name').textContent.startsWith('Click Tick'));
  check('Ratings show in the list', shown.some(r => r.querySelectorAll('.c-rate .rs.on').length === 4), `${shown.length} row(s)`);
  setQuery('');
  key('0', { ctrlKey: true });
  const cleared = sf.ratingOf(tick) === 0;
  key('z', { ctrlKey: true });
  check('Clearing a rating can be undone', cleared && sf.ratingOf(tick) === 4, `cleared ${cleared}, after undo ${sf.ratingOf(tick)}`);

  const notes = document.querySelector('#mine-notes');
  notes.value = 'Squeaky hinge, great for menus';
  notes.dispatchEvent(new Event('input', { bubbles: true }));
  notes.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  setQuery('hinge');
  check('Notes are saved and searchable', visible() === 1 && S.view[0] === tick && S.mine.sounds[tick.path].n.includes('hinge'), `${visible()} found`);
  setQuery('has:notes');
  check('Search has:notes', visible() === 1, `${visible()} found`);
  setQuery('');

  S.cursor = Math.round(0.25 * 44100);
  key('k');
  const mk = (S.mine.sounds[tick.path].m || [])[0];
  check('K drops a marker at the playhead', mk && Math.abs(mk[0] - 0.25) < 0.01 && sf.wave.markers.length === 1 && !!document.querySelector('.wm-flag'), mk ? `${mk[1]} at ${mk[0]} s` : 'none');
  const mkName = document.querySelector('#meta-mine .mk-name');
  mkName.value = 'Best click'; mkName.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  check('Markers can be named', S.mine.sounds[tick.path].m[0][1] === 'Best click' && document.querySelector('.wm-flag').textContent === 'Best click');

  // Synonyms and typos ("Explosion Big 5.1" is the only explosion)
  setQuery('blast');
  check('Synonyms: "blast" finds the explosion', visible() === 1 && /Explosion/.test(S.view[0].name), `${visible()} found`);
  setQuery('"blast"');
  check('Quotes turn synonyms off', visible() === 0, `${visible()} found`);
  setQuery('explsion');
  check('Small typos are forgiven', visible() === 1 && /Explosion/.test(S.view[0].name), `${visible()} found`);
  setQuery('door');
  const exactFirst = S.view.length >= 2 && S.view.slice(0, 2).every(it => /door/i.test(it.name));
  check('Exact matches are listed before synonym matches', exactFirst, S.view.map(it => it.name).join(', ').slice(0, 80));
  setQuery('');

  // Recently played (the quick-switching test played every PCM sound)
  S.scope = { type: 'recent' }; sf.applyFilters();
  check('Recently played lists what was played, newest first', visible() >= 5 && S.view[0].path === S.mine.recent[0][0], `${visible()} listed`);
  S.scope = { type: 'all' }; sf.applyFilters();

  // Find similar: the sound itself first, then the rest
  await sf.findSimilar(rain);
  check('Find similar sounds', S.scope.type === 'similar' && S.view[0] === rain && S.view.length > 3 && !document.querySelector('#sim-banner').hidden, `${S.view.length} listed`);
  document.querySelector('#sim-banner [data-a=close]').click();

  // Hiding a folder from All sounds (it stays listed when opened)
  const allN = visible();
  const ambN = S.items.filter(it => it.folder === 'Ambience').length;
  sf.setFolderHidden(rain.lib, 'Ambience', true);
  const hiddenOk = visible() === allN - ambN;
  sf.openFolder(rain.lib, 'Ambience');
  const stillThere = S.view.filter(it => !it.isFolder).length === ambN;
  S.scope = { type: 'all' }; sf.applyFilters();
  setQuery('rain');
  const searchHidden = visible() === 0;
  setQuery('');
  sf.runUndo();
  check('Hide a folder from All sounds', hiddenOk && stillThere && searchHidden && visible() === allN, `hidden ${hiddenOk}, listed in its folder ${stillThere}, kept out of search ${searchHidden}, back after undo ${visible() === allN}`);

  // An entry follows its file when it moves (same name and size, only one match)
  S.mine.sounds['C:\\Moved away\\Click Tick.aif'] = S.mine.sounds[tick.path];
  delete S.mine.sounds[tick.path];
  const moved = sf.relinkMine();
  check('Notes and ratings follow a moved file', moved === 1 && sf.ratingOf(tick) === 4, `${moved} moved`);
  sf.setRating([rain], 5); // looked for after the restart

  // Projects
  const p = { id: 'testproj', name: 'Test project', created: Date.now(), items: [] };
  S.projects.push(p);
  sf.addToProject(p, S.items.filter(it => !it.zip).slice(0, 3), true);
  sf.openProject(p);
  check('Project lists its sounds', visible() === 3, `${visible()} listed`);
  sf.removeFromProject(p, [p.items[0].path]);
  check('Remove from project', visible() === 2, `${visible()} listed`);
  sf.runUndo();
  check('Removing from a project can be undone', visible() === 3, `${visible()} listed`);
  S.projects = S.projects.filter(x => x !== p); sf.saveProjects();
  S.scope = { type: 'all' }; sf.applyFilters();

  // Duplicates
  await sf.findDupes('name');
  const ng = S.dupes && S.dupes.groups;
  check('Duplicate names found', ng && ng.length === 1 && ng[0].paths.length === 2, ng ? `${ng.length} group(s)` : 'none');
  const ag = await window.api.findDupes();
  const doors = (ag || []).find(g => g.paths.every(x => /Door Slam Wood 01\.wav$/.test(x)));
  check('Identical audio found', doors && doors.paths.length === 2, ag ? `${ag.length} group(s)` : 'none');
  S.dupes = null; S.dupesRaw = null; S.scope = { type: 'all' }; sf.applyFilters();

  // Category from the file name
  const door = byRel('Doors/Door Slam Wood 01.wav');
  check('Category from name', door && door.type !== 'unsorted', door && door.type);

  // ---------------------------------------------------------------- safety (dialogs answered by the test)
  const D = window.api.testDialogs;
  const boxes = log => log.filter(d => d.kind === 'box');
  const has = (log, re) => boxes(log).some(d => re.test(d.message + ' ' + d.detail));
  const three = S.items.filter(it => !it.zip).slice(0, 3);
  const expItems = three.map(it => ({ path: it.path, rel: `${it.lib.name}/${it.rec.rel}`, size: it.rec.size }));
  const sp = { id: 'sizeproj', name: 'Size project', created: Date.now(), items: [] };
  S.projects.push(sp);
  sf.addToProject(sp, three, true);
  sf.openProject(sp);
  const want = three.reduce((t, it) => t + it.rec.size, 0);
  const banner = document.querySelector('#proj-banner').textContent;
  check('Project shows its materialized size', /\d[\d.]* (KB|MB|GB)/.test(banner), banner.replace(/\s+/g, ' ').slice(0, 90));
  S.projects = S.projects.filter(x => x !== sp); sf.saveProjects();
  S.scope = { type: 'all' }; sf.applyFilters();

  await D({ open: CFG.exportDir, box: [] });
  let r = await window.api.exportProject({ mode: 'copy', name: 'Test export', items: expItems.map((x, i) => (i ? x : { ...x, markers: [[1.5, 'Test mark']] })), layout: 'flat', manifest: true, markerList: true });
  check('Materialize copies a project', r && r.count === 3, r ? `${r.count} copied, ${r.bytes} bytes of ${want}` : 'nothing');
  check('Exports include a markers list', await window.api.exists(CFG.exportDir + '\\Test export\\_Markers.txt'));

  await D({ open: CFG.exportDir, box: [] });
  r = await window.api.exportProject({ mode: 'copy', name: 'Too big', items: expItems.map(x => ({ ...x, size: 1e15 })), layout: 'flat', manifest: true });
  let log = await D(null);
  check('Materialize refuses when the drive is too small', r === null && has(log, /isn't enough free space/), r === null ? 'refused' : 'went ahead');
  check('Nothing left behind after a refused copy', !(await window.api.exists(CFG.exportDir + '\\Too big')));

  await D({ open: CFG.libDir, box: [] });
  r = await window.api.exportProject({ mode: 'copy', name: 'Inside lib', items: expItems, layout: 'flat', manifest: true });
  log = await D(null);
  check('Warns before materializing inside a library', r === null && has(log, /inside your library/), r === null ? 'stopped at the warning' : 'went ahead');

  const est = await window.api.dupesEstimate();
  check('Duplicate search estimates what it will read', est.files === 2 && est.bytes === 2 * door.rec.size, `${est.files} files, ${est.bytes} bytes`);

  // Going ahead anyway puts 3 copies inside the library folder: folder watching should list them by itself.
  const before = S.items.length;
  await D({ open: CFG.libDir, box: [0] });
  r = await window.api.exportProject({ mode: 'copy', name: 'Watched copies', items: expItems, layout: 'flat', manifest: true });
  const seen = await until(() => S.items.length === before + 3, 20000);
  check('New files in a library folder show up by themselves', r && r.count === 3 && seen, `${S.items.length - before} new`);

  sf.prefs.safety = { confirmFiles: 2 }; sf.savePrefs(); await wait(100);
  await D({ open: CFG.exportDir, box: [] });
  r = await window.api.exportProject({ mode: 'copy', name: 'Big job', items: expItems, layout: 'flat', manifest: true });
  log = await D(null);
  check('Big jobs ask a second time', r === null && boxes(log).some(d => d.title === 'Large job' && /3 sounds/.test(d.message)), boxes(log).map(d => d.title).join(', '));
  delete sf.prefs.safety; sf.savePrefs(); await wait(100);

  await D({ box: [] });
  const doorPath = door.path;
  const gone = await window.api.trash([doorPath], '');
  log = await D(null);
  check('Recycle shows the size and cancelling keeps the file', gone.length === 0 && has(log, /\(\d[\d.]* (B|KB|MB)\)/) && await window.api.exists(doorPath), boxes(log).map(d => d.message).join(' | '));

  const zipIt = S.items.find(it => it.zip);
  const z1 = await window.api.extractZip(zipIt.path, 'here', zipIt.lib.id);
  const z2 = await window.api.extractZip(zipIt.path, 'here', zipIt.lib.id);
  check('Extract never overwrites existing files', z1 && z1.skipped === 0 && z2 && z2.skipped === 1, `first skipped ${z1 && z1.skipped}, second skipped ${z2 && z2.skipped}`);


  // A "preview" that is really a multi-GB original asks first (nothing is downloaded here: it's cancelled).
  const huge = { key: 'test:huge', source: 'archive', sourceLabel: 'Test', title: 'Huge field recording', previewIsOriginal: true, size: 3e9, previewSize: 3e9, previewUrl: 'https://example.invalid/huge.wav', previewExt: 'wav', ext: 'wav', license: 'cc0', duration: 3600 };
  const pending = sf.loadOnline(huge, { play: false });
  await until(() => !document.querySelector('#modal').hidden, 3000);
  const q = document.querySelector('#modal').textContent;
  document.querySelector('#modal [data-a=cancel]')?.click();
  await pending;
  check('Asks before downloading a huge preview', /2\.8 GB/.test(q) && sf.wave.message.includes('not downloaded'), q.slice(0, 60));

  await D({ open: CFG.driveRoot, box: [] });
  const added = await window.api.addLibraries();
  log = await D({ open: null });
  check('Warns before linking a whole drive', added.length === 0 && has(log, /a whole drive/), added.length ? 'linked it' : 'skipped');

  // ---------------------------------------------------------------- Team SFX (a local stand-in for the Lighthouse service)
  if (CFG.team) {
    const T = window.api.teamsfx;
    const stats = () => window.api.testTeamStats();
    await T.set({ key: 'lhsk_wrong' });
    let msg = '';
    try { await T.sync(true); } catch (err) { msg = String(err.message || err); }
    check('Team SFX: a wrong key is explained', /Soundfield key/.test(msg), msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '').slice(0, 70));
    await T.set({ key: 'lhsk_test_ok' });
    let st = await T.sync(true);
    check('Team SFX: the index loads', st.hasKey && st.files === 2 && !/lhsk_test_ok/.test(JSON.stringify(st)), `${st.files} sounds, key shown as ${st.keyHint}`);
    const found = await window.api.online.search({ query: 'pistol', page: 1, sources: ['teamsfx'], types: ['wav', 'aiff', 'flac', 'mp3', 'ogg'] });
    const hit = found.results[0];
    check('Team SFX: search', found.results.length === 1 && hit.title === 'Pistol Shot 01' && hit.licenseText.startsWith('Epidemic') && found.totals.teamsfx === 1, hit ? `${hit.title} · ${hit.licenseText}` : JSON.stringify(found.errors));
    const file = hit && await window.api.online.preview(hit).catch(e => String(e));
    const s1 = await stats();
    check('Team SFX: listening downloads the file through the service', typeof file === 'string' && await window.api.exists(file) && s1.fileGets === 1, String(file).slice(-40));
    const entry = await window.api.online.download(hit, CFG.exportDir + '\\Team saves').catch(e => ({ error: String(e) }));
    const s2 = await stats();
    check('Team SFX: Save reuses the preview', entry && entry.quality === 'original' && entry.licenseText && s2.fileGets === 1, entry.error || `${entry.quality}, ${s2.fileGets} download(s)`);
    await until(() => S.libs.some(l => entry.path && entry.path.startsWith(l.path)), 5000);
    for (const l of S.libs.filter(l => entry.path && entry.path.startsWith(l.path))) { await window.api.removeLibrary(l.id); S.libs = S.libs.filter(x => x !== l); }
    const up = await T.upload({ paths: [tick.path], folder: 'Drop here/../Test pack', credits: 'Recorded by the test' });
    const s3 = await stats();
    const u0 = s3.uploads[0] || {};
    check('Team SFX: adding a sound (with credits)', up.done.length === 1 && u0.name === 'Click Tick.aif' && u0.folder === 'Drop here/Test pack' && u0.size === tick.rec.size && s3.credits[0] && s3.credits[0].text === 'Recorded by the test', `${u0.folder} / ${u0.name}, ${u0.size} bytes`);
    st = await T.sync(true);
    check('Team SFX: the index picks up changes with its cursor', st.files === 3 && s3.index + 1 === (await stats()).index, `${st.files} sounds`);
    await T.set({ forget: true });
  }

  // ---------------------------------------------------------------- settings panel
  sf.settingsUI.open('waveform');
  const panel = document.querySelector('#settings');
  check('Settings opens', !panel.hidden && /Level scale range/.test(panel.textContent), panel.hidden ? 'hidden' : 'open');
  const floorSel = [...panel.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === '-60'));
  floorSel.value = '-60'; floorSel.dispatchEvent(new Event('change'));
  check('A setting applies at once and is saved', sf.wave.dbFloor === -60 && sf.prefs.dbFloor === -60, `scale ${sf.wave.dbFloor}, saved ${sf.prefs.dbFloor}`);
  const num = panel.querySelector('input[type=number]');
  num.value = '7'; num.dispatchEvent(new Event('change'));
  check('Numbers are kept in range', sf.prefs.peakWarnDb === 0, `peak warning ${sf.prefs.peakWarnDb}`);
  [...panel.querySelectorAll('button')].find(b => /^Reset /.test(b.textContent)).click();
  check('Reset a section to defaults', sf.prefs.dbFloor === -40 && sf.prefs.peakWarnDb === -1 && sf.wave.dbFloor === -40, `floor ${sf.prefs.dbFloor}, warning ${sf.prefs.peakWarnDb}`);
  const ss = panel.querySelector('#set-search');
  ss.value = 'recycle'; ss.dispatchEvent(new Event('input'));
  check('Search finds settings in any section', /network or USB/.test(panel.textContent), panel.querySelectorAll('.set-row').length + ' rows');
  ss.value = ''; ss.dispatchEvent(new Event('input'));
  sf.settingsUI.open('look');
  const dens = [...panel.querySelectorAll('select')].find(s => [...s.options].some(o => o.value === 'roomy'));
  dens.value = 'roomy'; dens.dispatchEvent(new Event('change'));
  await wait(50);
  const rowH = document.querySelector('#list .row') && document.querySelector('#list .row').getBoundingClientRect().height;
  check('Row height setting', rowH === 32, `${rowH}px rows`);
  dens.value = 'normal'; dens.dispatchEvent(new Event('change'));
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  check('Esc closes Settings', panel.hidden);
  const report = await window.api.problemReport();
  check('Problem report', report.startsWith(`Soundfield ${CFG.version}`), report.split('\n')[0]);

  // The level-range slider stays where it's left, across restarts
  const rangeIn = document.querySelector('#spec-range-in');
  rangeIn.value = '95'; rangeIn.dispatchEvent(new Event('input'));
  // A preference to look for after the restart
  sf.prefs.testMarker = CFG.marker;
  sf.savePrefs();
  if (window.gc) window.gc();
  if (performance.memory) metrics.heapMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
  await wait(600); // let the settings save go out
  return { results, metrics };
})()
