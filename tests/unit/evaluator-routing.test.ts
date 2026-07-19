import { vi, describe, it, expect, beforeEach } from 'vitest';
import { Evaluator, GeminiEvaluationExhaustedError } from '../../src/lib/evaluation/evaluator';

const primaryMock = vi.fn();
const fallbackMock = vi.fn();

vi.mock('@google/genai', () => {
  class MockGoogleGenAI {
    public apiKey: string;
    public models: any;
    constructor(config: { apiKey: string }) {
      this.apiKey = config.apiKey;
      this.models = {
        generateContent: async (args: any) => {
          if (this.apiKey === 'PRIMARY_KEY') {
            return primaryMock(args);
          } else if (this.apiKey === 'FALLBACK_KEY') {
            return fallbackMock(args);
          } else {
            throw new Error(`Unknown API Key in mock: ${this.apiKey}`);
          }
        }
      };
    }
  }

  return {
    GoogleGenAI: MockGoogleGenAI,
    // Mirrors the SDK enum so buildGenerationConfig resolves the real value under test.
    ThinkingLevel: {
      THINKING_LEVEL_UNSPECIFIED: 'THINKING_LEVEL_UNSPECIFIED',
      MINIMAL: 'MINIMAL',
      LOW: 'LOW',
      MEDIUM: 'MEDIUM',
      HIGH: 'HIGH'
    }
  };
});

import { segmentStatementsStrict } from '../../src/lib/evaluation/public-claims';

/**
 * Builds a fully statement-covered mock generation output. Every public field is a single
 * `unverified` statement carrying absence wording, so the whole output satisfies the
 * statement-coverage contract that verifyRules now enforces during generation, without
 * needing evidence citations. Text varies per judge/criterion to keep personas distinct.
 */
function buildMockOutput() {
  const annotations: any[] = [];
  const ann = (path: string, text: string) => {
    for (const statement of segmentStatementsStrict(text)) {
      annotations.push({ public_output_path: path, statement_text: statement, support_mode: 'unverified', evidence_ids: [] });
    }
  };

  const product = {
    name: 'test-repo',
    category: 'The available evidence does not establish a firm product category.',
    summary: 'The available evidence does not establish a full product summary.',
    primary_audience: 'The available evidence does not establish a specific audience.'
  };
  ann('product.category', product.category);
  ann('product.summary', product.summary);
  ann('product.primary_audience', product.primary_audience);

  const article = {
    headline: 'The available evidence does not establish a definitive headline',
    standfirst: 'The available evidence does not establish a strong standfirst.',
    jury_summary: 'The available evidence does not establish a complete jury summary.',
    where_jury_agreed: [] as string[],
    where_jury_disagreed: [] as any[],
    evidence_limitations: ['No verified execution result was collected.'],
    evidence_classifications: [] as any[],
    final_verdict: 'The available evidence does not establish verified runtime results. No verified benchmark was collected.',
    meta_description: 'The available evidence does not establish a full description.'
  };
  ann('article.headline', article.headline);
  ann('article.standfirst', article.standfirst);
  ann('article.jury_summary', article.jury_summary);
  ann('article.evidence_limitations.0', article.evidence_limitations[0]);
  ann('article.final_verdict', article.final_verdict);
  ann('article.meta_description', article.meta_description);

  const judgeMeta = [
    { id: 'alex', name: 'Alex', role: 'Entrepreneur' },
    { id: 'david', name: 'David', role: 'Engineer' },
    { id: 'lisa', name: 'Lisa', role: 'UX' },
    { id: 'sarah', name: 'Sarah', role: 'PM' },
    { id: 'marcus', name: 'Marcus', role: 'VC' }
  ];
  const critIds = ['purpose_usefulness', 'implementation_evidence', 'technical_quality', 'usability_onboarding', 'differentiation_insight', 'project_health_stewardship'];
  const notAssessable = new Set(['technical_quality', 'project_health_stewardship']);

  // Distinct reasoning vocabulary per judge (each containing an absence phrase that is also a
  // calibrated phrase) so the cross-judge similarity gate is satisfied.
  const reasoningTemplates = [
    (cid: string) => `The available metadata does not establish ${cid} outcomes.`,
    (cid: string) => `Reviewers could not verify ${cid} behaviour independently.`,
    (cid: string) => `No public evidence documents ${cid} for this project.`,
    (cid: string) => `Runtime tracing does not establish ${cid} anywhere.`,
    (cid: string) => `Benchmark logs could not verify ${cid} thoroughly.`
  ];

  const judges = judgeMeta.map((meta, ji) => {
    const verdict = `Perspective ${ji} could not verify the runtime behavior.`;
    const strength = `Perspective ${ji} strength could not be independently verified.`;
    const concern = `Perspective ${ji} raised a concern that could not be verified.`;
    const action = `Extend the README with the verification steps for the concern perspective ${ji} raised so reviewers can confirm the workflow.`;
    ann(`judges.${ji}.verdict`, verdict);
    ann(`judges.${ji}.strengths.0`, strength);
    ann(`judges.${ji}.concerns.0`, concern);
    // The action cites the README evidence, so its annotation is evidence_backed and the
    // sentence carries the creator attribution ("README") the validator demands.
    for (const statement of segmentStatementsStrict(action)) {
      annotations.push({ public_output_path: `judges.${ji}.recommended_next_step.action`, statement_text: statement, support_mode: 'evidence_backed', evidence_ids: ['ev-1'] });
    }
    const criteria = critIds.map((cid, ci) => {
      const na = notAssessable.has(cid);
      const reasoning = reasoningTemplates[ji](cid);
      ann(`judges.${ji}.criteria.${ci}.reasoning`, reasoning);
      const limitations = na ? [] : [`No verified ${cid} result was collected for perspective ${ji}.`];
      if (!na) ann(`judges.${ji}.criteria.${ci}.limitations.0`, limitations[0]);
      return {
        criterion_id: cid,
        // The recommended next step must cite a subset of its criterion's evidence.
        score: na ? null : 3.0,
        confidence: na ? 'not_assessable' : 'low',
        reasoning,
        evidence_ids: cid === 'purpose_usefulness' ? ['ev-1'] : [] as string[],
        limitations
      };
    });
    return {
      judge_id: meta.id,
      judge_name: meta.name,
      role: meta.role,
      verdict,
      strengths: [strength],
      concerns: [concern],
      recommended_next_step: {
        action,
        primary_concern_index: 0,
        criterion_id: 'purpose_usefulness',
        evidence_ids: ['ev-1']
      },
      criteria
    };
  });

  return { schema_version: '2.1.0', public_statement_annotations: annotations, product, article, judges };
}

