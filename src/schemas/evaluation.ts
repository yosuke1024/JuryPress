import { z } from 'zod';
import { 
  GitHubMetadataSnapshotSchema,
  ProjectIdentitySchema,
  DiscussionEvidenceSchema,
  EvidenceFactClassSchema
} from './evidence';


export const ConfidenceSchema = z.enum(['high', 'medium', 'low', 'not_assessable']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const JudgeIdSchema = z.enum(['alex', 'david', 'lisa', 'sarah', 'marcus']);
export type JudgeId = z.infer<typeof JudgeIdSchema>;

// === V1 Criterion & Evaluation ===
export const CriterionIdSchemaV1 = z.enum([
  'innovation_creativity',
  'technical_implementation',
  'problem_solving_impact',
  'product_ux',
  'working_prototype',
  'presentation'
]);
export type CriterionIdV1 = z.infer<typeof CriterionIdSchemaV1>;

export const CriterionEvaluationSchemaV1 = z.object({
  criterion_id: CriterionIdSchemaV1,
  score: z.number().min(0).max(5),
  confidence: ConfidenceSchema,
  reasoning: z.string().min(1),
  evidence_ids: z.array(z.string()),
  limitations: z.array(z.string())
});

export const PublishedCriterionEvaluationSchemaV1 = CriterionEvaluationSchemaV1.extend({
  weighted_score: z.number()
});

export const JudgeEvaluationSchemaV1 = z.object({
  judge_id: JudgeIdSchema,
  judge_name: z.string(),
  role: z.string(),
  verdict: z.string().min(1),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  decisive_question: z.string(),
  criteria: z.array(CriterionEvaluationSchemaV1).length(6)
});

export const PublishedJudgeEvaluationSchemaV1 = JudgeEvaluationSchemaV1.extend({
  judge_score: z.number(),
  criteria: z.array(PublishedCriterionEvaluationSchemaV1).length(6)
});

export const EvidenceClassificationSchemaV1 = z.object({
  evidence_id: z.string(),
  classification: z.enum(['verified_fact', 'creator_claim', 'inference', 'unknown']),
  claim: z.string()
});

export const EvaluationOutputBaseSchemaV1 = z.object({
  schema_version: z.literal("1.0.0"),
  product: z.object({
    name: z.string().min(1),
    category: z.string(),
    summary: z.string(),
    primary_audience: z.string()
  }),
  article: z.object({
    headline: z.string().min(1),
    standfirst: z.string(),
    jury_summary: z.string(),
    where_jury_agreed: z.array(z.string()),
    where_jury_disagreed: z.array(z.object({
      criterion_id: CriterionIdSchemaV1,
      summary: z.string()
    })),
    evidence_limitations: z.array(z.string()),
    evidence_classifications: z.array(EvidenceClassificationSchemaV1),
    final_verdict: z.string(),
    meta_description: z.string()
  }),
  judges: z.array(JudgeEvaluationSchemaV1).length(5)
});

const refineJudgesV1 = (data: any) => {
  const judgeIds = data.judges.map((j: any) => j.judge_id);
  const uniqueJudges = new Set(judgeIds);
  if (uniqueJudges.size !== 5) return false;

  for (const judge of data.judges) {
    const critIds = judge.criteria.map((c: any) => c.criterion_id);
    const uniqueCrits = new Set(critIds);
    if (uniqueCrits.size !== 6) return false;
  }
  return true;
};

export const EvaluationOutputSchemaV1 = EvaluationOutputBaseSchemaV1.refine(refineJudgesV1, "Must contain exactly 5 unique judges, each with exactly 6 unique V1 criteria");

export const PublishedEvaluationSchemaV1 = EvaluationOutputBaseSchemaV1.extend({
  recalculated_jury_score: z.number(),
  judge_score_range: z.object({
    min: z.number(),
    max: z.number()
  }),
  criterion_averages: z.record(z.string(), z.number()).optional(),
  overall_evidence_confidence: z.number().optional(),
  judges: z.array(PublishedJudgeEvaluationSchemaV1).length(5)
}).refine(refineJudgesV1, "Must contain exactly 5 unique judges, each with exactly 6 unique V1 criteria");


// === V2 Criterion & Evaluation ===
export const CriterionIdSchemaV2 = z.enum([
  'purpose_usefulness',
  'implementation_evidence',
  'technical_quality',
  'usability_onboarding',
  'differentiation_insight',
  'project_health_stewardship'
]);
export type CriterionIdV2 = z.infer<typeof CriterionIdSchemaV2>;

export const CriterionEvaluationObjectV2 = z.object({
  criterion_id: CriterionIdSchemaV2,
  score: z.number().min(0).max(5).nullable(),
  confidence: ConfidenceSchema,
  reasoning: z.string().min(1),
  evidence_ids: z.array(z.string()),
  limitations: z.array(z.string())
});

const refineCriterionV2 = (data: any, ctx: z.RefinementCtx) => {
  if (data.confidence === 'not_assessable') {
    if (data.score !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "score must be null when confidence is 'not_assessable'",
        path: ["score"]
      });
    }
  } else {
    if (data.score === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "score must not be null when confidence is not 'not_assessable'",
        path: ["score"]
      });
    } else {
      if ((data.score * 10) % 5 !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "score must be in steps of 0.5",
          path: ["score"]
        });
      }
    }
  }

  if (data.confidence === 'low' || data.confidence === 'medium') {
    if (!data.limitations || data.limitations.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `limitations must not be empty when confidence is '${data.confidence}'`,
        path: ["limitations"]
      });
    }

    const reasoningLower = (data.reasoning || "").toLowerCase();
    const calibratedPhrases = [
      "according to",
      "states that",
      "metadata reports",
      "inferred",
      "suggests",
      "inferred that",
      "could not verify",
      "does not establish",
      "no public evidence",
      "source confirmed",
      "creator claim"
    ];
    const hasCalibratedPhrase = calibratedPhrases.some(phrase => reasoningLower.includes(phrase));
    if (!hasCalibratedPhrase) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `reasoning must use calibrated language (e.g. 'according to', 'inferred', 'could not verify') when confidence is '${data.confidence}'`,
        path: ["reasoning"]
      });
    }
  }
};

