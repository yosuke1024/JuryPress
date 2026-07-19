import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { ReviewSchema } from '../../src/schemas/review';
import { EvidenceBundleSchema } from '../../src/schemas/evidence';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { validateRefinedReviewIntegrity } from '../../src/lib/publication-integrity';

/**
 * Already-published reviews must keep rendering byte-identically after the editorial-first
 * change. This is the constraint that turns a redesign into a migration rather than a
 * rewrite: the audit-era articles were generated to satisfy the old contract, that contract
 * is what their pages still advertise, and nothing here may relax it retroactively.
 *
 * Runs against the operator's real content repository when it is present, and skips cleanly
 * when it is not (CI runners without the private checkout).
 */
const CONTENT_ROOT = path.resolve(__dirname, '..', '..', '..', 'JuryPress-content', 'data');
const REVIEWS_DIR = path.join(CONTENT_ROOT, 'reviews');
const available = fs.existsSync(REVIEWS_DIR);

interface PublishedReview {
  slug: string;
  dir: string;
  review: any;
  bundle: any;
}

function loadPublishedReviews(): PublishedReview[] {
  const out: PublishedReview[] = [];
  for (const year of fs.readdirSync(REVIEWS_DIR)) {
    const yearDir = path.join(REVIEWS_DIR, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      for (const slug of fs.readdirSync(monthDir)) {
        const dir = path.join(monthDir, slug);
        const reviewPath = path.join(dir, 'review.json');
        if (!fs.existsSync(reviewPath)) continue;
        const evidencePath = path.join(dir, 'evidence.json');
        out.push({
          slug,
          dir,
          review: JSON.parse(fs.readFileSync(reviewPath, 'utf8')),
          bundle: fs.existsSync(evidencePath)
            ? EvidenceBundleSchema.parse(JSON.parse(fs.readFileSync(evidencePath, 'utf8')))
            : null
        });
      }
    }
  }
  return out;
}

describe.skipIf(!available)('Published reviews keep rendering after the editorial-first change', () => {
  const reviews = available ? loadPublishedReviews() : [];

  it('finds the published corpus', () => {
    expect(reviews.length).toBeGreaterThan(0);
  });

  it('every published review still parses against the review schema union', () => {
    for (const { slug, review } of reviews) {
      const parsed = ReviewSchema.safeParse(review);
      expect(parsed.success, `${slug} failed schema validation: ${parsed.success ? '' : parsed.error.message}`).toBe(true);
    }
  });

  it('score recalculation still reproduces every published number', () => {
    // data.ts re-runs this on every site build and throws on any mismatch, so a drift here
    // is a broken deploy for the whole site, not just for one article.
    const evaluator = new Evaluator();
    for (const { slug, review, bundle } of reviews) {
      const recalculated: any = evaluator.recalculateScores(
        review.evaluation,
        bundle?.evidences,
        review
      );
      const EPSILON = 0.0001;
      const savedScore = review.evaluation.recalculated_jury_score;
      if (savedScore === null || recalculated.recalculated_jury_score === null) {
        expect(savedScore, slug).toBe(recalculated.recalculated_jury_score);
      } else {
        expect(Math.abs(savedScore - recalculated.recalculated_jury_score), slug).toBeLessThan(EPSILON);
      }
      const savedConfidence = review.evaluation.overall_evidence_confidence ?? 0;
      const calcConfidence = recalculated.overall_evidence_confidence ?? 0;
      expect(Math.abs(savedConfidence - calcConfidence), `${slug} confidence`).toBeLessThan(EPSILON);
    }
  });

  it('audit-era reviews still satisfy the full refined publication gate', () => {
    const refined = reviews.filter(r => r.review.evaluation?.evaluation_integrity_version === '1.0.0');
    // The corpus contains refined articles; if this ever hits zero the assertion below is
    // vacuous and the guarantee has quietly stopped being tested.
    expect(refined.length).toBeGreaterThan(0);
    for (const { slug, review, bundle } of refined) {
      expect(bundle, `${slug} has no evidence bundle`).not.toBeNull();
      expect(() => validateRefinedReviewIntegrity(review, bundle, slug)).not.toThrow();
    }
  });

  it('audit-era reviews keep their per-sentence provenance record', () => {
    const refined = reviews.filter(r => r.review.evaluation?.evaluation_integrity_version === '1.0.0');
    for (const { slug, review } of refined) {
      expect(review.evaluation.claim_references?.length, `${slug} lost its claim references`).toBeGreaterThan(0);
      expect(review.evaluation.article.evidence_classifications, slug).toBeDefined();
    }
  });

  it('no published review has been retroactively migrated to the editorial schema', () => {
    // The editorial pipeline applies to NEW generations. Rewriting an existing article's
    // schema would silently drop the provenance record its page still advertises.
    for (const { slug, review } of reviews) {
      if (review.schema_version === '3.0.0') {
        expect(review.prompt_version?.startsWith('4.'), `${slug} claims V3 without an editorial prompt`).toBe(true);
      }
    }
  });
});