const mockValidResponseText = JSON.stringify(buildMockOutput());

const mockResponseSuccess = {
  text: mockValidResponseText,
  // The actually-served model version the API reports; distinct from the alias concept
  // but equal to the default request alias here so alias-agnostic tests stay simple.
  modelVersion: 'gemini-3.5-flash',
  usageMetadata: {
    promptTokenCount: 100,
    candidatesTokenCount: 50
  }
};

const candidate = {
  source: "GitHub" as const,
  sourceId: "test/repo",
  name: "test-repo",
  canonicalUrl: "https://github.com/test/repo",
  sourceUrl: "https://github.com/test/repo",
  sourceRank: 1,
  popularityValue: 100,
  popularityUnit: "stars",
  collectedAt: new Date().toISOString(),
  metadata: {
    stars: 100,
    forks: 20
  }
};

const evidences = [
  {
    evidence_id: "ev-1",
    url: "https://github.com/test/repo",
    type: "readme" as const,
    title: "README.md",
    retrieved_at: new Date().toISOString(),
    content_hash: "abc123hash",
    summary: "This is a test repository README content.",
    claims: [] as { text: string; claim_type: "creator_claim" | "inference" | "unknown" | "verified_fact" }[]
  }
];

describe('Evaluator API Routing & Failover', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = 'PRIMARY_KEY';
    process.env.GEMINI_FALLBACK_API_KEY = 'FALLBACK_KEY';
    process.env.GEMINI_PRIMARY_MAX_ATTEMPTS = '3';
    process.env.GEMINI_FALLBACK_MAX_ATTEMPTS = '3';
  });

  // 1. Primary first attempt success
  it('Primary first attempt success', async () => {
    primaryMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.successfulRoute).toBe('primary');
    expect(result.attemptCount).toBe(1);
    expect(result.primaryAttemptCount).toBe(1);
    expect(result.fallbackAttemptCount).toBe(0);
    expect(result.failoverUsed).toBe(false);
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(0);
  });

  it('passes the trusted canonical name and immutable snapshot to the production prompt', async () => {
    primaryMock.mockResolvedValue(mockResponseSuccess);
    const trustedCandidate = {
      ...candidate,
      name: 'Untrusted Source Title',
      metadata: {
        project_identity: {
          canonical_display_name: 'Canonical Product',
          source_title: 'Untrusted Source Title',
          identity_source: 'repository_name'
        },
        metadata_snapshot: {
          snapshot_id: 'snap-prompt', fetched_at: '2026-07-16T00:00:00.000Z',
          repository_full_name: 'test/repo', repository_url: 'https://github.com/test/repo',
          stars: 321, forks: 12, open_issues: 4
        }
      }
    };

    await new Evaluator().evaluate(trustedCandidate, evidences);
    const prompt = primaryMock.mock.calls[0][0].contents as string;
    expect(prompt).toContain('Product Name: Canonical Product');
    expect(prompt).toContain('Stars: 321, Forks: 12, Open Issues: 4');
  });

  it('keeps discussion evidence intact when the total budget forces truncation', async () => {
    primaryMock.mockResolvedValue(mockResponseSuccess);
    const oversizedEvidences = [
      {
        evidence_id: 'ev-1', url: 'https://github.com/test/repo', type: 'readme' as const,
        title: 'README.md', retrieved_at: new Date().toISOString(), content_hash: 'h',
        summary: 'X'.repeat(30000), claims: [] as any[]
      },
      {
        evidence_id: 'ev-disc', url: 'https://news.ycombinator.com/item?id=1', type: 'source_discussion' as const,
        title: 'Discussion', retrieved_at: new Date().toISOString(), content_hash: 'h2',
        summary: 'Critical Comments (Community Concerns):\n- MARKER_CRITICAL_EXCERPT reproducibility is unclear.', claims: [] as any[]
      }
    ];
    await new Evaluator().evaluate(candidate, oversizedEvidences);
    const prompt = primaryMock.mock.calls[0][0].contents as string;
    expect(prompt).toContain('MARKER_CRITICAL_EXCERPT');
    expect(prompt).toContain('Truncated due to total budget');
  });

  // 2. Primary succeeds on third attempt
  it('Primary succeeds on third attempt', async () => {
    const error503 = new Error("Service unavailable (status code 503)");
    (error503 as any).status = 503;

    primaryMock
      .mockRejectedValueOnce(error503)
      .mockRejectedValueOnce(error503)
      .mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.successfulRoute).toBe('primary');
    expect(result.attemptCount).toBe(3);
    expect(result.primaryAttemptCount).toBe(3);
    expect(result.fallbackAttemptCount).toBe(0);
    expect(primaryMock).toHaveBeenCalledTimes(3);
    expect(fallbackMock).toHaveBeenCalledTimes(0);
  });

  // 3. Primary fails three retryable attempts and Fallback succeeds first
  it('Primary fails three retryable attempts and Fallback succeeds first', async () => {
    const error503 = new Error("Service unavailable (status code 503)");
    (error503 as any).status = 503;

    primaryMock.mockRejectedValue(error503);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.successfulRoute).toBe('fallback');
    expect(result.attemptCount).toBe(4);
    expect(result.primaryAttemptCount).toBe(3);
    expect(result.fallbackAttemptCount).toBe(1);
    expect(result.failoverUsed).toBe(true);
    expect(result.failoverReason).toBe('HTTP_503');
    expect(primaryMock).toHaveBeenCalledTimes(3);
    expect(fallbackMock).toHaveBeenCalledTimes(1);
  });

  // 4. Primary and Fallback both fail three times
  it('Primary and Fallback both fail three times', async () => {
    const error503 = new Error("Service unavailable (status code 503)");
    (error503 as any).status = 503;

    primaryMock.mockRejectedValue(error503);
    fallbackMock.mockRejectedValue(error503);

    const evaluator = new Evaluator();

    await expect(evaluator.evaluate(candidate, evidences)).rejects.toThrow(GeminiEvaluationExhaustedError);

    try {
      await evaluator.evaluate(candidate, evidences);
    } catch (e: any) {
      expect(e.totalAttempts).toBe(6);
      expect(e.primaryAttempts).toBe(3);
      expect(e.fallbackAttempts).toBe(3);
      expect(e.lastErrorCategory).toBe('HTTP_503');
      expect(e.failoverUsed).toBe(true);
    }
  });

  // 5. Primary explicit quota exhaustion
  it('Primary explicit quota exhaustion', async () => {
    const error429 = new Error("Quota exceeded (status code 429)");
    (error429 as any).status = 429;

    primaryMock.mockRejectedValueOnce(error429);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.successfulRoute).toBe('fallback');
    expect(result.attemptCount).toBe(2);
    expect(result.primaryAttemptCount).toBe(1);
    expect(result.fallbackAttemptCount).toBe(1);
    expect(result.failoverUsed).toBe(true);
    expect(result.failoverReason).toBe('QUOTA_EXCEEDED');
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(1);
  });

  // 6. Primary invalid credential
  it('Primary invalid credential', async () => {
    const error403 = new Error("API Key invalid (status code 403)");
    (error403 as any).status = 403;

    primaryMock.mockRejectedValueOnce(error403);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.successfulRoute).toBe('fallback');
    expect(result.attemptCount).toBe(2);
    expect(result.primaryAttemptCount).toBe(1);
    expect(result.fallbackAttemptCount).toBe(1);
    expect(result.failoverUsed).toBe(true);
    expect(result.failoverReason).toBe('CREDENTIAL_OR_PERMISSION_ERROR');
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(1);
  });

  // 7. HTTP 400
  it('HTTP 400', async () => {
    const error400 = new Error("Invalid argument (status code 400)");
    (error400 as any).status = 400;

    primaryMock.mockRejectedValueOnce(error400);

    const evaluator = new Evaluator();
    await expect(evaluator.evaluate(candidate, evidences)).rejects.toThrow("Invalid argument");
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(0);
  });

  // 8. HTTP 404
  it('HTTP 404', async () => {
    const error404 = new Error("Model not found (status code 404)");
    (error404 as any).status = 404;

    primaryMock.mockRejectedValueOnce(error404);

    const evaluator = new Evaluator();
    await expect(evaluator.evaluate(candidate, evidences)).rejects.toThrow("Model not found");
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(0);
  });

  // 9. An unparseable response is a RESULT, not a reason to call Gemini again.
  it('returns an unparseable response verbatim without retrying it', async () => {
    primaryMock
      .mockResolvedValueOnce({
        text: "invalid json content",
        modelVersion: 'gemini-3.5-flash',
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
      })
      .mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const raw = await evaluator.generateRaw(candidate, evidences);

    // Exactly one call: the response arrived, so there is nothing to retry. It is persisted
    // as-is and the validator excludes it.
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(raw.attemptCount).toBe(1);
    expect(raw.rawResponse).toBe('invalid json content');
    expect(raw.parsed).toBeNull();
  });

  // 10. Schema-violating content is likewise a result, not a transport failure.
  it('does not retry or fail over when the response violates the schema', async () => {
    const responseWithInvalidSchema = {
      text: JSON.stringify({ invalid_schema: true }),
      modelVersion: 'gemini-3.5-flash',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
    };

    primaryMock.mockResolvedValue(responseWithInvalidSchema);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const raw = await evaluator.generateRaw(candidate, evidences);

    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).not.toHaveBeenCalled();
    expect(raw.failoverUsed).toBe(false);
    expect(raw.successfulRoute).toBe('primary');
    expect(raw.parsed).toEqual({ invalid_schema: true });
  });

  // 10b. Transport failures DO still retry and fail over — they yield no response at all.
  it('still retries and fails over on transport failures', async () => {
    const error503 = new Error("Service unavailable (status code 503)");
    (error503 as any).status = 503;
    primaryMock.mockRejectedValue(error503);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const raw = await evaluator.generateRaw(candidate, evidences);

    expect(raw.successfulRoute).toBe('fallback');
    expect(raw.primaryAttemptCount).toBe(3);
    expect(raw.failoverUsed).toBe(true);
    expect(primaryMock).toHaveBeenCalledTimes(3);
  });

  // 11. Fallback secret missing
  it('Fallback secret missing', async () => {
    process.env.GEMINI_FALLBACK_API_KEY = '';

    // Primary succeeds
    primaryMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);
    expect(result.successfulRoute).toBe('primary');

    // Primary fails, but fallback is missing -> fails with exhausted error
    vi.clearAllMocks();
    const error503 = new Error("Service unavailable (status code 503)");
    (error503 as any).status = 503;
    primaryMock.mockRejectedValue(error503);

    await expect(evaluator.evaluate(candidate, evidences)).rejects.toThrow(GeminiEvaluationExhaustedError);
  });

  // 12. Primary and Fallback identical API Key string
  it('Primary and Fallback identical API Key string', async () => {
    process.env.GEMINI_API_KEY = 'SAME_KEY';
    process.env.GEMINI_FALLBACK_API_KEY = 'SAME_KEY';

    const evaluator = new Evaluator();
    await expect(evaluator.evaluate(candidate, evidences)).rejects.toThrow("identical");
  });

  // 14. A claim-provenance defect never re-requests generation: it is a verdict on a
  // response that already arrived, and the response must survive to be judged.
  it('does not retry or fail over when the response has a claim-provenance defect', async () => {
    // Drop one field's annotations — content that the validator will hard-fail.
    const uncovered = buildMockOutput();
    uncovered.public_statement_annotations = uncovered.public_statement_annotations.filter(
      (a: any) => a.public_output_path !== 'article.standfirst'
    );
    const rawText = JSON.stringify(uncovered);
    primaryMock.mockResolvedValue({
      text: rawText,
      modelVersion: 'gemini-3.5-flash',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
    });
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const raw = await evaluator.generateRaw(candidate, evidences);

    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).not.toHaveBeenCalled();
    expect(raw.failoverUsed).toBe(false);
    // Verbatim: not normalized, not repaired, not rewritten.
    expect(raw.rawResponse).toBe(rawText);
  });

  // 13. API Key not leaked in errors or result metadata
  it('API Key not leaked in errors or result metadata', async () => {
    const errorWithSecret = new Error("API Key PRIMARY_KEY failed to auth");
    (errorWithSecret as any).status = 403;

    primaryMock.mockRejectedValueOnce(errorWithSecret);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.failoverReason).toBe('CREDENTIAL_OR_PERMISSION_ERROR');
    expect(JSON.stringify(result)).not.toContain('PRIMARY_KEY');
    expect(JSON.stringify(result)).not.toContain('FALLBACK_KEY');
  });
});

