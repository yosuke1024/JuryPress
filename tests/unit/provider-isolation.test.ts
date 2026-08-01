import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { GenerationRecordSchema } from '../../src/schemas/generation-record';
import { buildInitialRecord } from '../../src/lib/generation/record-store';
import type { LlmGenerationRequest, LlmTransport, RawTransportResult } from '../../src/lib/evaluation/llm-transport';

/**
 * The properties that make a provider comparison mean anything:
 *
 *   - one run, one provider, decided before the response exists and recorded with it;
 *   - a failure in one provider is never covered by the other;
 *   - a stored response is never replaced by a different provider's;
 *   - records written before providers existed keep loading, without being backfilled with a
 *     provider nobody can prove they used.
 */

function fakeResult(provider: 'gemini' | 'anthropic-claude-code'): RawTransportResult {
  return {
    rawResponse: '{"ok":true}',
    parsed: { ok: true },
    provider,
    requestedModel: 'm',
    modelUsed: null,
    tokenUsage: {
      inputTokens: null, outputTokens: null, thinkingTokens: null,
      totalTokens: null, cachedInputTokens: null
    },
    attemptCount: 1,
    responseCapture: { type: 'api_response_text', verbatim: true, providerExecutionLogStored: false },
    transportMetadata: {}
  };
}

class RecordingTransport implements LlmTransport {
  public calls: LlmGenerationRequest[] = [];
  constructor(
    public readonly provider: 'gemini' | 'anthropic-claude-code',
    private readonly behaviour: 'succeed' | 'fail' = 'succeed'
  ) {}
  async generate(request: LlmGenerationRequest): Promise<RawTransportResult> {
    this.calls.push(request);
    if (this.behaviour === 'fail') throw new Error(`${this.provider} transport failed`);
    return fakeResult(this.provider);
  }
}

describe('no provider can rescue another', () => {
  it('keeps the two transports structurally unaware of each other', () => {
    // A fallback cannot be added by accident if neither module can reach the other's code. Prose
    // may compare them — the design is explained by contrast — but neither may import or call
    // the other, which is what an actual fallback would require.
    const importsOf = (file: string) =>
      readFileSync(file, 'utf8').match(/^\s*import[\s\S]*?from\s+'[^']+';/gm)?.join('\n') ?? '';

    const geminiImports = importsOf('src/lib/evaluation/gemini-transport.ts');
    const claudeImports = importsOf('src/lib/evaluation/claude-code-transport.ts');

    expect(geminiImports).not.toMatch(/claude/i);
    expect(claudeImports).not.toMatch(/gemini/i);

    // And neither names the other's exported symbols anywhere in its body.
    const claudeSource = readFileSync('src/lib/evaluation/claude-code-transport.ts', 'utf8');
    const geminiSource = readFileSync('src/lib/evaluation/gemini-transport.ts', 'utf8');
    expect(claudeSource).not.toContain('generateWithFailover');
    expect(claudeSource).not.toContain('GoogleGenAI');
    expect(geminiSource).not.toContain('ClaudeCodeTransport');
  });

  it('leaves the factory with no failure path between providers', () => {
    const factory = readFileSync('src/lib/evaluation/transport-factory.ts', 'utf8');
    // No try/catch, so a constructor failure cannot be swallowed into the other branch.
    expect(factory).not.toContain('catch');
  });

  it('propagates a transport failure instead of trying the other provider', async () => {
    const claude = new RecordingTransport('anthropic-claude-code', 'fail');
    const gemini = new RecordingTransport('gemini');

    await expect(claude.generate({
      requestedModel: 'claude-opus-5', prompt: 'p', jsonSchema: {}, thinkingBudget: 'high'
    })).rejects.toThrow(/anthropic-claude-code transport failed/);

    // Nothing anywhere reached for the other provider on the way out.
    expect(gemini.calls).toHaveLength(0);
  });
});

describe('an evaluator that will not generate needs no generation model', () => {
  it('constructs under Claude with no model configured', async () => {
    // The site build and the publish path both construct an Evaluator purely to recalculate
    // scores from a stored record. Resolving a generation model eagerly would let a provider
    // that has no default fail a build over a variable that build was never going to use.
    const { Evaluator } = await import('../../src/lib/evaluation/evaluator');
    const previousProvider = process.env.JURYPRESS_LLM_PROVIDER;
    const previousModel = process.env.JURYPRESS_GENERATION_MODEL;
    process.env.JURYPRESS_LLM_PROVIDER = 'anthropic-claude-code';
    delete process.env.JURYPRESS_GENERATION_MODEL;
    try {
      const evaluator = new Evaluator();
      expect(evaluator.getProvider()).toBe('anthropic-claude-code');
    } finally {
      if (previousProvider === undefined) delete process.env.JURYPRESS_LLM_PROVIDER;
      else process.env.JURYPRESS_LLM_PROVIDER = previousProvider;
      if (previousModel !== undefined) process.env.JURYPRESS_GENERATION_MODEL = previousModel;
    }
  });
});

