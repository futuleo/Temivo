import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

import { assertMapId, assertMapLink, assertMindMap, InvalidMindMapError } from '@temivo/core';
import type { MindMapRepository } from '@temivo/core';

import { MIND_MAP_CHANNELS } from '../shared/desktop-api';
import type { DesktopResult } from '../shared/desktop-api';

export function registerMindMapIpc(
  repository: MindMapRepository,
  isTrustedSender: (event: IpcMainInvokeEvent) => boolean,
): void {
  function handle<T>(channel: string, action: (...args: unknown[]) => Promise<T>): void {
    ipcMain.handle(channel, async (event, ...args: unknown[]): Promise<DesktopResult<T>> => {
      if (!isTrustedSender(event)) {
        console.warn('Rejected a maps request from an untrusted frame.');
        return { ok: false, error: { code: 'FORBIDDEN', message: 'This frame cannot access maps.' } };
      }
      try {
        return { ok: true, value: await action(...args) };
      } catch (error) {
        if (error instanceof InvalidMindMapError) {
          console.warn('Rejected invalid maps input.');
          return { ok: false, error: { code: 'INVALID_INPUT', message: error.message } };
        }
        console.error('Maps storage operation failed.', error);
        return { ok: false, error: { code: 'STORAGE_ERROR', message: 'Unable to access local maps.' } };
      }
    });
  }

  handle(MIND_MAP_CHANNELS.list, () => repository.list());
  handle(MIND_MAP_CHANNELS.get, (id) => {
    assertMapId(id);
    return repository.get(id);
  });
  handle(MIND_MAP_CHANNELS.save, async (map) => {
    assertMindMap(map);
    await repository.save(map);
    return null;
  });
  handle(MIND_MAP_CHANNELS.delete, async (id) => {
    assertMapId(id);
    await repository.delete(id);
    return null;
  });
  handle(MIND_MAP_CHANNELS.getLinks, (sourceMapId) => {
    assertMapId(sourceMapId);
    return repository.getLinks(sourceMapId);
  });
  handle(MIND_MAP_CHANNELS.link, async (link) => {
    assertMapLink(link);
    await repository.link(link);
    return null;
  });
  handle(MIND_MAP_CHANNELS.unlink, async (sourceMapId, sourceNodeId) => {
    assertMapId(sourceMapId);
    assertMapId(sourceNodeId);
    await repository.unlink(sourceMapId, sourceNodeId);
    return null;
  });
}
