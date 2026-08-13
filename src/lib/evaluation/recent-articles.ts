import * as fs from 'fs';
import * as path from 'path';
import { collectMarkedIntensity, type RecentReviewIntensity } from './editorial-intensity';

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
 *
 * #109 found the same failure one level up: "masterclass" appeared once in each of three
 * reviews inside one week, invisible to any single article because it never repeated WITHIN
 * one. `intensityWords` and `readRecentReviewIntensity` extend the same fix — show the writer
 * what the publication just spent — to a vocabulary the writer cannot see from its own draft.
 */

export interface RecentArticleOpening {
  headline: string;
  standfirstOpening: string;
  verdictOpening: string;
  /** Marked intensity words (editorial-intensity.ts) that review's own text already spent. */
  intensityWords: readonly string[];
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

/** One review as read off disk, before it is shaped into either an opening or an intensity entry. */
interface StoredReview {
  slug: string;
  publishedAt: string;
  evaluation: unknown;
}

/**
 * Walks the archive once and returns every review it can parse, newest first. Shared by
 * `readRecentArticleOpenings` and `readRecentReviewIntensity` so the two views of "the
 * publication's recent reviews" can never disagree about which reviews those are or what order
 * they come in.
 *
 * Best effort by design: nothing downstream of this depends on it succeeding, so a missing
 * directory, an unreadable file or an unexpected shape yields fewer reviews — never an
 * exception. A generation or validation run must not fail because the archive could not be
 * listed.
 */
function listStoredReviews(contentRoot: string): StoredReview[] {
  const reviewsDir = path.join(contentRoot, 'reviews');
  const found: StoredReview[] = [];

  try {
    if (!fs.existsSync(reviewsDir)) return [];
    for (const year of fs.readdirSync(reviewsDir)) {
      for (const month of fs.readdirSync(path.join(reviewsDir, year))) {
        for (const slug of fs.readdirSync(path.join(reviewsDir, year, month))) {
          const file = path.join(reviewsDir, year, month, slug, 'review.json');
          if (!fs.existsSync(file)) continue;
          try {
            const review = JSON.parse(fs.readFileSync(file, 'utf8'));
            found.push({
              slug: typeof review?.slug === 'string' ? review.slug : slug,
              publishedAt: typeof review?.published_at === 'string' ? review.published_at : '',
              evaluation: review?.evaluation
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

  return found.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
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
  const openings: RecentArticleOpening[] = [];

  for (const stored of listStoredReviews(contentRoot)) {
    const article = (stored.evaluation as any)?.article;
    const headline = typeof article?.headline === 'string' ? article.headline.trim() : '';
    if (headline === '') continue;
    openings.push({
      headline,
      standfirstOpening: firstSentence(article?.standfirst),
      verdictOpening: firstSentence(article?.final_verdict),
      intensityWords: collectMarkedIntensity(stored.evaluation)
    });
    if (openings.length >= limit) break;
  }

  return openings;
}

/**
 * Reads the marked intensity words the publication's recent reviews already spent, for the
 * cross-article check in editorial-intensity.ts. `excludeSlug` matters here in a way it does
 * not for `readRecentArticleOpenings`: this function is also called while REVALIDATING an
 * already-published record, and that record's own review.json sits in the same archive this
 * function walks — without excluding it, a record would compare its intensity words against
 * itself and manufacture a cross-article match out of nothing.
 *
 * Best effort by design, for the same reason as `listStoredReviews`: this feeds a warning, not
 * a gate, so a failure here yields no comparison rather than a failed run.
 */
export function readRecentReviewIntensity(
  contentRoot: string,
  options?: { excludeSlug?: string | null; limit?: number }
): RecentReviewIntensity[] {
  try {
    const limit = options?.limit ?? RECENT_ARTICLE_COUNT;
    const excludeSlug = options?.excludeSlug ?? null;
    return listStoredReviews(contentRoot)
      .filter(stored => stored.slug !== excludeSlug)
      .slice(0, limit)
      .map(stored => ({ slug: stored.slug, words: collectMarkedIntensity(stored.evaluation) }));
  } catch {
    return [];
  }
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
      if (opening.intensityWords.length > 0) lines.push(`   Intensity spent: ${opening.intensityWords.join(', ')}`);
      return lines.join('\n');
    })
    .join('\n');

  // The spent-words rule only earns its place when there are spent words to point at: a
  // paragraph about "the intensity words listed above" over a list that names none reads as
  // boilerplate, and boilerplate is exactly what teaches the writer to skim this section.
  const anySpent = openings.some(opening => opening.intensityWords.length > 0);
  const spentParagraph = anySpent
    ? `
The intensity words listed above are already spent. A rare superlative — masterclass, phenomenal, stellar, a triumph — that appears in consecutive reviews stops describing any single project and becomes the publication's tic; if one of them fits your draft, replace it with the specific observation that earned it. Two different projects cannot both be a masterclass in the same week without both claims going flat.
`
    : '';

  return `
=== THE PUBLICATION'S LAST ${openings.length} REVIEW${openings.length === 1 ? '' : 'S'} ===
${listed}
=========================================

These are for contrast, not imitation. Do not reuse their syntax, contrast pattern, opening phrase, or rhetorical structure. If your headline would share a shape with one of them — the same "A brilliant X wrapped in Y" construction, the same two-clause pivot, the same opening word — find a different one that fits THIS project. They say nothing about the project you are reviewing; do not carry over their judgments, comparisons, or tone.
${spentParagraph}`;
}
