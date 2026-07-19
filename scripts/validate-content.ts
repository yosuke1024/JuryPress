import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveContentRoot, resolveDataMode, type JuryPressDataMode } from '../src/lib/content-root';
import { getAllReviews } from '../src/lib/data';
import { AnyPublicationStateSchema } from '../src/schemas/selection';
import { EvidenceBundleSchema, type EvidenceBundle } from '../src/schemas/evidence';
import { validateEditorialReviewIntegrity, validateRefinedReviewIntegrity } from '../src/lib/publication-integrity';
import { EvidenceMapSchema } from '../src/schemas/evidence-map';

function containsJsonFile(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() ? containsJsonFile(entryPath) : entry.name.endsWith('.json')) return true;
  }
  return false;
}

function validateBasicPublicationGate(review: any, bundle: EvidenceBundle | null, slug: string): void {
  // Editorial (3.0.0) reviews are held to the system-protection subset only. The rules
  // skipped below are all content judgments — prohibited vocabulary, persona differentiation,
  // README-only confidence caps — that the editorial-first pipeline deliberately no longer
  // makes. What remains applies to every review: fixture leakage, evidence-bundle presence,
  // API metadata, license and runnability.
  const editorial = review.schema_version === '3.0.0';

  const json = JSON.stringify(review).toLowerCase();
  const bannedFixtureStrings = [
    '1250 stars', 'fixture-product', 'https://github.com/example/fixture',
    'a product used for testing the ci and ui components'
  ];
  for (const value of bannedFixtureStrings) {
    if (json.includes(value)) throw new Error(`[Publication Gate] Fixture/placeholder value detected in ${slug}: "${value}"`);
  }

  if (!editorial) {
    const prohibitedPhrases = [
      'highly detailed evaluation of', 'migrated from v1', 'hackathon rubric',
      'given the hackathon context', 'stars prove reliability', 'stars prove technical quality',
      'forks verify implementation', 'popularity confirms production readiness',
      'trending proves security', 'community interest proves usability'
    ];
    for (const phrase of prohibitedPhrases) {
      if (json.includes(phrase)) throw new Error(`[Publication Gate] Prohibited text detected in ${slug}: "${phrase}"`);
    }
  }

  if (!bundle) throw new Error(`[Publication Gate] Missing evidence bundle for ${slug}`);
  const evidenceIds = new Set(bundle.evidences.map(evidence => evidence.evidence_id));
  for (const judge of review.evaluation.judges) {
    for (const criterion of judge.criteria) {
      // V3 criteria carry no evidence_ids at all; the evidence map holds the linkage.
      for (const evidenceId of criterion.evidence_ids ?? []) {
        if (!evidenceIds.has(evidenceId)) {
          throw new Error(`[Publication Gate] Referenced Evidence ID "${evidenceId}" in ${slug} does not exist in evidence bundle`);
        }
      }
    }
  }

  if (!editorial) {
    const verdicts = new Set(review.evaluation.judges.map((judge: any) => judge.verdict));
    const concerns = new Set(review.evaluation.judges.map((judge: any) => judge.concerns.join(' ')));
    // Legacy judges differentiate through decisive_question; 2.1.0 judges through the
    // recommended next step action.
    const questions = new Set(review.evaluation.judges.map((judge: any) => judge.decisive_question ?? judge.recommended_next_step?.action));
    if (verdicts.size === 1 || concerns.size === 1 || questions.size === 1) {
      throw new Error(`[Publication Gate] Persona differentiation failed in ${slug}`);
    }

    const hasNonReadmeEvidence = bundle.evidences.some(evidence => !['readme', 'official_site'].includes(evidence.type));
    if (!hasNonReadmeEvidence) {
      for (const judge of review.evaluation.judges) {
        for (const criterion of judge.criteria) {
          if (['technical_quality', 'project_health_stewardship'].includes(criterion.criterion_id) && criterion.confidence === 'high') {
            throw new Error(`[Publication Gate] Confidence level too high for ${criterion.criterion_id} under README-only evidence in ${slug}`);
          }
        }
      }
    }
  }

  if (review.schema_version === '2.0.0' || review.schema_version === '2.1.0' || editorial) {
    if (!review.provenance?.no_fixture_provenance || !review.provenance?.api_metadata_verified || !review.provenance?.recalculated_by_code) {
      throw new Error(`[Publication Gate] Provenance metadata missing or unverified in ${slug}`);
    }
  }

  const apiEvidence = bundle.evidences.find(evidence => evidence.type === 'api_metadata');
  if (!apiEvidence) throw new Error(`[Publication Gate] Missing dynamic API metadata evidence for ${slug}`);
  let metadata: any;
  try {
    metadata = JSON.parse(apiEvidence.summary);
  } catch {
    throw new Error(`[Publication Gate] API metadata in ${slug} is not valid JSON`);
  }
  if (metadata.stargazers_count === undefined && metadata.likes === undefined) {
    throw new Error(`[Publication Gate] Missing stargazers_count or likes in API metadata for ${slug}`);
  }

  const approvedLicenses = new Set(['mit', 'apache-2.0', 'gpl-3.0', 'gpl-2.0', 'lgpl-3.0', 'bsd-3-clause', 'bsd-2-clause', 'mpl-2.0', 'unlicense', 'agpl-3.0']);
  const spdx = String(metadata.license_spdx || 'unknown').toLowerCase();
  if (!approvedLicenses.has(spdx)) {
    const readme = bundle.evidences.find(evidence => evidence.type === 'readme')?.summary.toLowerCase() || '';
    const documentedLicense = ['mit license', 'apache-2.0', 'general public license', 'bsd license'].some(value => readme.includes(value));
    if (!documentedLicense) throw new Error(`[Publication Gate] Unapproved or missing SPDX license for ${slug}: "${spdx}"`);
  }

  if (!hasRunnabilityEvidence(metadata, bundle.evidences)) {
    throw new Error(`[Publication Gate] Missing runnability evidence for ${slug}`);
  }
}

