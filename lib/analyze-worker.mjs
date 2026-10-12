// Listens to sounds whose names don't reveal their type. Reads at most ~9 s
// per file (three 3 s windows for long files), so it stays light on the disk.
import { parentPort, workerData } from 'node:worker_threads';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { decodePcm } from '../shared/pcm.mjs';
import { metaCategory, analyzeFeatures, classifyFeatures, ANALYSIS_VERSION } from '../shared/categorize.mjs';

const require = createRequire(import.meta.url);
const { probe } = require('./probe.js');

const { root, records, cache } = workerData; // cache: { rel: [size, mtime, cat, version] }

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
  let batch = {}, last = Date.now(), done = 0;
  const flush = () => {
    parentPort.postMessage({ type: 'results', results: batch, done, total: todo.length });
    batch = {};
    last = Date.now();
  };
  if (todo.length) parentPort.postMessage({ type: 'results', results: {}, done: 0, total: todo.length });
  for (const r of todo) {
    let cat = null;
    try { cat = await classify(path.join(root, r.rel)); } catch {}
    batch[r.rel] = [r.size, r.mtime, cat, ANALYSIS_VERSION];
    done++;
    if (Date.now() - last > 1500) flush();
  }
  flush();
  parentPort.postMessage({ type: 'done' });
}

main().catch(err => parentPort.postMessage({ type: 'error', message: String(err && err.message || err) }));
