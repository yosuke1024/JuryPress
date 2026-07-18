import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRecommendationFixture } from '../fixtures/refined-review';
import { buildInitialRecord, recordsDir, contentHash } from '../../src/lib/generation/record-store';
import { validateContent, applyVerdict } from '../../src/lib/generation/validator';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * The publish CLI's per-record commit verification: a commit that touches OTHER records or
 * unrelated files must not block a safe publish of the target. This is the concurrency
 * property that a blanket "expected SHA === HEAD" check would break for multi-publish.
 */
describe('publish-record CLI — per-record commit verification', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  let contentRoot: string;
  let gitRepo: string;
  const fixture = createRecommendationFixture();

  const idA = 'season-2-manual-810001';
  const slugA = 'recommended-product';

  function git(...args: string[]): string {
    return execFileSync('git', ['-C', gitRepo, ...args], { encoding: 'utf8' }).trim();
  }

  function seedRunState(id: string, slug: string) {
    const runState = {
      schema_version: '2.0.0', data_class: 'production', status: 'generated', run_key: id,
      trigger: 'manual', operation: 'publish_new', workflow_run_id: id.split('-').pop(),
      reserved_at: '2026-07-17T00:00:00.000Z', updated_at: '2026-07-17T00:00:00.000Z',
      candidate_reservation: { content_id: 'refined-product-id', canonical_url: 'https://github.com/example/refined-product', candidate_name: 'Refined Product' },
      candidate: { source: 'show_hn', sourceId: 'refined-product-id', name: 'Refined Product', canonicalUrl: 'https://github.com/example/refined-product', sourceUrl: 'https://github.com/example/refined-product', sourceRank: 1, popularityValue: 42, popularityUnit: 'stars', publishedAt: '2026-01-01T00:00:00Z', collectedAt: '2026-07-17T00:00:00.000Z', metadata: {} },
      collection_result: fixture.context, selection: { ...fixture.selection, run_key: id }
    };
    fs.writeFileSync(path.join(contentRoot, 'runs', `${id}.json`), `${JSON.stringify(runState, null, 2)}\n`);
  }

  /** A validated (quality passed, ready) record on disk. */
  function seedValidatedRecord(id: string, slug: string): GenerationRecord {
    let record = buildInitialRecord({
      recordId: id, candidateId: 'refined-product-id', runKey: id,
      canonicalUrl: 'https://github.com/example/refined-product', candidateName: 'Refined Product', slug,
      receivedAt: '2026-07-17T00:00:00.000Z', model: 'fixture-model', modelVersion: 'fixture-model',
      promptVersion: '2.1.0', promptHash: 'a'.repeat(64),
      rawResponse: JSON.stringify(fixture.generatedOutput), originalContent: fixture.generatedOutput,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, thinkingTokens: null, cachedInputTokens: null },
      route: { requestedModel: 'fixture-model', thinkingLevel: 'HIGH', successfulRoute: 'primary', failoverUsed: false, primaryAttempts: 1, fallbackAttempts: 0, totalAttempts: 1, charactersSentToModel: 10 }
    });
    const verdict = validateContent({ content: fixture.generatedOutput, originalContent: fixture.generatedOutput, evidences: fixture.context.evidences, humanEdited: false });
    record = applyVerdict(record, verdict, '2026-07-17T00:10:00.000Z');
    fs.writeFileSync(path.join(recordsDir(contentRoot), `${id}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  function runPublish(id: string, sha: string, hash: string) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/publish-record.ts',
      '--id', id, '--expected-commit-sha', sha, '--expected-content-hash', hash], {
      cwd: repoRoot,
      env: { ...process.env, JURYPRESS_DATA_MODE: 'production', JURYPRESS_CONTENT_ROOT: contentRoot },
      encoding: 'utf8'
    });
  }

  beforeEach(() => {
    gitRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-publish-cli-'));
    contentRoot = path.join(gitRepo, 'data');
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'runs'), { recursive: true });
    git('init');
    git('config', 'user.email', 't@t.co');
    git('config', 'user.name', 't');
  });

  afterEach(() => {
    fs.rmSync(gitRepo, { recursive: true, force: true });
  });

  it('publishes the target even though HEAD moved on for an unrelated commit', () => {
    const record = seedValidatedRecord(idA, slugA);
    seedRunState(idA, slugA);
    git('add', '-A');
    git('commit', '-m', 'validated A');
    const shaAtValidation = git('rev-parse', 'HEAD');
    const hash = record.quality.validatedContentHash as string;

    // An unrelated commit moves HEAD (a different record, an unrelated file — here a stray file).
    fs.writeFileSync(path.join(gitRepo, 'UNRELATED.txt'), 'noise');
    git('add', '-A');
    git('commit', '-m', 'unrelated change');
    expect(git('rev-parse', 'HEAD')).not.toBe(shaAtValidation);

    // Publish A against the commit that described A's validated content. Per-record
    // verification tolerates HEAD having moved for the unrelated commit.
    const result = runPublish(idA, shaAtValidation, hash);
    expect(result.status).toBe(0);
    expect(fs.existsSync(path.join(contentRoot, 'reviews', '2026', '07', slugA, 'review.json'))).toBe(true);
  });

  it('refuses to publish and writes nothing when the content hash does not match', () => {
    const record = seedValidatedRecord(idA, slugA);
    seedRunState(idA, slugA);
    git('add', '-A');
    git('commit', '-m', 'validated A');
    const sha = git('rev-parse', 'HEAD');

    const result = runPublish(idA, sha, 'f'.repeat(64));
    expect(result.status).toBe(1);
    // No public artifact was produced on a gate failure.
    expect(fs.existsSync(path.join(contentRoot, 'reviews'))).toBe(false);
    const onDisk = JSON.parse(fs.readFileSync(path.join(recordsDir(contentRoot), `${idA}.json`), 'utf8'));
    expect(onDisk.publication.status).not.toBe('published');
  });
});
