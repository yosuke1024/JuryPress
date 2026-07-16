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
    GoogleGenAI: MockGoogleGenAI
  };
});

import { segmentStatements } from '../../src/lib/evaluation/public-claims';

/**
 * Builds a fully statement-covered mock generation output. Every public field is a single
 * `unverified` statement carrying absence wording, so the whole output satisfies the
 * statement-coverage contract that verifyRules now enforces during generation, without
 * needing evidence citations. Text varies per judge/criterion to keep personas distinct.
 */
function buildMockOutput() {
  const annotations: any[] = [];
  const ann = (path: string, text: string) => {
    for (const statement of segmentStatements(text)) {
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
    const question = `What could not be verified for perspective ${ji}?`;
    ann(`judges.${ji}.verdict`, verdict);
    ann(`judges.${ji}.strengths.0`, strength);
    ann(`judges.${ji}.concerns.0`, concern);
    ann(`judges.${ji}.decisive_question`, question);
    const criteria = critIds.map((cid, ci) => {
      const na = notAssessable.has(cid);
      const reasoning = reasoningTemplates[ji](cid);
      ann(`judges.${ji}.criteria.${ci}.reasoning`, reasoning);
      const limitations = na ? [] : [`No verified ${cid} result was collected for perspective ${ji}.`];
      if (!na) ann(`judges.${ji}.criteria.${ci}.limitations.0`, limitations[0]);
      return {
        criterion_id: cid,
        score: na ? null : 3.0,
        confidence: na ? 'not_assessable' : 'low',
        reasoning,
        evidence_ids: [] as string[],
        limitations
      };
    });
    return { judge_id: meta.id, judge_name: meta.name, role: meta.role, verdict, strengths: [strength], concerns: [concern], decisive_question: question, criteria };
  });

  return { schema_version: '2.0.0', public_statement_annotations: annotations, product, article, judges };
}

const mockValidResponseText = JSON.stringify(buildMockOutput());

const mockResponseSuccess = {
  text: mockValidResponseText,
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

  // 9. JSON parse failure followed by valid response
  it('JSON parse failure followed by valid response', async () => {
    primaryMock
      .mockResolvedValueOnce({
        text: "invalid json content",
        usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
      })
      .mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.successfulRoute).toBe('primary');
    expect(result.attemptCount).toBe(2);
    expect(result.primaryAttemptCount).toBe(2);
    expect(primaryMock).toHaveBeenCalledTimes(2);
  });

  // 10. Schema validation fails three times on Primary, Fallback first response succeeds
  it('Schema validation fails three times on Primary, Fallback first response succeeds', async () => {
    const responseWithInvalidSchema = {
      text: JSON.stringify({ invalid_schema: true }),
      usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 50 }
    };

    primaryMock.mockResolvedValue(responseWithInvalidSchema);
    fallbackMock.mockResolvedValue(mockResponseSuccess);

    const evaluator = new Evaluator();
    const result = await evaluator.evaluate(candidate, evidences);

    expect(result.successfulRoute).toBe('fallback');
    expect(result.attemptCount).toBe(4);
    expect(result.primaryAttemptCount).toBe(3);
    expect(result.fallbackAttemptCount).toBe(1);
    expect(result.failoverUsed).toBe(true);
    expect(primaryMock).toHaveBeenCalledTimes(3);
    expect(fallbackMock).toHaveBeenCalledTimes(1);
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
