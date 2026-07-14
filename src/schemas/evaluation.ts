import { z } from 'zod';

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

const refineCriterionV2 = (data: { confidence: string; score: number | null }, ctx: z.RefinementCtx) => {
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
  classification: z.enum(['source_confirmed', 'creator_claim', 'inference', 'unknown', 'runtime_observed']),
  claim: z.string()
});

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
  judges: z.array(JudgeEvaluationSchemaV2).length(5)
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
  judges: z.array(JudgeEvaluationGenSchemaV2)
});

