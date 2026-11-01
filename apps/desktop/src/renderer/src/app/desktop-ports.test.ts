import { describe, expect, it, vi } from 'vitest';
import { createMapLibrary, createTopicMap } from '@temivo/core';
import type { MindMapsApi } from '../../../shared/desktop-api';
import { createLibraryPorts } from './desktop-ports';
import { DesktopPortError } from './workspace';

describe('real library bridge adapter with injected IPC', () => {
  it('passes full rich snapshots and storage revisions through the actual library contract', async () => {
    const library = createMapLibrary([createTopicMap('map', 'root', 'Topic')]);
    const loadLibrary = vi.fn(async () => ({ ok: true as const, value: { library, revision: 12 } }));
    const saveLibrary = vi.fn(async () => ({ ok: true as const, value: { library, revision: 13 } }));
    const ports = createLibraryPorts({ loadLibrary, saveLibrary });
    expect(await ports.load()).toEqual({ library, revision: 12 });
    expect(await ports.save(library, 12)).toEqual({ library, revision: 13 });
    expect(saveLibrary).toHaveBeenCalledWith(library, 12);
  });

  it('does not turn a CAS conflict into success or silently load replacement state', async () => {
    const loadLibrary = vi.fn();
    const ports = createLibraryPorts({
      loadLibrary,
      saveLibrary: vi.fn<MindMapsApi['saveLibrary']>(async () => ({ ok: false, error: { code: 'VERSION_CONFLICT', message: 'Reload required.' } })),
    });
    await expect(ports.save(createMapLibrary(), 12)).rejects.toEqual(new DesktopPortError('VERSION_CONFLICT', 'Reload required.'));
    expect(loadLibrary).not.toHaveBeenCalled();
  });
});
