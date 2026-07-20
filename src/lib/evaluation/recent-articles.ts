import * as fs from 'fs';
import * as path from 'path';

/**
 * Openings from the most recently published reviews, shown to the writer so it does not
 * reuse them.
 *
 * Two consecutive reviews arrived at the same headline shape:
 *
 *   "A brilliant visual permission matrix wrapped in a fragile, single-file frontend."
 *   "A brilliant terminal interface chained to a closed corporate monorepo."
 *
 * Each is a good headline. Repeated, the pattern becomes the voice, and a house style that
 * fits every product is a style that describes none of them — which is how automated writing
 * starts reading as automated. The fix is to show the writer what it just did, not to add a
 * similarity gate: a validator here would reject finished articles over phrasing, which is
 * exactly the audit-era failure this pipeline moved away from.
 */

export interface RecentArticleOpening {
  headline: string;
  standfirstOpening: string;
  verdictOpening: string;
}

/** How many previous reviews the writer is shown. */
export const RECENT_ARTICLE_COUNT = 3;

function firstSentence(text: unknown): string {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const match = trimmed.match(/^.*?[.!?](?=\s|$)/);
  return (match ? match[0] : trimmed).slice(0, 200);
}

/**
 * Reads the most recent published reviews from the content root.
 *
 * Best effort by design: this shapes prose and nothing depends on it, so a missing directory,
 * an unreadable file or an unexpected shape yields fewer openings — never an exception. A
 * generation run must not fail because the archive could not be listed.
 */
export function readRecentArticleOpenings(
  contentRoot: string,
  limit: number = RECENT_ARTICLE_COUNT
): RecentArticleOpening[] {
  const reviewsDir = path.join(contentRoot, 'reviews');
  const found: { publishedAt: string; opening: RecentArticleOpening }[] = [];

  try {
    if (!fs.existsSync(reviewsDir)) return [];
    for (const year of fs.readdirSync(reviewsDir)) {
      for (const month of fs.readdirSync(path.join(reviewsDir, year))) {
        for (const slug of fs.readdirSync(path.join(reviewsDir, year, month))) {
          const file = path.join(reviewsDir, year, month, slug, 'review.json');
          if (!fs.existsSync(file)) continue;
          try {
            const review = JSON.parse(fs.readFileSync(file, 'utf8'));
            const article = review?.evaluation?.article;
            const headline = typeof article?.headline === 'string' ? article.headline.trim() : '';
            if (headline === '') continue;
            found.push({
              publishedAt: typeof review.published_at === 'string' ? review.published_at : '',
              opening: {
                headline,
                standfirstOpening: firstSentence(article?.standfirst),
                verdictOpening: firstSentence(article?.final_verdict)
              }
            });
          } catch {
            // One unreadable review does not stop the rest.
          }
        }
      }
    }
  } catch {
    return [];
  }

  return found
    .sort((a, b) => b.publishedAt.localeCompare(a.publishedAt))
    .slice(0, limit)
    .map(entry => entry.opening);
}

/**
 * The prompt section. Empty string when there is nothing to show, so the first reviews of a
 * season carry no section at all rather than an empty heading.
 */
export function buildRecentArticleBlock(openings: readonly RecentArticleOpening[]): string {
  if (openings.length === 0) return '';

  const listed = openings
    .map((opening, index) => {
      const lines = [`${index + 1}. Headline: ${opening.headline}`];
      if (opening.standfirstOpening) lines.push(`   Standfirst opened: ${opening.standfirstOpening}`);
      if (opening.verdictOpening) lines.push(`   Verdict opened: ${opening.verdictOpening}`);
      return lines.join('\n');
    })
    .join('\n');

  return `
=== THE PUBLICATION'S LAST ${openings.length} REVIEW${openings.length === 1 ? '' : 'S'} ===
${listed}
=========================================

These are for contrast, not imitation. Do not reuse their syntax, contrast pattern, opening phrase, or rhetorical structure. If your headline would share a shape with one of them — the same "A brilliant X wrapped in Y" construction, the same two-clause pivot, the same opening word — find a different one that fits THIS project. They say nothing about the project you are reviewing; do not carry over their judgments, comparisons, or tone.
`;
}
