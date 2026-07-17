import type { Evidence } from '../../schemas/evidence';
import type { GenerationRecord, QualityFinding, RepairRecord } from '../../schemas/generation-record';
import { EvaluationOutputGenSchemaV2_1 } from '../../schemas/evaluation';
import { buildTrustedClaimReferences } from '../evaluation/public-claims';
import { collectRecommendationFindings } from '../evaluation/recommendations';
import { repairContent } from './repair';
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
 */

export const VALIDATOR_VERSION = '2.0.0';

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

/**
 * Maps a thrown claim-provenance error onto a stable code. The claim module fails closed by
 * throwing on the first traceability violation (it cannot build a reference set without it),
 * so this yields one finding rather than a list — deliberately, since the rest of the set is
 * unknowable until that one is fixed.
 *
 * Messages are the module's own text: they describe the defect and never carry a stack trace,
 * an environment value or a credential.
 */
function classifyClaimError(message: string): QualityFinding {
  const text = message.replace(/^\[Claim\]\s*/, '');
  const table: Array<[RegExp, string]> = [
    [/references missing evidence|does not exist in the evidence bundle/i, 'EVIDENCE_ID_NOT_FOUND'],
    [/matches no statement of that field|does not match the published statement/i, 'CLAIM_STATEMENT_UNMATCHED'],
    [/targets unknown or empty public field|beyond the field's/i, 'CLAIM_ANNOTATION_TARGET_UNKNOWN'],
    [/has no evidence-backed provenance annotation|is not covered by any claim reference/i, 'CLAIM_PROVENANCE_MISSING'],
    [/mixes creator and community sources/i, 'CLAIM_MIXED_SOURCE_VOICES'],
    [/mixed fact classes/i, 'CLAIM_MIXED_FACT_CLASSES'],
    [/is evidence_backed but cites/i, 'CLAIM_EVIDENCE_TOO_WEAK'],
    [/tampered|changes fact class|misstates/i, 'CLAIM_REFERENCE_TAMPERED'],
    [/Duplicate reference/i, 'CLAIM_REFERENCE_DUPLICATE']
  ];
  for (const [pattern, code] of table) {
    if (pattern.test(text)) return error(code, '$.evaluation.claim_references', text);
  }
  return error('CLAIM_VALIDATION_FAILED', '$.evaluation.claim_references', text);
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
    if (judge.persona_id !== originalJudge.persona_id) {
      findings.push(error(
        'IMMUTABLE_JUDGMENT_FIELD_CHANGED',
        `$.judges.${judgeIndex}.persona_id`,
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

  const { content: repaired, repairs } = repairContent(input.content, input.evidences);

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

  // Claim provenance. The wording sink turns "does this sentence hedge" into a warning while
  // every traceability rule still throws — see public-claims.ts.
  if (input.evidences.length > 0 && (repaired as any).public_statement_annotations !== undefined) {
    const evidenceById = new Map(input.evidences.map(evidence => [evidence.evidence_id, evidence]));
    try {
      buildTrustedClaimReferences(repaired, evidenceById, warnings);
    } catch (e: any) {
      errors.push(classifyClaimError(String(e?.message ?? e)));
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
      repairs: verdict.repairs
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
        publishedAt: null
      }
  };
}
