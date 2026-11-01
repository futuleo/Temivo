import { AiInfrastructureError } from './ai-errors';
import { assertAiKey, isRecord, parseAiProviderConfig } from './ai-provider-config';

/** Main-private input. This is not a domain generation contract or a renderer API. */
export interface AiTransportRequest {
  system: string;
  prompt: string;
  maxOutputTokens: number;
}

export interface AiTransportOptions {
  fetch: typeof globalThis.fetch;
  timeoutMs?: number;
  maxResponseBytes?: number;
}

function assertRequest(value: unknown): asserts value is AiTransportRequest {
  if (
    !isRecord(value) ||
    typeof value.system !== 'string' ||
    typeof value.prompt !== 'string' ||
    value.prompt.trim().length === 0 ||
    value.system.length + value.prompt.length > 64_000 ||
    typeof value.maxOutputTokens !== 'number' ||
    !Number.isInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 1 ||
    value.maxOutputTokens > 8192
  ) {
    throw new AiInfrastructureError('INVALID_REQUEST');
  }
}

function parseOutput(envelope: unknown, provider: 'openai-compatible' | 'anthropic'): unknown {
  if (!isRecord(envelope)) throw new AiInfrastructureError('PROTOCOL');
  let text: string;
  if (provider === 'openai-compatible') {
    if (!Array.isArray(envelope.choices) || envelope.choices.length !== 1) {
      throw new AiInfrastructureError('PROTOCOL');
    }
    const choice: unknown = envelope.choices[0];
    if (!isRecord(choice)) throw new AiInfrastructureError('PROTOCOL');
    if (choice.finish_reason === 'length') throw new AiInfrastructureError('TRUNCATED');
    if (
      choice.finish_reason !== 'stop' ||
      !isRecord(choice.message) ||
      choice.message.role !== 'assistant' ||
      typeof choice.message.content !== 'string' ||
      choice.message.tool_calls != null ||
      choice.message.function_call != null ||
      choice.message.refusal != null
    ) {
      throw new AiInfrastructureError('PROTOCOL');
    }
    text = choice.message.content;
  } else {
    if (envelope.stop_reason === 'max_tokens' || envelope.stop_reason === 'model_context_window_exceeded') {
      throw new AiInfrastructureError('TRUNCATED');
    }
    if (
      envelope.type !== 'message' ||
      envelope.role !== 'assistant' ||
      envelope.stop_reason !== 'end_turn' ||
      !Array.isArray(envelope.content) ||
      envelope.content.length === 0
    ) {
      throw new AiInfrastructureError('PROTOCOL');
    }
    text = '';
    for (const block of envelope.content) {
      if (!isRecord(block) || block.type !== 'text' || typeof block.text !== 'string') {
        throw new AiInfrastructureError('PROTOCOL');
      }
      text += block.text;
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new AiInfrastructureError('PROTOCOL');
  }
}

export class AiProviderTransport {
  private readonly timeoutMs: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: AiTransportOptions) {
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
    if (
      !Number.isInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 120_000 ||
      !Number.isInteger(this.maxResponseBytes) || this.maxResponseBytes < 1 || this.maxResponseBytes > 1024 * 1024
    ) {
      throw new AiInfrastructureError('INVALID_CONFIG');
    }
  }

  /** Returns parsed JSON only; callers must still validate it against the approved core contract. */
  async request(configInput: unknown, key: unknown, request: unknown, signal?: AbortSignal): Promise<unknown> {
    const config = parseAiProviderConfig(configInput);
    assertAiKey(key);
    assertRequest(request);
    if (signal?.aborted) throw new AiInfrastructureError('CANCELLED');

    const controller = new AbortController();
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let timedOut = false;
    let rejectTermination: (error: AiInfrastructureError) => void = () => undefined;
    const termination = new Promise<never>((_resolve, reject) => {
      rejectTermination = reject;
    });
    const abort = (): void => {
      rejectTermination(new AiInfrastructureError(timedOut ? 'TIMEOUT' : 'CANCELLED'));
      controller.abort();
    };
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; abort(); }, this.timeoutMs);
    const perform = async (): Promise<unknown> => {
      const anthropic = config.provider === 'anthropic';
      const response = await this.options.fetch(
        `${config.endpoint}/${anthropic ? 'messages' : 'chat/completions'}`,
        {
          method: 'POST',
          redirect: 'error',
          signal: controller.signal,
          headers: anthropic
            ? { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }
            : { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({
            model: config.model,
            max_tokens: request.maxOutputTokens,
            ...(anthropic ? { system: request.system } : {}),
            messages: [
              ...(!anthropic && request.system ? [{ role: 'system', content: request.system }] : []),
              { role: 'user', content: request.prompt },
            ],
          }),
        },
      );
      if (controller.signal.aborted) {
        void response.body?.cancel().catch(() => undefined);
        throw new AiInfrastructureError(timedOut ? 'TIMEOUT' : 'CANCELLED');
      }
      if (response.body) reader = response.body.getReader();
      if (response.status === 401 || response.status === 403) throw new AiInfrastructureError('AUTHENTICATION');
      if (response.status === 429) throw new AiInfrastructureError('RATE_LIMIT');
      if (!response.ok) throw new AiInfrastructureError('HTTP_ERROR');
      if (
        response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json' ||
        !reader
      ) {
        throw new AiInfrastructureError('PROTOCOL');
      }
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > this.maxResponseBytes) throw new AiInfrastructureError('RESPONSE_TOO_LARGE');
        chunks.push(chunk.value);
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        throw new AiInfrastructureError('PROTOCOL');
      }
      return parseOutput(envelope, config.provider);
    };
    try {
      return await Promise.race([perform(), termination]);
    } catch (error) {
      if (controller.signal.aborted) throw new AiInfrastructureError(timedOut ? 'TIMEOUT' : 'CANCELLED');
      if (error instanceof AiInfrastructureError) throw error;
      throw new AiInfrastructureError('NETWORK');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      controller.abort();
      // Cleanup must not delay a timeout or replace the sanitized primary failure.
      void reader?.cancel().catch(() => undefined);
    }
  }
}
