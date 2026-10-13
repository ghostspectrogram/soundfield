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

  // Projects
  const p = { id: 'testproj', name: 'Test project', created: Date.now(), items: [] };
  S.projects.push(p);
  sf.addToProject(p, S.items.filter(it => !it.zip).slice(0, 3), true);
  sf.openProject(p);
  check('Project lists its sounds', visible() === 3, `${visible()} listed`);
  sf.removeFromProject(p, [p.items[0].path]);
  check('Remove from project', visible() === 2, `${visible()} listed`);
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
  let r = await window.api.exportProject({ mode: 'copy', name: 'Test export', items: expItems, layout: 'flat', manifest: true });
  check('Materialize copies a project', r && r.count === 3, r ? `${r.count} copied, ${r.bytes} bytes of ${want}` : 'nothing');

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

  // A preference to look for after the restart
  sf.prefs.testMarker = CFG.marker;
  sf.savePrefs();
  if (window.gc) window.gc();
  if (performance.memory) metrics.heapMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
  await wait(600); // let the settings save go out
  return { results, metrics };
})()
