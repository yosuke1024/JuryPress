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

/**
 * Upper bound on GitHub stars, above which a project is out of scope.
 *
 * JuryPress exists to evaluate projects that have not already been evaluated by everyone.
 * Above this line a project is a household name in its field, the reader learns nothing from
 * a score, and — the practical half of the argument — the evidence collector performs worst
 * on exactly these repositories: it samples a handful of files from a monorepo it cannot
 * cover, and the evaluation ends up resting on whatever it happened to reach. The React
 * review withdrawn on 2026-07-27 scored every criterion off a single .eslintrc.js.
 *
 * Stars are a coarse proxy and the honest limitation is that they are not comparable across
 * ecosystems: a widely-used Rust CLI and a JavaScript UI library sit orders of magnitude
 * apart at the same level of fame. The ceiling is deliberately set high enough that only the
 * unambiguous cases fall on the far side of it.
 */
export const MAX_POPULARITY_STARS = 100_000;

/**
 * SPDX identifiers accepted as open source.
 *
 * Both the disjunctive (`gpl-3.0`) and the explicit (`gpl-3.0-only`, `gpl-3.0-or-later`)
 * forms are listed, because the GitHub licenses API returns only the disjunctive one:
 * `license.key` is `agpl-3.0` and `license.spdx_id` is `AGPL-3.0` for every AGPL repository.
 * Listing only the `-only`/`-or-later` variants rejected the entire GPL family — see the
 * `unsupported_license` rejection recorded for juggler-ai/juggler (AGPL-3.0, JavaScript).
 */
export const OSS_LICENSE_ALLOWLIST = [
  'mit', 'apache-2.0', 'bsd-2-clause', 'bsd-3-clause', 'isc', 'mpl-2.0',
  'gpl-2.0', 'gpl-2.0-only', 'gpl-2.0-or-later',
  'gpl-3.0', 'gpl-3.0-only', 'gpl-3.0-or-later',
  'lgpl-2.1', 'lgpl-2.1-only', 'lgpl-2.1-or-later',
  'lgpl-3.0', 'lgpl-3.0-only', 'lgpl-3.0-or-later',
  'agpl-3.0', 'agpl-3.0-only', 'agpl-3.0-or-later',
  'unlicense'
];

/**
 * Host-anchored URL check: the hostname itself must be the given host or one of its
 * subdomains. A substring match would accept `https://evil.example/github.com`, so the
 * URL is parsed and only the hostname is compared.
 */
function urlHostMatches(url: string, host: string): boolean {
  try {
    const hostname = new URL(url).hostname.toLowerCase();
    return hostname === host || hostname.endsWith(`.${host}`);
  } catch {
    return false;
  }
}

/**
 * Broad source focus used during candidate discovery: the canonical URL must point at a
 * supported public repository/source host.
 */
export function isSupportedSourceUrl(url: string): boolean {
  return ['github.com', 'github.io', 'huggingface.co'].some(host => urlHostMatches(url, host));
}

/**
 * Strict public-source check used by the eligibility gate itself (github.io pages are a
 * discovery convenience, not an evaluable public repository).
 */
export function isEligibleGateSource(url: string): boolean {
  return ['github.com', 'huggingface.co'].some(host => urlHostMatches(url, host));
}

export function checkEligibilityGate(candidate: Candidate, evidences: Evidence[]): string[] {
  const reasons: string[] = [];

  // 1. Evidence Readiness Check
  const hasMetadata = evidences.some(e => e.type === 'api_metadata');
  const hasReadme = evidences.some(e => e.type === 'readme' || e.type === 'official_site');
  const apiEvidence = evidences.find(e => e.type === 'api_metadata');
  const readmeEvidence = evidences.find(e => e.type === 'readme');

  // Evidence that claims to be GitHub metadata but does not parse is worse than absent
  // evidence: `hasMetadata` above is a type check and still reports true, so without this
  // flag an unreadable snapshot would silently disable every `if (githubMeta)` check below
  // — archived, fork, licence, freshness and the popularity ceiling — and the candidate
  // would pass for lack of anything to fail against. Fail closed instead.
  let githubMeta: any = null;
  let githubMetaUnreadable = false;
  if (apiEvidence && urlHostMatches(apiEvidence.url, 'api.github.com')) {
    try {
      githubMeta = JSON.parse(apiEvidence.summary);
    } catch (e) {
      githubMetaUnreadable = true;
    }
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

  if (!hasMetadata || !hasReadme || !hasLicense || githubMetaUnreadable) {
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

  const isNewsOrBlog = /\bblog\b/.test(nameLower) || /\bnews\b/.test(nameLower) || /\barticle\b/.test(nameLower) || urlHostMatches(candidate.canonicalUrl, 'nytimes.com') || urlHostMatches(candidate.canonicalUrl, 'medium.com') || urlStr.endsWith('.pdf');
  if (isNewsOrBlog) {
    reasons.push('not_software_product');
  }

  // 8. Popularity ceiling. Applied here rather than in a source query so that every path
  // gets it: a reader request for a household-name project is refused on the same ground
  // as an autonomous selection, and the refusal is logged with a reason either way.
  const stars = resolveStarCount(candidate, githubMeta);
  if (stars !== null && stars > MAX_POPULARITY_STARS) {
    reasons.push('above_popularity_ceiling');
  }

  return Array.from(new Set(reasons));
}

/**
 * Star count for the ceiling check, or null when the candidate has no star metric at all.
 *
 * The API snapshot wins over the candidate's own figure: the candidate carries whatever the
 * source listing reported, which for a cross-source candidate is a blended score and for any
 * source is older than the metadata fetched during collection. A non-star popularity unit
 * (Hacker News points, Hugging Face likes) yields null — those scales have nothing to do
 * with this threshold and must not be compared against it.
 */
function resolveStarCount(candidate: Candidate, githubMeta: any): number | null {
  if (githubMeta && typeof githubMeta.stargazers_count === 'number') {
    return githubMeta.stargazers_count;
  }
  if (candidate.popularityUnit === 'stars' && typeof candidate.popularityValue === 'number') {
    return candidate.popularityValue;
  }
  return null;
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
      selection_policy_version: "2.1.0"
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
            // A withdrawn review does not block a re-review of the same project: it is the
            // reason one is wanted. Skipping it here is what lets a deliberate request
            // produce the successor, while the selector's own exclusion list still stops the
            // daily cron from picking withdrawn projects back up on its own.
            if (fs.existsSync(path.join(productDir, 'editorial-withdrawal.json'))) continue;
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
