// Exports a project's sounds in the background, either into one zip or
// copied into a real folder ("materialize"). Both share the same planning:
// files that are gone are reported, never fatal; clashing names get " (2)".
'use strict';
const { parentPort, workerData } = require('worker_threads');
const fs = require('fs');
const path = require('path');
const { writeZip } = require('./zipwrite');

const { mode, items, dest, layout, manifest, projectName } = workerData;
// items: [{ path, rel }] — rel is "Library/sub/file.wav", used for "keep folders".

const INVALID = /[<>:"|?*\x00-\x1f]/g;
const cleanPart = s => s.replace(INVALID, '_').replace(/[. ]+$/, '') || '_';

function plan() {
  const used = new Set();
  const out = [], missing = [];
  for (const it of items) {
    let st;
    try { st = fs.statSync(it.path); } catch { missing.push(it.path); continue; }
    if (!st.isFile()) { missing.push(it.path); continue; }
    let name = layout === 'keep' && it.rel
      ? it.rel.split(/[\\/]/).map(cleanPart).join('/')
      : cleanPart(path.basename(it.path));
    // Same name twice: "kick.wav", "kick (2).wav", ...
    const dot = name.lastIndexOf('.');
    const base = dot > 0 ? name.slice(0, dot) : name, ext = dot > 0 ? name.slice(dot) : '';
    for (let n = 2; used.has(name.toLowerCase()); n++) name = `${base} (${n})${ext}`;
    used.add(name.toLowerCase());
    out.push({ from: it.path, name, size: st.size });
  }
  return { files: out, missing };
}

function manifestText(files, missing) {
  const lines = [
    `${projectName} — exported by Soundfield ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `${files.length} sound${files.length === 1 ? '' : 's'}${missing.length ? `, ${missing.length} missing` : ''}`,
    '',
    'File in export\tOriginal location',
    ...files.map(f => `${f.name}\t${f.from}`),
  ];
  if (missing.length) lines.push('', 'Missing (not exported):', ...missing);
  return lines.join('\r\n') + '\r\n';
}

function main() {
  const { files, missing } = plan();
  const total = files.length;
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let last = 0;
  const progress = (done, bytes) => {
    const now = Date.now();
    if (now - last < 150 && done < total) return;
    last = now;
    parentPort.postMessage({ type: 'progress', done, total, bytes, totalBytes });
  };
  progress(0, 0);

  if (mode === 'zip') {
    const entries = files.map(f => ({ name: f.name, path: f.from }));
    if (manifest) entries.push({ name: '_Original locations.txt', data: Buffer.from(manifestText(files, missing), 'utf8') });
    writeZip(dest, entries, { onProgress: (d, _t, bytes) => progress(Math.min(d, total), bytes) });
    parentPort.postMessage({ type: 'done', dest, count: total, missing, bytes: fs.statSync(dest).size, copies: [] });
    return;
  }

  // Materialize: copy into dest, then verify each copy's size.
  fs.mkdirSync(dest, { recursive: true });
  const copies = [], failed = [];
  let bytes = 0;
  files.forEach((f, i) => {
    const to = path.join(dest, ...f.name.split('/'));
    try {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(f.from, to, fs.constants.COPYFILE_EXCL);
      if (fs.statSync(to).size !== f.size) throw new Error('size mismatch after copy');
      copies.push({ from: f.from, to });
    } catch (err) {
      failed.push(`${f.from} (${err.code || err.message})`);
    }
    bytes += f.size;
    progress(i + 1, bytes);
  });
  if (manifest) fs.writeFileSync(path.join(dest, '_Original locations.txt'), manifestText(files, missing), 'utf8');
  parentPort.postMessage({ type: 'done', dest, count: copies.length, missing: missing.concat(failed), bytes, copies });
}

try { main(); } catch (err) { parentPort.postMessage({ type: 'error', message: String(err && err.message || err) }); }
