import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync, spawnSync } from 'child_process';
import { TimezoneUtil } from '../../src/lib/timezone';

/**
 * Run-key based idempotency of scripts/run-daily.ts, exercised as a subprocess exactly the
 * way the private workflow invokes it. The historical "pick up any pending publication
 * state" behaviour is gone: every resume is addressed by its run key.
 */
describe('Idempotency Integration (run-key based)', () => {
  const repoRoot = path.join(__dirname, '..', '..');
  const targetDate = new Date('2026-07-14T00:15:00Z');
  const seasonData = JSON.parse(fs.readFileSync(path.join(repoRoot, 'config', 'season.json'), 'utf8'));
  const dailyRunKey = TimezoneUtil.getRunKey(seasonData.season, targetDate);

  let tempContentRoot: string;

  beforeEach(() => {
    tempContentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-idempotency-'));
    fs.mkdirSync(path.join(tempContentRoot, 'runs'), { recursive: true });
    fs.mkdirSync(path.join(tempContentRoot, 'publication-state'), { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tempContentRoot, { recursive: true, force: true });
  });

  function runDaily(args: string[], envOverrides: Record<string, string> = {}) {
    return spawnSync(process.execPath, ['--import', 'tsx', 'scripts/run-daily.ts', ...args], {
      cwd: repoRoot,
      env: {
        ...process.env,
        JURYPRESS_DATA_MODE: 'production',
        JURYPRESS_CONTENT_ROOT: tempContentRoot,
        TARGET_DATE: targetDate.toISOString(),
        DRY_RUN: 'false',
        ...envOverrides
      },
      encoding: 'utf8'
    });
  }

  function writeRunStateFile(runKey: string, state: Record<string, unknown>) {
    fs.writeFileSync(path.join(tempContentRoot, 'runs', `${runKey}.json`), JSON.stringify(state, null, 2));
  }

  function v2State(runKey: string, status: string, extra: Record<string, unknown> = {}) {
    return {
      schema_version: '2.0.0',
      data_class: 'production',
      status,
      run_key: runKey,
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '999',
      reserved_at: '2026-07-14T00:00:00.000Z',
      updated_at: '2026-07-14T00:00:00.000Z',
      candidate_reservation: {
        content_id: 'github/rerun-test-project',
        canonical_url: 'https://github.com/github/rerun-test-project',
        candidate_name: 'Rerun Test Project'
      },
      candidate: {
        name: 'Rerun Test Project',
        canonicalUrl: 'https://github.com/github/rerun-test-project',
        sourceUrl: 'https://github.com/github/rerun-test-project',
        source: 'github',
        sourceId: 'github/rerun-test-project',
        sourceRank: 1,
        popularityValue: 10,
        popularityUnit: 'stars',
        collectedAt: '2026-07-14T00:00:00.000Z',
        metadata: {}
      },
      selection: {
        selected_at: '2026-07-14T00:00:00.000Z',
        source_id: 'github/rerun-test-project'
      },
      ...extra
    };
  }

  function writeReviewFor(slug: string) {
    const yearMonth = TimezoneUtil.getJSTYearMonth(targetDate);
    const dir = path.join(tempContentRoot, 'reviews', yearMonth.year, yearMonth.month, slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ slug, marker: 'existing-review' }));
  }

  /**
   * Seeds a stored Gemini response for a run. This — not the presence of a review — is what
   * makes a resumed run skip generation: the response exists from the moment it arrives,
   * whereas a review only appears if validation passed.
   */
  function writeRecordFor(runKey: string, slug: string, overrides: Record<string, unknown> = {}) {
    const dir = path.join(tempContentRoot, 'generations');
    fs.mkdirSync(dir, { recursive: true });
    const now = '2026-07-16T00:00:00.000Z';
    const record = {
      schemaVersion: 1,
      recordId: runKey,
      candidate: { id: 'src-1', runKey, canonicalUrl: 'https://example.invalid/repo', name: 'Test Project' },
      slug,
      generation: {
        status: 'succeeded',
        receivedAt: now,
        model: 'gemini-test',
        modelVersion: 'gemini-test-001',
        promptVersion: '2.1.0',
        promptHash: 'a'.repeat(64),
        rawResponse: '{"stored":"response"}',
        originalContent: { stored: 'response' },
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2, thinkingTokens: null, cachedInputTokens: null },
        route: {
          requestedModel: 'gemini-test',
          thinkingLevel: 'HIGH',
          successfulRoute: 'primary',
          failoverUsed: false,
          primaryAttempts: 1,
          fallbackAttempts: 0,
          totalAttempts: 1,
          charactersSentToModel: 100
        }
      },
      editorial: {
        mode: 'autonomous',
        currentRevision: 0,
        currentContent: { stored: 'response' },
        revisions: [{ revision: 0, source: 'gemini', createdAt: now, contentHash: 'b'.repeat(64) }]
      },
      quality: {
        status: 'pending',
        checkedAt: null,
        validatorVersion: null,
        validatedRevision: null,
        validatedContentHash: null,
        errors: [],
        warnings: [],
        repairs: []
      },
      publication: { status: 'pending', reason: null, publishedAt: null },
      ...overrides
    };
    fs.writeFileSync(path.join(dir, `${runKey}.json`), JSON.stringify(record, null, 2));
  }

  it('scheduled: published run is a clean no-op (legacy 1.0.0 state)', () => {
    writeRunStateFile(dailyRunKey, {
      schema_version: '1.0.0',
      data_class: 'production',
      status: 'published',
      run_key: dailyRunKey,
      slug: 'test-slug'
    });

    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    const result = runDaily(['--github-output', outputPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Run ${dailyRunKey} is already published. Exiting cleanly.`);

    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain('publication_status=published');
    expect(outputs).toContain('generation_performed=false');
    expect(outputs).toContain('next_stage=none');
    expect(outputs).toContain(`run_key=${dailyRunKey}`);
  });

  it('scheduled retry: reuses the reserved candidate and never re-runs the selector or Gemini when a response is already stored', () => {
    const slug = 'rerun-test-project-abc123';
    writeRunStateFile(dailyRunKey, v2State(dailyRunKey, 'reserved', { slug }));
    writeRecordFor(dailyRunKey, slug);
    writeReviewFor(slug);

    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    // No network access is possible here: if the selector or Gemini were invoked the
    // subprocess would fail (no API keys, no fetch targets).
    const result = runDaily(['--github-output', outputPath]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reusing reserved candidate');
    expect(result.stdout).toContain('Skipping Gemini generation');

    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain(`slug=${slug}`);
    expect(outputs).toContain('content_id=github/rerun-test-project');
    expect(outputs).toContain('generation_performed=false');
    expect(outputs).toContain('resumed=true');
    expect(outputs).toContain('reservation_created=false');

    // The run state advanced monotonically to generated.
    const runState = JSON.parse(fs.readFileSync(path.join(tempContentRoot, 'runs', `${dailyRunKey}.json`), 'utf8'));
    expect(runState.status).toBe('generated');
    expect(runState.schema_version).toBe('2.0.0');
  });

  it('manual publish_new: derives the run key from GITHUB_RUN_ID (re-runs resume the same run)', () => {
    const manualKey = `season-${seasonData.season}-manual-424242`;
    writeRunStateFile(manualKey, v2State(manualKey, 'published', { trigger: 'manual', slug: 'done-slug' }));

    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    const result = runDaily(
      ['--operation', 'publish_new', '--trigger', 'manual', '--github-output', outputPath],
      { GITHUB_RUN_ID: '424242', GITHUB_RUN_ATTEMPT: '7' }
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Run ${manualKey} is already published.`);
    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain(`run_key=${manualKey}`);
    // run_attempt=7 had no effect on the key.
    expect(outputs).not.toContain('manual-424242-7');
  });

  it('reserve-only resume: reports the reservation without generating', () => {
    writeRunStateFile(dailyRunKey, v2State(dailyRunKey, 'reserved'));
    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    const result = runDaily(['--reserve-only', '--github-output', outputPath]);
    expect(result.status).toBe(0);
    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain('reservation_created=false');
    expect(outputs).toContain('resumed=true');
    expect(outputs).toContain('next_stage=generate');
    expect(outputs).toContain('generation_performed=false');
  });

  it('resume_pending: resumes exactly the requested run, ignoring other pending runs', () => {
    const runA = `season-${seasonData.season}-manual-111`;
    const runB = `season-${seasonData.season}-manual-222`;
    const slugA = 'project-a-aaaaaa';
    writeRunStateFile(runA, v2State(runA, 'generated', {
      trigger: 'manual',
      slug: slugA,
      candidate_reservation: {
        content_id: 'example/project-a',
        canonical_url: 'https://github.com/example/project-a',
        candidate_name: 'Project A'
      }
    }));
    writeRunStateFile(runB, v2State(runB, 'generated', { trigger: 'manual', slug: 'project-b-bbbbbb' }));
    writeRecordFor(runA, slugA);
    writeReviewFor(slugA);
    fs.writeFileSync(path.join(tempContentRoot, 'publication-state', `${slugA}.json`), JSON.stringify({
      schema_version: '2.0.0',
      data_class: 'production',
      content_id: 'example/project-a',
      slug: slugA,
      source_canonical_url: 'https://github.com/example/project-a',
      selected_at: '2026-07-14T00:00:00.000Z',
      generated_at: '2026-07-14T00:05:00.000Z',
      generation_run_id: runA,
      run_key: runA,
      trigger: 'manual',
      operation: 'publish_new',
      workflow_run_id: '111',
      publication_status: 'committed'
    }));

    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    const result = runDaily([
      '--operation', 'resume_pending', '--trigger', 'manual', '--run-key', runA,
      '--github-output', outputPath
    ]);
    expect(result.status).toBe(0);

    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain(`run_key=${runA}`);
    expect(outputs).toContain(`slug=${slugA}`);
    // committed content resumes at deploy, not at generation or validation.
    expect(outputs).toContain('publication_status=committed');
    expect(outputs).toContain('next_stage=deploy');
    expect(outputs).toContain('generation_performed=false');

    // Run B was left untouched.
    const runBState = JSON.parse(fs.readFileSync(path.join(tempContentRoot, 'runs', `${runB}.json`), 'utf8'));
    expect(runBState.status).toBe('generated');
  });

  // Required regression 2: the SAME failed run resumes with its stored candidate — the
  // reservation survives failure and is reused via the run key, never via re-selection.
  it('resume_pending: a failed run reuses its reserved candidate via its run key', () => {
    const failedKey = `season-${seasonData.season}-manual-31337`;
    const slug = 'rerun-test-project-abc123';
    writeRunStateFile(failedKey, v2State(failedKey, 'failed', {
      trigger: 'manual',
      slug,
      failure: {
        stage: 'evaluation',
        retryable: true,
        previous_status: 'generating',
        error_category: 'HTTP_503',
        failed_at: '2026-07-14T00:10:00.000Z'
      }
    }));
    writeRecordFor(failedKey, slug);
    writeReviewFor(slug);

    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    const result = runDaily([
      '--operation', 'resume_pending', '--trigger', 'manual', '--run-key', failedKey,
      '--github-output', outputPath
    ]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Reusing reserved candidate');

    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain(`run_key=${failedKey}`);
    expect(outputs).toContain('content_id=github/rerun-test-project');
    expect(outputs).toContain('generation_performed=false');

    // The failed state recovered to generated with the SAME reservation.
    const runState = JSON.parse(fs.readFileSync(path.join(tempContentRoot, 'runs', `${failedKey}.json`), 'utf8'));
    expect(runState.status).toBe('generated');
    expect(runState.candidate_reservation.content_id).toBe('github/rerun-test-project');
  });

  // Required regression 4: a malformed run-state file aborts publish_new selection
  // instead of silently dropping the file from the exclusion set.
  it('publish_new: fails closed when a run state file is malformed JSON', () => {
    fs.writeFileSync(path.join(tempContentRoot, 'runs', 'season-2-manual-666.json'), '{ definitely not json');
    const result = runDaily([]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('[State Inventory]');
    expect(`${result.stdout}${result.stderr}`).toContain('season-2-manual-666.json');
  });

  // Required regression 5: a schema-invalid publication state does the same.
  it('publish_new: fails closed when a publication state fails schema validation', () => {
    fs.writeFileSync(path.join(tempContentRoot, 'publication-state', 'broken-pub.json'), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      slug: 'broken-pub',
      publication_status: 'not-a-real-status'
    }));
    const result = runDaily([]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('[State Inventory]');
    expect(`${result.stdout}${result.stderr}`).toContain('broken-pub.json');
  });

  // Fix 2: a run-state sync failure fails the workflow BEFORE the publication state is
  // written, so a contradictory pair can never be committed.
  it('update-status: fails closed (and leaves the publication state untouched) when the run-state sync errors', () => {
    const slug = 'sync-fail-slug';
    fs.writeFileSync(path.join(tempContentRoot, 'runs', `${dailyRunKey}.json`), '{ corrupted run state');
    const statePath = path.join(tempContentRoot, 'publication-state', `${slug}.json`);
    fs.writeFileSync(statePath, JSON.stringify({
      schema_version: '2.0.0',
      data_class: 'production',
      content_id: 'github/rerun-test-project',
      slug,
      source_canonical_url: 'https://github.com/github/rerun-test-project',
      selected_at: '2026-07-14T00:00:00.000Z',
      generated_at: '2026-07-14T00:05:00.000Z',
      generation_run_id: dailyRunKey,
      run_key: dailyRunKey,
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '999',
      publication_status: 'generated'
    }));

    const result = runDaily(['--update-status', 'validated', '--slug', slug]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Failed to sync run state');
    // The publication state was NOT advanced.
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).publication_status).toBe('generated');
  });

  it('publish_new: a candidate-less selection failure does not brick the run key', () => {
    // A failure before any reservation existed (the selector itself failed).
    writeRunStateFile(dailyRunKey, {
      schema_version: '1.0.0',
      data_class: 'production',
      status: 'failed',
      run_key: dailyRunKey,
      updated_at: '2026-07-14T00:10:00.000Z'
    });
    // Selection re-runs (and fails again here for lack of network), but the point is that
    // the run does NOT fail on "no stored candidate" — it reaches the selection stage.
    const result = runDaily([]);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain('failed before reserving a candidate. Re-running selection');
    expect(`${result.stdout}${result.stderr}`).not.toContain('no stored candidate to resume from');
  });

  it('resume: a failed publication state re-enters at validation, never straight to deploy', () => {
    const slug = 'rerun-test-project-abc123';
    writeRunStateFile(dailyRunKey, v2State(dailyRunKey, 'generated', { slug }));
    writeRecordFor(dailyRunKey, slug);
    writeReviewFor(slug);
    fs.writeFileSync(path.join(tempContentRoot, 'publication-state', `${slug}.json`), JSON.stringify({
      schema_version: '2.0.0',
      data_class: 'production',
      content_id: 'github/rerun-test-project',
      slug,
      source_canonical_url: 'https://github.com/github/rerun-test-project',
      selected_at: '2026-07-14T00:00:00.000Z',
      generated_at: '2026-07-14T00:05:00.000Z',
      generation_run_id: dailyRunKey,
      run_key: dailyRunKey,
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '999',
      publication_status: 'failed'
    }));

    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    const result = runDaily(['--github-output', outputPath]);
    expect(result.status).toBe(0);
    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain('publication_status=generated');
    expect(outputs).toContain('next_stage=validate');
  });

  it('update-status: recovers a failed v2 run state when the publication advances', () => {
    const slug = 'sync-slug';
    writeRunStateFile(dailyRunKey, v2State(dailyRunKey, 'failed', {
      slug,
      failure: {
        stage: 'evaluation',
        retryable: true,
        previous_status: 'generating',
        error_category: 'HTTP_503',
        failed_at: '2026-07-14T00:10:00.000Z'
      }
    }));
    fs.writeFileSync(path.join(tempContentRoot, 'publication-state', `${slug}.json`), JSON.stringify({
      schema_version: '2.0.0',
      data_class: 'production',
      content_id: 'github/rerun-test-project',
      slug,
      source_canonical_url: 'https://github.com/github/rerun-test-project',
      selected_at: '2026-07-14T00:00:00.000Z',
      generated_at: '2026-07-14T00:05:00.000Z',
      generation_run_id: dailyRunKey,
      run_key: dailyRunKey,
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '999',
      publication_status: 'generated'
    }));

    const result = runDaily(['--update-status', 'validated', '--slug', slug]);
    expect(result.status).toBe(0);
    const runState = JSON.parse(fs.readFileSync(path.join(tempContentRoot, 'runs', `${dailyRunKey}.json`), 'utf8'));
    expect(runState.status).toBe('validated');
    expect(runState.failure).toBeUndefined();
  });

  it('update-status: rejects slugs with path characters', () => {
    const result = runDaily(['--update-status', 'validated', '--slug', '../../etc/passwd']);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('forbidden characters');
  });

  it('resume_pending: fails closed when the run state does not exist', () => {
    const result = runDaily(['--operation', 'resume_pending', '--trigger', 'manual', '--run-key', `season-${seasonData.season}-manual-999888`]);
    expect(result.status).toBe(1);
    expect(`${result.stdout}${result.stderr}`).toContain('Failing closed');
  });

  it('rejects path-traversal run keys before touching the filesystem', () => {
    const result = runDaily(['--operation', 'resume_pending', '--run-key', '../../etc/passwd']);
    expect(result.status).not.toBe(0);
    expect(fs.readdirSync(path.join(tempContentRoot, 'runs'))).toHaveLength(0);
  });

  it('update-status: enforces forward-only publication transitions', () => {
    const slug = 'monotonic-slug';
    const statePath = path.join(tempContentRoot, 'publication-state', `${slug}.json`);
    fs.writeFileSync(statePath, JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: 'example/monotonic',
      slug,
      source_canonical_url: 'https://github.com/example/monotonic',
      selected_at: '2026-07-14T00:00:00.000Z',
      generated_at: '2026-07-14T00:05:00.000Z',
      generation_run_id: dailyRunKey,
      publication_status: 'committed'
    }));

    // Regression: refused, file unchanged, exit 0 so resumed workflows can replay steps.
    let result = runDaily(['--update-status', 'validated', '--slug', slug]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping regression');
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).publication_status).toBe('committed');

    // Same status: clean no-op.
    result = runDaily(['--update-status', 'committed', '--slug', slug]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('No-op');

    // Forward: applied, published_at stamped.
    result = runDaily(['--update-status', 'published', '--slug', slug]);
    expect(result.status).toBe(0);
    const published = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    expect(published.publication_status).toBe('published');
    expect(published.published_at).toBeTruthy();

    // Published never regresses (and cannot be marked failed).
    result = runDaily(['--update-status', 'generated', '--slug', slug]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Skipping regression');
    result = runDaily(['--update-status', 'failed', '--slug', slug]);
    expect(result.status).toBe(1);
    expect(JSON.parse(fs.readFileSync(statePath, 'utf8')).publication_status).toBe('published');
  });

  it('update-status: keeps a v2 run state in sync through the lifecycle', () => {
    const slug = 'sync-slug';
    writeRunStateFile(dailyRunKey, v2State(dailyRunKey, 'generated', { slug }));
    fs.writeFileSync(path.join(tempContentRoot, 'publication-state', `${slug}.json`), JSON.stringify({
      schema_version: '2.0.0',
      data_class: 'production',
      content_id: 'github/rerun-test-project',
      slug,
      source_canonical_url: 'https://github.com/github/rerun-test-project',
      selected_at: '2026-07-14T00:00:00.000Z',
      generated_at: '2026-07-14T00:05:00.000Z',
      generation_run_id: dailyRunKey,
      run_key: dailyRunKey,
      trigger: 'scheduled',
      operation: 'publish_new',
      workflow_run_id: '999',
      publication_status: 'generated'
    }));

    for (const status of ['validated', 'committed', 'published']) {
      const result = runDaily(['--update-status', status, '--slug', slug]);
      expect(result.status).toBe(0);
      const runState = JSON.parse(fs.readFileSync(path.join(tempContentRoot, 'runs', `${dailyRunKey}.json`), 'utf8'));
      expect(runState.status).toBe(status);
    }
  });

  it('legacy compat: invoking with no operation flags behaves as the scheduled daily', () => {
    const slug = 'legacy-compat-slug';
    // A legacy 1.0.0 run state from a previously failed daily run.
    writeRunStateFile(dailyRunKey, {
      schema_version: '1.0.0',
      data_class: 'production',
      status: 'failed',
      run_key: dailyRunKey,
      updated_at: '2026-07-14T00:10:00.000Z',
      candidate: { name: 'Legacy Compat Project', canonical_url: 'https://github.com/example/legacy-compat' },
      selection: {
        source_url: 'https://github.com/example/legacy-compat',
        source: 'github',
        source_id: 'example/legacy-compat',
        source_rank: 1,
        selected_at: '2026-07-14T00:00:00.000Z',
        candidate_metadata: {}
      }
    });
    // The response was already obtained (before the failure), so the resumed run must not
    // call Gemini again — the stored record is what proves that, not the review.
    const yearMonth = TimezoneUtil.getJSTYearMonth(targetDate);
    const computedSlugDir = path.join(tempContentRoot, 'reviews', yearMonth.year, yearMonth.month);
    fs.mkdirSync(computedSlugDir, { recursive: true });
    // computeSlug('Legacy Compat Project', 'example/legacy-compat')
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update('example/legacy-compat').digest('hex').substring(0, 6);
    const computedSlug = `legacy-compat-project-${hash}`;
    fs.mkdirSync(path.join(computedSlugDir, computedSlug), { recursive: true });
    fs.writeFileSync(path.join(computedSlugDir, computedSlug, 'review.json'), JSON.stringify({ slug: computedSlug }));
    writeRecordFor(dailyRunKey, computedSlug);

    const outputPath = path.join(tempContentRoot, 'github_output.txt');
    const result = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/run-daily.ts', '--github-output', outputPath], {
      cwd: repoRoot,
      env: {
        ...process.env,
        JURYPRESS_DATA_MODE: 'production',
        JURYPRESS_CONTENT_ROOT: tempContentRoot,
        TARGET_DATE: targetDate.toISOString(),
        DRY_RUN: 'false'
      },
      encoding: 'utf8'
    });
    expect(result).toContain('Reusing candidate from previous run');
    const outputs = fs.readFileSync(outputPath, 'utf8');
    expect(outputs).toContain(`slug=${computedSlug}`);
    expect(outputs).toContain('generation_performed=false');
    expect(outputs).toContain(`generation_run_id=${dailyRunKey}`);
    expect(slug).toBeTruthy();
  });
});
