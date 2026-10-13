// Small JSON persistence in the app's userData folder. Libraries are only
// references to folders; audio files are never copied or moved.
'use strict';
const fs = require('fs');
const path = require('path');

let dir = null;

function init(userData) {
  dir = userData;
  fs.mkdirSync(path.join(dir, 'index'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'analysis'), { recursive: true });
}

function file(name) { return path.join(dir, name); }

function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(file(name), 'utf8')); } catch { return fallback; }
}

const pause = ms => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const LOCKED = new Set(['EBUSY', 'EPERM', 'EACCES']);

// Write to a temp file, then swap it in. Windows can briefly lock the target
// (antivirus, search indexer, cloud sync), so retry, then fall back to writing
// in place. A failed save is logged, never thrown: it must not crash the app.
function writeJson(name, value) {
  const f = file(name);
  const data = JSON.stringify(value);
  const tmp = `${f}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(tmp, data);
    for (let i = 0; ; i++) {
      try { fs.renameSync(tmp, f); return; }
      catch (e) { if (!LOCKED.has(e.code) || i >= 8) throw e; pause(25 * (i + 1)); }
    }
  } catch (e) {
    try { fs.writeFileSync(f, data); }
    catch (e2) { console.error(`Couldn't save ${name}:`, e2.message); }
    try { fs.unlinkSync(tmp); } catch {}
  }
}

module.exports = {
  init,
  libraries: () => readJson('libraries.json', []),
  saveLibraries: libs => writeJson('libraries.json', libs),
  index: id => readJson(path.join('index', id + '.json'), []),
  saveIndex: (id, records) => writeJson(path.join('index', id + '.json'), records),
  dropIndex: id => {
    for (const d of ['index', 'analysis']) { try { fs.unlinkSync(file(path.join(d, id + '.json'))); } catch {} }
  },
  analysis: id => readJson(path.join('analysis', id + '.json'), {}),
  saveAnalysis: (id, map) => writeJson(path.join('analysis', id + '.json'), map),
  projects: () => readJson('projects.json', []),
  saveProjects: list => writeJson('projects.json', list),
  typeOverrides: () => readJson('types.json', {}),
  saveTypeOverrides: map => writeJson('types.json', map),
  favorites: () => readJson('favorites.json', []),
  saveFavorites: list => writeJson('favorites.json', list),
  online: () => readJson('online.json', {}),
  saveOnline: o => writeJson('online.json', o),
  downloads: () => readJson('downloads.json', {}),
  saveDownloads: m => writeJson('downloads.json', m),
  overrides: () => readJson('overrides.json', {}),
  saveOverrides: map => writeJson('overrides.json', map),
  // Measured loudness: { "path|size|mtime": [lufs, truePeak] }.
  loudness: () => readJson('loudness.json', {}),
  saveLoudness: map => writeJson('loudness.json', map),
  // Preferences (null until the first save, so old browser-stored ones can be moved over).
  settings: () => readJson('settings.json', null),
  saveSettings: s => writeJson('settings.json', s),
};
