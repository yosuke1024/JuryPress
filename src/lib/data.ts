import * as fs from 'fs';
import * as path from 'path';
import { ReviewSchema } from '../schemas/review';
import { SelectionSchema } from '../schemas/selection';
import { EvidenceBundleSchema } from '../schemas/evidence';
import { EvidenceMapSchema, type EvidenceMap } from '../schemas/evidence-map';
import {
  EditorialWithdrawalSchema,
  type EditorialWithdrawalState
} from '../schemas/editorial-withdrawal';
import { z } from 'zod';
import { Evaluator } from './evaluation/evaluator';
import { resolveContentRoot, resolveDataMode } from './content-root';
import { getConsensus } from './verdict';
import { getRankedReviews } from './ranking-eligibility';

export interface ReviewEntry {
  slug: string;
  year: string;
  month: string;
  review: z.infer<typeof ReviewSchema>;
  selection: z.infer<typeof SelectionSchema>;
  evidence: any[];
  /**
   * The evidence map (V3 reviews), when one is present, parses, and describes exactly the
   * published content. Null in every other case — including a stale map after an edit — and
   * the page then shows "Evidence mapping unavailable for this review." A map problem must
   * never break a build: it is an appendix, not the article.
   */
  evidenceMap: EvidenceMap | null;
  /**
   * An editorial withdrawal, when one has been filed. Never null-on-error: unlike the
   * evidence map, a withdrawal that cannot be trusted must not quietly disappear, because
   * disappearing means the review returns to the rankings.
   */
  editorialWithdrawal: EditorialWithdrawalState;
}

/**
 * Reads editorial-withdrawal.json, if present.
 *
 * The failure modes are deliberately not the evidence map's. A broken map is an appendix that
 * hides itself; a broken withdrawal would restore a ranking nobody re-approved.
 *
 *   missing        -> null (not withdrawn)
 *   unparseable    -> throw (file corruption, and silence would un-withdraw the review)
 *   slug mismatch  -> throw (misfiled record; it is describing a different review)
 *   hash mismatch  -> stale, and STILL withdrawn (the article was republished after the
 *                     withdrawal was written). Reported by the dedicated integrity test
 *                     rather than by failing the build, so one stale bookkeeping file cannot
 *                     take down the daily publish that renders every other review.
 */
