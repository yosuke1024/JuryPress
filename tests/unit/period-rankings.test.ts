import { describe, it, expect } from 'vitest';
import {
  CURRENT_COHORT,
  formatPeriodLabel,
  getCurrentCohortReviews,
  getLatestPeriodKey,
  getPeriodKey,
  getPeriodNeighbours,
  getPeriodReviews,
  isCurrentCohortReview,
  isValidPeriodKey,
  listPeriodKeys,
  periodPath,
  toISOWeek,
  toJSTCivilDate
} from '../../src/lib/rankings';
import { sortReviews } from '../../src/lib/data';

interface Overrides {
  season?: number;
  rubric_id?: string;
  rubric_version?: string;
  evaluation_status?: string;
  ranking_eligible?: boolean;
  relationship?: string;
  jury_score?: number | null;
  published_at?: string;
  min?: number;
  confidence?: number;
}

function makeEntry(slug: string, overrides: Overrides = {}): any {
  const published_at = overrides.published_at ?? '2026-07-14T10:00:00+09:00';
  return {
    slug,
    year: published_at.slice(0, 4),
    month: published_at.slice(5, 7),
    review: {
      slug,
      season: overrides.season ?? CURRENT_COHORT.season,
      rubric_id: overrides.rubric_id ?? CURRENT_COHORT.rubricId,
      rubric_version: overrides.rubric_version ?? CURRENT_COHORT.rubricVersion,
      evaluation_status: overrides.evaluation_status ?? 'complete',
      ranking_eligible: overrides.ranking_eligible ?? true,
      relationship: overrides.relationship ?? 'independent',
      jury_score: overrides.jury_score === undefined ? 80 : overrides.jury_score,
      judge_score_range: { min: overrides.min ?? 75, max: 90 },
      published_at,
      evaluation: {
        overall_evidence_confidence: overrides.confidence ?? 0.8,
        product: { name: slug },
        article: { headline: `${slug} headline` }
      }
    },
    selection: {},
    evidence: []
  };
}

const ALL_KINDS = ['annual', 'monthly', 'weekly'] as const;

describe('Current Cohort eligibility', () => {
  it('accepts a complete, independent, ranking-eligible Season 2 v2.0.0 review', () => {
    expect(isCurrentCohortReview(makeEntry('ok'))).toBe(true);
  });

  it.each([
    ['Season 1', { season: 1 }],
    ['a different rubric id', { rubric_id: 'hackathon' }],
    ['a different rubric version', { rubric_version: '1.0.0' }],
    ['an incomplete evaluation', { evaluation_status: 'evidence_limited' }],
    ['ranking_eligible: false', { ranking_eligible: false }],
    ['a related-party relationship', { relationship: 'related-party' }],
    ['a null jury score', { jury_score: null }]
  ])('excludes %s', (_label, overrides) => {
    expect(isCurrentCohortReview(makeEntry('nope', overrides as Overrides))).toBe(false);
  });

  it('keeps only the Current Cohort out of a mixed set', () => {
    const entries = [
      makeEntry('current-a'),
      makeEntry('current-b'),
      makeEntry('legacy', { season: 1, rubric_version: 'v1' }),
      makeEntry('related', { relationship: 'related-party', ranking_eligible: false }),
      makeEntry('unranked', { jury_score: null, evaluation_status: 'evidence_limited' })
    ];
    expect(getCurrentCohortReviews(entries).map(e => e.slug)).toEqual(['current-a', 'current-b']);
  });

  it('excludes non-cohort reviews from every period listing and page', () => {
    const entries = [
      makeEntry('current', { published_at: '2026-07-14T10:00:00+09:00' }),
      makeEntry('legacy', { season: 1, rubric_version: 'v1', published_at: '2026-07-14T10:00:00+09:00' }),
      makeEntry('related', { relationship: 'related-party', published_at: '2026-07-14T10:00:00+09:00' })
    ];
    for (const kind of ALL_KINDS) {
      const keys = listPeriodKeys(kind, entries);
      expect(keys).toHaveLength(1);
      const slugs = getPeriodReviews(kind, keys[0], entries).map(e => e.slug);
      expect(slugs).toEqual(['current']);
    }
  });

  it('uses the same population for all-time and every period', () => {
    const entries = [
      makeEntry('a', { published_at: '2026-01-05T10:00:00+09:00' }),
      makeEntry('b', { published_at: '2026-01-06T10:00:00+09:00' }),
      makeEntry('legacy', { season: 1, published_at: '2026-01-06T10:00:00+09:00' })
    ];
    // All three reviews fall in the same year, month and ISO week, so each period page
    // must contain exactly the all-time population.
    const allTime = sortReviews(getCurrentCohortReviews(entries)).map(e => e.slug);
    for (const kind of ALL_KINDS) {
      const key = getLatestPeriodKey(kind, entries)!;
      expect(getPeriodReviews(kind, key, entries).map(e => e.slug)).toEqual(allTime);
    }
  });
});

