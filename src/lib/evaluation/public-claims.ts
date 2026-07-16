import type { Evidence, EvidenceFactClass } from '../../schemas/evidence';

/**
 * Phase 1 Claim Provenance — shared single source of truth.
 *
 * Both the generation-side validator (evaluator.verifyRules / buildTrustedClaimReferences)
 * and the publication gate (validateRefinedReviewIntegrity) import this module so the two
 * can never drift. The contract is statement-level, whole-field coverage:
 *
 *  1. Every reader-facing public field in COVERAGE_FIELDS is deterministically segmented
 *     into statements by `segmentStatements`.
 *  2. Every statement must be accounted for by exactly one trusted ClaimReference whose
 *     `statement_text` equals it (after normalization). One substring no longer covers a
 *     whole field; an un-annotated sentence fails closed.
 *  3. fact_class, attribution_required and coverage_source are derived by the application
 *     from the evidence and the declared support_mode. Gemini never supplies them.
 *
 * Guarantee boundary (deliberate, deterministic-only): this contract guarantees per-statement
 * classification, attribution and whole-field coverage. It does NOT verify that a cited
 * evidence semantically supports its statement (a statement may cite a resolving but unrelated
 * evidence id — topic-overlap binding is not used because it breaks legitimate inference whose
 * wording naturally diverges from its evidence), nor does it split an assertion from a hedge
 * joined by a comma inside one grammatical sentence (semicolons DO split). Those residuals are
 * inherent to sentence-granular, non-semantic verification and are backstopped by the
 * confidence ceilings, the metadata-number and prohibited-phrase scans, and human review.
 */

export type SupportMode = 'evidence_backed' | 'inference' | 'unverified';
export type CoverageSource = 'statement_annotation' | 'system_generated';

/** The application-owned, trusted reference. Persisted as evaluation.claim_references. */
export interface TrustedClaimReference {
  claim_id: string;
  public_output_path: string;
  statement_index: number;
  statement_text: string;
  support_mode: SupportMode;
  fact_class: EvidenceFactClass;
  attribution_required: boolean;
  evidence_ids: string[];
  coverage_source: CoverageSource;
}

/** Untrusted, generation-only annotation shape (mirrors PublicStatementAnnotationGenSchema). */
export interface StatementAnnotation {
  public_output_path: string;
  statement_text: string;
  support_mode: SupportMode;
  evidence_ids: string[];
}

// ---------------------------------------------------------------------------
// Deterministic normalization and segmentation
// ---------------------------------------------------------------------------

/**
 * Canonical whitespace/Unicode normalization. Every whitespace run collapses to a single
 * U+0020 and the string is NFC-composed, so segmentation and equality are deterministic
 * regardless of how the model spaced its output.
 */
export function normalizeStatement(s: string): string {
  return s
    .normalize('NFC')
    // Strip zero-width / soft-hyphen / format / default-ignorable characters (ZWSP, ZWNJ, ZWJ,
    // directional marks, U+2060-2064, U+206A-206F, tag characters, variation selectors, \u2026).
    // They are invisible to a reader but survive NFC and are mostly not matched by \s, so
    // without this an adversary could sit one between a period and its space to defeat the
    // sentence-boundary lookahead. (NBSP, line/paragraph separators and BOM are already in \s.)
    .replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, '')
    .replace(/[；﹔]/g, ';')
    // Fold every Unicode sentence terminator (｡ ． ․ 。 ‼ ⁇ ⁉ ‽ danda । Arabic ۔ …) plus the
    // single-char ellipsis down to an ASCII terminator, by Unicode property rather than an
    // allowlist, so no look-alike terminator can hide a reader-visible sentence boundary.
    .replace(/[\p{Sentence_Terminal}…]/gu, ch => ('.!?'.includes(ch) ? ch : '.'))
    // Fold any control character (including NEL U+0085, which \s does not match) to a space.
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Partitions normalized field text into ordered statements. A statement boundary is a run of
 * sentence terminators (. ! ? or a semicolon), optionally followed by closing quotes/brackets.
 * The ONLY thing that does not split is a decimal-internal dot — a single "." with a digit on
 * both sides ("3.5", "v1.2"). Every other terminator splits regardless of what follows it (a
 * non-ASCII letter, em-dash, opening quote, CJK, etc.), so two reader-visible sentences can
 * never merge into one statement. The slices are an exact index partition of the normalized
 * text — no visible character is dropped — so "cover every statement" is provably equal to
 * "cover the whole field". Over-splitting (e.g. abbreviations) is harmless: it only raises the
 * provenance-coverage requirement, never the displayed text.
 */
