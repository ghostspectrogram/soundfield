// Minimal streaming ZIP writer. Entries are STORED (no compression): audio
// barely compresses and this is far faster. Uses ZIP64 records whenever a
// size, offset or entry count needs it, so multi-GB projects work.
'use strict';
const fs = require('fs');
const zlib = require('zlib');

const CHUNK = 4 << 20;
const MAX32 = 0xffffffff;

function dosTime(d) {
  const t = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2);
  const day = ((Math.max(1980, d.getFullYear()) - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { t, day };
}

// entries: [{ name, path } | { name, data: Buffer }]
// opts: { onProgress(doneEntries, totalEntries, bytes), forceZip64, shouldStop() }
function writeZip(outPath, entries, opts = {}) {
  const out = fs.openSync(outPath, 'w');
  let pos = 0;
  const write = buf => { fs.writeSync(out, buf, 0, buf.length, pos); pos += buf.length; };
  const central = [];
  const buf = Buffer.allocUnsafe(CHUNK);
  let bytesDone = 0;
  try {
    entries.forEach((e, idx) => {
      if (opts.shouldStop && opts.shouldStop()) throw new Error('Cancelled');
      const name = Buffer.from(e.name.replace(/\\/g, '/'), 'utf8');
      let size, crc = 0, mtime = new Date(), fd = null;
      if (e.data) {
        size = e.data.length;
        crc = zlib.crc32(e.data);
      } else {
        fd = fs.openSync(e.path, 'r');
        const st = fs.fstatSync(fd);
        size = st.size;
        mtime = st.mtime;
        // Pass 1: CRC (the local header needs it up front; no data descriptors keeps readers happy).
        for (let p = 0; p < size;) {
          const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - p), p);
          if (!n) break;
          crc = zlib.crc32(buf.subarray(0, n), crc);
          p += n;
        }
      }
      const offset = pos;
      const big = opts.forceZip64 || size >= MAX32 || offset >= MAX32;
      const { t, day } = dosTime(mtime);

      const localExtra = big ? Buffer.alloc(20) : Buffer.alloc(0);
      if (big) {
        localExtra.writeUInt16LE(0x0001, 0); localExtra.writeUInt16LE(16, 2);
        localExtra.writeBigUInt64LE(BigInt(size), 4); localExtra.writeBigUInt64LE(BigInt(size), 12);
      }
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(big ? 45 : 20, 4);
      lh.writeUInt16LE(0x0800, 6); // UTF-8 names
      lh.writeUInt16LE(0, 8); // stored
      lh.writeUInt16LE(t, 10); lh.writeUInt16LE(day, 12);
      lh.writeUInt32LE(crc >>> 0, 14);
      lh.writeUInt32LE(big ? MAX32 : size, 18);
      lh.writeUInt32LE(big ? MAX32 : size, 22);
      lh.writeUInt16LE(name.length, 26);
      lh.writeUInt16LE(localExtra.length, 28);
      write(lh); write(name); write(localExtra);

      // Pass 2: data.
      if (e.data) write(e.data);
      else {
        for (let p = 0; p < size;) {
          const n = fs.readSync(fd, buf, 0, Math.min(CHUNK, size - p), p);
          if (!n) break;
          fs.writeSync(out, buf, 0, n, pos);
          pos += n;
          p += n;
          bytesDone += n;
        }
        fs.closeSync(fd);
      }
      central.push({ name, crc: crc >>> 0, size, offset, t, day });
      if (opts.onProgress) opts.onProgress(idx + 1, entries.length, bytesDone);
    });

    // Central directory.
    const cdStart = pos;
    for (const c of central) {
      const needSize = opts.forceZip64 || c.size >= MAX32;
      const needOff = opts.forceZip64 || c.offset >= MAX32;
      const fields = [];
      if (needSize) fields.push(c.size, c.size);
      if (needOff) fields.push(c.offset);
      const extra = Buffer.alloc(fields.length ? 4 + 8 * fields.length : 0);
      if (fields.length) {
        extra.writeUInt16LE(0x0001, 0); extra.writeUInt16LE(8 * fields.length, 2);
        fields.forEach((v, i) => extra.writeBigUInt64LE(BigInt(v), 4 + 8 * i));
      }
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(45, 4); // made by: 4.5, MS-DOS
      ch.writeUInt16LE(fields.length ? 45 : 20, 6);
      ch.writeUInt16LE(0x0800, 8);
      ch.writeUInt16LE(0, 10);
      ch.writeUInt16LE(c.t, 12); ch.writeUInt16LE(c.day, 14);
      ch.writeUInt32LE(c.crc, 16);
      ch.writeUInt32LE(needSize ? MAX32 : c.size, 20);
      ch.writeUInt32LE(needSize ? MAX32 : c.size, 24);
      ch.writeUInt16LE(c.name.length, 28);
      ch.writeUInt16LE(extra.length, 30);
      ch.writeUInt16LE(0, 32); ch.writeUInt16LE(0, 34); ch.writeUInt16LE(0, 36);
      ch.writeUInt32LE(0, 38);
      ch.writeUInt32LE(needOff ? MAX32 : c.offset, 42);
      write(ch); write(c.name); write(extra);
    }
    const cdSize = pos - cdStart;
    const zip64 = opts.forceZip64 || central.length >= 0xffff || cdStart >= MAX32 || cdSize >= MAX32;
    if (zip64) {
      const eocd64At = pos;
      const z = Buffer.alloc(56);
      z.writeUInt32LE(0x06064b50, 0);
      z.writeBigUInt64LE(44n, 4);
      z.writeUInt16LE(45, 12); z.writeUInt16LE(45, 14);
      z.writeUInt32LE(0, 16); z.writeUInt32LE(0, 20);
      z.writeBigUInt64LE(BigInt(central.length), 24);
      z.writeBigUInt64LE(BigInt(central.length), 32);
      z.writeBigUInt64LE(BigInt(cdSize), 40);
      z.writeBigUInt64LE(BigInt(cdStart), 48);
      write(z);
      const loc = Buffer.alloc(20);
      loc.writeUInt32LE(0x07064b50, 0);
      loc.writeUInt32LE(0, 4);
      loc.writeBigUInt64LE(BigInt(eocd64At), 8);
      loc.writeUInt32LE(1, 16);
      write(loc);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(zip64 ? 0xffff : central.length, 8);
    end.writeUInt16LE(zip64 ? 0xffff : central.length, 10);
    end.writeUInt32LE(zip64 ? MAX32 : cdSize, 12);
    end.writeUInt32LE(zip64 ? MAX32 : cdStart, 16);
    write(end);
  } finally {
    fs.closeSync(out);
  }
  return pos;
}

module.exports = { writeZip };
