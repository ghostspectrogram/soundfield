// Streaming multichannel player. The main thread feeds planar Float32 chunks;
// this processor applies the monitoring matrix (any N in -> M out), short
// fades on start / stop / seek, and reports position + per-channel peaks.

class SfxPlayer extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const o = options.processorOptions;
    this.inCh = o.inCh;
    this.outCh = o.outCh;
    this.m = new Float32Array(this.outCh * this.inCh);
    this.mt = new Float32Array(this.outCh * this.inCh);
    this.ramp = false;
    this.queue = [];
    this.off = 0;
    this.gen = -1;
    this.pendingGen = null;
    this.playing = false;
    this.stopping = false;
    this.fade = 0;
    this.fadeTarget = 0;
    this.fadeStep = 1 / (0.004 * sampleRate);
    this.env = new Float32Array(128);
    this.consumed = 0;
    this.pos = 0;
    this.meters = new Float32Array(this.inCh);
    this.ambi = null;
    this.iv = new Float64Array(4);
    this.postEvery = Math.max(1, Math.round(sampleRate / 128 / 60));
    this.tick = 0;
    this.port.onmessage = e => this.onMsg(e.data);
  }

  onMsg(d) {
    switch (d.type) {
      case 'matrix':
        this.mt.set(d.m);
        this.ramp = true;
        if (!this.playing) { this.m.set(d.m); this.ramp = false; }
        break;
      case 'play':
        if (this.playing && this.fade > 0 && !this.stopping) { this.pendingGen = d.gen; this.fadeTarget = 0; }
        else this.switchGen(d.gen);
        this.playing = true;
        break;
      case 'chunk':
      case 'eos':
        if (d.gen === this.gen || d.gen === this.pendingGen) this.queue.push(d);
        break;
      case 'stop':
        if (this.playing) { this.stopping = true; this.pendingGen = null; this.fadeTarget = 0; }
        break;
      case 'ambi':
        this.ambi = d.map;
        break;
    }
  }

  switchGen(g) {
    this.gen = g;
    this.pendingGen = null;
    this.queue = this.queue.filter(c => c.gen === g);
    this.off = 0;
    this.consumed = 0;
    this.stopping = false;
    this.fadeTarget = 1;
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    for (let o = 0; o < out.length; o++) out[o].fill(0);
    if (this.playing) this.render(out, out[0].length);
    if (this.playing && ++this.tick >= this.postEvery) { this.tick = 0; this.post(); }
    return true;
  }

  render(out, N) {
    let w = 0;
    while (w < N) {
      if (this.fade <= 0 && this.fadeTarget === 0) {
        if (this.pendingGen !== null) this.switchGen(this.pendingGen);
        else if (this.stopping) {
          this.playing = false;
          this.stopping = false;
          this.queue = [];
          this.post();
          this.port.postMessage({ type: 'stopped', gen: this.gen });
          return;
        }
      }
      let c = this.queue[0];
      while (c && c.gen !== this.gen) { this.queue.shift(); c = this.queue[0]; }
      if (!c) {
        if (this.fadeTarget === 0) { this.fade = 0; continue; } // nothing left to fade out
        return; // underrun: output silence this block
      }
      if (c.type === 'eos') {
        this.queue.shift();
        this.playing = false;
        this.post();
        this.port.postMessage({ type: 'ended', gen: this.gen });
        return;
      }
      const take = Math.min(c.frames - this.off, N - w);
      this.mix(c.data, this.off, out, w, take);
      this.off += take;
      w += take;
      this.consumed += take;
      this.pos = c.start + this.off * (c.rate || 1); // varispeed chunks: one output frame = `rate` source frames
      if (this.off >= c.frames) { this.queue.shift(); this.off = 0; }
    }
  }

  mix(data, off, out, w, n) {
    const inCh = this.inCh, outCh = this.outCh, m = this.m, mt = this.mt, env = this.env;
    let f = this.fade;
    const tgt = this.fadeTarget, st = this.fadeStep;
    for (let k = 0; k < n; k++) {
      if (f < tgt) f = Math.min(tgt, f + st); else if (f > tgt) f = Math.max(tgt, f - st);
      env[k] = f;
    }
    this.fade = f;

    for (let i = 0; i < inCh; i++) {
      const s = data[i];
      let pk = this.meters[i];
      for (let k = 0; k < n; k++) { const a = Math.abs(s[off + k]); if (a > pk) pk = a; }
      this.meters[i] = pk;
    }
    if (this.ambi) {
      const a = this.ambi;
      if (a.w && a.x && a.y) {
        const W = data[a.w.i], X = data[a.x.i], Y = data[a.y.i], Z = a.z ? data[a.z.i] : null;
        let sw = 0, sx = 0, sy = 0, sz = 0;
        for (let k = 0; k < n; k++) {
          const wv = W[off + k] * a.w.k;
          sw += wv * wv; sx += wv * X[off + k] * a.x.k; sy += wv * Y[off + k] * a.y.k;
          if (Z) sz += wv * Z[off + k] * a.z.k;
        }
        this.iv[0] += sw; this.iv[1] += sx; this.iv[2] += sy; this.iv[3] += sz;
      }
    }

    const ramp = this.ramp;
    for (let o = 0; o < outCh; o++) {
      const dst = out[o];
      if (!dst) continue;
      for (let i = 0; i < inCh; i++) {
        const g0 = m[o * inCh + i], g1 = ramp ? mt[o * inCh + i] : g0;
        if (g0 === 0 && g1 === 0) continue;
        const s = data[i];
        if (g0 === g1) {
          for (let k = 0; k < n; k++) dst[w + k] += s[off + k] * g0 * env[k];
        } else {
          const dg = (g1 - g0) / n;
          for (let k = 0; k < n; k++) dst[w + k] += s[off + k] * (g0 + dg * (k + 1)) * env[k];
        }
      }
    }
    if (ramp) { m.set(mt); this.ramp = false; }
  }

  post() {
    this.port.postMessage({
      type: 'state', gen: this.gen, pos: this.pos, consumed: this.consumed, playing: this.playing,
      meters: this.meters.slice(), iv: this.ambi ? Array.from(this.iv) : null,
    });
    this.meters.fill(0);
    this.iv.fill(0);
  }
}

registerProcessor('sfx-player', SfxPlayer);
