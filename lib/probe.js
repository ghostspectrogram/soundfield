// Fast audio header probing. Reads only chunk headers and small metadata
// chunks; never the audio payload.
'use strict';
const fsp = require('fs/promises');
const path = require('path');

const AUDIO_EXT = new Set([
  '.wav', '.wave', '.bwf', '.rf64',
  '.aif', '.aiff', '.aifc',
  '.flac', '.mp3', '.ogg', '.oga', '.opus', '.m4a',
]);

function isAudioFile(name) {
  if (name.startsWith('.')) return false; // ._AppleDouble junk, hidden files
  return AUDIO_EXT.has(path.extname(name).toLowerCase());
}

async function rd(fh, pos, len) {
  const buf = Buffer.alloc(len);
  const { bytesRead } = await fh.read(buf, 0, len, pos);
  return bytesRead === len ? buf : buf.subarray(0, bytesRead);
}

function cstr(buf, start, len) {
  const end = Math.min(buf.length, start + len);
  let s = buf.toString('latin1', start, end);
  const z = s.indexOf('\0');
  if (z >= 0) s = s.slice(0, z);
  return s.trim();
}

function utf8(buf) {
  let s = buf.toString('utf8');
  const z = s.indexOf('\0');
  if (z >= 0) s = s.slice(0, z);
  return s.trim();
}

function xmlText(xml, tag) {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'i'));
  return m ? decodeXml(m[1].trim()) : '';
}

