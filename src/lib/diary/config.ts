import * as fs from 'node:fs';
import { DiaryConfigSchema, type DiaryConfig } from '../../schemas/diary-state';
import { diaryConfigPath, readJsonIfExists, writeJsonAtomic } from './storage';
import { JUDGE_SLUGS } from '../../schemas/jury';

/**
 * The rotation config: when the experiment started and in what order the jurors write.
 *
 * Kept in the content repo rather than in code because it is an operational fact about a
 * running experiment, not a property of the software — and because changing the start date
 * silently reassigns every future duty day, which is a decision for an operator with the
 * archive in front of them, not something a deploy should be able to do.
 */

export function readDiaryConfigIfPresent(contentRoot: string): DiaryConfig | null {
  const raw = readJsonIfExists(diaryConfigPath(contentRoot));
  if (raw === null) return null;
  return DiaryConfigSchema.parse(raw);
}

export function readDiaryConfig(contentRoot: string): DiaryConfig {
  const config = readDiaryConfigIfPresent(contentRoot);
  if (!config) {
    throw new Error(
      `[Diary Config] No diary config at ${diaryConfigPath(contentRoot)}. ` +
        'Run the bootstrap operation before generating diaries.'
    );
  }
  return config;
}

export function diaryConfigExists(contentRoot: string): boolean {
  return fs.existsSync(diaryConfigPath(contentRoot));
}

export function writeDiaryConfig(contentRoot: string, config: DiaryConfig): DiaryConfig {
  const parsed = DiaryConfigSchema.parse(config);
  writeJsonAtomic(diaryConfigPath(contentRoot), parsed);
  return parsed;
}

/**
 * The config bootstrap writes when none exists. `startDate` defaults to the bootstrap day, so
 * the rotation is immediately well-defined; an operator who wants a different launch date
 * edits this one field before enabling autonomous publishing.
 */
export function buildDefaultDiaryConfig(startDate: string): DiaryConfig {
  return DiaryConfigSchema.parse({
    schema_version: '1.0',
    startDate,
    rotation: [...JUDGE_SLUGS],
    timezone: 'Asia/Tokyo'
  });
}
