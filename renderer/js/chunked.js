// Long MP3 and FLAC files are decoded about 10 s at a time instead of all at once, so a
// 25-minute MP3 needs a few MB of memory instead of ~600 MB. The file's frames are indexed
// first (MP3 frame headers / FLAC frame headers), then each piece is turned into a small
// stand-alone file the browser can decode:
//   MP3:  a run of frames, starting 3 frames early so the bit reservoir and overlap are
//         primed; the extra output is trimmed from the front.
//   FLAC: the stream header + a run of frames (FLAC frames decode independently).
// Pieces are decoded when needed (playback, zoomed waveform) and a few are kept.
import { PeakBuilder, bucketFor } from '../../shared/pcm.mjs';

export const CHUNKING = { minSeconds: 120, segSeconds: 10 }; // tests lower these

const id3Size = b => (b.length >= 10 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33
  ? 10 + (((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f)) + (b[5] & 0x10 ? 10 : 0) : 0);

// ---------------------------------------------------------------- MP3 (Layer III)
const BR1 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320];
const BR2 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160];
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

function mp3Header(b, p) {
  if (p + 4 > b.length || b[p] !== 0xff || (b[p + 1] & 0xe0) !== 0xe0) return null;
  const ver = (b[p + 1] >> 3) & 3, layer = (b[p + 1] >> 1) & 3, bri = b[p + 2] >> 4, sri = (b[p + 2] >> 2) & 3;
  if (ver === 1 || layer !== 1 || bri === 0 || bri === 15 || sri === 3) return null; // Layer III only, no free format
  const sr = SR[ver][sri], br = (ver === 3 ? BR1 : BR2)[bri] * 1000, pad = (b[p + 2] >> 1) & 1;
  const len = Math.floor((ver === 3 ? 144 : 72) * br / sr) + pad;
  return { ver, sr, len, spf: ver === 3 ? 1152 : 576, mono: (b[p + 3] >> 6) === 3 };
}

export function indexMp3(b) {
  let p = id3Size(b);
  // First frame: one whose successor is also a valid frame (avoids false syncs).
  let h = null;
  for (const lim = Math.min(b.length, p + 65536); p < lim; p++) {
    h = mp3Header(b, p);
    if (h && mp3Header(b, p + h.len)) break;
    h = null;
  }
  if (!h) return null;
  const { ver, sr, spf } = h, ch = h.mono ? 1 : 2;
  // A Xing / Info / VBRI tag frame carries no audio: leave it out.
  const side = ver === 3 ? (h.mono ? 17 : 32) : (h.mono ? 9 : 17);
  const tag = String.fromCharCode(...b.subarray(p + 4 + side, p + 8 + side));
  const vbri = String.fromCharCode(...b.subarray(p + 36, p + 40));
  if (tag === 'Xing' || tag === 'Info' || vbri === 'VBRI') p += h.len;
  const offs = [];
  while (p < b.length) {
    const f = mp3Header(b, p);
    if (!f || f.sr !== sr || f.ver !== ver || p + f.len > b.length) {
      // ID3v1 / APE tag at the end, or garbage: look for the next frame a little further on.
      if (b[p] === 0x54 && b[p + 1] === 0x41 && b[p + 2] === 0x47) break;
      let q = p + 1, found = false;
      for (const lim = Math.min(b.length, p + 4096); q < lim; q++) {
        const g = mp3Header(b, q);
        if (g && g.sr === sr && g.ver === ver && mp3Header(b, q + g.len)) { found = true; break; }
      }
      if (!found) break;
      p = q;
      continue;
    }
    offs.push(p);
    p += f.len;
  }
  if (offs.length < 8) return null;
  offs.push(p); // end of the last frame
  const per = Math.max(8, Math.round(CHUNKING.segSeconds * sr / spf));
  const segs = [];
  for (let a = 0; a < offs.length - 1; a += per) {
    const e = Math.min(a + per, offs.length - 1);
    segs.push({ start: a * spf, n: (e - a) * spf, a, e });
  }
  const WARM = 3;
  return {
    kind: 'mp3', sr, ch, total: (offs.length - 1) * spf, segs,
    bytes: s => { const a0 = Math.max(0, s.a - WARM); return b.slice(offs[a0], offs[s.e]); },
    // The run decoded from a0 includes (a - a0) warm-up frames; keep the last n samples.
    trim: (s, len) => len - s.n,
  };
}

