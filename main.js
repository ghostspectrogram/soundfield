'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, nativeImage, Menu, clipboard, net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { probe } = require('./lib/probe');
const { writeRegionSync } = require('./lib/region');
const { extractZip } = require('./lib/zip');
const store = require('./lib/store');
const online = require('./lib/online');

if (process.env.SF_USERDATA) app.setPath('userData', process.env.SF_USERDATA);
// Our own taskbar identity (so Windows shows the Soundfield icon, not Electron's).
if (process.platform === 'win32') app.setAppUserModelId('com.soundfield.app');
const DEBUG = !!process.env.SF_DEBUG;

// One Soundfield at a time: two copies would fight over the same library files.
// Opening it again just brings the existing window to the front.
if (!process.env.SF_SNAPSHOT && !app.requestSingleInstanceLock()) {
  app.exit(0);
} else {
  app.on('second-instance', () => {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

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
  if (scanning && scanning.id === id) { scanning.again = true; return; } // rescan once this one finishes
  if (scanQueue.includes(id)) return;
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
  const finish = () => {
    const again = scanning && scanning.again;
    const changed = !(scanning && scanning.unchanged);
    scanning = null;
    send('scan:progress', { id, phase: 'end', changed });
    if (again && libraries.includes(lib)) scanQueue.unshift(id);
    pumpScans();
  };
  w.on('message', m => {
    if (m.type === 'progress') send('scan:progress', { id, phase: m.phase, done: m.done, total: m.total });
    else if (m.type === 'offline') {
      lib.offline = true; saveLibs();
      send('lib:status', libPublic(lib));
    } else if (m.type === 'done') {
      if (!libraries.includes(lib)) return; // removed mid-scan
      lib.offline = false;
      lib.scannedAt = Date.now();
      if (m.unchanged) {
        // Same files as last time: no need to rewrite the index or resend it.
        scanning.unchanged = true;
        lib.count = m.count;
        saveLibs();
        send('lib:status', libPublic(lib));
      } else {
        lib.count = m.records.length;
        store.saveIndex(id, m.records);
        saveLibs();
        send('lib:updated', { lib: libPublic(lib), records: m.records });
      }
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
  const epi = new Set(Object.values(store.downloads()).filter(d => d.source === 'epidemic').map(d => path.resolve(d.path).toLowerCase()));
  const records = store.index(id).filter(r => !epi.has(path.join(lib.path, r.rel).toLowerCase()));
  const cache = store.analysis(id);
  // Forget files that are gone.
  const live = new Set(records.map(r => r.rel));
  for (const rel of Object.keys(cache)) if (!live.has(rel)) delete cache[rel];
  const w = new Worker(path.join(__dirname, 'lib', 'analyze-worker.mjs'), { workerData: { root: lib.path, records, cache } });
  analyzing = { id, w };
  // The cache can be several MB, so it's written every 15 s while listening (and at the end), not per batch.
  let savedAt = Date.now();
  w.on('message', m => {
    if (m.type === 'results') {
      const map = {};
      for (const [rel, v] of Object.entries(m.results)) { cache[rel] = v; if (v[2]) map[rel] = v[2]; }
      if (Object.keys(m.results).length && Date.now() - savedAt > 15000) { store.saveAnalysis(id, cache); savedAt = Date.now(); }
      send('analysis:update', { id, map, done: m.done, total: m.total });
    } else if (m.type === 'error') console.error('analysis error', m.message);
  });
  w.on('error', err => console.error('analysis worker', err));
  w.on('exit', () => {
    if (libraries.some(l => l.id === id)) store.saveAnalysis(id, cache); // not for a library removed meanwhile
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

// Files being streamed stay open between reads. A handle is only closed once no read is using
// it, so switching sounds mid-read can't break the read that's still running.
const handles = new Map(); // path -> { fh: Promise<FileHandle>, users, timer }
function closeHandle(p, h) {
  if (handles.get(p) === h) handles.delete(p);
  h.fh.then(fh => fh.close()).catch(() => {});
}
async function withHandle(p, fn) {
  let h = handles.get(p);
  if (!h) {
    h = { fh: fsp.open(p, 'r'), users: 0, timer: null };
    handles.set(p, h);
    h.fh.catch(() => { if (handles.get(p) === h) handles.delete(p); });
  }
  clearTimeout(h.timer);
  h.users++;
  try {
    return await fn(await h.fh);
  } finally {
    if (--h.users === 0) {
      h.timer = setTimeout(() => closeHandle(p, h), 4000);
      // Keep only a few idle files open.
      const idle = [...handles].filter(([, x]) => x.users === 0);
      for (const [q, x] of idle.slice(0, Math.max(0, idle.length - 3))) { clearTimeout(x.timer); closeHandle(q, x); }
    }
  }
}

// ------------------------------------------------------------------ drag
let dragIcon = null;
function getDragIcon() {
  if (!dragIcon) dragIcon = nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.png')).resize({ width: 40, height: 40, quality: 'best' });
  return dragIcon;
}

// ------------------------------------------------------------------ settings + app info
// Preferences live in settings.json in the app's data folder ({ prefs: {...} }), so they
// survive browser-storage wipes and can be backed up. Saves are batched.
let settings = null;
let settingsTimer = null, settingsDirty = false;
function loadSettings() {
  if (!settings) settings = store.settings() || { prefs: null };
  return settings;
}
function flushSettings() {
  clearTimeout(settingsTimer);
  if (!settingsDirty) return;
  settingsDirty = false;
  store.saveSettings(settings);
}

// Version, build date and commit. Packaged builds carry build-info.json, written by tools/build.js.
let appInfo = null;
function getAppInfo() {
  if (appInfo) return appInfo;
  let b = {};
  try { b = JSON.parse(fs.readFileSync(path.join(__dirname, 'build-info.json'), 'utf8')); } catch {}
  appInfo = {
    version: b.version || require('./package.json').version,
    builtAt: b.builtAt || null,
    commit: b.commit || '',
    dev: !b.builtAt,
    electron: process.versions.electron,
    dataDir: app.getPath('userData'),
  };
  return appInfo;
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
    return { libs, records, analysis, typeOverrides, projects: store.projects(), downloads: store.downloads(), favorites: [...favorites], overrides, sep: path.sep, platform: process.platform };
  });

  // ---------------------------------------------------------------- projects
  // A project is a list of references to sounds; it never moves files.
  ipcMain.handle('proj:save', (e, list) => { store.saveProjects(list); return true; });

  // Zip a project into one file, or "materialize" it as a real folder of copies.
  ipcMain.handle('proj:export', async (e, req) => {
    const { mode, name, items, layout, manifest, repoint } = req;
    const safe = (name || 'Project').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/, '') || 'Project';
    let dest;
    if (mode === 'zip') {
      const r = await dialog.showSaveDialog(win, {
        title: `Zip “${name}”`,
        defaultPath: path.join(app.getPath('documents'), safe + '.zip'),
        filters: [{ name: 'Zip archive', extensions: ['zip'] }],
      });
      if (r.canceled || !r.filePath) return null;
      dest = r.filePath;
    } else {
      const r = await dialog.showOpenDialog(win, {
        title: `Choose where to create the “${safe}” folder`,
        properties: ['openDirectory', 'createDirectory'],
      });
      if (r.canceled || !r.filePaths.length) return null;
      dest = path.join(r.filePaths[0], safe);
      for (let n = 2; fs.existsSync(dest); n++) dest = path.join(r.filePaths[0], `${safe} (${n})`);
    }
    const result = await new Promise((resolve, reject) => {
      const w = new Worker(path.join(__dirname, 'lib', 'export-worker.js'), {
        workerData: { mode, items, dest, layout: layout === 'keep' ? 'keep' : 'flat', manifest: manifest !== false, projectName: name },
      });
      w.on('message', m => {
        if (m.type === 'progress') send('export:progress', { ...m, mode, name });
        else if (m.type === 'done') resolve(m);
        else if (m.type === 'error') reject(new Error(m.message));
      });
      w.on('error', reject);
      w.on('exit', code => { if (code) reject(new Error('Export stopped unexpectedly')); });
    }).finally(() => send('export:progress', { finished: true }));

    // Optionally make the copies the project's sounds: their folder must be a library to be listed.
    if (mode === 'copy' && repoint && result.copies.length) {
      const low = dest.toLowerCase();
      const covered = libraries.some(l => { const p = path.resolve(l.path).toLowerCase(); return low === p || low.startsWith(p.endsWith(path.sep) ? p : p + path.sep); });
      if (!covered) {
        const lib = { id: crypto.randomBytes(6).toString('hex'), name: path.basename(dest), path: dest, count: 0, addedAt: Date.now() };
        libraries.push(lib);
        saveLibs();
        result.newLibrary = libPublic(lib);
      }
      for (const l of libraries) if (dest.toLowerCase().startsWith(path.resolve(l.path).toLowerCase())) queueScan(l.id);
    }

    const what = mode === 'zip' ? `Zipped ${result.count} sound${result.count === 1 ? '' : 's'}` : `Copied ${result.count} sound${result.count === 1 ? '' : 's'}`;
    const miss = result.missing.length;
    const r = await dialog.showMessageBox(win, {
      type: miss ? 'warning' : 'info',
      buttons: ['Show in Explorer', 'OK'],
      defaultId: 0,
      cancelId: 1,
      title: name,
      message: `${what} from “${name}”${mode === 'zip' ? ' into one zip' : ' into a new folder'}.`,
      detail: `${dest}` + (miss
        ? `\n\n${miss} file${miss === 1 ? ' was' : 's were'} skipped (missing or unreadable):\n` + result.missing.slice(0, 12).map(p => '  ' + p).join('\n') + (miss > 12 ? `\n  …and ${miss - 12} more` : '')
        : '') + (result.newLibrary ? `\n\nThe new folder was added as a library, and the project now points at the copies.` : ''),
    });
    if (r.response === 0) { if (mode === 'zip') shell.showItemInFolder(dest); else shell.openPath(dest); }
    return result;
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

  ipcMain.handle('file:read', (e, p, offset, length) => withHandle(p, async fh => {
    const buf = Buffer.allocUnsafeSlow(length);
    const { bytesRead } = await fh.read(buf, 0, length, offset);
    return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
  }));

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
  // A materialized folder opens in Explorer; a zip is shown selected in its folder.
  ipcMain.handle('file:showExport', async (e, p, isFile) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return false;
    if (isFile) shell.showItemInFolder(p); else await shell.openPath(p);
    return true;
  });

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
    for (const p of paths) { const h = handles.get(p); if (h && !h.users) { clearTimeout(h.timer); closeHandle(p, h); } }
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

  ipcMain.handle('zip:extract', async (e, p, mode, libId) => {
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

  // The renderer reads its preferences synchronously at startup, before anything is drawn.
  ipcMain.on('settings:getSync', e => { e.returnValue = loadSettings().prefs; });
  ipcMain.on('settings:save', (e, prefs) => {
    if (!prefs || typeof prefs !== 'object') return;
    loadSettings().prefs = prefs;
    settingsDirty = true;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(flushSettings, 400);
  });
  ipcMain.handle('app:info', () => getAppInfo());
  ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));

  ipcMain.on('drag:start', async (e, p, region) => {
    if (Array.isArray(p)) { // several selected sounds
      const files = p.filter(f => typeof f === 'string' && fs.existsSync(f));
      if (files.length) { try { e.sender.startDrag({ file: files[0], files, icon: getDragIcon() }); } catch (err) { console.error('startDrag', err); } }
      return;
    }
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

// ------------------------------------------------------------------ online search
// Secrets (Freesound key and account tokens) are encrypted with Windows' user key.
function seal(s) { return s ? (safeStorage.isEncryptionAvailable() ? 'enc:' + safeStorage.encryptString(s).toString('base64') : s) : ''; }
function unseal(s) {
  if (!s) return '';
  if (!s.startsWith('enc:')) return s;
  try { return safeStorage.decryptString(Buffer.from(s.slice(4), 'base64')); } catch { return ''; }
}

const downloadsDir = () => process.env.SF_DOWNLOADS || path.join(app.getPath('documents'), 'Soundfield Downloads');
const previewDir = () => path.join(app.getPath('userData'), 'online-cache');
const FS_CALLBACK = 'https://freesound.org/home/app_permissions/permission_granted/';

function onlineSettings() {
  const o = store.online();
  return { apiKey: unseal(o.fsKey), clientId: o.fsClientId || '', token: unseal(o.fsToken), refresh: unseal(o.fsRefresh), expires: o.fsExpires || 0, user: o.fsUser || '' };
}
function saveOnlineSettings(s) {
  store.saveOnline({ ...store.online(), fsKey: seal(s.apiKey), fsClientId: s.clientId, fsToken: seal(s.token), fsRefresh: seal(s.refresh), fsExpires: s.expires, fsUser: s.user });
}
function publicOnline(s = onlineSettings()) {
  return { hasKey: !!s.apiKey, keyHint: s.apiKey ? '••••' + s.apiKey.slice(-4) : '', clientId: s.clientId, connected: !!s.refresh, user: s.user, callback: FS_CALLBACK };
}

async function freesoundToken(grant) {
  const s = onlineSettings();
  const body = new URLSearchParams({ client_id: s.clientId, client_secret: s.apiKey, ...grant });
  const r = await net.fetch(`${online.FS_API}/oauth2/access_token/`, {
    method: 'POST', body: body.toString(),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': online.UA },
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.access_token) throw new Error(j.error_description || j.error || j.detail || `Freesound said no (HTTP ${r.status})`);
  Object.assign(s, { token: j.access_token, refresh: j.refresh_token || s.refresh, expires: Date.now() + (j.expires_in || 86000) * 1000 });
  try {
    const me = await net.fetch(`${online.FS_API}/me/`, { headers: { Authorization: `Bearer ${s.token}`, 'User-Agent': online.UA } });
    if (me.ok) s.user = (await me.json()).username || s.user;
  } catch {}
  saveOnlineSettings(s);
  return s;
}

// A valid account token for original-file downloads, refreshed when it's about to expire.
async function freesoundBearer() {
  let s = onlineSettings();
  if (!s.refresh || !s.apiKey || !s.clientId) return '';
  if (!s.token || s.expires < Date.now() + 60000) {
    try { s = await freesoundToken({ grant_type: 'refresh_token', refresh_token: s.refresh }); }
    catch (err) { console.error('freesound refresh', err.message); return ''; }
  }
  return s.token;
}

// ------------------------------------------------------------------ Epidemic Sound
// Everything goes through Epidemic's MCP server with your own Epidemic ACCOUNT key: search,
// quick previews (a low-quality MP3 link that comes with each result) and WAV saves, all covered
// by your subscription with nothing counted. Each person uses their own key. A developer key
// (Partner API) is only used for searching when no account key is set.
const keyHint = k => (k ? '••••' + k.slice(-4) : '');
function epiSettings() {
  const o = store.online();
  return { apiKey: unseal(o.epKey), accountKey: unseal(o.epAccountKey) };
}
function saveEpi(s) {
  const o = store.online();
  for (const k of ['epClientId', 'epToken', 'epRefresh', 'epExpires', 'epRefreshExpires', 'epUser']) delete o[k]; // old sign-in fields
  store.saveOnline({ ...o, epKey: seal(s.apiKey), epAccountKey: seal(s.accountKey) });
}
function publicEpi(s = epiSettings()) {
  return { hasKey: !!s.apiKey, keyHint: keyHint(s.apiKey), hasAccountKey: !!s.accountKey, accountKeyHint: keyHint(s.accountKey) };
}

// Signed file URLs, per sound and format, reused for a while within the session.
const epiUrls = new Map(); // `${id}|${fileType}` -> { url, at }
async function epiFileUrl(id, fileType) {
  const { accountKey } = epiSettings();
  if (!accountKey) throw new Error('Add your Epidemic account key to listen and save (the Epidemic button at the top).');
  const k = `${id}|${fileType}`;
  const hit = epiUrls.get(k);
  if (hit && Date.now() - hit.at < 20 * 60 * 1000) return hit.url;
  const url = await online.epidemicAssetUrl(id, fileType, accountKey);
  epiUrls.set(k, { url, at: Date.now() });
  return url;
}

// The preview cache keeps the most recent 300 files / 300 MB. Half-finished downloads left
// behind by a crash are removed too. Runs at most once a minute.
let prunedAt = 0;
function prunePreviews(force) {
  if (!force && Date.now() - prunedAt < 60000) return;
  prunedAt = Date.now();
  const dir = previewDir();
  let files;
  try { files = fs.readdirSync(dir); } catch { return; }
  const list = [];
  for (const f of files) {
    const p = path.join(dir, f);
    try {
      const st = fs.statSync(p);
      if (f.endsWith('.part')) { if (Date.now() - st.mtimeMs > 3600e3) fs.unlinkSync(p); continue; }
      list.push({ p, t: st.mtimeMs, size: st.size });
    } catch {}
  }
  list.sort((a, b) => b.t - a.t);
  let total = 0;
  list.forEach((f, i) => {
    total += f.size;
    const recent = Date.now() - f.t < 600e3; // may be playing right now
    if (!recent && (i >= 300 || total > 300 * 1024 * 1024)) { try { fs.unlinkSync(f.p); } catch {} }
  });
}

const previewFile = r => {
  const ext = (r.previewExt || 'mp3').replace(/[^a-z0-9]/gi, '').slice(0, 5) || 'mp3';
  return path.join(previewDir(), `${String(r.key).replace(/[^a-z0-9]+/gi, '-')}.${ext}`);
};
// Freesound HQ previews run at roughly 128–190 kbps; over-estimating only adds an empty range.
const previewSizeHint = r => (r.source === 'freesound' ? Math.max(64 * 1024, Math.ceil((r.duration || 0) * 24000))
  : r.previewSize > 512 * 1024 ? r.previewSize : 0); // exact size known (Internet Archive): only worth splitting when big

const previewJobs = new Map(); // file -> Promise
function fetchPreview(r) {
  const file = previewFile(r);
  if (fs.existsSync(file)) {
    fs.promises.utimes(file, new Date(), new Date()).catch(() => {}); // recently played previews are kept longest
    return Promise.resolve(file);
  }
  if (previewJobs.has(file)) return previewJobs.get(file);
  let last = 0;
  const progress = (got, total) => {
    if (Date.now() - last < 120) return;
    last = Date.now();
    send('preview:progress', { key: r.key, got, total });
  };
  const get = async () => {
    // Epidemic results from the developer key carry no preview link; one is asked for with the account key.
    const url = r.source === 'epidemic' && !r.previewUrl ? await epiFileUrl(r.id, 'MP3') : r.previewUrl;
    if (!/^https:\/\//.test(url || '')) throw new Error('No preview available');
    const hint = previewSizeHint(r);
    await (hint ? online.downloadRanges(url, file, hint, progress) : online.download(url, file, {}, progress));
    prunePreviews();
    return file;
  };
  const job = get().finally(() => previewJobs.delete(file));
  previewJobs.set(file, job);
  return job;
}

function registerOnlineIpc() {
  ipcMain.handle('online:search', async (e, req) => {
    const auth = onlineSettings();
    if ((req.sources || []).includes('epidemic')) auth.epidemic = epiSettings(); // { apiKey, accountKey }
    return online.search(req, auth);
  });

  // Previews are cached in the app's own folder (not your libraries) so the player can show them.
  // Requests for the same preview (a click while it's being pre-loaded) share one download.
  ipcMain.handle('online:preview', (e, r) => fetchPreview(r));

  // Saves a sound into the session's save folder (default: Documents\Soundfield Downloads\<Source>),
  // records where it came from in that folder's Credits.txt, and makes sure the folder is
  // part of a library so it shows up in your sounds.
  ipcMain.handle('online:download', async (e, r, saveDir) => {
    const custom = typeof saveDir === 'string' && saveDir && path.isAbsolute(saveDir) ? path.resolve(saveDir) : null;
    const root = custom || downloadsDir();
    const dir = custom || path.join(root, online.safeName(r.sourceLabel));
    const downloads = store.downloads();
    const known = downloads[r.key];
    // Already saved in this folder: nothing to do. Saved somewhere else: save another copy here.
    if (known && fs.existsSync(known.path) && path.dirname(known.path).toLowerCase() === dir.toLowerCase()) return { ...known, already: true };
    let url = r.previewUrl, ext = r.previewExt || 'mp3', headers = {}, quality = 'preview';
    if (r.source === 'epidemic') { url = await epiFileUrl(r.id, 'WAV'); quality = 'original'; ext = 'wav'; } // your subscription, via the MCP server
    else if (r.downloadUrl) { url = r.downloadUrl; quality = 'original'; ext = r.ext; } // Wikimedia Commons / Internet Archive original file
    else if (r.source === 'freesound' && r.original) {
      const bearer = await freesoundBearer();
      if (bearer) { url = `${online.FS_API}/sounds/${encodeURIComponent(r.id)}/download/`; headers = { Authorization: `Bearer ${bearer}` }; ext = r.ext || 'wav'; quality = 'original'; }
    }
    if (!/^https:\/\//.test(url || '')) throw new Error('This sound has no downloadable file');
    ext = ext === 'aiff' ? 'aif' : ext.replace(/[^a-z0-9]/gi, '').slice(0, 5);
    const base = online.safeName(r.title) + (quality === 'preview' ? ' (preview)' : '');
    const dest = online.uniquePath(dir, base, ext);
    send('online:progress', { key: r.key, got: 0, total: r.size || 0 });
    let last = 0;
    try {
      // Same file as the preview you just listened to: reuse it instead of downloading again.
      const cached = quality === 'preview' || (r.previewIsOriginal && fs.existsSync(previewFile(r)));
      if (cached) {
        const from = await fetchPreview(r);
        fs.mkdirSync(dir, { recursive: true });
        fs.copyFileSync(from, dest);
      } else {
        await online.download(url, dest, headers, (got, total) => {
          if (Date.now() - last > 150) { last = Date.now(); send('online:progress', { key: r.key, got, total: total || r.size || 0 }); }
        });
      }
    } finally { send('online:progress', { key: r.key, finished: true }); }

    const lic = online.LICENSES[r.license] || { name: r.license, credit: true };
    const entry = {
      path: dest, source: r.source, sourceLabel: r.sourceLabel, title: r.title, creator: r.creator, pageUrl: r.pageUrl,
      license: r.license, licenseLabel: lic.label || r.license, licenseUrl: r.licenseUrl || '', credit: lic.credit, quality, at: Date.now(),
    };
    downloads[r.key] = entry;
    store.saveDownloads(downloads);
    const line = `${path.relative(root, dest)}\r\n    ${online.attributionText(r)}\r\n    ${lic.credit ? 'Credit required: include the line above in your credits.' : 'No credit required (you may still credit the creator).'}\r\n\r\n`;
    const credits = path.join(root, 'Credits.txt');
    if (!fs.existsSync(credits)) fs.writeFileSync(credits, '﻿Sounds downloaded with Soundfield, with their licences.\r\nKeep this file: it is your record of where each sound came from.\r\n\r\n');
    fs.appendFileSync(credits, line);

    const low = root.toLowerCase();
    let lib = libraries.find(l => { const p = path.resolve(l.path).toLowerCase(); return low === p || low.startsWith(p.endsWith(path.sep) ? p : p + path.sep); });
    if (!lib) {
      lib = { id: crypto.randomBytes(6).toString('hex'), name: custom ? path.basename(root) || root : 'Online downloads', path: root, count: 0, addedAt: Date.now() };
      libraries.push(lib);
      saveLibs();
    }
    queueScan(lib.id);
    return entry;
  });

  ipcMain.handle('online:downloads', () => store.downloads());
  ipcMain.handle('online:defaultDir', () => downloadsDir());
  ipcMain.handle('online:pickFolder', async (e, current) => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Save Soundfield search downloads to…',
      defaultPath: typeof current === 'string' && current ? current : downloadsDir(),
      properties: ['openDirectory', 'createDirectory'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('file:exists', (e, p) => typeof p === 'string' && fs.existsSync(p));
  ipcMain.handle('online:settings', () => publicOnline());
  ipcMain.handle('online:setKey', (e, { apiKey, clientId }) => {
    const s = onlineSettings();
    if (typeof apiKey === 'string') { const k = apiKey.trim(); if (k !== s.apiKey) Object.assign(s, { apiKey: k, token: '', refresh: '', expires: 0, user: '' }); }
    if (typeof clientId === 'string') s.clientId = clientId.trim();
    saveOnlineSettings(s);
    return publicOnline(s);
  });
  // Signs in to Freesound in a small window of our own and picks the authorization code
  // out of Freesound's redirect, whatever callback URL the key was registered with.
  // Resolves the new settings, or null if the window was closed.
  let authWin = null;
  ipcMain.handle('online:connect', () => {
    const s = onlineSettings();
    if (!s.clientId || !s.apiKey) throw new Error('Enter your Freesound Client ID and API key first');
    if (authWin && !authWin.isDestroyed()) { authWin.focus(); return null; }
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, v) => { if (settled) return; settled = true; fn(v); if (authWin && !authWin.isDestroyed()) authWin.close(); };
      authWin = new BrowserWindow({
        parent: win, width: 560, height: 760, title: 'Connect Freesound', autoHideMenuBar: true,
        backgroundColor: '#ffffff', icon: path.join(__dirname, 'build', 'icon.ico'),
        webPreferences: { partition: 'persist:freesound', sandbox: true, contextIsolation: true, nodeIntegration: false },
      });
      const wc = authWin.webContents;
      const check = (e, url) => {
        let u;
        try { u = new URL(url); } catch { return; }
        const code = u.searchParams.get('code'), err = u.searchParams.get('error');
        if ((!code && !err) || u.pathname.startsWith('/apiv2/oauth2/')) return; // not the redirect yet
        if (e && e.preventDefault) e.preventDefault();
        if (err) { finish(reject, new Error(err === 'access_denied' ? 'Access was denied on Freesound' : err)); return; }
        freesoundToken({ grant_type: 'authorization_code', code }).then(() => finish(resolve, publicOnline()), er => finish(reject, er));
      };
      wc.on('will-redirect', check);
      wc.on('will-navigate', check);
      wc.on('did-navigate', check);
      wc.setWindowOpenHandler(({ url }) => { if (/^https:\/\//.test(url)) shell.openExternal(url); return { action: 'deny' }; });
      authWin.on('closed', () => { authWin = null; finish(resolve, null); });
      authWin.loadURL(`${online.FS_API}/oauth2/authorize/?client_id=${encodeURIComponent(s.clientId)}&response_type=code&state=soundfield`);
    });
  });
  ipcMain.handle('online:code', async (e, text) => {
    const m = String(text || '').match(/[?&]code=([^&\s]+)/);
    const code = m ? decodeURIComponent(m[1]) : String(text || '').trim();
    if (!code) throw new Error('Paste the code Freesound showed you');
    await freesoundToken({ grant_type: 'authorization_code', code });
    return publicOnline();
  });
  ipcMain.handle('epidemic:settings', () => publicEpi());
  // Keys are only replaced when a new one is typed; forget: 'apiKey' | 'accountKey' removes one.
  ipcMain.handle('epidemic:set', (e, { apiKey, accountKey, forget } = {}) => {
    const s = epiSettings();
    if (typeof apiKey === 'string' && apiKey.trim()) s.apiKey = apiKey.trim();
    if (typeof accountKey === 'string' && accountKey.trim() && accountKey.trim() !== s.accountKey) { s.accountKey = accountKey.trim(); epiUrls.clear(); }
    if (forget === 'apiKey') s.apiKey = '';
    if (forget === 'accountKey') { s.accountKey = ''; epiUrls.clear(); }
    saveEpi(s);
    return publicEpi(s);
  });
  // Checks the account key with Epidemic (lists the MCP tools; downloads nothing).
  ipcMain.handle('epidemic:check', async () => {
    const { accountKey } = epiSettings();
    if (!accountKey) throw new Error('No account key saved yet');
    const tools = await online.epidemicCheckKey(accountKey);
    if (!tools.includes('DownloadSoundEffect')) throw new Error('This key works, but Epidemic didn’t offer sound effect downloads for it');
    return { ok: true, tools: tools.length };
  });
  ipcMain.handle('online:disconnect', () => {
    const s = onlineSettings();
    Object.assign(s, { token: '', refresh: '', expires: 0, user: '' });
    saveOnlineSettings(s);
    return publicOnline(s);
  });
  // Only web links, opened in the default browser.
  ipcMain.handle('open:external', (e, url) => {
    if (!/^https:\/\//i.test(String(url))) return false;
    shell.openExternal(url);
    return true;
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
  registerOnlineIpc();
  createWindow();

  // Quietly pick up added / changed / removed files after the UI is up.
  win.webContents.once('did-finish-load', () => {
    if (!process.env.SF_NO_SCAN) setTimeout(() => libraries.forEach(l => queueScan(l.id)), 1500); // SF_NO_SCAN: speed tests on a copy of the index
    setTimeout(() => prunePreviews(true), 8000);
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', flushSettings);
