import { describe, it, expect } from 'vitest';
import {
  CURRENT_COHORT,
  getEffectiveEvidenceMapStatus,
  getRankingEligibility,
  getRankedReviews,
  isHistoricalMethodology
} from '../../src/lib/ranking-eligibility';

/**
 * Ranking eligibility is derived at read time and never written back to review.json, so these
 * tests are the only place the rules are pinned. The load-bearing cases are the two that fail
 * closed: a generation that predates mapping, and a review that claims a complete map without
 * one being loadable.
 */

interface EntryOptions {
  /** Omit to model a schema generation that has no evidence_map_status field at all. */
  evidenceMapStatus?: 'complete' | 'partial' | 'unavailable';
  /** Null models a map that is missing, unparseable, or bound to different content. */
  evidenceMap?: unknown | null;
  schemaVersion?: string;
  season?: number;
  relationship?: string;
  evaluationStatus?: string;
  rankingEligible?: boolean;
  juryScore?: number | null;
}

function makeEntry(slug: string, options: EntryOptions = {}): any {
  const review: any = {
    slug,
    schema_version: options.schemaVersion ?? '3.0.0',
    season: options.season ?? CURRENT_COHORT.season,
    rubric_id: CURRENT_COHORT.rubricId,
    rubric_version: CURRENT_COHORT.rubricVersion,
    evaluation_status: options.evaluationStatus ?? 'complete',
    ranking_eligible: options.rankingEligible ?? true,
    relationship: options.relationship ?? 'independent',
    jury_score: options.juryScore === undefined ? 80 : options.juryScore
  };
  if (options.evidenceMapStatus !== undefined) {
    review.evidence_map_status = options.evidenceMapStatus;
  }
  return {
    slug,
    review,
    selection: {},
    evidence: [],
    evidenceMap: options.evidenceMap === undefined ? { claims: [] } : options.evidenceMap
  };
}

describe('getEffectiveEvidenceMapStatus', () => {
  it('reports a complete map when the review claims one and the map loads', () => {
    expect(getEffectiveEvidenceMapStatus(makeEntry('ok', { evidenceMapStatus: 'complete' })))
      .toBe('complete');
  });

  it('reports unavailable for a generation that has no evidence_map_status field', () => {
    // 2.0.0 / 2.1.0 reviews predate statement-level mapping entirely.
    expect(getEffectiveEvidenceMapStatus(makeEntry('v2', { schemaVersion: '2.1.0' })))
      .toBe('unavailable');
  });

  it('reports partial when the review says so', () => {
    expect(getEffectiveEvidenceMapStatus(makeEntry('p', { evidenceMapStatus: 'partial' })))
      .toBe('partial');
  });

  it('reports unavailable when the review says so', () => {
    expect(getEffectiveEvidenceMapStatus(makeEntry('u', { evidenceMapStatus: 'unavailable' })))
      .toBe('unavailable');
  });

  it('fails closed when the review claims a complete map but no map is loadable', () => {
    // The map file is missing, unparseable, or bound to different content. Trusting the
    // review's own claim here would rank on self-report.
    const entry = makeEntry('liar', { evidenceMapStatus: 'complete', evidenceMap: null });
    expect(getEffectiveEvidenceMapStatus(entry)).toBe('unavailable');
    expect(getRankingEligibility(entry).eligible).toBe(false);
  });

  it('does not treat a future schema version as unmapped', () => {
    // Regression guard. `schema_version` is a per-variant z.literal, so a `!== '3.0.0'` test
    // would classify every review of the next schema version as unmapped and silently drop
    // the newest work out of the rankings. Presence of the field is the signal, not the value.
    const entry = makeEntry('v4', { schemaVersion: '4.0.0', evidenceMapStatus: 'complete' });
    expect(getEffectiveEvidenceMapStatus(entry)).toBe('complete');
    expect(getRankingEligibility(entry).eligible).toBe(true);
  });
});

describe('getRankingEligibility', () => {
  it('ranks a current-cohort review with a complete, loadable map', () => {
    expect(getRankingEligibility(makeEntry('ok', { evidenceMapStatus: 'complete' })))
      .toEqual({ eligible: true, reason: null });
  });

  it.each([
    ['a Season 1 review', { season: 1 }],
    ['a related-party review', { relationship: 'related-party' }],
    ['an incomplete evaluation', { evaluationStatus: 'evidence_limited' }],
    ['a base-ineligible review', { rankingEligible: false }],
    ['a review with no jury score', { juryScore: null }]
  ])('excludes %s as outside the current cohort', (_label, options) => {
    const entry = makeEntry('nope', { evidenceMapStatus: 'complete', ...(options as EntryOptions) });
    expect(getRankingEligibility(entry).reason).toBe('outside-current-cohort');
  });

  it('names the mapping reason so the Methodology History page can group by it', () => {
    expect(getRankingEligibility(makeEntry('a', { schemaVersion: '2.0.0' })).reason)
      .toBe('evidence-map-unavailable');
    expect(getRankingEligibility(makeEntry('b', { evidenceMapStatus: 'partial' })).reason)
      .toBe('evidence-map-partial');
  });

  it('keeps only ranked reviews in the population', () => {
    const entries = [
      makeEntry('ranked', { evidenceMapStatus: 'complete' }),
      makeEntry('legacy', { schemaVersion: '2.0.0' }),
      makeEntry('related', { evidenceMapStatus: 'complete', relationship: 'related-party' })
    ];
    expect(getRankedReviews(entries).map(e => e.slug)).toEqual(['ranked']);
  });
});

describe('isHistoricalMethodology', () => {
  it('marks reviews excluded for mapping reasons', () => {
    expect(isHistoricalMethodology(makeEntry('legacy', { schemaVersion: '2.0.0' }))).toBe(true);
    expect(isHistoricalMethodology(makeEntry('partial', { evidenceMapStatus: 'partial' }))).toBe(true);
  });

  it('does not mark reviews excluded for cohort reasons alone', () => {
    // A related-party or Season 1 review is not a methodology-history artefact, and labelling
    // it as one would misstate why it is unranked.
    const related = makeEntry('related', { evidenceMapStatus: 'complete', relationship: 'related-party' });
    expect(isHistoricalMethodology(related)).toBe(false);
  });

  it('does not mark ranked reviews', () => {
    expect(isHistoricalMethodology(makeEntry('ok', { evidenceMapStatus: 'complete' }))).toBe(false);
  });
});
