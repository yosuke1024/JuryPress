import type { Evidence } from '../../schemas/evidence';
import type { GenerationRecord, QualityFinding, RepairRecord } from '../../schemas/generation-record';
import { EvaluationOutputGenSchemaV2_1, EvaluationOutputSchemaV3 } from '../../schemas/evaluation';
import { isEditorialPromptVersion } from '../evaluation/evaluator';
import { buildTrustedClaimReferences, buildProtectedTokens, classifyClaimMessage, findAbsoluteAssertions, scannableTextFields } from '../evaluation/public-claims';
import { collectRecommendationFindings } from '../evaluation/recommendations';
import { collectEditorialRecommendationFindings, recommendationContractApplies } from '../evaluation/editorial-recommendations';
import { repairContent } from './repair';
import { findSystemProtectionDefects } from './system-protection';
import { contentHash } from './record-store';

/**
 * The quality validator: the single decision point for whether stored content may publish.
 *
 * It never calls Gemini, never mutates the stored response, and never throws on a content
 * defect — a defect is a *verdict*, returned as structured findings. It throws only when the
 * validator itself cannot run, which is a genuine system failure and must fail the workflow.
 *
 * Order matters: deterministic repair runs first, so the rules judge the content in its
 * canonical form and no defect that has exactly one correct fix is ever reported as one.
 *
 * The same function backs every path — the daily pipeline, `review:validate`,
 * `review:revalidate` and the PR check — so an edited record cannot be held to a different
 * standard than a generated one.
 *
 * VERSION DISPATCH (3.0.0): the record's immutable generation.promptVersion decides the rule
 * set. Editorial (4.x) records get the minimal system-protection gate: parse + structure +
 * immutability + corruption/injection scans. Audit-era (≤3.x) records keep the frozen 2.x
 * rule set below, unchanged — they were generated to satisfy it, and it is their contract.
 * The model's self-reported schema_version is never the dispatch key: repair pins it, so
 * branching on it would be circular.
 */

// 3.1.0: PRODUCT_NAME_INVALID joins the editorial system-protection gate, and the editorial
// branch gains warning-only wording scans. The bump keeps validationIds honest: the same
// content judged under the new rules is a NEW validation, so an append-only history entry is
// written instead of being deduplicated against a verdict the old rules produced.
// 3.2.0: the editorial recommendation contract (issue #85) joins the editorial branch, itself
// gated on generation.promptVersion >= 4.5.0 — records generated before the prompt stated the
// contract are never judged by it.
export const VALIDATOR_VERSION = '3.2.0';

export interface ValidationVerdict {
  /** The repaired content the verdict applies to; null when the response never parsed. */
  content: unknown | null;
  status: 'passed' | 'failed';
  errors: QualityFinding[];
  warnings: QualityFinding[];
  repairs: RepairRecord[];
  /** Hash of `content`, i.e. what the publish gate must re-check before going live. */
  contentHash: string;
}

function error(code: string, path: string, message: string): QualityFinding {
  return { code, path, message, severity: 'error', ruleVersion: VALIDATOR_VERSION };
}

function warning(code: string, path: string, message: string): QualityFinding {
  return { code, path, message, severity: 'warning', ruleVersion: VALIDATOR_VERSION };
}

/**
 * Scorched-earth condemnation phrasing ("complete abandonment of engineering discipline",
 * "absolute lack of testing", "zero automated verification"). A WARNING-ONLY scan by design:
 * the editorial pipeline's owner decision is that the validator never blocks on prose, and
 * the INTENSITY section of the prompt is where the style is governed. This scan only makes
 * the overreach visible to an operator — in the record and the Actions summary — before a
 * reader sees it.
 */
const EXTREME_SEVERITY_PATTERN = /\b(?:complete|total|utter|absolute)\s+(?:abandonment|absence|lack|disregard|failure)\b|\bzero\s+(?:automated|meaningful|real)\s+\w+/i;

