import { contextBridge, ipcRenderer } from 'electron';

import { AI_CHANNELS, MIND_MAP_CHANNELS } from '../shared/desktop-api';
import type { DesktopApi } from '../shared/desktop-api';

const api: DesktopApi = {
  ai: {
    getSettings: () => ipcRenderer.invoke(AI_CHANNELS.getSettings),
    updateSettings: (update) => ipcRenderer.invoke(AI_CHANNELS.updateSettings, update),
    generate: (request) => ipcRenderer.invoke(AI_CHANNELS.generate, request),
    cancelGeneration: (mapId, sequence) => ipcRenderer.invoke(AI_CHANNELS.cancelGeneration, mapId, sequence),
  },
  maps: {
    loadLibrary: () => ipcRenderer.invoke(MIND_MAP_CHANNELS.loadLibrary),
    saveLibrary: (library, expectedRevision) => ipcRenderer.invoke(MIND_MAP_CHANNELS.saveLibrary, library, expectedRevision),
    list: () => ipcRenderer.invoke(MIND_MAP_CHANNELS.list),
    get: (id) => ipcRenderer.invoke(MIND_MAP_CHANNELS.get, id),
    save: (map) => ipcRenderer.invoke(MIND_MAP_CHANNELS.save, map),
    delete: (id) => ipcRenderer.invoke(MIND_MAP_CHANNELS.delete, id),
    getLinks: (sourceMapId) => ipcRenderer.invoke(MIND_MAP_CHANNELS.getLinks, sourceMapId),
    link: (link) => ipcRenderer.invoke(MIND_MAP_CHANNELS.link, link),
    unlink: (sourceMapId, sourceNodeId) => ipcRenderer.invoke(MIND_MAP_CHANNELS.unlink, sourceMapId, sourceNodeId),
  },
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('temivo', api);
