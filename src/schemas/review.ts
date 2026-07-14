import { z } from 'zod';
import { PublishedEvaluationSchema } from './evaluation';

export const ReviewSchema = z.object({
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
  }).optional()
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
});

export type Review = z.infer<typeof ReviewSchema>;
