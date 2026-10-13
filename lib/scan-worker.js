// Walks a library folder, keeping only audio files, and probes headers.
// Unchanged files (same size + mtime) reuse their previous index record.
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fsp = require('fs/promises');
const path = require('path');
const { probe, isAudioFile } = require('./probe');
const { zipAudioCount } = require('./zip');

const SKIP_DIRS = new Set(['system volume information', '$recycle.bin', '__macosx', '.trashes', '.spotlight-v100', '.fseventsd', 'node_modules']);

async function pool(items, limit, fn) {
  let i = 0;
  const run = async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
}

function toRecord(rel, info) {
  const r = {
    rel, size: info.size, mtime: info.mtime,
    sr: info.sr, ch: info.ch, bits: info.bits || 0,
    dur: Math.round(info.dur * 1000) / 1000,
    codec: info.codec,
  };
  if (info.mask) r.mask = info.mask;
  if (info.desc) r.desc = info.desc;
  if (info.trackNames && info.trackNames.some(Boolean)) r.tn = info.trackNames;
  if (info.ambiGuid) r.ag = 1;
  return r;
}

async function main() {
  const { root, prev } = workerData;
  try {
    const st = await fsp.stat(root);
    if (!st.isDirectory()) throw new Error('not a directory');
  } catch {
    parentPort.postMessage({ type: 'offline' });
    return;
  }
  const prevMap = new Map((prev || []).map(r => [r.rel, r]));
  const files = [];
  let lastPost = 0;
  const progress = (phase, done, total) => {
    const now = Date.now();
    if (now - lastPost < 150) return;
    lastPost = now;
    parentPort.postMessage({ type: 'progress', phase, done, total });
  };

  // Phase 1: walk (parallel across directories).
  const dirs = [''];
  let active = 0;
  await new Promise(resolve => {
    const next = () => {
      while (active < 8 && dirs.length) {
        const rel = dirs.pop();
        active++;
        fsp.opendir(path.join(root, rel)).then(async d => {
          for await (const e of d) {
            const lower = e.name.toLowerCase();
            if (e.isDirectory()) {
              if (!SKIP_DIRS.has(lower) && !e.name.startsWith('.') && !e.name.startsWith('$')) dirs.push(rel ? rel + '/' + e.name : e.name);
            } else if (e.isFile() && (isAudioFile(e.name) || (lower.endsWith('.zip') && !e.name.startsWith('.')))) {
              files.push(rel ? rel + '/' + e.name : e.name);
              progress('walk', files.length, 0);
            }
          }
        }).catch(() => {}).finally(() => {
          active--;
          if (!active && !dirs.length) resolve();
          else next();
        });
      }
    };
    next();
  });

  // Phase 2: stat + probe changed files.
  const out = new Array(files.length);
  let done = 0;
  await pool(files, 16, async (rel, k) => {
    const full = path.join(root, rel);
    try {
      const old = prevMap.get(rel);
      if (old) {
        const st = await fsp.stat(full);
        if (st.size === old.size && Math.round(st.mtimeMs) === old.mtime) { out[k] = old; return; }
      }
      if (rel.toLowerCase().endsWith('.zip')) {
        // Only archives that actually contain audio are listed.
        const st = await fsp.stat(full);
        const z = await zipAudioCount(full);
        if (z && z.audio > 0) out[k] = { rel, size: st.size, mtime: Math.round(st.mtimeMs), zip: z.audio, zb: z.bytes };
        return;
      }
      const info = await probe(full);
      if (info) out[k] = toRecord(rel, info);
    } finally {
      done++;
      progress('probe', done, files.length);
    }
  });

  const records = out.filter(Boolean);
  records.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  // Nothing added, removed or changed: the caller can keep what it has.
  const unchanged = records.length === prevMap.size && records.every(r => prevMap.get(r.rel) === r);
  parentPort.postMessage(unchanged ? { type: 'done', unchanged: true, count: records.length } : { type: 'done', records });
}

main().catch(err => parentPort.postMessage({ type: 'error', message: String(err && err.message || err) }));
