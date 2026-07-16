import { z } from 'zod';
import {
  PublishedEvaluationSchema,
  PublishedEvaluationSchemaV2_1,
  RefinedPublishedEvaluationSchemaV2,
  RefinedPublishedEvaluationSchemaV2_1,
  RECOMMENDATION_CONTRACT_VERSION
} from './evaluation';

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
const ReviewObjectV2 = z.object({
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
});

const reviewV2Rules = (data: any, ctx: z.RefinementCtx) => {
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
};

export const ReviewSchemaV2 = ReviewObjectV2.superRefine(reviewV2Rules);

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

// === Generation metadata (Phase 3, stored on 2.1.0 reviews) ===
export const GenerationMetadataSchema = z.object({
  requested_model: z.string().min(1),
  used_model: z.string().min(1),
  thinking_level: z.literal("HIGH"),
  successful_route: z.enum(["primary", "fallback"]),
  failover_used: z.boolean(),
  primary_attempts: z.number().int().nonnegative(),
  fallback_attempts: z.number().int().nonnegative(),
  total_attempts: z.number().int().positive(),
  token_usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    // Values the Gemini response did not report are null, never fabricated zeros.
    thinking_tokens: z.number().nullable(),
    total_tokens: z.number().nullable(),
    cached_input_tokens: z.number().nullable()
  })
});

export type GenerationMetadata = z.infer<typeof GenerationMetadataSchema>;

/**
 * Cross-checks generation_metadata against the legacy top-level fields so the two views of
 * one generation can never disagree: model === used_model, route/attempt values match
 * generation_route, usage tokens match token_usage, and the token totals are coherent.
 */
const generationMetadataRules = (data: any, ctx: z.RefinementCtx) => {
  const metadata = data.generation_metadata;
  if (!metadata) return;

  if (data.model !== metadata.used_model) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["generation_metadata", "used_model"],
      message: "generation_metadata.used_model must equal the top-level model"
    });
  }

  const route = data.generation_route;
  if (!route) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["generation_route"],
      message: "generation_route is required when generation_metadata is present"
    });
  } else {
    const pairs: Array<[string, unknown, unknown]> = [
      ["successful_route", route.successful_route, metadata.successful_route],
      ["failover_used", route.failover_used, metadata.failover_used],
      ["primary_attempts", route.primary_attempts, metadata.primary_attempts],
      ["fallback_attempts", route.fallback_attempts, metadata.fallback_attempts],
      ["total_attempts", route.total_attempts, metadata.total_attempts]
    ];
    for (const [field, routeValue, metadataValue] of pairs) {
      if (routeValue !== metadataValue) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["generation_metadata", field],
          message: `generation_metadata.${field} must equal generation_route.${field}`
        });
      }
    }
  }

  if (data.attempt_count !== undefined && data.attempt_count !== metadata.total_attempts) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["generation_metadata", "total_attempts"],
      message: "generation_metadata.total_attempts must equal attempt_count"
    });
  }

  const usage = data.usage;
  const tokens = metadata.token_usage;
  if (usage) {
    if (usage.input_tokens !== null && usage.input_tokens !== undefined && usage.input_tokens !== tokens.input_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generation_metadata", "token_usage", "input_tokens"],
        message: "token_usage.input_tokens must equal usage.input_tokens"
      });
    }
    if (usage.output_tokens !== null && usage.output_tokens !== undefined && usage.output_tokens !== tokens.output_tokens) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generation_metadata", "token_usage", "output_tokens"],
        message: "token_usage.output_tokens must equal usage.output_tokens"
      });
    }
  }
  if (tokens.total_tokens !== null) {
    const knownSum = tokens.input_tokens + tokens.output_tokens + (tokens.thinking_tokens ?? 0);
    if (tokens.total_tokens < knownSum) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["generation_metadata", "token_usage", "total_tokens"],
        message: "token_usage.total_tokens must not be smaller than the sum of its parts"
      });
    }
  }
};

// === Review Schema V2.1 (actionable recommendations) ===
/**
 * Top-level schema for newly generated articles. Judges carry recommended_next_step and can
 * no longer carry decisive_question; existing 1.0.0 / 2.0.0 reviews stay on their own
 * schemas and are never migrated.
 */
const ReviewObjectV2_1 = ReviewObjectV2.extend({
  schema_version: z.literal("2.1.0"),
  recommendation_contract_version: z.literal(RECOMMENDATION_CONTRACT_VERSION),
  generation_metadata: GenerationMetadataSchema,
  evaluation: PublishedEvaluationSchemaV2_1
});

export const ReviewSchemaV2_1 = ReviewObjectV2_1.superRefine(reviewV2Rules).superRefine(generationMetadataRules);

/** Strict write schema for reviews created by the 2.1.0 daily pipeline. */
export const RefinedReviewSchemaV2_1 = ReviewSchemaV2_1.superRefine((data, ctx) => {
  const parsed = RefinedPublishedEvaluationSchemaV2_1.safeParse(data.evaluation);
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
  ReviewSchemaV2,
  ReviewSchemaV2_1
]);

export type Review = z.infer<typeof ReviewSchema>;
export type ReviewV1 = z.infer<typeof ReviewSchemaV1>;
export type ReviewV2 = z.infer<typeof ReviewSchemaV2>;
export type ReviewV2_1 = z.infer<typeof ReviewSchemaV2_1>;

