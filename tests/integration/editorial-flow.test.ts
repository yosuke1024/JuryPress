import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createEditorialFixture } from '../fixtures/refined-review';
import {
  buildInitialRecord,
  contentHash,
  readRecord,
  writeRecord,
  recordsDir
} from '../../src/lib/generation/record-store';
import { prepareEdit } from '../../src/lib/generation/review-edit';
import { publishRecord } from '../../src/lib/generation/publish';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * The editorial-first flow end to end, through the real CLI, with Gemini unreachable.
 *
 * The property under test is the one the whole redesign rests on: an evidence-mapping
 * failure — which is what an offline network guarantees here — must produce a PUBLISHED
 * article with no map, never an excluded one. If this suite ever goes red by excluding an
 * article, the record-keeping has taken the article hostage again.
 */
describe('Editorial flow (V3) — mapping never gates publication', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const offlineNetwork = pathToFileURL(path.join(__dirname, '..', 'helpers', 'offline-network.ts')).href;

  let contentRoot: string;
  let fixture: ReturnType<typeof createEditorialFixture>;

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-editorial-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'publication-state'), { recursive: true });
    fixture = createEditorialFixture();
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  const RUN_KEY = 'season-2-2026-07-19-daily';
  const SLUG = 'editorial-product';

  function seedRunState(): void {
    const state = {
      schema_version: '2.0.0',
      data_class: 'production',
      status: 'generated',
      run_key: RUN_KEY,
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '515151',
      reserved_at: '2026-07-19T00:00:00.000Z',
      updated_at: '2026-07-19T00:00:00.000Z',
      slug: SLUG,
      candidate_reservation: {
        content_id: 'refined-product-id',
        canonical_url: 'https://github.com/example/refined-product',
        candidate_name: 'Refined Product'
      },
      candidate: {
        name: 'Refined Product',
        canonicalUrl: 'https://github.com/example/refined-product',
        sourceUrl: 'https://github.com/example/refined-product',
        source: 'github',
        sourceId: 'refined-product-id',
        sourceRank: 1,
        popularityValue: 10,
        popularityUnit: 'stars',
        collectedAt: '2026-07-19T00:00:00.000Z',
        metadata: {}
      },
      selection: fixture.selection,
      collection_result: fixture.context
    };
    fs.writeFileSync(path.join(contentRoot, 'runs', `${RUN_KEY}.json`), JSON.stringify(state, null, 2));
  }

  /** A persisted editorial generation: prompt version 4.0.0 is the pipeline's dispatch key. */
  function seedRecord(content: unknown = fixture.generatedOutput): GenerationRecord {
    const record = buildInitialRecord({
      recordId: RUN_KEY,
      candidateId: 'refined-product-id',
      runKey: RUN_KEY,
      canonicalUrl: 'https://github.com/example/refined-product',
      candidateName: 'Refined Product',
      slug: SLUG,
      receivedAt: '2026-07-19T00:00:00.000Z',
      model: 'fixture-model',
      modelVersion: 'fixture-model',
      promptVersion: '4.0.0',
      promptHash: 'a'.repeat(64),
      rawResponse: JSON.stringify(content),
      originalContent: content,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, thinkingTokens: null, cachedInputTokens: null },
      route: {
        requestedModel: 'fixture-model', thinkingLevel: 'HIGH', successfulRoute: 'primary',
        failoverUsed: false, primaryAttempts: 1, fallbackAttempts: 0, totalAttempts: 1, charactersSentToModel: 10
      }
    });
    return writeRecord(contentRoot, record);
  }

  function runCli(args: string[]) {
    const outputFile = path.join(contentRoot, `gh-output-${args.join('-').replace(/[^a-z0-9-]/gi, '')}.txt`);
    fs.writeFileSync(outputFile, '');
    const result = spawnSync(process.execPath, [
      '--import', 'tsx',
      '--import', offlineNetwork,
      'scripts/run-daily.ts', ...args, '--github-output', outputFile
    ], {
      cwd: repoRoot,
      env: {
        ...process.env,
        JURYPRESS_DATA_MODE: 'production',
        JURYPRESS_CONTENT_ROOT: contentRoot,
        JURYPRESS_SITE_URL: 'http://localhost:4321',
        // Present but unusable: the offline guard fails any outbound call, which is exactly
        // the mapping-failure condition under test.
        GEMINI_API_KEY: 'test-primary-key-value',
        GEMINI_FALLBACK_API_KEY: 'test-fallback-key-value',
        GEMINI_PRIMARY_MAX_ATTEMPTS: '1',
        GEMINI_FALLBACK_MAX_ATTEMPTS: '1',
        DRY_RUN: 'false'
      },
      encoding: 'utf8'
    });
    const outputs: Record<string, string> = {};
    for (const line of (fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '').split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) outputs[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return { ...result, outputs };
  }

  function reviewDir(): string {
    return path.join(contentRoot, 'reviews', '2026', '07', SLUG);
  }

  it('publishes without an evidence map when mapping cannot run', () => {
    seedRunState();
    seedRecord();

    const result = runCli(['--validate-record', '--run-key', RUN_KEY]);

    // A record-keeping failure is a green run with a published article.
    expect(result.status).toBe(0);
    expect(result.outputs.quality_status).toBe('passed');
    expect(result.outputs.publication_status).toBe('published');
    expect(result.outputs.evidence_mapping_status).toBe('failed');
    expect(result.outputs.published_without_evidence_map).toBe('true');

    // The article exists; the map does not, and the review says so honestly.
    expect(fs.existsSync(path.join(reviewDir(), 'review.json'))).toBe(true);
    expect(fs.existsSync(path.join(reviewDir(), 'evidence-map.json'))).toBe(false);
    const review = JSON.parse(fs.readFileSync(path.join(reviewDir(), 'review.json'), 'utf8'));
    expect(review.schema_version).toBe('3.0.0');
    expect(review.evidence_map_status).toBe('unavailable');
  });

  it('records the mapping failure on the record without touching the article', () => {
    seedRunState();
    const seeded = seedRecord();
    const originalHash = contentHash(seeded.editorial.currentContent);

    runCli(['--validate-record', '--run-key', RUN_KEY]);

    const record = readRecord(contentRoot, RUN_KEY)!;
    expect(record.evidenceMapping?.status).toBe('failed');
    expect(record.evidenceMapping?.map).toBeNull();
    expect(record.evidenceMapping?.failureCategory).toBeTruthy();
    // The judgment is exactly what the model produced; mapping cannot edit it.
    expect(contentHash(record.generation.originalContent)).toBe(originalHash);
    expect(record.quality.status).toBe('passed');
  });

  it('publishes an editorial article with no audit apparatus in the evaluation', () => {
    seedRunState();
    seedRecord();
    runCli(['--validate-record', '--run-key', RUN_KEY]);

    const review = JSON.parse(fs.readFileSync(path.join(reviewDir(), 'review.json'), 'utf8'));
    const evaluation = review.evaluation;

    expect(evaluation.claim_references).toBeUndefined();
    expect(evaluation.public_statement_annotations).toBeUndefined();
    expect(evaluation.confidence_adjustments).toBeUndefined();
    expect(evaluation.evaluation_integrity_version).toBeUndefined();
    expect(evaluation.article.evidence_classifications).toBeUndefined();
    for (const judge of evaluation.judges) {
      for (const criterion of judge.criteria) {
        expect(criterion.evidence_ids).toBeUndefined();
      }
      expect(judge.decisive_question).toBeUndefined();
    }
    // Scores are still recomputed by code — the independence claim is untouched.
    expect(review.provenance.recalculated_by_code).toBe(true);
    expect(typeof evaluation.recalculated_jury_score).toBe('number');
  });

  it('keeps the article live-safe through an edit: a stale map is dropped, not shown', () => {
    seedRunState();
    seedRecord();
    runCli(['--validate-record', '--run-key', RUN_KEY]);

    // Attach a map bound to the published content, as a successful mapping would.
    const published = readRecord(contentRoot, RUN_KEY)!;
    const boundHash = contentHash(published.editorial.currentContent);
    // The CLI published it just now; that timestamp is the one a correction must preserve.
    const firstPublishedAt = published.publication.publishedAt as string;
    const withMap: GenerationRecord = {
      ...published,
      evidenceMapping: {
        status: 'succeeded',
        attemptedAt: '2026-07-19T01:00:00.000Z',
        articleHash: boundHash,
        mappingPromptVersion: '1.0.0',
        model: 'mapping-model',
        modelVersion: 'mapping-model',
        failureCategory: null,
        usage: null,
        map: {
          map_schema_version: '1.0.0',
          article_hash: boundHash,
          mapping_prompt_version: '1.0.0',
          mapped_at: '2026-07-19T01:00:00.000Z',
          model: 'mapping-model',
          status: 'complete',
          claims: [],
          unmapped_statements: [],
          contradictions: [],
          evidence_usage: []
        }
      }
    };
    writeRecord(contentRoot, withMap);
    publishRecord({
      contentRoot,
      recordId: RUN_KEY,
      expectedContentHash: boundHash,
      collectionResult: fixture.context,
      selection: fixture.selection,
      seasonConfig: JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'season.json'), 'utf8')),
      publishedAt: '2026-07-19T01:00:00.000Z'
    });
    expect(fs.existsSync(path.join(reviewDir(), 'evidence-map.json'))).toBe(true);

    // Now a human corrects the prose. The map is bound to the OLD text.
    const opened = prepareEdit(readRecord(contentRoot, RUN_KEY)!, {
      reason: 'Fix a typo in the standfirst.',
      editedAt: '2026-07-19T02:00:00.000Z'
    });
    const edited = JSON.parse(JSON.stringify(opened.record.editorial.currentContent));
    edited.article.standfirst = 'A corrected standfirst that says something slightly different.';
    writeRecord(contentRoot, {
      ...opened.record,
      editorial: { ...opened.record.editorial, currentContent: edited }
    });

    // The record is open for editing, but the live page is unaffected: review.json still
    // holds the last validated version until an explicit republish replaces it.
    const editing = readRecord(contentRoot, RUN_KEY)!;
    expect(editing.publication.status).toBe('editing');
    expect(fs.existsSync(path.join(reviewDir(), 'review.json'))).toBe(true);
    // The original publication date survives: a correction is not a new article.
    expect(editing.publication.publishedAt).toBe(firstPublishedAt);

    // Re-validate and republish; the stale map must be removed rather than shown.
    runCli(['--validate-record', '--run-key', RUN_KEY]);
    const revalidated = readRecord(contentRoot, RUN_KEY)!;
    expect(revalidated.quality.status).toBe('passed');

    publishRecord({
      contentRoot,
      recordId: RUN_KEY,
      expectedContentHash: revalidated.quality.validatedContentHash as string,
      collectionResult: fixture.context,
      selection: fixture.selection,
      seasonConfig: JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'season.json'), 'utf8')),
      publishedAt: '2026-07-19T03:00:00.000Z'
    });

    expect(fs.existsSync(path.join(reviewDir(), 'evidence-map.json'))).toBe(false);
    const review = JSON.parse(fs.readFileSync(path.join(reviewDir(), 'review.json'), 'utf8'));
    expect(review.evidence_map_status).toBe('unavailable');
    expect(review.evaluation.article.standfirst).toBe(edited.article.standfirst);
    // The correction did not re-date the article.
    // published_at is formatted to second precision, so compare at that granularity.
    expect(new Date(review.published_at).toISOString().slice(0, 19))
      .toBe(new Date(firstPublishedAt).toISOString().slice(0, 19));
  });

  it('a failed remap keeps the existing map instead of stripping it from the live page', async () => {
    seedRunState();
    seedRecord();
    runCli(['--validate-record', '--run-key', RUN_KEY]);

    // Give the record a successful map bound to the published content.
    const published = readRecord(contentRoot, RUN_KEY)!;
    const boundHash = contentHash(published.editorial.currentContent);
    writeRecord(contentRoot, {
      ...published,
      evidenceMapping: {
        status: 'succeeded',
        attemptedAt: '2026-07-19T01:00:00.000Z',
        articleHash: boundHash,
        mappingPromptVersion: '1.0.0',
        model: 'mapping-model',
        modelVersion: 'mapping-model',
        failureCategory: null,
        usage: null,
        map: {
          map_schema_version: '1.0.0',
          article_hash: boundHash,
          mapping_prompt_version: '1.0.0',
          mapped_at: '2026-07-19T01:00:00.000Z',
          model: 'mapping-model',
          status: 'complete',
          claims: [],
          unmapped_statements: [],
          contradictions: [],
          evidence_usage: []
        }
      }
    });

    // Re-map with the network offline: the request fails. A transient failure must not be
    // able to delete a good map — otherwise re-dispatching the workflow meant to REPAIR a
    // map is the very thing that destroys the one already published.
    const { mapEvidenceAndPersist } = await import('../../src/lib/generation/pipeline');
    process.env.GEMINI_API_KEY = 'test-primary-key-value';
    process.env.GEMINI_FALLBACK_API_KEY = 'test-fallback-key-value';
    process.env.GEMINI_PRIMARY_MAX_ATTEMPTS = '1';
    process.env.GEMINI_FALLBACK_MAX_ATTEMPTS = '1';
    const result = await mapEvidenceAndPersist({
      contentRoot,
      recordId: RUN_KEY,
      evidences: fixture.context.evidences
    });

    expect(result.status).toBe('failed');
    const after = readRecord(contentRoot, RUN_KEY)!;
    expect(after.evidenceMapping?.status).toBe('succeeded');
    expect(after.evidenceMapping?.map).not.toBeNull();
    expect(after.evidenceMapping?.articleHash).toBe(boundHash);
  });
});
