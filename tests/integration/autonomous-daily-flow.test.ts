import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import { createRecommendationFixture } from '../fixtures/refined-review';
import {
  buildInitialRecord,
  buildUnavailableRecord,
  writeRecord,
  readRecord,
  recordPath,
  recordsDir
} from '../../src/lib/generation/record-store';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * The autonomous daily flow, exercised through the exact CLI entrypoints the private
 * `daily-publish.yml` workflow invokes:
 *
 *   generate (--generate-reserved) -> durable record on disk
 *   validate (--validate-record)   -> quality gate; on pass+autonomous, publishRecord()
 *                                     writes review.json and flips the record to published;
 *                                     on fail, the record becomes terminal `excluded`.
 *
 * These cases assert the §9 wiring contract: one Gemini call per run key, response-first
 * durability, a single review.json writer, quality failure as a green completed run, and
 * multi-publish independence with no candidate back-fill. Gemini is never reachable — an
 * offline-network guard turns any outbound call into a hard failure.
 */
describe('Autonomous daily flow (response-first CLI wiring)', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const offlineNetwork = pathToFileURL(path.join(__dirname, '..', 'helpers', 'offline-network.ts')).href;

  let contentRoot: string;
  let fixture: ReturnType<typeof createRecommendationFixture>;

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-autonomous-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(contentRoot, 'publication-state'), { recursive: true });
    fixture = createRecommendationFixture();
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  /** A v2 run-state at `generated`, carrying the evidence bundle and selection the CLI reads. */
  function seedRunState(runKey: string, status = 'generated'): void {
    const state = {
      schema_version: '2.0.0',
      data_class: 'production',
      status,
      run_key: runKey,
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '424242',
      reserved_at: '2026-07-17T00:00:00.000Z',
      updated_at: '2026-07-17T00:00:00.000Z',
      slug: 'recommended-product',
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
        collectedAt: '2026-07-17T00:00:00.000Z',
        metadata: {}
      },
      selection: fixture.selection,
      collection_result: fixture.context,
      // A 'failed' run-state must carry failure details (schema requirement); this mirrors the
      // surviving run-state of a pre-persistence failed run that a migration record replaces.
      ...(status === 'failed'
        ? {
          failure: {
            stage: 'evaluation',
            retryable: true,
            previous_status: 'generating',
            error_category: 'GENERATION_VALIDATION_FAILURE',
            failed_at: '2026-07-17T00:00:00.000Z'
          }
        }
        : {})
    };
    fs.writeFileSync(path.join(contentRoot, 'runs', `${runKey}.json`), JSON.stringify(state, null, 2));
  }

  /**
   * A durably-persisted generation record (response-first Phase 1 output). `content` chooses
   * the response body: the passing fixture, a body that fails a hard rule, or invalid JSON.
   */
  function seedRecord(runKey: string, content: 'pass' | 'invalid-json' | 'schema-invalid' = 'pass'): GenerationRecord {
    let rawResponse = JSON.stringify(fixture.generatedOutput);
    let originalContent: unknown = fixture.generatedOutput;
    if (content === 'invalid-json') {
      rawResponse = '{ this is not valid json';
      originalContent = null;
    } else if (content === 'schema-invalid') {
      // A body missing an entire required top-level section -> SCHEMA_VALIDATION_FAILED.
      const broken = JSON.parse(JSON.stringify(fixture.generatedOutput));
      delete broken.article;
      rawResponse = JSON.stringify(broken);
      originalContent = broken;
    }
    const record = buildInitialRecord({
      recordId: runKey,
      candidateId: 'refined-product-id',
      runKey,
      canonicalUrl: 'https://github.com/example/refined-product',
      candidateName: 'Refined Product',
      slug: 'recommended-product',
      receivedAt: '2026-07-17T00:00:00.000Z',
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

  // ── §9.1 — first response passes ────────────────────────────────────────────────
  it('validate-record on a passing autonomous record publishes exactly once', () => {
    const runKey = 'season-2-manual-900001';
    seedRunState(runKey);
    seedRecord(runKey, 'pass');

    const { status, stdout, stderr, outputs } = runCli(['--validate-record', '--run-key', runKey]);

    expect(status, stderr).toBe(0);
    expect(outputs.quality_status).toBe('passed');
    expect(outputs.publication_status).toBe('published');
    expect(outputs.new_published_articles).toBe('1');
    expect(stdout).toMatch(/autonomous published -> published/);

    const record = readRecord(contentRoot, runKey)!;
    expect(record.generation.status).toBe('succeeded');
    expect(record.quality.status).toBe('passed');
    expect(record.publication.status).toBe('published');
    // review.json exists exactly once, written only by publishRecord.
    expect(reviewJsonFiles()).toHaveLength(1);
  });

  // ── §9.2 — first response fails the quality bar ─────────────────────────────────
  it('a quality failure excludes the record, writes no review.json, and stays green', () => {
    const runKey = 'season-2-manual-900002';
    seedRunState(runKey);
    // A body missing an entire required section is a hard-fail the validator must reject.
    seedRecord(runKey, 'schema-invalid');

    const { status, stdout, outputs } = runCli(['--validate-record', '--run-key', runKey]);

    expect(status).toBe(0); // quality failure is a completed run, never a red workflow
    expect(outputs.quality_status).toBe('failed');
    expect(outputs.publication_status).toBe('excluded');
    expect(outputs.new_published_articles).toBe('0');
    expect(stdout).toMatch(/::warning/);

    const persisted = readRecord(contentRoot, runKey)!;
    expect(persisted.generation.status).toBe('succeeded'); // the raw response is still persisted
    expect(persisted.generation.rawResponse).not.toBeNull();
    expect(persisted.quality.status).toBe('failed');
    expect(persisted.quality.history.length).toBeGreaterThan(0);
    expect(persisted.publication.status).toBe('excluded');
    expect(reviewJsonFiles()).toHaveLength(0);
  });

  // ── §9.3 — invalid JSON response ────────────────────────────────────────────────
  it('an unparseable response is persisted, excluded, and never re-generated', () => {
    const runKey = 'season-2-manual-900003';
    seedRunState(runKey);
    seedRecord(runKey, 'invalid-json');

    const { status, outputs } = runCli(['--validate-record', '--run-key', runKey]);

    expect(status).toBe(0);
    expect(outputs.quality_status).toBe('failed');
    expect(outputs.publication_status).toBe('excluded');

    const persisted = readRecord(contentRoot, runKey)!;
    expect(persisted.generation.rawResponse).toBe('{ this is not valid json');
    expect(persisted.publication.status).toBe('excluded');
    expect(reviewJsonFiles()).toHaveLength(0);
  });

  // ── §9.4 — resume after persistence, before validation ──────────────────────────
  it('resume with a stored response never re-calls Gemini and resumes at validation', () => {
    const runKey = 'season-2-manual-900004';
    seedRunState(runKey);
    seedRecord(runKey, 'pass');

    // The generate phase must find the stored response and skip Gemini entirely.
    const generate = runCli(['--operation', 'resume_pending', '--trigger', 'manual', '--generate-reserved', '--run-key', runKey]);
    expect(generate.status, generate.stderr).toBe(0);
    expect(generate.stdout).toMatch(/already has a stored response/);
    expect(generate.outputs.generation_performed).toBe('false');

    // Validation then runs against the reused response and publishes.
    const validate = runCli(['--validate-record', '--run-key', runKey]);
    expect(validate.outputs.publication_status).toBe('published');
    expect(reviewJsonFiles()).toHaveLength(1);
  });

  // ── §9.5 — resume after validation, before publish side effects ─────────────────
  it('re-validating an already-published record is an idempotent no-op (no re-Gemini, no rewrite)', () => {
    const runKey = 'season-2-manual-900005';
    seedRunState(runKey);
    seedRecord(runKey, 'pass');

    const first = runCli(['--validate-record', '--run-key', runKey]);
    expect(first.outputs.publication_status).toBe('published');
    expect(reviewJsonFiles()).toHaveLength(1);
    const reviewPath = reviewJsonFiles()[0];
    const firstBytes = fs.readFileSync(reviewPath);

    // A resumed run re-enters validation; publishRecord's idempotency must not rewrite.
    const second = runCli(['--validate-record', '--run-key', runKey]);
    expect(second.status, second.stderr).toBe(0);
    expect(second.outputs.publication_status).toBe('published');
    expect(reviewJsonFiles()).toHaveLength(1);
    expect(fs.readFileSync(reviewPath).equals(firstBytes)).toBe(true);
  });

  // ── §9.6 — multi-publish: one passes, one fails, no back-fill ────────────────────
  it('two independent run keys publish/exclude independently with no candidate back-fill', () => {
    const passKey = 'season-2-manual-900006';
    const failKey = 'season-2-manual-900007';
    seedRunState(passKey);
    seedRecord(passKey, 'pass');
    seedRunState(failKey);
    seedRecord(failKey, 'invalid-json');

    const a = runCli(['--validate-record', '--run-key', passKey]);
    const b = runCli(['--validate-record', '--run-key', failKey]);

    expect(a.outputs.publication_status).toBe('published');
    expect(b.outputs.publication_status).toBe('excluded');
    expect(a.status).toBe(0);
    expect(b.status).toBe(0);

    // Exactly one article published; no third candidate was selected to make up the count.
    expect(reviewJsonFiles()).toHaveLength(1);
    const records = fs.readdirSync(recordsDir(contentRoot)).filter(f => f.endsWith('.json'));
    expect(records.sort()).toEqual([`${passKey}.json`, `${failKey}.json`].sort());
  });

  // ── §9.8 — unavailable migration record is terminal ─────────────────────────────
  it('an unavailable migration record is terminal: excluded, no content, not re-generated', () => {
    const runKey = 'season-2-manual-900008';
    const record = buildUnavailableRecord({
      recordId: runKey,
      candidateId: 'lost-candidate',
      runKey,
      canonicalUrl: 'https://github.com/example/lost',
      candidateName: 'Lost Candidate',
      slug: null,
      originalFailedAt: '2026-07-17T00:00:00.000Z',
      migratedAt: '2026-07-18T00:00:00.000Z',
      reason: 'Failed before response-first persistence.',
      recoveredFrom: ['runs-x.json'],
      notes: 'terminal'
    });
    writeRecord(contentRoot, record);

    const persisted = readRecord(contentRoot, runKey)!;
    expect(persisted.generation.status).toBe('unavailable');
    expect(persisted.generation.rawResponse).toBeNull();
    expect(persisted.publication.status).toBe('excluded');
    expect(reviewJsonFiles()).toHaveLength(0);
  });

  // ── B1 — excluded is strictly terminal: resume is a byte-level no-op ─────────────
  function sha256(file: string): string {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  }

  it('resuming an excluded run is a strict byte-level no-op (no Gemini, no validation, no review)', () => {
    const runKey = 'season-2-manual-900010';
    seedRunState(runKey);
    seedRecord(runKey, 'invalid-json');

    // Validate once → excluded (this is the terminal result).
    const excluded = runCli(['--validate-record', '--run-key', runKey]);
    expect(excluded.outputs.publication_status).toBe('excluded');
    const recordFile = recordPath(contentRoot, runKey);
    const shaBefore = sha256(recordFile);

    // Resume the exact run key. Gemini is unreachable (offline guard); a strict no-op must
    // not touch the record, the history, or write any review — and must stay green.
    const resume = runCli(['--operation', 'resume_pending', '--trigger', 'manual', '--generate-reserved', '--run-key', runKey]);

    expect(resume.status, resume.stderr).toBe(0);
    expect(resume.outputs.publication_status).toBe('excluded');
    expect(resume.outputs.generation_performed).toBe('false');
    // No Gemini call was made (no attempt log), no candidate selection, no validation.
    expect(resume.stdout).not.toMatch(/Attempt \d+ on (primary|fallback) route/);
    expect(resume.stdout).not.toMatch(/\[Reservation\] Reserved candidate/);
    expect(resume.stdout).toMatch(/terminal/i);
    // Record is byte-for-byte identical; history unchanged; still no review.json.
    expect(sha256(recordFile)).toBe(shaBefore);
    const record = readRecord(contentRoot, runKey)!;
    expect(record.publication.status).toBe('excluded');
    expect(reviewJsonFiles()).toHaveLength(0);
  });

  it('resuming an unavailable migration record is a strict byte-level no-op', () => {
    const runKey = 'season-2-manual-900011';
    seedRunState(runKey, 'failed');
    const record = buildUnavailableRecord({
      recordId: runKey,
      candidateId: 'lost-candidate',
      runKey,
      canonicalUrl: 'https://github.com/example/lost',
      candidateName: 'Lost Candidate',
      slug: null,
      originalFailedAt: '2026-07-17T00:00:00.000Z',
      migratedAt: '2026-07-18T00:00:00.000Z',
      reason: 'Failed before response-first persistence.',
      recoveredFrom: ['runs-x.json'],
      notes: 'terminal'
    });
    writeRecord(contentRoot, record);
    const recordFile = recordPath(contentRoot, runKey);
    const shaBefore = sha256(recordFile);

    const resume = runCli(['--operation', 'resume_pending', '--trigger', 'manual', '--generate-reserved', '--run-key', runKey]);

    expect(resume.status, resume.stderr).toBe(0);
    expect(resume.outputs.publication_status).toBe('excluded');
    expect(resume.stdout).not.toMatch(/Attempt \d+ on (primary|fallback) route/);
    expect(sha256(recordFile)).toBe(shaBefore);
    expect(reviewJsonFiles()).toHaveLength(0);
  });
});
