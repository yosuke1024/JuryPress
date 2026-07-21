import * as fs from 'fs';
import * as path from 'path';
import type { Candidate } from '../../schemas/selection';
import { isEligibleGateSource } from '../selection/eligibility';

/**
 * Loading an existing review so it can be re-reviewed as a supersession.
 *
 * A review whose evaluation was scored on evidence the collector has since learned to gather
 * (source it used to miss for Rust, C, or subdirectory layouts) cannot be edited — review.json
 * is immutable after publish. It is replaced instead: the old review is withdrawn, a fresh
 * evaluation is generated for the same project, and the withdrawal points at the successor.
 *
 * The candidate is rebuilt from the target's own selection.json — the same official-source
 * identity it was first reviewed under — so regeneration re-collects from the project itself,
 * never from anything an operator retypes.
 */

export interface RegenerationTarget {
  slug: string;
  reviewDir: string;
  withdrawalPath: string;
  candidate: Candidate;
  canonicalUrl: string;
  /** The target's own selection.json — reused (with a fresh run key) for the successor. */
  selection: Record<string, unknown>;
}

function findReviewDir(contentRoot: string, slug: string): string | null {
  const reviewsDir = path.join(contentRoot, 'reviews');
  if (!fs.existsSync(reviewsDir)) return null;
  for (const year of fs.readdirSync(reviewsDir)) {
    const yearDir = path.join(reviewsDir, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yearDir)) {
      const dir = path.join(yearDir, month, slug);
      if (fs.existsSync(path.join(dir, 'selection.json'))) return dir;
    }
  }
  return null;
}

/**
 * Resolves the regeneration target, or throws with an operator-facing reason. The invariants
 * are deliberately strict, because this is the one path that publishes a second review for a
 * project already reviewed:
 *
 *   - The target must exist and carry a selection.json (the official-source identity).
 *   - It MUST already be editorially withdrawn. Regeneration replaces a withdrawn review; the
 *     withdrawal is what keeps "one live review per project" true while both briefly coexist,
 *     and requiring it first makes the supersession a deliberate, recorded decision rather
 *     than a side effect of a regeneration run.
 */
export function loadRegenerationTarget(contentRoot: string, slug: string): RegenerationTarget {
  const reviewDir = findReviewDir(contentRoot, slug);
  if (!reviewDir) {
    throw new Error(`[Regenerate] No review found for slug "${slug}".`);
  }
  const withdrawalPath = path.join(reviewDir, 'editorial-withdrawal.json');
  if (!fs.existsSync(withdrawalPath)) {
    throw new Error(
      `[Regenerate] Review "${slug}" is not editorially withdrawn. Withdraw it first: ` +
        'regeneration replaces a withdrawn review, and the withdrawal keeps one live review per project.'
    );
  }

  const selection = JSON.parse(fs.readFileSync(path.join(reviewDir, 'selection.json'), 'utf8'));
  const canonicalUrl = selection.canonical_url;
  if (typeof canonicalUrl !== 'string' || canonicalUrl === '') {
    throw new Error(`[Regenerate] Review "${slug}" has no canonical_url in its selection.json.`);
  }
  // The same host policy the daily selector applies before it collects, enforced here so an
  // unsupported host is refused BEFORE any fetch — regeneration never collects from a host
  // the gate would reject.
  if (!isEligibleGateSource(canonicalUrl)) {
    throw new Error(
      `[Regenerate] Review "${slug}" canonical_url "${canonicalUrl}" is not a supported public source; refusing to collect.`
    );
  }

  const candidate: Candidate = {
    source: selection.source,
    sourceId: selection.source_id,
    name: selection.candidate_name,
    canonicalUrl,
    sourceUrl: selection.source_url,
    sourceRank: selection.source_rank ?? 1,
    popularityValue: selection.popularity_value ?? 0,
    popularityUnit: selection.popularity_unit ?? 'unknown',
    collectedAt: new Date().toISOString(),
    metadata: selection.candidate_metadata ?? {}
  };

  return { slug, reviewDir, withdrawalPath, candidate, canonicalUrl, selection };
}

/**
 * Records the successor on the withdrawn review's withdrawal file. Called after the new review
 * is published, so a reader on the old page can reach the one that replaced it. The withdrawal
 * file is regenerable bookkeeping (unlike review.json), so updating it here is allowed.
 */
export function linkSuccessor(withdrawalPath: string, successorSlug: string): void {
  const record = JSON.parse(fs.readFileSync(withdrawalPath, 'utf8'));
  record.superseded_by = successorSlug;
  fs.writeFileSync(withdrawalPath, JSON.stringify(record, null, 2) + '\n');
}
