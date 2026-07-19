import { describe, it, expect } from 'vitest';
import { 
  sortReviewsByPublishedAt, 
  groupReviewsByYearAndMonth, 
  normalizeSearchText,
  buildReviewSearchText
} from '../../src/lib/review-archive';
import type { ReviewEntry } from '../../src/lib/data';

function getMockReview(slug: string, published_at: string, name: string = 'Test'): ReviewEntry {
  return {
    slug,
    year: '2026',
    month: '07',
    review: {
      published_at,
      jury_score: 80,
      judge_score_range: { min: 70, max: 90 },
      evaluation: {
        product: { name, category: 'Dev Tools' },
        article: { headline: 'Headline of Test', standfirst: 'Standfirst of Test' },
        recalculated_jury_score: 80,
        overall_evidence_confidence: 0.9,
        judges: []
      }
    } as any,
    selection: {
      source: 'hacker news'
    } as any,
    evidence: [],
    evidenceMap: null
  };
}

describe('Review Archive Helpers', () => {
  describe('sortReviewsByPublishedAt', () => {
    it('should sort reviews by published_at descending', () => {
      const r1 = getMockReview('a', '2026-07-15T00:00:00Z');
      const r2 = getMockReview('b', '2026-07-18T00:00:00Z');
      const r3 = getMockReview('c', '2026-07-10T00:00:00Z');

      const sorted = sortReviewsByPublishedAt([r1, r2, r3]);
      expect(sorted[0].slug).toBe('b');
      expect(sorted[1].slug).toBe('a');
      expect(sorted[2].slug).toBe('c');
    });

    it('should break ties deterministically using slug', () => {
      const r1 = getMockReview('z', '2026-07-15T00:00:00Z');
      const r2 = getMockReview('m', '2026-07-15T00:00:00Z');
      const r3 = getMockReview('a', '2026-07-15T00:00:00Z');

      const sorted = sortReviewsByPublishedAt([r1, r2, r3]);
      expect(sorted[0].slug).toBe('a');
      expect(sorted[1].slug).toBe('m');
      expect(sorted[2].slug).toBe('z');
    });

    it('should not mutate the original array', () => {
      const r1 = getMockReview('a', '2026-07-15T00:00:00Z');
      const r2 = getMockReview('b', '2026-07-18T00:00:00Z');
      const original = [r1, r2];

      sortReviewsByPublishedAt(original);
      expect(original[0].slug).toBe('a'); // remains unchanged
    });

    it('should fail build (throw error) on invalid date string', () => {
      const r1 = getMockReview('a', 'not-a-valid-date');
      expect(() => sortReviewsByPublishedAt([r1])).toThrow('Invalid published_at for review a');
    });
  });

  describe('groupReviewsByYearAndMonth', () => {
    it('should group reviews by year and month in descending order', () => {
      const r1 = getMockReview('a', '2026-07-15T00:00:00Z'); // 2026-07
      const r2 = getMockReview('b', '2026-08-01T00:00:00Z'); // 2026-08
      const r3 = getMockReview('c', '2025-12-10T00:00:00Z'); // 2025-12

      const grouped = groupReviewsByYearAndMonth([r1, r2, r3]);

      // Expect years descending
      expect(grouped.length).toBe(2);
      expect(grouped[0].year).toBe('2026');
      expect(grouped[1].year).toBe('2025');

      // Expect months descending in 2026
      expect(grouped[0].months.length).toBe(2);
      expect(grouped[0].months[0].monthName).toBe('August');
      expect(grouped[0].months[0].reviews[0].slug).toBe('b');
      expect(grouped[0].months[1].monthName).toBe('July');
      expect(grouped[0].months[1].reviews[0].slug).toBe('a');

      // Expect months in 2025
      expect(grouped[1].months.length).toBe(1);
      expect(grouped[1].months[0].monthName).toBe('December');
      expect(grouped[1].months[0].reviews[0].slug).toBe('c');
    });
  });

  describe('normalizeSearchText', () => {
    it('should lowercase the text', () => {
      expect(normalizeSearchText('RUST')).toBe('rust');
    });

    it('should collapse consecutive whitespaces', () => {
      expect(normalizeSearchText('rust    compiler  system')).toBe('rust compiler system');
    });

    it('should normalize Unicode NFKC', () => {
      expect(normalizeSearchText('ＡＩ')).toBe('ai');
    });
  });

  describe('buildReviewSearchText', () => {
    it('should build a normalized search text from review data', () => {
      const review = getMockReview('my-slug', '2026-07-15T00:00:00Z', 'My Product Name');
      const searchText = buildReviewSearchText(review);
      
      expect(searchText).toContain('my product name');
      expect(searchText).toContain('dev tools');
      expect(searchText).toContain('headline of test');
      expect(searchText).toContain('standfirst of test');
      expect(searchText).toContain('hacker news');
      expect(searchText).toContain('my-slug');
    });
  });
});
