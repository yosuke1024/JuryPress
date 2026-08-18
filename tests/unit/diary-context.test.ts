import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DIARY_CONTEXT_BUDGET,
  buildDiaryContext,
  extractClosing,
  extractOpening
} from '../../src/lib/diary/context';
import {
  DiaryEntrySchema,
  type DiaryEntry,
  type DiaryEntryFocus,
  type DiaryTheme
} from '../../src/schemas/diary';
import { getJudge } from '../../src/lib/jury';
import {
  FIXTURE_BODY_EN,
  FIXTURE_BODY_JA,
  createEntryFocus,
  createJurorStates
} from '../helpers/diary-fixtures';

/*
 * Arc glances exist because of issue #105: five diarists, one narrative shape — prop,
 * professional metaphor, tidy lesson. The shape lives at the two ends of a body, so the
 * context reduces recent entries to their first and last sentences. Peer glances could not
 * carry this: they excerpt only the start, which shows how everyone opens and hides how
 * everyone ends — and the tidy-lesson habit lives at the end.
 */

/** A content root that does not exist: review reading is fail-soft, so none is needed. */
const MISSING_ROOT = path.join(os.tmpdir(), 'jurypress-diary-context-test-no-root');

function entry(overrides: {
  date: string;
  jurorId: string;
  theme?: DiaryTheme;
  bodyEn?: string;
  /** Omitted on purpose by the tests covering entries written before focus existed. */
  entryFocus?: DiaryEntryFocus;
}): DiaryEntry {
  return DiaryEntrySchema.parse({
    schema_version: '1.0',
    id: `diary-${overrides.date}-${overrides.jurorId}`,
    date: overrides.date,
    jurorId: overrides.jurorId,
    theme: overrides.theme ?? 'private',
    privateEventCategory: 'rest',
    title: { en: 'A Title', ja: 'タイトル' },
    body: { en: overrides.bodyEn ?? FIXTURE_BODY_EN, ja: FIXTURE_BODY_JA },
    mood: { en: 'level', ja: '平静' },
    shareQuote: { en: 'A quote.', ja: '引用。' },
    relatedReviewSlugs: [],
    entryFocus: overrides.entryFocus ?? null,
    publishedAt: `${overrides.date}T09:00:00.000Z`,
    generation: { model: 'gemini-3.5-flash', promptVersion: 'diary-v3' }
  });
}

/** The archive is always handed over newest-first, as the entry store returns it. */
function archive(...entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}

function build(input: { date: string; jurorId: 'alex' | 'david'; entries: DiaryEntry[] }) {
  return buildDiaryContext({
    contentRoot: MISSING_ROOT,
    juror: getJudge(input.jurorId),
    date: input.date,
    theme: 'private',
    privateEventCategory: 'rest',
    states: createJurorStates(input.jurorId),
    entries: input.entries
  });
}

describe('extractOpening', () => {
  it('returns a short body whole', () => {
    expect(extractOpening('One line, no more.', 220)).toBe('One line, no more.');
  });

  it('keeps whole leading sentences within the cap', () => {
    const body = `First sentence here. Second sentence follows after. ${'x'.repeat(300)}.`;
    expect(extractOpening(body, 60)).toBe('First sentence here. Second sentence follows after.');
  });

  it('respects a closing quote after the terminator', () => {
    const body = `"Is that so?" she asked. ${'x'.repeat(300)}.`;
    expect(extractOpening(body, 30)).toBe('"Is that so?" she asked.');
  });

  it('hard-truncates when the first sentence alone exceeds the cap', () => {
    const body = `${'a'.repeat(100)}. And then more.`;
    expect(extractOpening(body, 40)).toBe(`${'a'.repeat(40)}…`);
  });
});

describe('extractClosing', () => {
  it('returns a short body whole', () => {
    expect(extractClosing('One line, no more.', 220)).toBe('One line, no more.');
  });

  it('keeps the longest run of whole trailing sentences that fits', () => {
    const body = `${'x'.repeat(300)}. Penultimate sentence sits here. The very last sentence.`;
    expect(extractClosing(body, 220)).toBe('Penultimate sentence sits here. The very last sentence.');
    expect(extractClosing(body, 30)).toBe('The very last sentence.');
  });

  it('hard-truncates when the last sentence alone exceeds the cap', () => {
    const body = `Short start. ${'z'.repeat(100)}`;
    expect(extractClosing(body, 40)).toBe(`…${'z'.repeat(40)}`);
  });
});

