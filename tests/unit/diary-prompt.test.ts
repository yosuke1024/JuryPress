import { describe, it, expect } from 'vitest';
import { buildDiaryPrompt } from '../../src/lib/diary/prompt';
import { validateDiaryResponse } from '../../src/lib/diary/validator';
import {
  DIARY_CANON_FACT_TYPES,
  DIARY_MEMORY_IMPORTANCE,
  DIARY_PATCH_LIMITS,
  DIARY_TEXT_LIMITS
} from '../../src/schemas/diary';
import { JUDGE_SLUGS } from '../../src/schemas/jury';
import type { DiaryContext } from '../../src/lib/diary/context';
import { getJudge } from '../../src/lib/jury';
import { createDiaryResponse, createJurorStates } from '../helpers/diary-fixtures';

/**
 * These tests exist because of 2026-08-01, the first day JuryDiary ever generated.
 *
 * The validator required `memoryCandidate.importance` to sit in [0, 1]. The prompt described the
 * field only as "worth remembering months from now" and never named a scale, and the response
 * schema typed it as a bare number, so nothing the model could read carried the bound. Gemini
 * answered 2 — the obvious reading of an unstated rating — and a structurally sound entry, its
 * canon fact and its life patches were all discarded over one number.
 *
 * The lesson generalises past that field: a bound the validator enforces and the prompt withholds
 * is not a strict gate, it is a trap. So the assertion here is not "the prompt mentions
 * importance" but "every numeric bound this prompt is judged against appears in the prompt".
 */

function context(): DiaryContext {
  return {
    juror: getJudge('david'),
    date: '2026-08-02',
    theme: 'mixed',
    privateEventCategory: 'small_success',
    states: createJurorStates('david'),
    ownPreviousEntry: null,
    peerGlances: [],
    mentionsOfSelf: [],
    readingTarget: null,
    memories: [],
    reviews: [],
    allowedReviewSlugs: []
  };
}

