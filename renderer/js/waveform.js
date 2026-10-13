// Multichannel waveform view: one lane per channel, zoom / pan, click to
// play from a point, drag to select, drag a selection out to a DAW.

// Level scale beside the waveform: floor … 0 dBFS, evenly spaced (floor −40 by default, or −60;
// Settings → Waveform). Marks every 5 dB.
const DEFAULT_FLOOR = -40;

// dBFS text for a linear level (1 = 0 dBFS). Float files can go above 0.
export function fmtDb(v) {
  if (!(v > 1e-9)) return '−∞';
  const d = 20 * Math.log10(v);
  if (d >= 0.05) return '+' + d.toFixed(1);
  if (d > -0.05) return '0.0';
  return '−' + (-d).toFixed(1);
}

const NICE_STEPS = [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800, 3600];

export function fmtTime(sec, precise = false) {
  if (!isFinite(sec)) return '—';
  const m = Math.floor(sec / 60), s = sec - m * 60;
  if (precise) return `${m}:${s.toFixed(3).padStart(6, '0')}`;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(s)).padStart(2, '0')}`;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export class WaveView {
  constructor(els) {
    Object.assign(this, els); // wrap, canvas, ruler, sel, playhead, hover, labels
    this.ctx2d = this.canvas.getContext('2d');
    this.rctx = this.ruler.getContext('2d');
    this.frames = 0;
    this.sr = 48000;
    this.layout = null;
    this.peaks = null;
    this.v0 = 0;
    this.v1 = 1;
    this.vzoom = 1;
    this.selection = null;
    this.raw = null;
    this.rawPending = null;
    this.rawProvider = null;
    this.mute = [];
    this.solo = [];
    this.meterEls = [];
    this.peakHold = [];
    this.cb = {};
    this.message = '';
    this.levels = null;
    this.setDbFloor(DEFAULT_FLOOR);
    this.peakWarn = Math.pow(10, -1 / 20); // a peak readout turns red at −1 dBFS or louder
    new ResizeObserver(() => this.resize()).observe(this.wrap);
    this.bind();
  }

  on(name, fn) { this.cb[name] = fn; }

  setFile({ frames, sr, layout }) {
    this.frames = Math.max(1, frames);
    this.sr = sr;
    this.layout = layout;
    this.peaks = null;
    this.raw = null;
    this.rawPending = null;
    this.selection = null;
    this.message = '';
    this.v0 = 0;
    this.v1 = this.frames;
    this.mute = [];
    this.solo = [];
    this.levels = null;
    this.buildLabels();
    this.updateSel();
    this.draw();
  }

  clear(message = '') {
    this.frames = 0;
    this.levels = null;
    this.layout = null;
    this.peaks = null;
    this.raw = null;
    this.selection = null;
    this.message = message;
    this.labels.innerHTML = '';
    this.meterEls = [];
    this.updateSel();
    this.setPlayhead(null);
    this.draw();
  }

  setLayout(layout) {
    this.layout = layout;
    this.mute = [];
    this.solo = [];
    this.buildLabels();
    this.draw();
  }

  setPeaks(p) {
    this.peaks = p;
    if (p && p.done >= p.nb) this.computeLevels();
    this.draw();
  }

  buildLabels() {
    const L = this.layout;
    this.labels.innerHTML = '';
    this.meterEls = [];
    this.peakHold = [];
    if (!L) return;
    const n = L.ch;
    const compact = n > 8;
    this.labels.classList.toggle('compact', compact);
    L.chans.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'lane-label';
      el.style.setProperty('--lane-color', c.color);
      el.innerHTML = `<span class="lane-id"><span class="lane-name" title="${escapeAttr(c.label)}">${escapeHtml(c.label)}</span><span class="lane-pk"></span></span>
        <button class="ms m" title="Mute (click) · Alt-click: unmute all">M</button>
        <button class="ms s" title="Solo (click) · Ctrl-click: solo exclusively">S</button>
        <div class="lane-meter"><div class="fill"></div></div>`;
      el.querySelector('.m').addEventListener('click', e => this.toggleMS('mute', i, e));
      el.querySelector('.s').addEventListener('click', e => this.toggleMS('solo', i, e));
      this.labels.appendChild(el);
      this.meterEls.push(el.querySelector('.fill'));
      this.peakHold.push(0);
    });
    this.refreshMS();
    this.showLevels();
  }

  toggleMS(kind, i, e) {
    const arr = kind === 'mute' ? this.mute : this.solo;
    if (e.altKey) arr.length = 0;
    else if (e.ctrlKey && kind === 'solo') { const was = arr[i]; arr.length = 0; arr[i] = !was; }
    else arr[i] = !arr[i];
    this.refreshMS();
    this.cb.mutesolo && this.cb.mutesolo(this.mute.slice(), this.solo.slice());
  }

  soloOnly(i) {
    const was = this.solo[i] && this.solo.filter(Boolean).length === 1;
    this.solo.length = 0;
    if (!was) this.solo[i] = true;
    this.refreshMS();
    this.cb.mutesolo && this.cb.mutesolo(this.mute.slice(), this.solo.slice());
  }

  refreshMS() {
    const anySolo = this.solo.some(Boolean);
    [...this.labels.children].forEach((el, i) => {
      el.querySelector('.m').classList.toggle('on', !!this.mute[i]);
      el.querySelector('.s').classList.toggle('on', !!this.solo[i]);
      el.classList.toggle('silent', !!this.mute[i] || (anySolo && !this.solo[i]));
    });
    this.draw();
  }

  setMeters(m, dt) {
    if (!this.meterEls.length) return;
    const decay = Math.pow(0.5, dt / 0.25);
    for (let i = 0; i < this.meterEls.length; i++) {
      const v = m ? m[i] || 0 : 0;
      this.peakHold[i] = Math.max(v, this.peakHold[i] * decay);
      const db = 20 * Math.log10(this.peakHold[i] + 1e-9);
      const w = Math.max(0, Math.min(1, (db + 60) / 60));
      this.meterEls[i].style.transform = `scaleX(${w})`;
      this.meterEls[i].classList.toggle('hot', db > -1);
    }
  }

  // ---------------------------------------------------------------- geometry
  get W() { return this.wrap.clientWidth; }
  frameAt(x) { return this.v0 + (x / this.W) * (this.v1 - this.v0); }
  xAt(f) { return ((f - this.v0) / (this.v1 - this.v0)) * this.W; }

  setView(v0, v1) {
    const minSpan = Math.min(this.frames, 32);
    let span = Math.max(minSpan, Math.min(this.frames, v1 - v0));
    v0 = Math.max(0, Math.min(this.frames - span, v0));
    this.v0 = v0;
    this.v1 = v0 + span;
    this.updateSel();
    this.draw();
  }

  zoomAt(x, factor) {
    const f = this.frameAt(x);
    const span = (this.v1 - this.v0) * factor;
    const r = x / this.W;
    this.setView(f - span * r, f - span * r + span);
  }

  fit() { this.setView(0, this.frames); }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, this.wrap.clientWidth), h = Math.max(1, this.canvas.clientHeight);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.ruler.width = Math.round(w * dpr);
    this.ruler.height = Math.round(this.ruler.clientHeight * dpr);
    if (this.dbscale) {
      this.dbscale.width = Math.round(Math.max(1, this.dbscale.clientWidth) * dpr);
      this.dbscale.height = Math.round(Math.max(1, this.dbscale.clientHeight) * dpr);
    }
    this.updateSel();
    this.draw();
  }

  // ---------------------------------------------------------------- drawing
  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const c = this.ctx2d, cv = this.canvas;
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    this.paintRuler();
    this.paintScale();
    if (!this.layout || !this.frames) {
      if (this.message) {
        c.fillStyle = getComputedStyle(document.body).getPropertyValue('--muted');
        c.font = `${13 * dpr}px system-ui, sans-serif`;
        c.textAlign = 'center';
        c.fillText(this.message, W / 2, H / 2);
      }
      return;
    }
    const n = this.layout.ch;
    const laneH = H / n;
    const spp = (this.v1 - this.v0) / W; // frames per device pixel
    const anySolo = this.solo.some(Boolean);

    let useRaw = false;
    const viewFrames = this.v1 - this.v0;
    const needRaw = !this.peaks || spp < this.peaks.bucket;
    if (needRaw && this.rawProvider && viewFrames * n <= 4e6) {
      const r = this.raw;
      if (r && r.start <= this.v0 && r.start + r.n >= this.v1) useRaw = true;
      else this.requestRaw();
    }

    for (let ch = 0; ch < n; ch++) {
      const y0 = ch * laneH, mid = y0 + laneH / 2;
      const amp = (laneH / 2 - 2 * dpr) * this.vzoom;
      const info = this.layout.chans[ch];
      const silent = this.mute[ch] || (anySolo && !this.solo[ch]);
      if (ch % 2 === 1) { c.fillStyle = 'rgba(255,255,255,0.018)'; c.fillRect(0, y0, W, laneH); }
      c.fillStyle = 'rgba(255,255,255,0.07)';
      c.fillRect(0, Math.round(mid), W, 1);
      if (ch > 0) { c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(0, Math.round(y0), W, 1); }
      this.paintGuides(c, W, mid, amp, laneH, dpr);
      c.save();
      c.beginPath();
      c.rect(0, y0, W, laneH);
      c.clip();
      c.globalAlpha = silent ? 0.25 : 1;
      if (useRaw) this.paintRaw(c, ch, W, mid, amp, spp, info.color);
      else if (this.peaks && this.peaks.data[ch]) this.paintPeaks(c, ch, W, mid, amp, spp, info.color);
      c.restore();
    }
  }

  paintPeaks(c, ch, W, mid, amp, spp, color) {
    const p = this.peaks, d = p.data[ch], B = p.bucket, done = p.done;
    // Column buffers are reused between paints (one set, resized with the canvas).
    if (!this.cols || this.cols.top.length !== W) this.cols = { top: new Float32Array(W), bot: new Float32Array(W), rt: new Float32Array(W) };
    const { top, bot, rt } = this.cols;
    let last = -1;
    for (let x = 0; x < W; x++) {
      const f0 = this.v0 + x * spp, f1 = f0 + spp;
      let b0 = Math.floor(f0 / B), b1 = Math.max(b0 + 1, Math.ceil(f1 / B));
      b1 = Math.min(b1, done);
      if (b0 >= b1) { top[x] = bot[x] = rt[x] = 0; continue; }
      let mn = 0, mx = 0, r = 0;
      for (let b = b0; b < b1; b++) {
        const k = b * 3;
        if (d[k] < mn) mn = d[k];
        if (d[k + 1] > mx) mx = d[k + 1];
        if (d[k + 2] > r) r = d[k + 2];
      }
      top[x] = mx; bot[x] = mn; rt[x] = r;
      last = x;
    }
    if (last < 0) return;
    const lim = last + 1;
    for (let x = 0; x < lim; x++) { top[x] = this.amp01(top[x]); bot[x] = this.amp01(bot[x]); rt[x] = this.amp01(rt[x]); }
    c.fillStyle = withAlpha(color, 0.55);
    c.beginPath();
    c.moveTo(0, mid - top[0] * amp);
    for (let x = 1; x < lim; x++) c.lineTo(x, mid - top[x] * amp);
    for (let x = lim - 1; x >= 0; x--) c.lineTo(x, mid - bot[x] * amp + 1);
    c.closePath();
    c.fill();
    c.fillStyle = color;
    c.beginPath();
    c.moveTo(0, mid - rt[0] * amp);
    for (let x = 1; x < lim; x++) c.lineTo(x, mid - rt[x] * amp);
    for (let x = lim - 1; x >= 0; x--) c.lineTo(x, mid + rt[x] * amp + 1);
    c.closePath();
    c.fill();
  }

  paintRaw(c, ch, W, mid, amp, spp, color) {
    const r = this.raw, s = r.data[ch];
    if (!s) return;
    if (spp >= 1) {
      c.fillStyle = color;
      c.beginPath();
      for (let x = 0; x < W; x++) {
        const f0 = Math.floor(this.v0 + x * spp - r.start), f1 = Math.max(f0 + 1, Math.floor(this.v0 + (x + 1) * spp - r.start));
        let mn = 1e9, mx = -1e9;
        for (let f = Math.max(0, f0); f < Math.min(s.length, f1); f++) { const v = s[f]; if (v < mn) mn = v; if (v > mx) mx = v; }
        if (mn > mx) continue;
        const tx = this.amp01(mx), tn = this.amp01(mn);
        c.rect(x, mid - tx * amp, 1, Math.max(1, (tx - tn) * amp));
      }
      c.fill();
      return;
    }
    const dpr = window.devicePixelRatio || 1;
    c.strokeStyle = color;
    c.lineWidth = 1.25 * dpr;
    c.beginPath();
    const fStart = Math.max(0, Math.floor(this.v0) - r.start), fEnd = Math.min(s.length - 1, Math.ceil(this.v1) - r.start + 1);
    for (let f = fStart; f <= fEnd; f++) {
      const x = (r.start + f - this.v0) / spp, y = mid - this.amp01(s[f]) * amp;
      if (f === fStart) c.moveTo(x, y); else c.lineTo(x, y);
    }
    c.stroke();
    if (1 / spp > 6 * dpr) {
      c.fillStyle = color;
      for (let f = fStart; f <= fEnd; f++) {
        const x = (r.start + f - this.v0) / spp, y = mid - this.amp01(s[f]) * amp;
        c.fillRect(x - 1.5 * dpr, y - 1.5 * dpr, 3 * dpr, 3 * dpr);
      }
    }
  }

  requestRaw() {
    const span = this.v1 - this.v0;
    const start = Math.max(0, Math.floor(this.v0 - span * 0.5));
    const n = Math.min(this.frames - start, Math.ceil(span * 2) + 2);
    const key = `${start}:${n}`;
    if (this.rawPending === key) return;
    this.rawPending = key;
    const file = this.layout;
    this.rawProvider(start, n).then(data => {
      if (this.layout !== file || this.rawPending !== key) return;
      this.rawPending = null;
      this.raw = { start, n, data };
      this.draw();
    }).catch(() => { this.rawPending = null; });
  }

  paintRuler() {
    const c = this.rctx, W = this.ruler.width, H = this.ruler.height;
    const dpr = window.devicePixelRatio || 1;
    c.clearRect(0, 0, W, H);
    if (!this.frames || !this.layout) return;
    const secPerPx = (this.v1 - this.v0) / this.sr / W;
    const step = NICE_STEPS.find(s => s / secPerPx >= 70 * dpr) || 3600;
    const t0 = this.v0 / this.sr, t1 = this.v1 / this.sr;
    c.font = `${10 * dpr}px ui-monospace, Consolas, monospace`;
    c.textBaseline = 'top';
    for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round((t - t0) / secPerPx);
      c.fillStyle = 'rgba(255,255,255,0.25)';
      c.fillRect(x, H - 6 * dpr, 1, 6 * dpr);
      c.fillStyle = 'rgba(255,255,255,0.55)';
      const label = step < 1 ? `${t.toFixed(step < 0.01 ? 3 : step < 0.1 ? 2 : 1)}s` : fmtTime(t).replace(/\.0$/, '');
      c.fillText(label, x + 3 * dpr, 3 * dpr);
    }
    // Zoom indicator
    if (this.v1 - this.v0 < this.frames - 1) {
      const a = (this.v0 / this.frames) * W, b = (this.v1 / this.frames) * W;
      c.fillStyle = 'rgba(79,209,197,0.25)';
      c.fillRect(0, H - 2 * dpr, W, 2 * dpr);
      c.fillStyle = 'rgba(79,209,197,0.9)';
      c.fillRect(a, H - 2 * dpr, Math.max(2 * dpr, b - a), 2 * dpr);
    }
  }

  setPlayhead(frame) {
    if (frame == null || !this.frames || frame < this.v0 || frame > this.v1) {
      this.playhead.style.display = 'none';
      return;
    }
    this.playhead.style.display = 'block';
    this.playhead.style.transform = `translateX(${this.xAt(frame)}px)`;
  }

  setSelection(sel) {
    this.selection = sel;
    this.updateSel();
  }

  updateSel() {
    const s = this.selection;
    if (!s || !this.frames) { this.sel.style.display = 'none'; return; }
    const a = this.xAt(s.start), b = this.xAt(s.end);
    if (b < 0 || a > this.W) { this.sel.style.display = 'none'; return; }
    this.sel.style.display = 'block';
    this.sel.style.left = Math.max(0, a) + 'px';
    this.sel.style.width = Math.max(1, Math.min(this.W, b) - Math.max(0, a)) + 'px';
    this.sel.dataset.len = fmtTime((s.end - s.start) / this.sr, true);
  }

  // ---------------------------------------------------------------- levels + dB scale
  // Peak and RMS per channel from the finished peak data, so you can see how loud a sound
  // is before playing it. levels = { ch: [{ peak, rms }], peak, rms } (linear, 1 = 0 dBFS).
  computeLevels() {
    const p = this.peaks;
    if (!p || p.done < p.nb) return;
    const ch = [];
    for (let c = 0; c < p.ch; c++) {
      const d = p.data[c];
      if (!d) { ch.push({ peak: 0, rms: 0 }); continue; }
      let pk = 0, sq = 0;
      for (let b = 0; b < p.nb; b++) {
        const k = b * 3;
        const a = Math.max(-d[k], d[k + 1]);
        if (a > pk) pk = a;
        const cnt = Math.max(1, Math.min(p.bucket, p.frames - b * p.bucket));
        sq += d[k + 2] * d[k + 2] * cnt;
      }
      ch.push({ peak: pk, rms: Math.sqrt(sq / Math.max(1, p.frames)) });
    }
    const peak = Math.max(0, ...ch.map(x => x.peak));
    const rms = Math.sqrt(ch.reduce((t, x) => t + x.rms * x.rms, 0) / Math.max(1, ch.length));
    this.levels = { ch, peak, rms };
    this.showLevels();
    this.cb.levels && this.cb.levels(this.levels);
  }

  showLevels() {
    [...this.labels.children].forEach((el, i) => {
      const pk = el.querySelector('.lane-pk');
      const lv = this.levels && this.levels.ch[i];
      if (!pk) return;
      pk.textContent = lv ? fmtDb(lv.peak) : '';
      pk.title = lv ? `Peak ${fmtDb(lv.peak)} dBFS · RMS ${fmtDb(lv.rms)} dBFS` : '';
      pk.classList.toggle('hot', !!lv && lv.peak >= this.peakWarn);
    });
  }

  // Vertical position (0 … 1 of the half-lane) for a sample value: the lane runs from
  // −40 dBFS at the centre line to 0 dBFS at the edge, so the dB scale is even.
  amp01(v) {
    const a = v < 0 ? -v : v;
    if (a <= this.floorLin) return 0;
    const t = Math.min(1, (20 * Math.log10(a) - this.dbFloor) / -this.dbFloor);
    return v < 0 ? -t : t;
  }
  dbOffset(db) { return (db - this.dbFloor) / -this.dbFloor; }

  setDbFloor(db) {
    this.dbFloor = db === -60 ? -60 : -40;
    this.floorLin = Math.pow(10, this.dbFloor / 20);
    this.marks = [];
    for (let d = 0; d >= this.dbFloor; d -= 5) this.marks.push(d);
    this.draw();
  }

  setPeakWarn(db) {
    this.peakWarn = Math.pow(10, Math.max(-12, Math.min(0, Number(db) || 0)) / 20);
    this.showLevels();
    this.draw();
  }

  // dBFS marks for each lane (−40 … 0), matching the waveform and its vertical zoom;
  // a marker shows each channel's peak.
  paintScale() {
    const cv = this.dbscale;
    if (!cv) return;
    const c = cv.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const W = cv.width, H = cv.height;
    c.clearRect(0, 0, W, H);
    if (!this.layout || !this.frames) return;
    const n = this.layout.ch, laneH = H / n;
    c.font = `${9.5 * dpr}px ui-monospace, Consolas, monospace`;
    c.textAlign = 'right';
    c.textBaseline = 'middle';
    for (let ch = 0; ch < n; ch++) {
      const y0 = ch * laneH, mid = y0 + laneH / 2;
      const amp = (laneH / 2 - 2 * dpr) * this.vzoom;
      if (ch > 0) { c.fillStyle = 'rgba(255,255,255,0.06)'; c.fillRect(0, Math.round(y0), W, 1); }
      // Labels at one fixed step for the whole lane (every 5, 10 or 20 dB), so the scale is always even.
      const per5 = (5 / -this.dbFloor) * amp; // pixels between 5 dB marks
      const step = per5 >= 11 * dpr ? 5 : per5 * 2 >= 11 * dpr ? 10 : 20;
      for (const db of this.marks) {
        const off = this.dbOffset(db) * amp;
        if (off > laneH / 2 - 1 * dpr) continue; // above the lane at this zoom
        const yt = Math.round(mid - off), yb = Math.round(mid + off);
        const major = db % step === 0;
        c.fillStyle = major ? 'rgba(255,255,255,0.35)' : 'rgba(255,255,255,0.18)';
        c.fillRect(W - (major ? 5 : 3) * dpr, yt, (major ? 5 : 3) * dpr, 1);
        c.fillRect(W - (major ? 5 : 3) * dpr, yb, (major ? 5 : 3) * dpr, 1);
        if (major) {
          c.fillStyle = db === 0 ? 'rgba(255,255,255,0.75)' : 'rgba(255,255,255,0.5)';
          c.fillText(db === 0 ? '0' : '−' + -db, W - 7 * dpr, Math.max(y0 + 6 * dpr, yt));
        }
      }
      // This channel's peak.
      const lv = this.levels && this.levels.ch[ch];
      if (lv && lv.peak > this.floorLin) {
        const off = Math.min(laneH / 2 - 1 * dpr, this.amp01(lv.peak) * amp);
        c.fillStyle = lv.peak >= this.peakWarn ? '#fc8181' : this.layout.chans[ch].color;
        for (const y of [mid - off, mid + off]) {
          c.beginPath();
          c.moveTo(W - 6 * dpr, y - 3 * dpr); c.lineTo(W, y); c.lineTo(W - 6 * dpr, y + 3 * dpr);
          c.closePath();
          c.fill();
        }
      }
    }
  }

  // Faint level guides across the waveform at the same dB marks.
  paintGuides(c, W, mid, amp, laneH, dpr) {
    c.fillStyle = 'rgba(255,255,255,0.035)';
    for (const db of this.marks) {
      if (db === this.dbFloor) continue; // that's the centre line
      const off = this.dbOffset(db) * amp;
      if (off > laneH / 2 - 1 * dpr) continue;
      c.fillRect(0, Math.round(mid - off), W, 1);
      c.fillRect(0, Math.round(mid + off), W, 1);
    }
  }

  // ---------------------------------------------------------------- input
  bind() {
    const wrap = this.wrap;
    let drag = null;
    const xOf = e => e.clientX - wrap.getBoundingClientRect().left;

    wrap.addEventListener('mousedown', e => {
      if (e.button !== 0 || !this.frames || e.target === this.sel) return;
      e.preventDefault();
      drag = { x: xOf(e), f: this.frameAt(xOf(e)), moved: false };
    });
    window.addEventListener('mousemove', e => {
      if (this.frames && wrap.matches(':hover')) {
        const x = xOf(e);
        this.hover.style.display = 'block';
        this.hover.style.transform = `translateX(${x}px)`;
        this.hover.dataset.t = fmtTime(this.frameAt(x) / this.sr, true);
      } else this.hover.style.display = 'none';
      if (!drag) return;
      const x = xOf(e);
      if (!drag.moved && Math.abs(x - drag.x) < 4) return;
      drag.moved = true;
      const f = Math.max(0, Math.min(this.frames, this.frameAt(Math.max(0, Math.min(this.W, x)))));
      this.setSelection({ start: Math.min(drag.f, f), end: Math.max(drag.f, f) });
    });
    window.addEventListener('mouseup', () => {
      if (!drag) return;
      const d = drag;
      drag = null;
      if (d.moved && this.selection && this.selection.end - this.selection.start > 1) this.cb.select && this.cb.select(this.selection);
      else {
        this.setSelection(null);
        this.cb.select && this.cb.select(null);
        this.cb.seek && this.cb.seek(Math.max(0, Math.min(this.frames - 1, d.f)));
      }
    });
    wrap.addEventListener('mouseleave', () => { this.hover.style.display = 'none'; });

    // Click inside a selection plays it; dragging it drops a region file into the DAW.
    this.sel.draggable = true;
    this.sel.addEventListener('click', e => {
      const x = e.clientX - wrap.getBoundingClientRect().left;
      this.cb.seek && this.cb.seek(this.frameAt(x), true);
    });
    this.sel.addEventListener('dragstart', e => {
      e.preventDefault();
      this.cb.dragRegion && this.cb.dragRegion(this.selection);
    });

    wrap.addEventListener('wheel', e => {
      if (!this.frames) return;
      e.preventDefault();
      const x = xOf(e);
      if (e.altKey) {
        this.vzoom = Math.max(1, Math.min(32, this.vzoom * (e.deltaY < 0 ? 1.25 : 0.8)));
        this.draw();
      } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
        const d = (e.shiftKey ? e.deltaY : e.deltaX) / this.W * (this.v1 - this.v0);
        this.setView(this.v0 + d, this.v1 + d);
      } else {
        this.zoomAt(x, Math.pow(1.0015, e.deltaY));
      }
    }, { passive: false });
    wrap.addEventListener('dblclick', e => { if (e.target !== this.sel) this.fit(); });
  }
}

function withAlpha(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const escapeAttr = escapeHtml;
