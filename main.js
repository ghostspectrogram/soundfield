'use strict';
const { app, BrowserWindow, ipcMain, dialog, protocol, shell, nativeImage, Menu, clipboard, net, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const crypto = require('crypto');
const { Worker } = require('worker_threads');
const { execFile } = require('child_process');
const { probe } = require('./lib/probe');
const { writeRegionSync } = require('./lib/region');
const { extractZip, extractDest, zipListing } = require('./lib/zip');
const store = require('./lib/store');
const online = require('./lib/online');

if (process.env.SF_USERDATA) app.setPath('userData', process.env.SF_USERDATA);

// ------------------------------------------------------------------ problem log
// Errors and warnings (from here and from the window) go to logs\soundfield.log in the data
// folder, rotated at 1 MB, so Settings → About can copy a problem report.
const logFile = () => path.join(app.getPath('userData'), 'logs', 'soundfield.log');
function logLine(level, args) {
  try {
    const f = logFile();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    try { if (fs.statSync(f).size > 1 << 20) fs.renameSync(f, f + '.1'); } catch {}
    const text = args.map(a => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
    fs.appendFileSync(f, `${new Date().toISOString()} ${level} ${text.slice(0, 4000)}\n`);
  } catch {}
}
for (const level of ['error', 'warn']) {
  const orig = console[level].bind(console);
  console[level] = (...a) => { orig(...a); logLine(level.toUpperCase(), a); };
}
process.on('uncaughtException', err => console.error('uncaught', err));
process.on('unhandledRejection', err => console.error('unhandled rejection', err));
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

// Test runs (tools/test.js sets SF_TEST) answer dialogs from the test script instead of a person:
// `open` / `save` are the paths to pick (null = cancel); `box` is a queue of button indexes for
// message boxes (empty = the last button, normally Cancel / OK). Every dialog is logged.
const testDialogs = process.env.SF_TEST ? { open: null, save: null, box: [], log: [] } : null;
if (testDialogs) {
  const opts = (a, b) => (b && typeof b === 'object' ? b : a) || {};
  dialog.showOpenDialog = async (a, b) => {
    testDialogs.log.push({ kind: 'open', title: opts(a, b).title || '' });
    return testDialogs.open ? { canceled: false, filePaths: [].concat(testDialogs.open) } : { canceled: true, filePaths: [] };
  };
  dialog.showSaveDialog = async (a, b) => {
    testDialogs.log.push({ kind: 'save', title: opts(a, b).title || '' });
    return testDialogs.save ? { canceled: false, filePath: testDialogs.save } : { canceled: true };
  };
  dialog.showMessageBox = async (a, b) => {
    const o = opts(a, b);
    const response = testDialogs.box.length ? testDialogs.box.shift() : Math.max(0, (o.buttons || ['OK']).length - 1);
    testDialogs.log.push({ kind: 'box', title: o.title || '', message: o.message || '', detail: o.detail || '', buttons: o.buttons || [], response });
    return { response };
  };
  // Memory use of each Soundfield process (for the speed / memory runs).
  ipcMain.handle('test:metrics', () => app.getAppMetrics().map(m => ({ type: m.type, mb: Math.round(m.memory.workingSetSize / 1024) })));
  ipcMain.handle('test:dialogs', (e, patch) => {
    const log = testDialogs.log;
    if (patch) { Object.assign(testDialogs, patch); testDialogs.log = []; }
    return log;
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
let exportJob = null; // { cancelled, w } while a project is being zipped / materialized
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
      watchLibrary(lib);
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

// ------------------------------------------------------------------ folder watching
// Linked folders are watched, so sounds added, changed, renamed or deleted show up within a few
// seconds instead of only at the next launch. A burst of changes (an extract, a big copy) leads
// to one quick rescan; unchanged files aren't re-read. Settings → Libraries can turn it off.
const AUDIO_OR_ZIP = /\.(wav|wave|bwf|rf64|aif|aiff|aifc|flac|mp3|ogg|oga|opus|m4a|zip)$/i;
const watchers = new Map(); // lib id -> { w, timer }

function watchLibrary(lib) {
  if (watchers.has(lib.id) || prefsNow().watchFolders === false || process.env.SF_NO_SCAN) return;
  let w;
  try { w = fs.watch(lib.path, { recursive: true }); } catch { return; } // offline, or a drive that can't be watched
  const entry = { w, timer: null };
  watchers.set(lib.id, entry);
  w.on('change', (type, name) => {
    const f = String(name || '');
    // Only sound files, zips and folders matter (a folder has no extension); skip temp files and our own Credits.txt.
    if (f && /\.[a-z0-9]{1,5}$/i.test(f) && !AUDIO_OR_ZIP.test(f)) return;
    clearTimeout(entry.timer);
    entry.timer = setTimeout(() => queueScan(lib.id), 2500);
  });
  w.on('error', () => unwatchLibrary(lib.id)); // e.g. the drive was unplugged; watched again after its next scan
}
function unwatchLibrary(id) {
  const e = watchers.get(id);
  if (!e) return;
  clearTimeout(e.timer);
  try { e.w.close(); } catch {}
  watchers.delete(id);
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
  if (prefsNow().backgroundSorting === false) { analysisQueue.length = 0; return; } // turned off in Settings
  const epi = new Set(Object.values(store.downloads()).filter(d => d.source === 'epidemic').map(d => path.resolve(d.path).toLowerCase()));
  const records = store.index(id).filter(r => !epi.has(path.join(lib.path, r.rel).toLowerCase()));
  const cache = store.analysis(id);
  // Forget files that are gone.
  const live = new Set(records.map(r => r.rel));
  for (const rel of Object.keys(cache)) if (!live.has(rel)) delete cache[rel];
  // Short PCM sounds (up to a minute) whose loudness isn't known yet are measured too.
  const base = lib.path.endsWith(path.sep) ? lib.path : lib.path + path.sep;
  const full = r => base + r.rel.split('/').join(path.sep);
  const byRel = new Map(records.map(r => [r.rel, r]));
  const lm = loudStore();
  const loudTodo = records.filter(r => !r.zip && (r.codec === 'pcm' || r.codec === 'float') && r.dur <= 60 && !lm[loudKey(full(r), r.size, r.mtime)]).map(r => r.rel);
  const w = new Worker(path.join(__dirname, 'lib', 'analyze-worker.mjs'), { workerData: { root: lib.path, records, cache, loudTodo, busy: busyFlag.buffer } });
  analyzing = { id, w };
  // The cache can be several MB, so it's written every 15 s while listening (and at the end), not per batch.
  let savedAt = Date.now();
  w.on('message', m => {
    if (m.type === 'results') {
      const map = {};
      for (const [rel, v] of Object.entries(m.results)) { cache[rel] = v; if (v[2]) map[rel] = v[2]; }
      for (const [rel, v] of Object.entries(m.loudness || {})) { const r = byRel.get(rel); if (r) setLoudness(full(r), r.size, r.mtime, v); }
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

// ------------------------------------------------------------------ loudness
// Integrated loudness (LUFS) and true peak per file, measured while a waveform is built or in
// the background for short sounds. Keyed by path + size + modified time, so an edited file is
// measured again. Saved at most every 10 s.
let loudMap = null, loudTimer = null;
const loudKey = (p, size, mtime) => `${p}|${size}|${mtime}`;
function loudStore() { if (!loudMap) loudMap = store.loudness(); return loudMap; }
function setLoudness(p, size, mtime, v) {
  if (!v || v.lufs == null) return;
  const m = loudStore();
  m[loudKey(p, size, mtime)] = [v.lufs, v.tp];
  if (!loudTimer) loudTimer = setTimeout(flushLoudness, 10000);
}
function flushLoudness() {
  clearTimeout(loudTimer);
  loudTimer = null;
  if (!loudMap) return;
  const keys = Object.keys(loudMap);
  if (keys.length > 150000) for (const k of keys.slice(0, keys.length - 150000)) delete loudMap[k]; // keep the newest
  store.saveLoudness(loudMap);
}
// ------------------------------------------------------------------ your sounds
// Notes, ratings, markers and recently played (sounds.json). The window sends the whole set on
// every change; it's written at most once a second, and at quit.
let mineData = null, mineTimer = null;
function mineStore() { if (!mineData) mineData = store.mine() || { sounds: {}, recent: [] }; return mineData; }
function flushMine() { clearTimeout(mineTimer); mineTimer = null; if (mineData) store.saveMine(mineData); }

// Paused while something plays: background measuring reads files from disk.
const busyFlag = new Int32Array(new SharedArrayBuffer(4));

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
      if (m.peaks.loudness && job.file) setLoudness(job.file.path, job.file.size, job.file.mtime, m.peaks.loudness);
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
const prefsNow = () => loadSettings().prefs || {};
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

// ------------------------------------------------------------------ safety
// Anything that copies, deletes or downloads a lot says how big it is first, is refused when it
// can't fit, and asks twice above the size / file-count limits (adjustable: prefs.safety).
const GB = 1024 ** 3, MB = 1024 ** 2;
const SPACE_MARGIN = 2 * GB; // always left free on the destination drive
const SAFETY_DEFAULTS = require('./shared/safety.json');
const safety = () => ({ ...SAFETY_DEFAULTS, ...(((loadSettings().prefs || {}).safety) || {}) });

function fmtBytes(n) {
  if (!n) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return (n / Math.pow(1024, i)).toFixed(i ? 1 : 0) + ' ' + u[i];
}
const rootOf = p => path.parse(path.resolve(p)).root;
const driveName = p => { const r = rootOf(p); return /^[a-z]:\\$/i.test(r) ? `drive ${r.slice(0, 2).toUpperCase()}` : r.replace(/\\$/, ''); };

// Free bytes on the drive holding `p` (or its nearest existing parent); null if unknown.
function freeSpace(p) {
  let d = path.resolve(p);
  while (!fs.existsSync(d)) { const up = path.dirname(d); if (up === d) return null; d = up; }
  try { const s = fs.statfsSync(d); return s.bavail * s.bsize; } catch { return null; }
}

// False (after telling the person) when `bytes` won't fit at `dest` with the margin to spare.
async function ensureSpace(dest, bytes, what) {
  const free = freeSpace(dest);
  if (free == null || bytes + SPACE_MARGIN <= free) return true;
  await dialog.showMessageBox(win, {
    type: 'error', title: 'Not enough space', buttons: ['OK'],
    message: `There isn't enough free space for ${what}.`,
    detail: `It needs ${fmtBytes(bytes)}, plus ${fmtBytes(SPACE_MARGIN)} kept free for Windows, but ${driveName(dest)} has ${fmtBytes(free)} free.\n\nFree up ${fmtBytes(bytes + SPACE_MARGIN - free)} there, or choose another drive.`,
  });
  return false;
}

// A second confirmation for big jobs (above the size or file-count limit). `force` asks regardless.
async function confirmBig(bytes, files, { message, detail, ok, force = false }) {
  const s = safety();
  if (!force && bytes < s.confirmGB * GB && files < s.confirmFiles) return true;
  const r = await dialog.showMessageBox(win, { type: 'warning', buttons: [ok, 'Cancel'], defaultId: 1, cancelId: 1, title: 'Large job', message, detail });
  return r.response === 0;
}

// 'network' | 'removable' | 'fixed' | 'unknown'. Network and removable drives have no Recycle Bin.
const driveTypes = new Map();
function driveType(p) {
  const root = rootOf(p).toUpperCase();
  if (root.startsWith('\\\\')) return Promise.resolve('network');
  if (!driveTypes.has(root)) {
    driveTypes.set(root, new Promise(resolve => {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '[System.IO.DriveInfo]::new($env:SF_DRIVE).DriveType'],
        { env: { ...process.env, SF_DRIVE: root }, windowsHide: true, timeout: 8000 },
        (err, out) => { const t = String(out || '').trim().toLowerCase(); resolve(['network', 'removable', 'fixed'].includes(t) ? t : 'unknown'); });
    }));
  }
  return driveTypes.get(root);
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

// Selections dragged into a DAW pile up in the region folder. With "Keep dragged selections for"
// set (Settings → Saving & files), older ones go to the Recycle Bin (restorable, in case a DAW
// session still uses one). Only files Soundfield named itself ("name [1.20-3.45s].wav") are touched.
const REGION_FILE = /\[\d+\.\d{2}-\d+\.\d{2}s\]\.wav$/i;
function regionFiles() {
  const dir = regionDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch {}
  return names.filter(n => REGION_FILE.test(n)).map(n => { const p = path.join(dir, n); try { const s = fs.statSync(p); return { p, size: s.size, t: s.mtimeMs }; } catch { return null; } }).filter(Boolean);
}
async function cleanRegions() {
  const days = Number(prefsNow().regionKeepDays) || 0; // 0 = keep them all
  if (days <= 0) return 0;
  const old = regionFiles().filter(f => Date.now() - f.t > days * 86400e3);
  let n = 0;
  for (const f of old) { try { await shell.trashItem(f.p); n++; } catch (err) { console.warn('region cleanup', f.p, err.message); } }
  return n;
}

// Settings → Saving & files can point this elsewhere.
function regionDir() {
  const custom = prefsNow().regionDir;
  return typeof custom === 'string' && path.isAbsolute(custom) ? custom : path.join(app.getPath('documents'), 'Soundfield Regions');
}

// ------------------------------------------------------------------ IPC
function registerIpc() {
  ipcMain.handle('state:get', () => {
    const libs = libraries.map(libPublic);
    const records = {};
    for (const l of libraries) records[l.id] = store.index(l.id);
    const analysis = {};
    for (const l of libraries) analysis[l.id] = analysisForRenderer(l.id);
    return { libs, records, analysis, typeOverrides, projects: store.projects(), downloads: store.downloads(), favorites: [...favorites], mine: mineStore(), overrides, sep: path.sep, platform: process.platform };
  });

  // ---------------------------------------------------------------- projects
  // A project is a list of references to sounds; it never moves files.
  ipcMain.handle('proj:save', (e, list) => { store.saveProjects(list); return true; });

  // Zip a project into one file, or "materialize" it as a real folder of copies.
  ipcMain.handle('proj:export', async (e, req) => {
    const { mode, name, items, layout, manifest, repoint, markerList } = req;
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

    // How big it is, whether it fits, and a second "are you sure" for huge ones.
    const bytes = items.reduce((t, it) => t + (Number(it.size) || 0), 0);
    const verb = mode === 'zip' ? 'Zip' : 'Copy';
    if (!(await ensureSpace(dest, bytes, `“${name}” (${fmtBytes(bytes)})`))) return null;
    const low = dest.toLowerCase();
    const insideLib = mode === 'copy' && !repoint && libraries.find(l => { const p = path.resolve(l.path).toLowerCase(); return low.startsWith(p.endsWith(path.sep) ? p : p + path.sep); });
    if (insideLib) {
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['Copy there anyway', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Inside a library',
        message: `The new folder would be inside your library “${insideLib.name}”.`,
        detail: `Its ${items.length.toLocaleString()} copies would be indexed too and show up as duplicates of every sound in the project.\n\nChoose a folder outside your libraries, or tick “Point this project at the new copies” if you want the copies listed instead.`,
      });
      if (r.response !== 0) return null;
    }
    const free = freeSpace(dest);
    const go = await confirmBig(bytes, items.length, {
      message: `${verb} ${items.length.toLocaleString()} sounds (${fmtBytes(bytes)})?`,
      detail: `Into ${dest}\n\nThat's a large ${mode === 'zip' ? 'zip' : 'copy'}${free != null ? `; ${driveName(dest)} has ${fmtBytes(free)} free` : ''}. You can cancel while it runs.`,
      ok: mode === 'zip' ? 'Zip them' : 'Copy them',
    });
    if (!go) return null;

    let result;
    const job = exportJob = { cancelled: false, w: null };
    try {
      result = await new Promise((resolve, reject) => {
        const w = job.w = new Worker(path.join(__dirname, 'lib', 'export-worker.js'), {
          workerData: { mode, items, dest, layout: layout === 'keep' ? 'keep' : 'flat', manifest: manifest !== false, markerList: markerList !== false, projectName: name },
        });
        w.on('message', m => {
          if (m.type === 'progress') send('export:progress', { ...m, mode, name });
          else if (m.type === 'done') resolve(m);
          else if (m.type === 'error') reject(new Error(m.message));
        });
        w.on('error', reject);
        w.on('exit', code => { if (code) reject(new Error(job.cancelled ? 'cancelled' : 'Export stopped unexpectedly')); });
      }).finally(() => { if (exportJob === job) exportJob = null; send('export:progress', { finished: true }); });
    } catch (err) {
      // A cancelled or failed export leaves nothing half-made behind.
      try { fs.rmSync(dest, { recursive: true, force: true }); } catch {}
      if (job.cancelled) return { cancelled: true };
      throw err;
    }

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

  ipcMain.handle('proj:cancelExport', () => {
    if (!exportJob || !exportJob.w) return false;
    exportJob.cancelled = true;
    exportJob.w.terminate();
    return true;
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
    // Folders that hold huge numbers of non-sound files: scanning them takes very long.
    const risky = norm => {
      const trim = d => path.resolve(d).toLowerCase().replace(/[\\/]+$/, '');
      const low = trim(norm);
      const same = d => !!d && low === trim(d);
      if (trim(path.parse(norm).root) === low) return 'a whole drive';
      if (same(process.env.SystemRoot)) return 'the Windows folder';
      if (same(process.env.ProgramFiles) || same(process.env['ProgramFiles(x86)'])) return 'the Program Files folder';
      if (same(require('os').homedir())) return 'your whole user folder';
      if (same(process.env.APPDATA) || same(process.env.LOCALAPPDATA)) return 'an app-data folder';
      return '';
    };
    for (const p of r.filePaths) {
      const norm = path.resolve(p);
      if (libraries.some(l => path.resolve(l.path).toLowerCase() === norm.toLowerCase())) continue;
      const what = risky(norm);
      if (what) {
        const c = await dialog.showMessageBox(win, {
          type: 'warning', buttons: ['Link anyway', 'Skip it'], defaultId: 1, cancelId: 1, title: 'Link this folder?',
          message: `“${norm}” is ${what}.`,
          detail: 'It holds a very large number of files that aren’t sounds, so scanning it can take a long time and keep the disk busy. Linking the folders where your sounds actually live is faster.',
        });
        if (c.response !== 0) continue;
      }
      const lib = { id: crypto.randomBytes(6).toString('hex'), name: path.basename(norm) || norm, path: norm, count: 0, addedAt: Date.now() };
      libraries.push(lib);
      added.push(libPublic(lib));
      queueScan(lib.id);
    }
    saveLibs();
    return added;
  });

  ipcMain.handle('lib:remove', (e, id) => {
    unwatchLibrary(id);
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

  // Measured sound features per library ({ libId: { rel: [...] } }), for Find similar sounds.
  ipcMain.handle('analysis:features', () => {
    const out = {};
    for (const l of libraries) {
      const m = (out[l.id] = {});
      for (const [rel, v] of Object.entries(store.analysis(l.id))) if (v[3] === analysisVersion && Array.isArray(v[4]) && v[4].length) m[rel] = v[4];
    }
    return out;
  });

  ipcMain.on('mine:save', (e, data) => {
    if (!data || typeof data !== 'object' || !data.sounds || !Array.isArray(data.recent)) return;
    mineData = data;
    if (!mineTimer) mineTimer = setTimeout(flushMine, 1000);
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
    const { jobId, path: p, fmt, bucket, loud } = req;
    Atomics.store(peaksCancel, 0, jobId);
    const key = `${p}|${fmt.size}|${fmt.mtime}|${bucket}|${loud ? 'L' : ''}`;
    const hit = peakCache.get(key);
    if (hit) { peakCache.delete(key); peakCache.set(key, hit); return hit; }
    for (const [id, j] of peakJobs) if (id !== jobId) { j.resolve(null); peakJobs.delete(id); }
    return new Promise(resolve => {
      peakJobs.set(jobId, { resolve, key, sender: e.sender, file: { path: p, size: fmt.size, mtime: fmt.mtime } });
      getPeaksWorker().postMessage({ jobId, path: p, fmt, bucket, loud: loud || null });
    });
  });

  ipcMain.handle('file:reveal', (e, p) => { shell.showItemInFolder(p); return true; });
  // A materialized folder opens in Explorer; a zip is shown selected in its folder.
  ipcMain.handle('file:showExport', async (e, p, isFile) => {
    if (typeof p !== 'string' || !fs.existsSync(p)) return false;
    if (isFile) shell.showItemInFolder(p); else await shell.openPath(p);
    return true;
  });

  // Every indexed sound with its quick comparison key (format + length).
  const dupeFiles = () => {
    const files = [];
    for (const lib of libraries) {
      const base = lib.path.endsWith(path.sep) ? lib.path : lib.path + path.sep;
      for (const r of store.index(lib.id)) {
        if (r.zip) continue;
        const key = r.codec === 'decode' ? `d|${r.size}` : `p|${r.ch}|${r.sr}|${r.bits}|${r.dur}`;
        files.push({ path: base + r.rel.split('/').join(path.sep), size: r.size, key });
      }
    }
    return files;
  };
  // The most the "same audio" search could read: files sharing format + length with another one.
  ipcMain.handle('dupes:estimate', () => {
    const files = dupeFiles(), count = new Map();
    for (const f of files) count.set(f.key, (count.get(f.key) || 0) + 1);
    const cands = files.filter(f => count.get(f.key) > 1);
    return { files: cands.length, bytes: cands.reduce((t, f) => t + (f.size || 0), 0), confirmGB: safety().confirmGB };
  });
  ipcMain.handle('dupes:cancel', () => { if (!dupesWorker) return false; dupesWorker.terminate(); return true; });

  ipcMain.handle('dupes:find', () => {
    if (dupesWorker) dupesWorker.terminate();
    const files = dupeFiles();
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
    const s = safety();
    const plural = (n, w) => `${n.toLocaleString()} ${w}${n === 1 ? '' : 's'}`;
    const names = list => list.slice(0, 8).map(p => '  ' + path.basename(p)).join('\n') + (list.length > 8 ? `\n  …and ${(list.length - 8).toLocaleString()} more` : '');
    // Total size, and which files sit on drives without a Recycle Bin (network shares, USB sticks).
    let bytes = 0, next = 0;
    await Promise.all(Array.from({ length: 16 }, async () => {
      while (next < paths.length) { const p = paths[next++]; try { bytes += (await fsp.stat(p)).size; } catch {} }
    }));
    const types = new Map();
    for (const p of paths) { const r = rootOf(p).toUpperCase(); if (!types.has(r)) types.set(r, await driveType(p)); }
    const noBin = paths.filter(p => ['network', 'removable'].includes(types.get(rootOf(p).toUpperCase())));
    if (noBin.length) {
      const where = [...new Set(noBin.map(driveName))].join(', ');
      const why = `${where} ${noBin.length === paths.length ? 'is' : 'includes'} a network or removable drive. Windows has no Recycle Bin there, so these files would be deleted permanently and couldn't be restored.`;
      if (s.networkDelete === 'refuse') {
        await dialog.showMessageBox(win, { type: 'error', buttons: ['OK'], title: 'Can’t recycle these files', message: `${plural(noBin.length, 'file')} can’t go to the Recycle Bin.`, detail: `${why}\n\nSoundfield is set to refuse permanent deletes. Nothing was deleted.\n\n${names(noBin)}` });
        return [];
      }
      const r = await dialog.showMessageBox(win, {
        type: 'warning', buttons: ['Delete permanently', 'Cancel'], defaultId: 1, cancelId: 1, title: 'Permanent delete',
        message: `${plural(noBin.length, 'file')} would be deleted permanently.`, detail: `${why}\n\n${names(noBin)}`,
      });
      if (r.response !== 0) return [];
    }
    const r = await dialog.showMessageBox(win, {
      type: 'warning',
      buttons: ['Move to Recycle Bin', 'Cancel'],
      defaultId: 1,
      cancelId: 1,
      title: 'Move to Recycle Bin',
      message: `Move ${plural(paths.length, 'file')} (${fmtBytes(bytes)}) to the Recycle Bin?`,
      detail: (detail ? detail + '\n\n' : '') + names(paths),
    });
    if (r.response !== 0) return [];
    // Huge batches: the Recycle Bin has a size limit, and files that don't fit are deleted for good.
    const big = await confirmBig(bytes, paths.length, {
      message: `Really recycle ${plural(paths.length, 'file')} (${fmtBytes(bytes)})?`,
      detail: 'That’s a very large amount. The Recycle Bin has a size limit (a share of each drive), and Windows may delete files that don’t fit permanently instead of keeping them.\n\nIf you want to be able to restore them, recycle fewer at a time.',
      ok: 'Yes, recycle them',
    });
    if (!big) return [];
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

  // Resolves { dest, skipped } or null when the person cancelled / it can't fit.
  ipcMain.handle('zip:extract', async (e, p, mode, libId) => {
    const dest = extractDest(p, mode);
    const z = await zipListing(p);
    if (!z) throw new Error('This zip can’t be read');
    // Same-named files already there are kept, never overwritten.
    const skipped = z.files.filter(f => fs.existsSync(path.join(dest, ...f.name.split('/'))));
    const bytes = z.total - skipped.reduce((t, f) => t + Math.max(0, f.size), 0);
    if (!(await ensureSpace(dest, bytes, `the ${z.files.length.toLocaleString()} files in this zip (${fmtBytes(bytes)})`))) return null;
    // Contents far bigger than the zip itself can be a "zip bomb" made to fill a drive.
    const bomb = z.total > GB && z.total > z.zipSize * 20;
    const go = await confirmBig(bytes, z.files.length, {
      force: bomb,
      message: `Extract ${z.files.length.toLocaleString()} files (${fmtBytes(bytes)})?`,
      detail: (bomb ? `This ${fmtBytes(z.zipSize)} zip unpacks to ${fmtBytes(z.total)}, ${Math.round(z.total / z.zipSize)}× its own size. That's unusual for audio and can be a zip made to fill up a drive. Only continue if you trust where it came from.\n\n` : '')
        + `Into ${dest}${skipped.length ? `\n\n${skipped.length.toLocaleString()} file(s) with the same name are already there; they'll be kept, not overwritten.` : ''}`,
      ok: 'Extract',
    });
    if (!go) return null;
    await extractZip(p, mode);
    if (libId) queueScan(libId);
    return { dest, skipped: skipped.length };
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
    const old = prefsNow();
    loadSettings().prefs = prefs;
    // Settings that take effect here right away.
    if (old.backgroundSorting !== false && prefs.backgroundSorting === false) {
      analysisQueue.length = 0;
      if (analyzing) analyzing.w.terminate();
    } else if (old.backgroundSorting === false && prefs.backgroundSorting !== false) libraries.forEach(l => queueAnalysis(l.id));
    if (old.previewCacheMB !== prefs.previewCacheMB) prunePreviews(true);
    if (old.watchFolders !== false && prefs.watchFolders === false) [...watchers.keys()].forEach(unwatchLibrary);
    else if (old.watchFolders === false && prefs.watchFolders !== false) libraries.forEach(l => { if (!l.offline) watchLibrary(l); });
    if (old.regionKeepDays !== prefs.regionKeepDays) cleanRegions();
    settingsDirty = true;
    clearTimeout(settingsTimer);
    settingsTimer = setTimeout(flushSettings, 400);
  });
  ipcMain.handle('app:info', () => getAppInfo());
  ipcMain.handle('app:openDataDir', () => shell.openPath(app.getPath('userData')));
  ipcMain.on('app:log', (e, msg) => logLine('WINDOW', [String(msg)]));
  ipcMain.handle('app:pickFolder', async (e, title, current) => {
    const r = await dialog.showOpenDialog(win, { title: String(title || 'Choose a folder'), defaultPath: typeof current === 'string' && current ? current : undefined, properties: ['openDirectory', 'createDirectory'] });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  // Version, system and the most recent problems, for pasting into a bug report.
  ipcMain.handle('app:problemReport', () => {
    const i = getAppInfo();
    let lines = [];
    for (const f of [logFile() + '.1', logFile()]) { try { lines = lines.concat(fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)); } catch {} }
    const sounds = libraries.reduce((t, l) => t + (l.count || 0), 0);
    return [
      `Soundfield ${i.version}${i.builtAt ? ` (built ${i.builtAt}${i.commit ? ', ' + i.commit : ''})` : ' (from source)'}`,
      `Windows ${require('os').release()} · Electron ${i.electron} · ${libraries.length} libraries, ${sounds.toLocaleString()} sounds`,
      '',
      lines.length ? `Recent problems (${Math.min(150, lines.length)} of ${lines.length}):` : 'No problems logged.',
      ...lines.slice(-150),
    ].join('\r\n');
  });
  ipcMain.handle('loud:get', (e, p, size, mtime) => loudStore()[loudKey(p, size, mtime)] || null);
  ipcMain.on('loud:set', (e, p, size, mtime, v) => { if (typeof p === 'string') setLoudness(p, size, mtime, v); });
  ipcMain.on('app:busy', (e, on) => Atomics.store(busyFlag, 0, on ? 1 : 0));
  ipcMain.handle('regions:info', () => { const f = regionFiles(); return { dir: regionDir(), count: f.length, bytes: f.reduce((t, x) => t + x.size, 0) }; });
  ipcMain.handle('regions:open', () => { fs.mkdirSync(regionDir(), { recursive: true }); return shell.openPath(regionDir()); });
  ipcMain.handle('cache:previewSize', () => {
    try { return fs.readdirSync(previewDir()).reduce((t, f) => { try { return t + fs.statSync(path.join(previewDir(), f)).size; } catch { return t; } }, 0); } catch { return 0; }
  });
  ipcMain.handle('cache:clearPreviews', () => {
    let freed = 0;
    const busy = new Set(previewJobs.keys());
    try {
      for (const f of fs.readdirSync(previewDir())) {
        const p = path.join(previewDir(), f);
        if (busy.has(p)) continue;
        try { const s = fs.statSync(p).size; fs.unlinkSync(p); freed += s; } catch {}
      }
    } catch {}
    return freed;
  });

  ipcMain.on('drag:start', async (e, p, region) => {
    if (Array.isArray(p)) { // several selected sounds (the renderer checks the count / size limits first)
      const files = p.filter(f => typeof f === 'string' && fs.existsSync(f));
      if (files.length) { try { e.sender.startDrag({ file: files[0], files, icon: getDragIcon() }); } catch (err) { console.error('startDrag', err); } }
      return;
    }
    let file = p;
    if (region) {
      try {
        const info = probeCache.get(p) || await probeCached(p);
        if (info) {
          // A selection becomes a new WAV in Documents\Soundfield Regions: check its size first.
          const bytes = Math.max(0, Math.ceil(region.end) - Math.floor(region.start)) * info.blockAlign;
          const s = safety(), free = freeSpace(regionDir());
          if (bytes > s.dragGB * GB) { send('app:toast', `That selection would be a ${fmtBytes(bytes)} file, over the ${s.dragGB} GB drag limit. Select less, or drag the whole file.`); return; }
          if (free != null && bytes + SPACE_MARGIN > free) { send('app:toast', `Not enough free space on ${driveName(regionDir())} for a ${fmtBytes(bytes)} selection.`); return; }
          file = writeRegionSync(p, info, region.start, region.end, regionDir());
        }
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
  const capMB = Math.max(50, Number(prefsNow().previewCacheMB) || 300); // Settings → Saving & files
  let total = 0;
  list.forEach((f, i) => {
    total += f.size;
    const recent = Date.now() - f.t < 600e3; // may be playing right now
    if (!recent && (i >= 300 || total > capMB * MB)) { try { fs.unlinkSync(f.p); } catch {} }
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
    if (r.size && quality === 'original' && !(await ensureSpace(dir, r.size, `“${r.title}” (${fmtBytes(r.size)})`))) return { cancelled: true };
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
    if (prefsNow().writeCredits !== false) { // Settings → Saving & files
      const credits = path.join(root, 'Credits.txt');
      if (!fs.existsSync(credits)) fs.writeFileSync(credits, '﻿Sounds downloaded with Soundfield, with their licences.\r\nKeep this file: it is your record of where each sound came from.\r\n\r\n');
      fs.appendFileSync(credits, line);
    }

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
    setTimeout(cleanRegions, 15000);
    setInterval(cleanRegions, 6 * 3600e3);
  });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { flushSettings(); if (loudTimer) flushLoudness(); if (mineTimer) flushMine(); });
