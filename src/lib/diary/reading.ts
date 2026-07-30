import crypto from 'node:crypto';
import { DIARY_READING, type DiaryEntry, type DiaryTheme } from '../../schemas/diary';
import type { JudgeSlug } from '../../schemas/jury';
import { toEpochDay } from './rotation';

/**
 * Handing one juror another juror's diary to actually read.
 *
 * The jurors already see each other in passing — every prompt carries a short excerpt of what
 * the others last wrote. This is the deliberate version: on a relationship day the duty juror
 * is given one specific entry in full and writes with it in front of them, which is what turns
 * a set of parallel monologues into something that can argue back.
 *
 * Only on relationship days, which is roughly one day in ten. That rhythm is the point: often
 * enough that threads form across weeks, rare enough that the diary does not become a reply
 * column where nobody has a life.
 *
 * Selection is deterministic in (date, juror) and, like the theme, is decided by code and
 * recorded — the model is never asked to choose whose diary it read.
 */

export interface DiaryReadingTarget {
  diaryId: string;
  jurorId: JudgeSlug;
  date: string;
  title: string;
  mood: string;
  /** The body, not an excerpt: "read this" and "glance at this" are different inputs. */
  body: string;
  /** True when the entry named the reader — the strongest reason to answer it. */
  mentionsReader: boolean;
}

export function themeAssignsReading(theme: DiaryTheme): boolean {
  return theme === 'relationship';
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit).trimEnd()}…`;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function selectReadingTarget(input: {
  date: string;
  jurorId: string;
  jurorName: string;
  theme: DiaryTheme;
  entries: DiaryEntry[];
}): DiaryReadingTarget | null {
  if (!themeAssignsReading(input.theme)) return null;

  const today = toEpochDay(input.date);
  const candidates = input.entries.filter((entry) => {
    if (entry.jurorId === input.jurorId) return false;
    const age = today - toEpochDay(entry.date);
    return age > 0 && age <= DIARY_READING.lookbackDays;
  });

  if (candidates.length === 0) return null;

  const mentionPattern = new RegExp(`\\b${escapeRegExp(input.jurorName)}\\b`);
  const mentioning = candidates.filter((entry) => mentionPattern.test(entry.body.en));

  // Being written about is the strongest reason to answer someone, so those win outright and
  // the most recent one is taken. Otherwise the choice is spread across the window by hash,
  // rather than always landing on yesterday's entry.
  const pool = mentioning.length > 0 ? mentioning : candidates;
  const chosen =
    mentioning.length > 0
      ? pool[0]
      : pool[hashIndex(`diary-reading:${input.date}:${input.jurorId}`, pool.length)];

  return {
    diaryId: chosen.id,
    jurorId: chosen.jurorId,
    date: chosen.date,
    title: chosen.title.en,
    mood: chosen.mood.en,
    body: truncate(chosen.body.en, DIARY_READING.bodyChars),
    mentionsReader: mentioning.length > 0
  };
}

function hashIndex(seed: string, length: number): number {
  const digest = crypto.createHash('sha256').update(seed).digest('hex');
  return parseInt(digest.slice(0, 8), 16) % length;
}
