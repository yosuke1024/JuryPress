import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  DIARY_CONTEXT_BUDGET,
  buildDiaryContext,
  extractClosing,
  extractOpening
} from '../../src/lib/diary/context';
import { DiaryEntrySchema, type DiaryEntry, type DiaryTheme } from '../../src/schemas/diary';
import { getJudge } from '../../src/lib/jury';
import { FIXTURE_BODY_EN, FIXTURE_BODY_JA, createJurorStates } from '../helpers/diary-fixtures';

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