describe('Phase 3 thinking config & token metadata', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.GEMINI_MODEL;
    process.env.GEMINI_API_KEY = 'PRIMARY_KEY';
    process.env.GEMINI_FALLBACK_API_KEY = 'FALLBACK_KEY';
    process.env.GEMINI_PRIMARY_MAX_ATTEMPTS = '3';
    process.env.GEMINI_FALLBACK_MAX_ATTEMPTS = '3';
  });

  it('requests thinking level HIGH on the primary route', async () => {
    primaryMock.mockResolvedValue(mockResponseSuccess);
    const result = await new Evaluator().evaluate(candidate, evidences);

    const config = primaryMock.mock.calls[0][0].config;
    expect(config.thinkingConfig.thinkingLevel).toBe('HIGH');
    expect(config.responseMimeType).toBe('application/json');
    expect(config.responseJsonSchema).toBeDefined();
    expect(result.thinkingLevel).toBe('HIGH');
    expect(result.requestedModel).toBe('gemini-3.5-flash');
    // modelUsed comes from the response's modelVersion, which happens to match here.
    expect(result.modelUsed).toBe('gemini-3.5-flash');
  });

  it('uses the identical config object on the fallback route (no config drift)', async () => {
    const error503 = new Error('Service unavailable (status code 503)');
    (error503 as any).status = 503;
    primaryMock.mockRejectedValue(error503);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const result = await new Evaluator().evaluate(candidate, evidences);
    expect(result.successfulRoute).toBe('fallback');

    const primaryConfig = primaryMock.mock.calls[0][0].config;
    const fallbackConfig = fallbackMock.mock.calls[0][0].config;
    // Same frozen object, not merely an equal copy — drift is impossible by construction.
    expect(fallbackConfig).toBe(primaryConfig);
    expect(fallbackConfig.thinkingConfig.thinkingLevel).toBe('HIGH');
    expect(Object.isFrozen(primaryConfig)).toBe(true);
    // Every primary attempt used the same config too.
    for (const call of primaryMock.mock.calls) {
      expect(call[0].config).toBe(primaryConfig);
    }
  });

  it('captures thinking/total/cached token counts from usageMetadata', async () => {
    primaryMock.mockResolvedValue({
      text: mockValidResponseText,
      modelVersion: 'gemini-3.5-flash',
      usageMetadata: {
        promptTokenCount: 100,
        candidatesTokenCount: 50,
        thoughtsTokenCount: 222,
        totalTokenCount: 372,
        cachedContentTokenCount: 10
      }
    });
    const result = await new Evaluator().evaluate(candidate, evidences);
    expect(result.tokenUsage).toEqual({
      input_tokens: 100,
      output_tokens: 50,
      thinking_tokens: 222,
      total_tokens: 372,
      cached_input_tokens: 10
    });
  });

  it('keeps unreported token counts as null, never zero', async () => {
    primaryMock.mockResolvedValue(mockResponseSuccess);
    const result = await new Evaluator().evaluate(candidate, evidences);
    expect(result.tokenUsage.thinking_tokens).toBeNull();
    expect(result.tokenUsage.total_tokens).toBeNull();
    expect(result.tokenUsage.cached_input_tokens).toBeNull();
  });

  // Required regression 9: token metadata the API never reported is null, not 0 — for
  // every field, including input/output and the legacy usage view.
  it('keeps ALL token counts null when the response carries no usageMetadata', async () => {
    primaryMock.mockResolvedValue({
      text: mockValidResponseText,
      modelVersion: 'gemini-3.5-flash'
    });
    const result = await new Evaluator().evaluate(candidate, evidences);
    expect(result.tokenUsage).toEqual({
      input_tokens: null,
      output_tokens: null,
      thinking_tokens: null,
      total_tokens: null,
      cached_input_tokens: null
    });
    expect(result.usage).toEqual({ input_tokens: null, output_tokens: null });
    expect(JSON.stringify(result.tokenUsage)).not.toContain('0');
  });

  // Required regression 7: used_model records the actually-served modelVersion even when
  // it differs from the requested alias; the alias survives as requested_model.
  it('stores response.modelVersion as the used model when it differs from the requested alias', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.5-flash';
    primaryMock.mockResolvedValue({
      ...mockResponseSuccess,
      modelVersion: 'gemini-3.5-flash-preview-0716'
    });
    const result = await new Evaluator().evaluate(candidate, evidences);
    expect(result.requestedModel).toBe('gemini-3.5-flash');
    expect(result.modelUsed).toBe('gemini-3.5-flash-preview-0716');
  });

  // Required regression 8 (B4): once a response body is in hand, a missing modelVersion is
  // NOT a reason to call Gemini again. The body is a result — it is returned on the first
  // attempt and recorded honestly with modelUsed=null, never retried and never backfilled with
  // the requested alias. Retrying on envelope defects is how this pipeline used to burn calls.
  it('records modelUsed=null without retrying when the response omits modelVersion', async () => {
    const { modelVersion: _omitted, ...responseWithoutVersion } = mockResponseSuccess as any;
    primaryMock.mockResolvedValue(responseWithoutVersion);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const raw = await new Evaluator().generateRaw(candidate, evidences);

    // Exactly one Gemini call; no failover to the fallback route.
    expect(raw.successfulRoute).toBe('primary');
    expect(raw.attemptCount).toBe(1);
    expect(raw.primaryAttemptCount).toBe(1);
    expect(raw.fallbackAttemptCount).toBe(0);
    expect(raw.failoverUsed).toBe(false);
    expect(primaryMock).toHaveBeenCalledTimes(1);
    expect(fallbackMock).toHaveBeenCalledTimes(0);

    // Honest provenance: null, never the requested alias.
    expect(raw.modelUsed).toBeNull();
    expect(raw.modelUsed).not.toBe(raw.requestedModel);

    // The response body is persisted verbatim, byte-for-byte.
    expect(raw.rawResponse).toBe(mockValidResponseText);

    // A blank modelVersion string is treated the same as absent — still one call, still null.
    vi.clearAllMocks();
    primaryMock.mockResolvedValue({ ...responseWithoutVersion, modelVersion: '   ' });
    const rawBlank = await new Evaluator().generateRaw(candidate, evidences);
    expect(rawBlank.attemptCount).toBe(1);
    expect(rawBlank.modelUsed).toBeNull();
    expect(primaryMock).toHaveBeenCalledTimes(1);
  });

  it('never surfaces internal thought content in the evaluation result', async () => {
    primaryMock.mockResolvedValue({
      text: mockValidResponseText,
      modelVersion: 'gemini-3.5-flash',
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50, thoughtsTokenCount: 5 },
      candidates: [{
        content: {
          parts: [
            { thought: true, text: 'INTERNAL_THOUGHT_MARKER should never leak' },
            { text: mockValidResponseText }
          ]
        }
      }]
    });
    const result = await new Evaluator().evaluate(candidate, evidences);
    expect(JSON.stringify(result)).not.toContain('INTERNAL_THOUGHT_MARKER');
  });
});

