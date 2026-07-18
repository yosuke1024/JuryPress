import type { Candidate, Selection } from '../../schemas/selection';
import { getSourceAdapter } from '../sources';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';
import { resolveDataMode, resolveContentRoot } from '../content-root';
import { TimezoneUtil } from '../timezone';
import { EvidenceCollector } from '../evidence/collector';
import type { Evidence, EvidenceCollectionResult } from '../../schemas/evidence';
import {
  MIN_EVIDENCE_CONTENT_LENGTH,
  checkEligibilityGate,
  isSupportedSourceUrl,
  saveEligibilityRejection
} from './eligibility';

interface Config {
  timezone: string;
  schedule: Record<string, { primary: string, fallback: string[] }>;
}

export interface SelectionResult {
  selection: Selection;
  candidate: Candidate;
  evidences: Evidence[];
  collection_result: EvidenceCollectionResult;
}

export interface SelectionExclusions {
  /** Normalized (lowercase, no trailing slash) canonical URLs that may not be selected. */
  canonicalUrls?: Set<string>;
  /** Source content ids (e.g. GitHub full names) that may not be selected. */
  contentIds?: Set<string>;
}

export class Selector {
  private config: Config;
  private reviewsDir = path.join(process.cwd(), 'data', 'reviews');
  private season: number;

  constructor() {
    const configPath = path.join(process.cwd(), 'config', 'sources.yml');
    this.config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
    const seasonConfigPath = path.join(process.cwd(), 'config', 'season.json');
    const seasonConfig = JSON.parse(fs.readFileSync(seasonConfigPath, 'utf8'));
    this.season = seasonConfig.season;
  }

  private getPublishedUrlsPast90Days(date: Date): Set<string> {
    const urls = new Set<string>();
    const contentRoot = resolveContentRoot();
    const reviewsDir = path.join(contentRoot, 'reviews');
    if (!fs.existsSync(reviewsDir)) return urls;

    const threshold = new Date(date);
    threshold.setDate(threshold.getDate() - 90);

    const years = fs.readdirSync(reviewsDir);
    for (const year of years) {
      if (!fs.statSync(path.join(reviewsDir, year)).isDirectory()) continue;
      const months = fs.readdirSync(path.join(reviewsDir, year));
      for (const month of months) {
        if (!fs.statSync(path.join(reviewsDir, year, month)).isDirectory()) continue;
        const products = fs.readdirSync(path.join(reviewsDir, year, month));
        for (const product of products) {
          if (!fs.statSync(path.join(reviewsDir, year, month, product)).isDirectory()) continue;
          const selectionPath = path.join(reviewsDir, year, month, product, 'selection.json');
          if (fs.existsSync(selectionPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
              if (data.canonical_url) {
                const reviewPath = path.join(reviewsDir, year, month, product, 'review.json');
                if (fs.existsSync(reviewPath)) {
                  const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
                  if (new Date(review.published_at) >= threshold) {
                    urls.add(data.canonical_url);
                  }
                }
              }
            } catch (e) {
              // Ignore invalid JSONs
            }
          }
        }
      }
    }
    return urls;
  }

  private isEligible(candidate: Candidate, publishedUrls: Set<string>, exclusions?: SelectionExclusions): boolean {
    if (!candidate.name || !candidate.canonicalUrl) return false;

    // Normalize URL
    const normalizedUrl = candidate.canonicalUrl.replace(/\/$/, '').toLowerCase();

    for (const published of publishedUrls) {
      if (published.replace(/\/$/, '').toLowerCase() === normalizedUrl) {
        return false; // Already published in last 90 days
      }
    }

    // Reservation-aware duplicate prevention: candidates held by any active run or
    // publication state (reserved → published) may not be selected again.
    if (exclusions?.canonicalUrls?.has(normalizedUrl)) return false;
    if (candidate.sourceId && exclusions?.contentIds?.has(candidate.sourceId)) return false;

    if (!isSupportedSourceUrl(candidate.canonicalUrl)) {
      return false; // Force repository/source focus
    }

    return true;
  }

  // Eligibility judgement is shared with the reader-request path; see ./eligibility.
  private checkEligibilityGate(candidate: Candidate, evidences: Evidence[]): string[] {
    return checkEligibilityGate(candidate, evidences);
  }

  private saveRejection(candidate: Candidate, reasons: string[]) {
    saveEligibilityRejection(candidate, reasons);
  }

