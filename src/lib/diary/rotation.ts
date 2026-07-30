import type { JudgeSlug } from '../../schemas/jury';
import type { DiaryConfig } from '../../schemas/diary-state';

/**
 * Whose turn it is to write.
 *
 * The duty cycle is anchored to a start date rather than to weekdays, so it stays a clean
 * five-day rotation that never collides with the weekly review schedule. Two properties matter
 * more than the arithmetic:
 *
 * - **Timezone-independent.** Both the start date and the target date are already-resolved JST
 *   date keys (`YYYY-MM-DD`). They are compared as calendar days through `Date.UTC`, so the
 *   machine's local timezone cannot shift whose turn it is. A run at 23:50 JST and the same
 *   run replayed from a UTC box resolve to the same juror.
 * - **Failure-independent.** Duty follows the calendar, not the archive. A day that failed to
 *   generate leaves a gap and the next day proceeds to the next juror — no catch-up, no shift
 *   (brief §5). This is why the rotation is computed and never read back from what exists.
 */

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const MS_PER_DAY = 86_400_000;

export function isDateKey(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  try {
    toEpochDay(value);
    return true;
  } catch {
    return false;
  }
}

/**
 * Calendar day number for a JST date key. Uses `Date.UTC` purely as calendar arithmetic — the
 * key already carries the JST calendar day, so no further timezone conversion is wanted here.
 */
export function toEpochDay(dateKey: string): number {
  const match = DATE_PATTERN.exec(dateKey);
  if (!match) {
    throw new Error(`[Diary Rotation] Invalid date key: ${dateKey} (expected YYYY-MM-DD).`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const ms = Date.UTC(year, month - 1, day);
  const roundTrip = new Date(ms);
  // Date.UTC silently rolls 2026-02-30 into March. A rolled date would resolve to a plausible
  // but wrong juror, so reject it instead.
  if (
    roundTrip.getUTCFullYear() !== year ||
    roundTrip.getUTCMonth() !== month - 1 ||
    roundTrip.getUTCDate() !== day
  ) {
    throw new Error(`[Diary Rotation] Not a real calendar date: ${dateKey}.`);
  }
  return ms / MS_PER_DAY;
}

export function addDays(dateKey: string, days: number): string {
  const ms = (toEpochDay(dateKey) + days) * MS_PER_DAY;
  return new Date(ms).toISOString().slice(0, 10);
}

/** Whole days from `startDate` to `targetDate`; negative when the target precedes the start. */
export function daysSinceStart(config: DiaryConfig, targetDate: string): number {
  return toEpochDay(targetDate) - toEpochDay(config.startDate);
}

export function resolveDutyJuror(config: DiaryConfig, targetDate: string): JudgeSlug {
  const offset = daysSinceStart(config, targetDate);
  if (offset < 0) {
    throw new Error(
      `[Diary Rotation] ${targetDate} precedes the configured start date ${config.startDate}.`
    );
  }
  return config.rotation[offset % config.rotation.length];
}

export function resolveNextDuty(
  config: DiaryConfig,
  targetDate: string
): { date: string; jurorId: JudgeSlug } {
  const date = addDays(targetDate, 1);
  return { date, jurorId: resolveDutyJuror(config, date) };
}

/** The duty roster from `fromDate` forward, for the "today / next up" panel on the index. */
export function upcomingDuty(
  config: DiaryConfig,
  fromDate: string,
  days: number
): Array<{ date: string; jurorId: JudgeSlug }> {
  const roster: Array<{ date: string; jurorId: JudgeSlug }> = [];
  for (let i = 0; i < days; i++) {
    const date = addDays(fromDate, i);
    if (daysSinceStart(config, date) < 0) continue;
    roster.push({ date, jurorId: resolveDutyJuror(config, date) });
  }
  return roster;
}
