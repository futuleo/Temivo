/**
 * API exposed by the preload script to the renderer as `window.temivo`.
 * Keep it small and explicit: never expose Electron or Node.js objects directly.
 */
export interface DesktopApi {
  readonly platform: string;
  readonly versions: {
    readonly electron: string;
    readonly chrome: string;
    readonly node: string;
  };
}
