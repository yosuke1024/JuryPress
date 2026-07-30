import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A deliberately small, tolerant reader for published reviews.
 *
 * `getAllReviews()` is the wrong tool here even though it reads the same files: it re-derives
 * every score, cross-checks integrity, and throws on any inconsistency. That is exactly right
 * for building the review site and exactly wrong for a diary, which would then fail to
 * generate because of a defect in an unrelated article from three weeks ago.
 *
 * So this reads only what a diary needs — a slug to link to, a name to mention, and what this
 * juror said — and skips anything it cannot parse. A missing review context yields a diary
 * about something else, which is a perfectly good day (brief §17.3).
 */

export interface DiaryReviewSummary {
  slug: string;
  publishedAt: string;
  productName: string;
  headline: string;
  /** What the duty juror concluded about this product, when available. */
  jurorVerdict: string | null;
}

function reviewsDir(contentRoot: string): string {
  return path.join(contentRoot, 'reviews');
}

/** Every published review directory, as `<path to review.json>`. Empty when none exist. */
function listReviewFiles(contentRoot: string): string[] {
  const root = reviewsDir(contentRoot);
  if (!fs.existsSync(root)) return [];
  const files: string[] = [];
  for (const year of fs.readdirSync(root).sort()) {
    const yearDir = path.join(root, year);
    if (!safeIsDirectory(yearDir)) continue;
    for (const month of fs.readdirSync(yearDir).sort()) {
      const monthDir = path.join(yearDir, month);
      if (!safeIsDirectory(monthDir)) continue;
      for (const slug of fs.readdirSync(monthDir).sort()) {
        const reviewPath = path.join(monthDir, slug, 'review.json');
        if (fs.existsSync(reviewPath)) files.push(reviewPath);
      }
    }
  }
  return files;
}

function safeIsDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Slugs a diary is allowed to link to. Link integrity is the whole point: a related-review
 * link that 404s is a broken page, whereas a diary that mentions no reviews is just a diary.
 */
export function listReviewSlugs(contentRoot: string): string[] {
  const slugs: string[] = [];
  for (const filePath of listReviewFiles(contentRoot)) {
    const review = readReviewLoosely(filePath);
    if (review?.slug) slugs.push(review.slug);
  }
  return slugs;
}

function readReviewLoosely(filePath: string): Record<string, any> | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/** The most recent reviews, newest first, with this juror's own verdict attached. */
export function readRecentReviews(
  contentRoot: string,
  jurorId: string,
  limit: number
): DiaryReviewSummary[] {
  const summaries: DiaryReviewSummary[] = [];

  for (const filePath of listReviewFiles(contentRoot)) {
    const review = readReviewLoosely(filePath);
    if (!review || typeof review.slug !== 'string') continue;

    const evaluation = review.evaluation ?? {};
    const judges: any[] = Array.isArray(evaluation.judges) ? evaluation.judges : [];
    const own = judges.find((judge) => judge?.judge_id === jurorId);

    summaries.push({
      slug: review.slug,
      publishedAt: typeof review.published_at === 'string' ? review.published_at : '',
      productName: typeof evaluation?.product?.name === 'string' ? evaluation.product.name : review.slug,
      headline: typeof evaluation?.article?.headline === 'string' ? evaluation.article.headline : '',
      jurorVerdict: typeof own?.verdict === 'string' ? own.verdict : null
    });
  }

  return summaries
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit);
}
