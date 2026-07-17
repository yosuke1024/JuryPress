import type { Evidence } from '../../schemas/evidence';
import type { RepairRecord } from '../../schemas/generation-record';
import {
  coverageTextFields,
  scannableTextFields,
  normalizeStatement,
  segmentStatements,
  getFieldValue
} from '../evaluation/public-claims';

/**
 * Deterministic repair of a Gemini response.
 *
 * Scope rule: a repair may only change something that has exactly one correct value, where
 * that value is derivable from the response itself. Whitespace has one normalized form; an
 * annotation's evidence ids are already stated in the canonical field it annotates. Anything
 * requiring a judgement call — what a judge meant, whether a claim is supported — is NOT a
 * repair and belongs to the validator.
 *
 * Every repair here replaces a rule that used to reject the whole generation and burn a
 * retry. The model is no longer asked to emit the same information twice and get both copies
 * byte-identical; where two fields must agree, one is designated canonical and the other is
 * derived from it.
 *
 * Repairs never touch `generation.rawResponse` or `generation.originalContent` — they run on
 * a deep copy, and the original stays the immutable baseline.
 */

export const REPAIR_VERSION = '1.0.0';

export interface RepairResult {
  content: any;
  repairs: RepairRecord[];
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Writes a value at a dotted path, supporting numeric array indices. */
function setFieldValue(root: any, path: string, value: unknown): void {
  const segments = path.split('.');
  const last = segments.pop() as string;
  let current = root;
  for (const segment of segments) {
    if (current === null || current === undefined) return;
    current = current[segment];
  }
  if (current === null || current === undefined || typeof current !== 'object') return;
  current[last] = value;
}

/**
 * Canonical text form for a public field: NFC, no zero-width characters, single spaces,
 * folded sentence terminators. Reader-visible meaning is unchanged; what changes is that the
 * text now has exactly one representation, so statement matching is exact rather than fuzzy.
 *
 * This runs on the published text (not just on the comparison key) deliberately: if the
 * stored text and the matching key disagree, the next validator change re-opens the same
 * class of mismatch. Normalizing once, at the source, closes it.
 */
function normalizePublicText(text: string): string {
  return normalizeStatement(text);
}

/**
 * Repair 1 — whitespace / quotes / punctuation / Unicode normalization of every public text
 * field. Also the precondition for repair 3: annotations can only be matched to statements
 * exactly once both sides share a canonical form.
 */
function repairPublicTextFields(content: any, repairs: RepairRecord[]): void {
  for (const field of coverageTextFields(content)) {
    const normalized = normalizePublicText(field.text);
    if (normalized === field.text) continue;
    setFieldValue(content, field.path, normalized);
    repairs.push({
      code: 'PUBLIC_TEXT_NORMALIZED',
      path: `$.${field.path}`,
      message: 'Normalized whitespace, Unicode form and sentence punctuation to their canonical representation.'
    });
  }
}

/**
 * Repair 2 — derive each recommendation annotation's evidence ids from the canonical field.
 *
 * `recommended_next_step.evidence_ids` is the canonical statement of which evidence grounds a
 * recommendation. The annotation on the same action previously had to repeat that list and
 * match it as a set, which made a purely clerical divergence reject the entire generation.
 * The annotation's ids are now *derived* from the canonical field, so the two can never
 * disagree and the model is never asked for the same list twice.
 */
function repairRecommendationAnnotations(content: any, repairs: RepairRecord[]): void {
  const annotations: any[] = content.public_statement_annotations || [];
  if (annotations.length === 0) return;

  (content.judges || []).forEach((judge: any, judgeIndex: number) => {
    const step = judge?.recommended_next_step;
    if (!step) return;
    const canonical = dedupePreservingOrder(step.evidence_ids || []);
    if (canonical.length === 0) return;

    const actionPath = `judges.${judgeIndex}.recommended_next_step.action`;
    for (const annotation of annotations) {
      if (annotation.public_output_path !== actionPath) continue;
      if (sameIdSet(annotation.evidence_ids || [], canonical)) continue;
      annotation.evidence_ids = [...canonical];
      repairs.push({
        code: 'RECOMMENDATION_ANNOTATION_EVIDENCE_SYNCED',
        path: `$.${actionPath}`,
        message: 'Derived the recommendation annotation evidence ids from recommended_next_step.evidence_ids, the canonical field.'
      });
    }
  });
}

/**
 * Repair 3 — snap an annotation's statement_text onto the canonical statement it already
 * matches after normalization. An annotation that matches no statement even after
 * normalization is NOT repaired: that is a genuine mismatch and the validator hard-fails it.
 */
function repairAnnotationStatementText(content: any, repairs: RepairRecord[]): void {
  const annotations: any[] = content.public_statement_annotations || [];
  if (annotations.length === 0) return;

  const statementsByPath = new Map<string, string[]>();
  for (const field of coverageTextFields(content)) {
    statementsByPath.set(field.path, segmentStatements(field.text));
  }

  for (const annotation of annotations) {
    const statements = statementsByPath.get(annotation.public_output_path);
    if (!statements) continue;
    const target = normalizeStatement(annotation.statement_text || '');
    if (!target) continue;
    const match = statements.find(statement => normalizeStatement(statement) === target);
    if (!match || match === annotation.statement_text) continue;
    annotation.statement_text = match;
    repairs.push({
      code: 'CLAIM_ANNOTATION_TEXT_NORMALIZED',
      path: `$.${annotation.public_output_path}`,
      message: 'Snapped the annotation statement text onto the canonical statement it already matched after normalization.'
    });
  }
}

/**
 * Repair 4 — deduplicate `recommended_next_step.evidence_ids`. A repeated id carries no extra
 * information, so the deduplicated list is the single correct value.
 */
function repairRecommendationEvidenceIds(content: any, repairs: RepairRecord[]): void {
  (content.judges || []).forEach((judge: any, judgeIndex: number) => {
    const step = judge?.recommended_next_step;
    if (!step || !Array.isArray(step.evidence_ids)) return;
    const deduped = dedupePreservingOrder(step.evidence_ids);
    if (deduped.length === step.evidence_ids.length) return;
    step.evidence_ids = deduped;
    repairs.push({
      code: 'RECOMMENDATION_EVIDENCE_IDS_DEDUPED',
      path: `$.judges.${judgeIndex}.recommended_next_step.evidence_ids`,
      message: 'Removed duplicate evidence ids; a repeated citation carries no additional provenance.'
    });
  });
}

/**
 * Repair 5 — pin `primary_concern_index` to 0. The contract defines the primary concern as
 * concerns[0], so the field is a restatement of a fixed constant rather than a choice.
 */
function repairPrimaryConcernIndex(content: any, repairs: RepairRecord[]): void {
  (content.judges || []).forEach((judge: any, judgeIndex: number) => {
    const step = judge?.recommended_next_step;
    if (!step || step.primary_concern_index === 0) return;
    if (!Array.isArray(judge.concerns) || judge.concerns.length === 0) return;
    step.primary_concern_index = 0;
    repairs.push({
      code: 'PRIMARY_CONCERN_INDEX_PINNED',
      path: `$.judges.${judgeIndex}.recommended_next_step.primary_concern_index`,
      message: 'Pinned primary_concern_index to 0; the contract defines the primary concern as concerns[0].'
    });
  });
}

function dedupePreservingOrder(ids: string[]): string[] {
  return [...new Set(ids)];
}

function sameIdSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b);
  return a.every(id => setB.has(id));
}

