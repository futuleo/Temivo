import type { AiApi, AiSettingsUpdate, DesktopApi, MindMapsApi } from '../../../shared/desktop-api';
import { DesktopPortError } from './workspace';
import type { WorkspacePorts } from './workspace';
import type { SettingsPorts } from './settings';

type BridgeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: { readonly code: string; readonly message: string } };

export function unwrapResult<T>(result: BridgeResult<T>): T {
  if (!result.ok) throw new DesktopPortError(result.error.code, result.error.message);
  return result.value;
}

async function invokeBridge<T>(operation: () => Promise<BridgeResult<T>>): Promise<T> {
  let result: BridgeResult<T>;
  try { result = await operation(); }
  catch { throw new DesktopPortError('IPC_ERROR', 'The desktop connection failed. Your local work has been kept; retry the operation.'); }
  return unwrapResult(result);
}

export function createLibraryPorts(maps: Pick<MindMapsApi, 'loadLibrary' | 'saveLibrary'>): Pick<WorkspacePorts, 'load' | 'save'> {
  return {
    load: () => invokeBridge(() => maps.loadLibrary()),
    save: (library, expectedRevision) => invokeBridge(() => maps.saveLibrary(library, expectedRevision)),
  };
}

export function createWorkspacePorts(api: DesktopApi, newId: () => string = () => crypto.randomUUID()): WorkspacePorts {
  return {
    ...createLibraryPorts(api.maps),
    generate: (request) => invokeBridge(() => api.ai.generate(request)),
    cancel: async (mapId, sequence) => { await invokeBridge(() => api.ai.cancelGeneration(mapId, sequence)); },
    newId,
  };
}

export function createSettingsPorts(ai: AiApi): SettingsPorts {
  return {
    load: () => invokeBridge(() => ai.getSettings()),
    save: (fields) => {
      const update: AiSettingsUpdate = {
        config: { provider: fields.provider, endpoint: fields.endpoint.trim(), model: fields.model.trim() },
        keyAction: fields.keyAction === 'replace' ? { kind: 'replace', key: fields.apiKey } : { kind: fields.keyAction },
      };
      return invokeBridge(() => ai.updateSettings(update));
    },
  };
}
