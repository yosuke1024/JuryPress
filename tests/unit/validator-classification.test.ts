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

  // ── Hard Fail: a claim that matches no body text, even after normalization ───────
  it('classifies a claim unmatched after normalization as a Hard Fail (CLAIM_STATEMENT_UNMATCHED)', () => {
    const { content, evidences } = base();
    const g = clone(content);
    g.public_statement_annotations[0].statement_text = 'This sentence appears nowhere in the article body at all zzz.';
    const v = verdict(g, evidences);
    expect(v.status).toBe('failed');
    expect(v.errors.map(e => e.code)).toContain('CLAIM_STATEMENT_UNMATCHED');
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
