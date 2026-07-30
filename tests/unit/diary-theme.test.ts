import { describe, it, expect } from 'vitest';
import { resolveDailyBrief, resolveEventCategory, resolveTheme } from '../../src/lib/diary/theme';
import {
  DIARY_EVENT_CATEGORIES,
  DIARY_THEMES,
  DIARY_THEME_WEIGHTS
} from '../../src/schemas/diary';
import { addDays } from '../../src/lib/diary/rotation';
import { JUDGE_SLUGS } from '../../src/schemas/jury';

describe('diary theme selection', () => {
  it('is deterministic for a given date and juror', () => {
    const first = resolveDailyBrief('2026-08-02', 'david');
    for (let i = 0; i < 25; i++) {
      expect(resolveDailyBrief('2026-08-02', 'david')).toEqual(first);
    }
  });

  it('gives different jurors on the same day independent themes', () => {
    // Not an assertion that they differ — only that the seed includes the juror, so the whole
    // jury does not share one theme by construction.
    const themes = JUDGE_SLUGS.map((slug) => resolveTheme('2026-08-02', slug));
    expect(themes).toHaveLength(5);
    expect(new Set(themes).size).toBeGreaterThan(1);
  });

  it('only ever selects a defined theme', () => {
    for (let offset = 0; offset < 200; offset++) {
      const date = addDays('2026-08-01', offset);
      for (const slug of JUDGE_SLUGS) {
        expect(DIARY_THEMES).toContain(resolveTheme(date, slug));
      }
    }
  });

  it('only ever selects a defined event category, and only on days with a private half', () => {
    for (let offset = 0; offset < 200; offset++) {
      const date = addDays('2026-08-01', offset);
      for (const slug of JUDGE_SLUGS) {
        const { theme, privateEventCategory } = resolveDailyBrief(date, slug);
        if (theme === 'private' || theme === 'mixed') {
          expect(DIARY_EVENT_CATEGORIES).toContain(privateEventCategory);
        } else {
          expect(privateEventCategory).toBeNull();
        }
      }
    }
  });

  it('never hands a domestic prompt to a work, relationship or reflection day', () => {
    expect(resolveEventCategory('2026-08-02', 'david', 'work')).toBeNull();
    expect(resolveEventCategory('2026-08-02', 'david', 'relationship')).toBeNull();
    expect(resolveEventCategory('2026-08-02', 'david', 'memory')).toBeNull();
    expect(resolveEventCategory('2026-08-02', 'david', 'private')).not.toBeNull();
  });

  /**
   * Fully deterministic sample, so this is a fixed assertion about the selector rather than a
   * flaky statistical one: the same 2,000 (date, juror) pairs always produce the same tally.
   */
  it('approximates the configured weights over a large deterministic sample', () => {
    const tally = new Map(DIARY_THEMES.map((theme) => [theme, 0]));
    let total = 0;
    for (let offset = 0; offset < 400; offset++) {
      const date = addDays('2026-01-01', offset);
      for (const slug of JUDGE_SLUGS) {
        tally.set(resolveTheme(date, slug), (tally.get(resolveTheme(date, slug)) ?? 0) + 1);
        total++;
      }
    }

    for (const [theme, weight] of DIARY_THEME_WEIGHTS) {
      const share = (tally.get(theme) ?? 0) / total;
      expect(Math.abs(share - weight)).toBeLessThan(0.05);
    }
  });

  it('weights sum to one', () => {
    const sum = DIARY_THEME_WEIGHTS.reduce((acc, [, weight]) => acc + weight, 0);
    expect(sum).toBeCloseTo(1, 10);
  });
});