  public async selectForDate(date: Date, exclusions?: SelectionExclusions): Promise<SelectionResult> {
    const dayName = TimezoneUtil.getDayOfWeek(date);

    const schedule = this.config.schedule[dayName];
    if (!schedule) throw new Error(`No schedule found for day: ${dayName}`);

    const sourcesToTry = [schedule.primary, ...(schedule.fallback || [])];
    const publishedUrls = this.getPublishedUrlsPast90Days(date);

    for (const sourceId of sourcesToTry) {
      try {
        const adapter = getSourceAdapter(sourceId);
        const candidates = await adapter.fetchCandidates(date);

        const eligible = candidates.filter(c => this.isEligible(c, publishedUrls, exclusions));

        if (eligible.length > 0) {
          eligible.sort((a, b) => {
            if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
            if (a.popularityValue !== b.popularityValue) return b.popularityValue - a.popularityValue;
            return a.canonicalUrl.localeCompare(b.canonicalUrl);
          });
          
          let winner: Candidate | undefined;
          let winnerEvidences: Evidence[] = [];
          let winnerCollectionResult: EvidenceCollectionResult | undefined;

          for (const candidate of eligible) {
            try {
              console.log(`Checking evidence sufficiency for candidate: ${candidate.name} (${candidate.canonicalUrl})`);
              const collector = new EvidenceCollector();
              const collectionResult = await collector.collectWithContext(candidate);
              const evidences = collectionResult.evidences;
              
              const totalLen = evidences.reduce((sum, e) => sum + e.summary.length, 0);
              if (totalLen < MIN_EVIDENCE_CONTENT_LENGTH) {
                console.warn(`Skipping ${candidate.name}: insufficient evidence content (${totalLen} chars, min ${MIN_EVIDENCE_CONTENT_LENGTH} required).`);
                this.saveRejection(candidate, ['insufficient_evidence']);
                continue;
              }

              const reasons = this.checkEligibilityGate(candidate, evidences);
              if (reasons.length > 0) {
                console.warn(`Skipping ${candidate.name}: failed eligibility gate (${reasons.join(', ')}).`);
                this.saveRejection(candidate, reasons);
                continue;
              }
              
              winner = candidate;
              winnerEvidences = evidences;
              winnerCollectionResult = collectionResult;
              break;
            } catch (e: any) {
              console.warn(`Skipping ${candidate.name}: failed to collect evidence (${e.message})`);
              this.saveRejection(candidate, ['insufficient_evidence']);
            }
          }

          if (winner && winnerCollectionResult) {
            // Extract actual metrics from api_metadata evidence
            const apiEv = winnerEvidences.find(e => e.type === 'api_metadata');
            let actualStars: number | null = null;
            let actualForks: number | null = null;
            let actualLicense: string = 'unknown';
            
            if (apiEv) {
              try {
                const meta = JSON.parse(apiEv.summary);
                if (meta.stargazers_count !== undefined) {
                  actualStars = meta.stargazers_count;
                } else if (meta.likes !== undefined) {
                  actualStars = meta.likes; // For Hugging Face Spaces
                }
                if (meta.forks_count !== undefined) {
                  actualForks = meta.forks_count;
                }
                if (meta.license_spdx) {
                  actualLicense = meta.license_spdx;
                }
              } catch (e) {}
            }

            const platformName = (winner.source || sourceId || 'github').toLowerCase();
            const resolvedPlatform = platformName.includes('hugging') 
              ? 'hugging-face' 
              : (platformName.includes('hacker') ? 'hacker-news' : 'github');
            
            const resolvedMetric = winner.popularityUnit === 'likes' 
              ? 'likes' 
              : (winner.popularityUnit === 'points' ? 'points' : 'stars');

            const metricsList = [
              {
                platform: resolvedPlatform as any,
                metric: resolvedMetric as any,
                value: winner.popularityValue,
                source_url: winner.sourceUrl,
                retrieved_at: winner.collectedAt || new Date().toISOString()
              }
            ];

            // If selected from HN, also add GitHub stats if resolved
            if (resolvedPlatform === 'hacker-news' && actualStars !== null) {
              metricsList.push({
                platform: 'github' as any,
                metric: 'stars' as any,
                value: actualStars,
                source_url: winner.canonicalUrl,
                retrieved_at: new Date().toISOString()
              });
            }

            return {
              selection: {
                schema_version: "1.0.0",
                data_class: resolveDataMode(),
                run_key: TimezoneUtil.getRunKey(this.season, date),
                source: sourceId,
                source_rank: winner.sourceRank,
                popularity_value: winner.popularityValue,
                popularity_unit: winner.popularityUnit,
                selection_rule: "Highest-ranked eligible unpublished item with sufficient evidence",
                selected_at: new Date().toISOString(),
                canonical_url: winner.canonicalUrl,
                source_url: winner.sourceUrl,
                algorithm_version: "2.0.0",
                human_selected: false,
                candidate_name: winner.name,
                source_id: winner.sourceId,
                candidate_metadata: {
                  ...winner.metadata,
                  ...(actualStars !== null ? { stars: actualStars } : {}),
                  ...(actualForks !== null ? { forks: actualForks } : {}),
                  license: actualLicense
                },
                selection_mode: "automated-daily",
                selected_by: "system",
                source_metrics: metricsList
              },
              candidate: winner,
              evidences: winnerEvidences,
              collection_result: winnerCollectionResult
            };
          }
        }
      } catch (e: any) {
        console.warn(`Failed to fetch from ${sourceId}, trying fallback...`, e.message);
      }
    }

    throw new Error('No eligible candidates found in any configured source');
  }
}
