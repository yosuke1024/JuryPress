import { z } from 'zod';
import { EvidenceCollectionResultSchema } from './evidence';

export const SourceMetricSchema = z.object({
  platform: z.enum(["github", "hacker-news", "hugging-face"]),
  metric: z.enum(["stars", "points", "likes"]),
  value: z.number(),
  source_url: z.string().url(),
  retrieved_at: z.string() // ISO timestamp
});

export type SourceMetric = z.infer<typeof SourceMetricSchema>;

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
  metadata: z.record(z.unknown()),
  additional_evidence_urls: z.array(z.string().url()).optional()
});

export type Candidate = z.infer<typeof CandidateSchema>;

export const SelectionSchema = z.object({
  schema_version: z.literal("1.0.0"),
  data_class: z.enum(["fixture", "production"]),
  run_key: z.string(),
  source: z.string(),
  source_rank: z.number().nullable().optional(),
  popularity_value: z.number().optional(), // Legacy, now optional
  popularity_unit: z.string().optional(), // Legacy, now optional
  selection_rule: z.string(),
  selected_at: z.string(),
  canonical_url: z.string().url(),
  source_url: z.string().url(),
  algorithm_version: z.string(),
  human_selected: z.boolean(),
  candidate_name: z.string(),
  source_id: z.string(),
  candidate_metadata: z.record(z.any()),
  
  // New transparency metrics
  selection_mode: z.enum(["initial-bootstrap", "automated-daily"]),
  selected_by: z.enum(["operator", "system"]),
  source_metrics: z.array(SourceMetricSchema).optional()
}).superRefine((data, ctx) => {
  // Mode-based consistency checks
  if (data.selection_mode === 'initial-bootstrap') {
    if (data.selected_by !== 'operator') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selected_by must be 'operator' for initial-bootstrap mode",
        path: ["selected_by"]
      });
    }
    if (data.source_rank !== null && data.source_rank !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_rank must be null or omitted for initial-bootstrap mode",
        path: ["source_rank"]
      });
    }
  } else if (data.selection_mode === 'automated-daily') {
    if (data.selected_by !== 'system') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selected_by must be 'system' for automated-daily mode",
        path: ["selected_by"]
      });
    }
    if (data.source_rank === null || data.source_rank === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_rank is required and cannot be null for automated-daily mode",
        path: ["source_rank"]
      });
    }
  }

  // Production validation checks
  if (data.data_class === 'production') {
    if (!data.source_metrics || data.source_metrics.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_metrics is required and cannot be empty in production mode",
        path: ["source_metrics"]
      });
    } else {
      for (let i = 0; i < data.source_metrics.length; i++) {
        const metric = data.source_metrics[i];
        if (metric.value === 100) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Placeholder popularity value (100) is forbidden in production mode",
            path: ["source_metrics", i, "value"]
          });
        }
      }
    }
  }
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
  status: z.enum(["selected", "generated", "published", "failed"]),
  run_key: z.string(),
  updated_at: z.string().optional(),
  published_at: z.string().optional(),
  slug: z.string().optional(),
  candidate: z.any().optional(),
  selection: z.any().optional(),
  collection_result: EvidenceCollectionResultSchema.optional()
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