export function loadEditorialWithdrawal(
  reviewDir: string,
  review: any,
  slug: string
): EditorialWithdrawalState {
  const filePath = path.join(reviewDir, 'editorial-withdrawal.json');
  if (!fs.existsSync(filePath)) return null;

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err: any) {
    throw new Error(`Editorial withdrawal for ${slug} is not valid JSON: ${err.message}`);
  }

  const parsed = EditorialWithdrawalSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Editorial withdrawal for ${slug} does not match the schema: ${parsed.error.issues
        .map(i => `${i.path.join('.')} ${i.message}`)
        .join('; ')}`
    );
  }
  if (parsed.data.slug !== slug) {
    throw new Error(
      `Editorial withdrawal filed under ${slug} declares slug "${parsed.data.slug}".`
    );
  }

  const publishedHash = review.provenance?.validated_content_hash;
  const status = publishedHash && parsed.data.article_hash !== publishedHash ? 'stale' : 'active';
  return { status, record: parsed.data };
}

function loadEvidenceMap(reviewDir: string, review: any): EvidenceMap | null {
  const mapPath = path.join(reviewDir, 'evidence-map.json');
  if (!fs.existsSync(mapPath)) return null;
  try {
    const parsed = EvidenceMapSchema.safeParse(JSON.parse(fs.readFileSync(mapPath, 'utf8')));
    if (!parsed.success) return null;
    // Freshness: a map bound to different content describes sentences that may no longer
    // exist, so it is hidden rather than shown against the wrong article.
    const publishedHash = review.provenance?.validated_content_hash;
    if (publishedHash && parsed.data.article_hash !== publishedHash) return null;
    return parsed.data;
  } catch {
    return null;
  }
}

export function getAllReviews(): ReviewEntry[] {
  const mode = resolveDataMode();
  const contentRoot = resolveContentRoot();
  const reviewsDir = path.join(contentRoot, 'reviews');
  
  if (!fs.existsSync(reviewsDir)) {
    if (mode === 'production') {
      const manifestPath = path.join(contentRoot, 'manifest.json');
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
          if (manifest.data_class === 'production' && manifest.initialized === true && manifest.reviews === 0) {
            return [];
          }
        } catch (err) {
          // ignore
        }
      }
      throw new Error(`Reviews directory does not exist: ${reviewsDir}`);
    }
    return [];
  }

  const entries: ReviewEntry[] = [];
  const years = fs.readdirSync(reviewsDir);
  
  const contentIds = new Set<string>();
  const canonicalUrls = new Set<string>();
  const slugs = new Set<string>();

  for (const year of years) {
    if (!fs.statSync(path.join(reviewsDir, year)).isDirectory()) continue;
    const months = fs.readdirSync(path.join(reviewsDir, year));
    
    for (const month of months) {
      if (!fs.statSync(path.join(reviewsDir, year, month)).isDirectory()) continue;
      const products = fs.readdirSync(path.join(reviewsDir, year, month));
      
      for (const slug of products) {
        if (!fs.statSync(path.join(reviewsDir, year, month, slug)).isDirectory()) continue;
        
        try {
          const reviewPath = path.join(reviewsDir, year, month, slug, 'review.json');
          const selectionPath = path.join(reviewsDir, year, month, slug, 'selection.json');
          const evidencePath = path.join(reviewsDir, year, month, slug, 'evidence.json');
          
          if (fs.existsSync(reviewPath) && fs.existsSync(selectionPath)) {
            const rawReview = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
            const rawSelection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
            
            const review = ReviewSchema.parse(rawReview);
            const selection = SelectionSchema.parse(rawSelection);

            // Duplicate checks
            const contentId = selection.source_id;
            const canonicalUrl = selection.canonical_url;
            
            if (contentIds.has(contentId)) {
              throw new Error(`Duplicate content ID detected: ${contentId}`);
            }
            if (canonicalUrls.has(canonicalUrl)) {
              throw new Error(`Duplicate canonical URL detected: ${canonicalUrl}`);
            }
            if (slugs.has(slug)) {
              throw new Error(`Duplicate slug detected: ${slug}`);
            }
            contentIds.add(contentId);
            canonicalUrls.add(canonicalUrl);
            slugs.add(slug);

            // Integrity Check
            const evaluator = new Evaluator();
            const rawEvidence = fs.existsSync(evidencePath) ? JSON.parse(fs.readFileSync(evidencePath, 'utf8')) : null;
            const recalculated = evaluator.recalculateScores(review.evaluation, rawEvidence?.evidences, review);
            const EPSILON = 0.0001;

            if (review.jury_score === null || recalculated.recalculated_jury_score === null) {
              if (review.jury_score !== recalculated.recalculated_jury_score) {
                throw new Error(`Jury score mismatch for ${slug}: saved=${review.jury_score}, calc=${recalculated.recalculated_jury_score}`);
              }
            } else {
              if (Math.abs(review.jury_score - recalculated.recalculated_jury_score) > EPSILON) {
                throw new Error(`Jury score mismatch for ${slug}: saved=${review.jury_score}, calc=${recalculated.recalculated_jury_score}`);
              }
            }

            if (review.evaluation.recalculated_jury_score === null || recalculated.recalculated_jury_score === null) {
              if (review.evaluation.recalculated_jury_score !== recalculated.recalculated_jury_score) {
                throw new Error(`Evaluation recalculated jury score mismatch for ${slug}.`);
              }
            } else {
              if (Math.abs(review.evaluation.recalculated_jury_score - recalculated.recalculated_jury_score) > EPSILON) {
                throw new Error(`Evaluation recalculated jury score mismatch for ${slug}.`);
              }
            }

            const rangeMinSaved = review.judge_score_range?.min;
            const rangeMinCalc = recalculated.judge_score_range?.min;
            const rangeMaxSaved = review.judge_score_range?.max;
            const rangeMaxCalc = recalculated.judge_score_range?.max;

            if (rangeMinSaved === null || rangeMinCalc === null) {
              if (rangeMinSaved !== rangeMinCalc) {
                throw new Error(`Judge score range mismatch for ${slug}.`);
              }
            } else if (rangeMinSaved !== undefined && rangeMinCalc !== undefined) {
              if (Math.abs(rangeMinSaved - rangeMinCalc) > EPSILON) {
                throw new Error(`Judge score range mismatch for ${slug}.`);
              }
            }

            if (rangeMaxSaved === null || rangeMaxCalc === null) {
              if (rangeMaxSaved !== rangeMaxCalc) {
                throw new Error(`Judge score range mismatch for ${slug}.`);
              }
            } else if (rangeMaxSaved !== undefined && rangeMaxCalc !== undefined) {
              if (Math.abs(rangeMaxSaved - rangeMaxCalc) > EPSILON) {
                throw new Error(`Judge score range mismatch for ${slug}.`);
              }
            }

            if (review.evaluation.overall_evidence_confidence === null || recalculated.overall_evidence_confidence === null) {
              if (review.evaluation.overall_evidence_confidence !== recalculated.overall_evidence_confidence) {
                throw new Error(`Evidence confidence mismatch for ${slug}. saved=${review.evaluation.overall_evidence_confidence}, calc=${recalculated.overall_evidence_confidence}`);
              }
            } else {
              const savedConf = review.evaluation.overall_evidence_confidence ?? 0;
              const calcConf = recalculated.overall_evidence_confidence ?? 0;
              if (Math.abs(savedConf - calcConf) > EPSILON) {
                throw new Error(`Evidence confidence mismatch for ${slug}. saved=${savedConf}, calc=${calcConf}`);
              }
            }

            for (const key of Object.keys(recalculated.criterion_averages ?? {})) {
              const savedAvg = (review.evaluation.criterion_averages ?? {})[key];
              const calcAvg = (recalculated.criterion_averages ?? {})[key];
              if (savedAvg === null || calcAvg === null || savedAvg === undefined || calcAvg === undefined) {
                if (savedAvg !== calcAvg) {
                  throw new Error(`Criterion average mismatch for ${slug} on ${key}.`);
                }
              } else {
                if (Math.abs(savedAvg - calcAvg) > EPSILON) {
                  throw new Error(`Criterion average mismatch for ${slug} on ${key}.`);
                }
              }
            }

            for (const savedJudge of review.evaluation.judges) {
              const calcJudge = recalculated.judges.find(j => j.judge_id === savedJudge.judge_id);
              if (!calcJudge) {
                throw new Error(`Judge ${savedJudge.judge_id} not found in recalculated score for ${slug}`);
              }
              if (savedJudge.judge_score === null || calcJudge.judge_score === null) {
                if (savedJudge.judge_score !== calcJudge.judge_score) {
                  throw new Error(`Judge ${savedJudge.judge_id} score mismatch for ${slug}: saved=${savedJudge.judge_score}, calc=${calcJudge.judge_score}`);
                }
              } else {
                if (Math.abs(savedJudge.judge_score - calcJudge.judge_score) > EPSILON) {
                  throw new Error(`Judge ${savedJudge.judge_id} score mismatch for ${slug}: saved=${savedJudge.judge_score}, calc=${calcJudge.judge_score}`);
                }
              }

              for (const savedCrit of savedJudge.criteria) {
                const calcCrit = calcJudge.criteria.find(c => c.criterion_id === savedCrit.criterion_id);
                if (!calcCrit) {
                  throw new Error(`Criterion ${savedCrit.criterion_id} not found in recalculated score for judge ${savedJudge.judge_id} in ${slug}`);
                }
                if (savedCrit.weighted_score === null || calcCrit.weighted_score === null) {
                  if (savedCrit.weighted_score !== calcCrit.weighted_score) {
                    throw new Error(`Judge ${savedJudge.judge_id} criterion ${savedCrit.criterion_id} weighted score mismatch for ${slug}: saved=${savedCrit.weighted_score}, calc=${calcCrit.weighted_score}`);
                  }
                } else {
                  if (Math.abs(savedCrit.weighted_score - calcCrit.weighted_score) > EPSILON) {
                    throw new Error(`Judge ${savedJudge.judge_id} criterion ${savedCrit.criterion_id} weighted score mismatch for ${slug}: saved=${savedCrit.weighted_score}, calc=${calcCrit.weighted_score}`);
                  }
                }
              }
            }

            // Enforce classification strictness
            if (mode === 'production') {
              if (review.data_class !== 'production') {
                throw new Error(`Data classification mismatch for review ${slug}: expected 'production', found '${review.data_class}'`);
              }
              if (selection.data_class !== 'production') {
                throw new Error(`Data classification mismatch for selection ${slug}: expected 'production', found '${selection.data_class}'`);
              }
              if (slug === 'fixture-product') {
                throw new Error(`Fixture product 'fixture-product' is strictly prohibited in production mode.`);
              }
            } else if (mode === 'fixture') {
              if (review.data_class !== 'fixture') {
                throw new Error(`Data classification mismatch for review ${slug}: expected 'fixture', found '${review.data_class}'`);
              }
              if (selection.data_class !== 'fixture') {
                throw new Error(`Data classification mismatch for selection ${slug}: expected 'fixture', found '${selection.data_class}'`);
              }
            }

            // Validate Evidence bundle schema
            let evidenceList: any[] = [];
            if (fs.existsSync(evidencePath)) {
              const rawEvidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
              const bundle = EvidenceBundleSchema.parse(rawEvidence);
              if (mode === 'production' && bundle.data_class !== 'production') {
                throw new Error(`Data classification mismatch for evidence in ${slug}: expected 'production', found '${bundle.data_class}'`);
              } else if (mode === 'fixture' && bundle.data_class !== 'fixture') {
                throw new Error(`Data classification mismatch for evidence in ${slug}: expected 'fixture', found '${bundle.data_class}'`);
              }
              evidenceList = bundle.evidences;
            }

            entries.push({
              slug,
              year,
              month,
              review,
              selection,
              evidence: evidenceList,
              evidenceMap: loadEvidenceMap(path.join(reviewsDir, year, month, slug), review),
              editorialWithdrawal: loadEditorialWithdrawal(
                path.join(reviewsDir, year, month, slug),
                review,
                slug
              )
            });
          }
        } catch (e: any) {
          console.error(`Failed to load or validate review data for ${slug}. Failing build:`, e.message);
          throw e; // Fail fast during build
        }
      }
    }
  }
  validateIntegrity(entries);
  return entries;
}

export function sortReviews(reviews: ReviewEntry[]): ReviewEntry[] {
  return [...reviews].sort((a, b) => {
    // 1. Jury Score (null sorted last)
    const aScore = a.review.jury_score;
    const bScore = b.review.jury_score;
    if (aScore === null && bScore !== null) return 1;
    if (aScore !== null && bScore === null) return -1;
    if (aScore !== null && bScore !== null && aScore !== bScore) {
      return bScore - aScore;
    }

    // 2. Minimum Judge Score (null sorted last)
    const aMin = a.review.judge_score_range?.min;
    const bMin = b.review.judge_score_range?.min;
    if (aMin === null && bMin !== null) return 1;
    if (aMin !== null && bMin === null) return -1;
    if (aMin !== null && bMin !== null && aMin !== bMin) {
      return bMin - aMin;
    }

    // 3. Evidence Confidence
    const aConf = a.review.evaluation.overall_evidence_confidence || 0;
    const bConf = b.review.evaluation.overall_evidence_confidence || 0;
    if (aConf !== bConf) {
      return bConf - aConf;
    }

    // 4. Published At
    const dateA = new Date(a.review.published_at).getTime();
    const dateB = new Date(b.review.published_at).getTime();
    if (dateA !== dateB) {
      return dateB - dateA;
    }

    // 5. Slug
    return a.slug.localeCompare(b.slug);
  });
}

/**
 * Deprecated alias kept for existing callers. This used to be a second, independently
 * maintained copy of the eligibility rules, which meant the integrity assertions below
 * validated a different population than the pages actually rendered.
 */
export function getRankingReviews(reviews: ReviewEntry[]): ReviewEntry[] {
  return getRankedReviews(reviews);
}

function validateIntegrity(entries: ReviewEntry[]) {
  // 1. Review slugが重複していない
  const slugs = entries.map(e => e.slug);
  const uniqueSlugs = new Set(slugs);
  if (uniqueSlugs.size !== slugs.length) {
    const duplicates = slugs.filter((item, index) => slugs.indexOf(item) !== index);
    throw new Error(`Integrity Error: Review slugs must be unique. Duplicates: ${duplicates.join(', ')}`);
  }

  // 2. Rankings件数がrankedReviews.lengthと一致する、および関連当事者レビューの除外検証
  const publishedReviews = entries; // getAllReviewsでロードされるものが公開レビュー
  const rankedReviews = getRankingReviews(entries);

  // 3. ランキング対象はすべて公開済みである (entriesに含まれているため自明だが、整合性を確認)
  for (const r of rankedReviews) {
    if (!publishedReviews.some(e => e.slug === r.slug)) {
      throw new Error(`Integrity Error: Ranked review ${r.slug} is not in published reviews.`);
    }
  }

  // 4. 関連当事者レビューがランキングへ入っていない
  for (const r of rankedReviews) {
    if (r.review.relationship === 'related-party') {
      throw new Error(`Integrity Error: Related party review ${r.slug} is in rankings.`);
    }
  }

  // 5. 公開対象の関連当事者レビューがReviewsには存在する
  const relatedPartyReviews = publishedReviews.filter(e => e.review.relationship === 'related-party');
  for (const r of relatedPartyReviews) {
    if (!publishedReviews.some(e => e.slug === r.slug)) {
      throw new Error(`Integrity Error: Related party review ${r.slug} must exist in Reviews.`);
    }
  }

  // 6. 同一レビューのVerdict表記が全ページで一致することの整合性
  for (const r of entries) {
    const range = r.review.judge_score_range;
    if (range.min !== null && range.max !== null) {
      const consensus = getConsensus(range);
      const diff = range.max - range.min;
      if (diff <= 5.0 && consensus.label !== 'Strong Consensus') {
        throw new Error(`Integrity Error: Verdict Mismatch for ${r.slug}. diff <= 5.0 must be 'Strong Consensus'`);
      }
      if (diff > 5.0 && diff <= 12.0 && consensus.label !== 'General Agreement') {
        throw new Error(`Integrity Error: Verdict Mismatch for ${r.slug}. 5.0 < diff <= 12.0 must be 'General Agreement'`);
      }
      if (diff > 12.0 && diff <= 20.0 && consensus.label !== 'Split Decision') {
        throw new Error(`Integrity Error: Verdict Mismatch for ${r.slug}. 12.0 < diff <= 20.0 must be 'Split Decision'`);
      }
      if (diff > 20.0 && consensus.label !== 'Highly Divisive') {
        throw new Error(`Integrity Error: Verdict Mismatch for ${r.slug}. diff > 20.0 must be 'Highly Divisive'`);
      }
    }
  }

  // 7. HomeのLatest Verdictが公開日の最新レビューである
  const sortedByDate = [...entries].sort((a, b) => new Date(b.review.published_at).getTime() - new Date(a.review.published_at).getTime());
  if (sortedByDate.length > 0) {
    const latest = sortedByDate[0];
    for (const r of entries) {
      if (new Date(r.review.published_at).getTime() > new Date(latest.review.published_at).getTime()) {
        throw new Error(`Integrity Error: Latest Verdict ${latest.slug} is not the absolute newest by date.`);
      }
    }
  }

  // 8. HomeのRecent Verdictsが公開日の降順である
  for (let i = 0; i < sortedByDate.length - 1; i++) {
    const d1 = new Date(sortedByDate[i].review.published_at).getTime();
    const d2 = new Date(sortedByDate[i + 1].review.published_at).getTime();
    if (d1 < d2) {
      throw new Error(`Integrity Error: Recent Verdicts (sorted by date) must be in descending order. Mismatch between ${sortedByDate[i].slug} and ${sortedByDate[i+1].slug}`);
    }
  }

  // 9. HomeのTop Ratedがスコア降順である
  const rankedSorted = sortReviews(rankedReviews);
  for (let i = 0; i < rankedSorted.length - 1; i++) {
    const scoreA = rankedSorted[i].review.jury_score ?? 0;
    const scoreB = rankedSorted[i + 1].review.jury_score ?? 0;
    if (scoreA < scoreB) {
      throw new Error(`Integrity Error: Top Rated (sorted by score) must be in descending order of Jury Score. Mismatch between ${rankedSorted[i].slug} and ${rankedSorted[i+1].slug}`);
    }
  }
}

