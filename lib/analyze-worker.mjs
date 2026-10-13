// Listens to sounds whose names don't reveal their type. Reads at most ~9 s
// per file (three 3 s windows for long files), so it stays light on the disk.
// The same measurements are kept for every sound (named ones last) for "Find similar sounds".
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { decodePcm } from '../shared/pcm.mjs';
import { metaCategory, analyzeFeatures, classifyFeatures, musicFeatures, ANALYSIS_VERSION } from '../shared/categorize.mjs';
import { LoudnessMeter } from '../shared/loudness.mjs';

const require = createRequire(import.meta.url);
const { probe } = require('./probe.js');

// cache: { rel: [size, mtime, cat, version, features, [bpm, key]?] } (the last only for music). loudTodo: short PCM files with no loudness yet.
// busy: set while something plays; measuring waits so it never competes with playback.
const { root, records, cache, loudTodo = [], busy } = workerData;
const busyFlag = busy ? new Int32Array(busy) : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function whileBusy() { while (busyFlag && Atomics.load(busyFlag, 0)) await sleep(250); }

// Loudness weights without a known layout: 5.1 / 7.1 by channel count, otherwise all equal.
const WEIGHTS = { 6: [1, 1, 1, 0, 1.41, 1.41], 8: [1, 1, 1, 0, 1.41, 1.41, 1.41, 1.41] };

async function measure(full) {
  const info = await probe(full);
  if (!info || (info.codec !== 'pcm' && info.codec !== 'float') || !info.frames) return null;
  const m = new LoudnessMeter(info.sr, info.ch, WEIGHTS[info.ch]);
  const fd = fs.openSync(full, 'r');
  try {
    const step = Math.max(1, Math.floor((1 << 20) / info.blockAlign));
    for (let f = 0; f < info.frames; f += step) {
      const n = Math.min(step, info.frames - f);
      const buf = new Uint8Array(n * info.blockAlign);
      const got = Math.floor(fs.readSync(fd, buf, 0, buf.length, info.dataOffset + f * info.blockAlign) / info.blockAlign);
      if (got <= 0) break;
      m.push(decodePcm(buf.subarray(0, got * info.blockAlign), info, got), got);
    }
  } finally {
    fs.closeSync(fd);
  }
  return m.result();
}

function readSegment(fd, info, start, frames) {
  const ba = info.blockAlign;
  const buf = new Uint8Array(new ArrayBuffer(frames * ba));
  const got = fs.readSync(fd, buf, 0, buf.length, info.dataOffset + start * ba);
  const n = Math.floor(got / ba);
  const planar = decodePcm(buf.subarray(0, n * ba), info, n);
  if (planar.length === 1) return planar[0];
  const mono = new Float32Array(n);
  const k = 1 / planar.length;
  for (const ch of planar) for (let i = 0; i < n; i++) mono[i] += ch[i] * k;
  return mono;
}

async function classify(full) {
  const info = await probe(full);
  if (!info || (info.codec !== 'pcm' && info.codec !== 'float') || !info.frames) return null;
  const dur = info.frames / info.sr;
  const fd = fs.openSync(full, 'r');
  try {
    const segs = [];
    if (dur <= 10) segs.push(readSegment(fd, info, 0, info.frames));
    else {
      const len = Math.round(3 * info.sr);
      for (const at of [0.15, 0.5, 0.85]) segs.push(readSegment(fd, info, Math.floor(info.frames * at - len / 2), len));
    }
    const f = analyzeFeatures(segs, info.sr, dur);
    return { cat: classifyFeatures(f), feat: FEATURES.map(k => Math.round((Number(f[k]) || 0) * 1000) / 1000) };
  } finally {
    fs.closeSync(fd);
  }
}

// Tempo and key of a music file, by ear: 30 s from the middle. Tempo only when the
// listening found a beat (rhythm), so a pad or a drone gets no made-up BPM.
async function listenMusic(full, rhythm) {
  const info = await probe(full);
  if (!info || (info.codec !== 'pcm' && info.codec !== 'float') || !info.frames) return null;
  const len = Math.min(info.frames, Math.round(30 * info.sr));
  const fd = fs.openSync(full, 'r');
  try {
    const m = musicFeatures(readSegment(fd, info, Math.max(0, Math.floor((info.frames - len) / 2)), len), info.sr);
    return [rhythm >= 0.3 ? m.bpm : 0, m.key];
  } finally {
    fs.closeSync(fd);
  }
}

