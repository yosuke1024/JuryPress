import { z } from 'zod';

/**
 * Editorial withdrawal: a review is kept published but removed from the rankings.
 *
 * Stored as editorial-withdrawal.json beside review.json, never inside it. review.json is
 * immutable after publish and written only by publishRecord() (see publish.ts), so a decision
 * taken after publication cannot live there — the same reason the evidence map is a sibling
 * file. Keeping it separate also means the article, its scores and its evidence map are
 * provably untouched by the withdrawal.
 *
 * This is not the same thing as being unranked for methodology reasons. A review outside the
 * current evidence-mapping standard is marked "Historical methodology"; a withdrawal is an
 * explicit editorial judgement about this specific review, and says so in its own words.
 */
export const EDITORIAL_WITHDRAWAL_SCHEMA_VERSION = '1.0.0';

export const WithdrawalReasonCodeSchema = z.enum([
  /** The evaluation rests on evidence that was materially incomplete. */
  'material-evidence-gap',
  /** Factual errors significant enough that the verdict cannot stand as written. */
  'factual-error'
]);

export const EditorialWithdrawalSchema = z.object({
  schema_version: z.literal(EDITORIAL_WITHDRAWAL_SCHEMA_VERSION),
  /** Must match the review's slug. A mismatch is a misfiled record, not a stale one. */
  slug: z.string().min(1),
  /**
   * contentHash of the evaluation this withdrawal was written against, i.e.
   * review.provenance.validated_content_hash. On mismatch the withdrawal is stale — the
   * article was republished after it was written — and it stays in force regardless. See
   * loadEditorialWithdrawal in data.ts for why staleness never restores a ranking.
   */
  article_hash: z.string().regex(/^[a-f0-9]{64}$/),
  withdrawn_at: z.string().datetime(),
  reason_code: WithdrawalReasonCodeSchema,
  /** Shown to readers. Written for a reader, not for an operator. */
  reason: z.string().min(1),
  /** Slug of the review that replaces this one, once one exists. */
  superseded_by: z.string().min(1).nullable()
});

export type EditorialWithdrawal = z.infer<typeof EditorialWithdrawalSchema>;

/**
 * `stale` still withdraws. The only difference is that a stale record is reported by the
 * dedicated integrity test so an operator updates article_hash after a republish.
 */
export type EditorialWithdrawalState =
  | { status: 'active'; record: EditorialWithdrawal }
  | { status: 'stale'; record: EditorialWithdrawal }
  | null;