export function segmentStatements(text: string): string[] {
  const norm = normalizeStatement(text);
  if (!norm) return [];
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["'”’»)\]}]*|;+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    // A lone "." with a digit on both sides is a decimal/version separator, not a boundary.
    if (m[0] === '.' && /\d/.test(norm[m.index - 1] || '') && /\d/.test(norm[m.index + 1] || '')) {
      continue;
    }
    const end = m.index + m[0].length;
    const seg = norm.slice(start, end).trim();
    if (seg) out.push(seg);
    start = end;
  }
  if (start < norm.length) {
    const tail = norm.slice(start).trim();
    if (tail) out.push(tail);
  }
  return out;
}

/** Splitter invariant: re-joining the statements reproduces the normalized field exactly. */
export function assertLosslessSegmentation(text: string): void {
  const target = normalizeStatement(text);
  const rebuilt = normalizeStatement(segmentStatements(text).join(' '));
  if (rebuilt !== target) {
    throw new Error(`[Segmenter] Non-lossless segmentation: "${rebuilt}" !== "${target}"`);
  }
}

// ---------------------------------------------------------------------------
// The public-field SSOT (three views of one enumeration)
// ---------------------------------------------------------------------------

type Field = { path: string; text: string };

function pushString(fields: Field[], path: string, value: unknown): void {
  if (typeof value === 'string' && value.trim().length > 0) fields.push({ path, text: value });
}

/**
 * COVERAGE view — every Gemini-authored public field that states a claim about the product
 * and therefore requires full-text statement coverage. This is the SSOT the spec mandates.
 * Identity/taxonomy strings pinned by application config (persona name, role, criterion id)
 * are deliberately excluded; they are not model assertions.
 */
export function coverageTextFields(evaluation: any): Field[] {
  const fields: Field[] = [];
  pushString(fields, 'product.category', evaluation.product?.category);
  pushString(fields, 'product.summary', evaluation.product?.summary);
  pushString(fields, 'product.primary_audience', evaluation.product?.primary_audience);
  pushString(fields, 'article.headline', evaluation.article?.headline);
  pushString(fields, 'article.standfirst', evaluation.article?.standfirst);
  pushString(fields, 'article.jury_summary', evaluation.article?.jury_summary);
  evaluation.article?.where_jury_agreed?.forEach((value: string, index: number) =>
    pushString(fields, `article.where_jury_agreed.${index}`, value));
  evaluation.article?.where_jury_disagreed?.forEach((value: any, index: number) =>
    pushString(fields, `article.where_jury_disagreed.${index}.summary`, value?.summary));
  evaluation.article?.evidence_limitations?.forEach((value: string, index: number) =>
    pushString(fields, `article.evidence_limitations.${index}`, value));
  pushString(fields, 'article.final_verdict', evaluation.article?.final_verdict);
  pushString(fields, 'article.meta_description', evaluation.article?.meta_description);
  evaluation.judges?.forEach((judge: any, judgeIndex: number) => {
    pushString(fields, `judges.${judgeIndex}.verdict`, judge.verdict);
    judge.strengths?.forEach((value: string, index: number) =>
      pushString(fields, `judges.${judgeIndex}.strengths.${index}`, value));
    judge.concerns?.forEach((value: string, index: number) =>
      pushString(fields, `judges.${judgeIndex}.concerns.${index}`, value));
    pushString(fields, `judges.${judgeIndex}.decisive_question`, judge.decisive_question);
    judge.criteria?.forEach((criterion: any, criterionIndex: number) => {
      pushString(fields, `judges.${judgeIndex}.criteria.${criterionIndex}.reasoning`, criterion.reasoning);
      criterion.limitations?.forEach((value: string, index: number) =>
        pushString(fields, `judges.${judgeIndex}.criteria.${criterionIndex}.limitations.${index}`, value));
    });
  });
  return fields;
}

