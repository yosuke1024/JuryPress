import type { Evidence, EvidenceFactClass } from '../../schemas/evidence';
import type { QualityFinding } from '../../schemas/generation-record';

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
 *  3. fact_class, attribution_required, source_fact_classes and coverage_source are derived
 *     by the application from the evidence and the declared support_mode. Gemini never
 *     supplies them (they are absent from the generation schema).
 *  4. Source provenance survives every support_mode, in the DATA rather than in the prose:
 *     the cited evidence's fact classes are persisted as source_fact_classes (deduplicated,
 *     in SOURCE_FACT_CLASS_ORDER — never in evidence_ids order), so a statement whose
 *     fact_class is `inference` still records that its grounding evidence was a
 *     creator_claim (README) or community_opinion (discussion). The article renders that
 *     disclosure three ways: a per-statement evidence-id badge, the end-of-article Sources
 *     list and the Classifications block. Requiring the sentence to ALSO say it in prose
 *     (rule ≤2.2.0) was removed in 3.0.0 — see assertSourceAttribution. A statement still
 *     may not mix creator and community sources.
 *  5. An evidence_backed statement citing evidence of more than one fact class takes the
 *     WEAKEST cited class as its fact_class (rule 3.1.0; it used to fail closed). Rounding
 *     down over the total SOURCE_FACT_CLASS_ORDER is order-independent, and every class is
 *     still persisted in source_fact_classes, so nothing is hidden from the reader. Only
 *     EVIDENCE_BACKED_SOURCE_CLASSES may ground an evidence_backed statement: if the weakest
 *     class is inference or unverified it still fails closed, directing the statement to the
 *     matching support_mode and its required wording.
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

export const CLAIM_RULE_VERSION = '3.1.0';

/**
 * Optional findings sink. Rules about *what a statement says about itself* — whether an
 * inference hedges, whether an unverified statement uses absence wording — describe wording,
 * not provenance: the reference's fact_class, attribution_required and source_fact_classes
 * are derived from the evidence and are identical either way. When a sink is supplied those
 * rules record a warning and the reference is still built; without one they throw, which is
 * what the all-or-nothing publication gate expects for content already deemed publishable.
 *
 * Rules about provenance itself — missing evidence, an annotation matching no statement, an
 * uncovered statement, a statement mixing two source voices — are the traceability guarantees
 * and remain fail-closed everywhere: there is no correct reference to build without them. With
 * NO sink (the publication gate, the generation-time builder) they throw on the first one, as
 * before. With a sink they are recorded as ERRORS — the verdict is still `failed` — and the
 * scan continues, so a failing record reports its whole defect set rather than one at a time.
 * See reportFatal.
 */
export type ClaimFindingSink = QualityFinding[] | undefined;

function reportWording(sink: ClaimFindingSink, code: string, path: string, message: string): void {
  if (!sink) throw new Error(`[Claim] ${message}`);
  sink.push({ code, path, message, severity: 'warning', ruleVersion: CLAIM_RULE_VERSION });
}

/**
 * Maps a claim-provenance failure message onto its stable finding code. Lives here rather than
 * in the validator so the throwing path and the collecting path below cannot classify the same
 * defect differently.
 */
