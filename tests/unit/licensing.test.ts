import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAllReviews } from '../../src/lib/data';
import { resolveContentRoot, resolveDataMode } from '../../src/lib/content-root';
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

  it('should resolve fixture mode and root', () => {
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    expect(resolveDataMode()).toBe('fixture');
    expect(resolveContentRoot()).toBe(path.resolve(process.cwd(), 'tests', 'fixtures'));
  });

  it('should resolve production mode and root', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = path.join(process.cwd(), 'tests', 'fixtures');
    expect(resolveDataMode()).toBe('production');
    expect(resolveContentRoot()).toBe(path.resolve(process.cwd(), 'tests', 'fixtures'));
  });

  it('should reject invalid data mode', () => {
    process.env.JURYPRESS_DATA_MODE = 'invalid-mode';
    expect(() => resolveDataMode()).toThrow('JURYPRESS_DATA_MODE must be explicitly set to fixture or production');
  });

  it('should reject path traversal in JURYPRESS_CONTENT_ROOT', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = '../etc/passwd';
    expect(() => resolveContentRoot()).toThrow('Directory traversal attempt detected');
  });

  it('should throw error in production mode when JURYPRESS_CONTENT_ROOT is missing', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    delete process.env.JURYPRESS_CONTENT_ROOT;

    expect(() => resolveContentRoot()).toThrow('JURYPRESS_CONTENT_ROOT is required in production mode');
  });

  it('should throw error in production mode when JURYPRESS_CONTENT_ROOT points to non-existent directory', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = path.join(__dirname, 'non-existent-directory-xyz');

    expect(() => resolveContentRoot()).toThrow('Production content root does not exist');
  });

  it('should throw error in production mode if a review with data_class="fixture" is loaded', () => {
    process.env.JURYPRESS_DATA_MODE = 'production';
    process.env.JURYPRESS_CONTENT_ROOT = path.join(process.cwd(), 'tests/fixtures');

    // Expected exception path change: resolveContentRoot passes, but reviewsDir resolved is tests/fixtures/reviews.
    // In fixture reviewsDir, there is fixture-product which has data_class: "fixture".
    expect(() => getAllReviews()).toThrow("Data classification mismatch for review fixture-product: expected 'production', found 'fixture'");
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
    review.content_license = 'all-rights-reserved';
    review.copyright_holder = 'Yosuke Suzuki';
    review.slug = 'temp-prod-review';

    const selection = JSON.parse(fs.readFileSync(selFixturePath, 'utf8'));
    selection.slug = 'temp-prod-review';
    selection.data_class = 'production';
    selection.source_id = 'github/temp-prod-review';
    selection.canonical_url = 'https://github.com/example/temp-prod-review';

    fs.writeFileSync(jsonPath, JSON.stringify(review));
    fs.writeFileSync(selPath, JSON.stringify(selection));

    try {
      expect(() => getAllReviews()).toThrow("Data classification mismatch for review temp-prod-review: expected 'fixture', found 'production'");
    } finally {
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      if (fs.existsSync(selPath)) fs.unlinkSync(selPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    }
  });

  it('should throw error when duplicate content ID is detected', () => {
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    
    // We create a temporary review directory
    const tempDir = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/temp-dup-review');
    const jsonPath = path.join(tempDir, 'review.json');
    const selPath = path.join(tempDir, 'selection.json');
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fixturePath = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/fixture-product/review.json');
    const selFixturePath = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/fixture-product/selection.json');

    const review = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    review.slug = 'temp-dup-review';

    const selection = JSON.parse(fs.readFileSync(selFixturePath, 'utf8'));
    selection.slug = 'temp-dup-review';
    // Duplicate the source_id from fixture-product which is already loaded
    selection.source_id = 'github/example/fixture';

    fs.writeFileSync(jsonPath, JSON.stringify(review));
    fs.writeFileSync(selPath, JSON.stringify(selection));

    try {
      expect(() => getAllReviews()).toThrow("Duplicate content ID detected: github/example/fixture");
    } finally {
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      if (fs.existsSync(selPath)) fs.unlinkSync(selPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    }
  });

  it('should throw error when duplicate canonical URL is detected', () => {
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    
    const tempDir = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/temp-dup-url');
    const jsonPath = path.join(tempDir, 'review.json');
    const selPath = path.join(tempDir, 'selection.json');
    
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }

    const fixturePath = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/fixture-product/review.json');
    const selFixturePath = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/fixture-product/selection.json');

    const review = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    review.slug = 'temp-dup-url';

    const selection = JSON.parse(fs.readFileSync(selFixturePath, 'utf8'));
    selection.slug = 'temp-dup-url';
    // Make content ID unique, but duplicate the canonical URL
    selection.source_id = 'github/unique-id-xyz';
    selection.canonical_url = 'https://github.com/example/fixture';

    fs.writeFileSync(jsonPath, JSON.stringify(review));
    fs.writeFileSync(selPath, JSON.stringify(selection));

    try {
      expect(() => getAllReviews()).toThrow("Duplicate canonical URL detected: https://github.com/example/fixture");
    } finally {
      if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
      if (fs.existsSync(selPath)) fs.unlinkSync(selPath);
      if (fs.existsSync(tempDir)) fs.rmdirSync(tempDir);
    }
  });
});
