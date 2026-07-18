import * as fs from 'fs';
import * as path from 'path';
import crypto from 'crypto';
import type { Candidate } from '../../schemas/selection';
import type { Evidence } from '../../schemas/evidence';
import { resolveContentRoot, resolveDataMode } from '../content-root';

/**
 * The Open Source Eligibility Gate, shared by every selection path.
 *
 * The daily selector and the reader-request path MUST apply the exact same judgement: a
 * reader request never gets a looser (or stricter) gate than autonomous selection. The
 * logic lives here — extracted verbatim from the Selector — so there is exactly one
 * implementation to keep in sync with the selection policy.
 */

/** Minimum combined evidence content length before a candidate may be evaluated. */
export const MIN_EVIDENCE_CONTENT_LENGTH = 1500;

export const OSS_LICENSE_ALLOWLIST = [
  'mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'mpl-2.0',
  'gpl-2.0-only', 'gpl-2.0-or-later', 'gpl-3.0-only', 'gpl-3.0-or-later',
  'lgpl-2.1-only', 'lgpl-2.1-or-later', 'lgpl-3.0-only', 'lgpl-3.0-or-later',
  'agpl-3.0-only', 'agpl-3.0-or-later', 'unlicense'
];

/**
 * Broad source focus used during candidate discovery: the canonical URL must point at a
 * supported public repository/source host.
 */
export function isSupportedSourceUrl(url: string): boolean {
  const urlStr = (url || '').toLowerCase();
  return urlStr.includes('github.com') || urlStr.includes('github.io') || urlStr.includes('huggingface.co');
}

/**
 * Strict public-source check used by the eligibility gate itself (github.io pages are a
 * discovery convenience, not an evaluable public repository).
 */
export function isEligibleGateSource(url: string): boolean {
  const urlStr = (url || '').toLowerCase();
  return urlStr.includes('github.com') || urlStr.includes('huggingface.co');
}

export function checkEligibilityGate(candidate: Candidate, evidences: Evidence[]): string[] {
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
  if (!isEligibleGateSource(urlStr)) {
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

export function saveEligibilityRejection(candidate: Candidate, reasons: string[]): void {
  try {
    // Fixture inputs are immutable test assets; rejection logs are a
    // production pipeline artifact and must not rewrite checked_at values.
    if (resolveDataMode() === 'fixture') return;
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

export interface PublishedReviewMatch {
  slug: string;
  year: string;
  month: string;
  published_at: string;
}

/**
 * Finds an already-published review for a canonical URL (any age — a live article with the
 * same canonical URL is a duplicate regardless of the 90-day re-selection window, because
 * two reviews can never share a canonical URL in the same build).
 */
export function findPublishedReviewByCanonicalUrl(contentRoot: string, canonicalUrl: string): PublishedReviewMatch | null {
  const reviewsDir = path.join(contentRoot, 'reviews');
  if (!fs.existsSync(reviewsDir)) return null;
  const normalized = (canonicalUrl || '').replace(/\/$/, '').toLowerCase();

  for (const year of fs.readdirSync(reviewsDir)) {
    const yearDir = path.join(reviewsDir, year);
    if (!fs.statSync(yearDir).isDirectory()) continue;
    for (const month of fs.readdirSync(yearDir)) {
      const monthDir = path.join(yearDir, month);
      if (!fs.statSync(monthDir).isDirectory()) continue;
      for (const slug of fs.readdirSync(monthDir)) {
        const productDir = path.join(monthDir, slug);
        if (!fs.statSync(productDir).isDirectory()) continue;
        const selectionPath = path.join(productDir, 'selection.json');
        const reviewPath = path.join(productDir, 'review.json');
        if (!fs.existsSync(selectionPath) || !fs.existsSync(reviewPath)) continue;
        try {
          const selection = JSON.parse(fs.readFileSync(selectionPath, 'utf8'));
          if ((selection.canonical_url || '').replace(/\/$/, '').toLowerCase() === normalized) {
            const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
            return { slug, year, month, published_at: review.published_at };
          }
        } catch (e) {
          // Ignore invalid JSONs, matching the selector's tolerance.
        }
      }
    }
  }
  return null;
}
