import type { Evidence } from '../../schemas/evidence';

/**
 * Deterministic validation for the 2.1.0 recommendation contract. Every rule here is
 * enforced by the application — never left to the prompt. Errors are prefixed with
 * "[Recommendation]" so the evaluator classifies them as retryable generation failures
 * and the publication gate can re-wrap them fail-closed.
 *
 * Rules (recommendation contract 1.0.0):
 *  1. primary_concern_index === 0 and the judge's primary concern (concerns[0]) is non-empty.
 *  2. The action shares at least one meaningful token with the primary concern.
 *  3. The action is not too short and not a known generic recommendation.
 *  4. criterion_id exists among the judge's own criteria.
 *  5. evidence_ids is non-empty, duplicate-free, resolves in the evidence bundle and is a
 *     subset of the referenced criterion's evidence_ids.
 *  6. The evidence cited by the action's public statement annotations / claim references
 *     equals recommended_next_step.evidence_ids as a set.
 *  7. The five personas' recommendations are not all identical.
 */

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'could', 'does', 'from', 'have', 'into',
  'just', 'more', 'only', 'project', 'that', 'their', 'there', 'these', 'they', 'this',
  'with', 'would'
]);

export function meaningfulTokens(text: string): Set<string> {
  return new Set(
    ((text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [])
      .filter(token => !STOP_WORDS.has(token))
  );
}

function normalizeAction(action: string): string {
  return (action || '').toLowerCase().replace(/[.!?\s]+$/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Exact-match blacklist of generic recommendations. Deliberately literal: the contract
 * forbids high-false-positive semantic judgement, so specificity is otherwise enforced
 * through the minimum length/token rules below.
 */
const GENERIC_RECOMMENDATIONS = new Set([
  'improve documentation',
  'improve the documentation',
  'add more tests',
  'add tests',
  'enhance usability',
  'consider security',
  'listen to users',
  'continue improving the product',
  'address the concern',
  'make the project more robust'
]);

const MIN_ACTION_LENGTH = 30;
const MIN_ACTION_TOKENS = 4;

type RecommendationReference = { public_output_path?: string; evidence_ids?: string[] };

function annotatedEvidenceIdsForPath(evaluation: any, path: string): Set<string> {
  // Trusted claim_references exist post-recalculation and at the publication gate;
  // untrusted public_statement_annotations exist at generation time. Either carries the
  // (path, evidence_ids) pairs this check needs.
  const references: RecommendationReference[] =
    (evaluation.claim_references as RecommendationReference[] | undefined)
    ?? (evaluation.public_statement_annotations as RecommendationReference[] | undefined)
    ?? [];
  const ids = new Set<string>();
  for (const reference of references) {
    if (reference.public_output_path !== path) continue;
    for (const id of reference.evidence_ids || []) ids.add(id);
  }
  return ids;
}

function sameSet(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const value of a) if (!b.has(value)) return false;
  return true;
}

export function validateRecommendations(evaluation: any, evidences: Evidence[]): void {
  const judges: any[] = evaluation?.judges || [];
  const bundleEvidenceIds = new Set(evidences.map(evidence => evidence.evidence_id));

  judges.forEach((judge, judgeIndex) => {
    const step = judge.recommended_next_step;
    if (!step) {
      throw new Error(`[Recommendation] judges.${judgeIndex} is missing recommended_next_step.`);
    }

    if (step.primary_concern_index !== 0) {
      throw new Error(`[Recommendation] judges.${judgeIndex}.recommended_next_step.primary_concern_index must be 0.`);
    }

    const primaryConcern = judge.concerns?.[0];
    if (typeof primaryConcern !== 'string' || primaryConcern.trim().length === 0) {
      throw new Error(`[Recommendation] judges.${judgeIndex} has no primary concern for the recommended next step to address.`);
    }

    const action = typeof step.action === 'string' ? step.action.trim() : '';
    // The explicit generic blacklist fires first so a listed phrase is always reported as
    // generic, whatever its length; the length/token rules then catch unlisted vagueness.
    if (GENERIC_RECOMMENDATIONS.has(normalizeAction(action))) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended action is a generic recommendation.`);
    }
    if (action.length < MIN_ACTION_LENGTH) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended action is too short to be actionable.`);
    }
    const actionTokens = meaningfulTokens(action);
    if (actionTokens.size < MIN_ACTION_TOKENS) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended action does not name a concrete target or deliverable.`);
    }
    if (/\?\s*$/.test(action)) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended action must not be phrased as a question.`);
    }

    const concernTokens = meaningfulTokens(primaryConcern);
    const overlaps = [...actionTokens].some(token => concernTokens.has(token));
    if (!overlaps) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended action does not address the primary concern (no shared meaningful token).`);
    }
    if (normalizeAction(action) === normalizeAction(primaryConcern)) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended action merely restates the primary concern instead of answering it.`);
    }

    const criterion = (judge.criteria || []).find((c: any) => c.criterion_id === step.criterion_id);
    if (!criterion) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended criterion_id "${step.criterion_id}" does not exist in that judge's criteria.`);
    }

    const stepEvidenceIds: string[] = step.evidence_ids || [];
    if (stepEvidenceIds.length === 0) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended_next_step.evidence_ids must not be empty.`);
    }
    if (new Set(stepEvidenceIds).size !== stepEvidenceIds.length) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended_next_step.evidence_ids must not contain duplicates.`);
    }
    const criterionEvidenceIds = new Set<string>(criterion.evidence_ids || []);
    for (const evidenceId of stepEvidenceIds) {
      if (!bundleEvidenceIds.has(evidenceId)) {
        throw new Error(`[Recommendation] judges.${judgeIndex} recommended evidence_id "${evidenceId}" does not exist in the evidence bundle.`);
      }
      if (!criterionEvidenceIds.has(evidenceId)) {
        throw new Error(`[Recommendation] judges.${judgeIndex} recommended evidence_id "${evidenceId}" is not cited by criterion "${step.criterion_id}".`);
      }
    }

    const annotatedIds = annotatedEvidenceIdsForPath(evaluation, `judges.${judgeIndex}.recommended_next_step.action`);
    if (!sameSet(annotatedIds, new Set(stepEvidenceIds))) {
      throw new Error(`[Recommendation] judges.${judgeIndex} recommended action's statement annotations must cite exactly the recommended_next_step.evidence_ids.`);
    }
  });

  const normalizedActions = new Set(judges.map(judge => normalizeAction(judge.recommended_next_step?.action || '')));
  if (judges.length > 1 && normalizedActions.size === 1) {
    throw new Error('[Recommendation] All judges have identical recommended next steps. Too homogenized.');
  }
}
