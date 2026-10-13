// Loudness (ITU-R BS.1770-4 / EBU R128): integrated loudness in LUFS and true peak in dBTP.
// Fed the same planar Float32 blocks as the waveform peaks, so it costs no extra disk reads.
//   K-weighting: a high shelf (+4 dB above ~1.7 kHz) and a high-pass (~38 Hz), per channel.
//   400 ms blocks every 100 ms; absolute gate −70 LUFS, then relative gate −10 LU.
//   True peak: 4× oversampling (windowed-sinc), only where a block comes near the loudest peak.

function kWeighting(sr) {
  // High shelf (stage 1)
  let f0 = 1681.974450955533, G = 3.999843853973347, Q = 0.7071752369554196;
  let K = Math.tan(Math.PI * f0 / sr);
  const Vh = Math.pow(10, G / 20), Vb = Math.pow(Vh, 0.4996667741545416);
  let a0 = 1 + K / Q + K * K;
  const s1 = { b0: (Vh + Vb * K / Q + K * K) / a0, b1: 2 * (K * K - Vh) / a0, b2: (Vh - Vb * K / Q + K * K) / a0, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  // High-pass (stage 2, "RLB")
  f0 = 38.13547087602444; Q = 0.5003270373238773;
  K = Math.tan(Math.PI * f0 / sr);
  a0 = 1 + K / Q + K * K;
  const s2 = { b0: 1, b1: -2, b2: 1, a1: 2 * (K * K - 1) / a0, a2: (1 - K / Q + K * K) / a0 };
  return [s1, s2];
}

// 4× oversampling filters for true peak: phases 1–3 (phase 0 is the sample itself), 12 taps each.
const TP_TAPS = 12;
const TP_PHASES = (() => {
  const out = [];
  const half = TP_TAPS / 2, span = TP_TAPS + 1;
  for (let p = 1; p < 4; p++) {
    const h = new Float64Array(TP_TAPS);
    let sum = 0;
    for (let j = 0; j < TP_TAPS; j++) {
      const x = j - half + 1 - p / 4; // distance from the interpolated point
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x);
      const w = 0.42 + 0.5 * Math.cos(2 * Math.PI * x / span) + 0.08 * Math.cos(4 * Math.PI * x / span); // Blackman
      h[j] = sinc * w;
      sum += h[j];
    }
    for (let j = 0; j < TP_TAPS; j++) h[j] /= sum;
    out.push(h);
  }
  return out;
})();

// Loudness weight for each channel from its layout role: LFE is left out, surrounds count +1.5 dB.
export function loudnessWeights(layout, ch) {
  if (!layout || !layout.chans) return new Array(ch).fill(1);
  if (layout.ambi) return layout.chans.map((c, i) => (i === 0 ? 1 : 0)); // B-format: the omni (W) channel
  return layout.chans.map(c => {
    const r = String(c.role || c.label || '');
    if (/^LFE/i.test(r)) return 0;
    if (/^(Ls|Rs|Lss|Rss|Lrs|Rrs|Lsr|Rsr|Cs|Bl|Br|Bc)$/i.test(r)) return 1.41;
    return 1;
  });
}

export class LoudnessMeter {
  constructor(sr, ch, weights) {
    this.sr = sr;
    this.ch = ch;
    this.w = Float64Array.from({ length: ch }, (_, i) => (weights && weights[i] != null ? weights[i] : 1));
    this.f = kWeighting(sr);
    this.z = Array.from({ length: ch }, () => new Float64Array(4)); // biquad states, 2 stages
    this.step = Math.max(1, Math.round(sr * 0.1)); // 100 ms
    this.acc = new Float64Array(ch); // squares in the current 100 ms step
    this.inStep = 0;
    this.steps = []; // weighted mean square per 100 ms
    this.total = 0;  // weighted sum of squares over everything (for very short sounds)
    this.frames = 0;
    this.peak = 0;   // sample peak
    this.tp = 0;     // true peak (linear)
    this.hist = Array.from({ length: ch }, () => new Float32Array(TP_TAPS)); // last samples, for oversampling across blocks
  }