export const CriterionEvaluationSchemaV2 = CriterionEvaluationObjectV2.superRefine(refineCriterionV2);

export const PublishedCriterionEvaluationSchemaV2 = CriterionEvaluationObjectV2.extend({
  weighted_score: z.number().nullable()
}).superRefine(refineCriterionV2);

export const JudgeEvaluationSchemaV2 = z.object({
  judge_id: JudgeIdSchema,
  judge_name: z.string(),
  role: z.string(),
  verdict: z.string().min(1),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  decisive_question: z.string(),
  criteria: z.array(CriterionEvaluationSchemaV2).length(6)
});

export const PublishedJudgeEvaluationSchemaV2 = JudgeEvaluationSchemaV2.extend({
  judge_score: z.number().nullable(),
  criteria: z.array(PublishedCriterionEvaluationSchemaV2).length(6)
});

// === V2.1 Recommended Next Step (recommendation contract 1.0.0) ===
export const RECOMMENDATION_CONTRACT_VERSION = "1.0.0";

/**
 * Actionable recommendation replacing decisive_question on 2.1.0 articles. The action is a
 * published statement that must directly address the judge's primary concern (concerns[0]),
 * reference one of that judge's rubric criteria and be grounded in evidence the criterion
 * itself cites. Deterministic cross-field rules live in lib/evaluation/recommendations.ts;
 * this schema holds only the shape-level constraints.
 */
export const RecommendedNextStepSchema = z.object({
  action: z.string().min(1),
  primary_concern_index: z.literal(0),
  criterion_id: CriterionIdSchemaV2,
  evidence_ids: z.array(z.string()).min(1)
}).superRefine((data, ctx) => {
  if (new Set(data.evidence_ids).size !== data.evidence_ids.length) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['evidence_ids'],
      message: 'evidence_ids must not contain duplicates'
    });
  }
});

