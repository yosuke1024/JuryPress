import type { ReviewEntry } from './data';

export interface GroupedMonth {
  monthName: string; // "July", etc.
  monthKey: string;  // "07"
  reviews: ReviewEntry[];
}

export interface GroupedYear {
  year: string; // "2026"
  months: GroupedMonth[];
}

export function sortReviewsByPublishedAt(reviews: ReviewEntry[]): ReviewEntry[] {
  // Validate all dates first to fail fast during build
  for (const entry of reviews) {
    const date = Date.parse(entry.review.published_at);
    if (isNaN(date)) {
      throw new Error(`Invalid published_at for review ${entry.slug}`);
    }
  }

  return [...reviews].sort((a, b) => {
    const dateA = Date.parse(a.review.published_at);
    const dateB = Date.parse(b.review.published_at);

    if (dateA !== dateB) {
      return dateB - dateA;
    }

    return a.slug.localeCompare(b.slug);
  });
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

export function groupReviewsByYearAndMonth(reviews: ReviewEntry[]): GroupedYear[] {
  const sorted = sortReviewsByPublishedAt(reviews);
  const yearsMap = new Map<string, Map<string, ReviewEntry[]>>();

  for (const entry of sorted) {
    const date = new Date(entry.review.published_at);
    const yearStr = date.getUTCFullYear().toString();
    const monthNum = date.getUTCMonth(); // 0-11
    const monthKey = (monthNum + 1).toString().padStart(2, '0');

    if (!yearsMap.has(yearStr)) {
      yearsMap.set(yearStr, new Map<string, ReviewEntry[]>());
    }
    const monthsMap = yearsMap.get(yearStr)!;
    if (!monthsMap.has(monthKey)) {
      monthsMap.set(monthKey, []);
    }
    monthsMap.get(monthKey)!.push(entry);
  }

  const groupedYears: GroupedYear[] = [];
  const sortedYears = Array.from(yearsMap.keys()).sort((a, b) => b.localeCompare(a)); // Newest year first

  for (const year of sortedYears) {
    const monthsMap = yearsMap.get(year)!;
    const sortedMonths = Array.from(monthsMap.keys()).sort((a, b) => b.localeCompare(a)); // Newest month first
    const months: GroupedMonth[] = [];

    for (const monthKey of sortedMonths) {
      const monthNum = parseInt(monthKey, 10) - 1;
      const monthName = MONTH_NAMES[monthNum];
      months.push({
        monthName,
        monthKey,
        reviews: monthsMap.get(monthKey)!
      });
    }

    groupedYears.push({
      year,
      months
    });
  }

  return groupedYears;
}

export function normalizeSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim();
}

export function buildReviewSearchText(entry: ReviewEntry): string {
  const parts = [
    entry.review.evaluation.product.name,
    entry.review.evaluation.product.category,
    entry.review.evaluation.article.headline,
    entry.review.evaluation.article.standfirst,
    entry.selection.source,
    entry.slug
  ];
  return parts.map(p => normalizeSearchText(p || '')).join(' ');
}
