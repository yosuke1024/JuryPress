import { z } from 'zod';
import { GitHubMetadataSnapshotSchema } from './evidence';


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
  classification: z.enum(['source_confirmed', 'creator_claim', 'inference', 'unknown', 'runtime_observed', 'community_claim']),
  claim: z.string()
});

export const IdentitySourceSchema = z.enum([
  "readme_h1",
  "package_manifest",
  "official_website",
  "repository_name",
  "source_title_inference"
]);

export const ProjectIdentitySchema = z.object({
  canonical_display_name: z.string(),
  repository_full_name: z.string().optional(),
  repository_name: z.string().optional(),
  source_title: z.string(),
  identity_source: IdentitySourceSchema
});

export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

export const ClaimReferenceSchema = z.object({
  evidence_id: z.string(),
  fact_class: z.enum([
    "confirmed_fact",
    "creator_claim",
    "community_opinion",
    "repository_observation",
    "inference",
    "unverified"
  ]),
  attribution_required: z.boolean()
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
  limitations: z.array(z.string())
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
  original_confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  final_confidence: z.enum(["LOW", "MEDIUM", "HIGH"]),
  ceiling_applied: z.boolean(),
  reason_codes: z.array(z.string())
});

export type ConfidenceAdjustment = z.infer<typeof ConfidenceAdjustmentSchema>;

export const DiscussionEvidenceSchema = z.object({
  positive: z.array(z.string()),
  critical: z.array(z.string()),
  neutral: z.array(z.string())
});

export type DiscussionEvidence = z.infer<typeof DiscussionEvidenceSchema>;

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
  test_evidence_summary: TestEvidenceSummarySchema.optional(),
  core_source_evidence: CoreSourceEvidenceSchema.optional(),
  confidence_adjustments: z.array(ConfidenceAdjustmentSchema).optional(),
  discussion_evidence: DiscussionEvidenceSchema.optional()
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

export const EvaluationOutputGenSchemaV2 = z.object({
  schema_version: z.literal("2.0.0"),
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
    evidence_limitations: z.array(z.string()),
    evidence_classifications: z.array(EvidenceClassificationSchemaV2),
    final_verdict: z.string(),
    meta_description: z.string()
  }),
  judges: z.array(JudgeEvaluationGenSchemaV2),

  // Extension fields for generation output schema
  project_identity: ProjectIdentitySchema.optional(),
  metadata_snapshot: GitHubMetadataSnapshotSchema.optional(),
  claim_references: z.array(ClaimReferenceSchema).optional(),
  test_evidence_summary: TestEvidenceSummarySchema.optional(),
  core_source_evidence: CoreSourceEvidenceSchema.optional(),
  confidence_adjustments: z.array(ConfidenceAdjustmentSchema).optional(),
  discussion_evidence: DiscussionEvidenceSchema.optional()
});


