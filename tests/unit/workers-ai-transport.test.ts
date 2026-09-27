import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  WORKERS_AI_DEFAULT_MAX_COMPLETION_TOKENS,
  WORKERS_AI_DEFAULT_RESPONSE_FORMAT,
  WORKERS_AI_ENGINE_VERSION,
  WORKERS_AI_WRAPPER_SYSTEM_PROMPT,
  WorkersAiTransport,
  WorkersAiTransportError,
  assertWorkersAiModelId,
  buildWorkersAiEndpoint,
  buildWorkersAiRequestBody,
  classifyWorkersAiFailure,
  readWorkersAiModelUsed,
  readWorkersAiResponseText,
  readWorkersAiTokenUsage,
  resolveWorkersAiMaxCompletionTokens,
  resolveWorkersAiResponseFormat,
  resolveWorkersAiTimeoutMs,
  workersAiThinkingEnabled
} from '../../src/lib/evaluation/workers-ai-transport';
import {
  LlmProviderConfigurationError,
  type LlmGenerationRequest
} from '../../src/lib/evaluation/llm-transport';

const REQUEST: LlmGenerationRequest = {
  requestedModel: '@cf/google/gemma-4-26b-a4b-it',
  prompt: 'EDITORIAL PROMPT BODY',
  jsonSchema: { type: 'object', properties: { judges: { type: 'array' } } },
  thinkingBudget: 'high'
};

const ENV = {
  CLOUDFLARE_ACCOUNT_ID: 'acct-0123456789abcdef',
  WORKERS_AI_API_TOKEN: 'wai-token-super-secret-value',
  NODE_ENV: 'test'
};

/** A chat-completion envelope as the run endpoint returns it. */
function envelope(content: string | null, extra: Record<string, unknown> = {}) {
  return {
    success: true,
    errors: [],
    messages: [],
    result: {
      id: 'chatcmpl-1',
      object: 'chat.completion',
      model: '@cf/google/gemma-4-26b-a4b-it',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: 21000,
        completion_tokens: 9000,
        total_tokens: 30000,
        completion_tokens_details: { reasoning_tokens: 5000 }
      },
      ...extra
    }
  };
}

type Scripted = Array<{ status: number; body?: unknown; headers?: Record<string, string>; throws?: Error }>;

/** A fetch that replays a script and records every request it saw. */
function scriptedFetch(script: Scripted) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const step = script.shift();
    if (!step) throw new Error('fetch called more times than scripted');
    if (step.throws) throw step.throws;
    return new Response(step.body === undefined ? '' : JSON.stringify(step.body), {
      status: step.status,
      headers: { 'content-type': 'application/json', ...(step.headers ?? {}) }
    });
  };
  return { impl, calls };
}