/**
 * SCANNABLE view — everything reader-facing, a superset of the coverage view plus the
 * application-derived identity/classification strings. Feeds the metadata-number consistency
 * scan and the internal-implementation-leak scan (which must see the whole surface).
 */
export function scannableTextFields(evaluation: any): Field[] {
  const fields = coverageTextFields(evaluation);
  pushString(fields, 'product.name', evaluation.product?.name);
  evaluation.article?.evidence_classifications?.forEach((entry: any, index: number) =>
    pushString(fields, `article.evidence_classifications.${index}.claim`, entry?.claim));
  return fields;
}

/**
 * ASSERTION-SCAN view — scannable minus the hedge/limitation-class fields. The prohibited
 * "tests pass" assertion scan runs over this so a legitimately hedged limitation
 * ("could not verify that the tests pass") or an evidence-gap question does not hard-fail.
 */
export function assertionScanFields(evaluation: any): Field[] {
  // Exclude only the limitation-class and decisive_question fields, where hedged mentions of
  // test execution legitimately live (e.g. "could not verify that the tests pass"). Concerns
  // stay in the scan so a positive "tests pass" assertion laundered into a concern is caught.
  const excluded = /(\.limitations\.\d+$)|(^article\.evidence_limitations\.)|(\.decisive_question$)/;
  return scannableTextFields(evaluation).filter(field => !excluded.test(field.path));
}

export function getFieldValue(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, root);
}

// ---------------------------------------------------------------------------
// Fact-class derivation and attribution
// ---------------------------------------------------------------------------

export function factClassForEvidence(evidence: Evidence): EvidenceFactClass {
  const raw = evidence.claims?.[0]?.claim_type as string | undefined;
  if (raw === 'verified_fact') return 'confirmed_fact';
  if (raw === 'unknown') return 'unverified';
  if (raw && ['confirmed_fact', 'creator_claim', 'community_opinion', 'repository_observation', 'inference', 'unverified'].includes(raw)) {
    return raw as EvidenceFactClass;
  }
  if (evidence.type === 'api_metadata') return 'confirmed_fact';
  if (['source_code', 'test_file', 'ci_workflow', 'dependency_manifest'].includes(evidence.type)) return 'repository_observation';
  if (evidence.type === 'source_discussion') return 'community_opinion';
  if (['readme', 'official_site', 'additional_evidence'].includes(evidence.type)) return 'creator_claim';
  return 'unverified';
}

/** A cited claim must be attributed when any supporting evidence is a claim, not a fact. */
export function attributionRequired(factClasses: EvidenceFactClass[]): boolean {
  return factClasses.some(fc => fc === 'creator_claim' || fc === 'community_opinion');
}

export const CREATOR_ATTRIBUTION = /\b(according to|readme|project describes|creator (?:states|reports|claims)|repository documents|documentation (?:states|says))\b/i;
export const COMMUNITY_ATTRIBUTION = /\b(commenter|commenters|community|discussion|community opinion|a user|users questioned|criticism|criticized)\b/i;

export function attributionPatternFor(factClass: EvidenceFactClass): RegExp {
  return factClass === 'community_opinion' ? COMMUNITY_ATTRIBUTION : CREATOR_ATTRIBUTION;
}

/** Calibrated inference wording that an `inference` statement must contain about itself. */
export const INFERENCE_PATTERN = /\b(suggests?|may|might|could|appears?|indicat\w*|infer\w*|likely|does not prove|but does not|implies)\b/i;

