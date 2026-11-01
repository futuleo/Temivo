import { AiInfrastructureError } from './ai-errors';

export interface AiProviderConfig {
  provider: 'openai-compatible' | 'anthropic';
  /** API base URL, including any version prefix; not the operation URL. */
  endpoint: string;
  model: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
}

export function parseAiProviderConfig(value: unknown): AiProviderConfig {
  if (
    !isRecord(value) ||
    Object.keys(value).some((key) => !['provider', 'endpoint', 'model'].includes(key)) ||
    (value.provider !== 'openai-compatible' && value.provider !== 'anthropic') ||
    typeof value.endpoint !== 'string' ||
    value.endpoint.length > 2048 ||
    /[\s\\?#]/u.test(value.endpoint) ||
    hasControlCharacters(value.endpoint) ||
    typeof value.model !== 'string' ||
    value.model.length === 0 ||
    value.model.length > 256 ||
    value.model.trim() !== value.model ||
    hasControlCharacters(value.model)
  ) {
    throw new AiInfrastructureError('INVALID_CONFIG');
  }

  let endpoint: URL;
  try {
    endpoint = new URL(value.endpoint);
  } catch {
    throw new AiInfrastructureError('INVALID_CONFIG');
  }
  const loopback = endpoint.hostname === '127.0.0.1' || endpoint.hostname === '[::1]';
  if (
    (endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) ||
    endpoint.username !== '' ||
    endpoint.password !== '' ||
    endpoint.hostname === ''
  ) {
    throw new AiInfrastructureError('INVALID_CONFIG');
  }
  return {
    provider: value.provider,
    endpoint: endpoint.href.replace(/\/+$/u, ''),
    model: value.model,
  };
}

export function assertAiKey(value: unknown): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 4096 || /[^\x21-\x7e]/u.test(value)) {
    throw new AiInfrastructureError('INVALID_CONFIG');
  }
}

export function sameAiDestination(left: AiProviderConfig, right: AiProviderConfig): boolean {
  return left.provider === right.provider && left.endpoint === right.endpoint;
}
