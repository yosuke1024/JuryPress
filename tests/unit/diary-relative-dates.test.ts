import { describe, it, expect } from 'vitest';
import {
  addDays,
  resolveRelativeWindow,
  windowContains,
  windowsOverlap
} from '../../src/lib/diary/relative-dates';

/*
 * Issue #120, at the level of the words themselves. Alex's 2026-08-16 entry said "next month",
 * and the whole question the archive could not answer is which days that covers. Nothing here
 * is a date parser for arbitrary prose: it resolves a closed list of the ways a person states a
 * plan, and declines everything else rather than guessing at a window it will then accuse a
 * later entry of missing.
 *
 * 2026-08-16 is a Sunday, which is why the week and weekend cases below look the way they do.
 */

describe('resolveRelativeWindow — calendar-anchored phrases', () => {
  /* The exact phrase, on the exact day, from the issue. */
  it('resolves "next month" to the whole of the following calendar month', () => {
    expect(resolveRelativeWindow('next month', '2026-08-16')).toEqual({
      start: '2026-09-01',
      end: '2026-09-30'
    });
  });

  it('crosses the year boundary', () => {
    expect(resolveRelativeWindow('next month', '2026-12-20')).toEqual({
      start: '2027-01-01',
      end: '2027-01-31'
    });
    expect(resolveRelativeWindow('next year', '2026-12-31')).toEqual({
      start: '2027-01-01',
      end: '2027-12-31'
    });
  });

  it('gets February right in a leap year and out of one', () => {
    expect(resolveRelativeWindow('next month', '2028-01-31')).toEqual({
      start: '2028-02-01',
      end: '2028-02-29'
    });
    expect(resolveRelativeWindow('next month', '2026-01-31')).toEqual({
      start: '2026-02-01',
      end: '2026-02-28'
    });
  });

  it('resolves "this month" to the calendar month the entry falls in', () => {
    expect(resolveRelativeWindow('this month', '2026-08-16')).toEqual({
      start: '2026-08-01',
      end: '2026-08-31'
    });
  });

  it('reads the edges of a month as a week rather than a day', () => {
    expect(resolveRelativeWindow('the end of next month', '2026-08-16')).toEqual({
      start: '2026-09-24',
      end: '2026-09-30'
    });
    expect(resolveRelativeWindow('end of the month', '2026-08-16')).toEqual({
      start: '2026-08-25',
      end: '2026-08-31'
    });
    expect(resolveRelativeWindow('the start of next month', '2026-08-16')).toEqual({
      start: '2026-09-01',
      end: '2026-09-07'
    });
  });

  it('resolves weeks Monday to Sunday', () => {
    // 2026-08-16 is a Sunday, so its own week began on the 10th.
    expect(resolveRelativeWindow('this week', '2026-08-16')).toEqual({
      start: '2026-08-10',
      end: '2026-08-16'
    });
    expect(resolveRelativeWindow('next week', '2026-08-16')).toEqual({
      start: '2026-08-17',
      end: '2026-08-23'
    });
  });

  it('resolves weekends to their Saturday and Sunday', () => {
    expect(resolveRelativeWindow('this weekend', '2026-08-16')).toEqual({
      start: '2026-08-15',
      end: '2026-08-16'
    });
    expect(resolveRelativeWindow('next weekend', '2026-08-16')).toEqual({
      start: '2026-08-22',
      end: '2026-08-23'
    });
  });

  it('resolves the near days, across a month boundary', () => {
    expect(resolveRelativeWindow('tomorrow', '2026-08-31')).toEqual({
      start: '2026-09-01',
      end: '2026-09-01'
    });
    expect(resolveRelativeWindow('the day after tomorrow', '2026-08-30')).toEqual({
      start: '2026-09-01',
      end: '2026-09-01'
    });
    expect(resolveRelativeWindow('tonight', '2026-08-16')).toEqual({
      start: '2026-08-16',
      end: '2026-08-16'
    });
  });
});