/** Absence/uncertainty wording that an `unverified` statement must contain about itself. */
export const UNVERIFIED_PATTERN = /\b(could not|cannot|can not|does not establish|did not establish|do not establish|no public evidence|not (?:independently )?verified|unverified|no verified|was not (?:verified|collected|confirmed)|were not (?:verified|collected|confirmed)|did not (?:include|describe|show|confirm|establish)|does not (?:describe|show|confirm|prove)|unable to (?:verify|confirm)|no evidence (?:was )?found|remains? unclear|insufficient evidence|not assessable)\b/i;

/**
 * Statements the application itself injects into public fields during calibration/ceiling
 * remediation. They are trusted by construction; a system_generated reference is legitimate
 * only when its statement_text is one of these (normalized), which prevents a persisted
 * review from laundering an arbitrary claim as system-authored.
 */
export const SYSTEM_INJECTED_RAW = [
  'The available evidence does not describe detailed limitations metadata.',
  'The public evidence did not include a verified test execution result for the reviewed commit.',
  'The available evidence does not establish verified runtime results.',
  'This assessment was inferred from creator claims and available evidence metadata.'
] as const;

export const SYSTEM_INJECTED_STATEMENTS: ReadonlySet<string> = new Set(
  SYSTEM_INJECTED_RAW.map(normalizeStatement)
);

// ---------------------------------------------------------------------------
// Reference construction (generation side) and re-validation (both sides)
// ---------------------------------------------------------------------------

function resolveEvidence(evidenceById: Map<string, Evidence>, evidenceId: string, context: string): Evidence {
  const evidence = evidenceById.get(evidenceId);
  if (!evidence) throw new Error(`[Claim] ${context} references missing evidence "${evidenceId}".`);
  return evidence;
}

/** Derives the trusted fields for one evidence-backed statement, rejecting the creator×community mix. */
function deriveEvidenceBacked(
  statementText: string,
  evidenceIds: string[],
  evidenceById: Map<string, Evidence>,
  context: string
): { fact_class: EvidenceFactClass; attribution_required: boolean } {
  if (evidenceIds.length === 0) {
    throw new Error(`[Claim] ${context} is evidence_backed but cites no evidence.`);
  }
  const factClasses = evidenceIds.map(id => factClassForEvidence(resolveEvidence(evidenceById, id, context)));
  const hasCreator = factClasses.includes('creator_claim');
  const hasCommunity = factClasses.includes('community_opinion');
  if (hasCreator && hasCommunity) {
    throw new Error(`[Claim] ${context} mixes creator and community sources; split into one statement per source.`);
  }
  const fact_class: EvidenceFactClass = hasCommunity ? 'community_opinion' : (hasCreator ? 'creator_claim' : factClasses[0]);
  const attribution_required = hasCreator || hasCommunity;
  if (attribution_required && !attributionPatternFor(fact_class).test(statementText)) {
    throw new Error(`[Claim] ${context} cites a ${fact_class} but the statement itself carries no attribution.`);
  }
  return { fact_class, attribution_required };
}

/** Builds one trusted reference from a validated model annotation. Throws on any violation. */
function referenceFromAnnotation(
  path: string,
  statementIndex: number,
  statementText: string,
  annotation: StatementAnnotation,
  evidenceById: Map<string, Evidence>
): TrustedClaimReference {
  const context = `${path} statement ${statementIndex}`;
  const evidenceIds = [...new Set(annotation.evidence_ids)];
  const base = {
    claim_id: `stmt-${path}-${statementIndex}`,
    public_output_path: path,
    statement_index: statementIndex,
    statement_text: statementText,
    evidence_ids: evidenceIds,
    coverage_source: 'statement_annotation' as const
  };

  if (annotation.support_mode === 'evidence_backed') {
    const derived = deriveEvidenceBacked(statementText, evidenceIds, evidenceById, context);
    return { ...base, support_mode: 'evidence_backed', ...derived };
  }
  if (annotation.support_mode === 'inference') {
    if (evidenceIds.length === 0) throw new Error(`[Claim] ${context} is an inference but cites no grounding evidence.`);
    evidenceIds.forEach(id => resolveEvidence(evidenceById, id, context));
    if (!INFERENCE_PATTERN.test(statementText)) {
      throw new Error(`[Claim] ${context} is an inference but uses no calibrated wording (e.g. "suggests", "may", "the jury inferred").`);
    }
    return { ...base, support_mode: 'inference', fact_class: 'inference', attribution_required: false };
  }
  // unverified
  evidenceIds.forEach(id => resolveEvidence(evidenceById, id, context));
  if (!UNVERIFIED_PATTERN.test(statementText)) {
    throw new Error(`[Claim] ${context} is unverified but uses no absence wording (e.g. "could not verify", "does not establish", "no public evidence").`);
  }
  return { ...base, support_mode: 'unverified', fact_class: 'unverified', attribution_required: false };
}

