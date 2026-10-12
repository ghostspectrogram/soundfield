// Top-down speaker map. Ear-level speakers sit on the outer ring, height
// speakers on the inner ring; each lights up with its channel level. For
// ambisonics, an intensity vector shows where the energy is coming from.

export class SpeakerView {
  constructor(canvas) {
    this.canvas = canvas;
    this.c = canvas.getContext('2d');
    this.layout = null;
    this.levels = [];
    this.dir = null;
    this.trail = [];
    this.mute = [];
    this.solo = [];
    this.onPick = null;
    new ResizeObserver(() => this.resize()).observe(canvas);
    canvas.addEventListener('click', e => this.click(e));
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(this.canvas.clientWidth * dpr);
    this.canvas.height = Math.round(this.canvas.clientHeight * dpr);
    this.draw();
  }

  setLayout(layout) {
    this.layout = layout;
    this.levels = [];
    this.dir = null;
    this.trail = [];
    this.draw();
  }

  setMuteSolo(mute, solo) { this.mute = mute; this.solo = solo; this.draw(); }

  update(meters, iv, dt) {
    const L = this.layout;
    if (!L) return;
    const decay = Math.pow(0.5, dt / 0.18);
    for (let i = 0; i < L.ch; i++) {
      const v = meters ? meters[i] || 0 : 0;
      const lv = Math.max(0, Math.min(1, (20 * Math.log10(v + 1e-9) + 54) / 54));
      this.levels[i] = Math.max(lv, (this.levels[i] || 0) * decay);
    }
    if (L.ambi && iv && iv[0] > 1e-7) {
      const [e, x, y, z] = iv;
      const mag = Math.hypot(x, y, z);
      const diffuse = Math.min(1, mag / e); // 1 = single plane wave, 0 = fully diffuse
      const az = Math.atan2(y, x), el = Math.atan2(z, Math.hypot(x, y));
      const loud = Math.max(0, Math.min(1, (10 * Math.log10(e / 768 + 1e-12) + 60) / 60));
      this.dir = { az, el, diffuse, loud };
      this.trail.push({ az, el, a: loud * diffuse });
      if (this.trail.length > 24) this.trail.shift();
    } else if (this.dir) {
      this.dir.loud *= decay;
      if (this.dir.loud < 0.02) { this.dir = null; this.trail = []; }
    }
    this.draw();
  }

  geom() {
    const W = this.canvas.width, H = this.canvas.height;
    const R = Math.min(W, H) / 2 - 26 * (window.devicePixelRatio || 1);
    return { W, H, cx: W / 2, cy: H / 2, R };
  }

  pos(az, el, g) {
    const a = az * Math.PI / 180;
    const r = el >= 80 ? 0 : g.R * (el > 10 ? 0.55 : el < -10 ? 0.25 : 1);
    return { x: g.cx - Math.sin(a) * r, y: g.cy - Math.cos(a) * r };
  }