describe('Phase 1 prompt/validator contract synchronization', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GEMINI_API_KEY = 'PRIMARY_KEY';
    process.env.GEMINI_FALLBACK_API_KEY = 'FALLBACK_KEY';
    process.env.GEMINI_PRIMARY_MAX_ATTEMPTS = '3';
    process.env.GEMINI_FALLBACK_MAX_ATTEMPTS = '3';
  });

  async function captureProductionPrompt(): Promise<string> {
    primaryMock.mockResolvedValue(mockResponseSuccess);
    await new Evaluator().evaluate(candidate, evidences);
    return primaryMock.mock.calls[0][0].contents as string;
  }

  // Required regression 1 (rule 3.0.0): routine source prefixes are discouraged, not demanded.
  // The prompt must not reintroduce a blanket in-prose attribution requirement — that rule
  // made "According to the README" 59% of all attribution wording and caused every quality
  // failure the pipeline produced.
  it('tells the model not to prefix sentences with routine source attribution', async () => {
    const prompt = await captureProductionPrompt();
    expect(prompt).toContain('Do NOT prefix sentences with source attribution as a matter of routine');
    expect(prompt).toContain('Write the natural sentence.');
    expect(prompt).not.toContain('the SAME sentence must attribute the creator');
    expect(prompt).not.toContain('the SAME sentence must attribute the community');
    expect(prompt).not.toContain('must ALSO carry the creator/community attribution');
  });

  // Required regression 2: naming the source stays available where it carries meaning, so the
  // model can still contrast a creator claim with the evidence.
  it('keeps in-prose attribution available for the cases where it carries meaning', async () => {
    const prompt = await captureProductionPrompt();
    expect(prompt).toContain('Name the source in the prose only where it genuinely carries meaning');
    expect(prompt).toContain('contrasting what the creator claims with what the evidence shows');
  });

  // Required regression 3: heterogeneous fact classes are prohibited inside one evidence_backed sentence.
  it('prohibits mixing different fact classes in one evidence_backed sentence', async () => {
    const prompt = await captureProductionPrompt();
    expect(prompt).toContain('Every cited Evidence in ONE sentence must share the SAME fact class');
    expect(prompt).toContain('split it into one sentence per provenance');
    expect(prompt).toContain('Evidence whose own class is inference or unverified can NEVER back an evidence_backed sentence');
  });

  // Required regression 4: creator×community mixing is prohibited across all support modes.
  it('prohibits mixing creator and community evidence in one sentence regardless of support_mode', async () => {
    const prompt = await captureProductionPrompt();
    expect(prompt).toContain('NEVER mix creator evidence and community evidence in one sentence, regardless of support_mode');
  });

  // Required regression 5: derived fields are never requested from Gemini.
  it('does not request source_fact_classes or other derived fields as Gemini output', async () => {
    const prompt = await captureProductionPrompt();
    expect(prompt).toContain('Do NOT output fact_class, source_fact_classes, attribution_required, or coverage_source');
    // The annotation entry requests exactly the four model-supplied keys.
    expect(prompt).toContain('- public_output_path:');
    expect(prompt).toContain('- statement_text:');
    expect(prompt).toContain('- support_mode:');
    expect(prompt).toContain('- evidence_ids:');
    expect(prompt).not.toContain('- source_fact_classes:');
    expect(prompt).not.toContain('- fact_class:');
  });

  // The PASS/FAIL contract examples the spec mandates.
  it('includes the PASS/FAIL annotation examples matching the validator', async () => {
    const prompt = await captureProductionPrompt();
    // An unattributed inference is now a PASS: the calibrated "may" is what the mode needs,
    // and the cited Evidence ID already records the creator provenance.
    expect(prompt).toContain('PASS: "The tool may scale to enterprise workloads."');
    expect(prompt).not.toContain('FAIL: "The tool may scale to enterprise workloads."');
    // Mixing fact classes in one sentence is still a FAIL — that rule is unchanged.
    expect(prompt).toContain('FAIL: "Metadata reports strong adoption and the README describes a modular architecture."');
    expect(prompt).toContain('PASS: "The API metadata reports strong adoption."');
  });
});