export type RecommendedNextStep = z.infer<typeof RecommendedNextStepSchema>;

export const JudgeEvaluationSchemaV2_1 = JudgeEvaluationSchemaV2
  .omit({ decisive_question: true })
  .extend({
    // decisive_question is forbidden on 2.1.0 judges: never generated, never stored.
    decisive_question: z.never().optional(),
    recommended_next_step: RecommendedNextStepSchema
  });

export const PublishedJudgeEvaluationSchemaV2_1 = JudgeEvaluationSchemaV2_1.extend({
  judge_score: z.number().nullable(),
  criteria: z.array(PublishedCriterionEvaluationSchemaV2).length(6)
});

export const EvidenceClassificationSchemaV2 = z.object({
  evidence_id: z.string(),
  // Legacy values plus the six refined EvidenceFactClass values. Refined reviews
  // (evaluation_integrity_version 1.0.0) use the fact-class vocabulary directly so
  // community_opinion / repository_observation / unverified survive into the public UI;
  // legacy reviews keep their model-authored values unchanged.
  classification: z.enum([
    'source_confirmed', 'creator_claim', 'inference', 'unknown', 'runtime_observed', 'community_claim',
    'confirmed_fact', 'community_opinion', 'repository_observation', 'unverified'
  ]),
  claim: z.string()
});

/**
 * Application-owned trusted claim reference. Each reference binds ONE statement of a public
 * field to its provenance. fact_class, attribution_required, source_fact_classes and
 * coverage_source are derived by the application from the evidence and the declared
 * support_mode — never supplied by the model (none of them exist in the generation schema).
 * evidence_ids may be empty only for `unverified` / `system_generated` references.
 */
export const ClaimReferenceSchema = z.object({
  claim_id: z.string(),
  public_output_path: z.string(),
  statement_index: z.number().int().nonnegative(),
  statement_text: z.string().min(1),
  support_mode: z.enum(['evidence_backed', 'inference', 'unverified']),
  fact_class: EvidenceFactClassSchema,
  attribution_required: z.boolean(),
  evidence_ids: z.array(z.string()),
  // Fact classes of the cited evidence, re-derived from evidence_ids by the application in
  // a fixed enum order (SOURCE_FACT_CLASS_ORDER) — never evidence_ids order. Keeps creator/
  // community provenance visible even when fact_class is `inference`/`unverified`. Optional
  // at the schema level only for legacy tolerance: refined reviews must carry it
  // (RefinedPublishedEvaluationSchemaV2 and the publication gate both enforce presence and
  // exact re-derivation); legacy reviews carry no claim_references and are left unchanged.
  source_fact_classes: z.array(EvidenceFactClassSchema).optional(),
  coverage_source: z.enum(['statement_annotation', 'system_generated']),
  // Legacy-tolerant optionals; no production review carries claim_references yet.
  evidence_id: z.string().optional(),
  target_field: z.string().optional(),
  claim_text: z.string().optional()
});

export type ClaimReference = z.infer<typeof ClaimReferenceSchema>;

export const TestEvidenceSummarySchema = z.object({
  has_pytest_configuration: z.boolean(),
  actual_test_files: z.array(z.string()),
  ci_workflows: z.array(z.string()),
  documented_test_commands: z.array(z.string()),
  test_result_artifacts: z.array(z.string()),
  test_badges: z.array(z.string()),
  relevant_source_files: z.array(z.string()),
  confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  limitations: z.array(z.string()),
  verified_execution_results: z.array(z.object({
    source: z.string(),
    status: z.literal("success"),
    commit_sha: z.string().min(7),
    verified_at: z.string(),
    artifact_url: z.string().url().optional()
  }))
});

export type TestEvidenceSummary = z.infer<typeof TestEvidenceSummarySchema>;

