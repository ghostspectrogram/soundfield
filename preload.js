'use strict';
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const EVENTS = new Set(['scan:progress', 'lib:updated', 'lib:status', 'peaks:progress', 'dupes:progress', 'analysis:update', 'trash:progress', 'export:progress', 'online:progress', 'preview:progress']);

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
  // Real path of a file dropped onto the window (sounds dragged from the list or from Explorer).
  pathForFile: file => { try { return webUtils.getPathForFile(file); } catch { return ''; } },
  setType:(paths, type) => ipcRenderer.invoke('type:set', paths, type || null),
  findDupes:() => ipcRenderer.invoke('dupes:find'),
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
  openExternal: url => ipcRenderer.invoke('open:external', url),
  exists: p => ipcRenderer.invoke('file:exists', p),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error('Unknown channel ' + channel);
    const h = (e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
