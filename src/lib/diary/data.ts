import { resolveContentRoot } from '../content-root';
import type { DiaryEntry, DiaryTheme } from '../../schemas/diary';
import type { DiaryConfig } from '../../schemas/diary-state';
import type { JudgeSlug } from '../../schemas/jury';
import { readAllDiaryEntries } from './entry-store';
import { readDiaryConfigIfPresent } from './config';
import { resolveDutyJuror, upcomingDuty, daysSinceStart } from './rotation';
import { TimezoneUtil } from '../timezone';

/**
 * Build-time reader for the diary archive.
 *
 * Fail-soft about absence, fail-closed about corruption. That split is deliberate: this code
 * ships to the public repository and every content workflow checks out `main`, so from the
 * moment it merges until the first entry is ever generated, every review build will call
 * these functions against a content root with no diary in it. An empty archive must therefore
 * be an ordinary answer, not an error — while a malformed entry still stops the build rather
 * than silently vanishing from the archive.
 *
 * Results are cached per module instance, as `lib/jury.ts` does: one build, one read.
 */

let cachedEntries: DiaryEntry[] | null = null;
let cachedConfig: DiaryConfig | null | undefined;

export function getAllDiaryEntries(): DiaryEntry[] {
  if (cachedEntries) return cachedEntries;
  cachedEntries = readAllDiaryEntries(resolveContentRoot());
  return cachedEntries;
}

export function getDiaryConfig(): DiaryConfig | null {
  if (cachedConfig !== undefined) return cachedConfig;
  cachedConfig = readDiaryConfigIfPresent(resolveContentRoot());
  return cachedConfig;
}

export function hasDiaryContent(): boolean {
  return getAllDiaryEntries().length > 0;
}

/** The URL segment for an entry: `<YYYY-MM-DD>-<juror>`, stable regardless of its title. */
export function entrySlug(entry: DiaryEntry): string {
  return `${entry.date}-${entry.jurorId}`;
}

export function getDiaryEntryBySlug(slug: string): DiaryEntry | null {
  return getAllDiaryEntries().find((entry) => entrySlug(entry) === slug) ?? null;
}

export function getEntriesByJuror(jurorId: string): DiaryEntry[] {
  return getAllDiaryEntries().filter((entry) => entry.jurorId === jurorId);
}

/** The same juror's entry immediately before this one — the continuity link on every page. */
export function getPreviousEntryBySameJuror(entry: DiaryEntry): DiaryEntry | null {
  return (
    getEntriesByJuror(entry.jurorId).find((candidate) => candidate.date < entry.date) ?? null
  );
}

export function getNextEntryBySameJuror(entry: DiaryEntry): DiaryEntry | null {
  const later = getEntriesByJuror(entry.jurorId).filter((candidate) => candidate.date > entry.date);
  return later.length > 0 ? later[later.length - 1] : null;
}

export interface DiaryArchiveMonth {
  year: string;
  month: string;
  entries: DiaryEntry[];
}

export function groupEntriesByMonth(entries: DiaryEntry[]): DiaryArchiveMonth[] {
  const groups = new Map<string, DiaryEntry[]>();
  for (const entry of entries) {
    const key = entry.date.slice(0, 7);
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, monthEntries]) => ({
      year: key.slice(0, 4),
      month: key.slice(5, 7),
      entries: monthEntries
    }));
}

export interface DiaryDuty {
  date: string;
  jurorId: JudgeSlug;
}

/**
 * Today's and the next few days' duty, resolved from the rotation at build time.
 *
 * Build time, not request time: the site is static. On a day with no build the "today" shown
 * here can lag by a day, which is an acceptable cost for a daily-built archive — and the
 * rotation itself is always recomputed from the calendar, never from what exists.
 */
export function getDutyRoster(days = 3): { today: DiaryDuty | null; upcoming: DiaryDuty[] } {
  const config = getDiaryConfig();
  if (!config) return { today: null, upcoming: [] };

  const todayKey = TimezoneUtil.getJSTDateKey();
  if (daysSinceStart(config, todayKey) < 0) {
    // The experiment has not started yet; show what is coming from the start date.
    return { today: null, upcoming: upcomingDuty(config, config.startDate, days) };
  }

  const roster = upcomingDuty(config, todayKey, days + 1);
  return {
    today: { date: todayKey, jurorId: resolveDutyJuror(config, todayKey) },
    upcoming: roster.slice(1)
  };
}

/** Themes this juror has been writing about lately, most frequent first. */
export function summarizeThemes(entries: DiaryEntry[]): Array<{ theme: DiaryTheme; count: number }> {
  const counts = new Map<DiaryTheme, number>();
  for (const entry of entries) {
    counts.set(entry.theme, (counts.get(entry.theme) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([theme, count]) => ({ theme, count }))
    .sort((a, b) => (b.count === a.count ? a.theme.localeCompare(b.theme) : b.count - a.count));
}

/** Human-readable label for a theme, used in page copy. */
export const DIARY_THEME_LABELS: Record<DiaryTheme, { en: string; ja: string }> = {
  work: { en: 'Work & judging', ja: '仕事と審査' },
  private: { en: 'Private life', ja: '私生活' },
  mixed: { en: 'Work & life', ja: '仕事と私生活' },
  relationship: { en: 'The other jurors', ja: '審査員同士' },
  memory: { en: 'Memory & reflection', ja: '記憶と内省' }
};

/** Test seam: clears the per-build cache. */
export function resetDiaryCache(): void {
  cachedEntries = null;
  cachedConfig = undefined;
}