export const CoreSourceEvidenceSchema = z.object({
  evidence_ids: z.array(z.string()),
  source_files: z.array(z.string()),
  implementation_areas: z.array(z.string()),
  source_count: z.number()
});

export type CoreSourceEvidence = z.infer<typeof CoreSourceEvidenceSchema>;

/**
 * Which severe-claim domains (execution security, data write safety, cost controls,
 * production reliability — see lib/evidence/claim-domains.ts) the collected implementation
 * evidence reaches. App-derived at generation from the evidence bundle, never
 * model-authored; passed through untouched by the build-time recompute like the other
 * app-attached context. Optional because every review published before reach reporting
 * legitimately lacks it.
 */
export const ClaimDomainReachSchema = z.object({
  domain_id: z.string(),
  label: z.string(),
  examined: z.boolean(),
  evidence_ids: z.array(z.string()),
  matched_files: z.array(z.string())
});

export const ClaimEvidenceReachSchema = z.object({
  reach_version: z.literal('1.0.0'),
  domains: z.array(ClaimDomainReachSchema)
});

export type ClaimEvidenceReach = z.infer<typeof ClaimEvidenceReachSchema>;

export const ConfidenceAdjustmentSchema = z.object({
  scope: z.enum(["criterion", "overall"]),
  judge_id: z.string().optional(),
  criterion_id: z.string().optional(),
  original_confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  final_confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  ceiling_applied: z.boolean(),
  reason_codes: z.array(z.string())
});

export type ConfidenceAdjustment = z.infer<typeof ConfidenceAdjustmentSchema>;

export const CounterEvidenceReferenceSchema = z.object({
  discussion_item_id: z.string(),
  parent_evidence_id: z.string(),
  public_output_path: z.string(),
  target_field: z.string().optional()
});

export type CounterEvidenceReference = z.infer<typeof CounterEvidenceReferenceSchema>;

export const EvaluationOutputBaseSchemaV2 = z.object({
  schema_version: z.literal("2.0.0"),
  product: z.object({
    name: z.string().min(1),
    category: z.string(),
    summary: z.string(),
    primary_audience: z.string()
  }),
  article: z.object({
    headline: z.string().min(1),
    standfirst: z.string(),
    jury_summary: z.string(),
    where_jury_agreed: z.array(z.string()),
    where_jury_disagreed: z.array(z.object({
      criterion_id: CriterionIdSchemaV2,
      summary: z.string()
    })),
    evidence_limitations: z.array(z.string()),
    evidence_classifications: z.array(EvidenceClassificationSchemaV2),
    final_verdict: z.string(),
    meta_description: z.string()
  }),
  judges: z.array(JudgeEvaluationSchemaV2).length(5),
  
  // Extension fields (optional for compatibility with legacy content)
  project_identity: ProjectIdentitySchema.optional(),
  metadata_snapshot: GitHubMetadataSnapshotSchema.optional(),
  claim_references: z.array(ClaimReferenceSchema).optional(),
  counter_evidence_references: z.array(CounterEvidenceReferenceSchema).optional(),
  test_evidence_summary: TestEvidenceSummarySchema.optional(),
  core_source_evidence: CoreSourceEvidenceSchema.optional(),
  confidence_adjustments: z.array(ConfidenceAdjustmentSchema).optional(),
  discussion_evidence: DiscussionEvidenceSchema.optional(),
  evaluation_integrity_version: z.literal("1.0.0").optional()
});

const refineJudgesV2 = (data: any) => {
  const judgeIds = data.judges.map((j: any) => j.judge_id);
  const uniqueJudges = new Set(judgeIds);
  if (uniqueJudges.size !== 5) return false;

  for (const judge of data.judges) {
    const critIds = judge.criteria.map((c: any) => c.criterion_id);
    const uniqueCrits = new Set(critIds);
    if (uniqueCrits.size !== 6) return false;
  }
  return true;
};

