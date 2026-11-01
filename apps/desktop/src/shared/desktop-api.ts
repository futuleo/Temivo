/**
 * API exposed by the preload script to the renderer as `window.temivo`.
 * Keep it small and explicit: never expose Electron or Node.js objects directly.
 */
export interface DesktopApi {
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
} as const;

export type DesktopResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
    readonly ok: false;
    readonly error: {
      readonly code: 'INVALID_INPUT' | 'STORAGE_ERROR' | 'FORBIDDEN';
      readonly message: string;
    };
  };

export interface MindMapsApi {
  list(): Promise<DesktopResult<readonly MindMapSummary[]>>;
  get(id: string): Promise<DesktopResult<MindMap | null>>;
  save(map: MindMap): Promise<DesktopResult<null>>;
  delete(id: string): Promise<DesktopResult<null>>;
  getLinks(sourceMapId: string): Promise<DesktopResult<readonly MapLink[]>>;
  link(link: MapLink): Promise<DesktopResult<null>>;
  unlink(sourceMapId: string, sourceNodeId: string): Promise<DesktopResult<null>>;
}
import type { MapLink, MindMap, MindMapSummary } from '@temivo/core';
