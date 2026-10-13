// A stand-in for the Lighthouse Team SFX service, for tools/test.js (never used by the app itself).
// Prints the port it listens on. Accepts only the key "lhsk_test_ok". GET /__stats (no key) reports
// what it was asked for.
'use strict';
const http = require('http');

function wav(seconds = 1, sr = 48000) {
  const n = Math.round(seconds * sr), data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / sr) * 0.3 * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(sr, 24);
  h.writeUInt32LE(sr * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const AUDIO = { 'id:pistol': wav(0.8), 'id:rain': wav(2) };
const files = [
  { id: 'id:pistol', path: 'Armory/Generic Pistol/shot/Pistol Shot 01.wav', name: 'Pistol Shot 01.wav', folder: 'Armory/Generic Pistol/shot', size: AUDIO['id:pistol'].length, modified: '2026-10-13T10:02:11Z', rev: 'r1', duration: 0.8, sampleRate: 48000, channels: 1, category: 'weapons', tags: ['pistol', 'gunshot'], loudnessLufs: -14.2, licence: 'Epidemic Sound (team subscription)', credits: 'Epidemic Sound' },
  { id: 'id:rain', path: 'Ambience/Rain/Rain On Roof 01.wav', name: 'Rain On Roof 01.wav', folder: 'Ambience/Rain', size: AUDIO['id:rain'].length, modified: '2026-10-13T10:05:00Z', rev: 'r1', duration: 2, sampleRate: 48000, channels: 1, category: 'ambience', tags: ['rain'], loudnessLufs: null, licence: 'CC0', credits: 'Recorded by the team' },
];
const stats = { index: 0, fileGets: 0, uploads: [], credits: [] };
let fresh = []; // uploaded since the last index request

const json = (res, status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };

http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  if (u.pathname === '/__stats') return json(res, 200, stats);
  if (u.pathname.startsWith('/dl/')) { // the "temporary download link": no key needed
    const id = decodeURIComponent(u.pathname.slice(4));
    const a = AUDIO[id];
    if (!a) return json(res, 404, { error: 'gone', code: 'not_found' });
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': a.length });
    return res.end(a);
  }
  if (req.headers.authorization !== 'Bearer lhsk_test_ok') return json(res, 401, { error: 'Not signed in', code: 'lh_not_authenticated' });
  if (u.pathname === '/api/teamsfx/index') {
    stats.index++;
    const cursor = u.searchParams.get('cursor');
    const out = cursor ? { cursor: 'c' + stats.index, reset: false, files: fresh, deleted: [] } : { cursor: 'c' + stats.index, reset: false, files: files.concat(fresh), deleted: [] };
    fresh = [];
    return json(res, 200, out);
  }
  if (u.pathname === '/api/teamsfx/file') {
    const id = u.searchParams.get('id');
    if (!AUDIO[id]) return json(res, 404, { error: 'Unknown id', code: 'not_found' });
    stats.fileGets++;
    res.writeHead(302, { Location: `/dl/${encodeURIComponent(id)}` });
    return res.end();
  }
  if (u.pathname === '/api/teamsfx/upload' && req.method === 'POST') {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const folder = u.searchParams.get('folder'), name = u.searchParams.get('name');
      if (!folder || folder.includes('..')) return json(res, 400, { error: 'Bad folder', code: 'bad_folder' });
      const body = Buffer.concat(chunks), id = 'id:up' + (stats.uploads.length + 1);
      stats.uploads.push({ folder, name, size: body.length, type: req.headers['content-type'] });
      AUDIO[id] = body;
      fresh.push({ id, path: `${folder}/${name}`, name, folder, size: body.length, modified: new Date().toISOString(), rev: 'r1', duration: null, sampleRate: null, channels: null, category: null, tags: [], loudnessLufs: null, licence: '', credits: '' });
      json(res, 200, { id, path: `${folder}/${name}` });
    });
    return;
  }
  if (u.pathname === '/api/teamsfx/credits' && req.method === 'POST') {
    let s = '';
    req.on('data', c => { s += c; });
    req.on('end', () => { try { stats.credits.push(JSON.parse(s)); } catch {} json(res, 200, { ok: true }); });
    return;
  }
  json(res, 404, { error: 'Not found', code: 'not_found' });
}).listen(0, '127.0.0.1', function () { console.log(String(this.address().port)); });
