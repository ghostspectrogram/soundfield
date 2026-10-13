// Listens to sounds whose names don't reveal their type. Reads at most ~9 s
// per file (three 3 s windows for long files), so it stays light on the disk.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { decodePcm } from '../shared/pcm.mjs';
import { metaCategory, analyzeFeatures, classifyFeatures, ANALYSIS_VERSION } from '../shared/categorize.mjs';
import { LoudnessMeter } from '../shared/loudness.mjs';

const require = createRequire(import.meta.url);
const { probe } = require('./probe.js');

// cache: { rel: [size, mtime, cat, version] }. loudTodo: short PCM files with no loudness yet.
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
    return classifyFeatures(analyzeFeatures(segs, info.sr, dur));
  } finally {
    fs.closeSync(fd);
  }
}

async function main() {
  const todo = records.filter(r => {
    if (r.zip || r.codec === 'decode') return false;
    if (metaCategory(r.rel, r.desc)) return false;
    const c = cache[r.rel];
    return !(c && c[0] === r.size && c[1] === r.mtime && c[3] === ANALYSIS_VERSION);
  });
  const total = todo.length + loudTodo.length;
  let batch = {}, loud = {}, last = Date.now(), done = 0;
  const flush = () => {
    parentPort.postMessage({ type: 'results', results: batch, loudness: loud, done, total });
    batch = {};
    loud = {};
    last = Date.now();
  };
  if (total) parentPort.postMessage({ type: 'results', results: {}, loudness: {}, done: 0, total });
  for (const r of todo) {
    await whileBusy();
    let cat = null;
    try { cat = await classify(path.join(root, r.rel)); } catch {}
    batch[r.rel] = [r.size, r.mtime, cat, ANALYSIS_VERSION];
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
  flush();
  parentPort.postMessage({ type: 'done' });
}

main().catch(err => parentPort.postMessage({ type: 'error', message: String(err && err.message || err) }));
