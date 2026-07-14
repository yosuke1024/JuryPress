import * as fs from 'fs';
import * as path from 'path';
import { ReviewSchema } from '../schemas/review';
import { SelectionSchema } from '../schemas/selection';
import { EvidenceBundleSchema } from '../schemas/evidence';
import { z } from 'zod';
import { Evaluator } from './evaluation/evaluator';
import { resolveContentRoot, resolveDataMode } from './content-root';

export interface ReviewEntry {
  slug: string;
  year: string;
  month: string;
  review: z.infer<typeof ReviewSchema>;
  selection: z.infer<typeof SelectionSchema>;
  evidence: any[];
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
            const recalculated = evaluator.recalculateScores(review.evaluation);
            const EPSILON = 0.0001;
            if (Math.abs(review.jury_score - recalculated.recalculated_jury_score) > EPSILON) {
              throw new Error(`Jury score mismatch for ${slug}: saved=${review.jury_score}, calc=${recalculated.recalculated_jury_score}`);
            }
            if (Math.abs(review.evaluation.recalculated_jury_score - recalculated.recalculated_jury_score) > EPSILON) {
              throw new Error(`Evaluation recalculated jury score mismatch for ${slug}.`);
            }
            if (Math.abs(review.judge_score_range.min - recalculated.judge_score_range.min) > EPSILON || Math.abs(review.judge_score_range.max - recalculated.judge_score_range.max) > EPSILON) {
              throw new Error(`Judge score range mismatch for ${slug}.`);
            }
            if (Math.abs((review.evaluation.overall_evidence_confidence || 0) - (recalculated.overall_evidence_confidence || 0)) > EPSILON) {
              throw new Error(`Evidence confidence mismatch for ${slug}. saved=${review.evaluation.overall_evidence_confidence}, calc=${recalculated.overall_evidence_confidence}`);
            }
            for (const key of Object.keys(recalculated.criterion_averages ?? {})) {
              if (Math.abs(((review.evaluation.criterion_averages ?? {})[key] || 0) - (recalculated.criterion_averages ?? {})[key]) > EPSILON) {
                throw new Error(`Criterion average mismatch for ${slug} on ${key}.`);
              }
            }
            for (const savedJudge of review.evaluation.judges) {
              const calcJudge = recalculated.judges.find(j => j.judge_id === savedJudge.judge_id);
              if (!calcJudge || Math.abs(savedJudge.judge_score - calcJudge.judge_score) > EPSILON) {
                throw new Error(`Judge ${savedJudge.judge_id} score mismatch for ${slug}: saved=${savedJudge.judge_score}, calc=${calcJudge?.judge_score}`);
              }
              for (const savedCrit of savedJudge.criteria) {
                const calcCrit = calcJudge?.criteria.find(c => c.criterion_id === savedCrit.criterion_id);
                if (!calcCrit || Math.abs(savedCrit.weighted_score - calcCrit.weighted_score) > EPSILON) {
                  throw new Error(`Judge ${savedJudge.judge_id} criterion ${savedCrit.criterion_id} weighted score mismatch for ${slug}: saved=${savedCrit.weighted_score}, calc=${calcCrit?.weighted_score}`);
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
              evidence: evidenceList
            });
          }
        } catch (e: any) {
          console.error(`Failed to load or validate review data for ${slug}. Failing build:`, e.message);
          throw e; // Fail fast during build
        }
      }
    }
  }
  return entries;
}

export function sortReviews(reviews: ReviewEntry[]): ReviewEntry[] {
  return [...reviews].sort((a, b) => {
    // 1. Jury Score
    if (a.review.jury_score !== b.review.jury_score) {
      return b.review.jury_score - a.review.jury_score;
    }
    // 2. Minimum Judge Score
    const aMin = a.review.judge_score_range?.min || 0;
    const bMin = b.review.judge_score_range?.min || 0;
    if (aMin !== bMin) {
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

