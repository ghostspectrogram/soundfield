// Draws the Soundfield icon (concentric "sound field" rings with five
// speaker dots in a 5.1 layout) at every size Windows uses and writes
// build/icon.ico + build/icon.png. No dependencies: shapes are rendered
// from signed distances with 4x4 supersampling, PNG is encoded with zlib.
//   node tools/make-icon.js
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const TEAL = [79, 209, 197];

function render(S) {
  const px = new Float64Array(S * S * 4); // premultiplied RGBA, 0..1
  const ss = 4;
  // Geometry in a 0..1 unit square.
  const pad = S <= 32 ? 0.02 : 0.04;
  const radius = 0.22;
  const small = S <= 32;
  const rings = small
    ? [{ r: 0.30, w: 0.075, a: 0.55 }]
    : [{ r: 0.335, w: 0.042, a: 0.38 }, { r: 0.215, w: 0.05, a: 0.7 }];
  const dotR = small ? 0.115 : 0.088;
  const spk = small ? [] : [30, -30, 0, 110, -110].map(az => {
    const a = (az * Math.PI) / 180;
    return { x: 0.5 - Math.sin(a) * 0.335, y: 0.5 - Math.cos(a) * 0.335, r: 0.052 };
  });

  const over = (o, c, a) => { // composite colour c (0..255) with coverage a over o
    for (let k = 0; k < 3; k++) o[k] = (c[k] / 255) * a + o[k] * (1 - a);
    o[3] = a + o[3] * (1 - a);
  };

  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const acc = [0, 0, 0, 0];
    for (let sy = 0; sy < ss; sy++) for (let sx = 0; sx < ss; sx++) {
      const u = (x + (sx + 0.5) / ss) / S, v = (y + (sy + 0.5) / ss) / S;
      const o = [0, 0, 0, 0];
      // Rounded-square tile with a soft vertical gradient.
      const qx = Math.abs(u - 0.5) - (0.5 - pad - radius), qy = Math.abs(v - 0.5) - (0.5 - pad - radius);
      const d = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - radius;
      if (d <= 0) {
        const t = v;
        over(o, [24 - 8 * t, 30 - 10 * t, 40 - 12 * t], 1);
        // faint teal glow from the centre
        const g = Math.max(0, 1 - Math.hypot(u - 0.5, v - 0.5) / 0.48);
        over(o, TEAL, 0.10 * g * g);
        const dc = Math.hypot(u - 0.5, v - 0.5);
        for (const rg of rings) if (Math.abs(dc - rg.r) <= rg.w / 2) over(o, TEAL, rg.a);
        for (const s of spk) {
          const ds = Math.hypot(u - s.x, v - s.y);
          if (ds <= s.r + 0.022) over(o, [24, 30, 40], 1); // cut-out around the speaker
          if (ds <= s.r) over(o, [226, 250, 247], 1);
        }
        if (dc <= dotR) over(o, TEAL, 1);
      }
      for (let k = 0; k < 4; k++) acc[k] += o[k];
    }
    const i = (y * S + x) * 4;
    for (let k = 0; k < 4; k++) px[i + k] = acc[k] / (ss * ss);
  }
  // Un-premultiply to 8-bit RGBA.
  const out = Buffer.alloc(S * S * 4);
  for (let i = 0; i < S * S; i++) {
    const a = px[i * 4 + 3];
    for (let k = 0; k < 3; k++) out[i * 4 + k] = a ? Math.round(Math.min(1, px[i * 4 + k] / a) * 255) : 0;
    out[i * 4 + 3] = Math.round(a * 255);
  }
  return out;
}

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return buf => { let c = 0xffffffff; for (const b of buf) c = t[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
})();

function png(rgba, S) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(CRC(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
  const raw = Buffer.alloc(S * (S * 4 + 1));
  for (let y = 0; y < S; y++) rgba.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]);
}

// Classic 32-bit DIB entry (what every Windows icon reader understands).
function dib(rgba, S) {
  const h = Buffer.alloc(40);
  h.writeUInt32LE(40, 0); h.writeInt32LE(S, 4); h.writeInt32LE(S * 2, 8);
  h.writeUInt16LE(1, 12); h.writeUInt16LE(32, 14);
  const pix = Buffer.alloc(S * S * 4);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const s = (y * S + x) * 4, d = ((S - 1 - y) * S + x) * 4; // bottom-up BGRA
    pix[d] = rgba[s + 2]; pix[d + 1] = rgba[s + 1]; pix[d + 2] = rgba[s]; pix[d + 3] = rgba[s + 3];
  }
  const mask = Buffer.alloc(Math.ceil(S / 32) * 4 * S); // AND mask unused with alpha
  return Buffer.concat([h, pix, mask]);
}

const images = SIZES.map(S => ({ S, rgba: render(S) }));
const pngs = images.map(({ S, rgba }) => ({ S, data: S >= 256 ? png(rgba, S) : dib(rgba, S) }));
const head = Buffer.alloc(6); head.writeUInt16LE(0, 0); head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
const dir = [];
let offset = 6 + 16 * pngs.length;
for (const { S, data } of pngs) {
  const e = Buffer.alloc(16);
  e[0] = S >= 256 ? 0 : S; e[1] = S >= 256 ? 0 : S;
  e.writeUInt16LE(1, 4); e.writeUInt16LE(32, 6);
  e.writeUInt32LE(data.length, 8); e.writeUInt32LE(offset, 12);
  offset += data.length;
  dir.push(e);
}
const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'icon.ico'), Buffer.concat([head, ...dir, ...pngs.map(p => p.data)]));
fs.writeFileSync(path.join(outDir, 'icon.png'), png(images[images.length - 1].rgba, 256));
console.log('wrote build/icon.ico (' + SIZES.join(', ') + ') and build/icon.png');