describe('JST period boundaries', () => {
  it('reads the calendar date in Asia/Tokyo, not UTC', () => {
    expect(toJSTCivilDate('2026-07-13T16:00:00Z')).toEqual({ year: 2026, month: 7, day: 14 });
    expect(toJSTCivilDate('2026-07-13T14:59:59Z')).toEqual({ year: 2026, month: 7, day: 13 });
  });

  it('places 2025-12-31T15:00:00Z into JST year 2026', () => {
    // 2025-12-31T15:00Z == 2026-01-01T00:00 JST
    expect(getPeriodKey('annual', '2025-12-31T15:00:00Z')).toBe('2026');
    expect(getPeriodKey('annual', '2025-12-31T14:59:59Z')).toBe('2025');
  });

  it('places the JST month boundary correctly', () => {
    // 2026-06-30T15:00Z == 2026-07-01T00:00 JST
    expect(getPeriodKey('monthly', '2026-06-30T15:00:00Z')).toBe('2026-07');
    expect(getPeriodKey('monthly', '2026-06-30T14:59:59Z')).toBe('2026-06');
  });

  it('groups a UTC-evening publication into the next JST day and month', () => {
    expect(getPeriodKey('monthly', '2026-07-31T16:30:00Z')).toBe('2026-08');
  });
});

describe('ISO week (Monday start, Sunday end)', () => {
  it('keeps Monday through Sunday in the same week', () => {
    // 2026-07-13 (Mon) .. 2026-07-19 (Sun) JST
    const monday = getPeriodKey('weekly', '2026-07-13T00:00:00+09:00');
    const sunday = getPeriodKey('weekly', '2026-07-19T23:59:59+09:00');
    expect(monday).toBe(sunday);
    expect(monday).toBe('2026-W29');
  });

  it('rolls to the next week on the following Monday', () => {
    expect(getPeriodKey('weekly', '2026-07-20T00:00:00+09:00')).toBe('2026-W30');
  });

  it('rolls to the previous week on the preceding Sunday', () => {
    expect(getPeriodKey('weekly', '2026-07-12T23:59:59+09:00')).toBe('2026-W28');
  });

  it('uses the ISO week-year, not the calendar year, across New Year', () => {
    // 2026-01-01 is a Thursday: week 1 of ISO week-year 2026, and the preceding
    // Monday 2025-12-29 belongs to the same week.
    expect(getPeriodKey('weekly', '2025-12-29T00:00:00+09:00')).toBe('2026-W01');
    expect(getPeriodKey('weekly', '2026-01-01T00:00:00+09:00')).toBe('2026-W01');
    expect(getPeriodKey('weekly', '2026-01-04T23:59:59+09:00')).toBe('2026-W01');

    // 2027-01-01 is a Friday: it still belongs to ISO week 53 of week-year 2026.
    expect(getPeriodKey('weekly', '2027-01-01T00:00:00+09:00')).toBe('2026-W53');
    expect(getPeriodKey('weekly', '2027-01-04T00:00:00+09:00')).toBe('2027-W01');
  });

  it('computes ISO week numbers for known reference dates', () => {
    expect(toISOWeek({ year: 2026, month: 1, day: 1 })).toEqual({ weekYear: 2026, week: 1 });
    expect(toISOWeek({ year: 2025, month: 12, day: 28 })).toEqual({ weekYear: 2025, week: 52 });
    expect(toISOWeek({ year: 2026, month: 12, day: 31 })).toEqual({ weekYear: 2026, week: 53 });
  });

  it('assigns the annual and weekly keys independently at New Year', () => {
    const instant = '2025-12-29T00:00:00+09:00';
    expect(getPeriodKey('annual', instant)).toBe('2025');
    expect(getPeriodKey('weekly', instant)).toBe('2026-W01');
  });
});

