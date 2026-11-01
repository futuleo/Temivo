export type AiInfrastructureErrorCode =
  | 'INVALID_CONFIG'
  | 'INVALID_REQUEST'
  | 'AUTHENTICATION'
  | 'RATE_LIMIT'
  | 'NETWORK'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'HTTP_ERROR'
  | 'PROTOCOL'
  | 'TRUNCATED'
  | 'RESPONSE_TOO_LARGE'
  | 'SETTINGS_CORRUPT'
  | 'SETTINGS_READ'
  | 'SETTINGS_WRITE'
  | 'PROTECTION_UNAVAILABLE'
  | 'ENCRYPTION_FAILED'
  | 'DECRYPTION_FAILED'
  | 'KEY_MISSING';

const messages: Record<AiInfrastructureErrorCode, string> = {
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
};

// Never attach provider bodies, URLs, credentials, or original exception causes.
export class AiInfrastructureError extends Error {
  constructor(readonly code: AiInfrastructureErrorCode) {
    super(messages[code]);
    this.name = 'AiInfrastructureError';
  }
}