describe('a run is pinned to the provider that answered it', () => {
  const base = {
    recordId: 'season-2-2026-08-01-daily',
    candidateId: 'c1',
    runKey: 'season-2-2026-08-01-daily',
    canonicalUrl: null,
    candidateName: 'thing',
    slug: 'thing',
    receivedAt: '2026-08-01T00:00:00.000Z',
    model: 'm',
    modelVersion: null,
    promptVersion: '4.4.0',
    promptHash: 'a'.repeat(64),
    rawResponse: '{"ok":true}',
    originalContent: { ok: true },
    usage: {
      promptTokens: null, completionTokens: null, totalTokens: null,
      thinkingTokens: null, cachedInputTokens: null
    },
    route: null
  };

  it('records which provider produced the response', () => {
    const record = buildInitialRecord({
      ...base,
      provider: {
        name: 'anthropic-claude-code',
        requestedModel: 'claude-opus-5',
        modelUsed: 'claude-opus-5-20260101',
        authenticationMode: 'subscription_oauth',
        engineVersion: 'claude-code-transport-v1',
        responseCapture: {
          type: 'cli_final_result_text', verbatim: true, providerExecutionLogStored: false
        },
        transportMetadata: { sessionId: 's1', numTurns: 1 }
      }
    });

    expect(record.generation.provider?.name).toBe('anthropic-claude-code');
    expect(record.generation.provider?.modelUsed).toBe('claude-opus-5-20260101');
    expect(record.generation.provider?.responseCapture?.type).toBe('cli_final_result_text');
    // Provider-specific provenance is kept opaque rather than mapped onto Gemini's vocabulary.
    expect(record.generation.provider?.transportMetadata).toEqual({ sessionId: 's1', numTurns: 1 });
  });

  it('leaves a Gemini record byte-identical to a pre-provider one', () => {
    const record = buildInitialRecord({
      ...base,
      provider: {
        name: 'gemini',
        requestedModel: 'gemini-3.5-flash',
        modelUsed: 'gemini-3.5-flash',
        authenticationMode: 'api_key',
        engineVersion: null,
        responseCapture: {
          type: 'api_response_text', verbatim: true, providerExecutionLogStored: false
        },
        transportMetadata: {}
      }
    });
    // The historical revision-0 source is preserved for Gemini specifically. Renaming it would
    // have made every stored record disagree with every new one for no gain.
    expect(record.editorial.revisions[0].source).toBe('gemini');
  });

  it('refuses to write "gemini" on a response Gemini did not produce', () => {
    const record = buildInitialRecord({
      ...base,
      provider: {
        name: 'anthropic-claude-code',
        requestedModel: 'claude-opus-5',
        modelUsed: null,
        authenticationMode: 'subscription_oauth',
        engineVersion: 'claude-code-transport-v1',
        responseCapture: {
          type: 'cli_final_result_text', verbatim: true, providerExecutionLogStored: false
        },
        transportMetadata: {}
      }
    });
    expect(record.editorial.revisions[0].source).toBe('model');
  });

  it('still rejects a human-authored revision 0', () => {
    // Widening the enum must not have widened what may claim to be the model's own judgment.
    const record = buildInitialRecord(base) as any;
    const tampered = structuredClone(record);
    tampered.editorial.revisions[0].source = 'human_edited';
    expect(() => GenerationRecordSchema.parse(tampered)).toThrow(/Revision 0/);
  });
});

