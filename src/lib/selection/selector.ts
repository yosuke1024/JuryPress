import type { Candidate, Selection } from '../../schemas/selection';
import { getSourceAdapter } from '../sources';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';
import { TimezoneUtil } from '../timezone';

interface Config {
  timezone: string;
  schedule: Record<string, { primary: string, fallback: string[] }>;
}

export interface SelectionResult {
  selection: Selection;
  candidate: Candidate;
}

export class Selector {
  private config: Config;
  private reviewsDir = path.join(process.cwd(), 'data', 'reviews');

  constructor() {
    const configPath = path.join(process.cwd(), 'config', 'sources.yml');
    this.config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
  }

  private getPublishedUrlsPast90Days(date: Date): Set<string> {
    const urls = new Set<string>();
    if (!fs.existsSync(this.reviewsDir)) return urls;

    const threshold = new Date(date);
    threshold.setDate(threshold.getDate() - 90);

    const years = fs.readdirSync(this.reviewsDir);
    for (const year of years) {
      if (!fs.statSync(path.join(this.reviewsDir, year)).isDirectory()) continue;
      const months = fs.readdirSync(path.join(this.reviewsDir, year));
      for (const month of months) {
        if (!fs.statSync(path.join(this.reviewsDir, year, month)).isDirectory()) continue;
        const products = fs.readdirSync(path.join(this.reviewsDir, year, month));
        for (const product of products) {
          if (!fs.statSync(path.join(this.reviewsDir, year, month, product)).isDirectory()) continue;
          const selectionPath = path.join(this.reviewsDir, year, month, product, 'selection.json');
          if (fs.existsSync(selectionPath)) {
            try {
              const data = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
              if (data.canonical_url) {
                // If it has a published review
                const reviewPath = path.join(this.reviewsDir, year, month, product, 'review.json');
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

  private isEligible(candidate: Candidate, publishedUrls: Set<string>): boolean {
    if (!candidate.name || !candidate.canonicalUrl) return false;
    
    // Normalize URL
    const normalizedUrl = candidate.canonicalUrl.replace(/\/$/, '').toLowerCase();
    
    for (const published of publishedUrls) {
      if (published.replace(/\/$/, '').toLowerCase() === normalizedUrl) {
        return false; // Already published in last 90 days
      }
    }

    const titleStr = candidate.name.toLowerCase();
    const metaStr = JSON.stringify(candidate.metadata).toLowerCase();
    const urlStr = candidate.canonicalUrl.toLowerCase();

    // Reject common non-product items
    const exclusions = [
      'news', 'blog', 'article', 'job', 'hiring', 'interview',
      'podcast', 'newsletter', 'opinion', 'tutorial', 'course',
      'book', 'pdf', 'slides'
    ];
    
    // Simple heuristic checks
    if (urlStr.includes('nytimes.com') || urlStr.includes('wsj.com') || urlStr.includes('bloomberg.com')) return false;
    if (urlStr.includes('youtube.com') || urlStr.includes('vimeo.com')) return false;
    if (urlStr.includes('medium.com') || urlStr.includes('substack.com')) return false;
    
    // Try to exclude jobs based on HN title tags (e.g. "X is hiring")
    if (titleStr.includes(' is hiring') || titleStr.includes('hiring:')) return false;
    
    // Try to exclude Show HN items that are just books or courses if evident in title
    if (titleStr.includes('show hn: i wrote a book') || titleStr.includes('show hn: a course')) return false;

    // Generally require it to look like a software product, tool, library, or space
    return true;
  }

  public async selectForDate(date: Date): Promise<SelectionResult> {
    const dayName = TimezoneUtil.getDayOfWeek(date);

    const schedule = this.config.schedule[dayName];
    if (!schedule) throw new Error(`No schedule found for day: ${dayName}`);

    const sourcesToTry = [schedule.primary, ...(schedule.fallback || [])];
    const publishedUrls = this.getPublishedUrlsPast90Days(date);

    for (const sourceId of sourcesToTry) {
      try {
        const adapter = getSourceAdapter(sourceId);
        const candidates = await adapter.fetchCandidates(date);

        const eligible = candidates.filter(c => this.isEligible(c, publishedUrls));

        if (eligible.length > 0) {
          // Deterministic Sort:
          // 1. sourceRank asc
          // 2. popularityValue desc
          // 3. canonicalUrl asc
          eligible.sort((a, b) => {
            if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
            if (a.popularityValue !== b.popularityValue) return b.popularityValue - a.popularityValue;
            return a.canonicalUrl.localeCompare(b.canonicalUrl);
          });

          const winner = eligible[0];

          return {
            selection: {
              schema_version: "1.0.0",
              run_key: TimezoneUtil.getRunKey(1, date),
              source: sourceId,
              source_rank: winner.sourceRank,
              popularity_value: winner.popularityValue,
              popularity_unit: winner.popularityUnit,
              selection_rule: "Highest-ranked eligible unpublished item",
              selected_at: new Date().toISOString(),
              canonical_url: winner.canonicalUrl,
              source_url: winner.sourceUrl,
              algorithm_version: "1.0.0",
              human_selected: false,
              candidate_name: winner.name,
              source_id: winner.sourceId,
              candidate_metadata: winner.metadata
            },
            candidate: winner
          };
        }
      } catch (e: any) {
        console.warn(`Failed to fetch from ${sourceId}, trying fallback...`, e.message);
      }
    }

    throw new Error('No eligible candidates found in any configured source');
  }
}
