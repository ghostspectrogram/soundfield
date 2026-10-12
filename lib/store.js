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

function writeJson(name, value) {
  const f = file(name);
  const tmp = f + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(value));
  fs.renameSync(tmp, f);
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
  typeOverrides: () => readJson('types.json', {}),
  saveTypeOverrides: map => writeJson('types.json', map),
  favorites: () => readJson('favorites.json', []),
  saveFavorites: list => writeJson('favorites.json', list),
  overrides: () => readJson('overrides.json', {}),
  saveOverrides: map => writeJson('overrides.json', map),
};
