// Spectrogram analysis (notes from the Ghost session's spectral editor):
//   periodic Hann window, |X| · 4/N so a full-scale sine reads 0 dBFS, levels stored as one byte
//   over −160 … 0 dB. A column keeps the LOUDEST level per bin of the FFT frames inside it
//   (max-pooling), so short clicks still show when zoomed out.

export const LEVEL_FLOOR = -160;
export const toLevel = db => Math.max(0, Math.min(255, Math.round((db - LEVEL_FLOOR) * 255 / -LEVEL_FLOOR)));
export const levelDb = u8 => u8 * -LEVEL_FLOOR / 255 + LEVEL_FLOOR;

// In-place radix-2 FFT (N a power of two).
export function makeFft(N) {
  const bits = Math.log2(N);
  const rev = new Uint32Array(N);
  for (let i = 0; i < N; i++) { let r = 0; for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b); rev[i] = r; }
  const cos = new Float64Array(N / 2), sin = new Float64Array(N / 2);
  for (let i = 0; i < N / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / N); sin[i] = -Math.sin(2 * Math.PI * i / N); }
  return (re, im) => {
    for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= N; size <<= 1) {
      const half = size >> 1, step = N / size;
      for (let s = 0; s < N; s += size) {
        for (let k = 0, t = 0; k < half; k++, t += step) {
          const a = s + k, b = a + half;
          const xr = re[b] * cos[t] - im[b] * sin[t], xi = re[b] * sin[t] + im[b] * cos[t];
          re[b] = re[a] - xr; im[b] = im[a] - xi; re[a] += xr; im[a] += xi;
        }
      }
    }
  };
}

// Where each FFT frame starts: `cols` columns over [start, end), up to `perCol` frames per column,
// spread evenly and centred in their share of the column. Short ranges still get every column
// (the windows overlap more), so a short sound is as sharp as a long one; extra frames per column
// are only used when a column is wider than a hop (N/4). Returns { cols, starts, colOf }.
export function planWindows({ start, end, cols, perCol, N, frames }) {
  const hop = N / 4, span = Math.max(1, end - start);
  cols = Math.max(1, Math.min(Math.round(cols), Math.floor(span)));
  perCol = Math.max(1, Math.min(perCol, Math.floor(span / cols / hop)));
  const n = cols * perCol, starts = new Float64Array(n), colOf = new Uint32Array(n);
  const colSpan = span / cols, sub = colSpan / perCol;
  for (let c = 0, i = 0; c < cols; c++) {
    for (let k = 0; k < perCol; k++, i++) {
      const centre = start + c * colSpan + (k + 0.5) * sub;
      starts[i] = Math.max(0, Math.min(Math.max(0, frames - N), Math.round(centre - N / 2)));
      colOf[i] = c;
    }
  }
  return { cols, starts, colOf };
}

// Computes the planned frames from blocks of audio given in order (`at` = first frame of the block).
export class SpectroBuilder {
  constructor({ ch, N, plan }) {
    this.ch = ch;
    this.N = N;
    this.bins = N / 2 + 1;
    this.plan = plan;
    this.next = 0; // next planned frame
    this.data = Array.from({ length: ch }, () => new Uint8Array(plan.cols * this.bins));
    this.fft = makeFft(N);
    this.win = Float64Array.from({ length: N }, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N)); // periodic Hann
    this.re = new Float64Array(N);
    this.im = new Float64Array(N);
    this.scale = 4 / N;
  }

  // A block that covers whole planned frames (frames starting before `at` were in earlier blocks).
  // `last`: no more audio follows (frames running past the end are padded with silence).
  push(planar, n, at, last = false) {
    const { starts, colOf } = this.plan, N = this.N, bins = this.bins, re = this.re, im = this.im, win = this.win;
    while (this.next < starts.length) {
      const s = starts[this.next];
      if (s + N > at + n && !last) break; // finishes in a later block
      const off = s - at;
      const col = colOf[this.next];
      for (let c = 0; c < this.ch; c++) {
        const x = planar[c] || planar[0], out = this.data[c];
        for (let i = 0; i < N; i++) { const v = x[off + i]; re[i] = (v === undefined ? 0 : v) * win[i]; im[i] = 0; }
        this.fft(re, im);
        const base = col * bins;
        for (let k = 0; k < bins; k++) {
          const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]) * this.scale;
          const lv = m > 1e-8 ? Math.round((20 * Math.log10(m) - LEVEL_FLOOR) * 255 / -LEVEL_FLOOR) : 0;
          if (lv > out[base + k]) out[base + k] = lv > 255 ? 255 : lv;
        }
      }
      this.next++;
    }
  }

  get done() { return this.next >= this.plan.starts.length; }
}

// Contiguous reads that cover every planned frame (merging nearby ones), each at most `maxLen` frames.
export function planReads(plan, N, maxLen = 1 << 20) {
  const out = [];
  let a = -1, b = -1;
  for (const s of plan.starts) {
    if (a < 0) { a = s; b = s + N; continue; }
    if (s - b < N * 4 && s + N - a <= maxLen) { b = Math.max(b, s + N); continue; }
    out.push([a, b]);
    a = s; b = s + N;
  }
  if (a >= 0) out.push([a, b]);
  return out;
}
