// Writes a selected time range of a PCM file to a new WAV, keeping the
// channel count, bit depth, channel mask and BWF / iXML metadata so
// multichannel layouts survive the drag into a DAW.
'use strict';
const fs = require('fs');
const path = require('path');

function readAt(fd, pos, len) {
  const b = Buffer.alloc(len);
  const n = fs.readSync(fd, b, 0, len, pos);
  return b.subarray(0, n);
}

function writeRegionSync(src, info, startFrame, endFrame, outDir) {
  if (info.codec !== 'pcm' && info.codec !== 'float') throw new Error('Region export needs PCM audio');
  startFrame = Math.max(0, Math.floor(startFrame));
  endFrame = Math.min(info.frames, Math.ceil(endFrame));
  const frames = endFrame - startFrame;
  if (frames <= 0) throw new Error('Empty region');

  const ba = info.blockAlign;
  const bytes = ba / info.ch;
  const dataLen = frames * ba;
  const extra = [];
  const fd = fs.openSync(src, 'r');
  try {
    for (const c of [info.bext, info.ixml]) {
      if (c && c.size < (1 << 20)) extra.push(readAt(fd, c.offset, 8 + c.size + (c.size & 1)));
    }
  } catch (e) { fs.closeSync(fd); throw e; }
  // Sample data is converted to WAV byte order as it's copied.
  const fix = buf => {
    if (info.be) {
      // AIFF big-endian -> WAV little-endian
      for (let p = 0; p + bytes <= buf.length; p += bytes) {
        for (let i = 0, j = bytes - 1; i < j; i++, j--) { const t = buf[p + i]; buf[p + i] = buf[p + j]; buf[p + j] = t; }
      }
    }
    if (bytes === 1 && !info.unsigned8) for (let p = 0; p < buf.length; p++) buf[p] = (buf[p] + 128) & 0xff; // AIFF signed 8 -> WAV unsigned
    return buf;
  };

  const isFloat = info.codec === 'float';
  const container = bytes * 8;
  const ext = info.ch > 2 || container > 16 || isFloat || info.mask;
  const fmt = Buffer.alloc(ext ? 40 : 16);
  fmt.writeUInt16LE(ext ? 0xfffe : (isFloat ? 3 : 1), 0);
  fmt.writeUInt16LE(info.ch, 2);
  fmt.writeUInt32LE(info.sr, 4);
  fmt.writeUInt32LE(info.sr * ba, 8);
  fmt.writeUInt16LE(ba, 12);
  fmt.writeUInt16LE(container, 14);
  if (ext) {
    fmt.writeUInt16LE(22, 16);
    fmt.writeUInt16LE(Math.min(info.bits || container, container), 18);
    fmt.writeUInt32LE(info.mask || 0, 20);
    // KSDATAFORMAT_SUBTYPE_PCM / _IEEE_FLOAT, or the AMB B-format variant
    const guid = info.ambiGuid
      ? [0, 0, 0, 0, 0x21, 0x07, 0xd3, 0x11, 0x86, 0x44, 0xc8, 0xc1, 0xca, 0x00, 0x00, 0x00]
      : [0, 0, 0, 0, 0x00, 0x00, 0x10, 0x00, 0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71];
    guid[0] = isFloat ? 3 : 1;
    Buffer.from(guid).copy(fmt, 24);
  }

  const head = (id, len) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'latin1');
    h.writeUInt32LE(len, 4);
    return h;
  };
  const fmtChunk = [head('fmt ', fmt.length), fmt];
  const pad = dataLen & 1 ? Buffer.alloc(1) : Buffer.alloc(0);
  const total = extra.reduce((s, b) => s + b.length, 0) + 8 + fmt.length + 8 + dataLen + pad.length;
  const riff = Buffer.alloc(12);
  riff.write('RIFF', 0, 'latin1');
  riff.writeUInt32LE(total + 4, 4);
  riff.write('WAVE', 8, 'latin1');

  fs.mkdirSync(outDir, { recursive: true });
  const base = path.basename(src, path.extname(src));
  const t0 = (startFrame / info.sr).toFixed(2), t1 = (endFrame / info.sr).toFixed(2);
  const out = path.join(outDir, `${base} [${t0}-${t1}s].wav`);
  // Written in 4 MB pieces, so a long selection never has to fit in memory.
  const wfd = fs.openSync(out, 'w');
  try {
    for (const b of [riff, ...extra, ...fmtChunk, head('data', dataLen)]) fs.writeSync(wfd, b);
    const step = Math.max(ba, Math.floor((4 << 20) / ba) * ba);
    for (let done = 0; done < dataLen;) {
      const piece = readAt(fd, info.dataOffset + startFrame * ba + done, Math.min(step, dataLen - done));
      if (!piece.length) break;
      fs.writeSync(wfd, fix(piece));
      done += piece.length;
    }
    if (pad.length) fs.writeSync(wfd, pad);
  } catch (e) {
    fs.closeSync(wfd);
    try { fs.unlinkSync(out); } catch {}
    throw e;
  } finally {
    fs.closeSync(fd);
  }
  fs.closeSync(wfd);
  return out;
}

module.exports = { writeRegionSync };
