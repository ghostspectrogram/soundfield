'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, nativeImage, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { probe } = require('./lib/probe');
const { writeRegionSync } = require('./lib/region');
const { extractZip } = require('./lib/zip');
const store = require('./lib/store');

if (process.env.SF_USERDATA) app.setPath('userData', process.env.SF_USERDATA);
// Our own taskbar identity (so Windows shows the Soundfield icon, not Electron's).
if (process.platform === 'win32') app.setAppUserModelId('com.soundfield.app');
const DEBUG = !!process.env.SF_DEBUG;

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
};
const SERVE_ROOTS = ['renderer', 'shared'].map(d => path.join(__dirname, d) + path.sep);

let win = null;
let libraries = [];
let favorites = new Set();
let overrides = {};
let dupesWorker = null;
let typeOverrides = {};

// ------------------------------------------------------------------ window
function createWindow() {
  win = new BrowserWindow({
    width: 1560, height: 940, minWidth: 980, minHeight: 600,
    backgroundColor: '#0d0f13',
    title: 'Soundfield',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.once('ready-to-show', () => { if (!process.env.SF_SNAPSHOT) win.show(); });
  win.loadURL('app://bundle/renderer/index.html');
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12') win.webContents.toggleDevTools();
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', e => e.preventDefault());
  if (DEBUG) {
    win.webContents.on('console-message', e => console.log(`[renderer:${e.level}] ${e.message}`));
    win.webContents.on('render-process-gone', (e, d) => console.log('[renderer gone]', d.reason));
  }
  if (process.env.SF_SNAPSHOT) {
    win.webContents.once('did-finish-load', () => {
      setTimeout(async () => {
        if (process.env.SF_EVAL) {
          try { console.log('[eval]', JSON.stringify(await win.webContents.executeJavaScript(process.env.SF_EVAL))); }
          catch (err) { console.log('[eval error]', err.message); }
          await new Promise(r => setTimeout(r, Number(process.env.SF_EVAL_WAIT || 1500)));
        }
        win.webContents.invalidate();
        await new Promise(r => setTimeout(r, 300));
        const img = await win.webContents.capturePage();
        fs.writeFileSync(process.env.SF_SNAPSHOT, img.toPNG());
        app.quit();
      }, Number(process.env.SF_SNAPSHOT_DELAY || 2500));
    });
  }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ------------------------------------------------------------------ libraries
function libPublic(l) {
  return { id: l.id, name: l.name, path: l.path, count: l.count || 0, offline: !!l.offline, scannedAt: l.scannedAt || 0, fourCh: l.fourCh || 'auto' };
}

function saveLibs() { store.saveLibraries(libraries); }

const scanQueue = [];
let scanning = null;

function queueScan(id) {
  if ((scanning && scanning.id === id) || scanQueue.includes(id)) return;
  scanQueue.push(id);
  pumpScans();
}

function pumpScans() {
  if (scanning || !scanQueue.length) return;
  const id = scanQueue.shift();
  const lib = libraries.find(l => l.id === id);
  if (!lib) return pumpScans();
  scanning = { id };
  send('scan:progress', { id, phase: 'start', done: 0, total: 0 });
  const prev = store.index(id);
  const w = new Worker(path.join(__dirname, 'lib', 'scan-worker.js'), { workerData: { root: lib.path, prev } });
  const finish = () => { scanning = null; send('scan:progress', { id, phase: 'end' }); pumpScans(); };
  w.on('message', m => {
    if (m.type === 'progress') send('scan:progress', { id, phase: m.phase, done: m.done, total: m.total });
    else if (m.type === 'offline') {
      lib.offline = true; saveLibs();
      send('lib:status', libPublic(lib));
    } else if (m.type === 'done') {
      if (!libraries.includes(lib)) return; // removed mid-scan
      lib.offline = false;
      lib.count = m.records.length;
      lib.scannedAt = Date.now();
      store.saveIndex(id, m.records);
      saveLibs();
      send('lib:updated', { lib: libPublic(lib), records: m.records });
      queueAnalysis(id);
    } else if (m.type === 'error') {
      console.error('scan error', m.message);
    }
  });
  w.on('error', err => console.error('scan worker', err));
  w.on('exit', finish);
}

// ------------------------------------------------------------------ type analysis
// After a library is scanned, sounds whose names don't reveal their type are
// listened to in the background. Results are cached per file (size + mtime).
const analysisQueue = [];
let analyzing = null;

let analysisVersion = 0; // loaded from shared/categorize.mjs at startup

// Only results from the current listening rules; older ones get redone.
function analysisForRenderer(id) {
  const out = {};
  for (const [rel, v] of Object.entries(store.analysis(id))) if (v[2] && v[3] === analysisVersion) out[rel] = v[2];
  return out;
}

function queueAnalysis(id) {
  if ((analyzing && analyzing.id === id) || analysisQueue.includes(id)) return;
  analysisQueue.push(id);
  pumpAnalysis();
}

function pumpAnalysis() {
  if (analyzing || !analysisQueue.length) return;
  const id = analysisQueue.shift();
  const lib = libraries.find(l => l.id === id);
  if (!lib || lib.offline) return pumpAnalysis();
  const records = store.index(id);
  const cache = store.analysis(id);
  // Forget files that are gone.
  const live = new Set(records.map(r => r.rel));
  for (const rel of Object.keys(cache)) if (!live.has(rel)) delete cache[rel];
  const w = new Worker(path.join(__dirname, 'lib', 'analyze-worker.mjs'), { workerData: { root: lib.path, records, cache } });
  analyzing = { id, w };
  w.on('message', m => {
    if (m.type === 'results') {
      const map = {};
      for (const [rel, v] of Object.entries(m.results)) { cache[rel] = v; if (v[2]) map[rel] = v[2]; }
      if (Object.keys(m.results).length) store.saveAnalysis(id, cache);
      send('analysis:update', { id, map, done: m.done, total: m.total });
    } else if (m.type === 'error') console.error('analysis error', m.message);
  });
  w.on('error', err => console.error('analysis worker', err));
  w.on('exit', () => {
    store.saveAnalysis(id, cache);
    analyzing = null;
    send('analysis:update', { id, map: {}, done: 0, total: 0, finished: true });
    pumpAnalysis();
  });
}

// ------------------------------------------------------------------ peaks
const peaksCancel = new Int32Array(new SharedArrayBuffer(4));
const peakJobs = new Map();
const peakCache = new Map(); // key -> peaks (LRU)
let peaksWorker = null;

function getPeaksWorker() {
  if (peaksWorker) return peaksWorker;
  peaksWorker = new Worker(path.join(__dirname, 'lib', 'peaks-worker.mjs'), { workerData: { cancel: peaksCancel.buffer } });
  peaksWorker.on('message', m => {
    const job = peakJobs.get(m.jobId);
    if (!job) return;
    if (m.type === 'progress') { job.sender.send('peaks:progress', { jobId: m.jobId, peaks: m.peaks }); return; }
    peakJobs.delete(m.jobId);
    if (m.type === 'done') {
      peakCache.set(job.key, m.peaks);
      while (peakCache.size > 48) peakCache.delete(peakCache.keys().next().value);
      job.resolve(m.peaks);
    } else job.resolve(null);
  });
  peaksWorker.on('error', err => {
    console.error('peaks worker', err);
    for (const j of peakJobs.values()) j.resolve(null);
    peakJobs.clear();
    peaksWorker = null;
  });
  return peaksWorker;
}

// ------------------------------------------------------------------ file reads
const probeCache = new Map();
async function probeCached(p) {
  const info = await probe(p);
  if (info) {
    probeCache.set(p, info);
    while (probeCache.size > 64) probeCache.delete(probeCache.keys().next().value);
  }
  return info;
}

let openHandle = null; // { path, fh, timer }
async function handleFor(p) {
  if (openHandle && openHandle.path === p) {
    clearTimeout(openHandle.timer);
  } else {
    if (openHandle) openHandle.fh.close().catch(() => {});
    openHandle = { path: p, fh: await fsp.open(p, 'r') };
  }
  const h = openHandle;
  h.timer = setTimeout(() => { if (openHandle === h) { openHandle = null; h.fh.close().catch(() => {}); } }, 4000);
  return h.fh;
}

// ------------------------------------------------------------------ drag
let dragIcon = null;
function getDragIcon() {
  if (dragIcon) return dragIcon;
  const fromFile = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png'));
  if (!fromFile.isEmpty()) return (dragIcon = fromFile.resize({ width: 40, height: 40, quality: 'best' }));
  const S = 40, buf = Buffer.alloc(S * S * 4);
  const bars = [6, 12, 20, 28, 16, 24, 10, 18, 8];
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const i = (y * S + x) * 4;
    const r = 9, dx = Math.max(r - x, x - (S - 1 - r), 0), dy = Math.max(r - y, y - (S - 1 - r), 0);
    if (dx * dx + dy * dy > r * r) continue;
    let [R, G, B] = [0x2a, 0x2f, 0x3d];
    const bi = Math.floor((x - 4) / 3.6);
    if (x >= 4 && x < S - 4 && bi >= 0 && bi < bars.length && (x - 4) % 3.6 < 2.4 && Math.abs(y - S / 2) < bars[bi] / 2) [R, G, B] = [0x4f, 0xd1, 0xc5];
    buf[i] = B; buf[i + 1] = G; buf[i + 2] = R; buf[i + 3] = 235;
  }
  dragIcon = nativeImage.createFromBitmap(buf, { width: S, height: S });
  return dragIcon;
}

function regionDir() {
  return path.join(app.getPath('documents'), 'Soundfield Regions');
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  ipcMain.handle('state:get', () => {
    const libs = libraries.map(libPublic);
    const records = {};
    for (const l of libraries) records[l.id] = store.index(l.id);
    const analysis = {};
    for (const l of libraries) analysis[l.id] = analysisForRenderer(l.id);
    return { libs, records, analysis, typeOverrides, favorites: [...favorites], overrides, sep: path.sep, platform: process.platform };
  });

  ipcMain.handle('type:set', (e, paths, type) => {
    for (const p of paths) { if (type) typeOverrides[p] = type; else delete typeOverrides[p]; }
    store.saveTypeOverrides(typeOverrides);
    return true;
  });

  ipcMain.handle('lib:add', async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Link sound library folders (files stay where they are)',
      properties: ['openDirectory', 'multiSelections'],
    });
    if (r.canceled) return [];
    const added = [];
    for (const p of r.filePaths) {
      const norm = path.resolve(p);
      if (libraries.some(l => path.resolve(l.path).toLowerCase() === norm.toLowerCase())) continue;
      const lib = { id: crypto.randomBytes(6).toString('hex'), name: path.basename(norm) || norm, path: norm, count: 0, addedAt: Date.now() };
      libraries.push(lib);
      added.push(libPublic(lib));
      queueScan(lib.id);
    }
    saveLibs();
    return added;
  });

  ipcMain.handle('lib:remove', (e, id) => {
    libraries = libraries.filter(l => l.id !== id);
    const i = scanQueue.indexOf(id);
    if (i >= 0) scanQueue.splice(i, 1);
    const a = analysisQueue.indexOf(id);
    if (a >= 0) analysisQueue.splice(a, 1);
    if (analyzing && analyzing.id === id) analyzing.w.terminate();
    store.dropIndex(id);
    saveLibs();
    return true;
  });

  ipcMain.handle('lib:rescan', (e, id) => { queueScan(id); return true; });

  ipcMain.handle('lib:update', (e, id, patch) => {
    const lib = libraries.find(l => l.id === id);
    if (!lib) return null;
    if (typeof patch.name === 'string' && patch.name.trim()) lib.name = patch.name.trim();
    if (['auto', 'quad', 'ambix', 'fuma'].includes(patch.fourCh)) lib.fourCh = patch.fourCh;
    saveLibs();
    return libPublic(lib);
  });

  ipcMain.handle('fav:set', (e, p, on) => {
    if (on) favorites.add(p); else favorites.delete(p);
    store.saveFavorites([...favorites]);
    return on;
  });

  ipcMain.handle('override:set', (e, p, layoutId) => {
    if (layoutId) overrides[p] = layoutId; else delete overrides[p];
    store.saveOverrides(overrides);
    return true;
  });

  ipcMain.handle('file:probe', (e, p) => probeCached(p));

  ipcMain.handle('file:read', async (e, p, offset, length) => {
    const fh = await handleFor(p);
    const buf = Buffer.allocUnsafeSlow(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  });

  ipcMain.handle('file:readAll', (e, p) => fsp.readFile(p));

  ipcMain.handle('file:peaks', (e, req) => {
    const { jobId, path: p, fmt, bucket } = req;
    Atomics.store(peaksCancel, 0, jobId);
    const key = `${p}|${fmt.size}|${fmt.mtime}|${bucket}`;
    const hit = peakCache.get(key);
    if (hit) { peakCache.delete(key); peakCache.set(key, hit); return hit; }
    for (const [id, j] of peakJobs) if (id !== jobId) { j.resolve(null); peakJobs.delete(id); }
    return new Promise(resolve => {
      peakJobs.set(jobId, { resolve, key, sender: e.sender });
      getPeaksWorker().postMessage({ jobId, path: p, fmt, bucket });
    });
  });

  ipcMain.handle('file:reveal', (e, p) => { shell.showItemInFolder(p); return true; });

  ipcMain.handle('dupes:find', () => {
    if (dupesWorker) dupesWorker.terminate();
    const files = [];
    for (const lib of libraries) {
      const base = lib.path.endsWith(path.sep) ? lib.path : lib.path + path.sep;
      for (const r of store.index(lib.id)) {
        if (r.zip) continue;
        const key = r.codec === 'decode' ? `d|${r.size}` : `p|${r.ch}|${r.sr}|${r.bits}|${r.dur}`;
        files.push({ path: base + r.rel.split('/').join(path.sep), size: r.size, key });
      }
    }
    return new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'lib', 'dupes-worker.js'), { workerData: { files } });
      dupesWorker = w;
      w.on('message', m => {
        if (m.type === 'progress') send('dupes:progress', m);
        else if (m.type === 'done') resolve(m.groups);
        else if (m.type === 'error') reject(new Error(m.message));
      });
      w.on('error', reject);
      w.on('exit', () => { if (dupesWorker === w) dupesWorker = null; resolve(null); });
    });
  });

  // Moves files to the Recycle Bin after the user confirms. Returns the paths that were recycled.
  ipcMain.handle('file:trash', async (e, paths, detail) => {
    if (!paths.length) return [];
    const names = paths.slice(0, 8).map(p => '  ' + path.basename(p)).join('\n') + (paths.length > 8 ? `\n  …and ${paths.length - 8} more` : '');
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Move to Recycle Bin', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Move to Recycle Bin',
      message: `Move ${paths.length} file${paths.length === 1 ? '' : 's'} to the Recycle Bin?`,
      detail: (detail ? detail + '\n\n' : '') + names,
    });
    if (r.response !== 0) return [];
    const done = [];
    let last = 0;
    for (let i = 0; i < paths.length; i++) {
      const p = paths[i];
      try { await shell.trashItem(p); done.push(p); } catch (err) { console.error('trash failed', p, err); }
      if (paths.length > 5 && Date.now() - last > 200) {
        last = Date.now();
        send('trash:progress', { done: i + 1, total: paths.length });
      }
    }
    if (paths.length > 5) send('trash:progress', { done: paths.length, total: paths.length, finished: true });
    // Drop recycled files from the indexes right away.
    const gone = new Set(done);
    for (const lib of libraries) {
      const base = lib.path.endsWith(path.sep) ? lib.path : lib.path + path.sep;
      const recs = store.index(lib.id);
      const kept = recs.filter(r => !gone.has(base + r.rel.split('/').join(path.sep)));
      if (kept.length !== recs.length) {
        store.saveIndex(lib.id, kept);
        lib.count = kept.length;
        saveLibs();
        send('lib:updated', { lib: libPublic(lib), records: kept });
      }
    }
    return done;
  });

  ipcMain.handle('zip:extract',async (e, p, mode, libId) => {
    const dest = await extractZip(p, mode);
    if (libId) queueScan(libId);
    return dest;
  });

  // Native context menu: items = [{ id, label } | { type: 'separator' }]; resolves the clicked id or null.
  ipcMain.handle('menu:popup', (e, items) => new Promise(resolve => {
    let picked = null;
    const build = list => list.map(it => it.type === 'separator'
      ? { type: 'separator' }
      : it.submenu
        ? { label: it.label, submenu: build(it.submenu) }
        : { label: it.label, enabled: it.enabled !== false, click: () => { picked = it.id; } });
    const menu = Menu.buildFromTemplate(build(items));
    menu.popup({ window: win, callback: () => setTimeout(() => resolve(picked), 0) });
  }));

  ipcMain.handle('clipboard:write', (e, text) => { clipboard.writeText(String(text)); return true; });

  ipcMain.on('drag:start', async (e, p, region) => {
    let file = p;
    if (region) {
      try {
        const info = probeCache.get(p) || await probeCached(p);
        if (info) file = writeRegionSync(p, info, region.start, region.end, regionDir());
      } catch (err) {
        console.error('region export failed', err);
      }
    }
    try { e.sender.startDrag({ file, icon: getDragIcon() }); } catch (err) { console.error('startDrag', err); }
  });
}

// ------------------------------------------------------------------ boot
app.whenReady().then(async () => {
  ({ ANALYSIS_VERSION: analysisVersion } = await import(require('url').pathToFileURL(path.join(__dirname, 'shared', 'categorize.mjs')).href));
  Menu.setApplicationMenu(null);
  store.init(app.getPath('userData'));
  libraries = store.libraries();
  favorites = new Set(store.favorites());
  overrides = store.overrides();
  typeOverrides = store.typeOverrides();

  protocol.handle('app', async req => {
    const url = new URL(req.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    const full = path.normalize(path.join(__dirname, rel));
    if (!SERVE_ROOTS.some(r => full.startsWith(r))) return new Response('Not found', { status: 404 });
    try {
      const data = await fsp.readFile(full);
      return new Response(data, { headers: { 'content-type': MIME[path.extname(full).toLowerCase()] || 'application/octet-stream' } });
    } catch {
      return new Response('Not found', { status: 404 });
    }
  });

  registerIpc();
  createWindow();

  // Quietly pick up added / changed / removed files after the UI is up.
  win.webContents.once('did-finish-load', () => {
    setTimeout(() => libraries.forEach(l => queueScan(l.id)), 1500);
  });
});

app.on('window-all-closed', () => app.quit());
