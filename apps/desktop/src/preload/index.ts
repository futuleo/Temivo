import { contextBridge } from 'electron';

import type { DesktopApi } from '../shared/desktop-api';

const api: DesktopApi = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
  },
};

contextBridge.exposeInMainWorld('temivo', api);