describe('recorded provenance is constrained and frozen', () => {
  it('accepts only providers the code can actually route to', async () => {
    // The schema spells the enum literally to stay import-free, so this is what keeps the two
    // lists honest. A record naming a provider with no transport is unreadable provenance.
    const { ProviderProvenanceSchema } = await import('../../src/schemas/generation-record');
    const { LLM_PROVIDERS } = await import('../../src/lib/evaluation/llm-transport');
    const schemaNames = (ProviderProvenanceSchema.shape.name as any).options as string[];
    expect([...schemaNames].sort()).toEqual([...LLM_PROVIDERS].sort());
  });

  it('refuses a rewrite that changes or removes the provider block', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const { writeRecord, recordsDir } = await import('../../src/lib/generation/record-store');

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-provider-immutable-'));
    fs.mkdirSync(recordsDir(root), { recursive: true });
    try {
      const record = buildInitialRecord({
        recordId: 'season-2-2026-08-01-daily',
        candidateId: 'c', runKey: 'season-2-2026-08-01-daily', canonicalUrl: null,
        candidateName: null, slug: 's', receivedAt: '2026-08-01T00:00:00.000Z',
        model: 'claude-opus-5', modelVersion: null, promptVersion: '4.4.0',
        promptHash: 'a'.repeat(64), rawResponse: '{"ok":true}', originalContent: { ok: true },
        usage: {
          promptTokens: null, completionTokens: null, totalTokens: null,
          thinkingTokens: null, cachedInputTokens: null
        },
        route: null,
        provider: {
          name: 'anthropic-claude-code', requestedModel: 'claude-opus-5', modelUsed: null,
          authenticationMode: 'subscription_oauth', engineVersion: 'claude-code-transport-v1',
          responseCapture: {
            type: 'cli_final_result_text', verbatim: true, providerExecutionLogStored: false
          },
          transportMetadata: { sessionId: 's1' }
        }
      });
      writeRecord(root, record);

      // Rewriting who answered would let a later step relabel an article's origin — which is
      // exactly what a provider comparison must never allow.
      const relabelled: any = structuredClone(record);
      relabelled.generation.provider.name = 'gemini';
      expect(() => writeRecord(root, relabelled)).toThrow(/generation\.provider .* is immutable/);

      // Removing it is the same defect wearing a different hat.
      const stripped: any = structuredClone(record);
      delete stripped.generation.provider;
      expect(() => writeRecord(root, stripped)).toThrow(/generation\.provider .* is immutable/);

      // So is quietly changing what the stored rawResponse is claimed to be.
      const recaptioned: any = structuredClone(record);
      recaptioned.generation.provider.responseCapture.verbatim = false;
      expect(() => writeRecord(root, recaptioned)).toThrow(/generation\.provider .* is immutable/);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('guards the record against Anthropic credential values', async () => {
    const { SECRET_ENV_VARS } = await import('../../src/lib/generation/record-store');
    expect(SECRET_ENV_VARS).toContain('CLAUDE_CODE_OAUTH_TOKEN');
    expect(SECRET_ENV_VARS).toContain('ANTHROPIC_API_KEY');
  });
});

describe('records written before providers existed keep loading', () => {
  it('parses a record with no provider block and backfills nothing', () => {
    const record = buildInitialRecord({
      recordId: 'season-2-2026-07-01-daily',
      candidateId: 'c1',
      runKey: 'season-2-2026-07-01-daily',
      canonicalUrl: null,
      candidateName: 'legacy',
      slug: 'legacy',
      receivedAt: '2026-07-01T00:00:00.000Z',
      model: 'gemini-3.5-flash',
      modelVersion: 'gemini-3.5-flash',
      promptVersion: '4.4.0',
      promptHash: 'b'.repeat(64),
      rawResponse: '{"ok":true}',
      originalContent: { ok: true },
      usage: {
        promptTokens: 1, completionTokens: 2, totalTokens: 3,
        thinkingTokens: null, cachedInputTokens: null
      },
      route: {
        requestedModel: 'gemini-3.5-flash', thinkingLevel: 'HIGH', successfulRoute: 'primary',
        failoverUsed: false, primaryAttempts: 1, fallbackAttempts: 0, totalAttempts: 1,
        charactersSentToModel: 10
      }
    });

    const reparsed = GenerationRecordSchema.parse(JSON.parse(JSON.stringify(record)));
    // Absent, not defaulted. A reader infers "written before providers were selectable" from
    // the absence; inventing `provider: gemini` here would manufacture provenance the record
    // never actually had.
    expect(reparsed.generation.provider).toBeUndefined();
    expect(reparsed.editorial.revisions[0].source).toBe('gemini');
  });

  it('accepts a stored record whose evidence mapping predates provider recording', () => {
    const record: any = buildInitialRecord({
      recordId: 'r', candidateId: 'c', runKey: 'r', canonicalUrl: null, candidateName: null,
      slug: 's', receivedAt: '2026-07-01T00:00:00.000Z', model: null, modelVersion: null,
      promptVersion: '4.4.0', promptHash: null, rawResponse: '{}', originalContent: {},
      usage: {
        promptTokens: null, completionTokens: null, totalTokens: null,
        thinkingTokens: null, cachedInputTokens: null
      },
      route: null
    });
    record.evidenceMapping = {
      status: 'succeeded',
      attemptedAt: '2026-07-01T01:00:00.000Z',
      articleHash: 'c'.repeat(64),
      mappingPromptVersion: '1.0.0',
      model: 'gemini-3.5-flash',
      modelVersion: null,
      failureCategory: null,
      usage: null,
      map: { entries: [] }
    };
    const parsed = GenerationRecordSchema.parse(JSON.parse(JSON.stringify(record)));
    expect(parsed.evidenceMapping?.provider).toBeUndefined();
  });
});
