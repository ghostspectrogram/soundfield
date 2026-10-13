// Channel layouts, layout detection and monitoring matrices.
// Angles: azimuth in degrees, positive = left (counter-clockwise from front),
// elevation positive = up.

export const ROLES = {
  M:   { az: 0, el: 0, g: 'front' },
  L:   { az: 30, el: 0, g: 'front' },
  R:   { az: -30, el: 0, g: 'front' },
  C:   { az: 0, el: 0, g: 'front' },
  LFE: { az: 0, el: -20, g: 'lfe', lfe: true },
  Lc:  { az: 15, el: 0, g: 'front' },
  Rc:  { az: -15, el: 0, g: 'front' },
  Lw:  { az: 60, el: 0, g: 'front' },
  Rw:  { az: -60, el: 0, g: 'front' },
  Ls:  { az: 110, el: 0, g: 'surround' },
  Rs:  { az: -110, el: 0, g: 'surround' },
  Lss: { az: 90, el: 0, g: 'surround' },
  Rss: { az: -90, el: 0, g: 'surround' },
  Lrs: { az: 150, el: 0, g: 'rear' },
  Rrs: { az: -150, el: 0, g: 'rear' },
  Cs:  { az: 180, el: 0, g: 'rear' },
  Ltf: { az: 45, el: 45, g: 'top' },
  Rtf: { az: -45, el: 45, g: 'top' },
  Ctf: { az: 0, el: 45, g: 'top' },
  Ltm: { az: 90, el: 60, g: 'top' },
  Rtm: { az: -90, el: 60, g: 'top' },
  Ltr: { az: 135, el: 45, g: 'top' },
  Rtr: { az: -135, el: 45, g: 'top' },
  Ctr: { az: 180, el: 45, g: 'top' },
  Ts:  { az: 0, el: 90, g: 'top' },
  S:   { az: 90, el: 0, g: 'surround' }, // M/S side signal (shown at the side)
};

export const GROUP_COLORS = {
  front: '#4fd1c5', surround: '#7f9cf5', rear: '#b794f4', top: '#f6ad55',
  lfe: '#fc8181', ambi: '#68d391', other: '#a0aec0',
};