function systemGeneratedReference(path: string, statementIndex: number, statementText: string): TrustedClaimReference {
  return {
    claim_id: `sys-${path}-${statementIndex}`,
    public_output_path: path,
    statement_index: statementIndex,
    statement_text: statementText,
    support_mode: 'unverified',
    fact_class: 'unverified',
    attribution_required: false,
    evidence_ids: [],
    coverage_source: 'system_generated'
  };
}

/**
 * Builds the complete trusted reference set from the model's statement annotations.
 * Every statement of every coverage field must be matched by exactly one annotation
 * (by normalized-text equality) or be an application-injected statement; otherwise it
 * throws. This is the fail-closed generation contract.
 */
export function buildTrustedClaimReferences(evaluation: any, evidenceById: Map<string, Evidence>): TrustedClaimReference[] {
  const annotations: StatementAnnotation[] = evaluation.public_statement_annotations || [];
  const fields = coverageTextFields(evaluation);
  const knownPaths = new Set(fields.map(f => f.path));

  for (const annotation of annotations) {
    if (!knownPaths.has(annotation.public_output_path)) {
      throw new Error(`[Claim] Annotation targets unknown or empty public field "${annotation.public_output_path}".`);
    }
  }

  const annotationsByPath = new Map<string, StatementAnnotation[]>();
  for (const annotation of annotations) {
    const list = annotationsByPath.get(annotation.public_output_path) || [];
    list.push(annotation);
    annotationsByPath.set(annotation.public_output_path, list);
  }

  const references: TrustedClaimReference[] = [];
  for (const field of fields) {
    const statements = segmentStatements(field.text);
    const normalized = statements.map(normalizeStatement);
    const consumed = new Set<number>();

    for (const annotation of annotationsByPath.get(field.path) || []) {
      const target = normalizeStatement(annotation.statement_text);
      const index = normalized.findIndex((s, i) => !consumed.has(i) && s === target);
      if (index < 0) {
        throw new Error(`[Claim] Annotation on ${field.path} ("${annotation.statement_text}") matches no statement of that field.`);
      }
      consumed.add(index);
      references.push(referenceFromAnnotation(field.path, index, statements[index], annotation, evidenceById));
    }

    statements.forEach((statement, index) => {
      if (consumed.has(index)) return;
      if (SYSTEM_INJECTED_STATEMENTS.has(normalized[index])) {
        references.push(systemGeneratedReference(field.path, index, statement));
        return;
      }
      throw new Error(`[Claim] ${field.path} statement ${index} ("${statement}") has no evidence-backed provenance annotation.`);
    });
  }

  return references;
}

/**
 * Independently re-validates a persisted trusted reference set against the evaluation and
 * evidence bundle. Used by BOTH the generator (immediately after building, to guarantee
 * agreement with the gate) and the publication gate. It re-derives every trusted field so a
 * persisted reference can never relabel its fact class, forge attribution, cite missing
 * evidence, or leave a statement uncovered.
 */
