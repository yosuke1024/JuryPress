import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { getAllReviews } from '../../src/lib/data';

describe('Review Build Integration', () => {
  let originalMode: string | undefined;

  beforeAll(() => {
    originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'fixture';
  });

  afterAll(() => {
    process.env.JURYPRESS_DATA_MODE = originalMode;
  });

  it('should successfully load and parse all reviews in fixture mode', () => {
    const reviews = getAllReviews();
    
    // There should be at least the fixture-product
    expect(reviews.length).toBeGreaterThanOrEqual(1);
    
    const fixture = reviews.find(r => r.slug === 'fixture-product');
    expect(fixture).toBeDefined();
    
    if (fixture) {
      expect(fixture.review.schema_version).toBe('1.0.0');
      expect(fixture.selection.schema_version).toBe('1.0.0');
      expect(fixture.evidence.length).toBeGreaterThan(0);
      expect(fixture.review.evaluation.judges.length).toBe(5);
    }
  });
});
