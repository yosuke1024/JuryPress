import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
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
      const output = execSync(`npx tsx scripts/run-daily.ts`, {
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
  });

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
      popularity_value: 100,
      popularity_unit: 'stars',
      selection_rule: 'rule',
      selected_at: new Date().toISOString(),
      canonical_url: 'https://rerun.com',
      source_url: 'https://github.com/rerun',
      algorithm_version: '1.0.0',
      human_selected: false,
      candidate_name: 'candidate',
      source_id: contentId,
      candidate_metadata: {}
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
      const output = execSync(`npx tsx scripts/run-daily.ts --github-output ${githubOutputPath}`, {
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
});