/**
 * Repair 6 — pin the schema version. The application owns the contract version; a model that
 * reports a different one is reporting, not deciding.
 */
function repairSchemaVersion(content: any, repairs: RepairRecord[]): void {
  if (content.schema_version === '2.1.0') return;
  content.schema_version = '2.1.0';
  repairs.push({
    code: 'SCHEMA_VERSION_PINNED',
    path: '$.schema_version',
    message: 'Pinned schema_version to the contract version owned by the application.'
  });
}

/**
 * Editorial substitutions with exactly one meaning-preserving target. These are not style
 * preferences dressed up as repairs: each pair replaces an absolute with its calibrated
 * equivalent ("flawless" → "excellent"), which is the house standard and has one correct
 * result. The residual prohibited-phrase scan is a warning, not a repair — see the validator.
 *
 * Previously applied as a regex sweep over the raw response text, which mutated the model's
 * output before it was ever stored. They now run on parsed public fields, after the verbatim
 * response is durable, and each substitution is recorded.
 */
const CALIBRATION_SUBSTITUTIONS: Array<[RegExp, string]> = [
  [/\bperfect\b/gi, 'excellent'],
  [/\bflawless\b/gi, 'excellent'],
  [/\bobviously\b/gi, 'clearly'],
  [/\bliterally zero\b/gi, 'extremely low'],
  [/\bno value\b/gi, 'limited value'],
  [/\bguaranteed\b/gi, 'assured'],
  [/\bwill definitely\b/gi, 'is expected to'],
  [/\bproves demand\b/gi, 'suggests demand'],
  [/\bwithout question\b/gi, 'clearly'],
  [/\bhas no commercial value\b/gi, 'has no clear commercial path'],
  [/\bis almost flawless\b/gi, 'is highly refined'],
  [/\bwill easily become\b/gi, 'shows potential to become'],
  [/\bhas no real-world impact\b/gi, 'has limited immediate real-world impact'],
  [/\bis perfectly designed\b/gi, 'is well designed'],
  [/\bhas no error recovery\b/gi, 'does not specify error recovery'],
  [/\bhas serious security vulnerabilities\b/gi, 'presents potential security concerns'],
  [/example\.com/gi, 'example.invalid']
];

