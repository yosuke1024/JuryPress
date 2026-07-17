import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { ReviewSchemaV2_1, RefinedReviewSchemaV2_1, ReviewSchema } from '../../src/schemas/review';
import { RecommendedNextStepSchema, JudgeEvaluationSchemaV2_1 } from '../../src/schemas/evaluation';
import { validateRecommendations, collectRecommendationFindings } from '../../src/lib/evaluation/recommendations';
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

  /** Asserts a rule is recorded at the given severity with the given code. */
  function findingFor(evaluation: any, evidences: any[], code: string) {
    return collectRecommendationFindings(evaluation, evidences).find(f => f.code === code);
  }

  it('warns, but does not block, on primary_concern_index !== 0', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.primary_concern_index = 1;
    // The repair pass pins this to 0; a survivor is worth recording, never worth withholding.
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_CONCERN_INDEX_UNPINNED')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('blocks an empty primary concern (a required section is missing)', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].concerns = [];
    expect(findingFor(evaluation, evidences, 'REQUIRED_SECTION_MISSING')?.severity).toBe('error');
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/primary concern/);
  });

  it('blocks a criterion_id that does not exist in the judge criteria (dangling reference)', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].criteria = evaluation.judges[0].criteria.filter(
      (criterion: any) => criterion.criterion_id !== 'implementation_evidence'
    );
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_CRITERION_NOT_FOUND')?.severity).toBe('error');
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/does not exist in that judge's criteria/);
  });

  it('blocks an evidence id missing from the bundle (untraceable grounding)', () => {
    const { evaluation, evidences } = fixtureParts();
    const filtered = evidences.filter((evidence: any) => evidence.evidence_id !== 'ev-source-1');
    expect(findingFor(evaluation, filtered, 'EVIDENCE_ID_NOT_FOUND')?.severity).toBe('error');
    expect(() => validateRecommendations(evaluation, filtered)).toThrow(/does not exist in the evidence bundle/);
  });

  it('warns, but does not block, when no criterion of that judge cites the recommended evidence', () => {
    const { evaluation, evidences } = fixtureParts();
    for (const criterion of evaluation.judges[0].criteria) {
      criterion.evidence_ids = criterion.evidence_ids.filter((id: string) => id !== 'ev-source-1');
      if (criterion.evidence_ids.length === 0) criterion.evidence_ids = ['ev-source-2'];
    }
    // The evidence exists and resolves; criterion-level provenance is a stricter standard
    // than traceability, and enforcing it rejected nearly every live generation.
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_EVIDENCE_NOT_CITED_BY_CRITERIA')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('blocks a recommendation that cites no evidence at all', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.evidence_ids = [];
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_EVIDENCE_MISSING')?.severity).toBe('error');
    expect(() => validateRecommendations(evaluation, evidences)).toThrow(/cites no evidence/);
  });

  it('accepts evidence cited by a sibling criterion of the same judge (judge-level provenance)', () => {
    const { evaluation, evidences } = fixtureParts();
    // Remove ev-source-1 from the CHOSEN criterion only; sibling criteria still cite it.
    const chosen = evaluation.judges[0].criteria.find(
      (criterion: any) => criterion.criterion_id === evaluation.judges[0].recommended_next_step.criterion_id
    );
    chosen.evidence_ids = chosen.evidence_ids.filter((id: string) => id !== 'ev-source-1');
    if (chosen.evidence_ids.length === 0) chosen.evidence_ids = ['ev-source-2'];
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('warns, but does not block, on generic recommendations (style, not correctness)', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.action = 'Add more tests.';
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_GENERIC')?.severity).toBe('warning');
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_TOO_SHORT')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();

    const { evaluation: evaluation2, evidences: evidences2 } = fixtureParts();
    // Long enough to bypass the length rule but still an exact generic match.
    evaluation2.judges[0].recommended_next_step.action = 'Continue improving the product.';
    expect(findingFor(evaluation2, evidences2, 'RECOMMENDATION_GENERIC')?.severity).toBe('warning');
  });

  it('warns, but does not block, on an action unrelated to the primary concern', () => {
    const { evaluation, evidences } = fixtureParts();
    // Specific and long, but shares no meaningful token with the concern text. This exact
    // rule burned six Gemini calls per run in production and published nothing.
    evaluation.judges[0].recommended_next_step.action =
      'Refactor the exported configuration builder into smaller modules with focused ownership boundaries.';
    for (const annotation of evaluation.claim_references || []) {
      if (annotation.public_output_path === 'judges.0.recommended_next_step.action') {
        annotation.statement_text = evaluation.judges[0].recommended_next_step.action;
      }
    }
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_CONCERN_VOCABULARY_UNSHARED')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('warns, but does not block, on an action that merely restates the primary concern', () => {
    const { evaluation, evidences } = fixtureParts();
    const concern = evaluation.judges[0].concerns[0];
    evaluation.judges[0].recommended_next_step.action = concern;
    for (const reference of evaluation.claim_references || []) {
      if (reference.public_output_path === 'judges.0.recommended_next_step.action') {
        reference.statement_text = concern;
      }
    }
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_RESTATES_CONCERN')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('warns, but does not block, on question-form actions', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.action =
      'Could a verified runtime result be collected for perspective 1 with the repository test files?';
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_PHRASED_AS_QUESTION')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('warns, but does not block, when annotation evidence differs from the canonical field', () => {
    const { evaluation, evidences } = fixtureParts();
    for (const reference of evaluation.claim_references || []) {
      if (reference.public_output_path === 'judges.0.recommended_next_step.action') {
        reference.evidence_ids = ['ev-source-2'];
      }
    }
    // The repair pass derives the annotation's ids from recommended_next_step.evidence_ids,
    // so this divergence normally never reaches the validator at all.
    expect(findingFor(evaluation, evidences, 'RECOMMENDATION_ANNOTATION_EVIDENCE_MISMATCH')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('warns, but does not block, on five identical persona recommendations', () => {
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
    expect(findingFor(evaluation, evidences, 'RECOMMENDATIONS_HOMOGENEOUS')?.severity).toBe('warning');
    expect(() => validateRecommendations(evaluation, evidences)).not.toThrow();
  });

  it('reports every finding in one pass rather than stopping at the first', () => {
    const { evaluation, evidences } = fixtureParts();
    evaluation.judges[0].recommended_next_step.action = 'Add tests.';
    evaluation.judges[0].recommended_next_step.criterion_id = 'no_such_criterion';
    const codes = collectRecommendationFindings(evaluation, evidences).map(f => f.code);
    expect(codes).toContain('RECOMMENDATION_GENERIC');
    expect(codes).toContain('RECOMMENDATION_CRITERION_NOT_FOUND');
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

  it('lets the publication gate tolerate warning-level recommendation linkage drift', () => {
    const { review, bundle } = createRecommendationFixture();
    const drifted = clone(review);
    // ev-source-2 exists and resolves, so the recommendation is still traceable. Re-litigating
    // criterion-level provenance at the gate is what the hash check replaces: the gate proves
    // the content is byte-for-byte what passed validation, rather than re-deciding the rules.
    drifted.evaluation.judges[0].recommended_next_step.evidence_ids = ['ev-source-2'];
    expect(() => validateRefinedReviewIntegrity(drifted, bundle as any, review.slug)).not.toThrow();
  });

  it('fails the publication gate when a recommendation cites evidence outside the bundle', () => {
    const { review, bundle } = createRecommendationFixture();
    const broken = clone(review);
    broken.evaluation.judges[0].recommended_next_step.evidence_ids = ['ev-does-not-exist'];
    expect(() => validateRefinedReviewIntegrity(broken, bundle as any, review.slug)).toThrow(/\[Publication Gate\]/);
  });

  it('fails the strict write schema when the evaluation is not refined', () => {
    const { review } = createRecommendationFixture();
    const broken = clone(review);
    delete broken.evaluation.claim_references;
    expect(() => RefinedReviewSchemaV2_1.parse(broken)).toThrow();
  });
});
