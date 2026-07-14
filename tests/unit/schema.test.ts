import { describe, it, expect } from 'vitest';
import { EvaluationOutputSchema } from '../../src/schemas/evaluation';
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
    const jsonSchema = zodToJsonSchema(EvaluationOutputSchema, { $refStrategy: "none" }) as any;
    
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
    
    // Check score bounds
    const scoreProp = criteriaProp.items?.properties?.score;
    expect(scoreProp).toBeDefined();
    expect(scoreProp.type).toBe('number');
    expect(scoreProp.minimum).toBe(0);
    expect(scoreProp.maximum).toBe(5);
    
    // Check evidence classifications enum
    const classificationsProp = jsonSchema.properties?.article?.properties?.evidence_classifications?.items?.properties?.classification;
    expect(classificationsProp).toBeDefined();
    expect(classificationsProp.enum).toEqual(['verified_fact', 'creator_claim', 'inference', 'unknown']);
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
});

