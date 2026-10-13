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
  const r = spawnSync(ELECTRON, [ROOT], {
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

let failed = 0;
try {
  if (args.includes('--perf')) {
    // A copy of the real index: startup, filtering, search and project speed on your actual library size.
    const real = path.join(process.env.APPDATA, 'Soundfield');
    for (const f of ['libraries.json', 'projects.json', 'favorites.json', 'overrides.json', 'types.json']) {
      if (fs.existsSync(path.join(real, f))) fs.copyFileSync(path.join(real, f), path.join(userData, f));
    }
    for (const d of ['index', 'analysis']) if (fs.existsSync(path.join(real, d))) fs.cpSync(path.join(real, d), path.join(userData, d), { recursive: true });
    const out = run(withCfg({ mode: 'perf' }), { SF_NO_SCAN: '1' });
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
    // 2. First start of this version.
    const first = run(withCfg({ mode: 'first', version: pkg.version, count, fixtures, marker }));
    failed += report('First start', first);
    // 3. Restart: preferences and the index must still be there.
    const again = run(withCfg({ mode: 'restart', count, marker }), { SF_NO_SCAN: '1' });
    failed += report('Restart', again);
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