export const EvaluationOutputSchemaV2 = EvaluationOutputBaseSchemaV2.refine(refineJudgesV2, "Must contain exactly 5 unique judges, each with exactly 6 unique V2 criteria");

export const PublishedEvaluationSchemaV2 = EvaluationOutputBaseSchemaV2.extend({
  recalculated_jury_score: z.number().nullable(),
  judge_score_range: z.object({
    min: z.number().nullable(),
    max: z.number().nullable()
  }),
  criterion_averages: z.record(z.string(), z.number().nullable()).optional(),
  overall_evidence_confidence: z.number().optional(),
  judges: z.array(PublishedJudgeEvaluationSchemaV2).length(5)
}).refine(refineJudgesV2, "Must contain exactly 5 unique judges, each with exactly 6 unique V2 criteria");

const refineRefinedIntegrity = (data: any, ctx: z.RefinementCtx) => {
  const requiredFields = [
    'project_identity',
    'core_source_evidence',
    'test_evidence_summary',
    'confidence_adjustments',
    'claim_references',
    'counter_evidence_references',
    'discussion_evidence'
  ] as const;

  if (data.evaluation_integrity_version !== '1.0.0') {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['evaluation_integrity_version'], message: 'Refined evaluation_integrity_version must be 1.0.0' });
  }
  for (const field of requiredFields) {
    if (data[field] === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field], message: `${field} is required for refined evaluations` });
    }
  }
  if (data.claim_references && data.claim_references.length === 0) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['claim_references'], message: 'claim_references must not be empty for refined evaluations' });
  }
  // Refined references must persist their source provenance; a reference without
  // source_fact_classes could silently launder a creator/community-grounded statement.
  (data.claim_references || []).forEach((reference: any, index: number) => {
    if (reference.source_fact_classes === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['claim_references', index, 'source_fact_classes'],
        message: 'source_fact_classes is required for refined claim references'
      });
    }
  });
};

/**
 * Strict schema for newly generated Phase 1 articles. The general V2 schema
 * remains backwards-compatible so historical articles can still be loaded.
 */
export const RefinedPublishedEvaluationSchemaV2 = PublishedEvaluationSchemaV2.superRefine(refineRefinedIntegrity);

// === V2.1 Evaluation (recommended_next_step replaces decisive_question) ===
export const EvaluationOutputBaseSchemaV2_1 = EvaluationOutputBaseSchemaV2.extend({
  schema_version: z.literal("2.1.0"),
  judges: z.array(JudgeEvaluationSchemaV2_1).length(5)
});

export const EvaluationOutputSchemaV2_1 = EvaluationOutputBaseSchemaV2_1.refine(refineJudgesV2, "Must contain exactly 5 unique judges, each with exactly 6 unique V2 criteria");

export const PublishedEvaluationSchemaV2_1 = EvaluationOutputBaseSchemaV2_1.extend({
  recalculated_jury_score: z.number().nullable(),
  judge_score_range: z.object({
    min: z.number().nullable(),
    max: z.number().nullable()
  }),
  criterion_averages: z.record(z.string(), z.number().nullable()).optional(),
  overall_evidence_confidence: z.number().optional(),
  judges: z.array(PublishedJudgeEvaluationSchemaV2_1).length(5)
}).refine(refineJudgesV2, "Must contain exactly 5 unique judges, each with exactly 6 unique V2 criteria");

/** Strict write schema for newly generated 2.1.0 evaluations. */
export const RefinedPublishedEvaluationSchemaV2_1 = PublishedEvaluationSchemaV2_1.superRefine(refineRefinedIntegrity);


// === Versioned Union Exports for backwards compatibility ===
export const EvaluationOutputSchema = z.union([
  EvaluationOutputSchemaV1,
  EvaluationOutputSchemaV2,
  EvaluationOutputSchemaV2_1
]);

