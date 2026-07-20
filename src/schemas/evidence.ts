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
  // No watchers/contributors: the repo API returns watchers_count as an alias of
  // stargazers_count, and subscribers_count is a different metric again. Phase 1
  // needs stars/forks/open_issues, so conflatable fields stay out of the snapshot.
  contributors: z.number().optional(),
  latest_commit_sha: z.string().optional(),
  latest_commit_at: z.string().optional(),
  license: z.string().optional(),
  archived: z.boolean().optional(),
  /**
   * The repository's declared homepage, as GitHub reports it. Recorded because it is the only
   * trustworthy way to decide which domain counts as "official" for this project: it is
   * repository configuration returned by the GitHub API, not a link inside a README that the
   * project's own author writes. Collection follows it; it never follows a domain the README
   * nominates. Optional — most repositories set no homepage.
   */
  homepage: z.string().nullable().optional(),
  /**
   * The owning organisation's declared URL, read only when the repository sets no homepage.
   * Recorded alongside it because it is the other half of the basis for deciding which domain
   * counted as official for this review; storing one and not the other would leave that
   * decision unexplainable after the fact.
   */
  owner_url: z.string().nullable().optional()
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
    claim_id: z.string().optional(),
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
  metadata_snapshot: GitHubMetadataSnapshotSchema.optional(),
  evaluation_integrity_version: z.literal("1.0.0").optional()
});

export type EvidenceBundle = z.infer<typeof EvidenceBundleSchema>;

export const IdentitySourceSchema = z.enum([
  "readme_h1",
  "package_manifest",
  "official_website",
  "repository_name",
  "source_title_inference"
]);

export const ProjectIdentitySchema = z.object({
  canonical_display_name: z.string(),
  repository_full_name: z.string().optional(),
  repository_name: z.string().optional(),
  source_title: z.string(),
  identity_source: IdentitySourceSchema
});

export type ProjectIdentity = z.infer<typeof ProjectIdentitySchema>;

export const DiscussionItemSchema = z.object({
  discussion_item_id: z.string(),
  parent_evidence_id: z.string(),
  source_url: z.string(),
  excerpt: z.string(),
  fact_class: z.literal("community_opinion"),
  classification: z.enum(["positive", "critical", "neutral"]),
  materiality_reason_code: z.string().optional(),
  /**
   * True only when this exact excerpt survived into the evidence summary the
   * model was given. Every comment is retained for the record, but only a capped
   * subset reaches the model, so the two sets must be told apart.
   */
  included_in_model_input: z.boolean(),
  /**
   * True for material criticism the model actually saw. The publication gate
   * requires a public response only for these: demanding one for criticism that
   * was never supplied as input would fail the publish over unanswerable input.
   */
  requires_public_response: z.boolean()
});

export type DiscussionItem = z.infer<typeof DiscussionItemSchema>;

export const DiscussionEvidenceSchema = z.object({
  items: z.array(DiscussionItemSchema)
});

export type DiscussionEvidence = z.infer<typeof DiscussionEvidenceSchema>;

export const EvidenceCollectionResultSchema = z.object({
  evidences: z.array(EvidenceSchema),
  project_identity: ProjectIdentitySchema,
  metadata_snapshot: GitHubMetadataSnapshotSchema.optional(),
  discussion_evidence: DiscussionEvidenceSchema,
  evaluation_integrity_version: z.literal("1.0.0"),
  evidence_usage: z.object({
    raw_character_count: z.number(),
    sanitized_character_count: z.number()
  }).optional()
});

export type EvidenceCollectionResult = z.infer<typeof EvidenceCollectionResultSchema>;
