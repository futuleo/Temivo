import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { beginGeneration, createMapLibrary, createTopicMap } from '@temivo/core';

import { AI_CHANNELS, MIND_MAP_CHANNELS } from '../shared/desktop-api';

const startup = vi.hoisted(() => ({
  app: {
    whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getPath: vi.fn().mockReturnValue('/tmp/temivo-startup-test'),
    once: vi.fn(),
    on: vi.fn(),
    exit: vi.fn(),
    quit: vi.fn(),
    isPackaged: true,
  },
  showErrorBox: vi.fn(),
  openStorage: vi.fn(),
  closeStorage: vi.fn(),
  createWindow: vi.fn(),
  createSettings: vi.fn(),
  getSettings: vi.fn().mockResolvedValue({ config: null, hasKey: false }),
  updateSettings: vi.fn().mockResolvedValue({ config: null, hasKey: false }),
  readForRequest: vi.fn().mockResolvedValue({
    config: { provider: 'anthropic', endpoint: 'https://provider.invalid/v1', model: 'chosen-model' },
    key: 'synthetic-nonworking-startup-key',
  }),
  request: vi.fn<(...args: unknown[]) => Promise<unknown>>().mockResolvedValue({ changes: [] }),
  fetch: vi.fn(),
  protection: {
    isAsyncEncryptionAvailable: vi.fn(),
    encryptStringAsync: vi.fn(),
    decryptStringAsync: vi.fn(),
  },
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => Promise<unknown>>(),
  permissionHandler: vi.fn(),
  windows: [] as {
    webContents: {
      mainFrame: object;
      isDestroyed: ReturnType<typeof vi.fn>;
      once: ReturnType<typeof vi.fn>;
      removeListener: ReturnType<typeof vi.fn>;
      setWindowOpenHandler: ReturnType<typeof vi.fn>;
      on: ReturnType<typeof vi.fn>;
    };
    once: ReturnType<typeof vi.fn>;
    isDestroyed: ReturnType<typeof vi.fn>;
    show: ReturnType<typeof vi.fn>;
    loadFile: ReturnType<typeof vi.fn>;
    loadURL: ReturnType<typeof vi.fn>;
  }[],
  loadLibrary: vi.fn().mockResolvedValue({ revision: 0, library: { documents: [], links: [], collections: [], retiredMapIds: [] } }),
  saveLibrary: vi.fn().mockResolvedValue(null),
}));

vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
vi.mock('electron', () => ({
  app: startup.app,
  BrowserWindow: class {
    static getAllWindows() { return startup.windows; }
    webContents = {
      mainFrame: {}, setWindowOpenHandler: vi.fn(), on: vi.fn(),
      isDestroyed: vi.fn().mockReturnValue(false), once: vi.fn(), removeListener: vi.fn(),
    };
    once = vi.fn();
    isDestroyed = vi.fn().mockReturnValue(false);
    show = vi.fn();
    loadFile = vi.fn();
    loadURL = vi.fn();
    constructor(options: unknown) {
      startup.createWindow(options);
      startup.windows.push(this);
    }
  },
  dialog: { showErrorBox: startup.showErrorBox },
  ipcMain: {
    handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => Promise<unknown>) => {
      startup.handlers.set(channel, handler);
    },
  },
  session: { defaultSession: { setPermissionRequestHandler: startup.permissionHandler } },
  shell: { openExternal: vi.fn() },
  safeStorage: startup.protection,
}));
vi.mock('./ai-settings-store', () => ({
  AiSettingsStore: class {
    summary = startup.getSettings;
    update = startup.updateSettings;
    readForRequest = startup.readForRequest;
    constructor(...args: unknown[]) { startup.createSettings(...args); }
  },
}));
vi.mock('./ai-provider-transport', () => ({
  AiProviderTransport: class {
    request = startup.request;
  },
}));
vi.mock('./mind-map-repository', async (importOriginal) => {
  const original = await importOriginal<typeof import('./mind-map-repository')>();
  return {
    ...original,
    SqliteMindMapRepository: class {
      loadLibrary = startup.loadLibrary;
      saveLibrary = startup.saveLibrary;
      close = startup.closeStorage;
      constructor(path: string) { startup.openStorage(path); }
    },
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  startup.openStorage.mockReset();
  startup.closeStorage.mockReset();
  startup.request.mockReset().mockResolvedValue({ changes: [] });
  startup.loadLibrary.mockReset().mockResolvedValue({
    revision: 0, library: { documents: [], links: [], collections: [], retiredMapIds: [] },
  });
  startup.windows.length = 0;
  startup.handlers.clear();
  vi.stubGlobal('fetch', startup.fetch);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

it('surfaces startup storage failure and exits nonzero without opening a renderer', async () => {
  const failure = new Error('Unsupported schema; private storage details');
  startup.openStorage.mockImplementation(() => { throw failure; });
  const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    await import('./index');
    await vi.waitFor(() => expect(startup.app.exit).toHaveBeenCalledWith(1));
    expect(startup.openStorage).toHaveBeenCalledWith('/tmp/temivo-startup-test/temivo.sqlite');
    expect(startup.showErrorBox).toHaveBeenCalledWith(
      'Unable to start Temivo',
      'Local storage could not be initialized. Your maps were not reset.',
    );
    expect(startup.createWindow).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith('Unable to initialize Temivo.', failure);
    expect(JSON.stringify(startup.showErrorBox.mock.calls)).not.toContain('private storage details');
  } finally {
    log.mockRestore();
  }
});

it('registers fixed channels, keeps sandbox defaults and closes storage on quit (mocked Electron only)', async () => {
  await import('./index');
  await vi.waitFor(() => expect(startup.createWindow).toHaveBeenCalledOnce());
  expect([...startup.handlers.keys()].sort()).toEqual([
    ...Object.values(MIND_MAP_CHANNELS), ...Object.values(AI_CHANNELS),
  ].sort());
  expect(startup.createSettings).toHaveBeenCalledWith(
    '/tmp/temivo-startup-test/ai-settings.json', expect.objectContaining({
      encrypt: expect.any(Function), decrypt: expect.any(Function),
    }),
  );
  expect(startup.getSettings).not.toHaveBeenCalled();
  expect(startup.readForRequest).not.toHaveBeenCalled();
  expect(startup.request).not.toHaveBeenCalled();
  expect(startup.fetch).not.toHaveBeenCalled();
  for (const operation of Object.values(startup.protection)) expect(operation).not.toHaveBeenCalled();
  expect(startup.createWindow).toHaveBeenCalledWith(expect.objectContaining({
    webPreferences: expect.objectContaining({
      contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true,
    }),
  }));
  const window = startup.windows[0];
  if (!window) throw new Error('No mocked window.');
  expect(window.loadFile).toHaveBeenCalledOnce();
  expect(window.loadURL).not.toHaveBeenCalled();
  const navigationHandler = window.webContents.on.mock.calls.find(([name]) => name === 'will-navigate')?.[1];
  const preventDefault = vi.fn();
  navigationHandler({ preventDefault });
  expect(preventDefault).toHaveBeenCalledOnce();
  const openHandler = window.webContents.setWindowOpenHandler.mock.calls[0]?.[0];
  expect(openHandler({ url: 'file:///untrusted' })).toEqual({ action: 'deny' });
  const permissionHandler = startup.permissionHandler.mock.calls[0]?.[0];
  const callback = vi.fn();
  permissionHandler(null, 'camera', callback);
  expect(callback).toHaveBeenCalledWith(false);
  const close = startup.app.once.mock.calls.find(([name]) => name === 'quit')?.[1];
  close();
  expect(startup.closeStorage).toHaveBeenCalledOnce();
});

it('authorizes only an owned live main frame before every new channel accesses storage', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    await import('./index');
    await vi.waitFor(() => expect(startup.createWindow).toHaveBeenCalledOnce());
    const window = startup.windows[0];
    if (!window) throw new Error('No mocked window.');
    const foreignContents = { mainFrame: {}, isDestroyed: () => false };
    const validLibrary = { documents: [], links: [], collections: [], retiredMapIds: [] };
    for (const channel of [
      MIND_MAP_CHANNELS.loadLibrary, MIND_MAP_CHANNELS.saveLibrary, ...Object.values(AI_CHANNELS),
    ]) {
      const handler = startup.handlers.get(channel);
      if (!handler) throw new Error('No mocked handler.');
      for (const event of [
        { sender: window.webContents, senderFrame: {} },
        { sender: window.webContents, senderFrame: null },
        { sender: foreignContents, senderFrame: foreignContents.mainFrame },
      ]) {
        expect(await handler(event, validLibrary, 0)).toMatchObject({
          ok: false, error: { code: 'FORBIDDEN' },
        });
      }
    }
    expect(startup.loadLibrary).not.toHaveBeenCalled();
    expect(startup.saveLibrary).not.toHaveBeenCalled();
    expect(startup.getSettings).not.toHaveBeenCalled();
    expect(startup.updateSettings).not.toHaveBeenCalled();
    expect(startup.readForRequest).not.toHaveBeenCalled();
    expect(startup.request).not.toHaveBeenCalled();
    const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
    expect(await startup.handlers.get(MIND_MAP_CHANNELS.loadLibrary)?.(event)).toMatchObject({ ok: true });
    expect(await startup.handlers.get(MIND_MAP_CHANNELS.saveLibrary)?.(event, validLibrary, 0)).toMatchObject({ ok: true });
    expect(startup.loadLibrary).toHaveBeenCalledOnce();
    expect(startup.saveLibrary).toHaveBeenCalledWith(validLibrary, 0);
    expect(await startup.handlers.get(AI_CHANNELS.getSettings)?.(event)).toMatchObject({ ok: true });
    expect(startup.getSettings).toHaveBeenCalledOnce();
    window.isDestroyed.mockReturnValue(true);
    for (const channel of Object.values(AI_CHANNELS)) {
      expect(await startup.handlers.get(channel)?.(event)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    window.isDestroyed.mockReturnValue(false);
    window.webContents.isDestroyed.mockReturnValue(true);
    for (const channel of Object.values(AI_CHANNELS)) {
      expect(await startup.handlers.get(channel)?.(event)).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
    }
    window.webContents.isDestroyed.mockReturnValue(false);
    const closed = window.once.mock.calls.find(([name]) => name === 'closed')?.[1];
    closed();
    expect(await startup.handlers.get(MIND_MAP_CHANNELS.loadLibrary)?.(event)).toMatchObject({
      ok: false, error: { code: 'FORBIDDEN' },
    });
    expect(startup.loadLibrary).toHaveBeenCalledOnce();
    expect(await startup.handlers.get(AI_CHANNELS.getSettings)?.(event)).toMatchObject({
      ok: false, error: { code: 'FORBIDDEN' },
    });
    expect(startup.getSettings).toHaveBeenCalledOnce();
  } finally {
    warn.mockRestore();
  }
});

it.each(['closed', 'before-quit', 'quit'])(
  'cancels pending generation on %s before storage closes, with no real provider or OS access', async (reason) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let resolve!: (value: unknown) => void;
    startup.request.mockReturnValue(new Promise((yes) => { resolve = yes; }));
    try {
      await import('./index');
      await vi.waitFor(() => expect(startup.createWindow).toHaveBeenCalledOnce());
      const window = startup.windows[0];
      if (!window) throw new Error('No mocked window.');
      const started = beginGeneration(createMapLibrary([createTopicMap('map', 'root', 'Topic')]), 'map', 'root');
      startup.loadLibrary.mockResolvedValue({ revision: 1, library: started.library });
      const event = { sender: window.webContents, senderFrame: window.webContents.mainFrame };
      const result = startup.handlers.get(AI_CHANNELS.generate)?.(event, started.request);
      await vi.waitFor(() => expect(startup.request).toHaveBeenCalledOnce());
      const signal = startup.request.mock.calls[0]?.[3];
      if (!(signal instanceof AbortSignal)) throw new Error('Missing fixture abort signal.');
      startup.closeStorage.mockImplementation(() => expect(signal.aborted).toBe(true));
      const close = reason === 'closed'
        ? window.once.mock.calls.find(([name]) => name === 'closed')?.[1]
        : startup.app.once.mock.calls.find(([name]) => name === reason)?.[1];
      close();
      expect(await result).toMatchObject({ ok: false, error: { code: 'CANCELLED' } });
      expect(signal.aborted).toBe(true);
      expect(startup.closeStorage).toHaveBeenCalledTimes(reason === 'quit' ? 1 : 0);
      if (reason === 'before-quit') {
        expect(await startup.handlers.get(AI_CHANNELS.getSettings)?.(event)).toMatchObject({
          ok: false, error: { code: 'CANCELLED' },
        });
      }
      resolve({ changes: [] });
      expect(startup.loadLibrary).toHaveBeenCalledOnce();
      expect(startup.saveLibrary).not.toHaveBeenCalled();
      expect(startup.fetch).not.toHaveBeenCalled();
      for (const operation of Object.values(startup.protection)) expect(operation).not.toHaveBeenCalled();
      expect(window.webContents.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
      expect(window.webContents.removeListener).toHaveBeenCalledWith('render-process-gone', expect.any(Function));
    } finally {
      warn.mockRestore();
    }
  },
);
