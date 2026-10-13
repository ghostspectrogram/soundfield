// One-command checks for Soundfield. Runs the app hidden, never touching your own data.
//   npm test                 functional tests on a generated test library (about a minute)
//   npm test -- --perf       speed run on a COPY of your real library index (no audio is read)
//   npm test -- --perf --save-baseline   remember this machine's speed run for later comparison
// Exits with code 1 if anything fails, or (with --perf) if something got clearly slower.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync, spawn } = require('child_process');
const { makeFixtures } = require('./fixtures');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const ELECTRON = require('electron'); // path to electron.exe
const EVAL = fs.readFileSync(path.join(__dirname, 'test-eval.js'), 'utf8');
const BASELINE = path.join(__dirname, '.perf-baseline.json'); // per machine, not committed
const args = process.argv.slice(2);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'soundfield-test-'));
const userData = path.join(tmp, 'userdata');
fs.mkdirSync(userData, { recursive: true });

// Starts Soundfield hidden, runs `script` in its window, returns what it returned.
function run(script, extraEnv = {}) {
  // --expose-gc: memory is read after a garbage collection, so the number is stable from run to run.
  const r = spawnSync(ELECTRON, ['--js-flags=--expose-gc', ROOT], {
    env: {
      ...process.env, SF_USERDATA: userData, SF_DOWNLOADS: path.join(tmp, 'downloads'),
      SF_SNAPSHOT: path.join(tmp, 'shot.png'), SF_SNAPSHOT_DELAY: '1200', SF_EVAL_WAIT: '300', SF_EVAL: script, ...extraEnv,
    },
    encoding: 'utf8', maxBuffer: 64 << 20, timeout: 240000, windowsHide: true,
  });
  const line = (r.stdout || '').split(/\r?\n/).find(l => l.startsWith('[eval] ') || l.startsWith('[eval error]'));
  if (!line) throw new Error(`Soundfield gave no answer (exit ${r.status}).\n${(r.stderr || '').slice(-2000)}`);
  if (line.startsWith('[eval error]')) throw new Error(`${line} (mode ${(script.match(/"mode":"(\w+)"/) || [])[1] || '?'})`);
  return JSON.parse(line.slice(7));
}
// A crash inside the test page is reported with its stack instead of a bare message.
const withCfg = cfg => `const CFG = ${JSON.stringify(cfg)};\n(async () => { try { return await ${EVAL.trim().replace(/;$/, '')}; } catch (e) { return { results: [{ name: 'Test script crashed', ok: false, detail: String((e && e.stack) || e).slice(0, 800) }], metrics: {} }; } })()`;