/** A canonical dependency-install command in a CI workflow. */
const CI_DEPENDENCY_INSTALL = /\b(?:pip3? install|npm (?:ci|install)|yarn install|pnpm install|bundle install|composer install)\b/;
/** An interpreter invoked on a repository script file — `python scripts/validate/format.py`. */
const CI_SCRIPT_EXECUTION = /\b(?:python3?|node|bash|sh|ruby|perl)\s+[^\s]*\.(?:py|js|mjs|cjs|ts|sh|rb|pl)\b/;
/** A canonical test/build runner execution. */
const CI_RUNNER_EXECUTION = /\b(?:pytest|npm (?:test|run)|yarn test|pnpm test|cargo (?:test|run|build)|go (?:test|run|build)|make)\b/;

/**
 * Deterministic runnability evidence, judged ONLY from the collected evidence bundle —
 * nothing is fetched at validation time. Accepted, in priority order:
 *
 *   1. The API metadata attests a package manifest or container build at the repo root.
 *   2. The repository's own CI demonstrably executes repository code: the API metadata
 *      independently attests workflows exist AND a collected ci_workflow evidence both
 *      installs dependencies and executes a repository script (or a canonical test/build
 *      runner). A workflow of pure `uses:` actions, an echo-only step, or an install with
 *      nothing executed qualifies under neither pattern and lends no runnability — such a
 *      candidate falls through to the README check and otherwise stays unpublishable.
 *   3. The README documents an actual run command. The bare `clone` hint became
 *      `git clone`: as a substring it also matched prose like "Open Source Reddit Clone",
 *      which is a product description, not a run instruction.
 */
export function hasRunnabilityEvidence(metadata: any, evidences: EvidenceBundle['evidences']): boolean {
  if (metadata.presence?.package_manifest || metadata.presence?.container_build) return true;

  if (metadata.presence?.workflows === true) {
    const workflow = evidences.find(evidence => evidence.type === 'ci_workflow')?.summary.toLowerCase() || '';
    if (CI_DEPENDENCY_INSTALL.test(workflow) && (CI_SCRIPT_EXECUTION.test(workflow) || CI_RUNNER_EXECUTION.test(workflow))) {
      return true;
    }
  }

  const readme = evidences.find(evidence => evidence.type === 'readme')?.summary.toLowerCase() || '';
  const runHints = ['npm install', 'pip install', 'cargo install', 'go get', 'docker run', 'git clone', 'execute'];
  return runHints.some(value => readme.includes(value));
}

/**
 * Checks the evidence map alongside an editorial review. Deliberately toothless: a missing,
 * unparseable or stale map is a WARNING and the page simply hides the appendix. The one thing
 * that would be a real defect is a review claiming a map it cannot show, and even that is
 * reported rather than thrown — a bookkeeping inconsistency must not be able to fail a deploy
 * for every article on the site.
 */
function validateEvidenceMapFile(reviewDir: string, review: any, slug: string): void {
  const mapPath = path.join(reviewDir, 'evidence-map.json');
  const exists = fs.existsSync(mapPath);
  const claimsAvailable = review.evidence_map_status === 'available';

  if (!exists) {
    if (claimsAvailable) {
      console.log(`::warning title=Evidence map missing::${slug} declares evidence_map_status "available" but no evidence-map.json is present.`);
    }
    return;
  }

  const parsed = EvidenceMapSchema.safeParse(JSON.parse(fs.readFileSync(mapPath, 'utf8')));
  if (!parsed.success) {
    console.log(`::warning title=Evidence map invalid::${slug} evidence-map.json failed schema validation; the appendix will be hidden.`);
    return;
  }
  const publishedHash = review.provenance?.validated_content_hash;
  if (publishedHash && parsed.data.article_hash !== publishedHash) {
    console.log(`::warning title=Evidence map stale::${slug} evidence-map.json describes different content than the published article; the appendix will be hidden. Re-run: npm run review:remap -- --id <record-id>`);
  }
}

