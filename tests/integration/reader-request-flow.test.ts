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
  recordsDir
} from '../../src/lib/generation/record-store';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * The publish_request flow, exercised through the exact CLI entrypoints the extended
 * daily-publish.yml workflow invokes. Asserts the request-specific wiring contract:
 *
 *   - one run key per issue (season-<n>-request-<issue>), so one issue can never create
 *     two generation records,
 *   - duplicate prevention declines BEFORE any reservation or network call,
 *   - a resumed request run reuses the stored response and never re-calls Gemini,
 *   - a published request re-dispatch is a clean no-op that only re-reports the article,
 *   - a terminal excluded request stays terminal (quality exclusion is never re-run),
 *   - the published selection.json carries reader-request provenance.
 *
 * The offline-network guard makes any Gemini/API call a hard failure.
 */
describe('Reader request flow (publish_request CLI wiring)', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const offlineNetwork = pathToFileURL(path.join(__dirname, '..', 'helpers', 'offline-network.ts')).href;

  const ISSUE_NUMBER = 900123;
  const RUN_KEY = `season-2-request-${ISSUE_NUMBER}`;
  const ISSUE_URL = `https://github.com/yosuke1024/JuryPress/issues/${ISSUE_NUMBER}`;
  const CANONICAL_URL = 'https://github.com/example/refined-product';

  let contentRoot: string;
  let fixture: ReturnType<typeof createRecommendationFixture>;

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-request-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'publication-state'), { recursive: true });
    fixture = createRecommendationFixture();
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  function readerRequestSelection(runKey: string, issueNumber: number) {
    return {
      ...fixture.selection,
      run_key: runKey,
      source: 'reader_request',
      source_rank: null,
      selection_rule: 'Operator-approved reader review request via GitHub Issue',
      source_url: `https://github.com/yosuke1024/JuryPress/issues/${issueNumber}`,
      human_selected: true,
      selection_mode: 'reader-request',
      selected_by: 'operator',
      request_provenance: {
        request_id: '7f9c1c3a-2f6e-4a44-9d3c-2b1f5a8e9d10',
        issue_number: issueNumber,
        issue_url: `https://github.com/yosuke1024/JuryPress/issues/${issueNumber}`,
        requester_relationship: 'user'
      }
    };
  }

  function seedRequestRunState(runKey: string, issueNumber: number, status = 'generated'): void {
    const state = {
      schema_version: '2.0.0',
      data_class: 'production',
      status,
      run_key: runKey,
      trigger: 'manual',
      operation: 'publish_request',
      workflow_run_id: '424242',
      reserved_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z',
      slug: 'recommended-product',
      candidate_reservation: {
        content_id: 'refined-product-id',
        canonical_url: CANONICAL_URL,
        candidate_name: 'Refined Product'
      },
      candidate: {
        name: 'Refined Product',
        canonicalUrl: CANONICAL_URL,
        sourceUrl: CANONICAL_URL,
        source: 'reader_request',
        sourceId: 'refined-product-id',
        sourceRank: 0,
        popularityValue: 10,
        popularityUnit: 'stars',
        collectedAt: '2026-07-18T00:00:00.000Z',
        metadata: {}
      },
      selection: readerRequestSelection(runKey, issueNumber),
      collection_result: fixture.context
    };
    fs.writeFileSync(path.join(contentRoot, 'runs', `${runKey}.json`), JSON.stringify(state, null, 2));
  }

  function seedRecord(runKey: string, content: 'pass' | 'invalid-json' = 'pass'): GenerationRecord {
    let rawResponse = JSON.stringify(fixture.generatedOutput);
    let originalContent: unknown = fixture.generatedOutput;
    if (content === 'invalid-json') {
      rawResponse = '{ this is not valid json';
      originalContent = null;
    }
    const record = buildInitialRecord({
      recordId: runKey,
      candidateId: 'refined-product-id',
      runKey,
      canonicalUrl: CANONICAL_URL,
      candidateName: 'Refined Product',
      slug: 'recommended-product',
      receivedAt: '2026-07-18T00:00:00.000Z',
      model: 'fixture-model',
      modelVersion: 'fixture-model',
      promptVersion: '2.1.0',
      promptHash: 'a'.repeat(64),
      rawResponse,
      originalContent,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, thinkingTokens: null, cachedInputTokens: null },
      route: {
        requestedModel: 'fixture-model', thinkingLevel: 'HIGH', successfulRoute: 'primary',
        failoverUsed: false, primaryAttempts: 1, fallbackAttempts: 0, totalAttempts: 1, charactersSentToModel: 10
      }
    });
    return writeRecord(contentRoot, record);
  }

  function writeCandidateFile(issueNumber: number, canonicalUrl = CANONICAL_URL, sourceId = 'refined-product-id'): string {
    const filePath = path.join(contentRoot, `request-candidate-${issueNumber}.json`);
    const file = {
      schema_version: '1.0.0',
      generated_at: '2026-07-18T00:00:00.000Z',
      issue: {
        repo: 'yosuke1024/JuryPress',
        number: issueNumber,
        url: `https://github.com/yosuke1024/JuryPress/issues/${issueNumber}`
      },
      request: {
        request_id: '7f9c1c3a-2f6e-4a44-9d3c-2b1f5a8e9d10',
        requester_relationship: 'user'
      },
      candidate: {
        source: 'reader_request',
        sourceId,
        name: 'Refined Product',
        canonicalUrl,
        sourceUrl: canonicalUrl,
        sourceRank: 0,
        popularityValue: 10,
        popularityUnit: 'stars',
        collectedAt: '2026-07-18T00:00:00.000Z',
        metadata: {}
      },
      source_metrics: [{
        platform: 'github',
        metric: 'stars',
        value: 10,
        source_url: canonicalUrl,
        retrieved_at: '2026-07-18T00:00:00.000Z'
      }]
    };
    fs.writeFileSync(filePath, JSON.stringify(file, null, 2));
    return filePath;
  }

  /** A minimal published review on disk, enough for duplicate detection. */
  function seedPublishedReview(slug: string, canonicalUrl: string): void {
    const dir = path.join(contentRoot, 'reviews', '2026', '06', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'selection.json'), JSON.stringify({ canonical_url: canonicalUrl }, null, 2));
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ published_at: '2026-06-01T00:00:00.000Z' }, null, 2));
  }

  function runCli(args: string[]) {
    const outputFile = path.join(contentRoot, `gh-output-${Math.abs(hashArgs(args))}.txt`);
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
        DRY_RUN: 'false'
      },
      encoding: 'utf8'
    });
    const outputs = parseGithubOutput(fs.existsSync(outputFile) ? fs.readFileSync(outputFile, 'utf8') : '');
    return { ...result, outputs };
  }

  function hashArgs(args: string[]): number {
    let h = 0;
    for (const c of args.join(' ')) h = (h * 31 + c.charCodeAt(0)) | 0;
    return h;
  }

  function parseGithubOutput(text: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) out[line.slice(0, eq)] = line.slice(eq + 1);
    }
    return out;
  }

  function reviewJsonFiles(): string[] {
    const reviews = path.join(contentRoot, 'reviews');
    if (!fs.existsSync(reviews)) return [];
    const found: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name === 'review.json') found.push(p);
      }
    };
    walk(reviews);
    return found;
  }

  it('a resumed request run reuses the stored response and never re-calls Gemini', () => {
    seedRequestRunState(RUN_KEY, ISSUE_NUMBER);
    seedRecord(RUN_KEY, 'pass');

    const generate = runCli([
      '--operation', 'publish_request', '--issue-number', String(ISSUE_NUMBER),
      '--trigger', 'manual', '--generate-reserved', '--run-key', RUN_KEY
    ]);

    expect(generate.status, generate.stderr).toBe(0);
    expect(generate.stdout).toMatch(/already has a stored response/);
    expect(generate.outputs.generation_performed).toBe('false');
    expect(generate.outputs.run_key).toBe(RUN_KEY);
    expect(generate.stdout).not.toMatch(/Attempt \d+ on (primary|fallback) route/);
  });

  it('validate publishes the request and selection.json carries reader-request provenance', () => {
    seedRequestRunState(RUN_KEY, ISSUE_NUMBER);
    seedRecord(RUN_KEY, 'pass');

    const validate = runCli(['--validate-record', '--run-key', RUN_KEY]);

    expect(validate.status, validate.stderr).toBe(0);
    expect(validate.outputs.quality_status).toBe('passed');
    expect(validate.outputs.publication_status).toBe('published');
    expect(validate.outputs.new_published_articles).toBe('1');

    const reviews = reviewJsonFiles();
    expect(reviews).toHaveLength(1);
    const selectionPath = path.join(path.dirname(reviews[0]), 'selection.json');
    const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
    expect(selection.selection_mode).toBe('reader-request');
    expect(selection.selected_by).toBe('operator');
    expect(selection.human_selected).toBe(true);
    expect(selection.source).toBe('reader_request');
    expect(selection.source_rank).toBeNull();
    expect(selection.source_url).toBe(ISSUE_URL);
    expect(selection.request_provenance.issue_number).toBe(ISSUE_NUMBER);

    // The published review itself is standard: no request-specific score adjustment
    // exists anywhere, so the review must be indistinguishable from a daily one.
    const review = JSON.parse(fs.readFileSync(reviews[0], 'utf8'));
    expect(review.relationship).toBe('independent');
    expect(typeof review.ranking_eligible).toBe('boolean');
  });

  it('re-dispatching a published request is a clean no-op that re-reports the article', () => {
    seedRequestRunState(RUN_KEY, ISSUE_NUMBER);
    seedRecord(RUN_KEY, 'pass');

    // The workflow sequence: generate (reuses the stored response and writes the
    // publication state) -> validate (publishes) -> state sync to published.
    const generate = runCli([
      '--operation', 'publish_request', '--issue-number', String(ISSUE_NUMBER),
      '--trigger', 'manual', '--generate-reserved', '--run-key', RUN_KEY
    ]);
    expect(generate.status, generate.stderr).toBe(0);

    const first = runCli(['--validate-record', '--run-key', RUN_KEY]);
    expect(first.outputs.publication_status).toBe('published');

    // Mark the run state itself published (what the workflow's state-sync step does).
    const sync = runCli(['--operation', 'publish_request', '--issue-number', String(ISSUE_NUMBER), '--update-status', 'published', '--slug', 'recommended-product']);
    expect(sync.status, sync.stderr).toBe(0);

    const candidateFile = writeCandidateFile(ISSUE_NUMBER);
    const redispatch = runCli([
      '--operation', 'publish_request', '--issue-number', String(ISSUE_NUMBER),
      '--trigger', 'manual', '--reserve-only', '--request-candidate', candidateFile
    ]);

    expect(redispatch.status, redispatch.stderr).toBe(0);
    expect(redispatch.outputs.publication_status).toBe('published');
    expect(redispatch.outputs.proceed).toBe('false');
    expect(redispatch.outputs.slug).toBe('recommended-product');
    expect(redispatch.outputs.generation_performed).toBe('false');
    expect(reviewJsonFiles()).toHaveLength(1);
  });

  it('declines a request whose canonical URL already has a published review, before any reservation', () => {
    seedPublishedReview('already-reviewed-abc123', CANONICAL_URL);
    const issue = 900124;
    const candidateFile = writeCandidateFile(issue);

    const reserve = runCli([
      '--operation', 'publish_request', '--issue-number', String(issue),
      '--trigger', 'manual', '--reserve-only', '--request-candidate', candidateFile
    ]);

    expect(reserve.status, reserve.stderr).toBe(0);
    expect(reserve.outputs.request_declined).toBe('true');
    expect(reserve.outputs.decline_reason_codes).toBe('duplicate_published');
    expect(reserve.outputs.duplicate_slug).toBe('already-reviewed-abc123');
    expect(reserve.outputs.proceed).toBe('false');
    // No reservation was created — the run key stays free of state.
    expect(fs.existsSync(path.join(contentRoot, 'runs', `season-2-request-${issue}.json`))).toBe(false);
  });

  it('declines a request that conflicts with an active reservation', () => {
    // A daily run holds the candidate (reserved, non-terminal).
    const dailyState = {
      schema_version: '2.0.0',
      data_class: 'production',
      status: 'reserved',
      run_key: 'season-2-2026-07-18-daily',
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '11111',
      reserved_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z',
      candidate_reservation: {
        content_id: 'refined-product-id',
        canonical_url: CANONICAL_URL,
        candidate_name: 'Refined Product'
      }
    };
    fs.writeFileSync(path.join(contentRoot, 'runs', 'season-2-2026-07-18-daily.json'), JSON.stringify(dailyState, null, 2));

    const issue = 900125;
    const candidateFile = writeCandidateFile(issue);
    const reserve = runCli([
      '--operation', 'publish_request', '--issue-number', String(issue),
      '--trigger', 'manual', '--reserve-only', '--request-candidate', candidateFile
    ]);

    expect(reserve.status, reserve.stderr).toBe(0);
    expect(reserve.outputs.request_declined).toBe('true');
    expect(reserve.outputs.decline_reason_codes).toBe('duplicate_active_request');
    expect(fs.existsSync(path.join(contentRoot, 'runs', `season-2-request-${issue}.json`))).toBe(false);
  });

  it('a quality-excluded request is terminal: re-dispatch is a strict no-op reporting excluded', () => {
    seedRequestRunState(RUN_KEY, ISSUE_NUMBER);
    seedRecord(RUN_KEY, 'invalid-json');

    const excluded = runCli(['--validate-record', '--run-key', RUN_KEY]);
    expect(excluded.status, excluded.stderr).toBe(0);
    expect(excluded.outputs.publication_status).toBe('excluded');
    expect(reviewJsonFiles()).toHaveLength(0);

    const candidateFile = writeCandidateFile(ISSUE_NUMBER);
    const redispatch = runCli([
      '--operation', 'publish_request', '--issue-number', String(ISSUE_NUMBER),
      '--trigger', 'manual', '--reserve-only', '--request-candidate', candidateFile
    ]);

    expect(redispatch.status, redispatch.stderr).toBe(0);
    expect(redispatch.outputs.publication_status).toBe('excluded');
    expect(redispatch.outputs.proceed).toBe('false');
    expect(redispatch.stdout).toMatch(/terminal/i);
    expect(redispatch.stdout).not.toMatch(/Attempt \d+ on (primary|fallback) route/);
    const record = readRecord(contentRoot, RUN_KEY)!;
    expect(record.publication.status).toBe('excluded');
    expect(reviewJsonFiles()).toHaveLength(0);
  });

  it('rejects a run key that does not match the dispatched issue number', () => {
    const candidateFile = writeCandidateFile(ISSUE_NUMBER);
    const result = runCli([
      '--operation', 'publish_request', '--issue-number', String(ISSUE_NUMBER),
      '--trigger', 'manual', '--reserve-only', '--request-candidate', candidateFile,
      '--run-key', 'season-2-request-777'
    ]);
    expect(result.status).not.toBe(0);
    expect(result.stderr + result.stdout).toMatch(/does not match the issue-derived run key/);
  });
});