/**
 * Maps a thrown claim-provenance error onto a stable code, sharing the claim module's own
 * classification table so a defect cannot be coded differently depending on which path saw it.
 *
 * Only reached for a defect raised OUTSIDE the per-statement loop, which still aborts the whole
 * build. Per-statement violations are collected via the findings sink instead, so a failing
 * record reports every one of them in a single pass.
 *
 * Messages are the module's own text: they describe the defect and never carry a stack trace,
 * an environment value or a credential.
 */
function classifyClaimError(message: string): QualityFinding {
  const text = message.replace(/^\[Claim\]\s*/, '');
  return error(classifyClaimMessage(message), '$.evaluation.claim_references', text);
}

/**
 * Fields a human editor may never change. Compared against `generation.originalContent`
 * rather than against git history: history proves who changed a file, not whether the
 * judgement survived intact, and a rebase or a squash erases the former.
 *
 * Scores are the product's whole claim to independence. An editor may fix how a finding is
 * worded; they may not change what the jury concluded.
 */
const IMMUTABLE_SCORE_PATHS = ['recalculated_jury_score', 'judge_score_range', 'criterion_averages'];

function collectImmutabilityFindings(original: any, current: any): QualityFinding[] {
  const findings: QualityFinding[] = [];
  if (!original || !current || typeof original !== 'object' || typeof current !== 'object') {
    return findings;
  }

  for (const path of IMMUTABLE_SCORE_PATHS) {
    if (original[path] === undefined && current[path] === undefined) continue;
    if (contentHash(original[path] ?? null) !== contentHash(current[path] ?? null)) {
      findings.push(error(
        'IMMUTABLE_JUDGMENT_FIELD_CHANGED',
        `$.${path}`,
        `${path} differs from the Gemini original. Scores are recomputed from the jury's raw scores and cannot be edited.`
      ));
    }
  }

  const originalJudges: any[] = original.judges || [];
  const currentJudges: any[] = current.judges || [];
  if (originalJudges.length !== currentJudges.length) {
    findings.push(error(
      'IMMUTABLE_JUDGMENT_FIELD_CHANGED',
      '$.judges',
      `The judge count changed from ${originalJudges.length} to ${currentJudges.length}; the jury composition is fixed.`
    ));
    return findings;
  }

  currentJudges.forEach((judge, judgeIndex) => {
    const originalJudge = originalJudges[judgeIndex];
    if (!originalJudge) return;
    if (judge.judge_id !== originalJudge.judge_id) {
      findings.push(error(
        'IMMUTABLE_JUDGMENT_FIELD_CHANGED',
        `$.judges.${judgeIndex}.judge_id`,
        'The persona identity of a judge cannot be edited.'
      ));
    }
    const originalCriteria: any[] = originalJudge.criteria || [];
    const currentCriteria: any[] = judge.criteria || [];
    if (originalCriteria.length !== currentCriteria.length) {
      findings.push(error(
        'IMMUTABLE_JUDGMENT_FIELD_CHANGED',
        `$.judges.${judgeIndex}.criteria`,
        'The criterion count of a judge cannot be edited.'
      ));
      return;
    }
    currentCriteria.forEach((criterion, criterionIndex) => {
      const originalCriterion = originalCriteria[criterionIndex];
      if (!originalCriterion) return;
      if (criterion.criterion_id !== originalCriterion.criterion_id) {
        findings.push(error(
          'IMMUTABLE_JUDGMENT_FIELD_CHANGED',
          `$.judges.${judgeIndex}.criteria.${criterionIndex}.criterion_id`,
          'The criterion identity cannot be edited.'
        ));
      }
      if (criterion.score !== originalCriterion.score) {
        findings.push(error(
          'IMMUTABLE_JUDGMENT_FIELD_CHANGED',
          `$.judges.${judgeIndex}.criteria.${criterionIndex}.score`,
          `The criterion score changed from ${originalCriterion.score} to ${criterion.score}. Criterion scores cannot be edited.`
        ));
      }
    });
  });

  return findings;
}

/**
 * Validates content that has already been persisted.
 *
 * `originalContent` is supplied separately from `content` so a human revision is checked
 * against the Gemini baseline, not against itself. For an unedited generation the two are the
 * same object and the immutability pass is a no-op.
 */