// ---------------------------------------------------------------- FLAC
const crc8 = (b, p, e) => { let c = 0; for (let i = p; i < e; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 0xff : (c << 1) & 0xff; } return c; };

// A frame header at p: { start, n, end of header } or null. `si` is STREAMINFO.
function flacFrame(b, p, si) {
  if (p + 6 > b.length || b[p] !== 0xff || (b[p + 1] & 0xfe) !== 0xf8) return null;
  const variable = b[p + 1] & 1, bsCode = b[p + 2] >> 4, srCode = b[p + 2] & 15;
  if (bsCode === 0 || srCode === 15 || (b[p + 3] & 1) || (b[p + 3] >> 4) > 10) return null;
  // UTF-8-style coded frame or sample number
  let q = p + 4, v = b[q++], extra = 0;
  if (v < 0x80) extra = 0;
  else if ((v & 0xe0) === 0xc0) { extra = 1; v &= 0x1f; } else if ((v & 0xf0) === 0xe0) { extra = 2; v &= 0x0f; }
  else if ((v & 0xf8) === 0xf0) { extra = 3; v &= 0x07; } else if ((v & 0xfc) === 0xf8) { extra = 4; v &= 0x03; }
  else if ((v & 0xfe) === 0xfc) { extra = 5; v &= 0x01; } else if (v === 0xfe) { extra = 6; v = 0; } else return null;
  for (let i = 0; i < extra; i++) { if ((b[q] & 0xc0) !== 0x80) return null; v = v * 64 + (b[q++] & 0x3f); }
  let n;
  if (bsCode === 1) n = 192;
  else if (bsCode <= 5) n = 576 << (bsCode - 2);
  else if (bsCode === 6) n = b[q++] + 1;
  else if (bsCode === 7) { n = ((b[q] << 8) | b[q + 1]) + 1; q += 2; } else n = 256 << (bsCode - 8);
  if (srCode === 12) q += 1; else if (srCode === 13 || srCode === 14) q += 2;
  if (q >= b.length || crc8(b, p, q) !== b[q]) return null;
  return { start: variable ? v : v * si.minBlock, n, hdrEnd: q + 1 };
}

export function indexFlac(b) {
  let p = id3Size(b);
  if (String.fromCharCode(...b.subarray(p, p + 4)) !== 'fLaC') return null;
  p += 4;
  let si = null, last = false, siAt = 0;
  while (!last && p + 4 <= b.length) {
    last = !!(b[p] & 0x80);
    const type = b[p] & 0x7f, len = (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3];
    if (type === 0) {
      const s = p + 4;
      siAt = s;
      si = {
        minBlock: (b[s] << 8) | b[s + 1],
        sr: (b[s + 10] << 12) | (b[s + 11] << 4) | (b[s + 12] >> 4),
        ch: ((b[s + 12] >> 1) & 7) + 1,
      };
    }
    p += 4 + len;
  }
  if (!si || !si.sr) return null;
  // A minimal stream header for each piece: fLaC + STREAMINFO (marked last, length and MD5 unknown).
  const head = new Uint8Array(4 + 4 + 34);
  head.set([0x66, 0x4c, 0x61, 0x43, 0x80, 0, 0, 34]);
  head.set(b.subarray(siAt, siAt + 34), 8);
  head[8 + 13] &= 0xf0;
  head.fill(0, 8 + 14, 8 + 34);
  // Frames: each header must check out and continue exactly where the previous frame ended.
  const units = [];
  let f = flacFrame(b, p, si);
  if (!f) return null;
  units.push({ off: p, start: f.start, n: f.n });
  for (let q = f.hdrEnd; q < b.length - 1; q++) {
    if (b[q] !== 0xff || (b[q + 1] & 0xfe) !== 0xf8) continue;
    const prev = units[units.length - 1];
    const g = flacFrame(b, q, si);
    if (!g || g.start !== prev.start + prev.n) continue;
    units.push({ off: q, start: g.start, n: g.n });
    q = g.hdrEnd - 1;
  }
  const lastU = units[units.length - 1];
  const total = lastU.start + lastU.n;
  units.push({ off: b.length, start: total, n: 0 });
  const segs = [];
  const target = CHUNKING.segSeconds * si.sr;
  for (let a = 0; a < units.length - 1;) {
    let e = a + 1;
    while (e < units.length - 1 && units[e].start - units[a].start < target) e++;
    segs.push({ start: units[a].start, n: units[e].start - units[a].start, a, e });
    a = e;
  }
  return {
    kind: 'flac', sr: si.sr, ch: si.ch, total, segs,
    bytes: s => { const body = b.subarray(units[s.a].off, units[s.e].off); const out = new Uint8Array(head.length + body.length); out.set(head); out.set(body, head.length); return out; },
    trim: () => 0,
  };
}

