// Writes a small test library of known sounds, so tests can check exact levels and layouts.
'use strict';
const fs = require('fs');
const path = require('path');
const { writeZip } = require('../lib/zipwrite');

// A sine at `amp` (1 = 0 dBFS) per channel; amps: [ch0, ch1, ...].
function tone(sr, seconds, amps, freq = 440) {
  const n = Math.round(sr * seconds);
  return amps.map((a, c) => {
    const out = new Float64Array(n);
    for (let i = 0; i < n; i++) out[i] = a * Math.sin(2 * Math.PI * (freq + c * 110) * i / sr);
    return out;
  });
}

// WAV: bits 16 / 24 (PCM) or 32 float. mask = channel mask (WAVE_FORMAT_EXTENSIBLE).
function wav(chans, sr, bits, { float = false, mask = 0 } = {}) {
  const ch = chans.length, n = chans[0].length, bytes = bits / 8, ba = ch * bytes;
  const ext = ch > 2 || mask || bits > 16;
  const fmt = Buffer.alloc(ext ? 40 : 16);
  fmt.writeUInt16LE(ext ? 0xfffe : float ? 3 : 1, 0);
  fmt.writeUInt16LE(ch, 2);
  fmt.writeUInt32LE(sr, 4);
  fmt.writeUInt32LE(sr * ba, 8);
  fmt.writeUInt16LE(ba, 12);
  fmt.writeUInt16LE(bits, 14);
  if (ext) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(bits, 18);
    fmt.writeUInt32LE(mask, 20);
    Buffer.from([float ? 3 : 1, 0, 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]).copy(fmt, 24);
  }
  const data = Buffer.alloc(n * ba);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = Math.max(-1, Math.min(1, chans[c][i])), p = i * ba + c * bytes;
    if (float) data.writeFloatLE(v, p);
    else if (bits === 16) data.writeInt16LE(Math.round(v * 32767), p);
    else data.writeIntLE(Math.round(v * 8388607), p, 3);
  }
  const chunk = (id, body) => { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32LE(body.length, 4); return [h, body]; };
  const parts = [...chunk('fmt ', fmt), ...chunk('data', data)];
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(4 + parts.reduce((s, b) => s + b.length, 0), 4);
  riff.write('WAVE', 8, 'latin1');
  return Buffer.concat([riff, ...parts]);
}

// 16-bit big-endian AIFF.
function aiff(chans, sr) {
  const ch = chans.length, n = chans[0].length;
  const comm = Buffer.alloc(18);
  comm.writeInt16BE(ch, 0);
  comm.writeUInt32BE(n, 2);
  comm.writeInt16BE(16, 6);
  // 80-bit extended sample rate
  let e = 16383 + 63, m = BigInt(sr);
  while (!(m & (1n << 63n))) { m <<= 1n; e--; }
  comm.writeUInt16BE(e, 8);
  comm.writeBigUInt64BE(m, 10);
  const ssnd = Buffer.alloc(8 + n * ch * 2);
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) ssnd.writeInt16BE(Math.round(Math.max(-1, Math.min(1, chans[c][i])) * 32767), 8 + (i * ch + c) * 2);
  const chunk = (id, body) => { const h = Buffer.alloc(8); h.write(id, 0, 'latin1'); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]); };
  const body = Buffer.concat([Buffer.from('AIFF', 'latin1'), chunk('COMM', comm), chunk('SSND', ssnd)]);
  const form = Buffer.alloc(8);
  form.write('FORM', 0, 'latin1');
  form.writeUInt32BE(body.length, 4);
  return Buffer.concat([form, body]);
}

