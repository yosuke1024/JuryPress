import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ReviewSchemaV2_1, RefinedReviewSchemaV2_1, ReviewSchema } from '../../src/schemas/review';
import { RecommendedNextStepSchema, JudgeEvaluationSchemaV2_1 } from '../../src/schemas/evaluation';
import { validateRecommendations } from '../../src/lib/evaluation/recommendations';
import { validateRefinedReviewIntegrity } from '../../src/lib/publication-integrity';
import { finalizeRefinedEvaluation } from '../../src/lib/daily-evaluation';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { createRefinedFixture, createRecommendationFixture } from '../fixtures/refined-review';

let originalMode: string | undefined;

beforeAll(() => {
  originalMode = process.env.JURYPRESS_DATA_MODE;
  process.env.JURYPRESS_DATA_MODE = 'fixture';
});

afterAll(() => {
  process.env.JURYPRESS_DATA_MODE = originalMode;
});

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

describe('Recommendation contract — schema (2.1.0)', () => {
  it('accepts a valid 2.1.0 review with 5 recommended next steps', () => {
    const { review } = createRecommendationFixture();
    const parsed = ReviewSchemaV2_1.parse(clone(review));
    expect(parsed.schema_version).toBe('2.1.0');
    expect(parsed.recommendation_contract_version).toBe('1.0.0');
    expect(parsed.evaluation.judges).toHaveLength(5);
    for (const judge of parsed.evaluation.judges as any[]) {
      expect(judge.recommended_next_step).toBeDefined();
      expect(judge.recommended_next_step.primary_concern_index).toBe(0);
    }
  });

  it('requires recommended_next_step on every judge of a 2.1.0 review', () => {
    const { review } = createRecommendationFixture();
    const broken = clone(review);
    delete broken.evaluation.judges[2].recommended_next_step;
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow();
  });

  it('rejects decisive_question on a new 2.1.0 review', () => {
    const { review } = createRecommendationFixture();
    const broken = clone(review);
    broken.evaluation.judges[0].decisive_question = 'Should this be here?';
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow();
    expect(() => JudgeEvaluationSchemaV2_1.parse(broken.evaluation.judges[0])).toThrow();
  });

  it('rejects a primary_concern_index other than 0 at the schema level', () => {
    const { review } = createRecommendationFixture();
    const broken = clone(review);
    broken.evaluation.judges[0].recommended_next_step.primary_concern_index = 1;
    expect(() => ReviewSchemaV2_1.parse(broken)).toThrow();
  });

  it('rejects an unknown criterion_id at the schema level', () => {
    expect(() => RecommendedNextStepSchema.parse({
      action: 'Publish the CI output for the reviewed commit to document verification.',
      primary_concern_index: 0,
      criterion_id: 'not_a_criterion',
      evidence_ids: ['ev-1']
    })).toThrow();
  });

  it('rejects duplicate and empty evidence_ids at the schema level', () => {
    const base = {
      action: 'Publish the CI output for the reviewed commit to document verification.',
      primary_concern_index: 0,
      criterion_id: 'implementation_evidence'
    };
    expect(() => RecommendedNextStepSchema.parse({ ...base, evidence_ids: [] })).toThrow();
    expect(() => RecommendedNextStepSchema.parse({ ...base, evidence_ids: ['ev-1', 'ev-1'] })).toThrow();
  });

  it('keeps legacy decisive_question reviews readable, unchanged', () => {
    const { review } = createRefinedFixture();
    const parsed: any = ReviewSchema.parse(clone(review));
    expect(parsed.schema_version).toBe('2.0.0');
    for (const judge of parsed.evaluation.judges) {
      expect(typeof judge.decisive_question).toBe('string');
      expect(judge.recommended_next_step).toBeUndefined();
    }
    expect((parsed as any).recommendation_contract_version).toBeUndefined();
  });

  it('loads a 2.1.0 review through the ReviewSchema union', () => {
    const { review } = createRecommendationFixture();
    const parsed: any = ReviewSchema.parse(clone(review));
    expect(parsed.schema_version).toBe('2.1.0');
  });
});

