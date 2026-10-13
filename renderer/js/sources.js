// Audio sources. PCM WAV / AIFF stream straight off disk in small ranges (no
// full decode, so a 2 GB ambisonic take opens as fast as a 1 s click).
// Compressed formats are decoded once at their native sample rate.
import { decodePcm, PeakBuilder, bucketFor } from '../../shared/pcm.mjs';
import { ChunkedSource, CHUNKING } from './chunked.js';

export function createSource(path, info) {
  if (info.codec === 'pcm' || info.codec === 'float') return new PcmSource(path, info);
  // Long MP3 / FLAC: decoded a piece at a time (see chunked.js), so they don't fill memory.
  if (/\.(mp3|flac)$/i.test(path) && (info.dur || 0) >= CHUNKING.minSeconds) return new ChunkedSource(path, info, () => new DecodedSource(path, info));
  return new DecodedSource(path, info);
}

class PcmSource {
  constructor(path, info) {
    this.path = path;
    this.info = info;
    this.sr = info.sr;
    this.ch = info.ch;
    this.frames = info.frames;
    this.streaming = true;
    this.cache = []; // [{ start, n, data }]
    this.fmt = { codec: info.codec, ch: info.ch, blockAlign: info.blockAlign, be: !!info.be, unsigned8: !!info.unsigned8 };
  }

  async open() { return this; }

  async readFrames(start, n) {
    start = Math.max(0, Math.min(this.frames, Math.floor(start)));
    n = Math.max(0, Math.min(n, this.frames - start));
    const hit = this.cache.find(c => start >= c.start && start + n <= c.start + c.n);
    if (hit) return hit.data.map(a => a.slice(start - hit.start, start - hit.start + n));
    const ba = this.info.blockAlign;
    const u8 = await window.api.readRange(this.path, this.info.dataOffset + start * ba, n * ba);
    const got = Math.floor(u8.byteLength / ba);
    const data = decodePcm(u8, this.fmt, got);
    if (got < n) for (let c = 0; c < data.length; c++) { const a = new Float32Array(n); a.set(data[c]); data[c] = a; }
    // Keep a few small chunks around (loops, re-plays, short files).
    if (n * this.ch <= 1 << 20) {
      this.cache.push({ start, n, data: data.map(a => a.slice()) });
      if (this.cache.length > 6) this.cache.shift();
    }
    return data;
  }

  // Peaks are computed off-thread in the main process. opts.loud = { sr, weights } also measures loudness.
  async peaks(jobId, onProgress, opts) {
    const bucket = bucketFor(this.frames);
    const fmt = { ...this.fmt, frames: this.frames, dataOffset: this.info.dataOffset, size: this.info.size, mtime: this.info.mtime };
    const off = window.api.on('peaks:progress', m => { if (m.jobId === jobId) onProgress(m.peaks); });
    try {
      return await window.api.peaks({ jobId, path: this.path, fmt, bucket, loud: (opts && opts.loud) || null });
    } finally {
      off();
    }
  }
}

class DecodedSource {
  constructor(path, info) {
    this.path = path;
    this.info = info;
    this.sr = info.sr || 48000;
    this.ch = info.ch;
    this.frames = info.frames;
    this.streaming = false;
    this.data = null;
  }

  async open() {
    if (this.data) return this;
    const u8 = await window.api.readFile(this.path);
    const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
    const oc = new OfflineAudioContext(1, 1, this.sr);
    const buf = await oc.decodeAudioData(ab);
    this.sr = buf.sampleRate;
    this.ch = buf.numberOfChannels;
    this.frames = buf.length;
    this.data = Array.from({ length: this.ch }, (_, c) => buf.getChannelData(c));
    return this;
  }

  async readFrames(start, n) {
    start = Math.max(0, Math.min(this.frames, Math.floor(start)));
    n = Math.max(0, Math.min(n, this.frames - start));
    return this.data.map(a => a.slice(start, start + n));
  }

  async peaks(jobId, onProgress, opts) {
    const pb = new PeakBuilder(this.ch, this.frames, bucketFor(this.frames), opts && opts.loud);
    pb.push(this.data, this.frames);
    return pb.result();
  }
}
