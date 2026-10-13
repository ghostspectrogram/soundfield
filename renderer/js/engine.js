// Playback engine: one AudioContext per sample rate (so files play at their
// native rate with no extra resampling on our side), a streaming worklet,
// and a monitoring stage for stereo, binaural (HRTF) or discrete outputs.
import { buildMonitor, ambiMeterMap } from './layouts.js';

const dbToGain = db => (db <= -60 ? 0 : Math.pow(10, db / 20));

export class Engine {
  // opts.workletUrl: where worklet/player.js is served from (relative to the
  // page by default), so the engine can be embedded in another app.
  constructor(opts = {}) {
    this.workletUrl = opts.workletUrl || 'worklet/player.js';
    this.ctxs = new Map();
    this.volumeDb = 0;
    this.mode = 'stereo';
    this.lfe = false;
    this.mute = [];
    this.solo = [];
    this.source = null;
    this.layout = null;
    this.graph = null;
    this.feed = null;
    this.gen = 0;
    this.playing = false;
    this.pos = 0;
    this.posAt = 0;
    this.meters = null;
    this.iv = null;
    this.listeners = {};
    this.sinkId = ''; // output device ('' = the system default)
    this.rate = 1;    // varispeed
    this.trimDb = 0;  // matched-loudness gain for the current sound
  }