export function validateContent(): void {
  console.log('[JuryPress Validation] Starting content validation...');
  const mode = resolveDataMode();
  const contentRoot = resolveContentRoot();
  console.log(`- Mode: ${mode}`);
  console.log(`- Content Root: ${contentRoot}`);

  const publicDataDir = path.join(process.cwd(), 'data');
  if (containsJsonFile(publicDataDir)) {
    throw new Error(`Security Violation: Production data JSON files were detected in the public repository checkout path: ${publicDataDir}`);
  }

  const reviews = getAllReviews();
  console.log(`- Loaded reviews: ${reviews.length}`);
  const manifestPath = path.join(contentRoot, 'manifest.json');
  if (fs.existsSync(manifestPath)) {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (mode === 'production' && manifest.reviews < 1) {
      throw new Error(`Production manifest reviews count must be at least 1. Found: ${manifest.reviews}`);
    }
  }

  const reviewsDir = path.join(contentRoot, 'reviews');
  const publicationStateDir = path.join(contentRoot, 'publication-state');
  for (const entry of reviews) {
    const review = entry.review as any;
    const reviewDir = path.join(reviewsDir, entry.year, entry.month, entry.slug);
    const evidencePath = path.join(reviewDir, 'evidence.json');
    const bundle = fs.existsSync(evidencePath)
      ? EvidenceBundleSchema.parse(JSON.parse(fs.readFileSync(evidencePath, 'utf8')))
      : null;

    if (bundle && bundle.data_class !== mode) {
      throw new Error(`Data classification mismatch for evidence bundle in ${entry.slug}: expected '${mode}', found '${bundle.data_class}'`);
    }

    // Version dispatch. schema_version is checked FIRST: V3 evaluations never carry
    // evaluation_integrity_version, but routing on its absence alone would silently skip all
    // system protection, so the editorial branch is explicit.
    if (review.schema_version === '3.0.0') {
      if (!bundle) throw new Error(`[Publication Gate] Missing evidence bundle for editorial review ${entry.slug}`);
      for (const warning of validateEditorialReviewIntegrity(review, bundle, entry.slug)) {
        // Owner decision: the metric-consistency scan is kept but must never block a publish.
        console.log(`::warning title=Metric consistency::${entry.slug} ${warning.path}: ${warning.message}`);
      }
      validateEvidenceMapFile(reviewDir, review, entry.slug);
    } else if (review.evaluation.evaluation_integrity_version === '1.0.0') {
      if (!bundle) throw new Error(`[Publication Gate] Missing evidence bundle for refined review ${entry.slug}`);
      validateRefinedReviewIntegrity(review, bundle, entry.slug);
    }

    if (mode === 'production') {
      const statePath = path.join(publicationStateDir, `${entry.slug}.json`);
      if (!fs.existsSync(statePath)) throw new Error(`Missing publication state for slug: ${entry.slug}`);
      const state = AnyPublicationStateSchema.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')));
      if (state.data_class !== 'production') throw new Error(`Data classification mismatch for publication state of ${entry.slug}`);

      validateBasicPublicationGate(review, bundle, entry.slug);

      if (state.publication_status === 'generated') {
        state.publication_status = 'validated';
        fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`);
        console.log(`- Updated publication status of ${entry.slug} to 'validated'`);
      }
    }
  }

  console.log('[JuryPress Validation] SUCCESS: All validation checks passed.');
}

function logValidationFailure(error: unknown, mode: JuryPressDataMode): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[JuryPress Validation] FAILED: ${message}`);
  if (mode !== 'production') return;
  try {
    const failuresDir = path.join(resolveContentRoot(), 'failures');
    fs.mkdirSync(failuresDir, { recursive: true });
    const runKey = `fail-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.writeFileSync(path.join(failuresDir, `${runKey}.json`), `${JSON.stringify({
      timestamp: new Date().toISOString(),
      error: message,
      stack: error instanceof Error ? error.stack : undefined
    }, null, 2)}\n`);
  } catch (writeError) {
    console.error('Failed to write validation failure log:', writeError);
  }
}

const isDirectExecution = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectExecution) {
  try {
    validateContent();
  } catch (error) {
    let mode: JuryPressDataMode = 'fixture';
    try { mode = resolveDataMode(); } catch {}
    logValidationFailure(error, mode);
    process.exitCode = 1;
  }
}