// Evaluation union embedded by legacy (1.0.0 / 2.0.0) review schemas. Deliberately
// excludes V2.1: a legacy review can never carry a recommendation-contract evaluation.
export const PublishedEvaluationSchema = z.union([
  PublishedEvaluationSchemaV1,
  PublishedEvaluationSchemaV2
]);

// Every published evaluation shape, including 2.1.0 and 3.0.0 — for readers/recalculators.
// NOTE: PublishedEvaluationSchemaV3 is declared later in this file; the union is assembled
// lazily so file order stays readable. z.lazy defers resolution to first parse.
export const PublishedEvaluationAnySchema = z.union([
  PublishedEvaluationSchemaV1,
  PublishedEvaluationSchemaV2,
  PublishedEvaluationSchemaV2_1,
  z.lazy(() => PublishedEvaluationSchemaV3)
]);

export type EvaluationOutput = z.infer<typeof EvaluationOutputSchema>;
export type PublishedEvaluation = z.infer<typeof PublishedEvaluationSchema>;
export type PublishedEvaluationAny = z.infer<typeof PublishedEvaluationAnySchema>;

// === Simplified Gen Schemas for Gemini Generation API constraints ===
export const CriterionEvaluationGenSchemaV2 = z.object({
  criterion_id: CriterionIdSchemaV2,
  score: z.number().nullable(),
  confidence: ConfidenceSchema,
  reasoning: z.string(),
  evidence_ids: z.array(z.string()),
  limitations: z.array(z.string())
});

export const JudgeEvaluationGenSchemaV2 = z.object({
  judge_id: JudgeIdSchema,
  judge_name: z.string(),
  role: z.string(),
  verdict: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  decisive_question: z.string(),
  criteria: z.array(CriterionEvaluationGenSchemaV2)
});

/**
 * Untrusted, generation-only statement annotation. The model declares, per public statement,
 * its verbatim text, a support_mode, and the evidence it rests on. It carries NO fact_class
 * or attribution flag: the application derives those from the evidence itself and the
 * support_mode, and never takes them from the model. evidence_ids may be empty ONLY when
 * support_mode is 'unverified'.
 */
export const PublicStatementAnnotationGenSchema = z.object({
  public_output_path: z.string().min(1),
  statement_text: z.string().min(1),
  support_mode: z.enum(['evidence_backed', 'inference', 'unverified']),
  evidence_ids: z.array(z.string())
});

export type PublicStatementAnnotation = z.infer<typeof PublicStatementAnnotationGenSchema>;

export const EvaluationOutputGenSchemaV2 = z.object({
  schema_version: z.literal("2.0.0"),
  product: z.object({
    name: z.string(),
    category: z.string(),
    summary: z.string(),
    primary_audience: z.string()
  }),
  public_statement_annotations: z.array(PublicStatementAnnotationGenSchema).optional().default([]),
  article: z.object({
    headline: z.string(),
    standfirst: z.string(),
    jury_summary: z.string(),
    where_jury_agreed: z.array(z.string()),
    where_jury_disagreed: z.array(z.object({
      criterion_id: CriterionIdSchemaV2,
      summary: z.string()
    })),
    evidence_limitations: z.array(z.string()),
    evidence_classifications: z.array(EvidenceClassificationSchemaV2),
    final_verdict: z.string(),
    meta_description: z.string()
  }),
  judges: z.array(JudgeEvaluationGenSchemaV2)
});

/**
 * Generation-only recommended_next_step. primary_concern_index is a plain number here so the
 * Gemini structured-output schema stays simple; the application rejects any value other than 0
 * (a retryable generation failure), never remediating it silently.
 */
export const RecommendedNextStepGenSchema = z.object({
  action: z.string(),
  primary_concern_index: z.number(),
  criterion_id: CriterionIdSchemaV2,
  evidence_ids: z.array(z.string())
});

export const JudgeEvaluationGenSchemaV2_1 = z.object({
  judge_id: JudgeIdSchema,
  judge_name: z.string(),
  role: z.string(),
  verdict: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  recommended_next_step: RecommendedNextStepGenSchema,
  criteria: z.array(CriterionEvaluationGenSchemaV2)
});

