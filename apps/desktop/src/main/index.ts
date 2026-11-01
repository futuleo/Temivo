import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { app, BrowserWindow, dialog, safeStorage, session, shell } from 'electron';

import { registerAiIpc } from './ai-ipc';
import { createAiKeyCodec } from './ai-key-protection';
import { AiProviderTransport } from './ai-provider-transport';
import { AiSettingsStore } from './ai-settings-store';
import { registerMindMapIpc } from './mind-map-ipc';
import { SqliteMindMapRepository } from './mind-map-repository';

const rendererDevUrl = process.env['ELECTRON_RENDERER_URL'];
const ownedWindows = new Set<BrowserWindow>();
let ai: ReturnType<typeof registerAiIpc> | undefined;

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
  const contents = mainWindow.webContents;
  ownedWindows.add(mainWindow);
  mainWindow.once('closed', () => {
    ownedWindows.delete(mainWindow);
    ai?.cancelOwner(contents);
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
  const dataDirectory = app.getPath('userData');
  mkdirSync(dataDirectory, { recursive: true });
  const repository = new SqliteMindMapRepository(join(dataDirectory, 'temivo.sqlite'));
  const isTrustedSender: Parameters<typeof registerMindMapIpc>[1] = (event) =>
    !event.sender.isDestroyed() &&
    event.senderFrame !== null && event.senderFrame === event.sender.mainFrame &&
    [...ownedWindows].some((window) => !window.isDestroyed() && window.webContents === event.sender);
  registerMindMapIpc(repository, isTrustedSender);
  ai = registerAiIpc({
    repository,
    settings: new AiSettingsStore(join(dataDirectory, 'ai-settings.json'), createAiKeyCodec(safeStorage, process.platform)),
    transport: new AiProviderTransport({ fetch: globalThis.fetch }),
    createId: randomUUID,
  }, isTrustedSender);
  app.once('before-quit', () => ai?.dispose());
  app.once('quit', () => {
    ai?.dispose();
    repository.close();
  });

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
}).catch((error: unknown) => {
  console.error('Unable to initialize Temivo.', error);
  dialog.showErrorBox('Unable to start Temivo', 'Local storage could not be initialized. Your maps were not reset.');
  app.exit(1);
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
