import { expect, it, vi } from 'vitest';

const startup = vi.hoisted(() => ({
  app: {
    whenReady: vi.fn<() => Promise<void>>().mockResolvedValue(undefined),
    getPath: vi.fn().mockReturnValue('/tmp/temivo-startup-test'),
    once: vi.fn(),
    on: vi.fn(),
    exit: vi.fn(),
  },
  showErrorBox: vi.fn(),
  openStorage: vi.fn(),
  createWindow: vi.fn(),
}));

vi.mock('node:fs', () => ({ mkdirSync: vi.fn() }));
vi.mock('electron', () => ({
  app: startup.app,
  BrowserWindow: startup.createWindow,
  dialog: { showErrorBox: startup.showErrorBox },
  ipcMain: { handle: vi.fn() },
  session: {},
  shell: {},
}));
vi.mock('./mind-map-repository', () => ({
  SqliteMindMapRepository: class {
    constructor(path: string) {
      startup.openStorage(path);
    }
  },
}));

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
