import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import { JUDGE_SLUGS } from '../../schemas/jury';
import { assertNoSecrets } from '../generation/record-store';

/**
 * Paths and atomic writes for everything JuryDiary persists.
 *
 * All of it lives under `<contentRoot>/diary/`. That is not cosmetic: the content repo's
 * push script stages `data/` and nothing else, so a diary file written outside `data/` would
 * be generated, used, and then silently dropped on the floor at commit time.
 *
 * Every path is built from a validated run key, date and juror slug, so a value that reached
 * here from a workflow input cannot walk out of the diary tree.
 */

export const DIARY_RUN_KEY_PATTERN =
  /^diary-(bootstrap|\d{4}-\d{2}-\d{2}-(alex|david|lisa|sarah|marcus))$/;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function assertSafeDiaryRunKey(runKey: string): void {
  if (!DIARY_RUN_KEY_PATTERN.test(runKey)) {
    throw new Error(
      `[Diary Storage] Unsafe or unrecognized diary run key: ${runKey}. ` +
        'Expected diary-<YYYY-MM-DD>-<juror> or diary-bootstrap.'
    );
  }
}

export function assertSafeDate(date: string): void {
  if (!DATE_PATTERN.test(date)) {
    throw new Error(`[Diary Storage] Unsafe date: ${date}. Expected YYYY-MM-DD.`);
  }
}

export function assertSafeJuror(jurorId: string): void {
  if (!JUDGE_SLUGS.includes(jurorId as (typeof JUDGE_SLUGS)[number])) {
    throw new Error(`[Diary Storage] Unknown juror slug: ${jurorId}.`);
  }
}

export function diaryRoot(contentRoot: string): string {
  return path.join(contentRoot, 'diary');
}

export function diaryConfigPath(contentRoot: string): string {
  return path.join(diaryRoot(contentRoot), 'config.json');
}

export function diaryJurorDir(contentRoot: string, jurorId: string): string {
  assertSafeJuror(jurorId);
  return path.join(diaryRoot(contentRoot), 'jurors', jurorId);
}

export function diaryRecordsDir(contentRoot: string): string {
  return path.join(diaryRoot(contentRoot), 'generations');
}

export function diaryRecordPath(contentRoot: string, runKey: string): string {
  assertSafeDiaryRunKey(runKey);
  return path.join(diaryRecordsDir(contentRoot), `${runKey}.json`);
}

export function diaryEntriesDir(contentRoot: string): string {
  return path.join(diaryRoot(contentRoot), 'entries');
}

export function diaryEventsDir(contentRoot: string): string {
  return path.join(diaryRoot(contentRoot), 'events');
}

/** `entries/<YYYY>/<MM>/<YYYY-MM-DD>-<juror>.json` — the same layout reviews use. */
export function diaryEntryPath(contentRoot: string, date: string, jurorId: string): string {
  assertSafeDate(date);
  assertSafeJuror(jurorId);
  const [year, month] = date.split('-');
  return path.join(diaryEntriesDir(contentRoot), year, month, `${date}-${jurorId}.json`);
}

export function diaryEventPath(contentRoot: string, date: string, jurorId: string): string {
  assertSafeDate(date);
  assertSafeJuror(jurorId);
  const [year, month] = date.split('-');
  return path.join(diaryEventsDir(contentRoot), year, month, `${date}-${jurorId}.json`);
}

export function diaryFailurePath(contentRoot: string, runKey: string): string {
  assertSafeDiaryRunKey(runKey);
  return path.join(diaryRoot(contentRoot), 'failures', `${runKey}.json`);
}

export function readJsonIfExists(filePath: string): unknown | null {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

/**
 * Serialize, refuse to persist a credential, then write through a temp file in the same
 * directory so the rename is atomic. A half-written state file would be worse than a missing
 * one: it would fail schema validation on the next run and strand the persona.
 */
export function writeJsonAtomic(filePath: string, value: unknown): void {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  assertNoSecrets(serialized);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, serialized);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }
}

/** Recursively lists `*.json` under a `<YYYY>/<MM>/` tree, sorted; empty when absent. */
export function listDatedJsonFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const year of fs.readdirSync(root).sort()) {
    const yearDir = path.join(root, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yearDir).sort()) {
      const monthDir = path.join(yearDir, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      for (const file of fs.readdirSync(monthDir).sort()) {
        if (file.endsWith('.json')) files.push(path.join(monthDir, file));
      }
    }
  }
  return files;
}
