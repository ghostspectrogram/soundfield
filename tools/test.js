// One-command checks for Soundfield. Runs the app hidden, never touching your own data.
//   npm test                 functional tests on a generated test library (about a minute)
//   npm test -- --perf       speed run on a COPY of your real library index (no audio is read)
//   npm test -- --perf --save-baseline   remember this machine's speed run for later comparison
// Exits with code 1 if anything fails, or (with --perf) if something got clearly slower.
'use strict';
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawnSync } = require('child_process');
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
  if (line.startsWith('[eval error]')) throw new Error(line);
  return JSON.parse(line.slice(7));
}
const withCfg = cfg => `const CFG = ${JSON.stringify(cfg)};\n${EVAL}`;

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
  return { results };
}

(async () => {
let failed = 0;
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
    // 2. First start of this version. Dialogs are answered by the test (SF_TEST).
    const exportDir = path.join(tmp, 'exports');
    fs.mkdirSync(exportDir);
    const first = run(withCfg({ mode: 'first', version: pkg.version, count, fixtures, marker, exportDir, libDir: lib, driveRoot: path.parse(tmp).root }), { SF_TEST: '1' });
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
  if (!args.includes('--keep')) fs.rmSync(tmp, { recursive: true, force: true });
  else console.log(`\nKept test files in ${tmp}`);
}
console.log(failed ? `\n${failed} problem(s).` : '\nAll good.');
process.exit(failed ? 1 : 0);
})();