// 16-bit FLAC with "verbatim" (uncompressed) subframes: valid FLAC that any decoder reads,
// written without a real encoder. Fixed 4096-sample blocks.
function flac(chans, sr) {
  const ch = chans.length, n = chans[0].length, BS = 4096;
  const crc8 = (b, e) => { let c = 0; for (let i = 0; i < e; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; } return c; };
  const crc16 = b => { let c = 0; for (const x of b) { c ^= x << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; } return c; };
  const si = Buffer.alloc(34);
  si.writeUInt16BE(BS, 0); si.writeUInt16BE(BS, 2);
  // sample rate (20 bits) | channels-1 (3) | bits-1 (5) | total samples (36)
  const total = BigInt(n);
  const packed = (BigInt(sr) << 44n) | (BigInt(ch - 1) << 41n) | (15n << 36n) | total;
  si.writeBigUInt64BE(packed, 10);
  const parts = [Buffer.from('fLaC', 'latin1'), Buffer.from([0x80, 0, 0, 34]), si];
  const srCode = { 44100: 9, 48000: 10, 96000: 11 }[sr];
  for (let f = 0, start = 0; start < n; f++, start += BS) {
    const len = Math.min(BS, n - start);
    const head = [0xff, 0xf8, ((len === BS ? 12 : 7) << 4) | srCode, ((ch - 1) << 4) | (4 << 1)];
    // frame number, UTF-8 style
    if (f < 0x80) head.push(f);
    else if (f < 0x800) head.push(0xc0 | (f >> 6), 0x80 | (f & 0x3f));
    else head.push(0xe0 | (f >> 12), 0x80 | ((f >> 6) & 0x3f), 0x80 | (f & 0x3f));
    if (len !== BS) head.push((len - 1) >> 8, (len - 1) & 0xff);
    head.push(crc8(head, head.length));
    const body = Buffer.alloc(ch * (1 + len * 2));
    let p = 0;
    for (let c = 0; c < ch; c++) {
      body[p++] = 0x02; // verbatim subframe
      for (let i = 0; i < len; i++, p += 2) body.writeInt16BE(Math.round(Math.max(-1, Math.min(1, chans[c][start + i])) * 32767), p);
    }
    const frame = Buffer.concat([Buffer.from(head), body]);
    const crc = Buffer.alloc(2); crc.writeUInt16BE(crc16(frame), 0);
    parts.push(frame, crc);
  }
  return Buffer.concat(parts);
}

// The library. `expect` is what the tests check (peak per channel, layout class, ...).
const FIXTURES = [
  { rel: 'Doors/Door Slam Wood 01.wav', make: () => wav(tone(48000, 1, [0.5]), 48000, 16), expect: { ch: 1, cls: 'mono', peaks: [0.5] } },
  { rel: 'Doors/Copies/Door Slam Wood 01.wav', make: () => wav(tone(48000, 1, [0.5]), 48000, 16), expect: { ch: 1, cls: 'mono', peaks: [0.5] } },
  { rel: 'Ambience/Rain Ambience Loop.wav', make: () => wav(tone(48000, 3, [0.5, 0.25]), 48000, 24), expect: { ch: 2, cls: 'stereo', peaks: [0.5, 0.25] } },
  { rel: 'Ambience/Wind Gusts Float.wav', make: () => wav(tone(96000, 1, [0.7, 0.7]), 96000, 32, { float: true }), expect: { ch: 2, cls: 'stereo', sr: 96000, peaks: [0.7, 0.7] } },
  { rel: 'Explosions/Explosion Big 5.1.wav', make: () => wav(tone(48000, 2, [0.8, 0.8, 0.5, 0.1, 0.4, 0.4]), 48000, 24, { mask: 0x3f }), expect: { ch: 6, cls: 'surround', peaks: [0.8, 0.8, 0.5, 0.1, 0.4, 0.4] } },
  { rel: 'Ambisonic/Forest AmbiX FOA.wav', make: () => wav(tone(48000, 2, [0.5, 0.3, 0.3, 0.3]), 48000, 24), expect: { ch: 4, cls: 'ambi' } },
  { rel: 'UI/Click Tick.aif', make: () => aiff(tone(44100, 0.5, [0.25]), 44100), expect: { ch: 1, cls: 'mono', sr: 44100, peaks: [0.25] } },
  { rel: 'Long Room Tone.wav', make: () => wav(tone(48000, 90, [0.1], 120), 48000, 16), expect: { ch: 1, cls: 'mono', peaks: [0.1] } },
  // Compressed files: the tests lower the length limit so these are decoded a piece at a time.
  { rel: 'Ambience/Forest Bed.flac', make: () => flac(tone(44100, 20, [0.4, 0.2], 330), 44100), expect: { ch: 2, cls: 'stereo', sr: 44100, peaks: [0.4, 0.2] }, chunked: 'flac' },
  { rel: 'Vehicles/Car Window.mp3', make: () => fs.readFileSync(path.join(__dirname, 'test-media', 'car-window-freesound-50891.mp3')), expect: { ch: 1, cls: 'mono', sr: 44100 }, chunked: 'mp3' },
];

function makeFixtures(root) {
  fs.mkdirSync(root, { recursive: true });
  for (const f of FIXTURES) {
    const p = path.join(root, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.make());
  }
  // A zip holding one sound.
  const z = path.join(root, 'Packs', 'Small Pack.zip');
  fs.mkdirSync(path.dirname(z), { recursive: true });
  writeZip(z, [{ name: 'Pack Hit.wav', data: wav(tone(48000, 0.3, [0.5]), 48000, 16) }]);
  return { count: FIXTURES.length + 1, fixtures: FIXTURES.map(f => ({ rel: f.rel, expect: f.expect, chunked: f.chunked || '' })) };
}

module.exports = { makeFixtures };