describe('resolveRelativeWindow — counted phrases', () => {
  it('counts days exactly, and crosses the month boundary while doing it', () => {
    expect(resolveRelativeWindow('in three days', '2026-08-30')).toEqual({
      start: '2026-09-02',
      end: '2026-09-02'
    });
  });

  /*
   * Weeks get slack because "in three weeks" does not name a day. A plan kept on the Thursday of
   * roughly the right week is a plan kept, and an advisory that says otherwise is one nobody
   * reads (lib/diary/projects.ts makes the same argument about stages that carry new work).
   */
  it('gives a point named in weeks a few days either side', () => {
    expect(resolveRelativeWindow('in two weeks', '2026-08-16')).toEqual({
      start: '2026-08-27',
      end: '2026-09-02'
    });
    expect(resolveRelativeWindow('in a fortnight', '2026-08-16')).toEqual({
      start: '2026-08-27',
      end: '2026-09-02'
    });
  });

  it('reads a count in months as the calendar month it lands in', () => {
    expect(resolveRelativeWindow('in six months', '2026-08-16')).toEqual({
      start: '2027-02-01',
      end: '2027-02-28'
    });
  });

  it('reads written numbers, and "a couple" as two rather than as "a"', () => {
    expect(resolveRelativeWindow('in a month', '2026-08-16')).toEqual(
      resolveRelativeWindow('next month', '2026-08-16')
    );
    expect(resolveRelativeWindow('a couple of weeks', '2026-08-16')).toEqual(
      resolveRelativeWindow('in two weeks', '2026-08-16')
    );
  });

  it('tolerates the hedges people put in front of a plan', () => {
    const plain = resolveRelativeWindow('next month', '2026-08-16');
    expect(resolveRelativeWindow('sometime next month', '2026-08-16')).toEqual(plain);
    expect(resolveRelativeWindow('  Next Month.  ', '2026-08-16')).toEqual(plain);
    expect(resolveRelativeWindow('at the end of next month', '2026-08-16')).toEqual(
      resolveRelativeWindow('the end of next month', '2026-08-16')
    );
  });
});

describe('resolveRelativeWindow — the ambiguous and the unresolvable', () => {
  /*
   * "next Friday" is the coming Friday to some speakers and the Friday of the following week to
   * others. The window spans both, because picking one reading would report a contradiction that
   * is really a dialect difference.
   */
  it('spans both readings of a named weekday', () => {
    expect(resolveRelativeWindow('next Friday', '2026-08-16')).toEqual({
      start: '2026-08-21',
      end: '2026-08-28'
    });
    expect(resolveRelativeWindow('on Saturday', '2026-08-16')).toEqual({
      start: '2026-08-22',
      end: '2026-08-29'
    });
  });

  it('takes a date the writer spelled out at face value', () => {
    expect(resolveRelativeWindow('2026-09-04', '2026-08-16')).toEqual({
      start: '2026-09-04',
      end: '2026-09-04'
    });
  });

  /*
   * The rule the whole module turns on. A window invented here would be used to accuse a later
   * entry of contradicting a plan nobody actually stated, so a phrase without a fixed reading
   * resolves to nothing and costs the check rather than the writer.
   */
  it('resolves nothing rather than guessing', () => {
    for (const phrase of [
      'in a few weeks',
      'several months from now',
      'when the weather turns',
      'once the boiler is fixed',
      'soon',
      'eventually',
      'every Saturday',
      '',
      '   '
    ]) {
      expect(resolveRelativeWindow(phrase, '2026-08-16'), phrase).toBeNull();
    }
  });

  it('resolves nothing when the source date is not a date', () => {
    expect(resolveRelativeWindow('next month', 'sometime in August')).toBeNull();
    expect(resolveRelativeWindow('next month', '2026-02-30')).toBeNull();
    expect(resolveRelativeWindow('next month', '2026-13-01')).toBeNull();
  });
});

describe('window arithmetic', () => {
  it('adds days across months, years and leap days', () => {
    expect(addDays('2026-08-31', 1)).toBe('2026-09-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });

  it('includes both ends of a window', () => {
    const window = { start: '2026-09-01', end: '2026-09-30' };
    expect(windowContains(window, '2026-09-01')).toBe(true);
    expect(windowContains(window, '2026-09-30')).toBe(true);
    expect(windowContains(window, '2026-08-31')).toBe(false);
    expect(windowContains(window, '2026-10-01')).toBe(false);
  });

  it('overlaps on a single shared day and not on adjacency', () => {
    expect(
      windowsOverlap({ start: '2026-09-01', end: '2026-09-30' }, { start: '2026-08-17', end: '2026-09-01' })
    ).toBe(true);
    expect(
      windowsOverlap({ start: '2026-09-01', end: '2026-09-30' }, { start: '2026-08-17', end: '2026-08-31' })
    ).toBe(false);
  });
});