function report(title, out) {
  console.log(`\n${title}`);
  for (const r of out.results) console.log(`  ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
  return out.results.filter(r => !r.ok).length;
}

// Checks of lib/ helpers that run in Node directly (no window needed).
async function unitTests(lib) {
  const results = [];
  const check = (name, ok, detail = '') => results.push({ name, ok: !!ok, detail: String(detail) });
  const { probe } = require('../lib/probe');
  const { writeRegionSync } = require('../lib/region');
  const { zipListing } = require('../lib/zip');
  const out = path.join(tmp, 'regions');
  const long = path.join(lib, 'Long Room Tone.wav');
  const info = await probe(long);
  const f = writeRegionSync(long, info, 48000 * 10, 48000 * 70, out); // 60 s, written in pieces
  const got = await probe(f);
  check('Region export of a long selection', got && got.frames === 48000 * 60 && got.ch === 1 && fs.statSync(f).size === 44 + 48000 * 60 * 2, got ? `${got.frames} frames, ${fs.statSync(f).size} bytes` : 'unreadable');
  const aif = path.join(lib, 'UI', 'Click Tick.aif');
  const ai = await probe(aif);
  const f2 = writeRegionSync(aif, ai, 0, ai.frames, out);
  const a2 = await probe(f2);
  check('Region export converts AIFF to WAV', a2 && a2.frames === ai.frames && a2.codec === 'pcm' && !a2.be, a2 ? `${a2.frames} frames` : 'unreadable');
  const z = await zipListing(path.join(lib, 'Packs', 'Small Pack.zip'));
  check('Zip listing', z && z.files.length === 1 && z.total > 0 && z.zipSize > 0, z ? `${z.files.length} file, ${z.total} bytes` : 'unreadable');

  // Backups: keep the newest automatic ones; manual and "before restore" ones are never pruned.
  const backup = require('../lib/backup');
  const ud = path.join(tmp, 'bk-userdata'), bd = path.join(tmp, 'bk');
  fs.mkdirSync(ud, { recursive: true });
  fs.writeFileSync(path.join(ud, 'projects.json'), JSON.stringify([{ id: 'p', name: 'Kept', items: [] }]));
  fs.writeFileSync(path.join(ud, 'online.json'), JSON.stringify({ tsKey: 'secret' }));
  const b1 = backup.create(ud, bd, { kind: 'manual' });
  check('Backups leave account keys out', !b1.files.includes('online.json') && b1.files.includes('projects.json'), b1.files.join(', '));
  const t0 = Date.now();
  for (let i = 0; i < 5; i++) { const b = backup.create(ud, bd); fs.utimesSync(b.path, new Date(t0 - i * 864e5), new Date(t0 - i * 864e5)); }
  const prune = backup.toPrune(backup.list(bd), 3);
  check('Old automatic backups are picked for cleanup', prune.length === 2 && prune.every(b => b.kind === 'auto'), `${prune.length} of ${backup.list(bd).length}`);
  fs.writeFileSync(path.join(ud, 'projects.json'), '[]');
  backup.restore(ud, b1.path);
  check('Restore puts the files back', JSON.parse(fs.readFileSync(path.join(ud, 'projects.json'), 'utf8'))[0].name === 'Kept');
  fs.writeFileSync(path.join(bd, 'Soundfield backup 2026-01-01 0000.sfbackup'), 'not a backup');
  let bad = '';
  try { backup.read(path.join(bd, 'Soundfield backup 2026-01-01 0000.sfbackup')); } catch (e) { bad = e.message; }
  check('A damaged backup is refused', /isn’t a Soundfield backup/.test(bad), bad);
  return { results };
}

(async () => {
let failed = 0, mock = null;
try {
  if (args.includes('--perf')) {
    // A copy of the real index: startup, filtering, search and project speed on your actual library size.
    const real = path.join(process.env.APPDATA, 'Soundfield');
    for (const f of ['libraries.json', 'projects.json', 'favorites.json', 'overrides.json', 'types.json']) {
      if (fs.existsSync(path.join(real, f))) fs.copyFileSync(path.join(real, f), path.join(userData, f));
    }
    for (const d of ['index', 'analysis']) if (fs.existsSync(path.join(real, d))) fs.cpSync(path.join(real, d), path.join(userData, d), { recursive: true });
    const out = run(withCfg({ mode: 'perf' }), { SF_NO_SCAN: '1', SF_TEST: '1' });
    failed += report('Speed run (copy of your library index)', out);
    const m = out.metrics;
    console.log('');
    const base = fs.existsSync(BASELINE) ? JSON.parse(fs.readFileSync(BASELINE, 'utf8')) : null;
    for (const [k, v] of Object.entries(m)) {
      const b = base && base[k];
      let note = '';
      // Timing and memory: more than 25% (and a noticeable amount) above the baseline is flagged.
      if (b != null && /Ms$|MB$/.test(k) && v > b * 1.25 && v - b > (/MB$/.test(k) ? 20 : 5)) { note = `  SLOWER than baseline ${b}`; failed++; }
      else if (b != null) note = `  (baseline ${b})`;
      console.log(`  ${k.padEnd(14)} ${v}${note}`);
    }
    if (args.includes('--save-baseline')) { fs.writeFileSync(BASELINE, JSON.stringify(m, null, 2)); console.log('\nSaved as this machine’s baseline.'); }
  } else {
    const lib = path.join(tmp, 'library');
    const { count, fixtures } = makeFixtures(lib);
    fs.writeFileSync(path.join(userData, 'libraries.json'), JSON.stringify([{ id: 'testlib', name: 'Test Library', path: lib, count: 0, addedAt: Date.now() }]));
    const marker = 'm' + Date.now();
    // 1. An older Soundfield kept preferences in browser storage: put some there, then remove settings.json.
    run(`(async () => { localStorage.setItem('sf.prefs', JSON.stringify({ migratedProbe: 'from-localStorage', volume: -12 })); await new Promise(r => setTimeout(r, 300)); return { results: [], metrics: {} }; })()`, { SF_NO_SCAN: '1' });
    fs.rmSync(path.join(userData, 'settings.json'), { force: true });
    // 2. First start of this version. Dialogs are answered by the test (SF_TEST). Team SFX talks to a
    //    local stand-in for the Lighthouse service (tools/mock-teamsfx.js).
    mock = spawn(process.execPath, [path.join(__dirname, 'mock-teamsfx.js')], { stdio: ['ignore', 'pipe', 'inherit'] });
    const port = await new Promise((res, rej) => { mock.stdout.once('data', d => res(String(d).trim())); mock.once('error', rej); });
    const exportDir = path.join(tmp, 'exports');
    fs.mkdirSync(exportDir);
    const team = `http://127.0.0.1:${port}`;
    const first = run(withCfg({ mode: 'first', version: pkg.version, count, fixtures, marker, exportDir, libDir: lib, driveRoot: path.parse(tmp).root, team }), { SF_TEST: '1', SF_TEAMSFX_BASE: team, SF_BACKUPS: path.join(tmp, 'backups') });
    failed += report('First start', first);
    // 3. Restart: preferences and the index must still be there (plus the sound extracted from the
    //    zip and the 3 copies made inside the library).
    const again = run(withCfg({ mode: 'restart', count: count + 4, marker }), { SF_NO_SCAN: '1' });
    failed += report('Restart', again);
    failed += report('File helpers', await unitTests(lib));
    console.log(`\n  boot ${first.metrics.bootMs} ms · filter ${first.metrics.filterAllMs} ms · heap ${first.metrics.heapMB} MB`);
  }
} catch (e) {
  console.error('\nTEST RUN FAILED:', e.message);
  failed++;
} finally {
  if (mock) mock.kill();
  if (!args.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`\nKept test files in ${tmp}`);
}
console.log(failed ? `\n${failed} problem(s).` : '\nAll good.');
process.exit(failed ? 1 : 0);
})();