/** Generation schema for 2.1.0 articles: decisive_question is intentionally absent. */
export const EvaluationOutputGenSchemaV2_1 = EvaluationOutputGenSchemaV2.extend({
  schema_version: z.literal("2.1.0"),
  judges: z.array(JudgeEvaluationGenSchemaV2_1)
});

// === V3 Editorial Evaluation (editorial-first pipeline) ===
//
// The 3.0.0 contract separates writing from record-keeping: Request 1 (this schema) is the
// jury's editorial output — evaluation, article, scores — and carries NO audit apparatus.
// Statement-to-evidence linkage lives in a separate, regenerable evidence map produced by an
// independent request AFTER the article is persisted (see schemas/evidence-map.ts). Removed
// against 2.1.0, deliberately and permanently: public_statement_annotations,
// evidence_classifications, per-criterion evidence_ids, recommendation evidence binding,
// decisive_question, the calibrated-wording refines and the non-empty-limitations refine.

/**
 * V3 recommended next step: the advice and the rubric criterion it would most improve. The
 * criterion link survives only for UI anchoring; the evidence binding and the concern-index
 * contract are gone — whether the advice is good is editorial, not checkable.
 */
export const RecommendedNextStepGenSchemaV3 = z.object({
  action: z.string(),
  criterion_id: CriterionIdSchemaV2
});

/**
 * V3 criterion: no evidence_ids — the evidence map records grounding after the fact.
 *
 * `score` is deliberately a bare nullable number, matching the 2.x generation schema that is
 * proven against Gemini structured output. Adding `.min()/.max()` here would serialize as an
 * `anyOf` union rather than the `{"type":["number","null"]}` form the working schema emits,
 * and a wire schema the model cannot satisfy is exactly how this pipeline reached a 0%
 * first-attempt pass rate before. Range, 0.5-grid and null⟷not_assessable are all enforced
 * app-side by refineEvaluationV3 — the gate is no weaker, it just does not risk the request.
 */
export const CriterionEvaluationGenSchemaV3 = z.object({
  criterion_id: CriterionIdSchemaV2,
  score: z.number().nullable(),
  confidence: ConfidenceSchema,
  reasoning: z.string(),
  limitations: z.array(z.string())
});

export const JudgeEvaluationGenSchemaV3 = z.object({
  judge_id: JudgeIdSchema,
  judge_name: z.string(),
  role: z.string(),
  verdict: z.string(),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  recommended_next_step: RecommendedNextStepGenSchemaV3,
  // Length is asserted app-side (refineEvaluationV3), not on the wire: the 2.x generation
  // schemas that are proven against Gemini structured output constrain no array lengths, and
  // matching their construct set exactly is worth more than a redundant wire-level assertion.
  criteria: z.array(CriterionEvaluationGenSchemaV3)
});

export const EvaluationOutputGenSchemaV3 = z.object({
  schema_version: z.literal("3.0.0"),
  product: z.object({
    name: z.string(),
    category: z.string(),
    summary: z.string(),
    primary_audience: z.string()
  }),
  article: z.object({
    headline: z.string(),
    standfirst: z.string(),
    jury_summary: z.string(),
    where_jury_agreed: z.array(z.string()),
    where_jury_disagreed: z.array(z.object({
      criterion_id: CriterionIdSchemaV2,
      summary: z.string()
    })),
    /** May be empty: honesty about gaps is asked for, boilerplate is not. */
    evidence_limitations: z.array(z.string()),
    final_verdict: z.string(),
    meta_description: z.string()
  }),
  // See JudgeEvaluationGenSchemaV3.criteria: length is an app-side gate, not a wire constraint.
  judges: z.array(JudgeEvaluationGenSchemaV3)
});