  // Plays through a specific output device (from enumerateDevices); '' = the system default.
  // Resolves false if the device can't be used (e.g. it was unplugged).
  async setSink(id) {
    this.sinkId = id || '';
    let ok = true;
    for (const e of this.ctxs.values()) {
      try { await e.ctx.setSinkId(this.sinkId); } catch { ok = false; }
    }
    if (!ok) { this.sinkId = ''; for (const e of this.ctxs.values()) e.ctx.setSinkId('').catch(() => {}); }
    return ok;
  }

  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, arg) { (this.listeners[ev] || []).forEach(f => f(arg)); }

  get deviceChannels() {
    for (const e of this.ctxs.values()) return e.ctx.destination.maxChannelCount;
    return 2;
  }

  async ctxFor(sr) {
    let e = this.ctxs.get(sr);
    if (!e) {
      const ctx = new AudioContext({ sampleRate: sr, latencyHint: 'interactive', ...(this.sinkId ? { sinkId: this.sinkId } : {}) });
      const master = ctx.createGain();
      master.gain.value = this.outGain();
      master.connect(ctx.destination);
      e = { ctx, master, ready: ctx.audioWorklet.addModule(this.workletUrl) };
      this.ctxs.set(sr, e);
      // Keep at most three device streams open.
      if (this.ctxs.size > 3) {
        for (const [k, v] of this.ctxs) {
          if (v !== e && (!this.graph || this.graph.e !== v)) { v.ctx.close(); this.ctxs.delete(k); break; }
        }
      }
    }
    await e.ready;
    return e;
  }

  setSource(source, layout) {
    if (this.source === source && this.layout === layout) return;
    this.stop();
    this.source = source;
    this.layout = layout;
    this.mute = [];
    this.solo = [];
    this.pos = 0;
  }

  setLayout(layout) {
    this.layout = layout;
    this.mute = [];
    this.solo = [];
    if (this.graph) this.rebuildIfPlaying();
  }

  setMode(mode) { this.mode = mode; this.rebuildIfPlaying(); }
  setLfe(on) { this.lfe = on; this.rebuildIfPlaying(); }

  setMuteSolo(mute, solo) {
    this.mute = mute;
    this.solo = solo;
    if (this.graph && this.graph.key === this.graphKey()) {
      const mon = this.monitor();
      this.graph.node.port.postMessage({ type: 'matrix', m: mon.matrix });
    }
  }

  setVolume(db) {
    this.volumeDb = db;
    this.applyGain();
  }

  // Extra gain for the current sound (matched-loudness preview), on top of the volume.
  setTrim(db) {
    this.trimDb = Number(db) || 0;
    this.applyGain();
  }

  outGain() { return dbToGain(this.volumeDb) * Math.pow(10, this.trimDb / 20); }

  applyGain() {
    const g = this.outGain();
    for (const e of this.ctxs.values()) e.master.gain.setTargetAtTime(g, e.ctx.currentTime, 0.012);
  }

  monitor() {
    return buildMonitor(this.layout, this.mode, { mute: this.mute, solo: this.solo, lfe: this.lfe });
  }

  graphKey() {
    return [this.source && this.source.sr, this.layout && this.layout.id, this.layout && this.layout.ch, this.mode, this.lfe].join('|');
  }

  async rebuildIfPlaying() {
    if (!this.playing || !this.feed) { this.teardown(); return; }
    const f = this.feed;
    await this.play({ from: this.position(), region: f.region, loop: f.loop });
  }

  teardown() {
    const g = this.graph;
    if (!g) return;
    this.graph = null;
    try { g.node.port.postMessage({ type: 'stop' }); } catch {}
    setTimeout(() => { try { g.node.disconnect(); g.extra.forEach(n => n.disconnect()); } catch {} }, 60);
  }

  async buildGraph() {
    const key = this.graphKey();
    const e = await this.ctxFor(this.source.sr);
    if (this.graph && this.graph.key === key && this.graph.e === e) return this.graph;
    this.teardown();
    const { ctx, master } = e;
    const mon = this.monitor();
    const N = this.layout.ch;
    const node = new AudioWorkletNode(ctx, 'sfx-player', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [mon.outCount],
      processorOptions: { inCh: N, outCh: mon.outCount },
    });
    const extra = [];
    const dest = ctx.destination;
    if (this.mode === 'discrete') {
      const n = Math.min(mon.outCount, dest.maxChannelCount);
      dest.channelCount = n;
      dest.channelInterpretation = 'discrete';
      master.channelCount = n;
      master.channelCountMode = 'explicit';
      master.channelInterpretation = 'discrete';
      node.connect(master);
    } else {
      dest.channelCount = 2;
      dest.channelInterpretation = 'speakers';
      master.channelCount = 2;
      master.channelCountMode = 'max';
      master.channelInterpretation = 'speakers';
      if (this.mode === 'binaural' && (mon.speakers.length || mon.direct >= 0)) {
        const split = ctx.createChannelSplitter(mon.outCount);
        node.connect(split);
        extra.push(split);
        mon.speakers.forEach((s, k) => {
          const a = s.az * Math.PI / 180, el = s.el * Math.PI / 180;
          const p = new PannerNode(ctx, {
            panningModel: 'HRTF', distanceModel: 'linear', rolloffFactor: 0,
            positionX: -Math.sin(a) * Math.cos(el), positionY: Math.sin(el), positionZ: -Math.cos(a) * Math.cos(el),
            channelCount: 1, channelCountMode: 'explicit',
          });
          split.connect(p, k);
          p.connect(master);
          extra.push(p);
        });
        if (mon.direct >= 0) {
          const merge = ctx.createChannelMerger(2);
          split.connect(merge, mon.direct, 0);
          split.connect(merge, mon.direct + 1, 1);
          merge.connect(master);
          extra.push(merge);
        }
      } else {
        node.connect(master);
      }
    }
    node.port.onmessage = ev => this.onWorklet(ev.data);
    node.port.postMessage({ type: 'matrix', m: mon.matrix });
    const amap = ambiMeterMap(this.layout);
    if (amap) node.port.postMessage({ type: 'ambi', map: amap });
    this.graph = { key, e, node, extra, latency: Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0)) * ctx.sampleRate) };
    return this.graph;
  }

  // region: { start, end } in frames or null. loop: boolean.
  async play({ from = 0, region = null, loop = false } = {}) {
    if (!this.source || !this.layout || !this.layout.ch) return;
    const gen = ++this.gen;
    const g = await this.buildGraph();
    if (gen !== this.gen) return;
    const { ctx } = g.e;
    for (const v of this.ctxs.values()) if (v !== g.e && v.ctx.state === 'running') v.ctx.suspend();
    if (ctx.state !== 'running') await ctx.resume();
    if (gen !== this.gen) return;
    const frames = this.source.frames;
    let rs = region ? Math.max(0, Math.floor(region.start)) : 0;
    let re = region ? Math.min(frames, Math.ceil(region.end)) : frames;
    if (re - rs < 1024) loop = false;
    let start = Math.floor(from);
    if (start < rs || start >= re) start = rs;
    this.feed = { gen, cursor: start, rs, re, loop, region, rate: this.rate, sent: 0, consumed: 0, eos: false, busy: false };
    g.node.port.postMessage({ type: 'play', gen });
    this.playing = true;
    this.pos = start;
    this.posAt = performance.now();
    this.emit('state', { playing: true });
    this.pump();
  }

  stop() {
    this.gen++;
    this.feed = null;
    if (this.graph) this.graph.node.port.postMessage({ type: 'stop' });
    if (this.playing) {
      this.playing = false;
      this.emit('state', { playing: false });
    }
  }

  setLoop(loop) {
    const f = this.feed;
    if (!f || f.eos === 'sent') { if (f) f.loop = loop; return; }
    f.loop = loop && f.re - f.rs >= 1024;
  }

  async pump() {
    const f = this.feed;
    if (!f || f.busy || f.eos) return;
    f.busy = true;
    const sr = this.source.sr;
    const src = this.source;
    try {
      while (this.feed === f && !f.eos && f.sent - f.consumed < sr * (src.streaming || src.lazy ? 1.5 : 0.75)) {
        const chunk = f.sent === 0 ? Math.round(sr * 0.1) : Math.round(sr * 0.5);
        const rate = f.rate || 1;
        // Output frames for this chunk: at varispeed each one uses `rate` source frames.
        const n = Math.min(chunk, Math.floor((f.re - f.cursor) / rate));
        if (n <= 0) {
          if (f.loop) { f.cursor = f.rs; continue; }
          f.eos = true;
          this.graph.node.port.postMessage({ type: 'eos', gen: f.gen });
          break;
        }
        const data = rate === 1 ? await src.readFrames(f.cursor, n) : await this.varispeed(src, f.cursor, n, rate);
        if (this.feed !== f || !this.graph) return;
        this.graph.node.port.postMessage({ type: 'chunk', gen: f.gen, start: f.cursor, frames: n, rate, data }, data.map(a => a.buffer));
        f.cursor += n * rate;
        f.sent += n;
      }
    } catch (err) {
      if (this.feed !== f) return; // a read for a sound that's no longer playing
      console.error('stream error', err);
      this.emit('error', err);
      this.stop();
    } finally {
      f.busy = false;
    }
  }

  // Tape-style varispeed: `n` output frames starting at source frame `pos` (fractional), reading
  // the source `rate` times faster, with 4-point cubic (Hermite) interpolation.
  async varispeed(src, pos, n, rate) {
    const base = Math.floor(pos) - 1;
    const readAt = Math.max(0, base);
    const raw = await src.readFrames(readAt, Math.ceil(n * rate) + 4 + (readAt - base));
    return raw.map(d => {
      const out = new Float32Array(n), last = d.length - 1;
      const at = s => d[Math.max(0, Math.min(last, s - readAt))] || 0;
      for (let k = 0; k < n; k++) {
        const x = pos + k * rate, i = Math.floor(x), t = x - i;
        const y0 = at(i - 1), y1 = at(i), y2 = at(i + 1), y3 = at(i + 2);
        const c1 = 0.5 * (y2 - y0), c2 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3, c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
        out[k] = ((c3 * t + c2) * t + c1) * t + y1;
      }
      return out;
    });
  }

  // Playback speed for tape-style varispeed (1 = normal; pitch follows speed). Takes effect at
  // once: a playing sound restarts from where it is, with the usual short fade.
  setRate(rate) {
    const r = Math.max(0.25, Math.min(4, Number(rate) || 1));
    if (r === this.rate) return;
    const f = this.feed, from = this.position();
    this.rate = r;
    if (this.playing && f) this.play({ from, region: f.region, loop: f.loop });
  }

  onWorklet(d) {
    const f = this.feed;
    if (d.type === 'state') {
      this.meters = d.meters;
      this.iv = d.iv;
      this.metersAt = performance.now();
      if (f && d.gen === f.gen) {
        f.consumed = d.consumed;
        this.pos = d.pos;
        this.posAt = performance.now();
        this.pump();
      }
    } else if (d.type === 'ended') {
      if (f && d.gen === f.gen) {
        this.feed = null;
        this.playing = false;
        this.pos = f.region ? f.re : this.source.frames;
        this.emit('state', { playing: false, ended: true });
      }
    }
  }

  // Current playhead in frames, smoothed between worklet reports and
  // compensated for output latency.
  position() {
    if (!this.playing || !this.source) return this.pos;
    const g = this.graph;
    const f = this.feed;
    const rate = (f && f.rate) || 1; // source frames per output frame
    let p = this.pos + (((performance.now() - this.posAt) / 1000) * this.source.sr - (g ? g.latency : 0)) * rate;
    if (f) {
      if (p < f.rs) p = f.loop ? f.re - (f.rs - p) : f.rs;
      if (p > f.re) p = f.re;
    }
    return Math.max(0, p);
  }
}
