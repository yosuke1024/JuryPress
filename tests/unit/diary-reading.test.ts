import { describe, it, expect } from 'vitest';
import { selectReadingTarget, themeAssignsReading } from '../../src/lib/diary/reading';
import { DIARY_READING, DiaryEntrySchema, type DiaryEntry } from '../../src/schemas/diary';
import { DIARY_THEMES } from '../../src/schemas/diary';
import { addDays } from '../../src/lib/diary/rotation';
import { FIXTURE_BODY_EN, FIXTURE_BODY_JA } from '../helpers/diary-fixtures';

function entry(overrides: {
  date: string;
  jurorId: string;
  bodyEn?: string;
}): DiaryEntry {
  return DiaryEntrySchema.parse({
    schema_version: '1.0',
    id: `diary-${overrides.date}-${overrides.jurorId}`,
    date: overrides.date,
    jurorId: overrides.jurorId,
    theme: 'private',
    privateEventCategory: 'rest',
    title: { en: 'A Title', ja: 'タイトル' },
    body: { en: overrides.bodyEn ?? FIXTURE_BODY_EN, ja: FIXTURE_BODY_JA },
    mood: { en: 'level', ja: '平静' },
    shareQuote: { en: 'A quote.', ja: '引用。' },
    relatedReviewSlugs: [],
    publishedAt: `${overrides.date}T09:00:00.000Z`,
    generation: { model: 'gemini-3.5-flash', promptVersion: 'diary-v2' }
  });
}

/** The archive is always handed over newest-first, as the entry store returns it. */
function archive(...entries: DiaryEntry[]): DiaryEntry[] {
  return [...entries].sort((a, b) => b.date.localeCompare(a.date));
}

describe('diary reading assignment', () => {
  const READER = { date: '2026-08-20', jurorId: 'alex', jurorName: 'Alex' } as const;

  it('only assigns reading on relationship days', () => {
    for (const theme of DIARY_THEMES) {
      expect(themeAssignsReading(theme)).toBe(theme === 'relationship');
    }

    const entries = archive(entry({ date: '2026-08-19', jurorId: 'david' }));
    for (const theme of DIARY_THEMES) {
      const target = selectReadingTarget({ ...READER, theme, entries });
      if (theme === 'relationship') expect(target).not.toBeNull();
      else expect(target).toBeNull();
    }
  });

  it('is deterministic for a given day and archive', () => {
    const entries = archive(
      entry({ date: '2026-08-19', jurorId: 'david' }),
      entry({ date: '2026-08-18', jurorId: 'lisa' }),
      entry({ date: '2026-08-17', jurorId: 'sarah' })
    );
    const first = selectReadingTarget({ ...READER, theme: 'relationship', entries });
    for (let i = 0; i < 20; i++) {
      expect(selectReadingTarget({ ...READER, theme: 'relationship', entries })).toEqual(first);
    }
  });

  it('never assigns the juror their own entry', () => {
    const entries = archive(
      entry({ date: '2026-08-19', jurorId: 'alex' }),
      entry({ date: '2026-08-18', jurorId: 'alex' })
    );
    expect(selectReadingTarget({ ...READER, theme: 'relationship', entries })).toBeNull();
  });

  it('never assigns an entry from the same day or later', () => {
    const entries = archive(
      entry({ date: '2026-08-20', jurorId: 'david' }),
      entry({ date: '2026-08-21', jurorId: 'lisa' })
    );
    expect(selectReadingTarget({ ...READER, theme: 'relationship', entries })).toBeNull();
  });

  it('ignores entries older than the lookback window', () => {
    const tooOld = addDays(READER.date, -(DIARY_READING.lookbackDays + 1));
    const justInside = addDays(READER.date, -DIARY_READING.lookbackDays);

    expect(
      selectReadingTarget({
        ...READER,
        theme: 'relationship',
        entries: archive(entry({ date: tooOld, jurorId: 'david' }))
      })
    ).toBeNull();

    expect(
      selectReadingTarget({
        ...READER,
        theme: 'relationship',
        entries: archive(entry({ date: justInside, jurorId: 'david' }))
      })
    ).not.toBeNull();
  });

  it('returns null when nobody else has written yet', () => {
    expect(
      selectReadingTarget({ ...READER, theme: 'relationship', entries: [] })
    ).toBeNull();
  });

  /**
   * Being written about is the strongest reason to answer someone, so it outranks recency —
   * this is what lets a remark travel back to the person it was about.
   */
  it('prefers the most recent entry that named the reader', () => {
    const entries = archive(
      entry({ date: '2026-08-19', jurorId: 'david' }),
      entry({
        date: '2026-08-18',
        jurorId: 'lisa',
        bodyEn: `${FIXTURE_BODY_EN} Alex was in the room for that one.`
      }),
      entry({
        date: '2026-08-15',
        jurorId: 'sarah',
        bodyEn: `${FIXTURE_BODY_EN} Alex said the opposite last week.`
      })
    );

    const target = selectReadingTarget({ ...READER, theme: 'relationship', entries });
    expect(target?.diaryId).toBe('diary-2026-08-18-lisa');
    expect(target?.mentionsReader).toBe(true);
  });

  it('does not treat a name inside a longer word as a mention', () => {
    const entries = archive(
      entry({
        date: '2026-08-19',
        jurorId: 'david',
        bodyEn: `${FIXTURE_BODY_EN} We discussed Alexandria and its indexing.`
      })
    );
    expect(selectReadingTarget({ ...READER, theme: 'relationship', entries })?.mentionsReader).toBe(false);
  });

  it('hands over the body, not the short ambient excerpt', () => {
    const entries = archive(entry({ date: '2026-08-19', jurorId: 'david' }));
    const target = selectReadingTarget({ ...READER, theme: 'relationship', entries });
    expect(target?.body.length).toBeGreaterThan(300);
    expect(target?.body).toContain('cold solder joint');
  });

  it('truncates a very long entry to the reading budget', () => {
    const entries = archive(
      entry({ date: '2026-08-19', jurorId: 'david', bodyEn: 'x'.repeat(5000) })
    );
    const target = selectReadingTarget({ ...READER, theme: 'relationship', entries });
    expect(target!.body.length).toBeLessThanOrEqual(DIARY_READING.bodyChars + 1);
  });

  it('spreads its choice across the window rather than always taking yesterday', () => {
    const entries = archive(
      entry({ date: '2026-08-19', jurorId: 'david' }),
      entry({ date: '2026-08-18', jurorId: 'lisa' }),
      entry({ date: '2026-08-17', jurorId: 'sarah' }),
      entry({ date: '2026-08-16', jurorId: 'marcus' })
    );

    const chosen = new Set<string>();
    for (let offset = 0; offset < 40; offset++) {
      const target = selectReadingTarget({
        date: addDays('2026-08-20', offset),
        jurorId: 'alex',
        jurorName: 'Alex',
        theme: 'relationship',
        // Keep the same candidate set in range by re-dating nothing; only the seed moves.
        entries: entries.filter((candidate) => candidate.date < addDays('2026-08-20', offset))
      });
      if (target) chosen.add(target.diaryId);
    }
    expect(chosen.size).toBeGreaterThan(1);
  });
});
