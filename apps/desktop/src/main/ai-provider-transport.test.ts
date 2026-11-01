import { afterEach, describe, expect, it, vi } from 'vitest';

import { parseAiProviderConfig } from './ai-provider-config';
import { AiProviderTransport } from './ai-provider-transport';

const config = {
  provider: 'openai-compatible', endpoint: 'https://provider.invalid/v1', model: 'user-selected-model',
};
const anthropic = { ...config, provider: 'anthropic' };
const key = 'synthetic-nonworking-test-key';
const request = { system: 'Return JSON.', prompt: 'A topic', maxOutputTokens: 200 };
const output = { example: ['value'] };

function openAiReply(content = JSON.stringify(output), finishReason = 'stop'): unknown {
  return { choices: [{ finish_reason: finishReason, message: { role: 'assistant', content } }] };
}

function anthropicReply(text = JSON.stringify(output), stopReason = 'end_turn'): unknown {
  return { type: 'message', role: 'assistant', stop_reason: stopReason, content: [{ type: 'text', text }] };
}

function setup(response = Response.json(openAiReply()), options: { maxResponseBytes?: number; timeoutMs?: number } = {}) {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(response);
  return { fetch, transport: new AiProviderTransport({ fetch, ...options }) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('provider configuration', () => {
  it('rejects endpoints whose normalized form exceeds the persisted length bound', () => {
    const endpoint = 'https://provider.invalid/' + '\u00e9'.repeat(400);
    expect(endpoint.length).toBeLessThan(2048);
    expect(new URL(endpoint).href.length).toBeGreaterThan(2048);
    expect(() => parseAiProviderConfig({ ...config, endpoint })).toThrow('Invalid AI provider configuration.');
  });

  it('round-trips an accepted Unicode endpoint at the exact normalized length bound', () => {
    const unicodeEndpoint = 'https://provider.invalid/' + '\u00e9'.repeat(300);
    const endpoint = unicodeEndpoint + 'x'.repeat(2048 - new URL(unicodeEndpoint).href.length);
    const parsed = parseAiProviderConfig({ ...config, endpoint });
    expect(parsed.endpoint).toHaveLength(2048);
    expect(parseAiProviderConfig(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(() => parseAiProviderConfig({ ...config, endpoint: endpoint + 'x' }))
      .toThrow('Invalid AI provider configuration.');
  });

  it('normalizes API bases and allows HTTPS or explicit numeric loopback HTTP only', () => {
    expect(parseAiProviderConfig({ ...config, endpoint: 'https://PROVIDER.invalid:443/v1/' })).toEqual(config);
    for (const endpoint of ['http://127.0.0.1:8080/v1', 'http://[::1]:8080/v1']) {
      expect(parseAiProviderConfig({ ...config, endpoint }).endpoint).toBe(endpoint);
    }
  });

  it.each([
    null, {}, { ...config, provider: 'deepseek' }, { ...config, provider: 'unknown' },
    { ...config, model: '' }, { ...config, model: ' trimmed ' }, { ...config, model: 'bad\nmodel' },
    { ...config, model: 4 }, { ...config, model: 'x'.repeat(257) }, { ...config, extra: true },
    ...[
      'http://provider.invalid/v1', 'http://localhost:8000/v1', 'http://127.0.0.2/v1',
      'http://127.0.0.1.provider.invalid/v1', 'http://192.168.1.1/v1', 'file:///v1',
      'ftp://provider.invalid/v1', 'https://user:password@provider.invalid/v1',
      'https://user@provider.invalid/v1', 'https://provider.invalid/v1?api_key=fixture',
      'https://provider.invalid/v1?', 'https://provider.invalid/v1#fixture',
      ' https://provider.invalid/v1', 'https://provider.invalid\\@elsewhere.invalid',
      'not-a-url',
    ].map((endpoint) => ({ ...config, endpoint })),
  ])('rejects invalid or credential-bearing config %#', (invalid) => {
    expect(() => parseAiProviderConfig(invalid)).toThrow('Invalid AI provider configuration.');
  });
});

describe('AI provider transport', () => {
  it('does nothing on construction and uses the OpenAI-compatible dialect only on request', async () => {
    const { fetch, transport } = setup();
    expect(fetch).not.toHaveBeenCalled();
    expect(await transport.request(config, key, request)).toEqual(output);
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://provider.invalid/v1/chat/completions');
    expect(init).toMatchObject({
      method: 'POST', redirect: 'error',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    });
    expect(init?.headers).not.toHaveProperty('x-api-key');
    if (typeof init?.body !== 'string') throw new Error('Expected serialized request.');
    expect(JSON.parse(init.body)).toEqual({
      model: config.model, max_tokens: 200,
      messages: [{ role: 'system', content: request.system }, { role: 'user', content: request.prompt }],
    });
  });

  it('uses native Anthropic authentication, top-level system and required max_tokens', async () => {
    const { fetch, transport } = setup(Response.json(anthropicReply()));
    expect(await transport.request(anthropic, key, request)).toEqual(output);
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('https://provider.invalid/v1/messages');
    expect(init).toMatchObject({
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      redirect: 'error',
    });
    expect(init?.headers).not.toHaveProperty('authorization');
    if (typeof init?.body !== 'string') throw new Error('Expected serialized request.');
    expect(JSON.parse(init.body)).toEqual({
      model: config.model, system: request.system, max_tokens: 200,
      messages: [{ role: 'user', content: request.prompt }],
    });
  });

  it('supports an empty system prompt and concatenated Anthropic text blocks', async () => {
    const { fetch, transport } = setup();
    await transport.request(config, key, { ...request, system: '' });
    const init = fetch.mock.calls[0]?.[1];
    if (typeof init?.body !== 'string') throw new Error('Expected serialized request.');
    expect(JSON.parse(init.body).messages).toEqual([{ role: 'user', content: request.prompt }]);
    const multipleBlocks = {
      type: 'message', role: 'assistant', stop_reason: 'end_turn',
      content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }],
    };
    expect(await setup(Response.json(multipleBlocks)).transport.request(anthropic, key, request)).toEqual({ a: 1 });
  });

  it.each([
    { prompt: '', system: '', maxOutputTokens: 1 },
    { ...request, prompt: 'x'.repeat(64_001) },
    { ...request, system: null }, { ...request, maxOutputTokens: 0 },
    { ...request, maxOutputTokens: 8193 }, { ...request, maxOutputTokens: 1.5 }, null,
  ])('rejects invalid requests without fetching %#', async (invalid) => {
    const { fetch, transport } = setup();
    await expect(transport.request(config, key, invalid)).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(['', 'spaces not allowed', 'fixture\nheader', 'x'.repeat(4097), null])('rejects unsafe keys %#', async (invalid) => {
    const { fetch, transport } = setup();
    await expect(transport.request(config, invalid, request)).rejects.toMatchObject({ code: 'INVALID_CONFIG' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [401, 'AUTHENTICATION'], [403, 'AUTHENTICATION'], [429, 'RATE_LIMIT'],
    [302, 'HTTP_ERROR'], [400, 'HTTP_ERROR'], [503, 'HTTP_ERROR'],
  ])('sanitizes HTTP %i without reading the provider body or retrying', async (status, code) => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ cancel });
    const { fetch, transport } = setup(new Response(body, { status }));
    await expect(transport.request(config, key, request)).rejects.toMatchObject({ code });
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });

  it('discards raw exception messages, causes, request details and secret provider bodies', async () => {
    const { fetch, transport } = setup();
    fetch.mockRejectedValue(new Error(`private detail ${key}`, { cause: { authorization: key } }));
    try {
      await transport.request(config, key, request);
      throw new Error('Expected rejection.');
    } catch (error) {
      expect(error).toMatchObject({ code: 'NETWORK', message: 'Unable to reach the AI provider.' });
      expect(JSON.stringify(error)).not.toContain(key);
      expect(error).not.toHaveProperty('cause');
      expect(String(error)).not.toContain('private detail');
    }
    const failed = setup(new Response(key, { status: 401 }));
    await expect(failed.transport.request(config, key, request)).rejects.toMatchObject({
      code: 'AUTHENTICATION', message: 'The AI provider rejected authentication.',
    });
  });

  it('sanitizes an interrupted response stream rather than accepting its partial JSON', async () => {
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from('{"choices":'));
        controller.error(new Error(`private stream detail ${key}`));
      },
    }), { headers: { 'content-type': 'application/json' } });
    await expect(setup(response).transport.request(config, key, request)).rejects.toMatchObject({
      code: 'NETWORK', message: 'Unable to reach the AI provider.',
    });
  });

  it.each([
    null, {}, { choices: [] }, { choices: [null] },
    { choices: [{ finish_reason: 'stop', message: { role: 'user', content: '{}' } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', tool_calls: [] } }] },
    { choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: '{}', refusal: 'refused' } }] },
    openAiReply('not JSON'), openAiReply('```json\n{}\n```'), openAiReply('{}', 'tool_calls'),
    openAiReply('{}', 'content_filter'), anthropicReply(),
  ])('rejects malformed, refused, or wrong-dialect OpenAI replies %#', async (reply) => {
    await expect(setup(Response.json(reply)).transport.request(config, key, request))
      .rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it.each([
    openAiReply(), { ...anthropicReplyObject(), type: 'other' },
    { ...anthropicReplyObject(), role: 'user' }, { ...anthropicReplyObject(), content: [] },
    { ...anthropicReplyObject(), content: [{ type: 'tool_use', input: {} }] },
    { ...anthropicReplyObject(), content: [{ type: 'text', text: 42 }] },
    anthropicReply('not JSON'), anthropicReply('{}', 'tool_use'), anthropicReply('{}', 'refusal'),
    anthropicReply('{}', 'stop_sequence'),
  ])('rejects malformed, refused, or wrong-dialect Anthropic replies %#', async (reply) => {
    await expect(setup(Response.json(reply)).transport.request(anthropic, key, request))
      .rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it.each([
    [config, openAiReply('{}', 'length')],
    [anthropic, anthropicReply('{}', 'max_tokens')],
    [anthropic, anthropicReply('{}', 'model_context_window_exceeded')],
  ])('rejects provider-reported truncation %#', async (selected, reply) => {
    await expect(setup(Response.json(reply)).transport.request(selected, key, request))
      .rejects.toMatchObject({ code: 'TRUNCATED' });
  });

  it.each([
    new Response('{}', { headers: { 'content-type': 'text/html' } }),
    new Response(null, { headers: { 'content-type': 'application/json' } }),
    new Response('{"incomplete":', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
  ])('rejects invalid outer HTTP bodies %#', async (response) => {
    await expect(setup(response).transport.request(config, key, request)).rejects.toMatchObject({ code: 'PROTOCOL' });
  });

  it('enforces response bytes, including streamed multibyte content and dishonest Content-Length', async () => {
    const bytes = Buffer.from(JSON.stringify(openAiReply('{"value":"\u20ac"}')));
    const cancel = vi.fn();
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(bytes.subarray(0, 10));
        controller.enqueue(bytes.subarray(10));
      },
      cancel,
    }), { headers: { 'content-type': 'application/json', 'content-length': '1' } });
    await expect(setup(response, { maxResponseBytes: bytes.length - 1 }).transport.request(config, key, request))
      .rejects.toMatchObject({ code: 'RESPONSE_TOO_LARGE' });
    expect(cancel).toHaveBeenCalledOnce();
    const exact = setup(new Response(bytes, { headers: { 'content-type': 'application/json' } }), {
      maxResponseBytes: bytes.length,
    });
    expect(await exact.transport.request(config, key, request)).toEqual({ value: '\u20ac' });
  });

  it('rejects pre-cancellation before fetching', async () => {
    const controller = new AbortController();
    controller.abort(new Error(key));
    const { fetch, transport } = setup();
    await expect(transport.request(config, key, request, controller.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cancels a fetch even if the injected fetch ignores the signal', async () => {
    const controller = new AbortController();
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise(() => undefined));
    const transport = new AiProviderTransport({ fetch });
    const pending = transport.request(config, key, request, controller.signal);
    controller.abort(new Error(key));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(fetch.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
  });

  it('cancels stalled response reads and does not expose abort reasons', async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    let started: (() => void) | undefined;
    const reading = new Promise<void>((resolve) => { started = resolve; });
    const response = new Response(new ReadableStream<Uint8Array>({
      pull() { started?.(); },
      cancel,
    }), { headers: { 'content-type': 'application/json' } });
    const { transport } = setup(response);
    const pending = transport.request(config, key, request, controller.signal);
    await reading;
    controller.abort(new Error(key));
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED', message: 'The AI request was cancelled.' });
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each(['fetch', 'body'])('times out a stalled %s without using sockets', async (stage) => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const fetch = vi.fn<typeof globalThis.fetch>();
    if (stage === 'fetch') fetch.mockImplementation(() => new Promise(() => undefined));
    else fetch.mockResolvedValue(new Response(new ReadableStream<Uint8Array>({ cancel }), {
      headers: { 'content-type': 'application/json' },
    }));
    const transport = new AiProviderTransport({ fetch, timeoutMs: 20 });
    const rejection = expect(transport.request(config, key, request)).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await rejection;
    expect(fetch).toHaveBeenCalledOnce();
    if (stage === 'body') expect(cancel).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans up a response that arrives after cancellation', async () => {
    const controller = new AbortController();
    let complete: ((response: Response) => void) | undefined;
    const fetch = vi.fn<typeof globalThis.fetch>().mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const pending = new AiProviderTransport({ fetch }).request(config, key, request, controller.signal);
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    const cancel = vi.fn();
    complete?.(new Response(new ReadableStream<Uint8Array>({ cancel })));
    await Promise.resolve();
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    { timeoutMs: 0 }, { timeoutMs: NaN }, { timeoutMs: 120_001 }, { maxResponseBytes: 0 },
    { maxResponseBytes: 1024 * 1024 + 1 },
  ])('rejects unbounded transport options %#', (options) => {
    expect(() => setup(undefined, options)).toThrow('Invalid AI provider configuration.');
  });
});

function anthropicReplyObject() {
  return { type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] };
}
