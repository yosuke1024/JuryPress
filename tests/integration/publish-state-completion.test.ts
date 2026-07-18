import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRecommendationFixture } from '../fixtures/refined-review';
import {
  buildInitialRecord,
  writeRecord,
  readRecord,
  contentHash,
  recordsDir
} from '../../src/lib/generation/record-store';
import { validateAndPersist } from '../../src/lib/generation/pipeline';
import { buildReviewFromRecord } from '../../src/lib/generation/build-review';
import { publishRecord, PublishGateError } from '../../src/lib/generation/publish';
import { prepareEdit } from '../../src/lib/generation/review-edit';
import { readRunState, readPublicationState } from '../../src/lib/publication/state-store';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * Manual publish completes the run/publication lifecycle (B3), and the publish gate's commit
 * guard runs even on the already-published path (B5). Exercised at the service + CLI layer the
 * way publish-record.yml drives it: publishRecord() writes review.json and flips the record to
 * published, then `run-daily --update-status published` syncs the publication-state and
 * run-state — and only that, never a second review.json writer.
 */
describe('Manual publish state completion + commit guard', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const offlineNetwork = pathToFileURL(path.join(__dirname, '..', 'helpers', 'offline-network.ts')).href;
  const recordId = 'season-2-manual-880001';
  const slug = 'recommended-product';

  let contentRoot: string;
  let fixture: ReturnType<typeof createRecommendationFixture>;

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-publish-state-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'publication-state'), { recursive: true });
    fixture = createRecommendationFixture();
  });
  afterEach(() => fs.rmSync(contentRoot, { recursive: true, force: true }));

  const seasonConfig = { season: 2 };

  function seedRunState(): void {
    fs.writeFileSync(path.join(contentRoot, 'runs', `${recordId}.json`), JSON.stringify({
      schema_version: '2.0.0', data_class: 'production', status: 'generated', run_key: recordId,
      trigger: 'manual', operation: 'publish_new', workflow_run_id: '880001',
      reserved_at: '2026-07-17T00:00:00.000Z', updated_at: '2026-07-17T00:00:00.000Z', slug,
      candidate_reservation: { content_id: 'refined-product-id', canonical_url: 'https://github.com/example/refined-product', candidate_name: 'Refined Product' },
      candidate: { name: 'Refined Product', canonicalUrl: 'https://github.com/example/refined-product', sourceUrl: 'x', source: 'github', sourceId: 'refined-product-id', sourceRank: 1, popularityValue: 10, popularityUnit: 'stars', collectedAt: '2026-07-17T00:00:00.000Z', metadata: {} },
      selection: fixture.selection, collection_result: fixture.context
    }, null, 2));
  }

  function seedPublicationState(): void {
    fs.writeFileSync(path.join(contentRoot, 'publication-state', `${slug}.json`), JSON.stringify({
      schema_version: '2.0.0', data_class: 'production', content_id: 'refined-product-id', slug,
      source_canonical_url: 'https://github.com/example/refined-product',
      selected_at: '2026-07-17T00:00:00.000Z', generated_at: '2026-07-17T00:00:00.000Z',
      generation_run_id: recordId, run_key: recordId, trigger: 'manual', operation: 'publish_new',
      workflow_run_id: '880001', publication_status: 'generated'
    }, null, 2));
  }

  /** Seed a record and validate it to a passing, publishable state (quality.status=passed). */
  function seedValidatedRecord(): GenerationRecord {
    const record = buildInitialRecord({
      recordId, candidateId: 'refined-product-id', runKey: recordId, canonicalUrl: 'https://github.com/example/refined-product',
      candidateName: 'Refined Product', slug, receivedAt: '2026-07-17T00:00:00.000Z',
      model: 'fixture-model', modelVersion: 'fixture-model', promptVersion: '2.1.0', promptHash: 'a'.repeat(64),
      rawResponse: JSON.stringify(fixture.generatedOutput), originalContent: fixture.generatedOutput,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, thinkingTokens: null, cachedInputTokens: null },
      route: { requestedModel: 'fixture-model', thinkingLevel: 'HIGH', successfulRoute: 'primary', failoverUsed: false, primaryAttempts: 1, fallbackAttempts: 0, totalAttempts: 1, charactersSentToModel: 10 }
    });
    writeRecord(contentRoot, record);
    validateAndPersist({
      contentRoot, recordId, evidences: fixture.context.evidences,
      buildPublishedContent: content => {
        buildReviewFromRecord({ record: readRecord(contentRoot, recordId)!, collectionResult: fixture.context, seasonConfig, date: new Date('2026-07-17T00:00:00.000Z'), content });
      }
    });
    return readRecord(contentRoot, recordId)!;
  }

  function publish(guard?: (r: GenerationRecord) => void) {
    const record = readRecord(contentRoot, recordId)!;
    return publishRecord({
      contentRoot, recordId, expectedContentHash: record.quality.validatedContentHash as string,
      collectionResult: fixture.context, selection: fixture.selection, seasonConfig,
      publishedAt: '2026-07-17T02:00:00.000Z', date: new Date('2026-07-17T00:00:00.000Z'),
      assertRecordUnchanged: guard
    });
  }

  function updateStatusPublished() {
    return spawnSync(process.execPath, [
      '--import', 'tsx', '--import', offlineNetwork,
      'scripts/run-daily.ts', '--update-status', 'published', '--slug', slug
    ], {
      cwd: repoRoot,
      env: { ...process.env, JURYPRESS_DATA_MODE: 'production', JURYPRESS_CONTENT_ROOT: contentRoot, JURYPRESS_SITE_URL: 'http://localhost:4321' },
      encoding: 'utf8'
    });
  }

  function reviewJson(): string {
    // publishRecord writes into reviews/<year>/<month>/<slug>/review.json.
    const found: string[] = [];
    const walk = (d: string) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (e.name === 'review.json') found.push(p); } };
    const reviews = path.join(contentRoot, 'reviews');
    if (fs.existsSync(reviews)) walk(reviews);
    return found[0];
  }

  // ── B3 item 5 — publish success drives record + publication-state + run-state to published ─
  it('a successful manual publish leaves record, publication-state and run-state all published', () => {
    seedRunState();
    seedPublicationState();
    seedValidatedRecord();

    const result = publish();
    expect(result.alreadyPublished).toBe(false);
    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');

    const sync = updateStatusPublished();
    expect(sync.status, sync.stderr).toBe(0);

    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');
    expect((readPublicationState(contentRoot, slug) as any).publication_status).toBe('published');
    expect((readRunState(contentRoot, recordId) as any).status).toBe('published');
  });

  // ── B3 item 6 — recover from a deploy failure by re-dispatch (real workflow order) ────────
  // The real workflow syncs state ONLY after a successful deploy. This test models that order:
  // publish → (deploy fails, so NO state sync) → re-dispatch publish (idempotent) → deploy
  // succeeds → state sync → converge.
  it('re-dispatch after a deploy failure converges idempotently to published', () => {
    seedRunState();
    seedPublicationState();
    seedValidatedRecord();

    // 1. publishRecord runs: the record + review.json are published.
    publish();
    const reviewPath = reviewJson();
    const reviewBytes = fs.readFileSync(reviewPath);

    // 2-3. Deploy fails, so the state-sync step is never reached: the record is published but
    // run-state and publication-state remain `generated`.
    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');
    expect((readPublicationState(contentRoot, slug) as any).publication_status).toBe('generated');
    expect((readRunState(contentRoot, recordId) as any).status).toBe('generated');

    // 4-5. Re-dispatch: the publish gate is idempotent (already published), no review is
    // rewritten.
    const second = publish();
    expect(second.alreadyPublished).toBe(true);
    expect(second.writtenPaths).toHaveLength(0);
    expect(fs.readFileSync(reviewPath).equals(reviewBytes)).toBe(true);

    // 6-7. Deploy succeeds this time, then state sync converges every axis to published.
    const sync = updateStatusPublished();
    expect(sync.status, sync.stderr).toBe(0);
    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');
    expect((readPublicationState(contentRoot, slug) as any).publication_status).toBe('published');
    expect((readRunState(contentRoot, recordId) as any).status).toBe('published');
  });

  // ── B6 crash-recovery — re-validating an already-published record counts 0 new articles ───
  it('validate-record on an already-published record (generated states) reports 0 new published', () => {
    seedRunState();
    seedPublicationState();
    seedValidatedRecord();

    // Publish once; deploy then fails, so run-state / publication-state stay `generated`.
    publish();
    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');
    expect((readRunState(contentRoot, recordId) as any).status).toBe('generated');
    expect((readPublicationState(contentRoot, slug) as any).publication_status).toBe('generated');
    const reviewPath = reviewJson();
    const reviewBytes = fs.readFileSync(reviewPath);

    // Re-dispatch runs --validate-record again. publishRecord is an already-published no-op, so
    // this is NOT a new publication: the count is 0 in both the CLI output and the summary.
    const outputFile = path.join(contentRoot, 'gh-output.txt');
    const summaryFile = path.join(contentRoot, 'summary.md');
    fs.writeFileSync(outputFile, '');
    fs.writeFileSync(summaryFile, '');
    const res = spawnSync(process.execPath, [
      '--import', 'tsx', '--import', offlineNetwork,
      'scripts/run-daily.ts', '--validate-record', '--run-key', recordId, '--github-output', outputFile
    ], {
      cwd: repoRoot,
      env: { ...process.env, JURYPRESS_DATA_MODE: 'production', JURYPRESS_CONTENT_ROOT: contentRoot, JURYPRESS_SITE_URL: 'http://localhost:4321', GITHUB_STEP_SUMMARY: summaryFile },
      encoding: 'utf8'
    });
    expect(res.status, res.stderr).toBe(0);
    expect(res.stdout).toMatch(/already published \(idempotent no-op\)/);

    const outputs: Record<string, string> = {};
    for (const line of fs.readFileSync(outputFile, 'utf8').split('\n')) {
      const eq = line.indexOf('='); if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    expect(outputs.publication_status).toBe('published');
    expect(outputs.new_published_articles).toBe('0');
    expect(fs.readFileSync(summaryFile, 'utf8')).toMatch(/New published articles: 0/);
    // review.json was not rewritten.
    expect(fs.readFileSync(reviewPath).equals(reviewBytes)).toBe(true);
  });

  // ── B5 item 8 — the commit guard runs even on the already-published path ─────────────────
  it('runs the commit guard before the idempotent early return, even when already published', () => {
    seedRunState();
    seedPublicationState();
    seedValidatedRecord();

    // Publish once so the record is already published.
    publish();
    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');

    // A failing commit guard (e.g. a bad/nonexistent expected commit SHA) must abort even
    // though the record is already published — no false "already published" success.
    const failingGuard = () => { throw new PublishGateError('expected commit does not describe this record'); };
    expect(() => publish(failingGuard)).toThrow(PublishGateError);

    // A passing guard on the already-published record is the idempotent no-op.
    let called = false;
    const passingGuard = () => { called = true; };
    const result = publish(passingGuard);
    expect(called).toBe(true);
    expect(result.alreadyPublished).toBe(true);
  });

  // ── B6 item 9 — a human-edited record held at `ready` counts 0 new published articles ─────
  it('reports New published articles: 0 for a human-edited record that validates to ready', () => {
    seedRunState();
    // Autonomous record → validate to a passing `ready`, then exclude and open a human edit.
    seedValidatedRecord();
    let record = readRecord(contentRoot, recordId)!;
    // Force the excluded state a real quality failure would produce, so an edit can be opened.
    writeRecord(contentRoot, {
      ...record,
      quality: {
        ...record.quality, status: 'failed',
        errors: [{ code: 'CLAIM_PROVENANCE_MISSING', path: '$.article.summary', message: 'seeded', severity: 'error', ruleVersion: '2.0.0' }],
        history: [
          ...record.quality.history,
          { validationId: 'seed-fail', revision: 0, contentHash: contentHash(record.editorial.currentContent), checkedAt: '2026-07-17T00:30:00.000Z', validatorVersion: '2.0.0', status: 'failed', errors: [{ code: 'CLAIM_PROVENANCE_MISSING', path: '$.article.summary', message: 'seeded', severity: 'error', ruleVersion: '2.0.0' }], warnings: [] }
        ]
      },
      publication: { status: 'excluded', reason: 'quality_validation_failed', publishedAt: null }
    });
    const edit = prepareEdit(readRecord(contentRoot, recordId)!, { reason: 'reword only', editedAt: '2026-07-17T01:00:00.000Z' });
    writeRecord(contentRoot, edit.record);
    expect(readRecord(contentRoot, recordId)!.editorial.mode).toBe('human_edited');

    // Validate through the CLI with a step summary attached.
    const summaryFile = path.join(contentRoot, 'summary.md');
    fs.writeFileSync(summaryFile, '');
    const res = spawnSync(process.execPath, [
      '--import', 'tsx', '--import', offlineNetwork,
      'scripts/run-daily.ts', '--validate-record', '--run-key', recordId
    ], {
      cwd: repoRoot,
      env: { ...process.env, JURYPRESS_DATA_MODE: 'production', JURYPRESS_CONTENT_ROOT: contentRoot, JURYPRESS_SITE_URL: 'http://localhost:4321', GITHUB_STEP_SUMMARY: summaryFile },
      encoding: 'utf8'
    });
    expect(res.status, res.stderr).toBe(0);

    const finalRecord = readRecord(contentRoot, recordId)!;
    expect(finalRecord.quality.status).toBe('passed');
    expect(finalRecord.publication.status).toBe('ready'); // held, never auto-published
    // The summary counts by FINAL publication status, not quality: a passing `ready` is 0.
    const summary = fs.readFileSync(summaryFile, 'utf8');
    expect(summary).toMatch(/New published articles: 0/);
    // And no review.json was materialized (validation never publishes).
    expect(reviewJson()).toBeUndefined();
  });
});
