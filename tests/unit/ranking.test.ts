import { describe, it, expect } from 'vitest';
import { sortReviews, getRankingReviews } from '../../src/lib/data';

describe('Ranking Logic', () => {
  const getMockReview = (slug: string, juryScore: number, minJudgeScore: number, confidence: number, publishedAt: string) => ({
    slug,
    year: '2026',
    month: '07',
    review: {
      published_at: publishedAt,
      jury_score: juryScore,
      judge_score_range: { min: minJudgeScore, max: 100 },
      evaluation: {
        overall_evidence_confidence: confidence
      }
    },
    selection: {},
    evidence: []
  } as any);

  it('should sort by Jury Score descending', () => {
    const reviews = [
      getMockReview('b', 80, 70, 0.8, '2026-07-13T00:00:00Z'),
      getMockReview('a', 90, 80, 0.9, '2026-07-13T00:00:00Z')
    ];
    const sorted = sortReviews(reviews);
    expect(sorted[0].slug).toBe('a');
    expect(sorted[1].slug).toBe('b');
  });

  it('should tie-break Jury Score with Minimum Judge Score', () => {
    const reviews = [
      getMockReview('b', 90, 75, 0.8, '2026-07-13T00:00:00Z'),
      getMockReview('a', 90, 80, 0.8, '2026-07-13T00:00:00Z') // Higher min score wins
    ];
    const sorted = sortReviews(reviews);
    expect(sorted[0].slug).toBe('a');
    expect(sorted[1].slug).toBe('b');
  });

  it('should tie-break Min Score with Evidence Confidence', () => {
    const reviews = [
      getMockReview('b', 90, 80, 0.8, '2026-07-13T00:00:00Z'),
      getMockReview('a', 90, 80, 0.9, '2026-07-13T00:00:00Z') // Higher confidence wins
    ];
    const sorted = sortReviews(reviews);
    expect(sorted[0].slug).toBe('a');
    expect(sorted[1].slug).toBe('b');
  });

  it('should tie-break Confidence with Published Date (newer wins)', () => {
    const reviews = [
      getMockReview('b', 90, 80, 0.9, '2026-07-12T00:00:00Z'),
      getMockReview('a', 90, 80, 0.9, '2026-07-13T00:00:00Z') // Newer wins
    ];
    const sorted = sortReviews(reviews);
    expect(sorted[0].slug).toBe('a');
    expect(sorted[1].slug).toBe('b');
  });

  it('should tie-break Published Date with Slug (alphabetical)', () => {
    const reviews = [
      getMockReview('z', 90, 80, 0.9, '2026-07-13T00:00:00Z'),
      getMockReview('a', 90, 80, 0.9, '2026-07-13T00:00:00Z') // Alphabetical asc wins
    ];
    const sorted = sortReviews(reviews);
    expect(sorted[0].slug).toBe('a');
    expect(sorted[1].slug).toBe('z');
  });

  it('should filter out reviews with ranking_eligible: false in getRankingReviews', () => {
    const cohortMember = (slug: string, rankingEligible: boolean) => ({
      slug,
      review: {
        season: 2,
        rubric_id: 'open-source-product',
        rubric_version: '2.0.0',
        evaluation_status: 'complete',
        relationship: 'independent',
        jury_score: 80,
        evidence_map_status: 'complete',
        ranking_eligible: rankingEligible
      },
      evidenceMap: { claims: [] }
    });

    const reviews = [
      cohortMember('independent-1', true),
      cohortMember('related-party-1', false),
      cohortMember('independent-2', true)
    ] as any[];

    const filtered = getRankingReviews(reviews);
    expect(filtered.length).toBe(2);
    expect(filtered.some(r => r.slug === 'related-party-1')).toBe(false);
  });
});