function decodeXml(s) {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

function parseIxml(xml, info) {
  const names = [];
  const re = /<TRACK>([\s\S]*?)<\/TRACK>/gi;
  let m;
  while ((m = re.exec(xml))) {
    const idx = parseInt(xmlText(m[1], 'CHANNEL_INDEX'), 10);
    const name = xmlText(m[1], 'NAME');
    if (idx >= 1 && idx <= 64 && name) names[idx - 1] = name;
  }
  if (names.length) info.trackNames = Array.from(names, n => n || '');
  if (!info.desc) info.desc = xmlText(xml, 'NOTE') || xmlText(xml, 'BWF_DESCRIPTION');
}

// ---------------------------------------------------------------- WAV / RF64
async function probeWav(fh, size, info) {
  const hdr = await rd(fh, 0, 12);
  if (hdr.length < 12 || hdr.toString('latin1', 8, 12) !== 'WAVE') return null;
  let pos = 12;
  let ds64 = null;
  let haveFmt = false;
  for (let guard = 0; pos + 8 <= size && guard < 4096; guard++) {
    const h = await rd(fh, pos, 8);
    if (h.length < 8) break;
    const id = h.toString('latin1', 0, 4);
    let sz = h.readUInt32LE(4);
    const body = pos + 8;
    if (id === 'ds64') {
      const b = await rd(fh, body, Math.min(sz, 28));
      if (b.length >= 16) ds64 = Number(b.readBigUInt64LE(8));
    } else if (id === 'fmt ') {
      const b = await rd(fh, body, Math.min(sz, 64));
      if (b.length < 16) return null;
      const tag = b.readUInt16LE(0);
      info.ch = b.readUInt16LE(2);
      info.sr = b.readUInt32LE(4);
      info.blockAlign = b.readUInt16LE(12);
      info.bits = b.readUInt16LE(14);
      let sub = tag;
      if (tag === 0xfffe && b.length >= 40) {
        const valid = b.readUInt16LE(18);
        if (valid) info.bits = valid;
        info.mask = b.readUInt32LE(20);
        sub = b.readUInt16LE(24);
        if (b.readUInt16LE(28) === 0x0721) info.ambiGuid = true; // AMB B-format (FuMa)
      }
      info.codec = sub === 1 ? 'pcm' : sub === 3 ? 'float' : 'decode';
      info.unsigned8 = info.blockAlign / Math.max(1, info.ch) === 1;
      haveFmt = true;
    } else if (id === 'data') {
      info.dataOffset = body;
      let ds = sz;
      if (sz === 0xffffffff && ds64 != null) ds = ds64;
      if (ds === 0 || body + ds > size) ds = size - body; // unfinalized / truncated recording
      info.dataSize = ds;
      sz = ds;
    } else if (id === 'bext') {
      const b = await rd(fh, body, Math.min(sz, 602));
      const d = cstr(b, 0, 256);
      if (d) info.desc = d;
      info.bext = { offset: pos, size: sz };
    } else if (id === 'iXML') {
      if (sz < (1 << 20)) {
        parseIxml(utf8(await rd(fh, body, sz)), info);
        info.ixml = { offset: pos, size: sz };
      }
    } else if (id === 'LIST') {
      const b = await rd(fh, body, Math.min(sz, 65536));
      if (b.toString('latin1', 0, 4) === 'INFO') {
        let p = 4;
        while (p + 8 <= b.length) {
          const sid = b.toString('latin1', p, p + 4);
          const ssz = b.readUInt32LE(p + 4);
          const v = cstr(b, p + 8, ssz);
          if (v && !info.desc && (sid === 'ICMT' || sid === 'ISBJ')) info.desc = v;
          if (v && sid === 'INAM') info.title = v;
          p += 8 + ssz + (ssz & 1);
        }
      }
    }
    pos = body + sz + (sz & 1);
  }
  if (!haveFmt || info.dataOffset == null || !info.ch || !info.sr) return null;
  if (!info.desc && info.title) info.desc = info.title;
  info.frames = info.blockAlign ? Math.floor(info.dataSize / info.blockAlign) : 0;
  return info;
}

// ---------------------------------------------------------------- AIFF / AIFC
function ext80(b, o) {
  const exp = b.readUInt16BE(o) & 0x7fff;
  const hi = b.readUInt32BE(o + 2);
  const lo = b.readUInt32BE(o + 6);
  if (!exp && !hi && !lo) return 0;
  return (hi * 4294967296 + lo) * Math.pow(2, exp - 16383 - 63);
}

async function probeAiff(fh, size, info) {
  const hdr = await rd(fh, 0, 12);
  const form = hdr.toString('latin1', 8, 12);
  if (form !== 'AIFF' && form !== 'AIFC') return null;
  let pos = 12, haveComm = false, frames = 0;
  for (let guard = 0; pos + 8 <= size && guard < 4096; guard++) {
    const h = await rd(fh, pos, 8);
    if (h.length < 8) break;
    const id = h.toString('latin1', 0, 4);
    const sz = h.readUInt32BE(4);
    const body = pos + 8;
    if (id === 'COMM') {
      const b = await rd(fh, body, Math.min(sz, 64));
      info.ch = b.readInt16BE(0);
      frames = b.readUInt32BE(2);
      info.bits = b.readInt16BE(6);
      info.sr = Math.round(ext80(b, 8));
      let comp = 'NONE';
      if (form === 'AIFC' && b.length >= 22) comp = b.toString('latin1', 18, 22);
      const bytes = Math.ceil(info.bits / 8);
      info.be = true;
      info.codec = 'pcm';
      switch (comp) {
        case 'NONE': case 'twos': break;
        case 'sowt': info.be = false; break;
        case 'fl32': case 'FL32': info.codec = 'float'; info.bits = 32; break;
        case 'fl64': case 'FL64': info.codec = 'float'; info.bits = 64; break;
        case 'in24': info.bits = 24; break;
        case 'in32': info.bits = 32; break;
        default: info.codec = 'decode';
      }
      info.blockAlign = info.ch * (info.codec === 'float' ? info.bits / 8 : Math.ceil(info.bits / 8) || bytes);
      haveComm = true;
    } else if (id === 'SSND') {
      const b = await rd(fh, body, 8);
      const off = b.readUInt32BE(0);
      info.dataOffset = body + 8 + off;
      info.dataSize = Math.min(sz - 8 - off, size - info.dataOffset);
    } else if (id === 'NAME' || id === 'ANNO' || id === 'COMT') {
      const b = await rd(fh, body, Math.min(sz, 1024));
      const v = id === 'COMT' ? '' : cstr(b, 0, b.length);
      if (v && !info.desc) info.desc = v;
    }
    pos = body + sz + (sz & 1);
  }
  if (!haveComm || info.dataOffset == null) return null;
  info.frames = Math.min(frames, Math.floor(info.dataSize / info.blockAlign));
  return info;
}

// ---------------------------------------------------------------- FLAC
function id3Size(b) {
  if (b.length >= 10 && b.toString('latin1', 0, 3) === 'ID3') {
    const s = ((b[6] & 0x7f) << 21) | ((b[7] & 0x7f) << 14) | ((b[8] & 0x7f) << 7) | (b[9] & 0x7f);
    return 10 + s + ((b[5] & 0x10) ? 10 : 0);
  }
  return 0;
}

async function probeFlac(fh, size, info) {
  let pos = id3Size(await rd(fh, 0, 10));
  if ((await rd(fh, pos, 4)).toString('latin1') !== 'fLaC') return null;
  pos += 4;
  let last = false;
  for (let guard = 0; !last && pos + 4 <= size && guard < 128; guard++) {
    const h = await rd(fh, pos, 4);
    last = (h[0] & 0x80) !== 0;
    const type = h[0] & 0x7f;
    const len = (h[1] << 16) | (h[2] << 8) | h[3];
    const body = pos + 4;
    if (type === 0) {
      const b = await rd(fh, body, 34);
      info.sr = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
      info.ch = ((b[12] >> 1) & 7) + 1;
      info.bits = (((b[12] & 1) << 4) | (b[13] >> 4)) + 1;
      info.frames = (b[13] & 0x0f) * 4294967296 + b.readUInt32BE(14);
    } else if (type === 4 && len < (1 << 20)) {
      const b = await rd(fh, body, len);
      let p = 0;
      const vlen = b.readUInt32LE(p); p += 4 + vlen;
      const count = b.readUInt32LE(p); p += 4;
      for (let i = 0; i < count && p + 4 <= b.length; i++) {
        const l = b.readUInt32LE(p); p += 4;
        const kv = b.toString('utf8', p, p + l); p += l;
        const eq = kv.indexOf('=');
        const k = kv.slice(0, eq).toUpperCase(), v = kv.slice(eq + 1).trim();
        if (!v) continue;
        if (k === 'DESCRIPTION' || k === 'COMMENT') info.desc = info.desc || v;
        else if (k === 'TITLE') info.title = v;
      }
    }
    pos = body + len;
  }
  if (!info.sr) return null;
  if (!info.desc && info.title) info.desc = info.title;
  info.codec = 'decode';
  return info;
}

// ---------------------------------------------------------------- MP3
const BR = {
  '3-3': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '3-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '3-1': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  'x-3': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  'x-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
};
const SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };

