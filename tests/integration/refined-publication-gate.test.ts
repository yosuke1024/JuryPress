import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRefinedFixture } from '../fixtures/refined-review';

describe('Refined publication gate CLI', () => {
  let contentRoot: string;
  let reviewPath: string;
  let validReview: any;

  beforeAll(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-refined-'));
    const { review, bundle, selection } = createRefinedFixture();
    validReview = review;
    const reviewDir = path.join(contentRoot, 'reviews', '2026', '07', review.slug);
    fs.mkdirSync(reviewDir, { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'publication-state'), { recursive: true });
    reviewPath = path.join(reviewDir, 'review.json');
    fs.writeFileSync(reviewPath, `${JSON.stringify(review, null, 2)}\n`);
    fs.writeFileSync(path.join(reviewDir, 'evidence.json'), `${JSON.stringify(bundle, null, 2)}\n`);
    fs.writeFileSync(path.join(reviewDir, 'selection.json'), `${JSON.stringify(selection, null, 2)}\n`);
    fs.writeFileSync(path.join(contentRoot, 'manifest.json'), `${JSON.stringify({ data_class: 'production', initialized: true, reviews: 1 }, null, 2)}\n`);
    fs.writeFileSync(path.join(contentRoot, 'publication-state', `${review.slug}.json`), `${JSON.stringify({
      schema_version: '1.0.0', data_class: 'production', content_id: 'refined-product-id',
      slug: review.slug, source_canonical_url: 'https://github.com/example/refined-product',
      selected_at: '2026-07-16T00:00:00.000Z', generated_at: '2026-07-16T00:00:00.000Z',
      generation_run_id: 'season-2-2026-07-16', publication_status: 'generated'
    }, null, 2)}\n`);
  });

  afterAll(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  function runValidator() {
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/validate-content.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        JURYPRESS_DATA_MODE: 'production',
        JURYPRESS_CONTENT_ROOT: contentRoot,
        JURYPRESS_SITE_URL: 'http://localhost:4321'
      },
      encoding: 'utf8'
    });
  }

  it('succeeds for the Phase 1 refined fixture', () => {
    const result = runValidator();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[JuryPress Validation] SUCCESS');
  });

  it('fails for an invalid Phase 1 refined fixture', () => {
    const invalid = JSON.parse(JSON.stringify(validReview));
    invalid.evaluation.metadata_snapshot.stars = 999;
    fs.writeFileSync(reviewPath, `${JSON.stringify(invalid, null, 2)}\n`);
    const result = runValidator();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Snapshot content mismatch/i);
  });
});