  draw() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.paint(); });
  }

  paint() {
    const c = this.c, g = this.geom(), dpr = window.devicePixelRatio || 1;
    c.clearRect(0, 0, g.W, g.H);
    if (g.R <= 0) return;
    c.lineWidth = dpr;
    c.strokeStyle = 'rgba(255,255,255,0.10)';
    c.beginPath(); c.arc(g.cx, g.cy, g.R, 0, Math.PI * 2); c.stroke();
    c.setLineDash([3 * dpr, 4 * dpr]);
    c.beginPath(); c.arc(g.cx, g.cy, g.R * 0.55, 0, Math.PI * 2); c.stroke();
    c.setLineDash([]);
    // head
    c.fillStyle = 'rgba(255,255,255,0.12)';
    c.beginPath(); c.arc(g.cx, g.cy, 9 * dpr, 0, Math.PI * 2); c.fill();
    c.beginPath(); c.moveTo(g.cx - 4 * dpr, g.cy - 8 * dpr); c.lineTo(g.cx, g.cy - 14 * dpr); c.lineTo(g.cx + 4 * dpr, g.cy - 8 * dpr); c.fill();

    const L = this.layout;
    if (!L) return;
    c.font = `${9.5 * dpr}px system-ui, sans-serif`;
    c.textAlign = 'center';
    c.textBaseline = 'middle';

    if (L.ambi) {
      for (let i = 0; i < 12; i++) {
        const a = (i / 12) * Math.PI * 2;
        c.fillStyle = 'rgba(104,211,145,0.18)';
        c.beginPath(); c.arc(g.cx + Math.cos(a) * g.R, g.cy + Math.sin(a) * g.R, 2 * dpr, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = 'rgba(255,255,255,0.45)';
      c.fillText('FRONT', g.cx, g.cy - g.R - 9 * dpr);
      this.trail.forEach((t, i) => {
        const p = this.dirPos(t.az, t.el, g);
        c.fillStyle = `rgba(104,211,145,${(i / this.trail.length) * t.a * 0.35})`;
        c.beginPath(); c.arc(p.x, p.y, 5 * dpr, 0, Math.PI * 2); c.fill();
      });
      if (this.dir) {
        const d = this.dir, p = this.dirPos(d.az, d.el, g);
        const rad = (8 + 26 * (1 - d.diffuse)) * dpr;
        const grd = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, rad);
        grd.addColorStop(0, `rgba(104,211,145,${0.9 * d.loud})`);
        grd.addColorStop(1, 'rgba(104,211,145,0)');
        c.fillStyle = grd;
        c.beginPath(); c.arc(p.x, p.y, rad, 0, Math.PI * 2); c.fill();
        c.fillStyle = 'rgba(255,255,255,0.6)';
        c.fillText(`${Math.round(d.az * 180 / Math.PI)}° / ${Math.round(d.el * 180 / Math.PI)}°`, g.cx, g.cy + g.R + 10 * dpr);
      }
      return;
    }

    const anySolo = this.solo.some(Boolean);
    L.chans.forEach((ch, i) => {
      const p = ch.lfe ? { x: g.cx, y: g.cy + g.R * 0.36 } : this.pos(ch.az, ch.el, g);
      const lv = this.levels[i] || 0;
      const silent = this.mute[i] || (anySolo && !this.solo[i]);
      const r = (ch.group === 'top' ? 7 : 9) * dpr;
      if (lv > 0.02 && !silent) {
        const grd = c.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * 3);
        grd.addColorStop(0, hexA(ch.color, 0.55 * lv));
        grd.addColorStop(1, hexA(ch.color, 0));
        c.fillStyle = grd;
        c.beginPath(); c.arc(p.x, p.y, r * 3, 0, Math.PI * 2); c.fill();
      }
      c.fillStyle = silent ? 'rgba(255,255,255,0.06)' : hexA(ch.color, 0.18 + 0.82 * lv);
      c.strokeStyle = this.solo[i] ? '#f6e05e' : hexA(ch.color, silent ? 0.3 : 0.9);
      c.lineWidth = (this.solo[i] ? 2 : 1) * dpr;
      c.beginPath();
      if (ch.lfe) c.rect(p.x - r, p.y - r * 0.8, r * 2, r * 1.6);
      else if (ch.group === 'top') { c.moveTo(p.x, p.y - r); c.lineTo(p.x + r, p.y); c.lineTo(p.x, p.y + r); c.lineTo(p.x - r, p.y); c.closePath(); }
      else c.arc(p.x, p.y, r, 0, Math.PI * 2);
      c.fill();
      c.stroke();
      c.fillStyle = silent ? 'rgba(255,255,255,0.3)' : 'rgba(255,255,255,0.85)';
      const label = ch.label.length > 5 ? ch.label.slice(0, 5) : ch.label;
      const ly = ch.lfe ? p.y + r + 8 * dpr : p.y + (p.y < g.cy - 2 ? -r - 8 * dpr : r + 8 * dpr);
      c.fillText(label, p.x, ly);
      ch._p = p;
      ch._r = r * 1.6;
    });
  }

  dirPos(az, el, g) {
    const r = g.R * Math.cos(el);
    return { x: g.cx - Math.sin(az) * r, y: g.cy - Math.cos(az) * r };
  }

  click(e) {
    const L = this.layout;
    if (!L || L.ambi || !this.onPick) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = this.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) * dpr, y = (e.clientY - rect.top) * dpr;
    let best = -1, bd = Infinity;
    L.chans.forEach((ch, i) => {
      if (!ch._p) return;
      const d = Math.hypot(ch._p.x - x, ch._p.y - y);
      if (d < ch._r && d < bd) { bd = d; best = i; }
    });
    if (best >= 0) this.onPick(best);
  }
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
