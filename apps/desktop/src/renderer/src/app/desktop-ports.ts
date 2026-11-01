import type { MindMapsApi } from '../../../shared/desktop-api';
import { DesktopPortError } from './workspace';
import type { WorkspacePorts } from './workspace';

export function unwrapResult<T>(result:
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } },
): T {
  if (!result.ok) throw new DesktopPortError(result.error.code, result.error.message);
  return result.value;
}

export function createLibraryPorts(maps: Pick<MindMapsApi, 'loadLibrary' | 'saveLibrary'>): Pick<WorkspacePorts, 'load' | 'save'> {
  return {
    load: async () => unwrapResult(await maps.loadLibrary()),
    save: async (library, expectedRevision) => unwrapResult(await maps.saveLibrary(library, expectedRevision)),
  };
}
