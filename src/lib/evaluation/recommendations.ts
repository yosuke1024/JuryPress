import type { Evidence } from '../../schemas/evidence';
import type { QualityFinding } from '../../schemas/generation-record';

/**
 * Deterministic validation for the 2.1.0 recommendation contract. Every rule here is
 * enforced by the application — never left to the prompt.
 *
 * Rules are *classified*, not merely checked. Only a defect that misinforms the reader,
 * breaks the article, or makes a claim untraceable withholds publication; everything else is
 * recorded as a warning and published. The distinction matters because these rules used to
 * reject whole generations — a recommendation whose wording did not happen to share a token
 * with its concern would burn six Gemini calls and publish nothing, which is a false negative
 * dressed up as a quality bar.
 *
 * ERROR (withholds publication):
 *  - recommended_next_step missing, or no primary concern for it to address.
 *  - criterion_id naming a criterion the judge does not have (a dangling reference).
 *  - evidence_ids empty (a recommendation with no traceable grounding).
 *  - evidence_ids naming evidence that does not exist in the bundle.
 *
 * WARNING (recorded, published):
 *  - Vocabulary overlap between the concern and the action, and restatement of the concern.
 *    Both are proxies for "does the action address the concern"; a legitimate action often
 *    answers a concern in different words ("no CI" → "add a GitHub Actions workflow").
 *  - Genericness, length and specificity of the action — style, not correctness.
 *  - Whether the judge's own criteria happen to cite the recommended evidence. The evidence
 *    exists and resolves; criterion-level provenance is a stricter standard than traceability.
 *  - Annotation/evidence divergence, which the repair pass derives away before this runs.
 *  - Homogeneity across the five personas.
 */

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'could', 'does', 'from', 'have', 'into',
  'just', 'more', 'only', 'project', 'that', 'their', 'there', 'these', 'they', 'this',
  'with', 'would'
]);

export const RECOMMENDATION_RULE_VERSION = '2.0.0';

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
 * forbids high-false-positive semantic judgement.
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

function error(code: string, path: string, message: string): QualityFinding {
  return { code, path, message, severity: 'error', ruleVersion: RECOMMENDATION_RULE_VERSION };
}

function warning(code: string, path: string, message: string): QualityFinding {
  return { code, path, message, severity: 'warning', ruleVersion: RECOMMENDATION_RULE_VERSION };
}

/**
 * Collects every recommendation-contract finding, classified by severity. Unlike a
 * throw-on-first-violation check this reports the whole picture in one pass, so an editor
 * fixing an excluded record sees all of it rather than peeling one error at a time.
 */
