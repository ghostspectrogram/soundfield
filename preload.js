'use strict';
const { contextBridge, ipcRenderer, webUtils, webFrame } = require('electron');

const EVENTS = new Set(['scan:progress', 'lib:updated', 'lib:status', 'peaks:progress', 'dupes:progress', 'analysis:update', 'trash:progress', 'export:progress', 'online:progress', 'preview:progress', 'app:toast']);

contextBridge.exposeInMainWorld('api', {
  getState: () => ipcRenderer.invoke('state:get'),
  addLibraries: () => ipcRenderer.invoke('lib:add'),
  removeLibrary: id => ipcRenderer.invoke('lib:remove', id),
  rescan: id => ipcRenderer.invoke('lib:rescan', id),
  updateLibrary: (id, patch) => ipcRenderer.invoke('lib:update', id, patch),
  setFavorite: (p, on) => ipcRenderer.invoke('fav:set', p, on),
  setOverride: (p, id) => ipcRenderer.invoke('override:set', p, id),
  probe: p => ipcRenderer.invoke('file:probe', p),
  readRange: (p, offset, length) => ipcRenderer.invoke('file:read', p, offset, length),
  readFile: p => ipcRenderer.invoke('file:readAll', p),
  peaks: req => ipcRenderer.invoke('file:peaks', req),
  reveal: p => ipcRenderer.invoke('file:reveal', p),
  showExport: (p, isFile) => ipcRenderer.invoke('file:showExport', p, isFile),
  saveProjects: list => ipcRenderer.invoke('proj:save', list),
  exportProject: req => ipcRenderer.invoke('proj:export', req),
  cancelExport: () => ipcRenderer.invoke('proj:cancelExport'),
  // Real path of a file dropped onto the window (sounds dragged from the list or from Explorer).
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  setType:(paths, type) => ipcRenderer.invoke('type:set', paths, type || null),
  findDupes:() => ipcRenderer.invoke('dupes:find'),
  dupesEstimate: () => ipcRenderer.invoke('dupes:estimate'),
  cancelDupes: () => ipcRenderer.invoke('dupes:cancel'),
  trash: (paths, detail) => ipcRenderer.invoke('file:trash', paths, detail || ''),
  extractZip:(p, mode, libId) => ipcRenderer.invoke('zip:extract', p, mode, libId),
  menu: items => ipcRenderer.invoke('menu:popup', items),
  copyText: text => ipcRenderer.invoke('clipboard:write', text),
  startDrag:(p, region) => ipcRenderer.send('drag:start', p, region || null),
  online: {
    search: req => ipcRenderer.invoke('online:search', req),
    preview: r => ipcRenderer.invoke('online:preview', r),
    download: (r, saveDir) => ipcRenderer.invoke('online:download', r, saveDir || null),
    defaultDir: () => ipcRenderer.invoke('online:defaultDir'),
    pickFolder: current => ipcRenderer.invoke('online:pickFolder', current || null),
    downloads: () => ipcRenderer.invoke('online:downloads'),
    settings: () => ipcRenderer.invoke('online:settings'),
    setKey: s => ipcRenderer.invoke('online:setKey', s),
    connect: () => ipcRenderer.invoke('online:connect'),
    code: text => ipcRenderer.invoke('online:code', text),
    disconnect: () => ipcRenderer.invoke('online:disconnect'),
  },
  epidemic: {
    settings: () => ipcRenderer.invoke('epidemic:settings'),
    set: s => ipcRenderer.invoke('epidemic:set', s),
    check: () => ipcRenderer.invoke('epidemic:check'),
  },
  // Preferences: read once at startup (null = never saved here yet), saved in the app's data folder.
  settings: {
    load: () => ipcRenderer.sendSync('settings:getSync'),
    save: prefs => ipcRenderer.send('settings:save', prefs),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  // Only answers during test runs (tools/test.js): scripted dialog answers + a log of dialogs shown.
  testDialogs: patch => ipcRenderer.invoke('test:dialogs', patch || null),
  testMetrics: () => ipcRenderer.invoke('test:metrics'),
  openDataDir: () => ipcRenderer.invoke('app:openDataDir'),
  logProblem: msg => ipcRenderer.send('app:log', String(msg).slice(0, 4000)),
  problemReport: () => ipcRenderer.invoke('app:problemReport'),
  previewCacheSize: () => ipcRenderer.invoke('cache:previewSize'),
  regionsInfo: () => ipcRenderer.invoke('regions:info'),
  getLoudness: (p, size, mtime) => ipcRenderer.invoke('loud:get', p, size, mtime),
  saveLoudness: (p, size, mtime, v) => ipcRenderer.send('loud:set', p, size, mtime, v),
  saveMine: data => ipcRenderer.send('mine:save', data),
  soundFeatures: () => ipcRenderer.invoke('analysis:features'),
  setBusy: on => ipcRenderer.send('app:busy', !!on),
  openRegions: () => ipcRenderer.invoke('regions:open'),
  clearPreviewCache: () => ipcRenderer.invoke('cache:clearPreviews'),
  pickFolder: (title, current) => ipcRenderer.invoke('app:pickFolder', title, current || null),
  // Interface size (Settings → Look & feel): 0.8 … 1.5.
  setZoom: f => webFrame.setZoomFactor(Math.max(0.8, Math.min(1.5, Number(f) || 1))),
  openExternal: url => ipcRenderer.invoke('open:external', url),
  exists: p => ipcRenderer.invoke('file:exists', p),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error('Unknown channel ' + channel);
    const h = (e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
