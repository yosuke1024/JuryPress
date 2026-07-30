import * as fs from 'node:fs';
import * as path from 'node:path';
import { DiaryEntrySchema, type DiaryEntry } from '../../schemas/diary';
import { DiaryEventSchema, type DiaryEvent } from '../../schemas/diary-record';
import {
  diaryEntriesDir,
  diaryEntryPath,
  diaryEventPath,
  diaryEventsDir,
  listDatedJsonFiles,
  readJsonIfExists,
  writeJsonAtomic
} from './storage';

/**
 * Published entries and applied events.
 *
 * The entries directory *is* the published set. There is no separate published flag to keep
 * in sync, because an entry is only ever written after the structural gate passed and the
 * patches applied — so "the file exists" and "this diary is publishable" are the same fact.
 *
 * Reading is fail-soft about absence and fail-closed about corruption: no diary directory at
 * all yields an empty archive (the site must build before the first entry ever exists), while
 * a malformed entry stops the build rather than quietly disappearing from the archive.
 */

export function readDiaryEntry(
  contentRoot: string,
  date: string,
  jurorId: string
): DiaryEntry | null {
  const raw = readJsonIfExists(diaryEntryPath(contentRoot, date, jurorId));
  if (raw === null) return null;
  return DiaryEntrySchema.parse(raw);
}

export function diaryEntryExists(contentRoot: string, date: string, jurorId: string): boolean {
  return fs.existsSync(diaryEntryPath(contentRoot, date, jurorId));
}

export function writeDiaryEntry(contentRoot: string, entry: DiaryEntry): DiaryEntry {
  const parsed = DiaryEntrySchema.parse(entry);
  writeJsonAtomic(diaryEntryPath(contentRoot, parsed.date, parsed.jurorId), parsed);
  return parsed;
}

export function readDiaryEvent(
  contentRoot: string,
  date: string,
  jurorId: string
): DiaryEvent | null {
  const raw = readJsonIfExists(diaryEventPath(contentRoot, date, jurorId));
  if (raw === null) return null;
  return DiaryEventSchema.parse(raw);
}

export function diaryEventExists(contentRoot: string, date: string, jurorId: string): boolean {
  return fs.existsSync(diaryEventPath(contentRoot, date, jurorId));
}

export function writeDiaryEvent(contentRoot: string, event: DiaryEvent): DiaryEvent {
  const parsed = DiaryEventSchema.parse(event);
  writeJsonAtomic(diaryEventPath(contentRoot, parsed.date, parsed.jurorId), parsed);
  return parsed;
}

/** Every published entry, newest first. Empty when JuryDiary has not started yet. */
export function readAllDiaryEntries(contentRoot: string): DiaryEntry[] {
  const entries: DiaryEntry[] = [];
  for (const filePath of listDatedJsonFiles(diaryEntriesDir(contentRoot))) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error: any) {
      throw new Error(`[Diary Archive] ${path.basename(filePath)} is not valid JSON: ${error.message}`);
    }
    const parsed = DiaryEntrySchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `[Diary Archive] ${path.basename(filePath)} failed schema validation: ${parsed.error.message}`
      );
    }
    entries.push(parsed.data);
  }
  return entries.sort(compareEntriesDescending);
}

export function readAllDiaryEvents(contentRoot: string): DiaryEvent[] {
  const events: DiaryEvent[] = [];
  for (const filePath of listDatedJsonFiles(diaryEventsDir(contentRoot))) {
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error: any) {
      throw new Error(`[Diary Events] ${path.basename(filePath)} is not valid JSON: ${error.message}`);
    }
    const parsed = DiaryEventSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(
        `[Diary Events] ${path.basename(filePath)} failed schema validation: ${parsed.error.message}`
      );
    }
    events.push(parsed.data);
  }
  return events.sort((a, b) => (a.date === b.date ? a.jurorId.localeCompare(b.jurorId) : a.date.localeCompare(b.date)));
}

/** Newest first; a tie can only happen across jurors, and is broken by slug for stability. */
export function compareEntriesDescending(a: DiaryEntry, b: DiaryEntry): number {
  if (a.date !== b.date) return b.date.localeCompare(a.date);
  return a.jurorId.localeCompare(b.jurorId);
}
