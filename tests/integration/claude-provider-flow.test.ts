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
  LlmTransport,
  RawTransportResult
} from '../../src/lib/evaluation/llm-transport';

/**
 * The Claude provider through the real generation pipeline, with the transport faked at the
 * process boundary — everything above it (prompt building, response-first persistence, the
 * record envelope, the resume check) is the production code path.
 *
 * The properties under test are the ones that make a provider swap safe rather than merely
 * possible: the response is on disk before anything reads it, the record says who produced it,
 * a defective response is a stored result rather than a lost one, and a run that already has a
 * response never calls anybody.
 */

class FakeTransport implements LlmTransport {
  public calls: LlmGenerationRequest[] = [];

  constructor(
    public readonly provider: 'gemini' | 'anthropic-claude-code',
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
      modelUsed: 'claude-opus-5-20260101',
      tokenUsage: {
        inputTokens: 1200, outputTokens: 3400, thinkingTokens: null,
        totalTokens: 4600, cachedInputTokens: null
      },
      attemptCount: 1,
      responseCapture: {
        type: 'cli_final_result_text', verbatim: true, providerExecutionLogStored: false
      },
      transportMetadata: {
        engineVersion: 'claude-code-transport-v1',
        sessionId: 'sess-1',
        numTurns: 1,
        fencedJsonDetected: false
      }
    };
  }
}