export function collectRecommendationFindings(evaluation: any, evidences: Evidence[]): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const judges: any[] = evaluation?.judges || [];
  const bundleEvidenceIds = new Set(evidences.map(evidence => evidence.evidence_id));

  judges.forEach((judge, judgeIndex) => {
    const base = `$.judges.${judgeIndex}`;
    const step = judge.recommended_next_step;
    if (!step) {
      findings.push(error(
        'REQUIRED_SECTION_MISSING',
        `${base}.recommended_next_step`,
        'The judge has no recommended_next_step, so the published article would be missing a required section.'
      ));
      return;
    }

    const primaryConcern = judge.concerns?.[0];
    if (typeof primaryConcern !== 'string' || primaryConcern.trim().length === 0) {
      findings.push(error(
        'REQUIRED_SECTION_MISSING',
        `${base}.concerns.0`,
        'The judge has no primary concern for the recommended next step to address.'
      ));
      return;
    }

    // primary_concern_index is pinned to 0 by the repair pass; a surviving mismatch means the
    // judge listed no concerns at all, which the check above already reported.
    if (step.primary_concern_index !== 0) {
      findings.push(warning(
        'RECOMMENDATION_CONCERN_INDEX_UNPINNED',
        `${base}.recommended_next_step.primary_concern_index`,
        'primary_concern_index is not 0; the contract always treats concerns[0] as primary.'
      ));
    }

    const action = typeof step.action === 'string' ? step.action.trim() : '';
    if (GENERIC_RECOMMENDATIONS.has(normalizeAction(action))) {
      findings.push(warning(
        'RECOMMENDATION_GENERIC',
        `${base}.recommended_next_step.action`,
        'The recommended action is a known generic recommendation.'
      ));
    }
    if (action.length < MIN_ACTION_LENGTH) {
      findings.push(warning(
        'RECOMMENDATION_TOO_SHORT',
        `${base}.recommended_next_step.action`,
        `The recommended action is shorter than ${MIN_ACTION_LENGTH} characters and may not be actionable.`
      ));
    }
    const actionTokens = meaningfulTokens(action);
    if (actionTokens.size < MIN_ACTION_TOKENS) {
      findings.push(warning(
        'RECOMMENDATION_NOT_SPECIFIC',
        `${base}.recommended_next_step.action`,
        'The recommended action names fewer than four meaningful tokens, so it may not name a concrete target.'
      ));
    }
    if (/\?\s*$/.test(action)) {
      findings.push(warning(
        'RECOMMENDATION_PHRASED_AS_QUESTION',
        `${base}.recommended_next_step.action`,
        'The recommended action is phrased as a question rather than an action.'
      ));
    }

    // Vocabulary overlap is a proxy for relevance, and a weak one: an action that answers a
    // concern in its own words is good writing, not a defect. Recorded, never blocking.
    const concernTokens = meaningfulTokens(primaryConcern);
    if (![...actionTokens].some(token => concernTokens.has(token))) {
      findings.push(warning(
        'RECOMMENDATION_CONCERN_VOCABULARY_UNSHARED',
        `${base}.recommended_next_step.action`,
        'The recommended action shares no meaningful token with the primary concern; it may not address it.'
      ));
    }
    if (normalizeAction(action) === normalizeAction(primaryConcern)) {
      findings.push(warning(
        'RECOMMENDATION_RESTATES_CONCERN',
        `${base}.recommended_next_step.action`,
        'The recommended action restates the primary concern instead of answering it.'
      ));
    }

    const criterion = (judge.criteria || []).find((c: any) => c.criterion_id === step.criterion_id);
    if (!criterion) {
      findings.push(error(
        'RECOMMENDATION_CRITERION_NOT_FOUND',
        `${base}.recommended_next_step.criterion_id`,
        `The recommended criterion_id "${step.criterion_id}" does not exist in that judge's criteria, leaving a dangling reference.`
      ));
    }

    const stepEvidenceIds: string[] = step.evidence_ids || [];
    if (stepEvidenceIds.length === 0) {
      findings.push(error(
        'RECOMMENDATION_EVIDENCE_MISSING',
        `${base}.recommended_next_step.evidence_ids`,
        'The recommended next step cites no evidence, so its grounding cannot be traced.'
      ));
    }

    const judgeEvidenceIds = new Set<string>(
      (judge.criteria || []).flatMap((c: any) => c.evidence_ids || [])
    );
    for (const evidenceId of stepEvidenceIds) {
      if (!bundleEvidenceIds.has(evidenceId)) {
        findings.push(error(
          'EVIDENCE_ID_NOT_FOUND',
          `${base}.recommended_next_step.evidence_ids`,
          `The recommended evidence_id "${evidenceId}" does not exist in the evidence bundle.`
        ));
        continue;
      }
      if (!judgeEvidenceIds.has(evidenceId)) {
        findings.push(warning(
          'RECOMMENDATION_EVIDENCE_NOT_CITED_BY_CRITERIA',
          `${base}.recommended_next_step.evidence_ids`,
          `The recommended evidence_id "${evidenceId}" resolves in the bundle but none of that judge's criteria cite it.`
        ));
      }
    }

    const annotatedIds = annotatedEvidenceIdsForPath(evaluation, `judges.${judgeIndex}.recommended_next_step.action`);
    if (annotatedIds.size > 0 && !sameSet(annotatedIds, new Set(stepEvidenceIds))) {
      findings.push(warning(
        'RECOMMENDATION_ANNOTATION_EVIDENCE_MISMATCH',
        `${base}.recommended_next_step.action`,
        "The action's statement annotations do not cite exactly the recommended_next_step.evidence_ids."
      ));
    }
  });

  const normalizedActions = new Set(judges.map(judge => normalizeAction(judge.recommended_next_step?.action || '')));
  if (judges.length > 1 && normalizedActions.size === 1) {
    findings.push(warning(
      'RECOMMENDATIONS_HOMOGENEOUS',
      '$.judges',
      'All judges recommend the same next step; the personas are not differentiated here.'
    ));
  }

  return findings;
}

/**
 * Throwing wrapper retained for the publication gate, which is an all-or-nothing check on
 * already-validated content. Only error-severity findings throw — a warning has, by
 * definition, already been accepted for publication.
 */
export function validateRecommendations(evaluation: any, evidences: Evidence[]): void {
  const blocking = collectRecommendationFindings(evaluation, evidences).filter(f => f.severity === 'error');
  if (blocking.length > 0) {
    throw new Error(`[Recommendation] ${blocking[0].path}: ${blocking[0].message}`);
  }
}
