import { z } from 'zod';

export const CandidateSchema = z.object({
  source: z.string(),
  sourceId: z.string(),
  name: z.string(),
  canonicalUrl: z.string().url(),
  sourceUrl: z.string().url(),
  sourceRank: z.number(),
  popularityValue: z.number(),
  popularityUnit: z.string(),
  publishedAt: z.string().optional(),
  collectedAt: z.string(),
  metadata: z.record(z.unknown())
});

export type Candidate = z.infer<typeof CandidateSchema>;

export const SelectionSchema = z.object({
  schema_version: z.literal("1.0.0"),
  data_class: z.enum(["fixture", "production"]),
  run_key: z.string(),
  source: z.string(),
  source_rank: z.number(),
  popularity_value: z.number(),
  popularity_unit: z.string(),
  selection_rule: z.string(),
  selected_at: z.string(),
  canonical_url: z.string().url(),
  source_url: z.string().url(),
  algorithm_version: z.string(),
  human_selected: z.boolean(),
  candidate_name: z.string(),
  source_id: z.string(),
  candidate_metadata: z.record(z.any())
});

export type Selection = z.infer<typeof SelectionSchema>;

export const FailureSchema = z.object({
  data_class: z.enum(["fixture", "production"]),
  run_key: z.string(),
  status: z.literal("failed"),
  stage: z.string(),
  candidate: z.object({
    name: z.string(),
    canonical_url: z.string()
  }).optional(),
  attempts: z.number(),
  error_code: z.string(),
  error_summary: z.string(),
  failed_at: z.string()
});

export type Failure = z.infer<typeof FailureSchema>;

export const RunStateSchema = z.object({
  schema_version: z.literal("1.0.0").optional(),
  data_class: z.enum(["fixture", "production"]),
  status: z.enum(["selected", "published", "failed"]),
  run_key: z.string(),
  updated_at: z.string().optional(),
  published_at: z.string().optional(),
  slug: z.string().optional(),
  candidate: z.any().optional(),
  selection: z.any().optional()
});

export type RunState = z.infer<typeof RunStateSchema>;

export const PublicationStateSchema = z.object({
  schema_version: z.literal("1.0.0").optional(),
  data_class: z.enum(["fixture", "production"]),
  content_id: z.string(),
  slug: z.string(),
  source_canonical_url: z.string().url(),
  selected_at: z.string(),
  generated_at: z.string(),
  published_at: z.string().optional(),
  generation_run_id: z.string(),
  publication_status: z.enum(["generated", "validated", "committed", "published", "failed"])
});

export type PublicationState = z.infer<typeof PublicationStateSchema>;
