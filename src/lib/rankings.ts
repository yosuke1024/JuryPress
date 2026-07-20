import type { ReviewEntry } from './data';
import { sortReviews } from './data';
import { getRankedReviews } from './ranking-eligibility';

/**
 * Ranking eligibility lives in ./ranking-eligibility so that data.ts can share it without an
 * import cycle. Re-exported here because every ranking surface already imports from this file.
 */
export {
  CURRENT_COHORT,
  isCurrentCohortReview,
  getEffectiveEvidenceMapStatus,
  getRankingEligibility,
  isRankingEligible,
  isHistoricalMethodology,
  isEditoriallyWithdrawn,
  findSupersededReview,
  getRankedReviews
} from './ranking-eligibility';
export type {
  EffectiveEvidenceMapStatus,
  RankingExclusionReason,
  RankingEligibility
} from './ranking-eligibility';

export type PeriodKind = 'annual' | 'monthly' | 'weekly';

export interface JSTCivilDate {
  year: number;
  month: number;
  day: number;
}

/** Calendar date as observed in Asia/Tokyo, regardless of the instant's own offset. */
export function toJSTCivilDate(dateInput: string | Date): JSTCivilDate {
  const d = typeof dateInput === 'string' ? new Date(dateInput) : dateInput;
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Invalid date for JST conversion: ${String(dateInput)}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);
  const p = Object.fromEntries(parts.map(x => [x.type, x.value]));
  return { year: Number(p.year), month: Number(p.month), day: Number(p.day) };
}

/**
 * ISO-8601 week: weeks start Monday and end Sunday, and belong to the week-year that
 * owns their Thursday. Around New Year the week-year can differ from the calendar year.
 */
export function toISOWeek(civil: JSTCivilDate): { weekYear: number; week: number } {
  const d = new Date(Date.UTC(civil.year, civil.month - 1, civil.day));
  const isoDayIndex = (d.getUTCDay() + 6) % 7; // Monday = 0 … Sunday = 6
  d.setUTCDate(d.getUTCDate() - isoDayIndex + 3); // Thursday of this week
  const weekYear = d.getUTCFullYear();

  const firstThursday = new Date(Date.UTC(weekYear, 0, 4));
  const firstIsoDayIndex = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstIsoDayIndex + 3);

  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 24 * 60 * 60 * 1000));
  return { weekYear, week };
}

const pad2 = (n: number) => String(n).padStart(2, '0');

/** Period key for an instant, in JST: `YYYY` / `YYYY-MM` / `YYYY-Www`. */
export function getPeriodKey(kind: PeriodKind, dateInput: string | Date): string {
  const civil = toJSTCivilDate(dateInput);
  if (kind === 'annual') return String(civil.year);
  if (kind === 'monthly') return `${civil.year}-${pad2(civil.month)}`;
  const { weekYear, week } = toISOWeek(civil);
  return `${weekYear}-W${pad2(week)}`;
}

export function getReviewPeriodKey(kind: PeriodKind, entry: ReviewEntry): string {
  return getPeriodKey(kind, entry.review.published_at);
}

const PERIOD_KEY_PATTERN: Record<PeriodKind, RegExp> = {
  annual: /^\d{4}$/,
  monthly: /^\d{4}-(0[1-9]|1[0-2])$/,
  weekly: /^\d{4}-W(0[1-9]|[1-4]\d|5[0-3])$/
};

export function isValidPeriodKey(kind: PeriodKind, key: string): boolean {
  return PERIOD_KEY_PATTERN[kind].test(key);
}

/**
 * Every period that actually holds at least one Current Cohort review, ascending.
 * Periods with no reviews — including future ones — are never produced, so no static
 * page is generated for them.
 */
export function listPeriodKeys(kind: PeriodKind, entries: ReviewEntry[]): string[] {
  const keys = new Set<string>();
  for (const entry of getRankedReviews(entries)) {
    keys.add(getReviewPeriodKey(kind, entry));
  }
  return Array.from(keys).sort();
}

/** Current Cohort reviews inside one period, ranked with the existing sortReviews(). */
export function getPeriodReviews(kind: PeriodKind, key: string, entries: ReviewEntry[]): ReviewEntry[] {
  return sortReviews(
    getRankedReviews(entries).filter(entry => getReviewPeriodKey(kind, entry) === key)
  );
}

export interface PeriodNeighbours {
  previous: string | null;
  next: string | null;
}

export function getPeriodNeighbours(key: string, allKeys: string[]): PeriodNeighbours {
  const index = allKeys.indexOf(key);
  if (index === -1) return { previous: null, next: null };
  return {
    previous: index > 0 ? allKeys[index - 1] : null,
    next: index < allKeys.length - 1 ? allKeys[index + 1] : null
  };
}

export function getLatestPeriodKey(kind: PeriodKind, entries: ReviewEntry[]): string | null {
  const keys = listPeriodKeys(kind, entries);
  return keys.length > 0 ? keys[keys.length - 1] : null;
}

export function periodPath(kind: PeriodKind, key: string): string {
  return `/rankings/${kind}/${key}/`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function formatPeriodLabel(kind: PeriodKind, key: string): string {
  if (kind === 'annual') return key;
  if (kind === 'monthly') {
    const [year, month] = key.split('-');
    return `${MONTH_NAMES[Number(month) - 1]} ${year}`;
  }
  const [weekYear, week] = key.split('-W');
  return `Week ${week}, ${weekYear}`;
}