describe('Recommendation contract — deterministic validation', () => {
  function fixtureParts() {
    const { review, bundle } = createRecommendationFixture();
    return { evaluation: clone(review.evaluation), evidences: clone(bundle.evidences) };
  }

  it('accepts the canonical fixture', () => {
    const { evaluation, evidences } = fixtureParts();
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('rejects primary_concern_index !== 0', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.primary_concern_index = 1;
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/primary_concern_index/);
  });

  it('rejects an empty primary concern', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].concerns = [];
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/primary concern/);
  });

  it('rejects a criterion_id that does not exist in the judge criteria', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].criteria = evaluation.judges[0].criteria.filter(
      (criterion: any) => criterion.criterion_id !== 'implementation_evidence'
    );
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/does not exist in that judge's criteria/);
  });

  it('rejects an evidence id missing from the bundle', () => {
    const { evaluation, evidences } = fixtureParts();
    const filtered = evidences.filter((evidence: any) => evidence.evidence_id !== 'ev-source-1');
    expect(() => validateRecommendations(evaluation, filtered)).toThrow(/does not exist in the evidence bundle/);
  });

  it('rejects an evidence id not cited by the referenced criterion', () => {
    const { evaluation, evidences } = fixtureParts();
    for (const criterion of evaluation.judges[0].criteria) {
      criterion.evidence_ids = criterion.evidence_ids.filter((id: string) => id !== 'ev-source-1');
      if (criterion.evidence_ids.length === 0) criterion.evidence_ids = ['ev-source-2'];
    }
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/is not cited by criterion/);
  });

  it('rejects generic recommendations', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.action = 'Add more tests.';
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/\[Recommendation\]/);

    const { evaluation: evaluation2, evidences: evidences2 } = fixtureParts();
    // Long enough to bypass the length rule but still an exact generic match.
    evaluation2.judges[0].recommended_next_step.action = 'Continue improving the product.';
    expect(() => validateRecommendations(evaluation2, evidences2)).toThrow(/\[Recommendation\]/);
  });

  it('rejects an action unrelated to the primary concern', () => {
    const { evaluation, evidences } = fixtureParts();
    // Specific and long, but shares no meaningful token with the concern text.
    evaluation.judges[0].recommended_next_step.action =
      'Refactor the exported configuration builder into smaller modules with focused ownership boundaries.';
    // Keep annotations consistent so only the concern-overlap rule can fail.
    for (const annotation of evaluation.claim_references || []) {
      if (annotation.public_output_path === 'judges.0.recommended_next_step.action') {
        annotation.statement_text = evaluation.judges[0].recommended_next_step.action;
      }
    }
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/does not address the primary concern/);
  });

  it('rejects a listed generic phrase as generic, regardless of other rules', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.action = 'Continue improving the product.';
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/generic recommendation/);
  });

  it('rejects an action that merely restates the primary concern', () => {
    const { evaluation, evidences } = fixtureParts();
    const concern = evaluation.judges[0].concerns[0];
    evaluation.judges[0].recommended_next_step.action = concern;
    for (const reference of evaluation.claim_references || []) {
      if (reference.public_output_path === 'judges.0.recommended_next_step.action') {
        reference.statement_text = concern;
      }
    }
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/restates the primary concern/);
  });

  it('rejects question-form actions', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.action =
      'Could a verified runtime result be collected for perspective 1 with the repository test files?';
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/question/);
  });

  it('rejects an annotation evidence set that differs from recommended_next_step.evidence_ids', () => {
    const { evaluation, evidences } = fixtureParts();
    for (const reference of evaluation.claim_references || []) {
      if (reference.public_output_path === 'judges.0.recommended_next_step.action') {
        reference.evidence_ids = ['ev-source-2'];
      }
    }
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/must cite exactly/);
  });

  it('rejects five identical persona recommendations', () => {
    const { evaluation, evidences } = fixtureParts();
    const action = evaluation.judges[0].recommended_next_step.action;
    for (const [index, judge] of evaluation.judges.entries()) {
      judge.recommended_next_step = { ...evaluation.judges[0].recommended_next_step };
      judge.concerns = [...evaluation.judges[0].concerns];
      for (const reference of evaluation.claim_references || []) {
        if (reference.public_output_path === `judges.${index}.recommended_next_step.action`) {
          reference.statement_text = action;
        }
      }
    }
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/identical recommended/);
  });
});

describe('Recommendation contract — claim provenance & publication gate', () => {
  it('fails generation when the action lacks statement annotations (coverage)', () => {
    const { generatedOutput, context } = createRecommendationFixture();
    const raw = clone(generatedOutput);
    raw.public_statement_annotations = raw.public_statement_annotations.filter(
      (annotation: any) => annotation.public_output_path !== 'judges.0.recommended_next_step.action'
    );
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/no evidence-backed provenance annotation/i);
  });

  it('passes the full publication gate for the canonical 2.1.0 fixture', () => {
    const { review, bundle } = createRecommendationFixture();
    expect(() => validateRefinedReviewIntegrity(clone(review), bundle as any, review.slug)).not.toThrow();
  });

  it('fails the publication gate when recommendation evidence linkage drifts', () => {
    const { review, bundle } = createRecommendationFixture();
    const broken = clone(review);
    broken.evaluation.judges[0].recommended_next_step.evidence_ids = ['ev-source-2'];
    expect(() => validateRefinedReviewIntegrity(broken, bundle as any, review.slug)).toThrow(/\[Publication Gate\]/);
  });

  it('fails the strict write schema when the evaluation is not refined', () => {
    const { review } = createRecommendationFixture();
    const broken = clone(review);
    delete broken.evaluation.claim_references;
    expect(() => RefinedReviewSchemaV2_1.parse(broken)).toThrow();
  });
});
