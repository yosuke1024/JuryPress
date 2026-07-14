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
});
