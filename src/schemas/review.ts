import { z } from 'zod';
import { PublishedEvaluationSchema } from './evaluation';

export const ReviewSchema = z.object({
  schema_version: z.literal("1.0.0"),
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
});

export type Review = z.infer<typeof ReviewSchema>;