  push(planar, n) {
    const ch = this.ch, [s1, s2] = this.f;
    // K-weighted squares, accumulated per 100 ms step.
    let done = 0;
    while (done < n) {
      const take = Math.min(n - done, this.step - this.inStep);
      for (let c = 0; c < ch; c++) {
        if (!this.w[c]) continue;
        const x = planar[c], z = this.z[c];
        let z1 = z[0], z2 = z[1], z3 = z[2], z4 = z[3], sq = 0;
        for (let k = done; k < done + take; k++) {
          const v = x[k];
          const y1 = s1.b0 * v + z1; z1 = s1.b1 * v - s1.a1 * y1 + z2; z2 = s1.b2 * v - s1.a2 * y1;
          const y2 = s2.b0 * y1 + z3; z3 = s2.b1 * y1 - s2.a1 * y2 + z4; z4 = s2.b2 * y1 - s2.a2 * y2;
          sq += y2 * y2;
        }
        z[0] = z1; z[1] = z2; z[2] = z3; z[3] = z4;
        this.acc[c] += sq;
      }
      this.inStep += take;
      done += take;
      if (this.inStep === this.step) this.closeStep();
    }
    this.frames += n;
    // Peaks; true peak only where this block comes near the loudest peak so far (it's slower).
    for (let c = 0; c < ch; c++) {
      const x = planar[c];
      let m = 0;
      for (let k = 0; k < n; k++) { const a = x[k] < 0 ? -x[k] : x[k]; if (a > m) m = a; }
      if (m > this.peak) this.peak = m;
      if (m > this.tp) this.tp = m;
      if (m >= this.tp * 0.7) this.truePeak(c, x, n);
      else if (n >= TP_TAPS) this.hist[c].set(x.subarray(n - TP_TAPS, n));
      else { const H = this.hist[c]; H.copyWithin(0, n); H.set(x.subarray(0, n), TP_TAPS - n); }
    }
  }

  // Points between samples k and k+1 use samples k-5 … k+6. They're computed 6 samples behind,
  // so a block's last points are done at the start of the next block (from the kept history).
  truePeak(c, x, n) {
    const H = this.hist[c], T = TP_TAPS, half = T / 2;
    // The previous block's last T samples, then this block: index i of this block is buf[i + T].
    if (!this.buf || this.buf.length < n + T) this.buf = new Float32Array(n + T);
    const buf = this.buf;
    buf.set(H, 0);
    buf.set(x.subarray(0, n), T);
    const [h1, h2, h3] = TP_PHASES;
    let tp = this.tp, gate = tp * 0.7;
    for (let k = T - half, end = n + T - half; k < end; k++) {
      // A point between two samples can only beat the true peak so far if a neighbour is close to it.
      const a = buf[k] < 0 ? -buf[k] : buf[k], b = buf[k + 1] < 0 ? -buf[k + 1] : buf[k + 1];
      if (a < gate && b < gate) continue;
      const o = k - half + 1;
      let y1 = 0, y2 = 0, y3 = 0;
      for (let j = 0; j < T; j++) { const s = buf[o + j]; y1 += h1[j] * s; y2 += h2[j] * s; y3 += h3[j] * s; }
      if (y1 < 0) y1 = -y1; if (y2 < 0) y2 = -y2; if (y3 < 0) y3 = -y3;
      const m = y1 > y2 ? (y1 > y3 ? y1 : y3) : (y2 > y3 ? y2 : y3);
      if (m > tp) { tp = m; gate = tp * 0.7; }
    }
    this.tp = tp;
    H.set(buf.subarray(n, n + T));
  }

  closeStep() {
    let z = 0;
    for (let c = 0; c < this.ch; c++) { z += this.w[c] * this.acc[c]; this.acc[c] = 0; }
    this.total += z;
    this.steps.push(z / this.inStep);
    this.inStep = 0;
  }

  // { lufs, tp (dBTP), peak (dBFS), short: true when under 400 ms (an ungated whole-sound reading) }
  result() {
    if (this.inStep > 0) { let z = 0; for (let c = 0; c < this.ch; c++) z += this.w[c] * this.acc[c]; this.total += z; }
    const db = v => (v > 1e-12 ? 20 * Math.log10(v) : -Infinity);
    const L = ms => -0.691 + 10 * Math.log10(ms);
    const blocks = [];
    for (let i = 0; i + 4 <= this.steps.length; i++) blocks.push((this.steps[i] + this.steps[i + 1] + this.steps[i + 2] + this.steps[i + 3]) / 4);
    let lufs;
    if (!blocks.length) lufs = this.frames && this.total > 0 ? L(this.total / this.frames) : -Infinity;
    else {
      const abs = blocks.filter(z => z > 0 && L(z) > -70);
      if (!abs.length) lufs = -Infinity;
      else {
        const rel = L(abs.reduce((t, z) => t + z, 0) / abs.length) - 10;
        const gated = abs.filter(z => L(z) > rel);
        lufs = L(gated.reduce((t, z) => t + z, 0) / gated.length);
      }
    }
    return { lufs: Number.isFinite(lufs) ? +lufs.toFixed(2) : null, tp: Number.isFinite(db(this.tp)) ? +db(this.tp).toFixed(2) : null, peak: Number.isFinite(db(this.peak)) ? +db(this.peak).toFixed(2) : null, short: !blocks.length };
  }
}
