import type { Candidate, Selection } from '../../schemas/selection';
import { getSourceAdapter } from '../sources';
import * as fs from 'fs';
import * as path from 'path';
import yaml from 'yaml';
import crypto from 'crypto';
import { resolveDataMode, resolveContentRoot } from '../content-root';
import { TimezoneUtil } from '../timezone';
import { EvidenceCollector } from '../evidence/collector';
import type { Evidence } from '../../schemas/evidence';

interface Config {
  timezone: string;
  schedule: Record<string, { primary: string, fallback: string[] }>;
}

export interface SelectionResult {
  selection: Selection;
  candidate: Candidate;
  evidences: Evidence[];
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

  private isEligible(candidate: Candidate, publishedUrls: Set<string>): boolean {
    if (!candidate.name || !candidate.canonicalUrl) return false;
    
    // Normalize URL
    const normalizedUrl = candidate.canonicalUrl.replace(/\/$/, '').toLowerCase();
    
    for (const published of publishedUrls) {
      if (published.replace(/\/$/, '').toLowerCase() === normalizedUrl) {
        return false; // Already published in last 90 days
      }
    }

    const urlStr = candidate.canonicalUrl.toLowerCase();
    const isGithubOrHf = urlStr.includes('github.com') || urlStr.includes('github.io') || urlStr.includes('huggingface.co');
    if (!isGithubOrHf) {
      return false; // Force repository/source focus
    }

    return true;
  }

  private checkEligibilityGate(candidate: Candidate, evidences: Evidence[]): string[] {
    const reasons: string[] = [];
    
    // 1. Evidence Readiness Check
    const hasMetadata = evidences.some(e => e.type === 'api_metadata');
    const hasReadme = evidences.some(e => e.type === 'readme' || e.type === 'official_site');
    const apiEvidence = evidences.find(e => e.type === 'api_metadata');
    const readmeEvidence = evidences.find(e => e.type === 'readme');
    
    let githubMeta: any = null;
    if (apiEvidence && apiEvidence.url.includes('api.github.com')) {
      try {
        githubMeta = JSON.parse(apiEvidence.summary);
      } catch (e) {}
    }

    let hasLicense = false;
    if (githubMeta) {
      if (githubMeta.license) {
        hasLicense = true;
      } else if (githubMeta.license_spdx && githubMeta.license_spdx !== 'unknown') {
        hasLicense = true;
      }
    } else if (readmeEvidence) {
      const readmeLower = readmeEvidence.summary.toLowerCase();
      if (readmeLower.includes('license') || readmeLower.includes('licence')) {
        hasLicense = true;
      }
    }

    if (!hasMetadata || !hasReadme || !hasLicense) {
      reasons.push('insufficient_evidence');
    }

    // 2. Public Source Check
    const urlStr = candidate.canonicalUrl.toLowerCase();
    if (!urlStr.includes('github.com') && !urlStr.includes('huggingface.co')) {
      reasons.push('no_public_repository');
    }

    if (githubMeta) {
      // Empty repository check
      if (githubMeta.size === 0 || (githubMeta.language === null && githubMeta.size < 10)) {
        reasons.push('not_software_product');
      }
      
      // Exclusions: Archived
      if (githubMeta.archived) {
        reasons.push('archived_repository');
      }

      // Exclusions: Unmodified Fork / Mirror
      if (githubMeta.fork) {
        reasons.push('mirror_or_unmodified_fork');
      }
    }

    // 3. Open Source License SPDX check
    const OSS_LICENSE_ALLOWLIST = [
      'mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'mpl-2.0',
      'gpl-2.0-only', 'gpl-2.0-or-later', 'gpl-3.0-only', 'gpl-3.0-or-later',
      'lgpl-2.1-only', 'lgpl-2.1-or-later', 'lgpl-3.0-only', 'lgpl-3.0-or-later',
      'agpl-3.0-only', 'agpl-3.0-or-later', 'unlicense'
    ];

    if (githubMeta) {
      const licenseObj = githubMeta.license;
      const licenseSpdx = githubMeta.license_spdx;

      if (!licenseObj && !licenseSpdx) {
        reasons.push('missing_oss_license');
      } else if (licenseSpdx && licenseSpdx.toLowerCase() === 'unknown') {
        reasons.push('missing_oss_license');
      } else {
        const licenseKey = licenseObj ? (licenseObj.key || '').toLowerCase() : '';
        const licenseSpdxId = licenseObj ? (licenseObj.spdx_id || '').toLowerCase() : (licenseSpdx || '').toLowerCase();
        const matched = OSS_LICENSE_ALLOWLIST.includes(licenseKey) || OSS_LICENSE_ALLOWLIST.includes(licenseSpdxId);
        if (!matched) {
          reasons.push('unsupported_license');
        }
      }
    }

    // 4. Clear Purpose Check
    let purposeOk = false;
    if (githubMeta && githubMeta.description) {
      purposeOk = true;
    }
    if (readmeEvidence) {
      const readmeLower = readmeEvidence.summary.toLowerCase();
      const purposeKeywords = ['usage', 'install', 'why', 'how', 'purpose', 'features', 'description', '使い方', '概要', '目的'];
      if (purposeKeywords.some(kw => readmeLower.includes(kw)) && readmeEvidence.summary.length > 100) {
        purposeOk = true;
      }
    }
    if (!purposeOk) {
      reasons.push('missing_clear_purpose');
    }

    // 5. Runnable / Reproducible Check
    let runnableOk = false;
    if (githubMeta && (githubMeta.homepage || githubMeta.has_downloads)) {
      runnableOk = true;
    }
    if (readmeEvidence) {
      const readmeLower = readmeEvidence.summary.toLowerCase();
      const runnableKeywords = ['install', 'setup', 'run', 'docker', 'npm', 'pip', 'cargo', 'go get', 'build', 'reproduce', 'demo', 'http://', 'https://'];
      if (runnableKeywords.some(kw => readmeLower.includes(kw))) {
        runnableOk = true;
      }
    }
    if (!runnableOk) {
      reasons.push('not_runnable');
    }

    // 6. Freshness Check
    if (githubMeta) {
      const pushedDate = new Date(githubMeta.pushed_at);
      const limitDate = new Date();
      limitDate.setMonth(limitDate.getMonth() - 18);
      if (pushedDate < limitDate) {
        reasons.push('stale_project');
      }
    }

    // 7. Exclusions keywords check
    const nameLower = candidate.name.toLowerCase();
    const exclusions = [
      'awesome-list', 'awesome list', 'dataset-only', 'tutorial-copy', 'course-assignment',
      'hiring', 'careers', 'job post', 'job opening',
      'tutorial', 'course', 'book', 'guide', 'learn'
    ];
    if (exclusions.some(exc => nameLower.includes(exc))) {
      reasons.push('not_software_product');
    }

    const isNewsOrBlog = /\bblog\b/.test(nameLower) || /\bnews\b/.test(nameLower) || /\barticle\b/.test(nameLower) || urlStr.includes('nytimes.com') || urlStr.includes('medium.com') || urlStr.endsWith('.pdf');
    if (isNewsOrBlog) {
      reasons.push('not_software_product');
    }

    return Array.from(new Set(reasons));
  }