// Named layouts, channel order as stored in the file.
export const LAYOUTS = {
  mono:        { label: 'Mono', roles: ['M'] },
  stereo:      { label: 'Stereo', roles: ['L', 'R'] },
  ms:          { label: 'M/S', roles: ['M', 'S'], ms: true },
  lcr:         { label: 'LCR', roles: ['L', 'R', 'C'] },
  quad:        { label: 'Quad', roles: ['L', 'R', 'Ls', 'Rs'] },
  '5.0':       { label: '5.0', roles: ['L', 'R', 'C', 'Ls', 'Rs'] },
  '5.1':       { label: '5.1', roles: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs'] },
  '5.1film':   { label: '5.1', roles: ['L', 'C', 'R', 'Ls', 'Rs', 'LFE'], note: 'Film order' },
  '7.0':       { label: '7.0', roles: ['L', 'R', 'C', 'Lss', 'Rss', 'Lrs', 'Rrs'] },
  '7.1':       { label: '7.1', roles: ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs'] },
  '7.1wav':    { label: '7.1', roles: ['L', 'R', 'C', 'LFE', 'Lrs', 'Rrs', 'Lss', 'Rss'], note: 'WAV order' },
  '7.1film':   { label: '7.1', roles: ['L', 'C', 'R', 'Lss', 'Rss', 'Lrs', 'Rrs', 'LFE'], note: 'Film order' },
  '5.1.2':     { label: '5.1.2', roles: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Ltm', 'Rtm'] },
  '5.1.4':     { label: '5.1.4', roles: ['L', 'R', 'C', 'LFE', 'Ls', 'Rs', 'Ltf', 'Rtf', 'Ltr', 'Rtr'] },
  '7.1.2':     { label: '7.1.2', roles: ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltm', 'Rtm'] },
  '7.1.4':     { label: '7.1.4', roles: ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Ltf', 'Rtf', 'Ltr', 'Rtr'] },
  '9.1.6':     { label: '9.1.6', roles: ['L', 'R', 'C', 'LFE', 'Lss', 'Rss', 'Lrs', 'Rrs', 'Lw', 'Rw', 'Ltf', 'Rtf', 'Ltm', 'Rtm', 'Ltr', 'Rtr'] },
  ambix1:      { label: 'FOA', ambi: { order: 1 } },
  fuma1:       { label: 'FOA', ambi: { order: 1, fuma: true }, note: 'FuMa' },
  ambix2:      { label: '2OA', ambi: { order: 2 } },
  ambix3:      { label: '3OA', ambi: { order: 3 } },
};

// Choices for the per-file layout override menu, grouped by channel count.
export function layoutChoices(ch) {
  const out = [];
  for (const [id, l] of Object.entries(LAYOUTS)) {
    const n = l.ambi ? (l.ambi.order + 1) ** 2 : l.roles.length;
    if (n === ch) out.push({ id, label: l.ambi ? `${l.label} ${l.ambi.fuma ? '(FuMa)' : '(AmbiX)'}` : l.label + (l.note ? ` (${l.note})` : '') });
  }
  out.push({ id: 'discrete', label: `${ch} discrete channels` });
  return out;
}

const MASK_BITS = ['L', 'R', 'C', 'LFE', 'BL', 'BR', 'Lc', 'Rc', 'Cs', 'SL', 'SR', 'Ts', 'Ltf', 'Ctf', 'Rtf', 'Ltr', 'Ctr', 'Rtr'];

const NAME_ROLES = {
  l: 'L', left: 'L', r: 'R', right: 'R', c: 'C', center: 'C', centre: 'C', lfe: 'LFE', sub: 'LFE',
  ls: 'Ls', rs: 'Rs', lsr: 'Lrs', rsr: 'Rrs', lrs: 'Lrs', rrs: 'Rrs', lb: 'Lrs', rb: 'Rrs',
  lss: 'Lss', rss: 'Rss', lsd: 'Lss', rsd: 'Rss', cs: 'Cs', lc: 'Lc', rc: 'Rc', lw: 'Lw', rw: 'Rw',
  ltf: 'Ltf', rtf: 'Rtf', ltm: 'Ltm', rtm: 'Rtm', ltr: 'Ltr', rtr: 'Rtr', ltb: 'Ltr', rtb: 'Rtr',
  ts: 'Ts', vog: 'Ts',
};

function chansFromRoles(roles, names) {
  return roles.map((r, i) => {
    const d = ROLES[r] || { az: 0, el: 0, g: 'other' };
    return { role: r, label: (names && names[i]) || r, az: d.az, el: d.el, lfe: !!d.lfe, group: d.g, color: GROUP_COLORS[d.g] };
  });
}

function ambiChans(ch, fuma, names) {
  const fumaNames = ['W', 'X', 'Y', 'Z'];
  const out = [];
  for (let i = 0; i < ch; i++) {
    let label;
    if (fuma) label = fumaNames[i] || String(i + 1);
    else {
      const n = Math.floor(Math.sqrt(i)), m = i - n * n - n;
      label = i === 0 ? 'W' : `${n}${m >= 0 ? '+' : ''}${m}`;
    }
    out.push({ role: 'A' + i, label: (names && names[i]) || label, az: 0, el: 0, lfe: false, group: 'ambi', color: GROUP_COLORS.ambi });
  }
  return out;
}

function discreteChans(ch, names) {
  return Array.from({ length: ch }, (_, i) => {
    const az = ch === 1 ? 0 : 90 - (180 * i) / (ch - 1);
    return { role: 'D' + i, label: (names && names[i]) || String(i + 1), az, el: 0, lfe: false, group: 'other', color: GROUP_COLORS.other };
  });
}

function fromId(id, ch, names) {
  if (id === 'discrete') return { id, label: `${ch}ch`, cls: 'multi', ch, chans: discreteChans(ch, names), ambi: null };
  const l = LAYOUTS[id];
  if (!l) return null;
  if (l.ambi) {
    if ((l.ambi.order + 1) ** 2 !== ch) return null;
    return { id, label: l.label, cls: 'ambi', ch, chans: ambiChans(ch, l.ambi.fuma, names), ambi: { ...l.ambi } };
  }
  if (l.roles.length !== ch) return null;
  return finish({ id, label: l.label, ch, chans: chansFromRoles(l.roles, names), ambi: null, ms: !!l.ms });
}

function finish(layout) {
  const hasTop = layout.chans.some(c => c.group === 'top');
  layout.cls = layout.ms ? 'stereo' : layout.ch === 1 ? 'mono' : layout.ch === 2 ? 'stereo' : hasTop ? 'immersive' : 'surround';
  return layout;
}

function fromMask(mask, ch, names) {
  const bits = [];
  for (let b = 0; b < 18; b++) if (mask & (1 << b)) bits.push(MASK_BITS[b]);
  if (bits.length !== ch) return null;
  const hasSide = bits.includes('SL'), hasBack = bits.includes('BL');
  const roles = bits.map(b => {
    if (b === 'BL') return hasSide ? 'Lrs' : 'Ls';
    if (b === 'BR') return hasSide ? 'Rrs' : 'Rs';
    if (b === 'SL') return hasBack ? 'Lss' : 'Ls';
    if (b === 'SR') return hasBack ? 'Rss' : 'Rs';
    return b;
  });
  const key = roles.join(',');
  let id = 'mask', label = null;
  for (const [lid, l] of Object.entries(LAYOUTS)) {
    if (l.roles && [...l.roles].sort().join(',') === [...roles].sort().join(',')) { id = lid; label = l.label; break; }
  }
  if (ch === 1) label = 'Mono';
  const chans = chansFromRoles(roles, names);
  if (!label) {
    const lfe = roles.includes('LFE') ? 1 : 0;
    const top = chans.filter(c => c.group === 'top').length;
    label = `${ch - lfe - top}.${lfe}${top ? '.' + top : ''}`;
  }
  return finish({ id: id + ':' + key, label, ch, chans, ambi: null });
}

function fromTrackNames(names, ch) {
  if (!names || names.length !== ch) return null;
  const tokens = names.map(n => String(n || '').trim().toLowerCase().replace(/[\s_\-.]+/g, ''));
  if (ch === 2 && ['m', 'mid'].includes(tokens[0]) && ['s', 'side'].includes(tokens[1])) return fromId('ms', 2, names);
  if (ch === 4 && tokens.join(',') === 'w,x,y,z') return fromId('fuma1', 4, names);
  const roles = tokens.map(t => NAME_ROLES[t]);
  if (roles.some(r => !r) || new Set(roles).size !== roles.length) return null;
  const chans = chansFromRoles(roles, names);
  const lfe = roles.includes('LFE') ? 1 : 0;
  const top = chans.filter(c => c.group === 'top').length;
  const label = ch === 1 ? 'Mono' : ch === 2 ? 'Stereo' : `${ch - lfe - top}.${lfe}${top ? '.' + top : ''}`;
  return finish({ id: 'names:' + roles.join(','), label, ch, chans, ambi: null });
}

const AMBI_RE = /ambix|ambisonic|b[-_ ]?format|(^|[^a-z])(foa|hoa|[1-7]oa)([^a-z]|$)/i;
const FUMA_RE = /fuma|\.amb$/i;

const DEFAULTS = { 1: 'mono', 2: 'stereo', 3: 'lcr', 4: 'quad', 5: '5.0', 6: '5.1', 7: '7.0', 8: '7.1', 9: 'ambix2', 10: '5.1.4', 12: '7.1.4', 16: 'ambix3' };

// rec: index record ({ rel, ch, mask, tn, ag }); ctx: { path, override, fourCh }
export function detectLayout(rec, ctx = {}) {
  const ch = rec.ch || 0;
  const names = rec.tn;
  if (!ch) return { id: 'unknown', label: '—', cls: 'multi', ch: 0, chans: [], ambi: null };
  if (ctx.override) {
    const o = fromId(ctx.override, ch, names);
    if (o) return o;
  }
  if (rec.ag && ch === 4) return fromId('fuma1', 4, names);
  const byName = fromTrackNames(names, ch);
  if (byName) return byName;
  const p = ctx.path || rec.rel || '';
  if ([4, 9, 16, 25, 36].includes(ch) && AMBI_RE.test(p)) {
    const order = Math.sqrt(ch) - 1;
    const fuma = order === 1 && FUMA_RE.test(p);
    const l = fromId(fuma ? 'fuma1' : 'ambix' + order, ch, names);
    if (l) return l;
  }
  if (rec.mask) {
    const m = fromMask(rec.mask, ch, names);
    if (m) return m;
  }
  if (ch === 4 && ctx.fourCh && ctx.fourCh !== 'auto') return fromId(ctx.fourCh === 'fuma' ? 'fuma1' : ctx.fourCh === 'ambix' ? 'ambix1' : 'quad', 4, names);
  if (DEFAULTS[ch]) {
    const l = fromId(DEFAULTS[ch], ch, names);
    if (l) return l;
  }
  return fromId('discrete', ch, names);
}

// ------------------------------------------------------------ ambisonics
// Real spherical harmonics, ACN ordering, SN3D normalisation, up to 3rd order.
function sh(order, az, el) {
  const a = az * Math.PI / 180, e = el * Math.PI / 180;
  const x = Math.cos(a) * Math.cos(e), y = Math.sin(a) * Math.cos(e), z = Math.sin(e);
  const s3 = Math.sqrt(3);
  const v = [1, y, z, x];
  if (order >= 2) v.push(s3 * x * y, s3 * y * z, 0.5 * (3 * z * z - 1), s3 * x * z, (s3 / 2) * (x * x - y * y));
  if (order >= 3) {
    v.push(
      Math.sqrt(5 / 8) * y * (3 * x * x - y * y),
      Math.sqrt(15) * x * y * z,
      Math.sqrt(3 / 8) * y * (5 * z * z - 1),
      0.5 * z * (5 * z * z - 3),
      Math.sqrt(3 / 8) * x * (5 * z * z - 1),
      (Math.sqrt(15) / 2) * z * (x * x - y * y),
      Math.sqrt(5 / 8) * x * (x * x - 3 * y * y),
    );
  }
  return v;
}

// Max-rE weights per order (3D)
const MAXRE = { 1: [1, 0.577], 2: [1, 0.775, 0.4], 3: [1, 0.861, 0.612, 0.305] };

function virtualSpeakers(order) {
  if (order === 1) {
    const out = [];
    for (const el of [35.26, -35.26]) for (const az of [45, 135, -135, -45]) out.push({ az, el });
    return out;
  }
  const n = order === 2 ? 18 : 26;
  const out = [];
  const ga = Math.PI * (3 - Math.sqrt(5));
  for (let i = 0; i < n; i++) {
    const z = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - z * z);
    const t = ga * i;
    out.push({ az: Math.atan2(Math.sin(t) * r, Math.cos(t) * r) * 180 / Math.PI, el: Math.asin(z) * 180 / Math.PI });
  }
  return out;
}

// For each file channel: which ACN component it carries and with what gain to reach SN3D.
function ambiInputMap(layout) {
  const { order, fuma } = layout.ambi;
  if (fuma) return [{ acn: 0, k: Math.SQRT2 }, { acn: 3, k: 1 }, { acn: 1, k: 1 }, { acn: 2, k: 1 }];
  return Array.from({ length: layout.ch }, (_, i) => ({ acn: i < (order + 1) ** 2 ? i : -1, k: 1 }));
}

export function ambiMeterMap(layout) {
  if (!layout.ambi) return null;
  const map = ambiInputMap(layout);
  const find = acn => { const i = map.findIndex(m => m.acn === acn); return i < 0 ? null : { i, k: map[i].k }; };
  return { w: find(0), y: find(1), z: find(2), x: find(3) };
}

// ------------------------------------------------------------ monitoring
// Returns { outCount, matrix(out x in, row-major), speakers: [{az, el}] for
// binaural (output channels 0..speakers-1), direct: index of a non-spatialised
// L/R pair or -1 }.
export function buildMonitor(layout, mode, opts = {}) {
  const N = layout.ch;
  const lfeGain = opts.lfe ? 0.707 : 0;
  const enable = channelEnables(N, opts.mute, opts.solo);

  if (mode === 'discrete') {
    const m = new Float32Array(N * N);
    for (let i = 0; i < N; i++) m[i * N + i] = enable[i];
    return { outCount: N, matrix: m, speakers: [], direct: -1 };
  }

  if (layout.ambi) {
    const map = ambiInputMap(layout);
    if (mode === 'binaural') {
      const spk = virtualSpeakers(layout.ambi.order);
      const L = spk.length, w = MAXRE[layout.ambi.order];
      const m = new Float32Array(L * N);
      spk.forEach((s, o) => {
        const y = sh(layout.ambi.order, s.az, s.el);
        for (let i = 0; i < N; i++) {
          const { acn, k } = map[i];
          if (acn < 0) continue;
          const n = Math.floor(Math.sqrt(acn));
          m[o * N + i] = enable[i] * k * (2 * n + 1) * w[n] * y[acn] / L * 1.6;
        }
      });
      return { outCount: L, matrix: m, speakers: spk, direct: -1 };
    }
    // Stereo: two virtual cardioids at +/-60 degrees from the first-order components.
    const m = new Float32Array(2 * N);
    [60, -60].forEach((az, o) => {
      const y = sh(1, az, 0);
      for (let i = 0; i < N; i++) {
        const { acn, k } = map[i];
        if (acn < 0 || acn > 3) continue;
        m[o * N + i] = enable[i] * k * 0.5 * y[acn];
      }
    });
    return { outCount: 2, matrix: m, speakers: [], direct: -1 };
  }

  if (layout.ms) {
    // M/S decode: L = M + S, R = M - S
    const g = 0.707;
    if (mode === 'binaural') {
      const m = new Float32Array(2 * N);
      m[0] = g * enable[0]; m[1] = g * enable[1];
      m[N] = g * enable[0]; m[N + 1] = -g * enable[1];
      return { outCount: 2, matrix: m, speakers: [{ az: 30, el: 0 }, { az: -30, el: 0 }], direct: -1 };
    }
    const m = new Float32Array(2 * N);
    m[0] = g * enable[0]; m[1] = g * enable[1];
    m[N] = g * enable[0]; m[N + 1] = -g * enable[1];
    return { outCount: 2, matrix: m, speakers: [], direct: -1 };
  }

  if (N === 1) {
    const m = new Float32Array(2);
    m[0] = enable[0]; m[1] = enable[0];
    return { outCount: 2, matrix: m, speakers: [], direct: mode === 'binaural' ? 0 : -1 };
  }

  if (mode === 'binaural') {
    const spk = [], idx = [];
    layout.chans.forEach((c, i) => { if (!c.lfe) { idx[i] = spk.length; spk.push({ az: c.az, el: c.el }); } });
    const K = spk.length, out = K + 2;
    const m = new Float32Array(out * N);
    layout.chans.forEach((c, i) => {
      if (c.lfe) { m[K * N + i] = lfeGain * enable[i]; m[(K + 1) * N + i] = lfeGain * enable[i]; }
      else m[idx[i] * N + i] = enable[i];
    });
    return { outCount: out, matrix: m, speakers: spk, direct: K };
  }

  // Stereo Lo/Ro downmix
  const m = new Float32Array(2 * N);
  layout.chans.forEach((c, i) => {
    let gl, gr;
    if (c.lfe) { gl = gr = lfeGain; }
    else {
      const p = Math.max(-1, Math.min(1, -c.az / 30)); // -1 = hard left
      const th = (p + 1) * Math.PI / 4;
      gl = Math.cos(th); gr = Math.sin(th);
      const behind = Math.abs(c.az) > 60;
      const att = (behind ? 0.707 : 1) * (c.group === 'top' ? 0.707 : 1);
      if (Math.abs(c.az) >= 179) { gl = gr = 0.5; } else { gl *= att; gr *= att; }
      if (N === 2) { gl = i === 0 ? 1 : 0; gr = i === 1 ? 1 : 0; }
    }
    m[i] = gl * enable[i];
    m[N + i] = gr * enable[i];
  });
  return { outCount: 2, matrix: m, speakers: [], direct: -1 };
}

function channelEnables(N, mute = [], solo = []) {
  const anySolo = solo.some(Boolean);
  return Array.from({ length: N }, (_, i) => (mute[i] ? 0 : anySolo ? (solo[i] ? 1 : 0) : 1));
}