export function validateContent(input: {
  content: unknown | null;
  originalContent: unknown | null;
  evidences: Evidence[];
  /** True when the content is a human revision and must clear the immutability rules. */
  humanEdited: boolean;
  /**
   * The record's immutable generation.promptVersion — the version-dispatch key. 4.x routes
   * to the editorial minimal gate; anything else (including null, for records that predate
   * versioning) keeps the frozen audit-era rules.
   */
  promptVersion?: string | null;
}): ValidationVerdict {
  const errors: QualityFinding[] = [];
  const warnings: QualityFinding[] = [];

  if (input.content === null || input.content === undefined) {
    return {
      content: null,
      status: 'failed',
      errors: [error(
        'RESPONSE_PARSE_FAILED',
        '$',
        'The stored response is not valid JSON, so no publishable content could be constructed from it.'
      )],
      warnings: [],
      repairs: [],
      contentHash: contentHash(null)
    };
  }

  if (isEditorialPromptVersion(input.promptVersion)) {
    return validateEditorialContent(input, errors, warnings);
  }

  // One protected-token context for the whole validation, built from the same evidence bundle
  // that repair, the claim builder and the publication gate use, so all paths segment alike.
  const protectedTokens = buildProtectedTokens(input.evidences);

  const { content: repaired, repairs } = repairContent(input.content, input.evidences, protectedTokens);

  // Schema first: the rules below assume a shape, and reporting "no recommended_next_step" on
  // content that is not an evaluation at all would be noise rather than a finding.
  const schemaResult = EvaluationOutputGenSchemaV2_1.safeParse(repaired);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues.slice(0, 20)) {
      errors.push(error(
        'SCHEMA_VALIDATION_FAILED',
        `$.${issue.path.join('.')}`,
        issue.message
      ));
    }
    return {
      content: repaired,
      status: 'failed',
      errors,
      warnings,
      repairs,
      contentHash: contentHash(repaired)
    };
  }

  if (input.humanEdited) {
    errors.push(...collectImmutabilityFindings(input.originalContent, repaired));
  }

  for (const finding of collectRecommendationFindings(repaired, input.evidences)) {
    (finding.severity === 'error' ? errors : warnings).push(finding);
  }

  // The one wording-shaped rule that stays fail-closed after 3.2.0: an unsupportable absolute
  // asserted in the jury's own voice. Reported here as well as at the publication gate so the
  // two sides agree — a gate-only rule would pass validation and fail publication.
  for (const { path, statement } of findAbsoluteAssertions(repaired, protectedTokens)) {
    errors.push(error(
      'PROHIBITED_ABSOLUTE_ASSERTION',
      `$.${path}`,
      `${path} asserts an absolute the evidence cannot support ("${statement}"). ` +
      `Attribute it to its source, hedge it, or drop it.`
    ));
  }

  // Claim provenance. The wording sink turns "does this sentence hedge" into a warning while
  // every traceability rule — including source attribution, which the publish-side build
  // judges with the exact same shared predicate — still throws. See public-claims.ts.
  if (input.evidences.length > 0 && (repaired as any).public_statement_annotations !== undefined) {
    const evidenceById = new Map(input.evidences.map(evidence => [evidence.evidence_id, evidence]));
    // One sink for both severities: the claim module records wording defects as warnings and
    // provenance defects as errors, and — because a sink is supplied — keeps going after each
    // one instead of aborting on the first. That is what lets a failing record report its
    // COMPLETE defect set in a single pass; the builder's return value is deliberately unused
    // here, since a set built past an error is incomplete and must never be persisted.
    const claimFindings: QualityFinding[] = [];
    try {
      buildTrustedClaimReferences(repaired, evidenceById, protectedTokens, claimFindings);
    } catch (e: any) {
      // Reached only for a defect raised outside the per-statement loop (e.g. an annotation
      // targeting an unknown field), which still aborts the whole build.
      errors.push(classifyClaimError(String(e?.message ?? e)));
    }
    for (const finding of claimFindings) {
      (finding.severity === 'error' ? errors : warnings).push(finding);
    }
  }

  return {
    content: repaired,
    status: errors.length > 0 ? 'failed' : 'passed',
    errors,
    warnings,
    repairs,
    contentHash: contentHash(repaired)
  };
}

