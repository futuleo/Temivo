import type { AiErrorCode } from '../shared/ai-api';

export type { AiInfrastructureErrorCode } from '../shared/ai-api';

const messages: Record<AiErrorCode, string> = {
  INVALID_CONFIG: 'Invalid AI provider configuration.',
  INVALID_REQUEST: 'Invalid AI request.',
  AUTHENTICATION: 'The AI provider rejected authentication.',
  RATE_LIMIT: 'The AI provider rate limit was reached.',
  NETWORK: 'Unable to reach the AI provider.',
  TIMEOUT: 'The AI request timed out.',
  CANCELLED: 'The AI request was cancelled.',
  HTTP_ERROR: 'The AI provider returned an unsuccessful HTTP response.',
  PROTOCOL: 'The AI provider returned an unsupported or malformed response.',
  TRUNCATED: 'The AI provider response was truncated.',
  RESPONSE_TOO_LARGE: 'The AI provider response exceeded the size limit.',
  SETTINGS_CORRUPT: 'Stored AI settings are invalid or unsupported.',
  SETTINGS_READ: 'Unable to read AI settings.',
  SETTINGS_WRITE: 'Unable to save AI settings.',
  PROTECTION_UNAVAILABLE: 'Protected credential storage is unavailable on this platform.',
  ENCRYPTION_FAILED: 'Unable to protect the AI credential.',
  DECRYPTION_FAILED: 'Unable to unlock the AI credential.',
  KEY_MISSING: 'No credential is stored for this AI destination.',
  STALE_GENERATION: 'Generation is stale. Start again against the current map.',
  REQUEST_LIMIT: 'Too many generation requests in this window. Close it before starting more.',
  AI_ERROR: 'Unable to complete the AI operation.',
};

// Never attach provider bodies, URLs, credentials, or original exception causes.
export class AiInfrastructureError extends Error {
  constructor(readonly code: AiErrorCode) {
    super(messages[code]);
    this.name = 'AiInfrastructureError';
  }
}
