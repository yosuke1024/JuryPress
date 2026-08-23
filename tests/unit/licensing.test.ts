import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getAllReviews, loadReviewsFrom } from '../../src/lib/data';
import { resolveContentRoot, resolveDataMode } from '../../src/lib/content-root';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';

// The checks that need a deliberately invalid review get it in a throwaway content root, never
// in tests/fixtures. Vitest runs test files in parallel, and tests/fixtures is the tree every
// other fixture-mode test — and every fixture-mode `astro build` — reads: a planted review
// there kills whichever of them happens to be loading at the time, so planting had to be
// serialized behind the build lock, and waiting for that lock is what made this file flaky.

const FIXTURE_REVIEW_DIR = path.join(process.cwd(), 'tests/fixtures/reviews/2026/07/fixture-product');

function readFixtureFile(name: string): any {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_REVIEW_DIR, name), 'utf8'));
}

/**
 * Runs `fn` against a private content root holding a copy of the fixture review, so a planted
 * review sits next to a valid one exactly as it would in the real tree — the duplicate checks
 * need that neighbour to have anything to collide with.
 */
function withTempContentRoot(fn: (contentRoot: string) => void): void {
  const contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-licensing-'));
  try {
    fs.cpSync(FIXTURE_REVIEW_DIR, path.join(contentRoot, 'reviews', '2026', '07', 'fixture-product'), {
      recursive: true
    });
    fn(contentRoot);
  } finally {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  }
}

function plantReview(contentRoot: string, slug: string, review: any, selection: any): void {
  const dir = path.join(contentRoot, 'reviews', '2026', '07', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify(review));
  fs.writeFileSync(path.join(dir, 'selection.json'), JSON.stringify(selection));
}

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

    // Goes through getAllReviews() rather than loadReviewsFrom() so the env-to-content-root
    // wiring is covered too. It only reads tests/fixtures, so it needs no tree of its own:
    // fixture-product already carries data_class "fixture", which production mode must reject.
    expect(() => getAllReviews()).toThrow("Data classification mismatch for review fixture-product: expected 'production', found 'fixture'");
  });

  it('should throw error in fixture mode if a review has data_class="production"', () => {
    const review = readFixtureFile('review.json');
    review.data_class = 'production';
    review.content_license = 'all-rights-reserved';
    review.copyright_holder = 'Yosuke Suzuki';
    review.slug = 'temp-prod-review';

    const selection = readFixtureFile('selection.json');
    selection.slug = 'temp-prod-review';
    selection.data_class = 'production';
    selection.source_id = 'github/temp-prod-review';
    selection.canonical_url = 'https://github.com/example/temp-prod-review';

    withTempContentRoot(contentRoot => {
      plantReview(contentRoot, 'temp-prod-review', review, selection);

      expect(() => loadReviewsFrom('fixture', contentRoot)).toThrow("Data classification mismatch for review temp-prod-review: expected 'fixture', found 'production'");
    });
  });

  it('should throw error when duplicate content ID is detected', () => {
    const review = readFixtureFile('review.json');
    review.slug = 'temp-dup-review';

    const selection = readFixtureFile('selection.json');
    selection.slug = 'temp-dup-review';
    // Duplicate the source_id from fixture-product, which is loaded alongside it
    selection.source_id = 'github/example/fixture';

    withTempContentRoot(contentRoot => {
      plantReview(contentRoot, 'temp-dup-review', review, selection);

      expect(() => loadReviewsFrom('fixture', contentRoot)).toThrow("Duplicate content ID detected: github/example/fixture");
    });
  });

  it('should throw error when duplicate canonical URL is detected', () => {
    const review = readFixtureFile('review.json');
    review.slug = 'temp-dup-url';

    const selection = readFixtureFile('selection.json');
    selection.slug = 'temp-dup-url';
    // Make content ID unique, but duplicate the canonical URL
    selection.source_id = 'github/unique-id-xyz';
    selection.canonical_url = 'https://github.com/example/fixture';

    withTempContentRoot(contentRoot => {
      plantReview(contentRoot, 'temp-dup-url', review, selection);

      expect(() => loadReviewsFrom('fixture', contentRoot)).toThrow("Duplicate canonical URL detected: https://github.com/example/fixture");
    });
  });
});
