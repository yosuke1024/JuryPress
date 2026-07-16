import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { TimezoneUtil } from '../../src/lib/timezone';

describe('Idempotency Integration', () => {
  let tempContentRoot: string;
  let tmpDir: string;
  const targetDate = new Date('2026-07-14T00:15:00Z');
  const seasonConfigPath = path.join(__dirname, '..', '..', 'config', 'season.json');
  let seasonData: any;
  let runKey: string;
  let runFilePath: string;

  beforeAll(() => {
    seasonData = JSON.parse(fs.readFileSync(seasonConfigPath, 'utf8'));
    runKey = TimezoneUtil.getRunKey(seasonData.season, targetDate);
    
    tempContentRoot = path.join(__dirname, '..', '..', 'tests', 'temp_idempotency_content');
    tmpDir = path.join(tempContentRoot, 'runs');
    runFilePath = path.join(tmpDir, `${runKey}.json`);
    
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    
    // Set state to published with data_class: 'production'
    fs.writeFileSync(runFilePath, JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      status: 'published',
      run_key: runKey,
      slug: 'test-slug'
    }));
  });

  afterAll(() => {
    if (fs.existsSync(tempContentRoot)) {
      fs.rmSync(tempContentRoot, { recursive: true, force: true });
    }
  });

  it('should skip execution cleanly if run is already published', () => {
    try {
      const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/run-daily.ts'], {
        env: {
          ...process.env,
          JURYPRESS_DATA_MODE: 'production',
          JURYPRESS_CONTENT_ROOT: tempContentRoot,
          TARGET_DATE: targetDate.toISOString(),
          DRY_RUN: 'false'
        },
        encoding: 'utf8'
      });
      
      expect(output).toContain(`Run ${runKey} is already published. Exiting cleanly.`);
    } catch (e: any) {
      expect.fail(`Script failed or threw error: ${e.message}`);
    }
  }, 15_000);

  it('should reuse existing review and output slug on rerun', () => {
    const slug = 'test-rerun-slug';
    const contentId = 'github/rerun-test-project';
    const yearMonth = TimezoneUtil.getJSTYearMonth(targetDate);
    
    const reviewsDir = path.join(tempContentRoot, 'reviews', yearMonth.year, yearMonth.month, slug);
    const pubStateDir = path.join(tempContentRoot, 'publication-state');
    
    fs.mkdirSync(reviewsDir, { recursive: true });
    fs.mkdirSync(pubStateDir, { recursive: true });
    
    fs.writeFileSync(path.join(reviewsDir, 'review.json'), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_license: 'all-rights-reserved',
      copyright_holder: 'Yosuke Suzuki',
      season: 1,
      slug,
      published_at: '2026-07-14T00:00:00Z',
      model: 'gemini-3.5-flash',
      prompt_version: '1.0.0',
      rubric_version: '1.0.0',
      human_reviewed: false,
      jury_score: 80,
      judge_score_range: { min: 70, max: 90 },
      evaluation: {}
    }));

    fs.writeFileSync(path.join(reviewsDir, 'selection.json'), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      run_key: runKey,
      source: 'github',
      source_rank: 1,
      selection_rule: 'rule',
      selected_at: new Date().toISOString(),
      canonical_url: 'https://rerun.com',
      source_url: 'https://github.com/rerun',
      algorithm_version: '1.0.0',
      human_selected: false,
      candidate_name: 'candidate',
      source_id: contentId,
      candidate_metadata: {},
      selection_mode: 'automated-daily',
      selected_by: 'system',
      source_metrics: [
        {
          platform: 'github',
          metric: 'stars',
          value: 50,
          source_url: 'https://api.github.com/repos/rerun',
          retrieved_at: new Date().toISOString()
        }
      ]
    }));
    
    fs.writeFileSync(path.join(pubStateDir, `${slug}.json`), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: contentId,
      slug: slug,
      source_canonical_url: 'https://rerun.com',
      selected_at: new Date().toISOString(),
      generated_at: new Date().toISOString(),
      generation_run_id: runKey,
      publication_status: 'validated'
    }));

    const secondSlug = 'newest-mtime-slug';
    fs.writeFileSync(path.join(pubStateDir, `${secondSlug}.json`), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: 'github/newer-project',
      slug: secondSlug,
      source_canonical_url: 'https://newer.com',
      selected_at: new Date().toISOString(),
      generated_at: new Date().toISOString(),
      generation_run_id: runKey,
      publication_status: 'generated'
    }));
    
    const githubOutputPath = path.join(tempContentRoot, 'github_output.txt');
    try {
      const output = execFileSync(process.execPath, ['--import', 'tsx', 'scripts/run-daily.ts', '--github-output', githubOutputPath], {
        env: {
          ...process.env,
          JURYPRESS_DATA_MODE: 'production',
          JURYPRESS_CONTENT_ROOT: tempContentRoot,
          TARGET_DATE: targetDate.toISOString(),
          DRY_RUN: 'false'
        },
        encoding: 'utf8'
      });
      
      expect(output).toContain(`[Idempotency] Found pending publication state: ${slug} (validated). Reusing existing review.`);
      
      const githubOutputContent = fs.readFileSync(githubOutputPath, 'utf8');
      expect(githubOutputContent).toContain(`slug=${slug}`);
      expect(githubOutputContent).toContain(`content_id=${contentId}`);
      expect(githubOutputContent).toContain(`generation_performed=false`);
    } finally {
      if (fs.existsSync(githubOutputPath)) fs.unlinkSync(githubOutputPath);
    }
  });

  it('should prioritize committed status over validated or generated', () => {
    const pubStateDir = path.join(tempContentRoot, 'publication-state');
    if (fs.existsSync(tempContentRoot)) {
      fs.rmSync(tempContentRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(pubStateDir, { recursive: true });

    const slugGen = 'state-generated';
    const slugVal = 'state-validated';
    const slugCom = 'state-committed';
    const yearMonth = TimezoneUtil.getJSTYearMonth(targetDate);

    [slugGen, slugVal, slugCom].forEach(slug => {
      const dir = path.join(tempContentRoot, 'reviews', yearMonth.year, yearMonth.month, slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({
        schema_version: '1.0.0',
        data_class: 'production',
        content_license: 'all-rights-reserved',
        copyright_holder: 'Yosuke Suzuki',
        season: 1,
        slug,
        published_at: '2026-07-14T00:00:00Z',
        model: 'gemini-3.5-flash',
        prompt_version: '1.0.0',
        rubric_version: '1.0.0',
        human_reviewed: false,
        jury_score: 80,
        judge_score_range: { min: 70, max: 90 },
        evaluation: {}
      }));
    });

    fs.writeFileSync(path.join(pubStateDir, `${slugGen}.json`), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: 'gen-id',
      slug: slugGen,
      source_canonical_url: 'https://example.com/gen',
      selected_at: new Date().toISOString(),
      generated_at: new Date().toISOString(),
      generation_run_id: runKey,
      publication_status: 'generated'
    }));

    fs.writeFileSync(path.join(pubStateDir, `${slugVal}.json`), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: 'val-id',
      slug: slugVal,
      source_canonical_url: 'https://example.com/val',
      selected_at: new Date().toISOString(),
      generated_at: new Date().toISOString(),
      generation_run_id: runKey,
      publication_status: 'validated'
    }));

    fs.writeFileSync(path.join(pubStateDir, `${slugCom}.json`), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: 'com-id',
      slug: slugCom,
      source_canonical_url: 'https://example.com/com',
      selected_at: new Date().toISOString(),
      generated_at: new Date().toISOString(),
      generation_run_id: runKey,
      publication_status: 'committed'
    }));

    const githubOutputPath = path.join(tempContentRoot, 'github_output.txt');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/run-daily.ts', '--github-output', githubOutputPath], {
        env: {
          ...process.env,
          JURYPRESS_DATA_MODE: 'production',
          JURYPRESS_CONTENT_ROOT: tempContentRoot,
          TARGET_DATE: targetDate.toISOString(),
          DRY_RUN: 'false'
        },
        encoding: 'utf8'
      });
      const githubOutputContent = fs.readFileSync(githubOutputPath, 'utf8');
      expect(githubOutputContent).toContain(`slug=${slugCom}`);
      expect(githubOutputContent).toContain(`content_id=com-id`);
    } finally {
      if (fs.existsSync(githubOutputPath)) fs.unlinkSync(githubOutputPath);
    }
  });

  it('should prioritize older generated_at when status is same', () => {
    const pubStateDir = path.join(tempContentRoot, 'publication-state');
    if (fs.existsSync(tempContentRoot)) {
      fs.rmSync(tempContentRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(pubStateDir, { recursive: true });

    const slugOld = 'state-old';
    const slugNew = 'state-new';
    const yearMonth = TimezoneUtil.getJSTYearMonth(targetDate);

    [slugOld, slugNew].forEach(slug => {
      const dir = path.join(tempContentRoot, 'reviews', yearMonth.year, yearMonth.month, slug);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({
        schema_version: '1.0.0',
        data_class: 'production',
        content_license: 'all-rights-reserved',
        copyright_holder: 'Yosuke Suzuki',
        season: 1,
        slug,
        published_at: '2026-07-14T00:00:00Z',
        model: 'gemini-3.5-flash',
        prompt_version: '1.0.0',
        rubric_version: '1.0.0',
        human_reviewed: false,
        jury_score: 80,
        judge_score_range: { min: 70, max: 90 },
        evaluation: {}
      }));
    });

    const oldTime = new Date(Date.now() - 3600000).toISOString();
    const newTime = new Date().toISOString();

    fs.writeFileSync(path.join(pubStateDir, `${slugOld}.json`), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: 'old-id',
      slug: slugOld,
      source_canonical_url: 'https://example.com/old',
      selected_at: oldTime,
      generated_at: oldTime,
      generation_run_id: runKey,
      publication_status: 'generated'
    }));

    fs.writeFileSync(path.join(pubStateDir, `${slugNew}.json`), JSON.stringify({
      schema_version: '1.0.0',
      data_class: 'production',
      content_id: 'new-id',
      slug: slugNew,
      source_canonical_url: 'https://example.com/new',
      selected_at: newTime,
      generated_at: newTime,
      generation_run_id: runKey,
      publication_status: 'generated'
    }));

    const githubOutputPath = path.join(tempContentRoot, 'github_output.txt');
    try {
      execFileSync(process.execPath, ['--import', 'tsx', 'scripts/run-daily.ts', '--github-output', githubOutputPath], {
        env: {
          ...process.env,
          JURYPRESS_DATA_MODE: 'production',
          JURYPRESS_CONTENT_ROOT: tempContentRoot,
          TARGET_DATE: targetDate.toISOString(),
          DRY_RUN: 'false'
        },
        encoding: 'utf8'
      });
      const githubOutputContent = fs.readFileSync(githubOutputPath, 'utf8');
      expect(githubOutputContent).toContain(`slug=${slugOld}`);
      expect(githubOutputContent).toContain(`content_id=old-id`);
    } finally {
      if (fs.existsSync(githubOutputPath)) fs.unlinkSync(githubOutputPath);
    }
  });
});
