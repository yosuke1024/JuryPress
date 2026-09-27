import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createEditorialFixture } from '../fixtures/refined-review';
import { generateAndPersist } from '../../src/lib/generation/pipeline';
import { readRecord, recordsDir } from '../../src/lib/generation/record-store';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import type {
  LlmGenerationRequest,
  LlmProvider,
  LlmTransport,
  RawTransportResult
} from '../../src/lib/evaluation/llm-transport';

/**
 * The Workers AI provider through the real generation pipeline, with the transport faked at the
 * HTTP boundary — everything above it (prompt building, response-first persistence, the record
 * envelope) is the production code path.
 *
 * The Claude flow suite already proves the provider boundary holds for a second provider. This
 * suite is narrower: it proves the THIRD provider's provenance survives the record schema and
 * the record store's write path — a record naming `cloudflare-workers-ai` parses, is written,
 * and marks its revision as model output rather than as Gemini's.
 */

class FakeTransport implements LlmTransport {
  public calls: LlmGenerationRequest[] = [];

  constructor(
    public readonly provider: LlmProvider,
    private readonly rawResponse: string | Error
  ) {}

  async generate(request: LlmGenerationRequest): Promise<RawTransportResult> {
    this.calls.push(request);
    if (this.rawResponse instanceof Error) throw this.rawResponse;

    let parsed: unknown | null = null;
    try { parsed = JSON.parse(this.rawResponse); } catch { parsed = null; }

    return {
      rawResponse: this.rawResponse,
      parsed,
      provider: this.provider,
      requestedModel: request.requestedModel,
      modelUsed: '@cf/google/gemma-4-26b-a4b-it',
      tokenUsage: {
        inputTokens: 21000, outputTokens: 9000, thinkingTokens: 5000,
        totalTokens: 30000, cachedInputTokens: null
      },
      attemptCount: 1,
      responseCapture: {
        type: 'api_response_text', verbatim: true, providerExecutionLogStored: false
      },
      transportMetadata: {
        engineVersion: 'workers-ai-transport-v1',
        responseFormat: 'json_object',
        thinkingEnabled: true,
        finishReason: 'stop',
        fencedJsonDetected: false,
        structuralRecovery: null
      }
    };
  }
}

describe('Workers AI provider — response-first persistence', () => {
  let contentRoot: string;
  let fixture: ReturnType<typeof createEditorialFixture>;
  const RUN_KEY = 'season-2-2026-09-27-daily';

  const CANDIDATE = {
    name: 'Refined Product',
    canonicalUrl: 'https://github.com/example/refined-product',
    sourceUrl: 'https://github.com/example/refined-product',
    source: 'github',
    sourceId: 'refined-product-id',
    sourceRank: 1,
    popularityValue: 10,
    popularityUnit: 'stars',
    collectedAt: '2026-09-27T00:00:00.000Z',
    metadata: {}
  };

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-workers-ai-flow-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fixture = createEditorialFixture();
    process.env.JURYPRESS_GENERATION_MODEL = '@cf/google/gemma-4-26b-a4b-it';
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = contentRoot;
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
    delete process.env.JURYPRESS_GENERATION_MODEL;
    delete process.env.JURYPRESS_DATA_MODE;
    delete process.env.JURYPRESS_CONTENT_ROOT;
  });

  function generate(transport: LlmTransport) {
    return generateAndPersist({
      contentRoot,
      runKey: RUN_KEY,
      candidate: CANDIDATE as any,
      evidences: fixture.context.evidences as any,
      slug: 'editorial-product',
      promptVersion: '4.4.0',
      evaluator: new Evaluator({ transport })
    });
  }

  it('persists the response verbatim, with provenance that names Workers AI', async () => {
    const body = JSON.stringify(fixture.generatedOutput);
    const transport = new FakeTransport('cloudflare-workers-ai', body);

    const { record } = await generate(transport);
    const stored = readRecord(contentRoot, RUN_KEY)!;

    expect(stored.generation.rawResponse).toBe(body);
    expect(stored.generation.status).toBe('succeeded');
    expect(stored.generation.provider?.name).toBe('cloudflare-workers-ai');
    expect(stored.generation.provider?.requestedModel).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(stored.generation.provider?.modelUsed).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(stored.generation.provider?.authenticationMode).toBe('api_token');
    expect(stored.generation.provider?.engineVersion).toBe('workers-ai-transport-v1');
    expect(stored.generation.provider?.responseCapture).toEqual({
      type: 'api_response_text', verbatim: true, providerExecutionLogStored: false
    });
    // Provider-specific provenance is stored as the transport reported it, not translated.
    expect(stored.generation.provider?.transportMetadata).toMatchObject({
      responseFormat: 'json_object', thinkingEnabled: true
    });
    // Not Gemini's response, so not Gemini's historical revision source.
    expect(stored.editorial.revisions[0].source).toBe('model');
    // Thinking tokens ARE reported by this provider, and land where Gemini's do.
    expect(record.generation.usage.thinkingTokens).toBe(5000);
    expect(record.generation.usage.totalTokens).toBe(30000);
    // No credential route exists here, so no failover story is invented for the record.
    expect(stored.generation.route?.failoverUsed).toBe(false);
    expect(stored.generation.route?.successfulRoute).toBeNull();
    expect(stored.generation.route?.primaryAttempts).toBe(1);
  });

  it('sends the production editorial prompt with the thinking budget pinned high', async () => {
    const transport = new FakeTransport('cloudflare-workers-ai', JSON.stringify(fixture.generatedOutput));
    await generate(transport);

    expect(transport.calls).toHaveLength(1);
    expect(transport.calls[0].thinkingBudget).toBe('high');
    expect(transport.calls[0].requestedModel).toBe('@cf/google/gemma-4-26b-a4b-it');
    expect(transport.calls[0].prompt).toContain('JuryPress');
  });

  it('stores an unparseable response instead of throwing it away', async () => {
    const junk = 'Here is your review: {not json';
    const transport = new FakeTransport('cloudflare-workers-ai', junk);

    await generate(transport);
    const stored = readRecord(contentRoot, RUN_KEY)!;

    expect(stored.generation.rawResponse).toBe(junk);
    expect(stored.generation.originalContent).toBeNull();
    expect(stored.generation.status).toBe('succeeded');
    expect(transport.calls).toHaveLength(1);
  });

  it('writes no record at all when no response was obtained, and reaches for nobody else', async () => {
    const workersAi = new FakeTransport(
      'cloudflare-workers-ai',
      new Error('Workers AI transport failed (PROVIDER_UNAVAILABLE): HTTP 503.')
    );
    const gemini = new FakeTransport('gemini', JSON.stringify(fixture.generatedOutput));

    await expect(generate(workersAi)).rejects.toThrow(/PROVIDER_UNAVAILABLE/);
    expect(readRecord(contentRoot, RUN_KEY)).toBeNull();
    expect(gemini.calls).toHaveLength(0);
  });
});
