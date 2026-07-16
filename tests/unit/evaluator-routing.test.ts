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

const mockValidResponseText = JSON.stringify({
  schema_version: "2.0.0",
  public_claim_annotations: [
    { claim_text: "According to the README, this is a test repository.", evidence_ids: ["ev-1"], public_output_path: "product.summary" },
    { claim_text: "According to the README, the project is a test repository.", evidence_ids: ["ev-1"], public_output_path: "article.jury_summary" },
    { claim_text: "According to the README, the verdict is measured.", evidence_ids: ["ev-1"], public_output_path: "article.final_verdict" }
  ],
  product: {
    name: "test-repo",
    category: "DevTools",
    summary: "According to the README, this is a test repository.",
    primary_audience: "Developers"
  },
  article: {
    headline: "Headline",
    standfirst: "Standfirst",
    jury_summary: "According to the README, the project is a test repository.",
    where_jury_agreed: [],
    where_jury_disagreed: [],
    evidence_limitations: [],
    evidence_classifications: [],
    final_verdict: "According to the README, the verdict is measured. Second sentence. Third sentence. Fourth sentence.",
    meta_description: "Meta description"
  },
  judges: [
    {
      judge_id: "alex",
      judge_name: "Alex",
      role: "Entrepreneur",
      verdict: "Alex verdict",
      strengths: ["strength one", "strength two"],
      concerns: ["concern one", "concern two"],
      decisive_question: "question one",
      criteria: [
        { "criterion_id": "purpose_usefulness", "score": 3.0, "confidence": "low", "reasoning": "according to the first evidence", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "implementation_evidence", "score": 3.0, "confidence": "low", "reasoning": "according to the first evidence", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "technical_quality", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] },
        { "criterion_id": "usability_onboarding", "score": 3.0, "confidence": "low", "reasoning": "according to the first evidence", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "differentiation_insight", "score": 3.0, "confidence": "low", "reasoning": "according to the first evidence", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "project_health_stewardship", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] }
      ]
    },
    {
      judge_id: "david",
      judge_name: "David",
      role: "Engineer",
      verdict: "David verdict",
      strengths: ["strength three", "strength four"],
      concerns: ["concern three", "concern four"],
      decisive_question: "question two",
      criteria: [
        { "criterion_id": "purpose_usefulness", "score": 3.0, "confidence": "low", "reasoning": "states that the codebase is structured", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "implementation_evidence", "score": 3.0, "confidence": "low", "reasoning": "states that the codebase is structured", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "technical_quality", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] },
        { "criterion_id": "usability_onboarding", "score": 3.0, "confidence": "low", "reasoning": "states that the codebase is structured", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "differentiation_insight", "score": 3.0, "confidence": "low", "reasoning": "states that the codebase is structured", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "project_health_stewardship", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] }
      ]
    },
    {
      judge_id: "lisa",
      judge_name: "Lisa",
      role: "UX",
      verdict: "Lisa verdict",
      strengths: ["strength five", "strength six"],
      concerns: ["concern five", "concern six"],
      decisive_question: "question three",
      criteria: [
        { "criterion_id": "purpose_usefulness", "score": 3.0, "confidence": "low", "reasoning": "metadata reports onboarding steps", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "implementation_evidence", "score": 3.0, "confidence": "low", "reasoning": "metadata reports onboarding steps", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "technical_quality", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] },
        { "criterion_id": "usability_onboarding", "score": 3.0, "confidence": "low", "reasoning": "metadata reports onboarding steps", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "differentiation_insight", "score": 3.0, "confidence": "low", "reasoning": "metadata reports onboarding steps", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "project_health_stewardship", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] }
      ]
    },
    {
      judge_id: "sarah",
      judge_name: "Sarah",
      role: "PM",
      verdict: "Sarah verdict",
      strengths: ["strength seven", "strength eight"],
      concerns: ["concern seven", "concern eight"],
      decisive_question: "question four",
      criteria: [
        { "criterion_id": "purpose_usefulness", "score": 3.0, "confidence": "low", "reasoning": "inferred that the scope is limited", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "implementation_evidence", "score": 3.0, "confidence": "low", "reasoning": "inferred that the scope is limited", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "technical_quality", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] },
        { "criterion_id": "usability_onboarding", "score": 3.0, "confidence": "low", "reasoning": "inferred that the scope is limited", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "differentiation_insight", "score": 3.0, "confidence": "low", "reasoning": "inferred that the scope is limited", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "project_health_stewardship", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] }
      ]
    },
    {
      judge_id: "marcus",
      judge_name: "Marcus",
      role: "VC",
      verdict: "Marcus verdict",
      strengths: ["strength nine", "strength ten"],
      concerns: ["concern nine", "concern ten"],
      decisive_question: "question five",
      criteria: [
        { "criterion_id": "purpose_usefulness", "score": 3.0, "confidence": "low", "reasoning": "suggests high adoption potential", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "implementation_evidence", "score": 3.0, "confidence": "low", "reasoning": "suggests high adoption potential", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "technical_quality", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] },
        { "criterion_id": "usability_onboarding", "score": 3.0, "confidence": "low", "reasoning": "suggests high adoption potential", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "differentiation_insight", "score": 3.0, "confidence": "low", "reasoning": "suggests high adoption potential", "evidence_ids": ["ev-1"], "limitations": ["l"] },
        { "criterion_id": "project_health_stewardship", "score": null, "confidence": "not_assessable", "reasoning": "unknown details", "evidence_ids": [], "limitations": [] }
      ]
    }
  ]
});

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
