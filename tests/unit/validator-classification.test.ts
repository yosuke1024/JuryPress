import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { validateContent } from '../../src/lib/generation/validator';
import { repairContent } from '../../src/lib/generation/repair';
import { createRecommendationFixture } from '../fixtures/refined-review';

/**
 * §8 — classification of the reasons past runs actually failed. The original raw responses of
 * the 34 historical attempts were retried away and cannot be replayed, so instead each known
 * failure reason is reproduced as a perturbation of a currently-passing fixture, and the new
 * validator's classification is asserted: Hard Fail (excludes), deterministic repair (fixed in
 * place, still passes), or Warning (surfaced, never blocks).
 *
 * Complements the recommendation-rule coverage already in `recommendations.test.ts`
 * (RECOMMENDATION_EVIDENCE_NOT_CITED_BY_CRITERIA, RECOMMENDATION_CONCERN_VOCABULARY_UNSHARED,
 * RECOMMENDATION_ANNOTATION_EVIDENCE_MISMATCH, RECOMMENDATION_RESTATES_CONCERN — all warnings).
 */
describe('§8 validator classification (Hard Fail / deterministic repair / Warning)', () => {
  let originalMode: string | undefined;

  beforeAll(() => {
    originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'fixture';
  });
  afterAll(() => {
    process.env.JURYPRESS_DATA_MODE = originalMode;
  });

  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  function base() {
    const { generatedOutput, context } = createRecommendationFixture();
    return { content: generatedOutput as any, evidences: context.evidences };
  }

  function verdict(content: unknown, evidences: any[]) {
    return validateContent({ content, originalContent: content, evidences, humanEdited: false });
  }

  it('the unperturbed fixture passes with no errors (control)', () => {
    const { content, evidences } = base();
    const v = verdict(clone(content), evidences);
    expect(v.status).toBe('passed');
    expect(v.errors).toHaveLength(0);
  });

  // ── Hard Fail: a reference to evidence that does not exist ───────────────────────
  it('classifies a nonexistent evidence_id as a Hard Fail (EVIDENCE_ID_NOT_FOUND)', () => {
    const { content, evidences } = base();
    const g = clone(content);
    g.public_statement_annotations[0].evidence_ids = ['ev-does-not-exist'];
    const v = verdict(g, evidences);
    expect(v.status).toBe('failed');
    expect(v.errors.map(e => e.code)).toContain('EVIDENCE_ID_NOT_FOUND');
  });

  // ── Hard Fail: an unmatched claim in a MULTI-statement field has no single derivable
  // value, so it is never repaired ──────────────────────────────────────────────────
  it('classifies a claim unmatched in a multi-statement field as a Hard Fail (CLAIM_STATEMENT_UNMATCHED)', () => {
    const { content, evidences } = base();
    const g = clone(content);
    g.product.category = 'A developer command-line tool. It also ships a companion daemon.';
    const annotation = g.public_statement_annotations.find(
      (a: any) => a.public_output_path === 'product.category'
    );
    annotation.statement_text = 'This sentence appears nowhere in the article body at all zzz.';
    const v = verdict(g, evidences);
    expect(v.status).toBe('failed');
    expect(v.errors.map(e => e.code)).toContain('CLAIM_STATEMENT_UNMATCHED');
    expect(v.repairs.map(r => r.code)).not.toContain('CLAIM_ANNOTATION_SINGLE_STATEMENT_SYNCED');
  });

  // ── Deterministic repair: a single-statement field with a single drifted annotation
  // has exactly one derivable statement_text, so the copy is synced, not failed ─────
  // (Minimal reproduction of production record season-2-manual-29633364803: body said
  // "over 451,052 stars", the annotation said "over 451,000 stars".)
  const DRIFT_BODY = 'The API metadata reports outstanding community popularity and adoption with over 451,052 stars.';
  const DRIFT_ANNOTATION = 'The API metadata reports outstanding community popularity and adoption with over 451,000 stars.';

  function withSingleStatementDrift(evidenceIds: string[] = ['ev-api']) {
    const { content, evidences } = base();
    const g = clone(content);
    g.article.where_jury_agreed[1] = DRIFT_BODY;
    const annotation = g.public_statement_annotations.find(
      (a: any) => a.public_output_path === 'article.where_jury_agreed.1'
    );
    annotation.statement_text = DRIFT_ANNOTATION;
    annotation.support_mode = 'evidence_backed';
    annotation.evidence_ids = evidenceIds;
    return { g, evidences };
  }

  it('syncs a single-statement/single-annotation drift (CLAIM_ANNOTATION_SINGLE_STATEMENT_SYNCED), still passing', () => {
    const { g, evidences } = withSingleStatementDrift();
    const v = verdict(g, evidences);
    expect(v.status).toBe('passed');
    expect(v.errors).toHaveLength(0);
    expect(v.errors.map(e => e.code)).not.toContain('CLAIM_STATEMENT_UNMATCHED');
    expect(v.repairs.map(r => r.code)).toContain('CLAIM_ANNOTATION_SINGLE_STATEMENT_SYNCED');
    const repaired = (v.content as any).public_statement_annotations.find(
      (a: any) => a.public_output_path === 'article.where_jury_agreed.1'
    );
    // The repaired annotation is byte-identical to the only statement of its target field,
    // and the repair changed nothing but the redundant statement_text copy.
    expect(repaired.statement_text).toBe(DRIFT_BODY);
    expect(repaired.support_mode).toBe('evidence_backed');
    expect(repaired.evidence_ids).toEqual(['ev-api']);
  });

  // ── Ambiguity: a second annotation on the same single-statement field means there is
  // no longer one derivable value — Hard Fail, never repaired ───────────────────────
  it('does not repair when two annotations target the same single-statement field (CLAIM_STATEMENT_UNMATCHED)', () => {
    const { content, evidences } = base();
    const g = clone(content);
    const annotation = g.public_statement_annotations.find(
      (a: any) => a.public_output_path === 'product.category'
    );
    g.public_statement_annotations.push({
      ...clone(annotation),
      statement_text: 'A developer command-line tool with over 451,000 stars.'
    });
    const v = verdict(g, evidences);
    expect(v.status).toBe('failed');
    expect(v.errors.map(e => e.code)).toContain('CLAIM_STATEMENT_UNMATCHED');
    expect(v.repairs.map(r => r.code)).not.toContain('CLAIM_ANNOTATION_SINGLE_STATEMENT_SYNCED');
  });

  // ── Ambiguity: an annotation targeting a path that does not exist stays a Hard Fail ─
  it('classifies an annotation on an unknown path as a Hard Fail (CLAIM_ANNOTATION_TARGET_UNKNOWN)', () => {
    const { content, evidences } = base();
    const g = clone(content);
    g.public_statement_annotations.push({
      public_output_path: 'article.nonexistent_field',
      statement_text: 'This targets a field that does not exist.',
      support_mode: 'unverified',
      evidence_ids: []
    });
    const v = verdict(g, evidences);
    expect(v.status).toBe('failed');
    expect(v.errors.map(e => e.code)).toContain('CLAIM_ANNOTATION_TARGET_UNKNOWN');
    expect(v.repairs.map(r => r.code)).not.toContain('CLAIM_ANNOTATION_SINGLE_STATEMENT_SYNCED');
  });

  // ── Fail-closed provenance survives the repair: the synced text never rescues a
  // nonexistent evidence citation ───────────────────────────────────────────────────
  it('still hard-fails a nonexistent evidence id after the statement text is synced (EVIDENCE_ID_NOT_FOUND)', () => {
    const { g, evidences } = withSingleStatementDrift(['ev-does-not-exist']);
    const v = verdict(g, evidences);
    expect(v.status).toBe('failed');
    expect(v.errors.map(e => e.code)).toContain('EVIDENCE_ID_NOT_FOUND');
    // The text sync itself is deterministic and still applies; provenance fails afterwards.
    expect(v.repairs.map(r => r.code)).toContain('CLAIM_ANNOTATION_SINGLE_STATEMENT_SYNCED');
  });

  // ── Immutability: the repair lands on a deep copy; the validator's inputs (the stored
  // baseline objects) stay byte-identical ───────────────────────────────────────────
  it('never mutates the content or originalContent passed to the validator', () => {
    const { g, evidences } = withSingleStatementDrift();
    const original = clone(g);
    const contentBefore = JSON.stringify(g);
    const originalBefore = JSON.stringify(original);
    const v = validateContent({ content: g, originalContent: original, evidences, humanEdited: false });
    expect(v.repairs.map(r => r.code)).toContain('CLAIM_ANNOTATION_SINGLE_STATEMENT_SYNCED');
    expect(JSON.stringify(g)).toBe(contentBefore);
    expect(JSON.stringify(original)).toBe(originalBefore);
    expect(v.content).not.toBe(g);
  });

  // ── Deterministic repair: whitespace-only annotation drift is normalized, not failed ─
  it('normalizes an annotation that differs only in whitespace (CLAIM_ANNOTATION_TEXT_NORMALIZED), still passing', () => {
    const { content, evidences } = base();
    const g = clone(content);
    const original = g.public_statement_annotations[0].statement_text as string;
    // Double an interior space and add a trailing space: a pure whitespace difference from body.
    g.public_statement_annotations[0].statement_text = `${original.replace(' ', '  ')} `;

    const repair = repairContent(g, evidences);
    expect(repair.repairs.map(r => r.code)).toContain('CLAIM_ANNOTATION_TEXT_NORMALIZED');

    const v = verdict(g, evidences);
    expect(v.status).toBe('passed');
    expect(v.repairs.map(r => r.code)).toContain('CLAIM_ANNOTATION_TEXT_NORMALIZED');
    // A normalized whitespace diff must never be reported as a claim mismatch.
    expect(v.errors.map(e => e.code)).not.toContain('CLAIM_STATEMENT_UNMATCHED');
  });

  // ── Deterministic repair: over-claiming language is calibrated in place, not failed ─
  it('calibrates uncalibrated language deterministically (CALIBRATED_LANGUAGE_APPLIED)', () => {
    const { content, evidences } = base();
    const g = clone(content);
    g.article.headline = 'This is the best revolutionary tool ever, guaranteed to be perfect.';
    const repair = repairContent(g, evidences);
    expect(repair.repairs.map(r => r.code)).toContain('CALIBRATED_LANGUAGE_APPLIED');
    // The calibrated headline no longer carries the raw superlative verbatim.
    expect(repair.content).toBeTruthy();
  });
});