// ---------------------------------------------------------------- the source
let peakRun = 0; // the newest waveform job; older ones stop early

export class ChunkedSource {
  constructor(path, info, fallback) {
    this.path = path;
    this.info = info;
    this.sr = info.sr || 48000;
    this.ch = info.ch;
    this.frames = info.frames;
    this.streaming = false; // needs open() first
    this.lazy = true;       // reads decode on demand: the engine buffers a little more
    this.fallback = fallback; // () => a whole-file source, for files the index can't read
    this.cache = new Map(); // segment index -> Float32Array[]
  }

  async open() {
    if (this.idx || this.full) return this;
    const u8 = await window.api.readFile(this.path);
    const b = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
    this.idx = indexFlac(b) || indexMp3(b);
    if (!this.idx) {
      // Not something we can split: decode it whole, as before.
      this.full = this.fallback();
      await this.full.open();
      for (const k of ['sr', 'ch', 'frames']) this[k] = this.full[k];
      return this;
    }
    this.sr = this.idx.sr;
    this.frames = this.idx.total;
    const first = await this.segment(0); // also tells us the real channel count
    this.ch = first.length;
    return this;
  }

  async decode(k) {
    const s = this.idx.segs[k];
    const bytes = this.idx.bytes(s);
    const ab = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    const buf = await new OfflineAudioContext(1, 1, this.sr).decodeAudioData(ab);
    const skip = this.idx.trim(s, buf.length);
    const out = [];
    for (let c = 0; c < buf.numberOfChannels; c++) {
      const a = new Float32Array(s.n);
      const src = buf.getChannelData(c);
      // Front-trim the warm-up; if the decoder gave fewer samples than expected, keep the end aligned.
      if (skip >= 0) a.set(src.subarray(skip, skip + s.n));
      else a.set(src.subarray(0, s.n), -skip);
      out.push(a);
    }
    return out;
  }

  async segment(k) {
    const hit = this.cache.get(k);
    if (hit) { this.cache.delete(k); this.cache.set(k, hit); return hit; }
    const p = this.decode(k);
    this.cache.set(k, p);
    try {
      const data = await p;
      if (this.cache.get(k) === p) this.cache.set(k, data);
      while (this.cache.size > 6) this.cache.delete(this.cache.keys().next().value);
      return data;
    } catch (e) { this.cache.delete(k); throw e; }
  }

  segAt(frame) {
    const segs = this.idx.segs;
    let lo = 0, hi = segs.length - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].start <= frame) lo = m; else hi = m - 1; }
    return lo;
  }

  async readFrames(start, n) {
    if (this.full) return this.full.readFrames(start, n);
    start = Math.max(0, Math.min(this.frames, Math.floor(start)));
    n = Math.max(0, Math.min(n, this.frames - start));
    const out = Array.from({ length: this.ch }, () => new Float32Array(n));
    for (let k = this.segAt(start), done = 0; done < n && k < this.idx.segs.length; k++) {
      const s = this.idx.segs[k], data = await this.segment(k);
      const from = start + done - s.start, take = Math.min(n - done, s.n - from);
      if (take <= 0) continue;
      for (let c = 0; c < this.ch; c++) out[c].set((data[c] || data[0]).subarray(from, from + take), done);
      done += take;
    }
    return out;
  }

  // Waveform peaks: one pass over every piece, without keeping them.
  async peaks(jobId, onProgress) {
    if (this.full) return this.full.peaks(jobId, onProgress);
    const run = ++peakRun;
    const pb = new PeakBuilder(this.ch, this.frames, bucketFor(this.frames));
    let last = performance.now();
    for (let k = 0; k < this.idx.segs.length; k++) {
      if (run !== peakRun) return null; // another sound was opened
      const data = this.cache.get(k) instanceof Array ? this.cache.get(k) : await this.decode(k);
      pb.push(data, this.idx.segs[k].n);
      if (onProgress && performance.now() - last > 250) { last = performance.now(); onProgress(pb.snapshot()); }
    }
    return pb.result();
  }
}