describe('the request is the provider-neutral request and nothing else', () => {
  it('sends the editorial prompt byte-for-byte with the schema as text, in both modes', () => {
    for (const responseFormat of ['json_object', 'json_schema'] as const) {
      const body = buildWorkersAiRequestBody(REQUEST, { responseFormat, maxCompletionTokens: 1000 });
      const messages = body.messages as Array<{ role: string; content: string }>;
      expect(messages.map(m => m.role)).toEqual(['system', 'user']);
      expect(messages[0].content).toBe(WORKERS_AI_WRAPPER_SYSTEM_PROMPT);
      expect(messages[1].content).toContain(REQUEST.prompt);
      expect(messages[1].content).toContain(JSON.stringify(REQUEST.jsonSchema));
    }
  });

  it('asks for well-formed JSON by default and for the schema only when told to', () => {
    expect(buildWorkersAiRequestBody(REQUEST, { responseFormat: 'json_object', maxCompletionTokens: 1 }).response_format)
      .toEqual({ type: 'json_object' });
    expect(buildWorkersAiRequestBody(REQUEST, { responseFormat: 'json_schema', maxCompletionTokens: 1 }).response_format)
      .toEqual({ type: 'json_schema', json_schema: { name: 'jurypress_output', schema: REQUEST.jsonSchema } });
    expect(WORKERS_AI_DEFAULT_RESPONSE_FORMAT).toBe('json_object');
  });

  it('maps the thinking budget onto Gemma\'s on/off switch', () => {
    expect(workersAiThinkingEnabled('high')).toBe(true);
    expect(workersAiThinkingEnabled('low')).toBe(false);
    const high = buildWorkersAiRequestBody(REQUEST, { responseFormat: 'json_object', maxCompletionTokens: 1 });
    const low = buildWorkersAiRequestBody({ ...REQUEST, thinkingBudget: 'low' }, { responseFormat: 'json_object', maxCompletionTokens: 1 });
    expect(high.chat_template_kwargs).toEqual({ enable_thinking: true });
    expect(low.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it('lets the caller\'s output cap win over the default, and never streams', () => {
    const editorial = buildWorkersAiRequestBody(REQUEST, { responseFormat: 'json_object', maxCompletionTokens: 32768 });
    expect(editorial.max_completion_tokens).toBe(32768);
    expect(editorial.stream).toBe(false);
    expect(editorial).not.toHaveProperty('temperature');

    const mapping = buildWorkersAiRequestBody(
      { ...REQUEST, thinkingBudget: 'low', temperature: 0.1, maxOutputTokens: 4096 },
      { responseFormat: 'json_object', maxCompletionTokens: 32768 }
    );
    expect(mapping.max_completion_tokens).toBe(4096);
    expect(mapping.temperature).toBe(0.1);
  });

  it('refuses a model identifier that is not a Workers AI path', () => {
    expect(() => assertWorkersAiModelId('@cf/google/gemma-4-26b-a4b-it')).not.toThrow();
    expect(() => assertWorkersAiModelId('@hf/nousresearch/hermes-2-pro-mistral-7b')).not.toThrow();
    for (const bad of ['gemini-3.5-flash', 'claude-opus-5', '@cf/google/../secrets', '@cf/google/gemma?x=1', '']) {
      expect(() => assertWorkersAiModelId(bad)).toThrow(LlmProviderConfigurationError);
    }
  });

  it('addresses the account\'s run endpoint for the pinned model', () => {
    expect(buildWorkersAiEndpoint('acct-1', '@cf/google/gemma-4-26b-a4b-it'))
      .toBe('https://api.cloudflare.com/client/v4/accounts/acct-1/ai/run/@cf/google/gemma-4-26b-a4b-it');
  });
});

describe('the wrapper instruction is transport plumbing, not editorial guidance', () => {
  it('states the output contract and the untrusted-input boundary', () => {
    const wrapper = WORKERS_AI_WRAPPER_SYSTEM_PROMPT.toLowerCase();
    expect(wrapper).toContain('return only the json document');
    expect(wrapper).toContain('do not wrap the json in a markdown code fence');
    expect(wrapper).toContain('never instruction');
    expect(wrapper).toContain('ignore previous instructions');
  });

  it('expresses no editorial opinion whatsoever', () => {
    // Same check the Claude wrapper passes: the instruction half must name nothing editorial.
    // The UNTRUSTED INPUT half necessarily names things like "change a score" and "external
    // article text", because naming the attack is how it is refused.
    const wrapper = WORKERS_AI_WRAPPER_SYSTEM_PROMPT.toLowerCase();
    const untrustedAt = wrapper.indexOf('untrusted input');
    expect(untrustedAt).toBeGreaterThan(-1);
    const instructions = wrapper.slice(0, untrustedAt);
    for (const editorialWord of [
      'persona', 'judge', 'jury', 'rubric', 'criteri', 'score', 'verdict', 'headline',
      'article', 'review', 'critical', 'concise', 'tone', 'voice', 'audience'
    ]) {
      expect(instructions).not.toContain(editorialWord);
    }
    expect(wrapper.slice(untrustedAt)).toContain('change a score');
    expect(wrapper.slice(untrustedAt)).toContain('external article text');
  });

  it('reads the same wrapper Claude reads, so the two are asked the same question', () => {
    const source = readFileSync('src/lib/evaluation/workers-ai-transport.ts', 'utf8');
    expect(source).toContain('buildSchemaCarryingUserPrompt(request)');
  });
});

describe('configuration is fail-closed and never inherits another provider\'s values', () => {
  it('falls back to defaults for absent or nonsensical numeric values', () => {
    expect(resolveWorkersAiTimeoutMs({})).toBe(600_000);
    expect(resolveWorkersAiTimeoutMs({ JURYPRESS_WORKERS_AI_TIMEOUT_MS: 'soon' })).toBe(600_000);
    expect(resolveWorkersAiTimeoutMs({ JURYPRESS_WORKERS_AI_TIMEOUT_MS: '-5' })).toBe(600_000);
    expect(resolveWorkersAiTimeoutMs({ JURYPRESS_WORKERS_AI_TIMEOUT_MS: '120000' })).toBe(120_000);

    expect(resolveWorkersAiMaxCompletionTokens({})).toBe(WORKERS_AI_DEFAULT_MAX_COMPLETION_TOKENS);
    expect(resolveWorkersAiMaxCompletionTokens({ JURYPRESS_WORKERS_AI_MAX_COMPLETION_TOKENS: '0' }))
      .toBe(WORKERS_AI_DEFAULT_MAX_COMPLETION_TOKENS);
    expect(resolveWorkersAiMaxCompletionTokens({ JURYPRESS_WORKERS_AI_MAX_COMPLETION_TOKENS: '16384' })).toBe(16384);
  });

  it('refuses an unknown response format instead of falling back to the default', () => {
    // Two runs in different modes must be distinguishable; a typo silently landing on the
    // default would make them look identical on the record.
    expect(resolveWorkersAiResponseFormat({})).toBe('json_object');
    expect(resolveWorkersAiResponseFormat({ JURYPRESS_WORKERS_AI_RESPONSE_FORMAT: 'json_schema' })).toBe('json_schema');
    expect(() => resolveWorkersAiResponseFormat({ JURYPRESS_WORKERS_AI_RESPONSE_FORMAT: 'text' }))
      .toThrow(LlmProviderConfigurationError);
    expect(() => resolveWorkersAiResponseFormat({ JURYPRESS_WORKERS_AI_RESPONSE_FORMAT: 'schema' }))
      .toThrow(/JURYPRESS_WORKERS_AI_RESPONSE_FORMAT/);
  });

  it('refuses to generate without both halves of the credential', async () => {
    const { impl, calls } = scriptedFetch([]);
    for (const env of [
      { WORKERS_AI_API_TOKEN: 't' },
      { CLOUDFLARE_ACCOUNT_ID: 'a' },
      { CLOUDFLARE_ACCOUNT_ID: '', WORKERS_AI_API_TOKEN: '' }
    ]) {
      const transport = new WorkersAiTransport({ env, fetchImpl: impl });
      await expect(transport.generate(REQUEST)).rejects.toThrow(LlmProviderConfigurationError);
    }
    expect(calls).toHaveLength(0);
  });
});

describe('failure classification never judges content', () => {
  const base = { status: null, errorMessages: [], timedOut: false, networkError: false, emptyResponse: false };

  it('treats auth, model and request errors as terminal', () => {
    expect(classifyWorkersAiFailure({ ...base, status: 401 })).toEqual({ category: 'AUTHENTICATION_FAILED', retryable: false });
    expect(classifyWorkersAiFailure({ ...base, status: 403 })).toEqual({ category: 'AUTHENTICATION_FAILED', retryable: false });
    expect(classifyWorkersAiFailure({ ...base, status: 404 })).toEqual({ category: 'MODEL_NOT_FOUND', retryable: false });
    expect(classifyWorkersAiFailure({ ...base, status: 400, errorMessages: ['invalid input'] }))
      .toEqual({ category: 'INVALID_REQUEST', retryable: false });
  });

  it('never retries when the API refused to return a document for its content', () => {
    // The stricter JSON mode can decline to answer because the model's document did not satisfy
    // the schema. That is content deciding whether to generate again — the one thing no
    // transport here may do — so it is terminal, and the run fails visibly instead.
    expect(classifyWorkersAiFailure({ ...base, status: 400, errorMessages: ["JSON Mode couldn't be met"] }))
      .toEqual({ category: 'JSON_MODE_NOT_MET', retryable: false });
  });

  it('treats a spent daily allocation as terminal but a rate limit as retryable', () => {
    expect(classifyWorkersAiFailure({ ...base, status: 429, errorMessages: ['Account limited: daily free tier neuron allocation exceeded'] }))
      .toEqual({ category: 'QUOTA_EXCEEDED', retryable: false });
    expect(classifyWorkersAiFailure({ ...base, status: 429, errorMessages: ['Too many requests'] }))
      .toEqual({ category: 'RATE_LIMITED', retryable: true });
  });

  it('treats outages, timeouts, network failures and empty envelopes as retryable', () => {
    expect(classifyWorkersAiFailure({ ...base, status: 503 })).toEqual({ category: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(classifyWorkersAiFailure({ ...base, status: 524 })).toEqual({ category: 'PROVIDER_UNAVAILABLE', retryable: true });
    expect(classifyWorkersAiFailure({ ...base, timedOut: true })).toEqual({ category: 'TIMEOUT', retryable: true });
    expect(classifyWorkersAiFailure({ ...base, networkError: true })).toEqual({ category: 'NETWORK_ERROR', retryable: true });
    expect(classifyWorkersAiFailure({ ...base, status: 200, emptyResponse: true })).toEqual({ category: 'EMPTY_RESPONSE', retryable: true });
  });

  it('has no classification a response body could ever reach', () => {
    // The classifier's inputs are the envelope's status and error list. There is no argument
    // that carries the assistant text, so no property of that text can influence a retry.
    const source = readFileSync('src/lib/evaluation/workers-ai-transport.ts', 'utf8');
    const signature = source.slice(
      source.indexOf('export function classifyWorkersAiFailure'),
      source.indexOf('): { category: string; retryable: boolean }')
    );
    expect(signature).not.toMatch(/content|rawResponse|parsed|text/);
  });
});

describe('metadata is read, never invented', () => {
  it('reports the served model only when the API names one', () => {
    expect(readWorkersAiModelUsed({ model: '@cf/google/gemma-4-26b-a4b-it' })).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(readWorkersAiModelUsed({ model: '  ' })).toBeNull();
    expect(readWorkersAiModelUsed({})).toBeNull();
    expect(readWorkersAiModelUsed(null)).toBeNull();
  });

  it('keeps unreported token counts null rather than zero', () => {
    expect(readWorkersAiTokenUsage(null)).toEqual({
      inputTokens: null, outputTokens: null, thinkingTokens: null, totalTokens: null, cachedInputTokens: null
    });
    expect(readWorkersAiTokenUsage({ usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } })).toEqual({
      inputTokens: 10, outputTokens: 20, thinkingTokens: null, totalTokens: 30, cachedInputTokens: null
    });
    expect(readWorkersAiTokenUsage({
      usage: {
        prompt_tokens: 10, completion_tokens: 20, total_tokens: 30,
        completion_tokens_details: { reasoning_tokens: 7 },
        prompt_tokens_details: { cached_tokens: 3 }
      }
    })).toEqual({ inputTokens: 10, outputTokens: 20, thinkingTokens: 7, totalTokens: 30, cachedInputTokens: 3 });
  });

  it('reads the assistant text verbatim and says so when it cannot', () => {
    expect(readWorkersAiResponseText({ choices: [{ message: { content: '{"a":1}' } }] }))
      .toEqual({ text: '{"a":1}', verbatim: true, shape: 'chat_completion' });
    expect(readWorkersAiResponseText({ response: '{"a":1}' }))
      .toEqual({ text: '{"a":1}', verbatim: true, shape: 'legacy_text' });
    expect(readWorkersAiResponseText({ response: { a: 1 } }))
      .toEqual({ text: '{"a":1}', verbatim: false, shape: 'legacy_object' });
    expect(readWorkersAiResponseText({ choices: [{ message: { content: null } }] }))
      .toEqual({ text: null, verbatim: true, shape: 'none' });
    expect(readWorkersAiResponseText(null).text).toBeNull();
  });
});

describe('one HTTP call, one response, no agency', () => {
  it('persists the response verbatim with provenance that names Workers AI', async () => {
    const body = '{"judges":[]}';
    const { impl, calls } = scriptedFetch([{ status: 200, body: envelope(body), headers: { 'cf-ray': 'ray-1' } }]);
    const transport = new WorkersAiTransport({ env: ENV, fetchImpl: impl });

    const result = await transport.generate(REQUEST);

    expect(result.provider).toBe('cloudflare-workers-ai');
    expect(result.rawResponse).toBe(body);
    expect(result.parsed).toEqual({ judges: [] });
    expect(result.requestedModel).toBe(REQUEST.requestedModel);
    expect(result.modelUsed).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(result.tokenUsage).toEqual({
      inputTokens: 21000, outputTokens: 9000, thinkingTokens: 5000, totalTokens: 30000, cachedInputTokens: null
    });
    expect(result.attemptCount).toBe(1);
    expect(result.responseCapture).toEqual({ type: 'api_response_text', verbatim: true, providerExecutionLogStored: false });
    expect(result.transportMetadata).toMatchObject({
      engineVersion: WORKERS_AI_ENGINE_VERSION,
      responseFormat: 'json_object',
      thinkingEnabled: true,
      maxCompletionTokens: WORKERS_AI_DEFAULT_MAX_COMPLETION_TOKENS,
      finishReason: 'stop',
      responseShape: 'chat_completion',
      httpStatus: 200,
      cfRay: 'ray-1',
      fencedJsonDetected: false,
      structuralRecovery: null
    });

    // Exactly one request, to the account's run endpoint, bearing the token and nothing else.
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/ai/run/${REQUEST.requestedModel}`);
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe(`Bearer ${ENV.WORKERS_AI_API_TOKEN}`);
    const sent = JSON.parse(calls[0].init.body as string);
    expect(sent.response_format).toEqual({ type: 'json_object' });
    expect(sent.chat_template_kwargs).toEqual({ enable_thinking: true });
  });

  it('accepts a defective response as a result and never asks again', async () => {
    // Under Gemini a schema-violating or unparseable body is persisted and judged downstream.
    // The same must hold here: content is a result, never a reason for a second call.
    const junk = 'I cannot produce that document.';
    const { impl, calls } = scriptedFetch([{ status: 200, body: envelope(junk) }]);
    const transport = new WorkersAiTransport({ env: ENV, fetchImpl: impl });

    const result = await transport.generate(REQUEST);
    expect(result.rawResponse).toBe(junk);
    expect(result.parsed).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('records a fenced or truncated document as observation, not as a retry', async () => {
    const fenced = '```json\n{"judges":[]}\n```';
    const truncated = '{"judges":[{"id":"alex"}';
    const { impl } = scriptedFetch([
      { status: 200, body: envelope(fenced) },
      { status: 200, body: envelope(truncated, { choices: [{ index: 0, message: { role: 'assistant', content: truncated }, finish_reason: 'length' }] }) }
    ]);
    const transport = new WorkersAiTransport({ env: ENV, fetchImpl: impl });

    const first = await transport.generate(REQUEST);
    expect(first.rawResponse).toBe(fenced);
    expect(first.parsed).toBeNull();
    expect(first.transportMetadata.fencedJsonDetected).toBe(true);

    const second = await transport.generate(REQUEST);
    expect(second.rawResponse).toBe(truncated);
    expect(second.parsed).toEqual({ judges: [{ id: 'alex' }] });
    // The inner object was closed; only the array and the document were left open.
    expect(second.transportMetadata.structuralRecovery).toBe(']}');
    expect(second.transportMetadata.finishReason).toBe('length');
  });

  it('retries a retryable failure and then returns the response it finally obtained', async () => {
    const { impl, calls } = scriptedFetch([
      { status: 503, body: { success: false, errors: [{ code: 5000, message: 'upstream unavailable' }] } },
      { status: 429, body: { success: false, errors: [{ code: 3030, message: 'Too many requests' }] }, headers: { 'retry-after': '1' } },
      { status: 200, body: envelope('{"ok":true}') }
    ]);
    const transport = new WorkersAiTransport({ env: ENV, fetchImpl: impl });

    const result = await transport.generate({ ...REQUEST, maxAttempts: { primary: 3, fallback: 0 } });
    expect(result.parsed).toEqual({ ok: true });
    expect(result.attemptCount).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it('stops at once on a terminal failure and reports the category, never the credential', async () => {
    const { impl, calls } = scriptedFetch([
      { status: 401, body: { success: false, errors: [{ code: 10000, message: 'Authentication error' }] } }
    ]);
    const transport = new WorkersAiTransport({ env: ENV, fetchImpl: impl });

    let caught: unknown;
    try {
      await transport.generate({ ...REQUEST, maxAttempts: { primary: 3, fallback: 0 } });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(WorkersAiTransportError);
    const error = caught as WorkersAiTransportError;
    expect(error.category).toBe('AUTHENTICATION_FAILED');
    expect(error.attemptCount).toBe(1);
    expect(error.message).toContain('HTTP 401');
    expect(error.message).not.toContain(ENV.WORKERS_AI_API_TOKEN);
    expect(error.message).not.toContain(ENV.CLOUDFLARE_ACCOUNT_ID);
    expect(calls).toHaveLength(1);
  });

  it('never retries when the stricter JSON mode refused to return a document', async () => {
    const { impl, calls } = scriptedFetch([
      { status: 400, body: { success: false, errors: [{ code: 3040, message: "JSON Mode couldn't be met" }] } }
    ]);
    const transport = new WorkersAiTransport({
      env: { ...ENV, JURYPRESS_WORKERS_AI_RESPONSE_FORMAT: 'json_schema' },
      fetchImpl: impl
    });

    await expect(transport.generate({ ...REQUEST, maxAttempts: { primary: 3, fallback: 0 } }))
      .rejects.toThrow(/JSON_MODE_NOT_MET/);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(calls[0].init.body as string).response_format.type).toBe('json_schema');
  });

  it('exhausts the attempt budget on a persistent outage and throws rather than falling back', async () => {
    const { impl, calls } = scriptedFetch([
      { status: 502 }, { status: 502 }
    ]);
    const transport = new WorkersAiTransport({ env: ENV, fetchImpl: impl });

    await expect(transport.generate({ ...REQUEST, maxAttempts: { primary: 2, fallback: 5 } }))
      .rejects.toThrow(/PROVIDER_UNAVAILABLE/);
    // `fallback` is Gemini's second credential route. This provider has one route, so the
    // budget it ignores must not quietly become extra attempts.
    expect(calls).toHaveLength(2);
  });

  it('treats a successful envelope with no assistant text as a retryable transport failure', async () => {
    const { impl, calls } = scriptedFetch([
      { status: 200, body: envelope(null) },
      { status: 200, body: envelope('{"ok":true}') }
    ]);
    const transport = new WorkersAiTransport({ env: ENV, fetchImpl: impl });

    const result = await transport.generate({ ...REQUEST, maxAttempts: { primary: 2, fallback: 0 } });
    expect(result.parsed).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
  });

  it('cannot reach the Gemini or Claude transports even if something asked it to', () => {
    const source = readFileSync('src/lib/evaluation/workers-ai-transport.ts', 'utf8');
    const imports = source.match(/^\s*import[\s\S]*?from\s+'[^']+';/gm)?.join('\n') ?? '';
    expect(imports).not.toMatch(/gemini/i);
    expect(imports).not.toMatch(/claude/i);
    expect(source).not.toContain('generateWithFailover');
    expect(source).not.toContain('GoogleGenAI');
    expect(source).not.toContain('ClaudeCodeTransport');
    // No SDK either: the pipeline runs on a GitHub runner, and a bare fetch is the whole client.
    expect(imports).not.toMatch(/cloudflare|workers-ai-provider|openai/i);
  });
});
