// Finds files with identical audio. Stages, cheapest first:
//   1. group by format + length from the index (no disk access)
//   2. hash three 64 KB slices of the audio data
//   3. hash the full audio data of whatever still collides
// Only the audio payload is hashed for PCM files, so copies that differ only
// in name or metadata (BWF, iXML, tags) still match.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const crypto = require('crypto');
const { probe } = require('./probe');

const SLICE = 64 * 1024;
const CHUNK = 4 << 20;

function groupBy(list, keyFn) {
  const m = new Map();
  for (const x of list) {
    const k = keyFn(x);
    if (k == null) continue;
    let g = m.get(k);
    if (!g) m.set(k, (g = []));
    g.push(x);
  }
  return [...m.values()].filter(g => g.length > 1);
}

function readInto(fd, buf, len, pos) {
  let got = 0;
  while (got < len) {
    const n = fs.readSync(fd, buf, got, len - got, pos + got);
    if (!n) break;
    got += n;
  }
  return got;
}

function quickHash(f) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(f.path, 'r');
  try {
    const buf = Buffer.allocUnsafe(SLICE);
    const { off, len } = f;
    const points = len <= SLICE * 3 ? [off] : [off, off + Math.floor(len / 2) - SLICE / 2, off + len - SLICE];
    for (const p of points) {
      const n = readInto(fd, buf, Math.min(SLICE, off + len - p), p);
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

function fullHash(f, onBytes) {
  const h = crypto.createHash('sha1');
  const fd = fs.openSync(f.path, 'r');
  try {
    const buf = Buffer.allocUnsafe(CHUNK);
    let pos = f.off;
    const end = f.off + f.len;
    while (pos < end) {
      const n = readInto(fd, buf, Math.min(CHUNK, end - pos), pos);
      if (!n) break;
      h.update(buf.subarray(0, n));
      pos += n;
      onBytes(n);
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

async function main() {
  const { files } = workerData; // [{ path, size, key }]
  let last = 0;
  const progress = (stage, done, total) => {
    const now = Date.now();
    if (now - last < 150 && done < total) return;
    last = now;
    parentPort.postMessage({ type: 'progress', stage, done, total });
  };

  // 1. same format + length
  const cands = groupBy(files, f => f.key).flat();

  // Locate the audio payload of each candidate.
  let done = 0;
  for (const f of cands) {
    try {
      const info = await probe(f.path);
      if (info && (info.codec === 'pcm' || info.codec === 'float')) { f.off = info.dataOffset; f.len = info.frames * info.blockAlign; }
      else if (info) { f.off = 0; f.len = info.size; }
    } catch {}
    progress('Reading headers', ++done, cands.length);
  }

  // 2. sampled hash
  const stage2 = groupBy(cands.filter(f => f.len > 0), f => f.key + '|' + f.len);
  const flat2 = stage2.flat();
  done = 0;
  for (const f of flat2) {
    try { f.q = quickHash(f); } catch { f.q = null; }
    progress('Comparing audio', ++done, flat2.length);
  }

  // 3. full hash
  const stage3 = groupBy(flat2, f => (f.q ? f.len + '|' + f.q : null));
  const flat3 = stage3.flat();
  const totalBytes = flat3.reduce((s, f) => s + f.len, 0);
  let bytes = 0;
  for (const f of flat3) {
    try { f.h = fullHash(f, n => { bytes += n; progress('Verifying', bytes, totalBytes); }); } catch { f.h = null; }
  }
  const groups = groupBy(flat3, f => (f.h ? f.len + '|' + f.h : null))
    .map(g => ({ paths: g.map(f => f.path), size: g[0].size, wasted: g.slice(1).reduce((s, f) => s + f.size, 0) }))
    .sort((a, b) => b.wasted - a.wasted);
  parentPort.postMessage({ type: 'done', groups });
}

main().catch(err => parentPort.postMessage({ type: 'error', message: String(err && err.message || err) }));
