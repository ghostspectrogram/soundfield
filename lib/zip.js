// Reads a zip's central directory to count the audio files inside, and
// extracts archives with Windows' built-in bsdtar (fast, handles zip64).
'use strict';
const fsp = require('fs/promises');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { AUDIO_EXT } = require('./probe');

const skipEntry = name => { const base = name.split('/').pop(); return name.endsWith('/') || base.startsWith('.') || name.includes('__MACOSX/'); };

async function zipAudioCount(file) {
  const z = await readCentral(file);
  if (!z) return null;
  let audio = 0, bytes = 0;
  for (const e of z.entries) {
    if (skipEntry(e.name) || !AUDIO_EXT.has(path.extname(e.name).toLowerCase())) continue;
    audio++;
    if (e.size >= 0) bytes += e.size;
  }
  return { audio, entries: z.entries.length, bytes };
}

// What extracting would write: [{ name, size }] (folders and Mac junk left out, as tar is told to),
// their total uncompressed size, and the zip's own size.
async function zipListing(file) {
  const z = await readCentral(file);
  if (!z) return null;
  const files = z.entries.filter(e => !skipEntry(e.name));
  return { files, total: files.reduce((t, e) => t + Math.max(0, e.size), 0), zipSize: z.size };
}

// Reads the central directory: { size, entries: [{ name, size }] } (size -1 = zip64, unknown here).
async function readCentral(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const tailLen = Math.min(size, 65536 + 22);
    const tail = Buffer.alloc(tailLen);
    await fh.read(tail, 0, tailLen, size - tailLen);
    let eocd = -1;
    for (let i = tailLen - 22; i >= 0; i--) if (tail.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) return null;
    let entries = tail.readUInt16LE(eocd + 10);
    let cdSize = tail.readUInt32LE(eocd + 12);
    let cdOff = tail.readUInt32LE(eocd + 16);
    if (cdOff === 0xffffffff || entries === 0xffff) {
      const loc = eocd - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === 0x07064b50) {
        const off64 = Number(tail.readBigUInt64LE(loc + 8));
        const z = Buffer.alloc(56);
        await fh.read(z, 0, 56, off64);
        if (z.readUInt32LE(0) === 0x06064b50) {
          entries = Number(z.readBigUInt64LE(32));
          cdSize = Number(z.readBigUInt64LE(40));
          cdOff = Number(z.readBigUInt64LE(48));
        }
      }
    }
    if (cdSize > 64 << 20) return null;
    const cd = Buffer.alloc(cdSize);
    await fh.read(cd, 0, cdSize, cdOff);
    let p = 0;
    const list = [];
    for (let i = 0; i < entries && p + 46 <= cd.length; i++) {
      if (cd.readUInt32LE(p) !== 0x02014b50) break;
      let usize = cd.readUInt32LE(p + 24);
      const nl = cd.readUInt16LE(p + 28), el = cd.readUInt16LE(p + 30), cl = cd.readUInt16LE(p + 32);
      const name = cd.toString('utf8', p + 46, p + 46 + nl);
      if (usize === 0xffffffff) {
        // zip64: the real size is in the extra field (id 0x0001), first value.
        usize = -1;
        for (let x = p + 46 + nl; x + 4 <= p + 46 + nl + el;) {
          const id = cd.readUInt16LE(x), sz = cd.readUInt16LE(x + 2);
          if (id === 1 && sz >= 8) { usize = Number(cd.readBigUInt64LE(x + 4)); break; }
          x += 4 + sz;
        }
      }
      list.push({ name, size: usize });
      p += 46 + nl + el + cl;
    }
    return { size, entries: list };
  } catch {
    return null;
  } finally {
    if (fh) await fh.close().catch(() => {});
  }
}

function tarPath() {
  const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return fs.existsSync(sys) ? sys : 'tar';
}

// mode: 'here' -> zip's folder, 'folder' -> <zip folder>/<zip name>/
function extractDest(file, mode) {
  const dir = path.dirname(file);
  return mode === 'folder' ? path.join(dir, path.basename(file, path.extname(file))) : dir;
}

// Existing files are never overwritten (-k): they're kept and the zip's copy is skipped.
function extractZip(file, mode) {
  const dest = extractDest(file, mode);
  fs.mkdirSync(dest, { recursive: true });
  return new Promise((resolve, reject) => {
    const p = spawn(tarPath(), ['-xkf', file, '-C', dest, '--exclude', '__MACOSX', '--exclude', '._*'], { windowsHide: true });
    let err = '';
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve(dest) : reject(new Error(err.trim() || `tar exited with ${code}`))));
  });
}

module.exports = { zipAudioCount, zipListing, extractDest, extractZip };