/**
 * The editorial (V3) minimal gate — system protection plus the recommendation contract:
 *
 *   1. repair (version pin + markup folding + text normalization; no wording rewrites)
 *   2. strict schema parse (required fields, 5 unique judges, 6 unique criteria, score
 *      range/0.5-grid, null⟷not_assessable)
 *   3. human-edit immutability (scores and jury composition stay uneditable — unchanged)
 *   4. corruption/injection scans (HTML, fixture leak, CJK, repeated words)
 *   5. the recommendation contract (issue #85), for records whose prompt stated it (4.5.0+):
 *      an action that names an organizational end state the maintainer cannot start, or that
 *      substantially duplicates another judge's action, withholds publication; weaker signals
 *      (no shared concern vocabulary, genericness, brevity) are recorded as warnings.
 *
 * Whether the article is GOOD is still an editorial question no validator asks — prose
 * quality, hedging and intensity remain warning-only below, per the owner decision of
 * 2026-07-25. The recommendation contract is the owner's one deliberate exception (issue #85):
 * it checks structural relations — action↔concern, action↔judges, action↔maintainer — with
 * empirically near-zero false-positive rules, never the quality of the writing itself.
 * Whether claims hold is recorded — non-blockingly — by the evidence map. Buildability is
 * checked by the caller exactly as for legacy content.
 */
function validateEditorialContent(
  input: {
    content: unknown | null;
    originalContent: unknown | null;
    evidences: Evidence[];
    humanEdited: boolean;
    promptVersion?: string | null;
  },
  errors: QualityFinding[],
  warnings: QualityFinding[]
): ValidationVerdict {
  const { content: repaired, repairs } = repairContent(input.content, input.evidences, undefined, { mode: 'editorial' });

  const schemaResult = EvaluationOutputSchemaV3.safeParse(repaired);
  if (!schemaResult.success) {
    for (const issue of schemaResult.error.issues.slice(0, 20)) {
      errors.push(error(
        'SCHEMA_VALIDATION_FAILED',
        `$.${issue.path.join('.')}`,
        issue.message
      ));
    }
    return {
      content: repaired,
      status: 'failed',
      errors,
      warnings,
      repairs,
      contentHash: contentHash(repaired)
    };
  }

  if (input.humanEdited) {
    errors.push(...collectImmutabilityFindings(input.originalContent, repaired));
  }

  for (const defect of findSystemProtectionDefects(repaired)) {
    errors.push(error(defect.code, defect.path, defect.message));
  }

  // The recommendation contract, only for records whose prompt actually stated it. The
  // findings carry the contract module's own rule version, so a finding is always traceable
  // to the rule set that produced it.
  if (recommendationContractApplies(input.promptVersion)) {
    for (const finding of collectEditorialRecommendationFindings(repaired)) {
      (finding.severity === 'error' ? errors : warnings).push(finding);
    }
  }

  // Wording surveillance, WARNING-ONLY: unsupportable absolutes asserted in the jury's own
  // voice, and scorched-earth condemnation phrasing. Neither can fail an editorial record —
  // prose is the editor's jurisdiction — but both are worth an operator's eyes.
  const protectedTokens = buildProtectedTokens(input.evidences);
  for (const { path, statement } of findAbsoluteAssertions(repaired, protectedTokens)) {
    warnings.push(warning(
      'ABSOLUTE_ASSERTION_WARNING',
      `$.${path}`,
      `${path} asserts an absolute the evidence cannot support ("${statement}"). Consider attributing, hedging, or dropping it.`
    ));
  }
  for (const field of scannableTextFields(repaired)) {
    const match = field.text.match(EXTREME_SEVERITY_PATTERN);
    if (match) {
      warnings.push(warning(
        'EXTREME_SEVERITY_WARNING',
        `$.${field.path}`,
        `${field.path} uses condemnation phrasing ("${match[0]}") that likely overstates what the evidence shows.`
      ));
    }
  }

  return {
    content: repaired,
    status: errors.length > 0 ? 'failed' : 'passed',
    errors,
    warnings,
    repairs,
    contentHash: contentHash(repaired)
  };
}

