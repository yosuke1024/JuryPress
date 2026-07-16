import { z } from 'zod';
import { PublishedEvaluationSchema, RefinedPublishedEvaluationSchemaV2 } from './evaluation';

export const CorrectionSchema = z.object({
  corrected_at: z.string(),
  type: z.enum(["factual-metadata", "reevaluation", "rubric-migration"]),
  summary: z.string(),
  score_changed: z.boolean(),
  previous_score: z.number().optional(),
  new_score: z.number().optional(),
  previous_rubric: z.string().optional(),
  previous_rubric_version: z.string().optional(),
  new_rubric: z.string().optional(),
  new_rubric_version: z.string().optional()
});

export type Correction = z.infer<typeof CorrectionSchema>;

// === Review Schema V1 ===
export const ReviewSchemaV1 = z.object({
  schema_version: z.literal("1.0.0"),
  data_class: z.enum(["fixture", "production"]),
  content_license: z.enum(["all-rights-reserved", "mit"]).optional(),
  copyright_holder: z.string().optional(),
  season: z.number(),
  slug: z.string(),
  published_at: z.string(),
  model: z.string(),
  attempt_count: z.number().optional(),
  prompt_version: z.string(),
  rubric_version: z.string(),
  human_reviewed: z.boolean(),
  jury_score: z.number(),
  judge_score_range: z.object({
    min: z.number(),
    max: z.number()
  }),
  evaluation: PublishedEvaluationSchema,
  usage: z.object({
    input_tokens: z.number().nullable().optional(),
    output_tokens: z.number().nullable().optional(),
    estimated_cost: z.number().nullable().optional()
  }),
  evidence_usage: z.object({
    raw_character_count: z.number().nullable(),
    sanitized_character_count: z.number().nullable(),
    characters_sent_to_model: z.number(),
    budget_limit: z.number(),
    reduction_ratio: z.number().nullable()
  }).optional(),
  relationship: z.enum(["independent", "related-party"]),
  ranking_eligible: z.boolean(),
  ranking_exclusion_reason: z.string().optional(),
  disclosure: z.string().optional(),
  corrections: z.array(CorrectionSchema).optional()
}).superRefine((data, ctx) => {
  if (data.data_class === 'production') {
    if (data.content_license !== 'all-rights-reserved') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content_license must be 'all-rights-reserved' in production mode",
        path: ["content_license"]
      });
    }
    if (data.copyright_holder !== 'Yosuke Suzuki') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "copyright_holder must be 'Yosuke Suzuki' in production mode",
        path: ["copyright_holder"]
      });
    }
  }
  
  if (data.relationship === 'related-party') {
    if (data.ranking_eligible !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ranking_eligible must be false for related-party projects",
        path: ["ranking_eligible"]
      });
    }
    if (!data.ranking_exclusion_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ranking_exclusion_reason is required for related-party projects",
        path: ["ranking_exclusion_reason"]
      });
    }
  } else if (data.relationship === 'independent') {
    if (data.ranking_eligible !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ranking_eligible must be true for independent projects",
        path: ["ranking_eligible"]
      });
    }
    if (data.ranking_exclusion_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ranking_exclusion_reason must not be set for independent projects",
        path: ["ranking_exclusion_reason"]
      });
    }
  }
});

