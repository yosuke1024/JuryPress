import { z } from 'zod';
import { EvidenceFactClassSchema } from './evidence';

/**
 * The evidence map: the record-keeping half of the editorial-first (V3) pipeline.
 *
 * Produced by a SEPARATE Gemini request (Request 2) after the editorial article is persisted,
 * and stored as evidence-map.json next to review.json. Its contract is deliberately one-way:
 *
 *   - It describes how each published statement relates to the collected evidence.
 *   - It never changes the article, never scores it, and never decides publishability.
 *   - A failed or stale map means the review publishes WITHOUT one — never that it is blocked.
 *   - It is regenerable at any time (e.g. after a human edit); nothing in it is immutable.
 *
 * The application authors every statement_text / public_output_path / statement_index from
 * its own deterministic segmentation of the article; the model contributes only the
 * classification, evidence ids, support strength and note, joined by statement id at ingest.
 * A model that re-typed sentences could mismatch them — so it is never asked to.
 */

export const EVIDENCE_MAP_SCHEMA_VERSION = '1.0.0';
export const MAPPING_PROMPT_VERSION = '1.0.0';

/**
 * How a published statement relates to the collected evidence. The last three values are
 * honest, expected answers — an opinion needs no evidence, a fact the collector never
 * gathered has nothing to link to, and a contradiction is information for the appendix
 * (and an operator signal), not a publication verdict.
 */
export const ClaimClassificationSchema = z.enum([
  'directly_supported',
  'repository_observation',
  'creator_claim',
  'community_opinion',
  'reasonable_inference',
  'editorial_judgment',
  'not_linked_to_collected_evidence',
  'contradicted_by_evidence'
]);

export type ClaimClassification = z.infer<typeof ClaimClassificationSchema>;

export const SupportStrengthSchema = z.enum(['strong', 'moderate', 'weak', 'none']);

export const EvidenceMapClaimSchema = z.object({
  /** App-generated stable id, e.g. "claim-12". */
  claim_id: z.string().min(1),
  /** App-authored dotted path into the evaluation content, e.g. "judges.2.criteria.4.reasoning". */
  public_output_path: z.string().min(1),
  /** App-authored statement index within that field. */
  statement_index: z.number().int().nonnegative(),
  /** App-authored verbatim statement text (the model never re-types it). */
  statement_text: z.string().min(1),
  classification: ClaimClassificationSchema,
  /** Filtered at ingest to ids present in the evidence bundle. */
  evidence_ids: z.array(z.string()),
  support: SupportStrengthSchema,
  note: z.string().nullable()
});

export type EvidenceMapClaim = z.infer<typeof EvidenceMapClaimSchema>;

export const UnmappedStatementSchema = z.object({
  public_output_path: z.string().min(1),
  statement_index: z.number().int().nonnegative(),
  statement_text: z.string().min(1),
  /** Why the statement has no valid map entry: the model skipped it, or its entry was invalid. */
  reason: z.enum(['model_skipped', 'entry_invalid'])
});

export const EvidenceMapSchema = z.object({
  map_schema_version: z.literal(EVIDENCE_MAP_SCHEMA_VERSION),
  /**
   * contentHash of the evaluation content this map describes. On mismatch the map is stale
   * (the article was edited after mapping); a stale map is treated as absent and re-mapped —
   * never a reason to block or change the article.
   */
  article_hash: z.string().regex(/^[a-f0-9]{64}$/),
  mapping_prompt_version: z.string().min(1),
  mapped_at: z.string().datetime(),
  /** The model version the API reported serving; null when unreported — never fabricated. */
  model: z.string().nullable(),
  /**
   * complete — every article statement has a valid entry.
   * partial  — some model entries were invalid or missing; valid ones are kept, the rest are
   *            listed under unmapped_statements. Still publishable as an appendix.
   * failed   — the request or parse failed; the review publishes with the map marked
   *            unavailable.
   */
  status: z.enum(['complete', 'partial', 'failed']),
  claims: z.array(EvidenceMapClaimSchema),
  unmapped_statements: z.array(UnmappedStatementSchema),
  /** Derived view: claim_ids whose classification is contradicted_by_evidence. */
  contradictions: z.array(z.string()),
  /** Per-evidence usage, derived at ingest. fact_class comes from the evidence itself. */
  evidence_usage: z.array(z.object({
    evidence_id: z.string().min(1),
    fact_class: EvidenceFactClassSchema,
    cited_by_claims: z.number().int().nonnegative()
  }))
});

export type EvidenceMap = z.infer<typeof EvidenceMapSchema>;

/**
 * The wire schema for the mapping request (what Gemini actually returns). Everything else in
 * EvidenceMapSchema is app-authored at ingest. statement_id joins the entry back to the
 * app-side numbered statement list.
 */
export const EvidenceMapEntrySchema = z.object({
  statement_id: z.number().int(),
  classification: ClaimClassificationSchema,
  evidence_ids: z.array(z.string()),
  support: SupportStrengthSchema,
  note: z.string().nullable()
});

export type EvidenceMapEntry = z.infer<typeof EvidenceMapEntrySchema>;

export const EvidenceMapGenSchema = z.object({
  article_hash: z.string(),
  mapping: z.array(EvidenceMapEntrySchema)
});

export type EvidenceMapGen = z.infer<typeof EvidenceMapGenSchema>;
