import type { GenerationChange, GenerationRequest } from '@temivo/core';

import type { DesktopResult } from './desktop-api';

export interface AiProviderConfig {
  provider: 'openai-compatible' | 'anthropic';
  /** API base URL, including any version prefix; not the operation URL. */
  endpoint: string;
  model: string;
}

export interface AiSettingsSummary {
  config: AiProviderConfig | null;
  /** Stored ciphertext exists; this does not imply successful unlocking. */
  hasKey: boolean;
}

export type AiKeyAction =
  | { readonly kind: 'keep' }
  | { readonly kind: 'remove' }
  | { readonly kind: 'replace'; readonly key: string };

export interface AiSettingsUpdate {
  readonly config: AiProviderConfig;
  readonly keyAction: AiKeyAction;
}

export type AiInfrastructureErrorCode =
  | 'INVALID_CONFIG' | 'INVALID_REQUEST'
  | 'AUTHENTICATION' | 'RATE_LIMIT' | 'NETWORK' | 'TIMEOUT' | 'CANCELLED'
  | 'HTTP_ERROR' | 'PROTOCOL' | 'TRUNCATED' | 'RESPONSE_TOO_LARGE'
  | 'SETTINGS_CORRUPT' | 'SETTINGS_READ' | 'SETTINGS_WRITE'
  | 'PROTECTION_UNAVAILABLE' | 'ENCRYPTION_FAILED' | 'DECRYPTION_FAILED' | 'KEY_MISSING';

export type AiErrorCode = AiInfrastructureErrorCode | 'STALE_GENERATION' | 'REQUEST_LIMIT' | 'AI_ERROR';

export const AI_CHANNELS = {
  getSettings: 'ai:get-settings',
  updateSettings: 'ai:update-settings',
  generate: 'ai:generate',
  cancelGeneration: 'ai:cancel-generation',
} as const;

export interface AiApi {
  getSettings(): Promise<DesktopResult<AiSettingsSummary>>;
  updateSettings(update: AiSettingsUpdate): Promise<DesktopResult<AiSettingsSummary>>;
  /** CAS-save beginGeneration's library first. Main returns proposals, never writes maps. */
  generate(request: GenerationRequest): Promise<DesktopResult<readonly GenerationChange[]>>;
  /** Owner-bound and idempotent, including cancellation before generate reaches main. */
  cancelGeneration(mapId: string, sequence: number): Promise<DesktopResult<null>>;
}
