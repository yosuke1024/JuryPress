/**
 * GitHub Discussions configuration for per-review comment threads (giscus).
 *
 * Why: the Discussion mapping key must be stable across environments (local,
 * preview, production base paths) and across headline edits, so it is derived
 * from the review's immutable `slug` alone — never from pathname, canonical
 * URL, or title. See docs/current/review-discussions.md.
 */

export const DISCUSSIONS_REPO = "yosuke1024/JuryPress";
export const DISCUSSIONS_REPO_ID = "R_kgDOTW0LAA";
export const DISCUSSIONS_CATEGORY = "Review Comments";
export const DISCUSSIONS_CATEGORY_ID = "DIC_kwDOTW0LAM4DBb8x";
export const DISCUSSIONS_CATEGORY_URL =
  "https://github.com/yosuke1024/JuryPress/discussions/categories/review-comments";

/**
 * The giscus `data-term` value for a review's Discussion. Pure function of
 * `slug` — must never depend on pathname, base path, canonical URL, or title.
 */
export function reviewDiscussionTerm(slug: string): string {
  return `JuryPress review: ${slug}`;
}
