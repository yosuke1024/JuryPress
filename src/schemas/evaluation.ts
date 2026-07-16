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
 * field to its provenance. fact_class, attribution_required and coverage_source are derived
 * by the application from the evidence and the declared support_mode — never supplied by the
 * model. evidence_ids may be empty only for `unverified` / `system_generated` references.
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

/**
 * Strict schema for newly generated Phase 1 articles. The general V2 schema
 * remains backwards-compatible so historical articles can still be loaded.
 */
export const RefinedPublishedEvaluationSchemaV2 = PublishedEvaluationSchemaV2.superRefine((data, ctx) => {
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
});


// === Versioned Union Exports for backwards compatibility ===
export const EvaluationOutputSchema = z.union([
  EvaluationOutputSchemaV1,
  EvaluationOutputSchemaV2
]);

export const PublishedEvaluationSchema = z.union([
  PublishedEvaluationSchemaV1,
  PublishedEvaluationSchemaV2
]);

export type EvaluationOutput = z.infer<typeof EvaluationOutputSchema>;
export type PublishedEvaluation = z.infer<typeof PublishedEvaluationSchema>;

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