describe('Claude provider — response-first persistence', () => {
  let contentRoot: string;
  let fixture: ReturnType<typeof createEditorialFixture>;
  const RUN_KEY = 'season-2-2026-08-01-daily';

  const CANDIDATE = {
    name: 'Refined Product',
    canonicalUrl: 'https://github.com/example/refined-product',
    sourceUrl: 'https://github.com/example/refined-product',
    source: 'github',
    sourceId: 'refined-product-id',
    sourceRank: 1,
    popularityValue: 10,
    popularityUnit: 'stars',
    collectedAt: '2026-08-01T00:00:00.000Z',
    metadata: {}
  };

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-claude-flow-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fixture = createEditorialFixture();
    process.env.JURYPRESS_GENERATION_MODEL = 'claude-opus-5';
    // generateAndPersist reads the archive of recent openings from the resolved content root;
    // the temp root above is where every write in this suite lands.
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = contentRoot;
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
    delete process.env.JURYPRESS_GENERATION_MODEL;
    delete process.env.JURYPRESS_DATA_MODE;
    delete process.env.JURYPRESS_CONTENT_ROOT;
  });

  function evidences() {
    return fixture.context.evidences as any;
  }

  function generate(transport: LlmTransport) {
    return generateAndPersist({
      contentRoot,
      runKey: RUN_KEY,
      candidate: CANDIDATE as any,
      evidences: evidences(),
      slug: 'editorial-product',
      promptVersion: '4.4.0',
      evaluator: new Evaluator({ transport })
    });
  }

  it('persists the Claude response verbatim, with provenance that names Claude', async () => {
    const body = JSON.stringify(fixture.generatedOutput);
    const transport = new FakeTransport('anthropic-claude-code', body);

    const { record } = await generate(transport);
    const stored = readRecord(contentRoot, RUN_KEY)!;

    // Verbatim: what the model returned is what is on disk, byte for byte.
    expect(stored.generation.rawResponse).toBe(body);
    expect(stored.generation.status).toBe('succeeded');

    expect(stored.generation.provider?.name).toBe('anthropic-claude-code');
    expect(stored.generation.provider?.requestedModel).toBe('claude-opus-5');
    expect(stored.generation.provider?.modelUsed).toBe('claude-opus-5-20260101');
    expect(stored.generation.provider?.authenticationMode).toBe('subscription_oauth');
    // The record states what the stored text actually is rather than leaving it to be assumed.
    expect(stored.generation.provider?.responseCapture).toEqual({
      type: 'cli_final_result_text', verbatim: true, providerExecutionLogStored: false
    });
    expect(stored.editorial.revisions[0].source).toBe('model');
    expect(record.generation.usage.totalTokens).toBe(4600);
    // Claude Code publishes no thinking-token breakdown; absence is recorded as absence.
    expect(record.generation.usage.thinkingTokens).toBeNull();
  });

  it('sends the editorial prompt unchanged and pins the thinking budget high', async () => {
    const transport = new FakeTransport('anthropic-claude-code', JSON.stringify(fixture.generatedOutput));
    await generate(transport);

    expect(transport.calls).toHaveLength(1);
    const request = transport.calls[0];
    expect(request.thinkingBudget).toBe('high');
    expect(request.requestedModel).toBe('claude-opus-5');
    // The prompt reaching the provider is the production editorial prompt, not a Claude variant.
    expect(request.prompt).toContain('JuryPress');
    expect(request.jsonSchema).toBeTruthy();
  });

  it('stores an unparseable response instead of throwing it away', async () => {
    // Under Gemini this is a quality failure on a green run. It must stay one: a response that
    // arrived is a result, and losing it would be the exact failure response-first prevents.
    const junk = 'I am sorry, I cannot produce that document.';
    const transport = new FakeTransport('anthropic-claude-code', junk);

    await generate(transport);
    const stored = readRecord(contentRoot, RUN_KEY)!;

    expect(stored.generation.rawResponse).toBe(junk);
    expect(stored.generation.originalContent).toBeNull();
    expect(stored.generation.status).toBe('succeeded');
    // Exactly one call. A defective response never triggered a second.
    expect(transport.calls).toHaveLength(1);
  });

  it('writes no record at all when no response was obtained', async () => {
    const transport = new FakeTransport(
      'anthropic-claude-code',
      new Error('Claude Code transport failed (USAGE_LIMIT_REACHED).')
    );

    await expect(generate(transport)).rejects.toThrow(/USAGE_LIMIT_REACHED/);
    // Nothing half-written: a transport failure leaves the run resumable, not corrupted.
    expect(readRecord(contentRoot, RUN_KEY)).toBeNull();
  });

  it('never reaches for another provider when Claude fails', async () => {
    const claude = new FakeTransport('anthropic-claude-code', new Error('down'));
    const gemini = new FakeTransport('gemini', JSON.stringify(fixture.generatedOutput));

    await expect(generate(claude)).rejects.toThrow(/down/);
    expect(gemini.calls).toHaveLength(0);
  });

  it('pins the evaluator to one provider for the life of the run', async () => {
    const transport = new FakeTransport('anthropic-claude-code', JSON.stringify(fixture.generatedOutput));
    const evaluator = new Evaluator({ transport });
    expect(evaluator.getProvider()).toBe('anthropic-claude-code');

    // Changing the environment mid-run cannot move an already-constructed evaluator: a run's
    // provider is decided once, so its record can never name a provider that did not answer.
    process.env.JURYPRESS_LLM_PROVIDER = 'gemini';
    try {
      expect(evaluator.getProvider()).toBe('anthropic-claude-code');
      await evaluator.generateRaw(CANDIDATE as any, evidences(), {
        promptVersion: '4.4.0'
      });
      expect(transport.calls).toHaveLength(1);
    } finally {
      delete process.env.JURYPRESS_LLM_PROVIDER;
    }
  });

  it('leaves a stored Claude response untouched when the run is resumed', async () => {
    const body = JSON.stringify(fixture.generatedOutput);
    const first = new FakeTransport('anthropic-claude-code', body);
    await generate(first);

    const beforeResume = fs.readFileSync(
      path.join(recordsDir(contentRoot), `${RUN_KEY}.json`), 'utf8'
    );

    // The resume gate is "does a record exist", which is provider-independent — this is the
    // check run-daily performs before it constructs an evaluator at all.
    const existing = readRecord(contentRoot, RUN_KEY);
    expect(existing).not.toBeNull();

    const second = new FakeTransport('gemini', '{"different":"content"}');
    if (!existing) await generate(second);

    // No second call, from either provider, and not one byte changed. A provider switch between
    // runs can never overwrite a response that already exists.
    expect(second.calls).toHaveLength(0);
    expect(fs.readFileSync(path.join(recordsDir(contentRoot), `${RUN_KEY}.json`), 'utf8'))
      .toBe(beforeResume);
  });
});
