'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set(['scan:progress', 'lib:updated', 'lib:status', 'peaks:progress', 'dupes:progress', 'analysis:update', 'trash:progress']);

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
  setType: (paths, type) => ipcRenderer.invoke('type:set', paths, type || null),
  findDupes:() => ipcRenderer.invoke('dupes:find'),
  trash: (paths, detail) => ipcRenderer.invoke('file:trash', paths, detail || ''),
  extractZip:(p, mode, libId) => ipcRenderer.invoke('zip:extract', p, mode, libId),
  menu: items => ipcRenderer.invoke('menu:popup', items),
  copyText: text => ipcRenderer.invoke('clipboard:write', text),
  startDrag:(p, region) => ipcRenderer.send('drag:start', p, region || null),
  on: (channel, cb) => {
    if (!EVENTS.has(channel)) throw new Error('Unknown channel ' + channel);
    const h = (e, payload) => cb(payload);
    ipcRenderer.on(channel, h);
    return () => ipcRenderer.removeListener(channel, h);
  },
});