describe('diary context — recent arcs', () => {
  it('reduces the newest entries to opening and closing, own entries included', () => {
    const opener = 'The kettle failed again this morning.';
    const closer = 'I still have not called anyone about it.';
    const body = `${opener} ${'Filler sentence in the middle. '.repeat(20)}${closer}`;
    const entries = archive(
      entry({ date: '2026-08-07', jurorId: 'david', theme: 'work', bodyEn: body }),
      entry({ date: '2026-08-06', jurorId: 'alex' })
    );

    const context = build({ date: '2026-08-08', jurorId: 'alex', entries });

    expect(context.recentArcs.map((arc) => `${arc.date}-${arc.jurorId}`)).toEqual([
      '2026-08-07-david',
      '2026-08-06-alex'
    ]);
    // The duty juror's own previous entry is surveyed too: the repeated arc is a property of
    // the whole diary, not of the other four.
    expect(context.recentArcs.some((arc) => arc.jurorId === 'alex')).toBe(true);

    const david = context.recentArcs[0];
    expect(david.theme).toBe('work');
    expect(david.opening.startsWith(opener)).toBe(true);
    expect(david.closing.endsWith(closer)).toBe(true);
    expect(david.opening.length).toBeLessThanOrEqual(DIARY_CONTEXT_BUDGET.arcOpeningChars + 1);
    expect(david.closing.length).toBeLessThanOrEqual(DIARY_CONTEXT_BUDGET.arcClosingChars + 1);
  });

  it('caps the survey at arcGlanceCount and ignores today and later', () => {
    const jurors = ['alex', 'david', 'lisa', 'sarah', 'marcus'] as const;
    const past = Array.from({ length: 8 }, (_, i) =>
      entry({ date: `2026-08-0${8 - i}`, jurorId: jurors[i % jurors.length] })
    );
    const entries = archive(...past, entry({ date: '2026-08-09', jurorId: 'david' }));

    const context = build({ date: '2026-08-09', jurorId: 'david', entries });

    expect(context.recentArcs).toHaveLength(DIARY_CONTEXT_BUDGET.arcGlanceCount);
    // Newest strictly-earlier entry first; the entry dated today is not part of the past.
    expect(context.recentArcs[0].date).toBe('2026-08-08');
    expect(context.recentArcs.every((arc) => arc.date < '2026-08-09')).toBe(true);
  });

  it('yields no arcs on an empty archive', () => {
    const context = build({ date: '2026-08-08', jurorId: 'alex', entries: [] });
    expect(context.recentArcs).toEqual([]);
  });
});

/*
 * Issue #110: three consecutive Alex entries centred on the same typewriter ribbon and the
 * same friction thesis. The context could not have noticed — it carried the bodies but nothing
 * saying what any of them had been *about*.
 */
describe('buildDiaryContext — recent focuses (issue #110)', () => {
  const ribbon = createEntryFocus({
    dominantSubject: 'replacing the ribbon on the Hermes Baby',
    anchorObject: 'the Hermes Baby typewriter',
    centralTension: 'Manual friction gives a hobby its soul but has no place in software.',
    endingState: 'settled into a lesson'
  });

  it("carries the writer's own last two entries, newest first", () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-09', jurorId: 'david', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses.map((glance) => glance.date)).toEqual(['2026-08-06', '2026-08-01']);
    expect(context.recentFocuses[0].focus.anchorObject).toBe('the Hermes Baby typewriter');
  });

  /*
   * A subject dominating one persona's story is that persona's to move on from. Two diarists
   * both writing about their own kitchens is not a recurrence, and treating it as one would
   * push the five of them apart rather than letting each accumulate.
   */
  it('ignores what the other diarists have been writing about', () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-09', jurorId: 'david', entryFocus: ribbon }),
        entry({ date: '2026-08-10', jurorId: 'david', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses).toEqual([]);
    expect(context.recurringFocus).toBeNull();
  });

  it('reports the shared centre when the last two entries agree on one', () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon })
      )
    });

    expect(context.recurringFocus?.sharedSubjectTerms).toContain('ribbon');
  });

  /*
   * Every entry published before this shipped carries no focus. The context must show what it
   * has and claim nothing about what it does not — a juror whose only focus record is one day
   * old has not repeated anything yet.
   */
  it('skips entries written before focus existed, without inventing one', () => {
    const context = build({
      date: '2026-08-11',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex' }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses).toHaveLength(1);
    expect(context.recentFocuses[0].date).toBe('2026-08-06');
    expect(context.recurringFocus).toBeNull();
  });

  it('looks no further back than the two entries the question needs', () => {
    const context = build({
      date: '2026-08-16',
      jurorId: 'alex',
      entries: archive(
        entry({ date: '2026-08-01', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-06', jurorId: 'alex', entryFocus: ribbon }),
        entry({ date: '2026-08-11', jurorId: 'alex', entryFocus: ribbon })
      )
    });

    expect(context.recentFocuses).toHaveLength(DIARY_CONTEXT_BUDGET.ownRecentFocusCount);
    expect(context.recentFocuses.map((glance) => glance.date)).toEqual(['2026-08-11', '2026-08-06']);
  });
});