// Kept per sound, in this order (see analyzeFeatures in shared/categorize.mjs).
export const FEATURES = ['med', 'p10', 'p95', 'silent', 'flat', 'onsets', 'rhythm', 'voiced', 'low', 'mod', 'depth'];
const RHYTHM = FEATURES.indexOf('rhythm');
const featObj = (feat, dur) => Object.fromEntries([['dur', dur], ...FEATURES.map((k, i) => [k, feat[i]])]);

async function main() {
  const same = r => { const c = cache[r.rel]; return c && c[0] === r.size && c[1] === r.mtime ? c : null; };
  const fresh = r => { const c = same(r); return c && c[3] === ANALYSIS_VERSION && c[4]; };
  const pcm = records.filter(r => !r.zip && r.codec !== 'decode' && !fresh(r));
  // Measured by an older version: the stored measurements are re-sorted without reading the
  // file again. Only music is listened to again, for its tempo and key.
  const quick = {}, musicTodo = [], todo = [], featTodo = [];
  for (const r of pcm) {
    const meta = metaCategory(r.rel, r.desc);
    const c = same(r);
    if (c && c[3] === 3 && Array.isArray(c[4]) && c[4].length === FEATURES.length) {
      const cat = meta ? null : classifyFeatures(featObj(c[4], r.dur));
      if ((meta || cat) === 'musical') musicTodo.push([r, cat, c[4]]);
      else quick[r.rel] = [r.size, r.mtime, cat, ANALYSIS_VERSION, c[4]];
    } else if (meta) featTodo.push([r, meta]); // named: features only, after everything else
    else todo.push(r); // category from listening + features
  }
  const total = todo.length + musicTodo.length + loudTodo.length + featTodo.length;
  let batch = {}, loud = {}, last = Date.now(), done = 0;
  const flush = () => {
    parentPort.postMessage({ type: 'results', results: batch, loudness: loud, done, total });
    batch = {};
    loud = {};
    last = Date.now();
  };
  if (Object.keys(quick).length) parentPort.postMessage({ type: 'results', results: quick, loudness: {}, done: 0, total });
  else if (total) parentPort.postMessage({ type: 'results', results: {}, loudness: {}, done: 0, total });
  const music = async (full, res) => { try { return await listenMusic(full, res.feat[RHYTHM]); } catch { return null; } };
  for (const r of todo) {
    await whileBusy();
    let res = null;
    const full = path.join(root, r.rel);
    try { res = await classify(full); } catch {}
    const entry = [r.size, r.mtime, res && res.cat, ANALYSIS_VERSION, res ? res.feat : []];
    if (res && res.cat === 'musical') { const m = await music(full, res); if (m) entry.push(m); }
    batch[r.rel] = entry;
    done++;
    if (Date.now() - last > 1500) flush();
  }
  for (const [r, cat, feat] of musicTodo) {
    await whileBusy();
    const entry = [r.size, r.mtime, cat, ANALYSIS_VERSION, feat];
    const m = await music(path.join(root, r.rel), { feat });
    if (m) entry.push(m);
    batch[r.rel] = entry;
    done++;
    if (Date.now() - last > 1500) flush();
  }
  // Then the loudness of short sounds, so matched-loudness preview knows them before they play.
  for (const rel of loudTodo) {
    await whileBusy();
    try { const v = await measure(path.join(root, rel)); if (v && v.lufs != null) loud[rel] = v; } catch {}
    done++;
    if (Date.now() - last > 1500) flush();
    await sleep(2); // stay gentle on the disk
  }
  for (const [r, meta] of featTodo) {
    await whileBusy();
    let res = null;
    const full = path.join(root, r.rel);
    try { res = await classify(full); } catch {}
    batch[r.rel] = [r.size, r.mtime, null, ANALYSIS_VERSION, res ? res.feat : []];
    if (res && meta === 'musical') { const m = await music(full, res); if (m) batch[r.rel].push(m); }
    done++;
    if (Date.now() - last > 1500) flush();
    await sleep(2);
  }
  flush();
  parentPort.postMessage({ type: 'done' });
}

main().catch(err => parentPort.postMessage({ type: 'error', message: String(err && err.message || err) }));
