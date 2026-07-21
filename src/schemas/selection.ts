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

/**
 * Provenance of an operator-approved reader request. Present exactly when
 * selection_mode is "reader-request"; the GitHub Issue is the source of truth
 * for the request itself, so only its identity is recorded here.
 */
export const RequestProvenanceSchema = z.object({
  /** Deterministic request identity, e.g. "owner/repo#123" (the issue IS the request). */
  request_id: z.string().min(1).max(200),
  issue_number: z.number().int().positive(),
  issue_url: z.string().url(),
  requester_relationship: z.enum(["creator_maintainer", "contributor", "user", "other"])
});

export type RequestProvenance = z.infer<typeof RequestProvenanceSchema>;

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
  selection_mode: z.enum(["initial-bootstrap", "automated-daily", "reader-request"]),
  selected_by: z.enum(["operator", "system"]),
  source_metrics: z.array(SourceMetricSchema).optional(),
  request_provenance: RequestProvenanceSchema.optional()
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
  } else if (data.selection_mode === 'reader-request') {
    if (data.selected_by !== 'operator') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "selected_by must be 'operator' for reader-request mode",
        path: ["selected_by"]
      });
    }
    if (data.human_selected !== true) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "human_selected must be true for reader-request mode",
        path: ["human_selected"]
      });
    }
    if (data.source_rank !== null && data.source_rank !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source_rank must be null or omitted for reader-request mode",
        path: ["source_rank"]
      });
    }
    if (data.source !== 'reader_request') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "source must be 'reader_request' for reader-request mode",
        path: ["source"]
      });
    }
    if (!data.request_provenance) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "request_provenance is required for reader-request mode",
        path: ["request_provenance"]
      });
    }
  }
  if (data.selection_mode !== 'reader-request' && data.request_provenance) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "request_provenance is only allowed for reader-request mode",
      path: ["request_provenance"]
    });
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

// === Run State V2 (Phase 4: reservations, triggers, monotonic lifecycle) ===
export const RunTriggerSchema = z.enum(["scheduled", "manual"]);
export type RunTrigger = z.infer<typeof RunTriggerSchema>;

export const RunOperationSchema = z.enum(["publish_new", "resume_pending", "publish_request", "regenerate"]);
export type RunOperation = z.infer<typeof RunOperationSchema>;

export const RunStatusV2Schema = z.enum([
  "reserved",
  "generating",
  "generated",
  "validated",
  "committed",
  "published",
  "failed"
]);
export type RunStatusV2 = z.infer<typeof RunStatusV2Schema>;

export const RunFailureSchema = z.object({
  stage: z.string(),
  retryable: z.boolean(),
  previous_status: RunStatusV2Schema,
  error_category: z.string(),
  failed_at: z.string()
});

export const CandidateReservationSchema = z.object({
  content_id: z.string(),
  canonical_url: z.string().url(),
  candidate_name: z.string()
});

export const RunStateSchemaV2 = z.object({
  schema_version: z.literal("2.0.0"),
  data_class: z.enum(["fixture", "production"]),
  status: RunStatusV2Schema,
  run_key: z.string(),
  trigger: RunTriggerSchema,
  operation: RunOperationSchema,
  workflow_run_id: z.string(),
  reserved_at: z.string(),
  updated_at: z.string(),
  published_at: z.string().optional(),
  candidate_reservation: CandidateReservationSchema,
  candidate: z.any().optional(),
  selection: z.any().optional(),
  collection_result: EvidenceCollectionResultSchema.optional(),
  slug: z.string().optional(),
  /**
   * regenerate only: the slug of the withdrawn review this run supersedes. Persisted at
   * reservation so the later validate/publish invocation links the successor from durable
   * state, not from CLI flags it may not be passed.
   */
  regeneration_target_slug: z.string().optional(),
  failure: RunFailureSchema.optional()
}).superRefine((data, ctx) => {
  if (data.status === 'failed' && !data.failure) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['failure'],
      message: 'failure details are required when status is failed'
    });
  }
});

export type RunStateV2 = z.infer<typeof RunStateSchemaV2>;

/** Legacy 1.0.0 run states remain readable; new runs are always written as 2.0.0. */
export const AnyRunStateSchema = z.union([RunStateSchemaV2, RunStateSchema]);
export type AnyRunState = z.infer<typeof AnyRunStateSchema>;

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

// === Publication State V2 (Phase 4: run key / trigger / operation provenance) ===
export const PublicationStateSchemaV2 = z.object({
  schema_version: z.literal("2.0.0"),
  data_class: z.enum(["fixture", "production"]),
  content_id: z.string(),
  slug: z.string(),
  source_canonical_url: z.string().url(),
  selected_at: z.string(),
  generated_at: z.string(),
  published_at: z.string().optional(),
  // Kept identical to run_key for compatibility with the --update-status flow.
  generation_run_id: z.string(),
  run_key: z.string(),
  trigger: RunTriggerSchema,
  operation: RunOperationSchema,
  workflow_run_id: z.string(),
  publication_status: z.enum(["generated", "validated", "committed", "published", "failed"])
});

export type PublicationStateV2 = z.infer<typeof PublicationStateSchemaV2>;

/** Legacy 1.0.0 publication states remain readable; new ones are written as 2.0.0. */
export const AnyPublicationStateSchema = z.union([PublicationStateSchemaV2, PublicationStateSchema]);
export type AnyPublicationState = z.infer<typeof AnyPublicationStateSchema>;
