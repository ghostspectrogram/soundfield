// Backups of Soundfield's own data: projects, favorites, your notes / ratings / markers, settings,
// libraries, category and layout choices, and where downloaded sounds came from. No audio files,
// no caches (they're rebuilt), and no account keys (online.json stays on this PC).
// A backup is one gzipped JSON file: "Soundfield backup 2026-10-13 0830.sfbackup".
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const FILES = ['settings.json', 'libraries.json', 'projects.json', 'favorites.json', 'sounds.json', 'types.json', 'overrides.json', 'downloads.json'];
const EXT = '.sfbackup';
const NAME = /^Soundfield backup (\d{4}-\d{2}-\d{2}) (\d{4})(?:-(\d+))?(?: \((manual|before restore)\))?\.sfbackup$/i;

const pad = n => String(n).padStart(2, '0');
const stamp = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;

// kind: 'auto' | 'manual' | 'before restore'. Returns { path, size, at, kind, files }.
function create(userData, dir, { kind = 'auto', version = '' } = {}) {
  const files = {};
  for (const f of FILES) {
    try { files[f] = fs.readFileSync(path.join(userData, f), 'utf8'); } catch {}
  }
  const at = new Date();
  const body = zlib.gzipSync(Buffer.from(JSON.stringify({ app: 'Soundfield', format: 1, version, kind, createdAt: at.toISOString(), files }), 'utf8'));
  fs.mkdirSync(dir, { recursive: true });
  const base = `Soundfield backup ${stamp(at)}`, tail = kind === 'auto' ? '' : ` (${kind})`;
  let file = path.join(dir, base + tail + EXT);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base}-${n}${tail}${EXT}`);
  const tmp = file + '.part';
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, file);
  return { path: file, size: body.length, at: at.getTime(), kind, files: Object.keys(files) };
}

function read(file) {
  let j;
  try { j = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8')); }
  catch { throw new Error('This isn’t a Soundfield backup (or the file is damaged).'); }
  if (!j || j.app !== 'Soundfield' || !j.files || typeof j.files !== 'object') throw new Error('This isn’t a Soundfield backup.');
  for (const [k, v] of Object.entries(j.files)) {
    if (!FILES.includes(k) || typeof v !== 'string') throw new Error('This backup has unexpected contents, so it wasn’t restored.');
    try { JSON.parse(v); } catch { throw new Error(`This backup's ${k} is damaged, so it wasn’t restored.`); }
  }
  return j;
}

// Writes the backup's files over the current ones (only the files it has).
function restore(userData, file) {
  const j = read(file);
  for (const [k, v] of Object.entries(j.files)) {
    const dest = path.join(userData, k), tmp = `${dest}.restore`;
    fs.writeFileSync(tmp, v);
    fs.renameSync(tmp, dest);
  }
  return { createdAt: j.createdAt, version: j.version, files: Object.keys(j.files) };
}

// Backups in a folder, newest first: [{ path, name, size, at, kind }].
function list(dir) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = NAME.exec(name);
    if (!m) continue;
    try {
      const st = fs.statSync(path.join(dir, name));
      out.push({ path: path.join(dir, name), name, size: st.size, at: st.mtimeMs, kind: (m[4] || 'auto').toLowerCase() });
    } catch {}
  }
  return out.sort((a, b) => b.at - a.at);
}

// Automatic backups past the newest `keep` (manual ones and "before restore" ones are yours to keep).
function toPrune(items, keep) {
  return items.filter(b => b.kind === 'auto').sort((a, b) => b.at - a.at).slice(Math.max(1, keep));
}

module.exports = { FILES, EXT, create, read, restore, list, toPrune };
