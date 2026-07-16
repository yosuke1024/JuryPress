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

  it('scheduled retry: reuses the reserved candidate and never re-runs the selector or Gemini when the review exists', () => {
    const slug = 'rerun-test-project-abc123';
    writeRunStateFile(dailyRunKey, v2State(dailyRunKey, 'reserved', { slug }));
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
    // The review already exists (it was generated before the failure).
    const yearMonth = TimezoneUtil.getJSTYearMonth(targetDate);
    const computedSlugDir = path.join(tempContentRoot, 'reviews', yearMonth.year, yearMonth.month);
    fs.mkdirSync(computedSlugDir, { recursive: true });
    // computeSlug('Legacy Compat Project', 'example/legacy-compat')
    const crypto = require('crypto');
    const hash = crypto.createHash('md5').update('example/legacy-compat').digest('hex').substring(0, 6);
    const computedSlug = `legacy-compat-project-${hash}`;
    fs.mkdirSync(path.join(computedSlugDir, computedSlug), { recursive: true });
    fs.writeFileSync(path.join(computedSlugDir, computedSlug, 'review.json'), JSON.stringify({ slug: computedSlug }));

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