describe('diary prompt', () => {
  it('states the importance scale, so a model cannot guess 1–5 and lose the day', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toContain('importance');
    expect(prompt).toContain(
      `${DIARY_MEMORY_IMPORTANCE.min} to ${DIARY_MEMORY_IMPORTANCE.max}`
    );
    // The failure mode by name: an unqualified "importance" invites a 1–5 reading.
    expect(prompt).toMatch(/NOT a 1–5/);
  });

  /*
   * Field-scoped on purpose. A bare `toContain(String(bound))` is close to vacuous here:
   * relationshipDelta and traitDelta are both 0.05, so either instruction could disappear
   * entirely and a numeric-substring check would still pass. Each bound is asserted next to the
   * field name it governs instead.
   */
  it('quotes every list cap next to the field it governs', () => {
    const prompt = buildDiaryPrompt(context());

    /*
     * Every key of DIARY_PATCH_LIMITS that caps a list, derived from the constant rather than
     * hand-listed, so a cap added to the schema without a prompt line fails here. The delta
     * bounds are not counts and are asserted separately below.
     */
    const deltas = new Set(['relationshipDelta', 'traitDelta', 'beliefConfidenceDelta']);
    const capped = Object.entries(DIARY_PATCH_LIMITS).filter(([field]) => !deltas.has(field));
    expect(capped.length).toBeGreaterThan(10);

    for (const [field, cap] of capped) {
      // "at most" is required so the field name and the number cannot drift apart unnoticed.
      expect(prompt, `${field} cap missing from the prompt`).toMatch(
        new RegExp(`${field}: at most ${cap}\\b`)
      );
    }
  });

  it('quotes each delta bound beside its own field', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(
      new RegExp(`±${DIARY_PATCH_LIMITS.relationshipDelta}[^]*?neutral is trust`)
    );
    expect(prompt).toMatch(
      new RegExp(`traitAdjustments[^\\n]*±${DIARY_PATCH_LIMITS.traitDelta}`)
    );
    expect(prompt).toMatch(
      new RegExp(`beliefAdjustments[^\\n]*±${DIARY_PATCH_LIMITS.beliefConfidenceDelta}`)
    );
  });

  it('spells out the canon fact types, which are enum values and not concepts', () => {
    const prompt = buildDiaryPrompt(context());

    /*
     * Scoped to the factType line. Several of these words ("home", "other", "habit") occur in
     * ordinary prose elsewhere in the prompt, so an unscoped toContain would pass on a prompt
     * that never listed the enum at all.
     */
    const line = prompt
      .split('\n')
      .find((candidate) => candidate.includes('factType must be exactly one of'));
    expect(line, 'no line enumerating the accepted factType values').toBeDefined();

    for (const factType of DIARY_CANON_FACT_TYPES) {
      expect(line, `canon fact type ${factType} missing`).toContain(factType);
    }
    // The trap the old wording set: it offered "an object", which is not an accepted value.
    expect(prompt).toContain('"possession"');
    expect(prompt).not.toMatch(/\(a habit, an object, a place, a past event\)/);
  });

  it('states the text floors that decide publication', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(new RegExp(`body\\.en at least ${DIARY_TEXT_LIMITS.minBodyEn}`));
    expect(prompt).toMatch(new RegExp(`body\\.ja at least ${DIARY_TEXT_LIMITS.minBodyJa}`));
    expect(prompt).toMatch(new RegExp(`title at least ${DIARY_TEXT_LIMITS.minTitle}`));
    expect(prompt).toMatch(new RegExp(`mood at least ${DIARY_TEXT_LIMITS.minMood}`));
    // The script floor is a number in the validator; prose alone would leave it unstated.
    expect(prompt).toMatch(
      new RegExp(`${Math.round(DIARY_TEXT_LIMITS.minJapaneseRatio * 100)}% of body\\.ja`)
    );
    expect(prompt).toMatch(
      new RegExp(`shareQuote at least ${DIARY_TEXT_LIMITS.minShareQuote} characters`)
    );
    expect(prompt).toMatch(new RegExp(`most ${DIARY_TEXT_LIMITS.maxShareQuote}`));
    expect(prompt).toContain(
      `${DIARY_TEXT_LIMITS.minLengthRatio}–${DIARY_TEXT_LIMITS.maxLengthRatio}`
    );
  });

  it('names the jurors a relationship patch may target, and excludes the writer', () => {
    const prompt = buildDiaryPrompt(context());

    for (const slug of JUDGE_SLUGS.filter((candidate) => candidate !== 'david')) {
      expect(prompt, `peer ${slug} missing from the allowed targets`).toMatch(
        new RegExp(`targetJurorId must be one of:[^\\n]*${slug}`)
      );
    }
    // The writer is never a legal target, and the validator rejects a repeated one separately.
    expect(prompt).not.toMatch(/targetJurorId must be one of:[^\n]*david/);
    expect(prompt).toContain('Never yourself');
    expect(prompt).toMatch(/never the same\s+juror twice/);
  });

  /*
   * Over-claiming what is fatal is the same defect as under-claiming, pointed the other way: it
   * buys caution at the price of entries nobody needed to lose. The validator checks relationship
   * *deltas*, never the resulting 0–1 value, and cannot check "only jurors you wrote about" at
   * all — so neither may be described as day-ending.
   */
  it('claims fatality for exactly what the validator enforces, and no more', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(/Extra notes beyond that are dropped rather than fatal/);
    expect(prompt).toMatch(/Hard limits, checked exactly/);
    expect(prompt).toMatch(/contradictionNotes is not one of them/);
    expect(prompt).toMatch(/Neither is the 0–1 relationship scale/);
    expect(prompt).not.toMatch(/Everything above/);
  });

  it('rejects the exact value that cost 2026-08-01, and accepts one on the stated scale', () => {
    const expected = {
      date: '2026-08-02',
      jurorId: 'david' as const,
      theme: 'mixed' as const,
      privateEventCategory: 'small_success' as const,
      allowedReviewSlugs: [],
      readingTargetId: null
    };
    const withImportance = (importance: number) =>
      validateDiaryResponse({
        parsed: createDiaryResponse({
          memoryCandidate: { summary: 'A memory worth keeping.', importance, tags: [] }
        }),
        expected
      });

    expect(withImportance(2).errors.map((finding) => finding.code)).toEqual([
      'DIARY_IMPORTANCE_OUT_OF_BOUNDS'
    ]);
    // Zero errors, not merely a different set: importance is the only thing separating the two.
    expect(withImportance(0.9).errors).toEqual([]);
  });
});