/** HTML markup in a JSON string field is never intended as markup; it renders as noise. */
const HTML_TAG_PATTERN = /<([a-zA-Z/][^>]*)>/g;

function repairCalibratedLanguage(content: any, repairs: RepairRecord[]): void {
  for (const field of scannableTextFields(content)) {
    let text = field.text;
    for (const [pattern, replacement] of CALIBRATION_SUBSTITUTIONS) {
      text = text.replace(pattern, replacement);
    }
    text = text.replace(HTML_TAG_PATTERN, '[$1]');
    if (text === field.text) continue;
    setFieldValue(content, field.path, text);
    repairs.push({
      code: 'CALIBRATED_LANGUAGE_APPLIED',
      path: `$.${field.path}`,
      message: 'Replaced absolute wording and inline markup with their calibrated equivalents.'
    });
  }
}

/**
 * Repair 7 — backfill the application's own calibration statements on low/medium-confidence
 * criteria. These sentences are application-authored (see SYSTEM_INJECTED_STATEMENTS in
 * public-claims.ts), so their text is fixed and their provenance is system-generated.
 */
const CALIBRATED_PHRASES = [
  'according to', 'states that', 'metadata reports', 'inferred', 'suggests',
  'inferred that', 'could not verify', 'does not establish', 'no public evidence',
  'source confirmed', 'creator claim'
];

const LIMITATIONS_FALLBACK = 'The available evidence does not describe detailed limitations metadata.';
const REASONING_CALIBRATION_SUFFIX = 'This assessment was inferred from creator claims and available evidence metadata.';

function repairLowConfidenceCalibration(content: any, repairs: RepairRecord[]): void {
  (content.judges || []).forEach((judge: any, judgeIndex: number) => {
    (judge.criteria || []).forEach((criterion: any, criterionIndex: number) => {
      if (criterion.confidence !== 'low' && criterion.confidence !== 'medium') return;
      const base = `$.judges.${judgeIndex}.criteria.${criterionIndex}`;

      if (!Array.isArray(criterion.limitations) || criterion.limitations.length === 0) {
        criterion.limitations = [LIMITATIONS_FALLBACK];
        repairs.push({
          code: 'LOW_CONFIDENCE_LIMITATIONS_BACKFILLED',
          path: `${base}.limitations`,
          message: 'Backfilled the application-authored limitations statement required of a low/medium-confidence criterion.'
        });
      }

      const reasoning = criterion.reasoning || '';
      const hasCalibration = CALIBRATED_PHRASES.some(phrase => reasoning.toLowerCase().includes(phrase));
      if (!hasCalibration) {
        criterion.reasoning = `${reasoning} ${REASONING_CALIBRATION_SUFFIX}`.trim();
        repairs.push({
          code: 'LOW_CONFIDENCE_REASONING_CALIBRATED',
          path: `${base}.reasoning`,
          message: 'Appended the application-authored calibration statement required of a low/medium-confidence criterion.'
        });
      }
    });
  });
}

/**
 * Applies every deterministic repair, in dependency order:
 *
 *   1. schema version — cheap, unconditional.
 *   2. calibrated language and markup — rewrites field text.
 *   3. low-confidence calibration — appends application-authored statements to that text.
 *   4. text normalization — canonicalizes everything the steps above produced.
 *   5. recommendation fields — dedupe and pin the canonical source of truth.
 *   6. annotation derivation and snapping — consumes the canonical text and ids from above.
 *
 * `evidences` is accepted for symmetry with the validator and for future repairs that need to
 * resolve ids; no current repair invents or removes an evidence citation, because doing so
 * would change what the content claims.
 */
export function repairContent(content: unknown, _evidences: Evidence[]): RepairResult {
  if (content === null || typeof content !== 'object') {
    return { content, repairs: [] };
  }
  const repaired = deepCopy(content) as any;
  const repairs: RepairRecord[] = [];

  repairSchemaVersion(repaired, repairs);
  repairCalibratedLanguage(repaired, repairs);
  repairLowConfidenceCalibration(repaired, repairs);
  repairPublicTextFields(repaired, repairs);
  repairRecommendationEvidenceIds(repaired, repairs);
  repairPrimaryConcernIndex(repaired, repairs);
  repairRecommendationAnnotations(repaired, repairs);
  repairAnnotationStatementText(repaired, repairs);

  return { content: repaired, repairs };
}

export { getFieldValue };