async function probeMp3(fh, size, info) {
  const start = id3Size(await rd(fh, 0, 10));
  const b = await rd(fh, start, 65536);
  for (let i = 0; i + 4 < b.length; i++) {
    if (b[i] !== 0xff || (b[i + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[i + 1] >> 3) & 3, layer = (b[i + 1] >> 1) & 3;
    const bri = b[i + 2] >> 4, sri = (b[i + 2] >> 2) & 3;
    if (ver === 1 || layer === 0 || bri === 0 || bri === 15 || sri === 3) continue;
    const table = ver === 3 ? BR[`3-${layer}`] : BR[layer === 3 ? 'x-3' : 'x-2'];
    const kbps = table[bri];
    info.sr = SR[ver][sri];
    const mono = (b[i + 3] >> 6) === 3;
    info.ch = mono ? 1 : 2;
    const spf = layer === 3 ? 384 : layer === 2 ? 1152 : ver === 3 ? 1152 : 576;
    const xo = i + 4 + (ver === 3 ? (mono ? 17 : 32) : (mono ? 9 : 17));
    let frames = 0;
    const tag = b.toString('latin1', xo, xo + 4);
    if ((tag === 'Xing' || tag === 'Info') && (b.readUInt32BE(xo + 4) & 1)) frames = b.readUInt32BE(xo + 8);
    else if (b.toString('latin1', i + 36, i + 40) === 'VBRI') frames = b.readUInt32BE(i + 36 + 14);
    info.dur = frames ? frames * spf / info.sr : ((size - start - i) * 8) / (kbps * 1000);
    info.frames = Math.round(info.dur * info.sr);
    info.bits = 0;
    info.codec = 'decode';
    return info;
  }
  return null;
}

// ---------------------------------------------------------------- OGG
async function probeOgg(fh, size, info) {
  const b = await rd(fh, 0, 512);
  if (b.toString('latin1', 0, 4) !== 'OggS') return null;
  const p = 27 + b[26];
  let rate;
  let preskip = 0;
  if (b.toString('latin1', p + 1, p + 7) === 'vorbis') {
    info.ch = b[p + 11];
    info.sr = rate = b.readUInt32LE(p + 12);
  } else if (b.toString('latin1', p, p + 8) === 'OpusHead') {
    info.ch = b[p + 9];
    preskip = b.readUInt16LE(p + 10);
    info.sr = 48000;
    rate = 48000;
  } else return null;
  const tailLen = Math.min(size, 65536);
  const t = await rd(fh, size - tailLen, tailLen);
  const at = t.lastIndexOf('OggS');
  if (at >= 0 && at + 14 <= t.length) {
    const g = Number(t.readBigInt64LE(at + 6));
    if (g > 0) info.frames = Math.max(0, g - preskip);
  }
  info.dur = info.frames ? info.frames / rate : 0;
  info.bits = 0;
  info.codec = 'decode';
  return info;
}

// ---------------------------------------------------------------- M4A
async function probeM4a(fh, size, info) {
  let pos = 0, moov = null;
  for (let guard = 0; pos + 8 <= size && guard < 256; guard++) {
    const h = await rd(fh, pos, 16);
    let sz = h.readUInt32BE(0);
    const type = h.toString('latin1', 4, 8);
    let hl = 8;
    if (sz === 1) { sz = Number(h.readBigUInt64BE(8)); hl = 16; } else if (sz === 0) sz = size - pos;
    if (sz < 8) break;
    if (type === 'moov') { if (sz < (16 << 20)) moov = await rd(fh, pos + hl, sz - hl); break; }
    pos += sz;
  }
  if (!moov) return null;
  const find = (buf, path) => {
    let cur = buf;
    for (const want of path) {
      let p = 0, next = null;
      while (p + 8 <= cur.length) {
        const s = cur.readUInt32BE(p), t = cur.toString('latin1', p + 4, p + 8);
        if (s < 8) break;
        if (t === want) { next = cur.subarray(p + 8, p + s); break; }
        p += s;
      }
      if (!next) return null;
      cur = next;
    }
    return cur;
  };
  const mvhd = find(moov, ['mvhd']);
  if (mvhd) {
    const v1 = mvhd[0] === 1;
    const ts = v1 ? mvhd.readUInt32BE(20) : mvhd.readUInt32BE(12);
    const d = v1 ? Number(mvhd.readBigUInt64BE(24)) : mvhd.readUInt32BE(16);
    if (ts) info.dur = d / ts;
  }
  const stsd = find(moov, ['trak', 'mdia', 'minf', 'stbl', 'stsd']);
  if (stsd && stsd.length >= 8 + 36) {
    const e = stsd.subarray(8);
    info.ch = e.readUInt16BE(24);
    info.sr = e.readUInt32BE(32) >>> 16;
  }
  if (!info.sr) info.sr = 48000;
  if (!info.ch) info.ch = 2;
  info.frames = Math.round((info.dur || 0) * info.sr);
  info.bits = 0;
  info.codec = 'decode';
  return info;
}

async function probe(filePath) {
  let fh;
  try {
    fh = await fsp.open(filePath, 'r');
    const st = await fh.stat();
    const size = st.size;
    if (size < 32) return null;
    const head = await rd(fh, 0, 12);
    const magic = head.toString('latin1', 0, 4);
    const info = { size, mtime: Math.round(st.mtimeMs), ch: 0, sr: 0, bits: 0, frames: 0, mask: 0, desc: '' };
    let r = null;
    if (magic === 'RIFF' || magic === 'RF64' || magic === 'BW64') r = await probeWav(fh, size, info);
    else if (magic === 'FORM') r = await probeAiff(fh, size, info);
    else if (magic === 'fLaC' || (magic.startsWith('ID3') && path.extname(filePath).toLowerCase() === '.flac')) r = await probeFlac(fh, size, info);
    else if (magic === 'OggS') r = await probeOgg(fh, size, info);
    else if (head.toString('latin1', 4, 8) === 'ftyp') r = await probeM4a(fh, size, info);
    else if (magic.startsWith('ID3') || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0)) r = await probeMp3(fh, size, info);
    if (!r || !r.ch || !r.sr) return null;
    if (!r.dur) r.dur = r.frames / r.sr;
    if (r.desc && r.desc.length > 1000) r.desc = r.desc.slice(0, 1000);
    return r;
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

module.exports = { probe, isAudioFile, AUDIO_EXT };
