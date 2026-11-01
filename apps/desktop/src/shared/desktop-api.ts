import type { MapLibrary, MapLink, MindMap, MindMapSummary } from '@temivo/core';

import type { AiApi, AiErrorCode } from './ai-api';

export { AI_CHANNELS } from './ai-api';
export type {
  AiApi, AiErrorCode, AiInfrastructureErrorCode, AiKeyAction,
  AiProviderConfig, AiSettingsSummary, AiSettingsUpdate,
} from './ai-api';

/**
 * API exposed by the preload script to the renderer as `window.temivo`.
 * Keep it small and explicit: never expose Electron or Node.js objects directly.
 */
export interface DesktopApi {
  readonly ai: AiApi;
  readonly maps: MindMapsApi;
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}
export const MIND_MAP_CHANNELS = {
  list: 'mind-maps:list',
  get: 'mind-maps:get',
  save: 'mind-maps:save',
  delete: 'mind-maps:delete',
  getLinks: 'mind-maps:get-links',
  link: 'mind-maps:link',
  unlink: 'mind-maps:unlink',
  loadLibrary: 'mind-maps:load-library',
  saveLibrary: 'mind-maps:save-library',
} as const;

export interface LibrarySnapshot {
  /** Whole-library storage CAS revision, not a document/node revision. */
  readonly revision: number;
  readonly library: MapLibrary;
}

export type DesktopResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly error: {
      readonly code: 'INVALID_INPUT' | 'STORAGE_ERROR' | 'FORBIDDEN' | 'VERSION_CONFLICT' | 'LIBRARY_REQUIRED' | AiErrorCode;
      readonly message: string;
    };
  };

export interface MindMapsApi {
  loadLibrary(): Promise<DesktopResult<LibrarySnapshot>>;
  saveLibrary(library: MapLibrary, expectedRevision: number): Promise<DesktopResult<LibrarySnapshot>>;
  list(): Promise<DesktopResult<readonly MindMapSummary[]>>;
  get(id: string): Promise<DesktopResult<MindMap | null>>;
  /** @deprecated Returns LIBRARY_REQUIRED. Use loadLibrary/saveLibrary. */
  save(map: MindMap): Promise<DesktopResult<null>>;
  /** @deprecated Returns LIBRARY_REQUIRED. Use loadLibrary/saveLibrary. */
  delete(id: string): Promise<DesktopResult<null>>;
  getLinks(sourceMapId: string): Promise<DesktopResult<readonly MapLink[]>>;
  /** @deprecated Returns LIBRARY_REQUIRED. Use loadLibrary/saveLibrary. */
  link(link: MapLink): Promise<DesktopResult<null>>;
  /** @deprecated Returns LIBRARY_REQUIRED. Use loadLibrary/saveLibrary. */
  unlink(sourceMapId: string, sourceNodeId: string): Promise<DesktopResult<null>>;
}
