// PCM decoding + peak building shared by the renderer and the Node peaks worker.
//
// fmt: { codec: 'pcm' | 'float', ch, blockAlign, be, unsigned8 }
// Sample container size is blockAlign / ch bytes. Integer samples narrower than
// their container (e.g. 24-in-32) are left-justified, so they decode correctly
// as the container width.

export function decodePcm(u8, fmt, frames) {
  const ch = fmt.ch;
  const bytes = fmt.blockAlign / ch;
  const le = !fmt.be;
  const out = new Array(ch);
  for (let c = 0; c < ch; c++) out[c] = new Float32Array(frames);
  const n = frames * ch;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);

  if (fmt.codec === 'float') {
    if (bytes === 4) {
      if (le && u8.byteOffset % 4 === 0) {
        const v = new Float32Array(u8.buffer, u8.byteOffset, n);
        deinterleave(v, out, ch, frames, 1);
      } else {
        for (let f = 0, p = 0; f < frames; f++)
          for (let c = 0; c < ch; c++, p += 4) out[c][f] = dv.getFloat32(p, le);
      }
    } else if (bytes === 8) {
      for (let f = 0, p = 0; f < frames; f++)
        for (let c = 0; c < ch; c++, p += 8) out[c][f] = dv.getFloat64(p, le);
    }
    return out;
  }

  switch (bytes) {
    case 1: {
      if (fmt.unsigned8) {
        for (let f = 0, p = 0; f < frames; f++)
          for (let c = 0; c < ch; c++, p++) out[c][f] = (u8[p] - 128) / 128;
      } else {
        for (let f = 0, p = 0; f < frames; f++)
          for (let c = 0; c < ch; c++, p++) out[c][f] = ((u8[p] << 24) >> 24) / 128;
      }
      break;
    }
    case 2: {
      if (le && u8.byteOffset % 2 === 0) {
        const v = new Int16Array(u8.buffer, u8.byteOffset, n);
        deinterleave(v, out, ch, frames, 1 / 32768);
      } else {
        for (let f = 0, p = 0; f < frames; f++)
          for (let c = 0; c < ch; c++, p += 2) out[c][f] = dv.getInt16(p, le) / 32768;
      }
      break;
    }
    case 3: {
      const k = 1 / 8388608;
      if (le) {
        for (let f = 0, p = 0; f < frames; f++)
          for (let c = 0; c < ch; c++, p += 3)
            out[c][f] = (((u8[p] | (u8[p + 1] << 8) | (u8[p + 2] << 16)) << 8) >> 8) * k;
      } else {
        for (let f = 0, p = 0; f < frames; f++)
          for (let c = 0; c < ch; c++, p += 3)
            out[c][f] = ((((u8[p] << 16) | (u8[p + 1] << 8) | u8[p + 2]) << 8) >> 8) * k;
      }
      break;
    }
    case 4: {
      const k = 1 / 2147483648;
      if (le && u8.byteOffset % 4 === 0) {
        const v = new Int32Array(u8.buffer, u8.byteOffset, n);
        deinterleave(v, out, ch, frames, k);
      } else {
        for (let f = 0, p = 0; f < frames; f++)
          for (let c = 0; c < ch; c++, p += 4) out[c][f] = dv.getInt32(p, le) * k;
      }
      break;
    }
    default:
      throw new Error(`Unsupported sample size: ${bytes} bytes`);
  }
  return out;
}

function deinterleave(v, out, ch, frames, k) {
  if (ch === 1) {
    const o = out[0];
    for (let f = 0; f < frames; f++) o[f] = v[f] * k;
    return;
  }
  for (let c = 0; c < ch; c++) {
    const o = out[c];
    for (let f = 0, p = c; f < frames; f++, p += ch) o[f] = v[p] * k;
  }
}

// Peak bucket size for a file of `frames` frames: ~65k buckets max.
export function bucketFor(frames) {
  return Math.max(8, Math.ceil(frames / 65536));
}

// Incremental min / max / rms builder. data[c] is Float32Array(nb * 3).
export class PeakBuilder {
  constructor(ch, totalFrames, bucket) {
    this.ch = ch;
    this.frames = totalFrames;
    this.bucket = bucket;
    this.nb = Math.max(1, Math.ceil(totalFrames / bucket));
    this.data = [];
    this.acc = [];
    for (let c = 0; c < ch; c++) {
      this.data.push(new Float32Array(this.nb * 3));
      this.acc.push(new Float64Array(this.nb));
    }
    this.pos = 0;
    this.rmsDone = 0;
  }

  push(planar, n) {
    const B = this.bucket;
    for (let c = 0; c < this.ch; c++) {
      const s = planar[c], d = this.data[c], acc = this.acc[c];
      let k = 0;
      while (k < n) {
        const f = this.pos + k;
        const b = Math.floor(f / B);
        if (b >= this.nb) break;
        const lim = Math.min(n, k + (b + 1) * B - f);
        let mn = d[b * 3], mx = d[b * 3 + 1], sq = 0;
        for (; k < lim; k++) {
          const v = s[k];
          if (v < mn) mn = v;
          if (v > mx) mx = v;
          sq += v * v;
        }
        d[b * 3] = mn;
        d[b * 3 + 1] = mx;
        acc[b] += sq;
      }
    }
    this.pos += n;
    this.finalize(Math.floor(this.pos / B));
  }

  finalize(upTo) {
    upTo = Math.min(upTo, this.nb);
    const B = this.bucket;
    for (let b = this.rmsDone; b < upTo; b++) {
      const cnt = Math.max(1, Math.min(B, this.frames - b * B));
      for (let c = 0; c < this.ch; c++) this.data[c][b * 3 + 2] = Math.sqrt(this.acc[c][b] / cnt);
    }
    if (upTo > this.rmsDone) this.rmsDone = upTo;
  }

  result() {
    this.finalize(this.nb);
    return { bucket: this.bucket, nb: this.nb, ch: this.ch, frames: this.frames, done: this.nb, data: this.data };
  }

  snapshot() {
    return { bucket: this.bucket, nb: this.nb, ch: this.ch, frames: this.frames, done: this.rmsDone, data: this.data.map(d => d.slice()) };
  }
}