// === Review Schema V2 ===
export const ReviewSchemaV2 = z.object({
  schema_version: z.literal("2.0.0"),
  data_class: z.enum(["fixture", "production"]),
  content_license: z.enum(["all-rights-reserved", "mit"]).optional(),
  copyright_holder: z.string().optional(),
  season: z.literal(2),
  review_scope: z.literal("open-source-software-product"),
  slug: z.string(),
  published_at: z.string(),
  model: z.string(),
  attempt_count: z.number().optional(),
  generation_route: z.object({
    successful_route: z.enum(["primary", "fallback"]),
    failover_used: z.boolean(),
    primary_attempts: z.number(),
    fallback_attempts: z.number(),
    total_attempts: z.number()
  }).optional(),
  prompt_version: z.string(),
  rubric_id: z.literal("open-source-product"),
  rubric_version: z.literal("2.0.0"),
  selection_policy_id: z.literal("open-source-product"),
  selection_policy_version: z.literal("2.0.0"),
  evaluation_status: z.enum(["complete", "evidence_limited", "failed"]),
  assessment_coverage: z.number().min(0).max(1),
  human_reviewed: z.boolean(),
  jury_score: z.number().nullable(),
  judge_score_range: z.object({
    min: z.number().nullable(),
    max: z.number().nullable()
  }),
  evaluation: PublishedEvaluationSchema,
  usage: z.object({
    input_tokens: z.number().nullable().optional(),
    output_tokens: z.number().nullable().optional(),
    estimated_cost: z.number().nullable().optional()
  }),
  evidence_usage: z.object({
    raw_character_count: z.number().nullable(),
    sanitized_character_count: z.number().nullable(),
    characters_sent_to_model: z.number(),
    budget_limit: z.number(),
    reduction_ratio: z.number().nullable()
  }).optional(),
  provenance: z.object({
    no_fixture_provenance: z.boolean(),
    api_metadata_verified: z.boolean(),
    recalculated_by_code: z.boolean(),
    verified_at: z.string()
  }).optional(),
  relationship: z.enum(["independent", "related-party"]),
  ranking_eligible: z.boolean(),
  ranking_exclusion_reason: z.string().optional(),
  disclosure: z.string().optional(),
  corrections: z.array(CorrectionSchema).optional()
}).superRefine((data, ctx) => {
  if (data.data_class === 'production') {
    if (data.content_license !== 'all-rights-reserved') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "content_license must be 'all-rights-reserved' in production mode",
        path: ["content_license"]
      });
    }
    if (data.copyright_holder !== 'Yosuke Suzuki') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "copyright_holder must be 'Yosuke Suzuki' in production mode",
        path: ["copyright_holder"]
      });
    }
  }

  // Not Assessable integration
  if (data.evaluation_status === 'evidence_limited') {
    if (data.jury_score !== null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "jury_score must be null for evidence_limited status",
        path: ["jury_score"]
      });
    }
    if (data.ranking_eligible !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ranking_eligible must be false for evidence_limited status",
        path: ["ranking_eligible"]
      });
    }
    if (!data.ranking_exclusion_reason || data.ranking_exclusion_reason !== 'evidence-limited-project') {
       // Allow custom reason but evidence-limited-project is standard
    }
  }

  if (data.relationship === 'related-party') {
    if (data.ranking_eligible !== false) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ranking_eligible must be false for related-party projects",
        path: ["ranking_eligible"]
      });
    }
    if (!data.ranking_exclusion_reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "ranking_exclusion_reason is required for related-party projects",
        path: ["ranking_exclusion_reason"]
      });
    }
  } else if (data.relationship === 'independent') {
    if (data.evaluation_status === 'complete' && data.assessment_coverage === 1.0) {
      if (data.ranking_eligible !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ranking_eligible must be true for complete independent projects",
          path: ["ranking_eligible"]
        });
      }
      if (data.ranking_exclusion_reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ranking_exclusion_reason must not be set for complete independent projects",
          path: ["ranking_exclusion_reason"]
        });
      }
    } else {
      if (data.ranking_eligible !== false) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ranking_eligible must be false for incomplete/limited independent projects",
          path: ["ranking_eligible"]
        });
      }
      if (!data.ranking_exclusion_reason) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "ranking_exclusion_reason is required for incomplete/limited independent projects",
          path: ["ranking_exclusion_reason"]
        });
      }
    }
  }
});

/** Strict write schema for reviews created by the Phase 1 daily pipeline. */
export const RefinedReviewSchemaV2 = ReviewSchemaV2.superRefine((data, ctx) => {
  const parsed = RefinedPublishedEvaluationSchemaV2.safeParse(data.evaluation);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['evaluation', ...issue.path],
        message: issue.message
      });
    }
  }
});

// === Union Export ===
export const ReviewSchema = z.union([
  ReviewSchemaV1,
  ReviewSchemaV2
]);

export type Review = z.infer<typeof ReviewSchema>;
export type ReviewV1 = z.infer<typeof ReviewSchemaV1>;
export type ReviewV2 = z.infer<typeof ReviewSchemaV2>;