/**
 * The structural score rules that survive into V3 as system protection: a score exists
 * exactly when the criterion was assessable, sits within 0..5, and lands on the 0.5 grid.
 * Everything the V2 refine said about wording and limitations is gone.
 *
 * The range check lives here rather than on the wire schema on purpose — see
 * CriterionEvaluationGenSchemaV3. Enforcement is identical; only the serialized wire shape
 * differs, and the wire shape has to be one the model can actually satisfy.
 */
const refineEvaluationV3 = (data: any, ctx: z.RefinementCtx) => {
  // Explicit array lengths, because uniqueness alone does not imply count: six judges where
  // two share an id yields five unique ids and would otherwise slip through.
  if (!Array.isArray(data.judges) || data.judges.length !== 5) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['judges'],
      message: 'Must contain exactly 5 judges'
    });
    return;
  }
  for (const [judgeIndex, judge] of data.judges.entries()) {
    if (!Array.isArray(judge.criteria) || judge.criteria.length !== 6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['judges', judgeIndex, 'criteria'],
        message: 'Each judge must score exactly 6 criteria'
      });
      return;
    }
  }
  if (!refineJudgesV2(data)) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['judges'],
      message: 'Must contain exactly 5 unique judges, each with exactly 6 unique criteria'
    });
  }
  (data.judges || []).forEach((judge: any, judgeIndex: number) => {
    (judge.criteria || []).forEach((criterion: any, criterionIndex: number) => {
      const path = ['judges', judgeIndex, 'criteria', criterionIndex, 'score'];
      if (criterion.confidence === 'not_assessable') {
        if (criterion.score !== null) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "score must be null when confidence is 'not_assessable'" });
        }
      } else if (criterion.score === null) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: "score must not be null when confidence is not 'not_assessable'" });
      } else if (criterion.score < 0 || criterion.score > 5) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'score must be between 0 and 5' });
      } else if ((criterion.score * 10) % 5 !== 0) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path, message: 'score must be in steps of 0.5' });
      }
    });
  });
};

/** Strict app-side parse of a V3 generation (the validator's schema gate). */
export const EvaluationOutputSchemaV3 = EvaluationOutputGenSchemaV3.superRefine(refineEvaluationV3);

export const PublishedCriterionEvaluationSchemaV3 = CriterionEvaluationGenSchemaV3.extend({
  weighted_score: z.number().nullable()
});

export const PublishedJudgeEvaluationSchemaV3 = JudgeEvaluationGenSchemaV3.extend({
  judge_score: z.number().nullable(),
  criteria: z.array(PublishedCriterionEvaluationSchemaV3).length(6)
});

/**
 * Published V3 evaluation: the editorial output plus app-computed scores and app-attached
 * evidence context. overall_evidence_confidence is the plain mean of criterion confidences —
 * no ceilings, no prose rewriting — and must be reproducible at site-build time from the
 * evaluation content alone (data.ts re-runs the recalculation on every build).
 * evaluation_integrity_version is intentionally absent: V3 reviews must never enter the
 * refined (1.0.0) dispatch anywhere.
 */
export const PublishedEvaluationSchemaV3 = EvaluationOutputGenSchemaV3.extend({
  judges: z.array(PublishedJudgeEvaluationSchemaV3).length(5),
  recalculated_jury_score: z.number().nullable(),
  judge_score_range: z.object({
    min: z.number().nullable(),
    max: z.number().nullable()
  }),
  criterion_averages: z.record(z.string(), z.number().nullable()).optional(),
  overall_evidence_confidence: z.number().optional(),
  // App-attached context (never model-authored); rendered in the collapsed appendix.
  project_identity: ProjectIdentitySchema.optional(),
  metadata_snapshot: GitHubMetadataSnapshotSchema.optional(),
  test_evidence_summary: TestEvidenceSummarySchema.optional(),
  core_source_evidence: CoreSourceEvidenceSchema.optional(),
  claim_evidence_reach: ClaimEvidenceReachSchema.optional(),
  discussion_evidence: DiscussionEvidenceSchema.optional()
}).superRefine(refineEvaluationV3);