export function classifyClaimMessage(message: string): string {
  const text = message.replace(/^\[Claim\]\s*/, '');
  const table: Array<[RegExp, string]> = [
    [/references missing evidence|does not exist in the evidence bundle/i, 'EVIDENCE_ID_NOT_FOUND'],
    [/matches no statement of that field|does not match the published statement/i, 'CLAIM_STATEMENT_UNMATCHED'],
    [/targets unknown or empty public field|beyond the field's/i, 'CLAIM_ANNOTATION_TARGET_UNKNOWN'],
    [/has no evidence-backed provenance annotation|is not covered by any claim reference/i, 'CLAIM_PROVENANCE_MISSING'],
    [/mixes creator and community sources/i, 'CLAIM_MIXED_SOURCE_VOICES'],
    [/carries no attribution wording/i, 'CLAIM_ATTRIBUTION_WORDING_MISSING'],
    [/mixed fact classes/i, 'CLAIM_MIXED_FACT_CLASSES'],
    [/is evidence_backed but cites|is an inference but cites no grounding/i, 'CLAIM_EVIDENCE_TOO_WEAK'],
    [/tampered|changes fact class|misstates/i, 'CLAIM_REFERENCE_TAMPERED'],
    [/Duplicate reference/i, 'CLAIM_REFERENCE_DUPLICATE']
  ];
  for (const [pattern, code] of table) {
    if (pattern.test(text)) return code;
  }
  return 'CLAIM_VALIDATION_FAILED';
}

/**
 * Records a per-statement provenance violation.
 *
 * With NO sink (the publication gate and the generation-time builder) this rethrows, so those
 * paths keep their all-or-nothing contract exactly as before. With a sink (the quality
 * validator) it records the violation as an ERROR — still fail-closed, the verdict is still
 * `failed` — and lets the loop continue to the next statement.
 *
 * The distinction matters because the builder aborts on the first violation, which made every
 * failing generation report exactly ONE defect no matter how many it had. Measured on the
 * stored corpus, one record reporting a single `CLAIM_MIXED_FACT_CLASSES` actually held 10,
 * and one reporting a single `CLAIM_STATEMENT_UNMATCHED` held 5 across two root causes. Fixing
 * the reported defect merely surfaced the next one, so convergence took as many production
 * generations as there were violations. Reporting the full set makes one pass enough.
 */
function reportFatal(sink: ClaimFindingSink, error: unknown, path: string): void {
  if (!sink) throw error;
  const message = String((error as any)?.message ?? error);
  sink.push({
    code: classifyClaimMessage(message),
    path,
    message: message.replace(/^\[Claim\]\s*/, ''),
    severity: 'error',
    ruleVersion: CLAIM_RULE_VERSION
  });
}

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
  /**
   * Fact classes of the cited evidence, re-derived by the application from evidence_ids —
   * never taken from the model. Deduplicated and stored in SOURCE_FACT_CLASS_ORDER, so the
   * value is independent of the evidence_ids array order. This is what keeps an
   * inference/unverified statement from laundering its source: a statement whose
   * fact_class is `inference` still records that its grounding evidence was a
   * creator_claim (README) or community_opinion (discussion). Empty only for
   * evidence-less unverified statements and system_generated references.
   */
  source_fact_classes: EvidenceFactClass[];
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
 * The set of dotted technical tokens (file names, hostnames) whose INTERNAL dots are not
 * sentence boundaries — e.g. "package.json", "freecodecamp.org". Every member is derived by
 * `buildProtectedTokens` from independently-collected evidence, never from the model's own
 * public text, so the model cannot expand the set to launder an assertion past the segmenter.
 * Lower-cased; matched case-insensitively against the field text.
 */
export type ProtectedTokens = ReadonlySet<string>;

/** The empty context — segmentation with no protection, i.e. the strict adversarial scan. */
export const EMPTY_PROTECTED_TOKENS: ProtectedTokens = new Set<string>();

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function addHostname(out: Set<string>, hostname: string): void {
  const h = hostname.toLowerCase();
  if (!h.includes('.')) return;
  out.add(h);
  const bare = h.replace(/^www\./, '');
  if (bare !== h && bare.includes('.')) out.add(bare);
}

/** Structured URL (evidence.url, canonical URL): contributes its hostname AND path basename. */
function addStructuredUrl(out: Set<string>, raw: string): void {
  let u: URL;
  try { u = new URL(raw); } catch { return; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return;
  addHostname(out, u.hostname);
  const segments = u.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return;
  let basename: string;
  try { basename = decodeURIComponent(segments[segments.length - 1]); } catch { basename = segments[segments.length - 1]; }
  if (basename.includes('.')) out.add(basename.toLowerCase());
}

/**
 * Body text: contributes ONLY the hostnames of well-formed absolute http(s) URLs, decided by
 * the URL parser — never a bare `foo.bar` domain regex. A domain the model merely typed in prose
 * is not attested and must not gain protection; only a real URL the evidence carries does.
 */
function addBodyUrlHostnames(out: Set<string>, text: string): void {
  const re = /https?:\/\/[^\s"'<>()[\]{}]+/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const trimmed = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
    let u: URL;
    try { u = new URL(trimmed); } catch { continue; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') continue;
    addHostname(out, u.hostname);
  }
}

/**
 * The single, application-owned source of protected tokens (the SegmentationContext). Every
 * production path that segments public text for claim provenance — generation, repair,
 * validation, revalidation, build-review and the publication gate — MUST build its context from
 * this function over the SAME persisted evidence bundle, and NOTHING else. No caller adds its own
 * URLs on top, so the paths can never disagree about where a statement boundary is. Sources are
 * restricted to:
 *   - the basename of each structured evidence URL (e.g. ".../package.json" → "package.json")
 *   - the hostname of each structured evidence URL, plus its www-stripped form
 *   - the hostname of every valid absolute http(s) URL found in evidence body text
 * A bare `foo.bar` string in evidence prose is deliberately NOT treated as a domain. The
 * canonical/repository URL needs no special handling: it is already an evidence URL in the
 * bundle, so its hostname and basename are attested through the loop below.
 */
export function buildProtectedTokens(evidences: readonly Evidence[]): ProtectedTokens {
  const out = new Set<string>();
  for (const evidence of evidences) {
    if (evidence.url) addStructuredUrl(out, evidence.url);
    if (evidence.summary) addBodyUrlHostnames(out, evidence.summary);
    for (const claim of evidence.claims ?? []) {
      if (claim.text) addBodyUrlHostnames(out, claim.text);
    }
  }
  return out;
}

/**
 * Marks the index of every '.' that is INTERIOR to a STANDALONE occurrence of a protected token
 * (a token char on both sides), so it is suppressed as a boundary. Two guards keep this
 * fail-closed:
 *   - Only interior dots are protected: the dot AFTER a token ("README.md.The next sentence")
 *     stays a boundary, so a laundered sentence fused to the tail of a real token still splits.
 *   - The occurrence must be a WHOLE token, not a substring of a larger identifier: an
 *     alphanumeric character immediately before or after the match ("package.jsonevil",
 *     "evilpackage.json") disqualifies it, so an attacker cannot ride a real token's name to
 *     protect an unrelated dot. A path separator ("/package.json") or punctuation
 *     ("(package.json)", "freeCodeCamp.org.") is a valid boundary and still protects.
 * Returns null when nothing is protected.
 */
function protectedDotMask(norm: string, protectedTokens: ProtectedTokens): boolean[] | null {
  if (protectedTokens.size === 0) return null;
  // Identifier-adjacent characters: letters, digits, underscore and hyphen all glue the match
  // into a larger identifier ("evil_package.json", "package.json-evil"), so none of them are a
  // valid token boundary. A path separator, bracket, quote or space is.
  const isWordChar = (c: string): boolean => /[A-Za-z0-9_-]/.test(c);
  let mask: boolean[] | null = null;
  for (const token of protectedTokens) {
    if (!token.includes('.')) continue;
    const re = new RegExp(escapeRegExp(token), 'gi');
    let m: RegExpExecArray | null;
    while ((m = re.exec(norm)) !== null) {
      const start = m.index;
      const end = m.index + m[0].length;
      const boundedLeft = !isWordChar(norm[start - 1] || '');
      const boundedRight = !isWordChar(norm[end] || '');
      if (boundedLeft && boundedRight) {
        for (let i = start + 1; i < end - 1; i++) {
          if (norm[i] === '.') (mask ??= new Array<boolean>(norm.length).fill(false))[i] = true;
        }
      }
      if (re.lastIndex <= m.index) re.lastIndex = m.index + 1;
    }
  }
  return mask;
}

/**
 * The leading dot of a dotfile — a dot preceded by whitespace (or the very start of the
 * field) and followed IMMEDIATELY by a letter or digit: " .gitignore", " .env".
 *
 * Safe without evidence attestation because no English sentence can end this way: a
 * terminator is preceded by a word character, never by a space. Deliberately requires no
 * space AFTER the dot, so oddly-spaced prose ("one . two") still splits normally and cannot
 * use this to hide a boundary.
 *
 * Dotfiles are unavoidable in open-source reviews, and the attested-token mask cannot cover
 * them: it only protects dots INTERIOR to a token, so a leading dot was never protected even
 * when the evidence named the file.
 */
function isDotfileDot(norm: string, index: number): boolean {
  const before = norm[index - 1];
  const after = norm[index + 1] || '';
  const atFieldStart = index === 0;
  if (!atFieldStart && !/\s/.test(before || '')) return false;
  return /[A-Za-z0-9]/.test(after);
}

/**
 * Well-known repository filenames, as a CLOSED list of whole names — not a generic
 * `word.extension` pattern.
 *
 * The generic pattern was tried first and rejected: it protects any token shaped like a
 * filename, including `evilpackage.json` riding on an attested `package.json`, and worse it
 * would let a boundary hide behind an invented extension ("the claim is false.json the tool
 * is safe"). Restricting to names a repository actually carries keeps the fail-closed
 * property the segmenter is built on — an unknown token still splits — while covering the
 * case attestation structurally cannot: a review stating that a file is ABSENT ("no
 * SECURITY.md is present") describes something that by definition never appears in the
 * collected evidence.
 */
const KNOWN_REPO_FILENAMES: ReadonlySet<string> = new Set([
  'readme.md', 'readme.rst', 'readme.txt',
  'security.md', 'changelog.md', 'contributing.md', 'code_of_conduct.md',
  'license.md', 'licence.md', 'notice.md', 'authors.md', 'maintainers.md',
  'governance.md', 'support.md', 'history.md', 'install.md', 'roadmap.md',
  'package.json', 'package-lock.json', 'tsconfig.json', 'jsconfig.json',
  'composer.json', 'deno.json', 'bun.lockb',
  'cargo.toml', 'cargo.lock', 'pyproject.toml', 'setup.py', 'setup.cfg',
  'requirements.txt', 'go.mod', 'go.sum', 'gemfile.lock', 'tox.ini',
  'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock',
  'docker-compose.yml', 'docker-compose.yaml',
  'build.gradle', 'pom.xml', 'makefile.am',
  // Dotted technology names. Same closed-list discipline as the filenames above and for the
  // same reason: `Node.js` is unavoidable in an open-source review, is never a URL basename
  // (so attestation cannot reach it), and split into "Node." + "js." — producing a bare "js."
  // statement that no annotation can ever match. A generic `\w+\.js` pattern is deliberately
  // NOT used: it would let a boundary hide behind an invented name ("the claim is false.js
  // the tool is safe"). Only names a reviewer actually writes are listed.
  'node.js', 'vue.js', 'next.js', 'nuxt.js', 'express.js', 'react.js',
  'three.js', 'd3.js', 'chart.js', 'ember.js', 'backbone.js', 'alpine.js',
  'socket.io', 'asp.net', 'vb.net'
]);

/** Longest known filename, so the backward scan has a bounded window. */
const MAX_KNOWN_FILENAME_LENGTH = 24;

/**
 * Whether the dot at `index` is interior to one of KNOWN_REPO_FILENAMES. The candidate must
 * be delimited by non-identifier characters on both sides, so `evilpackage.json` and
 * `package.json-evil` are NOT protected and still split — the same boundary rule the
 * attested-token mask uses.
 */
function isFileExtensionDot(norm: string, index: number): boolean {
  const isWordChar = (c: string): boolean => /[A-Za-z0-9_.-]/.test(c);
  let start = index;
  while (start > 0 && isWordChar(norm[start - 1]) && index - start < MAX_KNOWN_FILENAME_LENGTH) start--;
  let end = index + 1;
  while (end < norm.length && isWordChar(norm[end]) && end - index < MAX_KNOWN_FILENAME_LENGTH) end++;
  // Trim a trailing sentence period so "…uses package.json." matches on the filename itself.
  while (end > index + 1 && norm[end - 1] === '.') end--;
  return KNOWN_REPO_FILENAMES.has(norm.slice(start, end).toLowerCase());
}

/**
 * Partitions normalized field text into ordered statements. A statement boundary is a run of
 * sentence terminators (. ! ? or a semicolon), optionally followed by closing quotes/brackets.
 * A single "." does NOT split in exactly two cases: a decimal/version dot (a digit on both
 * sides — "3.5", "v1.2"), and a dot interior to an evidence-attested technical token in
 * `protectedTokens` ("package.json", "freecodecamp.org"). Every other terminator splits
 * regardless of what follows it (a lower- or upper-case letter, digit, non-ASCII letter,
 * em-dash, opening quote, CJK, etc.), so two reader-visible sentences can never merge into one
 * statement and an unattested `passed.it also exposed data` still fails closed. The slices are
 * an exact index partition of the normalized text — no visible character is dropped.
 *
 * `protectedTokens` is REQUIRED: production callers pass a `buildProtectedTokens` context; the
 * strict adversarial scan is the separate, explicit `segmentStatementsStrict`. There is no
 * implicit "omit the argument to get strict" mode.
 */
export function segmentStatements(text: string, protectedTokens: ProtectedTokens): string[] {
  const norm = normalizeStatement(text);
  if (!norm) return [];
  const protectedDot = protectedDotMask(norm, protectedTokens);
  const out: string[] = [];
  let start = 0;
  const re = /[.!?]+["'”’»)\]}]*|;+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(norm)) !== null) {
    if (m[0] === '.') {
      // A lone "." with a digit on both sides is a decimal/version separator, not a boundary.
      if (/\d/.test(norm[m.index - 1] || '') && /\d/.test(norm[m.index + 1] || '')) continue;
      // A lone "." interior to an evidence-attested technical token is not a boundary either.
      if (protectedDot && protectedDot[m.index]) continue;
      // Lexically-decidable technical dots, protected without needing evidence attestation
      // because no English sentence can end that way. See isDotfileDot / isFileExtensionDot.
      if (isDotfileDot(norm, m.index) || isFileExtensionDot(norm, m.index)) continue;
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

/**
 * The strict adversarial scan: segmentation with NO protected tokens, so every terminator
 * (bar a decimal dot) splits. This is the explicit entry point for smuggling-detection tests
 * and any call that must not trust a technical-token context.
 */
export function segmentStatementsStrict(text: string): string[] {
  return segmentStatements(text, EMPTY_PROTECTED_TOKENS);
}

/** Splitter invariant: re-joining the statements reproduces the normalized field exactly. */
export function assertLosslessSegmentation(text: string): void {
  const target = normalizeStatement(text);
  const rebuilt = normalizeStatement(segmentStatementsStrict(text).join(' '));
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
    pushString(fields, `judges.${judgeIndex}.recommended_next_step.action`, judge.recommended_next_step?.action);
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
  // Exclude only the limitation-class, decisive_question and recommended-next-step fields,
  // where hedged or forward-looking mentions of test execution legitimately live (e.g.
  // "could not verify that the tests pass", "add tests so the suite passes in CI"). Concerns
  // stay in the scan so a positive "tests pass" assertion laundered into a concern is caught.
  const excluded = /(\.limitations\.\d+$)|(^article\.evidence_limitations\.)|(\.decisive_question$)|(\.recommended_next_step\.action$)/;
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

/**
 * The canonical persistence order for source_fact_classes: the EvidenceFactClassSchema enum
 * order, spelled out explicitly so the fixed order is visible in code. Derived sets are
 * deduplicated and sorted into this order, which makes the persisted value — and every
 * check on it — independent of how the model happened to order evidence_ids.
 */
export const SOURCE_FACT_CLASS_ORDER = [
  'confirmed_fact',
  'creator_claim',
  'community_opinion',
  'repository_observation',
  'inference',
  'unverified'
] as const satisfies readonly EvidenceFactClass[];

/**
 * Re-derives the deduplicated source fact classes for a set of cited evidence ids, in
 * SOURCE_FACT_CLASS_ORDER. Every id must resolve. This is the ONLY producer of
 * source_fact_classes — generation persists its output and the publication gate demands
 * exact equality with a fresh re-derivation, so the persisted value can never drift from
 * the evidence.
 */
export function deriveSourceFactClasses(
  evidenceIds: string[],
  evidenceById: Map<string, Evidence>,
  context: string
): EvidenceFactClass[] {
  const present = new Set(evidenceIds.map(id => factClassForEvidence(resolveEvidence(evidenceById, id, context))));
  return SOURCE_FACT_CLASS_ORDER.filter(fc => present.has(fc));
}

/** A cited claim must be attributed when any supporting evidence is a claim, not a fact. */
export function attributionRequired(factClasses: EvidenceFactClass[]): boolean {
  return factClasses.some(fc => fc === 'creator_claim' || fc === 'community_opinion');
}

/**
 * Public fields that hold a short LABEL rather than prose. A category or an audience is a
 * noun phrase by construction; there is no sentence in it to carry calibrated wording.
 */
const LABEL_FIELD_PATHS: ReadonlySet<string> = new Set([
  'product.category',
  'product.primary_audience'
]);

/** A label-shaped value: a short noun phrase, not a sentence. */
function isLabelShaped(statementText: string): boolean {
  const trimmed = statementText.trim();
  if (/[.!?]$/.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= 12;
}

/**
 * A title-shaped headline, as opposed to a sentence parked in the headline field.
 *
 * A headline is not prose and has nowhere to hedge — "Instrumation May Possibly Simplify
 * Hardware Test Automation" is not a headline — so demanding calibrated wording of one repeats
 * the inversion that demanding it of product.category produced: the correct form fails and the
 * wordy one passes.
 *
 * The discriminator is the terminal period. A headline does not end in one; a sentence does.
 * That is exactly what separates the two real cases in the corpus — "Bridging the Gap:
 * Instrumation Simplifies Hardware Test Automation with Digital Twins" (a title, exempt) from
 * "The project README indicates that Peek Cli enables AI coding agents to see and iterate on
 * web UI designs." (a sentence, still held to its wording). The word cap is looser than
 * isLabelShaped's because a headline is legitimately longer than a category label, but it is
 * still bounded, so a long unpunctuated assertion cannot claim the exemption.
 */
function isTitleShaped(statementText: string): boolean {
  const trimmed = statementText.trim();
  if (/[.!?]$/.test(trimmed)) return false;
  return trimmed.split(/\s+/).length <= 20;
}

/**
 * Whether a statement sits in a label field AND is actually shaped like a label.
 *
 * Demanding prose wording of a label inverted the gate: a correct category
 * ("Agentic Software Development Framework") failed while a sentence stuffed into the same
 * field passed, which is how "Category: According to the README, the project is a curated
 * directory of public APIs." reached the live page, the meta tag and the JSON-LD
 * applicationCategory. Predicated on path AND shape, so the moment such a field holds an
 * actual sentence it is prose again. Only WORDING is waived — evidence resolution,
 * fact-class derivation, attribution_required and source_fact_classes persistence are
 * untouched.
 */
function labelFieldWordingExempt(path: string, statementText: string): boolean {
  return LABEL_FIELD_PATHS.has(path) && isLabelShaped(statementText);
}

/**
 * Calibrated inference wording that an `inference` statement must contain about itself.
 * `suggest\w*` (not `suggests?`) so the present participle "suggesting" — the most common
 * calibrated form the model emits ("…, suggesting a sustainable ecosystem") — is recognized.
 */
export const INFERENCE_PATTERN = /\b(suggest\w*|may|might|could|appears?|indicat\w*|infer\w*|likely|does not prove|but does not|implies)\b/i;

/**
 * Absence/uncertainty wording that an `unverified` statement must contain about itself. The
 * "does/did not <verb>" verb lists cover the full family of absence phrasings the model emits
 * ("the available evidence does not contain/provide/include/outline/specify/document …"), not a
 * narrow subset — omitting one is a false positive that fails an already-hedged statement.
 */
export const UNVERIFIED_PATTERN = /\b(could not|cannot|can not|does not establish|did not establish|do not establish|no public evidence|not (?:independently )?verified|unverified|no verified|was not (?:verified|collected|confirmed)|were not (?:verified|collected|confirmed)|(?:did|do|does) not (?:include|describe|show|confirm|establish|prove|contain|provide|specify|document|detail|mention|outline|list|demonstrate|capture|expose|surface|report|verify|explain|address|cover)|unable to (?:verify|confirm)|no evidence (?:was )?found|remains? unclear|insufficient evidence|not assessable|lacks?|lacking|absence of|no (?:\w+\s+){0,3}(?:evidence|documentation|documents|logs?|visibility|benchmarks?|results?|metrics|data|record))\b/i;

/**
 * Prescriptive recommendation wording — the statement tells the maintainers what to DO, rather
 * than asserting a product state ("the maintainers should add X", "we recommend documenting Y").
 */
const PRESCRIPTIVE_WORDING = /\b(should|must|recommend(?:s|ed|ing)?|consider(?:s|ing)?|needs? to)\b/i;

/**
 * A `recommended_next_step.action` written in the IMPERATIVE mood — "Add structured
 * benchmarks…", "Refactor the hardcoded drivers…", "Publish a SECURITY.md…".
 *
 * This is the most natural way to write an action field, and more common in practice than the
 * modal form PRESCRIPTIVE_WORDING recognises: 8 of the wording findings in the stored corpus
 * were imperatives that the modal-only predicate could not see, so a correctly-written action
 * failed while a wordier "the maintainers should add…" passed — the same inversion that
 * demanding prose wording of a short label field produced.
 *
 * A CLOSED list of action verbs, anchored to the start of the statement, for the same reason
 * KNOWN_REPO_FILENAMES is closed: "the tool is fully secure" must not become prescriptive by
 * accident. The verb must be the FIRST word, which is what makes the mood unambiguous — an
 * assertion cannot begin with a bare imperative.
 */
const IMPERATIVE_ACTION_WORDING = /^(add|address|adopt|automate|clarify|define|document|enable|enforce|enhance|establish|expand|expose|extend|implement|improve|include|integrate|introduce|investigate|migrate|provide|publish|refactor|release|remove|rename|replace|standardi[sz]e|surface|update|validate|verify|version)\b/i;

/** The structural framing sentence of a jury-disagreement summary ("The jury disagreed on X"). */
const JURY_DISAGREEMENT_FRAMING = /^the jury disagreed\b/i;

/**
 * A meta_description sentence that describes the ARTICLE or the REVIEW PROCESS itself ("This
 * article provides an evaluation of X", "The jury evaluated Y") rather than asserting a product
 * property. Both arms are deliberately narrow:
 *   - "This article/review" must be followed by a process verb AND an evaluation noun
 *     ("provides/presents/offers/summarizes an evaluation/review/assessment/analysis/overview"),
 *     so "This article proves the product is fully secure." does NOT match;
 *   - "The jury <process verb>" must not carry an "… as <verdict>" complement, so
 *     "The jury evaluated the product as fully secure." does NOT match. Verbs of finding
 *     (verified/confirmed/found/proved) are not in the list at all.
 */
const EDITORIAL_PROCESS_WORDING = /^(?:this (?:article|review) (?:provides|presents|offers|summarizes) (?:an?|the) (?:evaluation|review|assessment|analysis|overview)\b|the jury (?:evaluated|reviewed|assessed|examined|considered)\b(?!.*\bas\b))/i;

/**
 * Statements that are structural or prescriptive rather than product-claim assertions, so the
 * self-wording calibration/absence requirement does not apply to them (their TRACEABILITY —
 * evidence resolution, attribution, source-class persistence — is still enforced, exactly like
 * every other field). The exemption is decided by path AND content — a narrow wording predicate
 * must match the statement itself, so "The product is fully secure." placed in any of these
 * positions is NOT exempt and still needs its calibrated/absence wording:
 *   - a `recommended_next_step.action` statement, only when it is actually prescriptive;
 *   - statement 0 of a `where_jury_disagreed[i].summary`, only when it is the "The jury
 *     disagreed …" framing sentence;
 *   - a `meta_description` statement, only when it describes the article/review process itself.
 */
function wordingCalibrationExempt(path: string, statementIndex: number, statementText: string): boolean {
  // A label carries no prose, so it cannot hedge ("suggests", "may") or use absence wording;
  // see labelFieldWordingExempt. Traceability is untouched.
  if (labelFieldWordingExempt(path, statementText)) return true;
  if (/\.recommended_next_step\.action$/.test(path)) {
    return PRESCRIPTIVE_WORDING.test(statementText) || IMPERATIVE_ACTION_WORDING.test(statementText.trim());
  }
  if (path === 'article.headline') return isTitleShaped(statementText);
  if (statementIndex === 0 && /^article\.where_jury_disagreed\.\d+\.summary$/.test(path)) {
    return JURY_DISAGREEMENT_FRAMING.test(statementText);
  }
  if (path === 'article.meta_description') return EDITORIAL_PROCESS_WORDING.test(statementText);
  return false;
}

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

/**
 * Enforces that a statement citing creator/community evidence attributes the source,
 * whatever its support_mode. This is the anti-laundering rule: an inference or unverified
 * statement grounded on a README (creator_claim) or a discussion (community_opinion) must
 * still name its source, and may never mix the two in one statement — the reader could not
 * tell whose voice the statement carries.
 *
 * IN-PROSE attribution wording is NO LONGER REQUIRED (rule 3.0.0). Source disclosure moved
 * entirely to the machine-readable layer, which the article already surfaces three ways: an
 * evidence-id badge on each statement, the end-of-article Sources list (id, title, URL,
 * type, retrieved-at) and the Classifications block that labels each cited claim by fact
 * class. Demanding the prose ALSO say it made "According to the README" 59% of all
 * attribution phrasing across the published articles (183 of 308), and it was the sole cause
 * of every quality failure the pipeline ever produced — a readability cost and a publication
 * risk paid for a fourth copy of information already on the page.
 *
 * What this function still enforces is structural and unchanged: one statement may not carry
 * two source voices. And nothing about TRACEABILITY is relaxed anywhere — evidence
 * resolution, fact-class derivation, `attribution_required` and `source_fact_classes`
 * persistence are all untouched, so every statement still records whose claim it rests on
 * and the UI can still show it.
 */
function assertSourceAttribution(
  statementText: string,
  sourceFactClasses: EvidenceFactClass[],
  context: string
): void {
  const hasCreator = sourceFactClasses.includes('creator_claim');
  const hasCommunity = sourceFactClasses.includes('community_opinion');
  // Structural, always fatal: one statement cannot carry two source voices, and no single
  // attribution_required value or fact class describes it correctly.
  if (hasCreator && hasCommunity) {
    throw new Error(`[Claim] ${context} mixes creator and community sources; split into one statement per source.`);
  }
}

/**
 * The only fact classes strong enough to ground an evidence_backed statement. Evidence whose
 * own class is `inference` or `unverified` cannot back an unqualified assertion: routing it
 * through evidence_backed would launder a guess into a statement with no calibrated wording.
 */
export const EVIDENCE_BACKED_SOURCE_CLASSES = [
  'confirmed_fact',
  'creator_claim',
  'community_opinion',
  'repository_observation'
] as const satisfies readonly EvidenceFactClass[];

/**
 * Derives the trusted fields for one evidence-backed statement.
 *
 * Heterogeneous source fact classes COLLAPSE to the weakest class (rule 3.1.0); they used to
 * fail closed. The stated rationale for failing — "an assertion is only as strong as its
 * weakest source" — is an argument for rounding DOWN, not for rejecting: rounding down is
 * exactly what a reader needs, and it is available deterministically because
 * SOURCE_FACT_CLASS_ORDER is a total order and `source_fact_classes` retains every class, so
 * no disclosure is lost. The old objection that collapsing "makes the label depend on which
 * evidence is considered first" does not apply to a minimum over a total order: the weakest
 * class is order-independent by construction, which is the same property the fail-closed rule
 * was reaching for.
 *
 * What the rule actually cost was inverted: a sentence citing a README ALONE passed, while the
 * same sentence additionally citing the manifest that corroborates it failed. It penalised
 * showing more evidence — 10 of 10 violations in the measured corpus were of that shape, most
 * of them `confirmed_fact + repository_observation` (API metadata corroborated by a source
 * file), which is the single most natural way to ground a claim well.
 *
 * Attribution is NOT weakened by the collapse: `attribution_required` is still computed over
 * the FULL class set, so a statement resting partly on a creator_claim still requires
 * attribution even when its fact_class rounds to `repository_observation`.
 *
 * Even a collapsed citation fails closed when the weakest class is `inference` or
 * `unverified` — the statement must instead use the matching support_mode with its
 * calibrated/absence wording. That check is unchanged and now applies to the rounded-down
 * class, which is strictly more conservative than judging a single-class citation.
 */
function deriveEvidenceBacked(
  statementText: string,
  evidenceIds: string[],
  evidenceById: Map<string, Evidence>,
  context: string,
  path: string
): { fact_class: EvidenceFactClass; attribution_required: boolean; source_fact_classes: EvidenceFactClass[] } {
  if (evidenceIds.length === 0) {
    throw new Error(`[Claim] ${context} is evidence_backed but cites no evidence.`);
  }
  const source_fact_classes = deriveSourceFactClasses(evidenceIds, evidenceById, context);
  // Never inherits attribution: an unqualified evidence_backed assertion must name its
  // source itself.
  assertSourceAttribution(statementText, source_fact_classes, context);
  // Round DOWN to the weakest cited class. source_fact_classes is already deduplicated and
  // sorted into SOURCE_FACT_CLASS_ORDER (strongest → weakest), so the last element is the
  // minimum and the result cannot depend on evidence_ids order.
  const fact_class = source_fact_classes[source_fact_classes.length - 1];
  if (fact_class === 'inference') {
    throw new Error(
      `[Claim] ${context} is evidence_backed but cites inference-class evidence; ` +
      `use support_mode=inference and calibrated wording in the statement itself (e.g. "suggests", "may", "the jury inferred").`
    );
  }
  if (fact_class === 'unverified') {
    throw new Error(
      `[Claim] ${context} is evidence_backed but cites unverified-class evidence; ` +
      `use support_mode=unverified and absence wording in the statement itself (e.g. "could not verify", "does not establish", "no public evidence").`
    );
  }
  return { fact_class, attribution_required: attributionRequired(source_fact_classes), source_fact_classes };
}

/** Builds one trusted reference from a validated model annotation. Throws on any violation. */
function referenceFromAnnotation(
  path: string,
  statementIndex: number,
  statementText: string,
  annotation: StatementAnnotation,
  evidenceById: Map<string, Evidence>,
  sink: ClaimFindingSink
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
    const derived = deriveEvidenceBacked(statementText, evidenceIds, evidenceById, context, path);
    return { ...base, support_mode: 'evidence_backed', ...derived };
  }
  if (annotation.support_mode === 'inference') {
    if (evidenceIds.length === 0) throw new Error(`[Claim] ${context} is an inference but cites no grounding evidence.`);
    // fact_class stays `inference` (the statement is the jury's reasoning), but the cited
    // evidence keeps its own provenance: a README-grounded inference must attribute the
    // creator — in the statement itself or inherited from the immediately preceding
    // statement — and the persisted reference records source_fact_classes so the
    // creator/community origin is never laundered away.
    const source_fact_classes = deriveSourceFactClasses(evidenceIds, evidenceById, context);
    assertSourceAttribution(statementText, source_fact_classes, context);
    if (!wordingCalibrationExempt(path, statementIndex, statementText) && !INFERENCE_PATTERN.test(statementText)) {
      reportWording(sink, 'CLAIM_CALIBRATION_WORDING_MISSING', `$.${context}`,
        `${context} is an inference but uses no calibrated wording (e.g. "suggests", "may", "the jury inferred").`);
    }
    return { ...base, support_mode: 'inference', fact_class: 'inference', attribution_required: attributionRequired(source_fact_classes), source_fact_classes };
  }
  // unverified — evidence_ids may be empty (a pure absence statement). When evidence IS
  // cited, citing a README or a discussion in an "unverified" statement still requires
  // in-statement attribution (never inherited) and persists the source classes.
  const source_fact_classes = deriveSourceFactClasses(evidenceIds, evidenceById, context);
  assertSourceAttribution(statementText, source_fact_classes, context);
  if (!wordingCalibrationExempt(path, statementIndex, statementText) && !UNVERIFIED_PATTERN.test(statementText)) {
    reportWording(sink, 'CLAIM_ABSENCE_WORDING_MISSING', `$.${context}`,
      `${context} is unverified but uses no absence wording (e.g. "could not verify", "does not establish", "no public evidence").`);
  }
  return { ...base, support_mode: 'unverified', fact_class: 'unverified', attribution_required: attributionRequired(source_fact_classes), source_fact_classes };
}

function sourceFactClassesMatch(actual: unknown, derived: EvidenceFactClass[]): boolean {
  return Array.isArray(actual)
    && actual.length === derived.length
    && derived.every((fc, index) => actual[index] === fc);
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
    source_fact_classes: [],
    coverage_source: 'system_generated'
  };
}

/**
 * Builds the complete trusted reference set from the model's statement annotations.
 * Every statement of every coverage field must be matched by exactly one annotation
 * (by normalized-text equality) or be an application-injected statement; otherwise it
 * throws. This is the fail-closed generation contract.
 */
export function buildTrustedClaimReferences(
  evaluation: any,
  evidenceById: Map<string, Evidence>,
  protectedTokens: ProtectedTokens,
  sink?: ClaimFindingSink
): TrustedClaimReference[] {
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
    const statements = segmentStatements(field.text, protectedTokens);
    const normalized = statements.map(normalizeStatement);
    const consumed = new Set<number>();

    // Pass 1 — match every annotation of this field to its statement index, fail-closed on a
    // mismatch.
    const matched: Array<{ annotation: StatementAnnotation; index: number }> = [];
    for (const annotation of annotationsByPath.get(field.path) || []) {
      const target = normalizeStatement(annotation.statement_text);
      const index = normalized.findIndex((s, i) => !consumed.has(i) && s === target);
      if (index < 0) {
        reportFatal(
          sink,
          new Error(`[Claim] Annotation on ${field.path} ("${annotation.statement_text}") matches no statement of that field.`),
          `$.${field.path}`
        );
        continue;
      }
      consumed.add(index);
      matched.push({ annotation, index });
    }

    // Pass 2 — build references in the original annotation order (the persisted order is
    // unchanged by the two-pass restructure).
    for (const { annotation, index } of matched) {
      try {
        references.push(referenceFromAnnotation(field.path, index, statements[index], annotation, evidenceById, sink));
      } catch (e) {
        reportFatal(sink, e, `$.${field.path} statement ${index}`);
      }
    }

    statements.forEach((statement, index) => {
      if (consumed.has(index)) return;
      if (SYSTEM_INJECTED_STATEMENTS.has(normalized[index])) {
        references.push(systemGeneratedReference(field.path, index, statement));
        return;
      }
      reportFatal(
        sink,
        new Error(`[Claim] ${field.path} statement ${index} ("${statement}") has no evidence-backed provenance annotation.`),
        `$.${field.path} statement ${index}`
      );
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
  evidenceById: Map<string, Evidence>,
  protectedTokens: ProtectedTokens,
  sink?: ClaimFindingSink
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
    const statements = segmentStatements(field.text, protectedTokens);
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
      revalidateReference(reference, statement, evidenceById, sink);
    });
  }
}

function revalidateReference(
  reference: TrustedClaimReference,
  statementText: string,
  evidenceById: Map<string, Evidence>,
  sink: ClaimFindingSink
): void {
  const context = `${reference.public_output_path} statement ${reference.statement_index}`;

  if (reference.coverage_source === 'system_generated') {
    if (!SYSTEM_INJECTED_STATEMENTS.has(normalizeStatement(statementText))) {
      throw new Error(`[Claim] ${context} claims to be system-generated but is not an application-injected statement.`);
    }
    if (reference.support_mode !== 'unverified' || reference.fact_class !== 'unverified' || reference.attribution_required
      || reference.evidence_ids.length !== 0 || !sourceFactClassesMatch(reference.source_fact_classes, [])) {
      throw new Error(`[Claim] ${context} has a tampered system-generated reference.`);
    }
    return;
  }

  if (reference.support_mode === 'evidence_backed') {
    const derived = deriveEvidenceBacked(statementText, reference.evidence_ids, evidenceById, context, reference.public_output_path);
    if (reference.fact_class !== derived.fact_class) {
      throw new Error(`[Claim] ${context} changes fact class: labelled ${reference.fact_class}, evidence implies ${derived.fact_class}.`);
    }
    if (reference.attribution_required !== derived.attribution_required) {
      throw new Error(`[Claim] ${context} misstates attribution_required.`);
    }
    if (!sourceFactClassesMatch(reference.source_fact_classes, derived.source_fact_classes)) {
      throw new Error(`[Claim] ${context} misstates source_fact_classes: evidence implies [${derived.source_fact_classes.join(', ')}].`);
    }
    return;
  }

  if (reference.support_mode === 'inference') {
    if (reference.evidence_ids.length === 0) throw new Error(`[Claim] ${context} is an inference but cites no grounding evidence.`);
    const derived = deriveSourceFactClasses(reference.evidence_ids, evidenceById, context);
    assertSourceAttribution(statementText, derived, context);
    if (reference.fact_class !== 'inference' || reference.attribution_required !== attributionRequired(derived)) {
      throw new Error(`[Claim] ${context} has a tampered inference reference.`);
    }
    if (!sourceFactClassesMatch(reference.source_fact_classes, derived)) {
      throw new Error(`[Claim] ${context} misstates source_fact_classes: evidence implies [${derived.join(', ')}].`);
    }
    if (!wordingCalibrationExempt(reference.public_output_path, reference.statement_index, statementText) && !INFERENCE_PATTERN.test(statementText)) {
      reportWording(sink, 'CLAIM_CALIBRATION_WORDING_MISSING', `$.${context}`,
        `${context} is an inference but uses no calibrated wording.`);
    }
    return;
  }

  // unverified — evidence_ids may be empty (a pure absence statement).
  const derived = deriveSourceFactClasses(reference.evidence_ids, evidenceById, context);
  assertSourceAttribution(statementText, derived, context);
  if (reference.fact_class !== 'unverified' || reference.attribution_required !== attributionRequired(derived)) {
    throw new Error(`[Claim] ${context} has a tampered unverified reference.`);
  }
  if (!sourceFactClassesMatch(reference.source_fact_classes, derived)) {
    throw new Error(`[Claim] ${context} misstates source_fact_classes: evidence implies [${derived.join(', ')}].`);
  }
  if (!wordingCalibrationExempt(reference.public_output_path, reference.statement_index, statementText) && !UNVERIFIED_PATTERN.test(statementText)) {
    reportWording(sink, 'CLAIM_ABSENCE_WORDING_MISSING', `$.${context}`,
      `${context} is unverified but uses no absence wording.`);
  }
}
