import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { TimezoneUtil } from '../../src/lib/timezone';

describe('Idempotency Integration', () => {
  const tmpDir = path.join(__dirname, '..', '..', 'data', 'runs');
  const targetDate = new Date('2026-07-14T00:15:00Z');
  const seasonConfigPath = path.join(__dirname, '..', '..', 'config', 'season.json');
  let seasonData: any;
  let runKey: string;
  let runFilePath: string;

  beforeAll(() => {
    seasonData = JSON.parse(fs.readFileSync(seasonConfigPath, 'utf8'));
    runKey = TimezoneUtil.getRunKey(seasonData.season, targetDate);
    runFilePath = path.join(tmpDir, `${runKey}.json`);
    
    if (!fs.existsSync(tmpDir)) {
      fs.mkdirSync(tmpDir, { recursive: true });
    }
    
    // Set state to published
    fs.writeFileSync(runFilePath, JSON.stringify({
      status: 'published',
      run_key: runKey,
      slug: 'test-slug'
    }));
  });

  afterAll(() => {
    if (fs.existsSync(runFilePath)) {
      fs.unlinkSync(runFilePath);
    }
  });

  it('should skip execution cleanly if run is already published', () => {
    try {
      const output = execSync(`npx tsx scripts/run-daily.ts`, {
        env: {
          ...process.env,
          TARGET_DATE: targetDate.toISOString(),
          DRY_RUN: 'false'
        },
        encoding: 'utf8'
      });
      
      expect(output).toContain(`Run ${runKey} is already published. Exiting cleanly.`);
    } catch (e: any) {
      // It should exit with code 0. If it exits with 1, error will be thrown.
      expect.fail(`Script failed or threw error: ${e.message}`);
    }
  });
});
