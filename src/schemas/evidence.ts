import { z } from 'zod';

export const GitHubMetadataSnapshotSchema = z.object({
  snapshot_id: z.string(),
  fetched_at: z.string(),
  repository_full_name: z.string(),
  repository_url: z.string(),
  default_branch: z.string().optional(),
  stars: z.number(),
  forks: z.number(),
  open_issues: z.number(),
  watchers: z.number().optional(),
  contributors: z.number().optional(),
  latest_commit_sha: z.string().optional(),
  latest_commit_at: z.string().optional(),
  license: z.string().optional(),
  archived: z.boolean().optional()
});

export type GitHubMetadataSnapshot = z.infer<typeof GitHubMetadataSnapshotSchema>;

export const EvidenceFactClassSchema = z.enum([
  "confirmed_fact",
  "creator_claim",
  "community_opinion",
  "repository_observation",
  "inference",
  "unverified"
]);

export type EvidenceFactClass = z.infer<typeof EvidenceFactClassSchema>;

export const EvidenceItemSchema = z.object({
  id: z.string(),
  source_type: z.string(),
  fact_class: EvidenceFactClassSchema,
  title: z.string(),
  excerpt: z.string().optional(),
  url: z.string().optional(),
  collected_at: z.string(),
  snapshot_id: z.string().optional()
});

export type EvidenceItem = z.infer<typeof EvidenceItemSchema>;

export const EvidenceSchema = z.object({
  evidence_id: z.string(),
  type: z.string(),
  url: z.string().url(),
  title: z.string(),
  retrieved_at: z.string(),
  content_hash: z.string(),
  summary: z.string(),
  snapshot_id: z.string().optional(), // Added for snapshot integrity tracking
  claims: z.array(z.object({
    text: z.string(),
    claim_type: z.enum([
      "verified_fact", 
      "creator_claim", 
      "inference", 
      "unknown",
      "confirmed_fact",
      "community_opinion",
      "repository_observation",
      "unverified"
    ])
  }))
});

export type Evidence = z.infer<typeof EvidenceSchema>;

export const EvidenceBundleSchema = z.object({
  data_class: z.enum(["fixture", "production"]),
  evidences: z.array(EvidenceSchema),
  metadata_snapshot: GitHubMetadataSnapshotSchema.optional() // Include immutable snapshot in bundle
});

export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

