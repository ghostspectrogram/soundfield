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
    if (performance.memory) metrics.heapMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
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

  // A preference to look for after the restart
  sf.prefs.testMarker = CFG.marker;
  sf.savePrefs();
  if (performance.memory) metrics.heapMB = +(performance.memory.usedJSHeapSize / 1048576).toFixed(1);
  await wait(600); // let the settings save go out
  return { results, metrics };
})()
