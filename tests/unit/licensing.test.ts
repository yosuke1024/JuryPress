import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAllReviews } from '../../src/lib/data';
import * as path from 'path';
import * as fs from 'fs';

describe('Licensing & Content Separation Fail-Closed Tests', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should throw error in production mode when JURYPRESS_CONTENT_ROOT is missing', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    delete process.env.JURYPRESS_CONTENT_ROOT;

    expect(() => getAllReviews()).toThrow('JURYPRESS_CONTENT_ROOT environment variable is required in production mode');
  });

  it('should throw error in production mode when JURYPRESS_CONTENT_ROOT points to non-existent directory', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = path.join(__dirname, 'non-existent-directory-xyz');

    expect(() => getAllReviews()).toThrow('Production content root reviews directory does not exist or is not a directory');
  });

  it('should throw error in production mode if a review with data_class="fixture" is loaded', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = path.join(process.cwd(), 'tests/fixtures');

    expect(() => getAllReviews()).toThrow("Data classification mismatch for fixture-product: expected 'production', found 'fixture'");
  });

  it('should throw error in fixture mode if a review has data_class="production"', () => {
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    
    const tempDir = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/temp-prod-review');
    const jsonPath = path.join(tempDir, 'review.json');
    const selPath = path.join(tempDir, 'selection.json');
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fixturePath = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/fixture-product/review.json');
    const selFixturePath = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/fixture-product/selection.json');

    const review = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    review.data_class = 'production';
    review.slug = 'temp-prod-review';

    const selection = JSON.parse(fs.readFileSync(selFixturePath, 'utf8'));
    selection.slug = 'temp-prod-review';

    fs.writeFileSync(jsonPath, JSON.stringify(review));
    fs.writeFileSync(selPath, JSON.stringify(selection));

    try {
      expect(() => getAllReviews()).toThrow("Data classification mismatch for temp-prod-review: expected 'fixture', found 'production'");
    } finally {
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      if (fs.existsSync(selPath)) fs.unlinkSync(selPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    }
  });
});