describe('period listing and navigation', () => {
  const entries = [
    makeEntry('jan', { published_at: '2026-01-15T10:00:00+09:00' }),
    makeEntry('feb', { published_at: '2026-02-15T10:00:00+09:00' }),
    makeEntry('apr', { published_at: '2026-04-15T10:00:00+09:00' }),
    makeEntry('prev-year', { published_at: '2025-11-15T10:00:00+09:00' })
  ];

  it('lists only periods that hold at least one Current Cohort review', () => {
    expect(listPeriodKeys('monthly', entries)).toEqual(['2025-11', '2026-01', '2026-02', '2026-04']);
    // 2025-12 and 2026-03 have no reviews and are never produced.
    expect(listPeriodKeys('monthly', entries)).not.toContain('2026-03');
    expect(listPeriodKeys('annual', entries)).toEqual(['2025', '2026']);
  });

  it('produces no periods at all when nothing is in the cohort', () => {
    const legacyOnly = [makeEntry('legacy', { season: 1 })];
    for (const kind of ALL_KINDS) {
      expect(listPeriodKeys(kind, legacyOnly)).toEqual([]);
      expect(getLatestPeriodKey(kind, legacyOnly)).toBeNull();
    }
  });

  it('resolves the latest period', () => {
    expect(getLatestPeriodKey('monthly', entries)).toBe('2026-04');
    expect(getLatestPeriodKey('annual', entries)).toBe('2026');
  });

  it('links only to existing neighbouring periods, skipping empty gaps', () => {
    const keys = listPeriodKeys('monthly', entries);
    expect(getPeriodNeighbours('2026-02', keys)).toEqual({ previous: '2026-01', next: '2026-04' });
    expect(getPeriodNeighbours('2025-11', keys)).toEqual({ previous: null, next: '2026-01' });
    expect(getPeriodNeighbours('2026-04', keys)).toEqual({ previous: '2026-02', next: null });
  });

  it('offers every existing period in the history list', () => {
    // The history selector is driven by the same ascending key list.
    expect(listPeriodKeys('monthly', entries)).toHaveLength(4);
  });

  it('builds period paths', () => {
    expect(periodPath('annual', '2026')).toBe('/rankings/annual/2026/');
    expect(periodPath('monthly', '2026-07')).toBe('/rankings/monthly/2026-07/');
    expect(periodPath('weekly', '2026-W29')).toBe('/rankings/weekly/2026-W29/');
  });

  it('validates period key shapes', () => {
    expect(isValidPeriodKey('annual', '2026')).toBe(true);
    expect(isValidPeriodKey('monthly', '2026-13')).toBe(false);
    expect(isValidPeriodKey('weekly', '2026-W54')).toBe(false);
    expect(isValidPeriodKey('weekly', '2026-W01')).toBe(true);
  });

  it('formats readable period labels', () => {
    expect(formatPeriodLabel('annual', '2026')).toBe('2026');
    expect(formatPeriodLabel('monthly', '2026-07')).toBe('July 2026');
    expect(formatPeriodLabel('weekly', '2026-W29')).toBe('Week 29, 2026');
  });
});

describe('period ordering matches sortReviews()', () => {
  it('ranks a period exactly as sortReviews() ranks its members', () => {
    const entries = [
      makeEntry('low', { jury_score: 70, published_at: '2026-07-14T10:00:00+09:00' }),
      makeEntry('high', { jury_score: 95, published_at: '2026-07-15T10:00:00+09:00' }),
      makeEntry('mid', { jury_score: 80, published_at: '2026-07-16T10:00:00+09:00' }),
      makeEntry('other-month', { jury_score: 99, published_at: '2026-08-03T10:00:00+09:00' })
    ];
    for (const kind of ALL_KINDS) {
      for (const key of listPeriodKeys(kind, entries)) {
        const actual = getPeriodReviews(kind, key, entries);
        const expected = sortReviews(
          getCurrentCohortReviews(entries).filter(e => getPeriodKey(kind, e.review.published_at) === key)
        );
        expect(actual.map(e => e.slug)).toEqual(expected.map(e => e.slug));
      }
    }
    expect(getPeriodReviews('monthly', '2026-07', entries).map(e => e.slug)).toEqual(['high', 'mid', 'low']);
  });

  it('preserves the existing tie-break order inside a period', () => {
    const entries = [
      makeEntry('b', { jury_score: 90, min: 70, published_at: '2026-07-14T10:00:00+09:00' }),
      makeEntry('a', { jury_score: 90, min: 80, published_at: '2026-07-14T10:00:00+09:00' })
    ];
    expect(getPeriodReviews('monthly', '2026-07', entries).map(e => e.slug)).toEqual(['a', 'b']);
  });
});
