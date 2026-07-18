import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRecommendationFixture } from '../fixtures/refined-review';

/**
 * End-to-end production gate over a 2.1.0 review, through the same validate-content CLI
 * the private workflow runs. This is the integration path the manual multi-publish
 * workflow exercises between generation and build.
 */
describe('Recommendation (2.1.0) publication gate CLI', () => {
  let contentRoot: string;
  let reviewPath: string;
  let validReview: any;

  beforeAll(() => {
    const originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'fixture';
    let fixture;
    try {
      fixture = createRecommendationFixture();
    } finally {
      process.env.JURYPRESS_DATA_MODE = originalMode;
    }
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-recommendation-gate-'));
    const { review, bundle, selection } = fixture;
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
      schema_version: '2.0.0', data_class: 'production', content_id: 'refined-product-id',
      slug: review.slug, source_canonical_url: 'https://github.com/example/refined-product',
      selected_at: '2026-07-16T00:00:00.000Z', generated_at: '2026-07-16T00:00:00.000Z',
      generation_run_id: 'season-2-2026-07-16-daily', run_key: 'season-2-2026-07-16-daily',
      trigger: 'manual', operation: 'publish_new', workflow_run_id: '123',
      publication_status: 'generated'
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

  it('succeeds for the 2.1.0 fixture and advances the publication state to validated', () => {
    const result = runValidator();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[JuryPress Validation] SUCCESS');
    const state = JSON.parse(fs.readFileSync(path.join(contentRoot, 'publication-state', `${validReview.slug}.json`), 'utf8'));
    expect(state.publication_status).toBe('validated');
    expect(state.run_key).toBe('season-2-2026-07-16-daily');
  });

  it('fails when a recommendation cites evidence that does not exist in the bundle', () => {
    const invalid = JSON.parse(JSON.stringify(validReview));
    // Untraceable grounding stays a hard failure. A citation that merely resolves to a
    // different-but-real evidence is warning-level and is covered in the unit tests.
    invalid.evaluation.judges[0].recommended_next_step.evidence_ids = ['ev-does-not-exist'];
    fs.writeFileSync(reviewPath, `${JSON.stringify(invalid, null, 2)}\n`);
    const result = runValidator();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Recommendation|Publication Gate/i);
    fs.writeFileSync(reviewPath, `${JSON.stringify(validReview, null, 2)}\n`);
  });

  it('fails when generation metadata disagrees with the top-level model', () => {
    const invalid = JSON.parse(JSON.stringify(validReview));
    invalid.generation_metadata.used_model = 'someone-elses-model';
    invalid.generation_metadata.requested_model = 'someone-elses-model';
    fs.writeFileSync(reviewPath, `${JSON.stringify(invalid, null, 2)}\n`);
    const result = runValidator();
    expect(result.status).not.toBe(0);
    fs.writeFileSync(reviewPath, `${JSON.stringify(validReview, null, 2)}\n`);
  });

  function bundlePath() {
    return path.join(contentRoot, 'reviews', '2026', '07', validReview.slug, 'evidence.json');
  }

  it('accepts CI-attested runnability when no manifest or container build exists', () => {
    const original = fs.readFileSync(bundlePath(), 'utf8');
    const bundle = JSON.parse(original);
    const api = bundle.evidences.find((e: any) => e.type === 'api_metadata');
    const summary = JSON.parse(api.summary);
    summary.presence = { package_manifest: false, container_build: false, workflows: true };
    api.summary = JSON.stringify(summary);
    // The README carries no run command, so only the CI route can attest runnability.
    bundle.evidences.find((e: any) => e.type === 'readme').summary = '# Refined Product\nA curated directory of things.';
    bundle.evidences.push({
      evidence_id: 'ev-ci', type: 'ci_workflow',
      url: 'https://raw.githubusercontent.com/example/refined-product/main/.github/workflows/tests.yml',
      title: 'tests.yml', retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: 'ci-hash',
      snapshot_id: 'snap-refined-fixture',
      summary: 'run: python -m pip install -r scripts/requirements.txt\nrun: python scripts/validate/format.py README.md',
      claims: [{ claim_id: 'ev-ci-default', text: 'CI executes repository scripts.', claim_type: 'repository_observation' }]
    });
    fs.writeFileSync(bundlePath(), `${JSON.stringify(bundle, null, 2)}\n`);
    const result = runValidator();
    fs.writeFileSync(bundlePath(), original);
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('[JuryPress Validation] SUCCESS');
  });

  it('still rejects a bundle with no runnability evidence at all', () => {
    const original = fs.readFileSync(bundlePath(), 'utf8');
    const bundle = JSON.parse(original);
    const api = bundle.evidences.find((e: any) => e.type === 'api_metadata');
    const summary = JSON.parse(api.summary);
    summary.presence = { package_manifest: false, container_build: false, workflows: false };
    api.summary = JSON.stringify(summary);
    bundle.evidences.find((e: any) => e.type === 'readme').summary = '# Refined Product\nA curated directory of things.';
    fs.writeFileSync(bundlePath(), `${JSON.stringify(bundle, null, 2)}\n`);
    const result = runValidator();
    fs.writeFileSync(bundlePath(), original);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/Missing runnability evidence/);
  });
});
