import type { ReviewEntry } from './data';
import { hasUnassessableCriteria, evidenceContextOf } from './evaluation/evidence-requirements';

/**
 * The ranking judgment, kept in its own module so that both data.ts (integrity assertions)
 * and rankings.ts (period pages) can reach it. The only import here is a *type*, which is
 * erased at build time, so bringing this into data.ts creates no runtime import cycle.
 */

/**
 * Current Cohort — the shared comparability definition behind every ranking surface
 * (All-time, Annual, Monthly, Weekly). Season 1 and other rubric versions stay published
 * and reachable, but never enter a ranking.
 */
export const CURRENT_COHORT = {
  season: 2,
  rubricId: 'open-source-product',
  rubricVersion: '2.0.0'
} as const;

export function isCurrentCohortReview(entry: ReviewEntry): boolean {
  const review = entry.review as any;
  return (
    review.season === CURRENT_COHORT.season &&
    review.rubric_id === CURRENT_COHORT.rubricId &&
    review.rubric_version === CURRENT_COHORT.rubricVersion &&
    review.evaluation_status === 'complete' &&
    review.ranking_eligible === true &&
    review.relationship === 'independent' &&
    review.jury_score !== null &&
    review.jury_score !== undefined
  );
}

export type EffectiveEvidenceMapStatus = 'complete' | 'partial' | 'unavailable';

/**
 * Evidence mapping as it actually stands for this review, derived at read time.
 *
 * Reviews are never rewritten to record this: the stored JSON is the artefact as generated,
 * and re-editing it to match a later standard would erase the record we are trying to keep.
 *
 * Two rules matter here:
 *
 * 1. Generations that predate statement-level mapping have no `evidence_map_status` field at
 *    all, so its *absence* is the signal. Do not branch on `schema_version` instead — it is a
 *    per-variant `z.literal`, so a `!== '3.0.0'` test silently reclassifies every review of
 *    the next schema version as unmapped and drops the newest work out of the rankings.
 * 2. `complete` is a claim the review makes about itself. It is only honoured when the map is
 *    actually loadable: `entry.evidenceMap` is null when the file is missing, unparseable, or
 *    bound to different content (see loadEvidenceMap in data.ts). Ranking on the claim alone
 *    would rank on self-report, which is the opposite of what the map exists to establish.
 */
export function getEffectiveEvidenceMapStatus(entry: ReviewEntry): EffectiveEvidenceMapStatus {
  const review = entry.review as any;
  if (!('evidence_map_status' in review)) return 'unavailable';
  if (entry.evidenceMap === null) return 'unavailable';
  if (review.evidence_map_status === 'complete') return 'complete';
  // The legacy value "available" is normalised to "partial" by the schema's preprocess step.
  return review.evidence_map_status === 'partial' ? 'partial' : 'unavailable';
}

export type RankingExclusionReason =
  | 'outside-current-cohort'
  | 'editorially-withdrawn'
  | 'insufficient-evidence'
  | 'evidence-map-partial'
  | 'evidence-map-unavailable';

export interface RankingEligibility {
  eligible: boolean;
  reason: RankingExclusionReason | null;
}

/**
 * The single ranking judgment. Every surface that ranks, orders, or displays a position —
 * ranking pages, the home page, per-review rank lines, judge pages — must go through this
 * and not read `ranking_eligible` directly, or a review can leave one list while keeping
 * its "#1" on another.
 *
 * `ranking_eligible` on the review is base eligibility recorded at generation time
 * (related-party, incomplete evaluation). It is a necessary input, not the answer.
 *
 * Mapping gates rankings, never publication: a review with no usable map stays published and
 * reachable, and is shown as historical methodology instead.
 */
export function getRankingEligibility(entry: ReviewEntry): RankingEligibility {
  if (!isCurrentCohortReview(entry)) {
    return { eligible: false, reason: 'outside-current-cohort' };
  }
  // Checked before mapping, and for `stale` as well as `active`: a withdrawal whose hash no
  // longer matches is still a decision somebody took, and there is no path back into the
  // rankings that does not go through deleting the file.
  if (entry.editorialWithdrawal) {
    return { eligible: false, reason: 'editorially-withdrawn' };
  }
  // Evidence mapping is judged FIRST. A review that predates or fails the current mapping
  // standard is historical methodology, and that is the reason to show — even when its
  // evidence is also thin. This ordering matters: refined reviews of more than one schema
  // version carry core_source_evidence, so testing evidence sufficiency ahead of the map
  // would relabel every unmapped refined review 'insufficient-evidence' and drop it off the
  // Methodology History page. Mapping status is the version-independent discriminator here,
  // not schema_version (which is a per-variant literal and would misclassify a future
  // version).
  const status = getEffectiveEvidenceMapStatus(entry);
  if (status !== 'complete') {
    return {
      eligible: false,
      reason: status === 'partial' ? 'evidence-map-partial' : 'evidence-map-unavailable'
    };
  }

  // The map is complete, so the review is otherwise rankable. Only now the evidence
  // requirement: a review scored before code enforced it can carry a real jury_score resting
  // on evidence too thin to assess a criterion — technical quality with no source-code
  // evidence, say. Its review.json is immutable, so the score stays on the page as published
  // and the review is dropped from the rankings here. Newer reviews never reach this branch:
  // enforcement nulls their score at generation, so they fail the cohort check above.
  const evaluation = (entry.review as any).evaluation;
  if (evaluation?.core_source_evidence && hasUnassessableCriteria(evidenceContextOf(evaluation))) {
    return { eligible: false, reason: 'insufficient-evidence' };
  }

  return { eligible: true, reason: null };
}

export function isRankingEligible(entry: ReviewEntry): boolean {
  return getRankingEligibility(entry).eligible;
}

/** The ranking population for every surface and every period. */
export function getRankedReviews(entries: ReviewEntry[]): ReviewEntry[] {
  return entries.filter(isRankingEligible);
}

/**
 * A published review that is not ranked because its evidence mapping predates, or does not
 * meet, the current statement-level standard. These carry the "Historical methodology" mark
 * and are listed on the Methodology History page. Reviews excluded for cohort reasons alone
 * (Season 1, related-party, incomplete evaluation) are not in this set, and neither are
 * editorial withdrawals — a withdrawal is a judgement about one review, not about the method
 * that produced it, and labelling it as methodology history would misstate why it is unranked.
 */
export function isHistoricalMethodology(entry: ReviewEntry): boolean {
  const { reason } = getRankingEligibility(entry);
  return reason === 'evidence-map-partial' || reason === 'evidence-map-unavailable';
}

/** Published, but withdrawn from the rankings by an editorial decision. */
export function isEditoriallyWithdrawn(entry: ReviewEntry): boolean {
  return getRankingEligibility(entry).reason === 'editorially-withdrawn';
}

/**
 * Published and otherwise current, but unranked because the evidence collected was too thin to
 * score a rubric criterion — a review scored before code enforced the requirement. Distinct
 * from historical methodology (which is about predating the evidence-map standard) and from
 * editorial withdrawal (a human decision about one review).
 */
export function isInsufficientlyEvidenced(entry: ReviewEntry): boolean {
  return getRankingEligibility(entry).reason === 'insufficient-evidence';
}

/**
 * The review that supersedes `slug`, if one has been published. Derived by looking for the
 * withdrawal that points here, so the successor needs no field of its own and the two
 * directions can never disagree.
 */
export function findSupersededReview(entries: ReviewEntry[], slug: string): ReviewEntry | null {
  return entries.find(e => e.editorialWithdrawal?.record.superseded_by === slug) ?? null;
}
