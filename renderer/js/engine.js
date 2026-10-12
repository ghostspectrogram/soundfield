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
      const ctx = new AudioContext({ sampleRate: sr, latencyHint: 'interactive' });
      const master = ctx.createGain();
      master.gain.value = dbToGain(this.volumeDb);
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
    const g = dbToGain(db);
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
    this.feed = { gen, cursor: start, rs, re, loop, region, sent: 0, consumed: 0, eos: false, busy: false };
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
      while (this.feed === f && !f.eos && f.sent - f.consumed < sr * (src.streaming ? 1.5 : 0.75)) {
        const chunk = f.sent === 0 ? Math.round(sr * 0.1) : Math.round(sr * 0.5);
        const n = Math.min(chunk, f.re - f.cursor);
        if (n <= 0) {
          if (f.loop) { f.cursor = f.rs; continue; }
          f.eos = true;
          this.graph.node.port.postMessage({ type: 'eos', gen: f.gen });
          break;
        }
        const data = await src.readFrames(f.cursor, n);
        if (this.feed !== f || !this.graph) return;
        this.graph.node.port.postMessage({ type: 'chunk', gen: f.gen, start: f.cursor, frames: n, data }, data.map(a => a.buffer));
        f.cursor += n;
        f.sent += n;
      }
    } catch (err) {
      console.error('stream error', err);
      this.emit('error', err);
      this.stop();
    } finally {
      f.busy = false;
    }
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
    let p = this.pos + ((performance.now() - this.posAt) / 1000) * this.source.sr - (g ? g.latency : 0);
    if (f) {
      if (p < f.rs) p = f.loop ? f.re - (f.rs - p) : f.rs;
      if (p > f.re) p = f.re;
    }
    return Math.max(0, p);
  }
}