  private saveRejection(candidate: Candidate, reasons: string[]) {
    try {
      const contentRoot = resolveContentRoot();
      const rejectionsDir = path.join(contentRoot, 'rejections');
      if (!fs.existsSync(rejectionsDir)) {
        fs.mkdirSync(rejectionsDir, { recursive: true });
      }

      const cleanName = candidate.name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
      const hash = crypto.createHash('md5').update(candidate.sourceId || '').digest('hex').substring(0, 6);
      const fileSlug = `${cleanName}-${hash}`;
      const logPath = path.join(rejectionsDir, `${fileSlug}.json`);

      const payload = {
        candidate_url: candidate.canonicalUrl,
        eligibility: "rejected",
        reason_codes: reasons,
        checked_at: new Date().toISOString(),
        selection_policy_version: "2.0.0"
      };

      fs.writeFileSync(logPath, JSON.stringify(payload, null, 2));
      console.log(`Saved eligibility rejection for candidate ${candidate.name} to ${logPath}`);
    } catch (e: any) {
      console.warn(`Failed to save rejection log: ${e.message}`);
    }
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
          eligible.sort((a, b) => {
            if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
            if (a.popularityValue !== b.popularityValue) return b.popularityValue - a.popularityValue;
            return a.canonicalUrl.localeCompare(b.canonicalUrl);
          });
          
          let winner: Candidate | undefined;
          let winnerEvidences: Evidence[] = [];

          for (const candidate of eligible) {
            try {
              console.log(`Checking evidence sufficiency for candidate: ${candidate.name} (${candidate.canonicalUrl})`);
              const collector = new EvidenceCollector();
              const evidences = await collector.collect(candidate);
              
              const totalLen = evidences.reduce((sum, e) => sum + e.summary.length, 0);
              if (totalLen < 1500) {
                console.warn(`Skipping ${candidate.name}: insufficient evidence content (${totalLen} chars, min 1500 required).`);
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
              break;
            } catch (e: any) {
              console.warn(`Skipping ${candidate.name}: failed to collect evidence (${e.message})`);
              this.saveRejection(candidate, ['insufficient_evidence']);
            }
          }

          if (winner) {
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
              evidences: winnerEvidences
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

