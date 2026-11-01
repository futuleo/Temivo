import { join } from 'node:path';

import { app, BrowserWindow, session, shell } from 'electron';

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];

function createMainWindow(): void {
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 640,
    minHeight: 480,
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Never open new Electron windows from content; hand http(s) links to the system browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // The renderer is a single-page app: block any attempt to navigate it away.
  mainWindow.webContents.on('will-navigate', (event) => {
    event.preventDefault();
  });

  if (rendererDevUrl && !app.isPackaged) {
    void mainWindow.loadURL(rendererDevUrl);
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
}

void app.whenReady().then(() => {
  // The app does not need camera, microphone, notifications, etc. yet.
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false);
  });

  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
