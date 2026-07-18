import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { createRecommendationFixture } from '../fixtures/refined-review';
import { runAstroBuild } from '../helpers/astro-build';

/**
 * Renders the real site once, in production data mode, over a content root containing a
 * single 2.1.0 review. Verifies the refined UI (RECOMMENDED NEXT STEP, no decisive
 * question) and that every versioned read surface (latest.json, RSS, rankings, archive
 * search text) accepts the 2.1.0 review.
 *
 * The legacy UI counterpart (DECISIVE QUESTION on 1.0.0 reviews, unchanged label) is
 * covered by the fixture-mode e2e suite over tests/fixtures/reviews/2026/07/fixture-product.
 */

let contentRoot: string;
let distDir: string;
let fixture: ReturnType<typeof createRecommendationFixture>;

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

describe('2.1.0 review rendering & versioned reads (real build)', () => {
  beforeAll(() => {
    const originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    try {
      fixture = createRecommendationFixture();
    } finally {
      process.env.JURYPRESS_DATA_MODE = originalMode;
    }
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-recommendation-ui-'));
    const { review, bundle, selection } = fixture;
    const reviewDir = path.join(contentRoot, 'reviews', '2026', '07', review.slug);
    writeJson(path.join(reviewDir, 'review.json'), review);
    writeJson(path.join(reviewDir, 'evidence.json'), bundle);
    writeJson(path.join(reviewDir, 'selection.json'), selection);
    writeJson(path.join(contentRoot, 'manifest.json'), { reviews: 1 });
    writeJson(path.join(contentRoot, 'publication-state', `${review.slug}.json`), {
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: selection.source_id,
      slug: review.slug,
      source_canonical_url: selection.canonical_url,
      selected_at: selection.selected_at,
      generated_at: review.published_at,
      generation_run_id: 'season-2-2026-07-16-daily',
      publication_status: 'validated'
    });

    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-recommendation-dist-'));
    runAstroBuild(distDir, {
      JURYPRESS_DATA_MODE: 'production',
      JURYPRESS_CONTENT_ROOT: contentRoot,
      JURYPRESS_SITE_URL: 'http://localhost:4321'
    });
  }, 300_000);

  afterAll(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  it('renders RECOMMENDED NEXT STEP (and no decisive question) on the 2.1.0 review page', () => {
    const html = fs.readFileSync(path.join(distDir, 'reviews', fixture.review.slug, 'index.html'), 'utf8');
    expect(html).toContain('RECOMMENDED NEXT STEP');
    expect(html).toContain('Publish a verified runtime result for perspective 1');
    expect(html).toContain('KEY STRENGTHS');
    expect(html).toContain('PRIMARY CONCERN');
    expect(html).not.toContain('DECISIVE QUESTION');
    // Criterion label and evidence ids are surfaced next to the action.
    expect(html).toContain('implementation evidence');
    expect(html).toContain('ev-source-1');
  });

  it('serves the 2.1.0 review through latest.json', () => {
    const latest = JSON.parse(fs.readFileSync(path.join(distDir, 'reviews', 'latest.json'), 'utf8'));
    expect(JSON.stringify(latest)).toContain(fixture.review.slug);
  });

  it('serves the 2.1.0 review through the RSS feed', () => {
    const rss = fs.readFileSync(path.join(distDir, 'rss.xml'), 'utf8');
    expect(rss).toContain(fixture.review.slug);
  });

  it('lists the 2.1.0 review in the rankings page', () => {
    const rankings = fs.readFileSync(path.join(distDir, 'rankings', 'index.html'), 'utf8');
    expect(rankings).toContain('Refined Product');
  });

  it('lists the 2.1.0 review in the review archive', () => {
    const archive = fs.readFileSync(path.join(distDir, 'reviews', 'index.html'), 'utf8');
    expect(archive).toContain(fixture.review.slug);
  });
});
