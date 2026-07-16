import { describe, it, expect } from 'vitest';
import { EvaluationOutputSchema, EvaluationOutputBaseSchemaV2 } from '../../src/schemas/evaluation';
import { ReviewSchema } from '../../src/schemas/review';
import { SelectionSchema } from '../../src/schemas/selection';
import { zodToJsonSchema } from 'zod-to-json-schema';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Schema Validations', () => {
  it('should generate a valid JSON schema for Gemini', () => {
    const jsonSchema = zodToJsonSchema(EvaluationOutputBaseSchemaV2, { $refStrategy: "none" }) as any;
    
    // Schema must not be empty
    expect(jsonSchema).toBeDefined();
    expect(Object.keys(jsonSchema).length).toBeGreaterThan(0);
    
    // No $refs should remain
    const schemaStr = JSON.stringify(jsonSchema);
    expect(schemaStr).not.toContain('"$ref"');
    
    // Check judges length constraint
    const judgesProp = jsonSchema.properties?.judges;
    expect(judgesProp).toBeDefined();
    expect(judgesProp.type).toBe('array');
    expect(judgesProp.minItems).toBe(5);
    expect(judgesProp.maxItems).toBe(5);
    
    // Check criteria length constraint inside judges
    const criteriaProp = judgesProp.items?.properties?.criteria;
    expect(criteriaProp).toBeDefined();
    expect(criteriaProp.type).toBe('array');
    expect(criteriaProp.minItems).toBe(6);
    expect(criteriaProp.maxItems).toBe(6);
    
    // Check score bounds (supports nullable anyOf structure)
    const scoreProp = criteriaProp.items?.properties?.score;
    expect(scoreProp).toBeDefined();
    const scoreTypeSchema = scoreProp.anyOf ? scoreProp.anyOf.find((s: any) => s.type === 'number') : scoreProp;
    expect(scoreTypeSchema).toBeDefined();
    expect(scoreTypeSchema.type).toBe('number');
    expect(scoreTypeSchema.minimum).toBe(0);
    expect(scoreTypeSchema.maximum).toBe(5);
    
    // Check evidence classifications enum
    const classificationsProp = jsonSchema.properties?.article?.properties?.evidence_classifications?.items?.properties?.classification;
    expect(classificationsProp).toBeDefined();
    expect(classificationsProp.enum).toEqual([
      'source_confirmed', 'creator_claim', 'inference', 'unknown', 'runtime_observed', 'community_claim',
      'confirmed_fact', 'community_opinion', 'repository_observation', 'unverified'
    ]);
  });

  it('should validate related-party and independent constraints in ReviewSchema', () => {
    const raw = fs.readFileSync(path.resolve(__dirname, '../fixtures/reviews/2026/07/fixture-product/review.json'), 'utf8');
    const baseReview = JSON.parse(raw);

    // Valid independent review
    const validIndependent = {
      ...baseReview,
      relationship: "independent",
      ranking_eligible: true
    };
    expect(ReviewSchema.safeParse(validIndependent).success).toBe(true);

    // Invalid independent review (ranking_eligible is false)
    const invalidIndependent = {
      ...baseReview,
      relationship: "independent",
      ranking_eligible: false
    };
    expect(ReviewSchema.safeParse(invalidIndependent).success).toBe(false);

    // Invalid independent review with exclusion reason
    const invalidIndependentWithReason = {
      ...baseReview,
      relationship: "independent",
      ranking_eligible: true,
      ranking_exclusion_reason: "related-party-project"
    };
    expect(ReviewSchema.safeParse(invalidIndependentWithReason).success).toBe(false);

    // Valid related-party review
    const validRelated = {
      ...baseReview,
      relationship: "related-party",
      ranking_eligible: false,
      ranking_exclusion_reason: "related-party-project"
    };
    expect(ReviewSchema.safeParse(validRelated).success).toBe(true);

    // Invalid related-party review (ranking_eligible is true)
    const invalidRelated = {
      ...baseReview,
      relationship: "related-party",
      ranking_eligible: true,
      ranking_exclusion_reason: "related-party-project"
    };
    expect(ReviewSchema.safeParse(invalidRelated).success).toBe(false);

    // Invalid related-party review (missing exclusion reason)
    const invalidRelatedMissingReason = {
      ...baseReview,
      relationship: "related-party",
      ranking_eligible: false
    };
    expect(ReviewSchema.safeParse(invalidRelatedMissingReason).success).toBe(false);
  });

  it('should validate SelectionSchema constraints (bootstrap, daily, production limits)', () => {
    
    const baseSelection = {
      schema_version: "1.0.0",
      data_class: "fixture",
      run_key: "season-1-2026-07-14-daily",
      source: "github",
      selection_rule: "Highest",
      selected_at: "2026-07-14T00:15:00+09:00",
      canonical_url: "https://github.com/example/fixture",
      source_url: "https://github.com/example/fixture",
      algorithm_version: "1.0.0",
      human_selected: false,
      candidate_name: "Fixture Product",
      source_id: "github/example/fixture",
      candidate_metadata: {},
      selection_mode: "automated-daily",
      selected_by: "system",
      source_rank: 1,
      source_metrics: [
        {
          platform: "github",
          metric: "stars",
          value: 106,
          source_url: "https://api.github.com/repos/example/fixture",
          retrieved_at: "2026-07-14T00:15:00Z"
        }
      ]
    };

    // Valid automated-daily
    const res = SelectionSchema.safeParse(baseSelection);
    if (!res.success) {
      console.log("Zod validation errors:", JSON.stringify(res.error.errors, null, 2));
    }
    expect(res.success).toBe(true);

    // Invalid automated-daily: operator selected
    const invalidDaily = {
      ...baseSelection,
      selected_by: "operator"
    };
    expect(SelectionSchema.safeParse(invalidDaily).success).toBe(false);

    // Invalid automated-daily: missing source_rank
    const invalidDailyRank = {
      ...baseSelection,
      source_rank: null
    };
    expect(SelectionSchema.safeParse(invalidDailyRank).success).toBe(false);

    // Valid initial-bootstrap
    const validBootstrap = {
      ...baseSelection,
      selection_mode: "initial-bootstrap",
      selected_by: "operator",
      source_rank: null
    };
    expect(SelectionSchema.safeParse(validBootstrap).success).toBe(true);

    // Invalid initial-bootstrap: system selected
    const invalidBootstrapSystem = {
      ...validBootstrap,
      selected_by: "system"
    };
    expect(SelectionSchema.safeParse(invalidBootstrapSystem).success).toBe(false);

    // Invalid initial-bootstrap: contains source_rank
    const invalidBootstrapRank = {
      ...validBootstrap,
      source_rank: 1
    };
    expect(SelectionSchema.safeParse(invalidBootstrapRank).success).toBe(false);

    // Production data check: missing source_metrics
    const invalidProdMetrics = {
      ...baseSelection,
      data_class: "production",
      source_metrics: []
    };
    expect(SelectionSchema.safeParse(invalidProdMetrics).success).toBe(false);

    // Production data check: contains placeholder 100
    const invalidProdPlaceholder = {
      ...baseSelection,
      data_class: "production",
      source_metrics: [
        {
          platform: "github",
          metric: "stars",
          value: 100,
          source_url: "https://api.github.com/repos/example/fixture",
          retrieved_at: "2026-07-14T00:15:00Z"
        }
      ]
    };
    expect(SelectionSchema.safeParse(invalidProdPlaceholder).success).toBe(false);
  });

  it('should validate EvaluationOutputSchema constraints (confidence, limitations, reasoning phrase requirements)', () => {
    const makeMockJudge = (id: string, name: string) => ({
      judge_id: id,
      judge_name: name,
      role: "Expert",
      verdict: "Verdict summary",
      strengths: ["Strength"],
      concerns: ["Concern"],
      decisive_question: "Decisive Question",
      criteria: [
        { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high" as const, reasoning: "R", evidence_ids: ["ev-1"], limitations: [] },
        { criterion_id: "implementation_evidence", score: 3.0, confidence: "high" as const, reasoning: "R", evidence_ids: ["ev-1"], limitations: [] },
        { criterion_id: "technical_quality", score: 4.0, confidence: "high" as const, reasoning: "R", evidence_ids: ["ev-1"], limitations: [] },
        { criterion_id: "usability_onboarding", score: 5.0, confidence: "high" as const, reasoning: "R", evidence_ids: ["ev-1"], limitations: [] },
        { criterion_id: "differentiation_insight", score: 4.0, confidence: "high" as const, reasoning: "R", evidence_ids: ["ev-1"], limitations: [] },
        { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high" as const, reasoning: "R", evidence_ids: ["ev-1"], limitations: [] }
      ]
    });

    const validEvaluation = {
      schema_version: "2.0.0",
      product: {
        name: "Test OSS Tool",
        category: "DevTools",
        summary: "A mock tool",
        primary_audience: "Developers"
      },
      article: {
        headline: "A headline",
        standfirst: "standfirst",
        jury_summary: "summary",
        where_jury_agreed: ["agreed"],
        where_jury_disagreed: [
          {
            criterion_id: "technical_quality",
            summary: "disagreed"
          }
        ],
        evidence_limitations: ["limitations"],
        evidence_classifications: [
          {
            evidence_id: "ev-1",
            classification: "source_confirmed" as const,
            claim: "verified something"
          }
        ],
        final_verdict: "The strongest quality is X. The largest concern is Y. It is relevant for Z. The evidence is limited to readme.",
        meta_description: "meta"
      },
      judges: [
        makeMockJudge("alex", "Alex"),
        makeMockJudge("david", "David"),
        makeMockJudge("lisa", "Lisa"),
        makeMockJudge("sarah", "Sarah"),
        makeMockJudge("marcus", "Marcus")
      ]
    };

    // Valid evaluation should pass
    const parseRes = EvaluationOutputSchema.safeParse(validEvaluation);
    if (!parseRes.success) {
      console.log("Evaluation validation errors:", JSON.stringify(parseRes.error.errors, null, 2));
    }
    expect(parseRes.success).toBe(true);

    // Invalid: confidence is low/medium but limitations array is empty
    const invalidEmptyLimitations = JSON.parse(JSON.stringify(validEvaluation));
    invalidEmptyLimitations.judges[0].criteria[0].confidence = 'low';
    invalidEmptyLimitations.judges[0].criteria[0].limitations = [];
    invalidEmptyLimitations.judges[0].criteria[0].reasoning = "According to the README, this is a test.";
    expect(EvaluationOutputSchema.safeParse(invalidEmptyLimitations).success).toBe(false);

    // Invalid: confidence is low/medium with limitations, but reasoning has no calibrated phrase
    const invalidNoPhrase = JSON.parse(JSON.stringify(validEvaluation));
    invalidNoPhrase.judges[0].criteria[0].confidence = 'low';
    invalidNoPhrase.judges[0].criteria[0].limitations = ["Missing test telemetry"];
    invalidNoPhrase.judges[0].criteria[0].reasoning = "This is a simple assertion without any calibrated language.";
    expect(EvaluationOutputSchema.safeParse(invalidNoPhrase).success).toBe(false);

    // Valid: confidence is low/medium with limitations and reasoning contains a calibrated phrase
    const validCalibrated = JSON.parse(JSON.stringify(validEvaluation));
    validCalibrated.judges[0].criteria[0].confidence = 'low';
    validCalibrated.judges[0].criteria[0].limitations = ["Missing test telemetry"];
    validCalibrated.judges[0].criteria[0].reasoning = "According to the README, the project performs actions.";
    expect(EvaluationOutputSchema.safeParse(validCalibrated).success).toBe(true);
  });
});