export function validateClaimReferences(
  evaluation: any,
  references: TrustedClaimReference[],
  evidenceById: Map<string, Evidence>
): void {
  const fields = coverageTextFields(evaluation);
  const knownPaths = new Set(fields.map(f => f.path));

  const byPath = new Map<string, Map<number, TrustedClaimReference>>();
  for (const reference of references) {
    if (!knownPaths.has(reference.public_output_path)) {
      throw new Error(`[Claim] Reference ${reference.claim_id} targets unknown or empty public field "${reference.public_output_path}".`);
    }
    const slot = byPath.get(reference.public_output_path) || new Map<number, TrustedClaimReference>();
    if (slot.has(reference.statement_index)) {
      throw new Error(`[Claim] Duplicate reference for ${reference.public_output_path} statement ${reference.statement_index}.`);
    }
    slot.set(reference.statement_index, reference);
    byPath.set(reference.public_output_path, slot);
  }

  for (const field of fields) {
    const statements = segmentStatements(field.text);
    const slot = byPath.get(field.path) || new Map<number, TrustedClaimReference>();
    for (const index of slot.keys()) {
      if (index >= statements.length) {
        throw new Error(`[Claim] Reference on ${field.path} points at statement ${index} beyond the field's ${statements.length} statements.`);
      }
    }
    statements.forEach((statement, index) => {
      const reference = slot.get(index);
      if (!reference) {
        throw new Error(`[Claim] ${field.path} statement ${index} ("${statement}") is not covered by any claim reference.`);
      }
      if (normalizeStatement(reference.statement_text) !== normalizeStatement(statement)) {
        throw new Error(`[Claim] Reference on ${field.path} statement ${index} does not match the published statement.`);
      }
      revalidateReference(reference, statement, evidenceById);
    });
  }
}

function revalidateReference(reference: TrustedClaimReference, statementText: string, evidenceById: Map<string, Evidence>): void {
  const context = `${reference.public_output_path} statement ${reference.statement_index}`;

  if (reference.coverage_source === 'system_generated') {
    if (!SYSTEM_INJECTED_STATEMENTS.has(normalizeStatement(statementText))) {
      throw new Error(`[Claim] ${context} claims to be system-generated but is not an application-injected statement.`);
    }
    if (reference.support_mode !== 'unverified' || reference.fact_class !== 'unverified' || reference.attribution_required || reference.evidence_ids.length !== 0) {
      throw new Error(`[Claim] ${context} has a tampered system-generated reference.`);
    }
    return;
  }

  if (reference.support_mode === 'evidence_backed') {
    const derived = deriveEvidenceBacked(statementText, reference.evidence_ids, evidenceById, context);
    if (reference.fact_class !== derived.fact_class) {
      throw new Error(`[Claim] ${context} changes fact class: labelled ${reference.fact_class}, evidence implies ${derived.fact_class}.`);
    }
    if (reference.attribution_required !== derived.attribution_required) {
      throw new Error(`[Claim] ${context} misstates attribution_required.`);
    }
    return;
  }

  if (reference.support_mode === 'inference') {
    if (reference.evidence_ids.length === 0) throw new Error(`[Claim] ${context} is an inference but cites no grounding evidence.`);
    reference.evidence_ids.forEach(id => resolveEvidence(evidenceById, id, context));
    if (reference.fact_class !== 'inference' || reference.attribution_required) {
      throw new Error(`[Claim] ${context} has a tampered inference reference.`);
    }
    if (!INFERENCE_PATTERN.test(statementText)) {
      throw new Error(`[Claim] ${context} is an inference but uses no calibrated wording.`);
    }
    return;
  }

  // unverified
  reference.evidence_ids.forEach(id => resolveEvidence(evidenceById, id, context));
  if (reference.fact_class !== 'unverified' || reference.attribution_required) {
    throw new Error(`[Claim] ${context} has a tampered unverified reference.`);
  }
  if (!UNVERIFIED_PATTERN.test(statementText)) {
    throw new Error(`[Claim] ${context} is unverified but uses no absence wording.`);
  }
}