/**
 * Applies a verdict to a record, returning the updated record. Pure: the caller persists it.
 *
 * A failing verdict is a *terminal, successful* outcome — excluded, not retried, not
 * regenerated, and not backfilled with a different candidate. A passing verdict stops at
 * `ready`; publication is always a separate, explicit operation (§12/§14), so a revalidation
 * that happens to pass can never silently push content live.
 */
export function applyVerdict(record: GenerationRecord, verdict: ValidationVerdict, checkedAt: string): GenerationRecord {
  const passed = verdict.status === 'passed';
  const revision = record.editorial.currentRevision;

  // Deterministic id: the same validator judging the same revision's same content is the same
  // validation, so re-running it refreshes that history entry in place instead of appending a
  // duplicate. A validator-version bump or an edit changes the id and earns a new entry.
  const validationId = `${VALIDATOR_VERSION}:${revision}:${verdict.contentHash}`;
  const historyEntry = {
    validationId,
    revision,
    contentHash: verdict.contentHash,
    checkedAt,
    validatorVersion: VALIDATOR_VERSION,
    status: verdict.status,
    errors: verdict.errors,
    warnings: verdict.warnings
  };
  // Strictly append-only: past attempts are never overwritten, dropped, or refreshed. An
  // idempotent re-run — the same validator judging the same revision's same content, so the
  // same validationId — is a no-op on the history: the existing entry (including its original
  // checkedAt) is left exactly as first recorded. Only a genuinely new validation (a distinct
  // revision, content hash, or validator version → a new validationId) appends an entry. The
  // top-level quality fields below are a separate materialized view and still reflect this run.
  const priorHistory = record.quality.history ?? [];
  const alreadyRecorded = priorHistory.some(entry => entry.validationId === validationId);
  const history = alreadyRecorded ? priorHistory : [...priorHistory, historyEntry];

  return {
    ...record,
    editorial: {
      ...record.editorial,
      currentContent: verdict.content,
      // A revision's hash describes the content as of that revision, and the repair pass may
      // have rewritten it. Keeping the two in lockstep is what lets the publish gate prove
      // "the content I am about to publish is the content that was validated".
      revisions: record.editorial.revisions.map(revision =>
        revision.revision === record.editorial.currentRevision
          ? { ...revision, contentHash: verdict.contentHash }
          : revision
      )
    },
    quality: {
      status: verdict.status,
      checkedAt,
      validatorVersion: VALIDATOR_VERSION,
      validatedRevision: record.editorial.currentRevision,
      validatedContentHash: verdict.contentHash,
      errors: verdict.errors,
      warnings: verdict.warnings,
      repairs: verdict.repairs,
      history
    },
    publication: passed
      ? {
        // An already-published record stays published: revalidating live content must not
        // demote it to ready and take it off the site as a side effect.
        status: record.publication.status === 'published' ? 'published' : 'ready',
        reason: null,
        publishedAt: record.publication.publishedAt
      }
      : {
        status: 'excluded',
        reason: 'quality_validation_failed',
        // The publication date is a historical fact about a document that WAS published, and
        // `excluded` already carries "not currently live". Nulling it would destroy the only
        // anchor publishRecord has for locating the existing review directory: a record that
        // was published in July, edited, failed one validation, then fixed and republished in
        // August would be written to reviews/2026/08/<slug>/ while reviews/2026/07/<slug>/
        // still exists — and getAllReviews fails the whole site build on the duplicate slug.
        // Editing a published record became a normal operation with owner decision 5, so this
        // path is on the ordinary edit loop rather than unreachable as it used to be.
        publishedAt: record.publication.publishedAt
      }
  };
}
