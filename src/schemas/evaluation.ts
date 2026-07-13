import { z } from 'zod';

export const ConfidenceSchema = z.enum(['high', 'medium', 'low', 'not_assessable']);
export type Confidence = z.infer<typeof ConfidenceSchema>;

export const JudgeIdSchema = z.enum(['alex', 'david', 'lisa', 'sarah', 'marcus']);
export type JudgeId = z.infer<typeof JudgeIdSchema>;

export const CriterionIdSchema = z.enum([
  'innovation_creativity',
  'technical_implementation',
  'problem_solving_impact',
  'product_ux',
  'working_prototype',
  'presentation'
]);
export type CriterionId = z.infer<typeof CriterionIdSchema>;

export const CriterionEvaluationSchema = z.object({
  criterion_id: CriterionIdSchema,
  score: z.number().min(0).max(5),
  confidence: ConfidenceSchema,
  reasoning: z.string().min(1),
  evidence_ids: z.array(z.string()),
  limitations: z.array(z.string())
});

export const PublishedCriterionEvaluationSchema = CriterionEvaluationSchema.extend({
  weighted_score: z.number()
});

export const JudgeEvaluationSchema = z.object({
  judge_id: JudgeIdSchema,
  judge_name: z.string(),
  role: z.string(),
  verdict: z.string().min(1),
  strengths: z.array(z.string()),
  concerns: z.array(z.string()),
  decisive_question: z.string(),
  criteria: z.array(CriterionEvaluationSchema).length(6)
});

export const PublishedJudgeEvaluationSchema = JudgeEvaluationSchema.extend({
  judge_score: z.number(),
  criteria: z.array(PublishedCriterionEvaluationSchema).length(6)
});

export const EvidenceClassificationSchema = z.object({
  evidence_id: z.string(),
  classification: z.enum(['verified_fact', 'creator_claim', 'inference', 'unknown']),
  claim: z.string()
});

export const EvaluationOutputBaseSchema = z.object({
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
      criterion_id: CriterionIdSchema,
      summary: z.string()
    })),
    evidence_limitations: z.array(z.string()),
    evidence_classifications: z.array(EvidenceClassificationSchema),
    final_verdict: z.string(),
    meta_description: z.string()
  }),
  judges: z.array(JudgeEvaluationSchema).length(5)
});

const refineJudges = (data: any) => {
  // Ensure all 5 unique judges are present
  const judgeIds = data.judges.map((j: any) => j.judge_id);
  const uniqueJudges = new Set(judgeIds);
  if (uniqueJudges.size !== 5) return false;

  // Ensure each judge has all 6 unique criteria
  for (const judge of data.judges) {
    const critIds = judge.criteria.map((c: any) => c.criterion_id);
    const uniqueCrits = new Set(critIds);
    if (uniqueCrits.size !== 6) return false;
  }
  return true;
};

export const EvaluationOutputSchema = EvaluationOutputBaseSchema.refine(refineJudges, "Must contain exactly 5 unique judges, each with exactly 6 unique criteria");


export const PublishedEvaluationSchema = EvaluationOutputBaseSchema.extend({
  recalculated_jury_score: z.number(),
  judge_score_range: z.object({
    min: z.number(),
    max: z.number()
  }),
  criterion_averages: z.record(z.string(), z.number()).optional(),
  overall_evidence_confidence: z.number().optional(),
  judges: z.array(PublishedJudgeEvaluationSchema).length(5)
}).refine(refineJudges, "Must contain exactly 5 unique judges, each with exactly 6 unique criteria");

export type EvaluationOutput = z.infer<typeof EvaluationOutputSchema>;
export type PublishedEvaluation = z.infer<typeof PublishedEvaluationSchema>;
