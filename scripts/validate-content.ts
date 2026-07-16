import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveContentRoot, resolveDataMode, type JuryPressDataMode } from '../src/lib/content-root';
import { getAllReviews } from '../src/lib/data';
import { PublicationStateSchema } from '../src/schemas/selection';
import { EvidenceBundleSchema, type EvidenceBundle } from '../src/schemas/evidence';
import { validateRefinedReviewIntegrity } from '../src/lib/publication-integrity';

function containsJsonFile(directory: string): boolean {
  if (!fs.existsSync(directory)) return false;
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory() ? containsJsonFile(entryPath) : entry.name.endsWith('.json')) return true;
  }
  return false;
}

function validateBasicPublicationGate(review: any, bundle: EvidenceBundle | null, slug: string): void {
  const json = JSON.stringify(review).toLowerCase();
  const bannedFixtureStrings = [
    '1250 stars', 'fixture-product', 'https://github.com/example/fixture',
    'a product used for testing the ci and ui components'
  ];
  for (const value of bannedFixtureStrings) {
    if (json.includes(value)) throw new Error(`[Publication Gate] Fixture/placeholder value detected in ${slug}: "${value}"`);
  }

  const prohibitedPhrases = [
    'highly detailed evaluation of', 'migrated from v1', 'hackathon rubric',
    'given the hackathon context', 'stars prove reliability', 'stars prove technical quality',
    'forks verify implementation', 'popularity confirms production readiness',
    'trending proves security', 'community interest proves usability'
  ];
  for (const phrase of prohibitedPhrases) {
    if (json.includes(phrase)) throw new Error(`[Publication Gate] Prohibited text detected in ${slug}: "${phrase}"`);
  }

  if (!bundle) throw new Error(`[Publication Gate] Missing evidence bundle for ${slug}`);
  const evidenceIds = new Set(bundle.evidences.map(evidence => evidence.evidence_id));
  for (const judge of review.evaluation.judges) {
    for (const criterion of judge.criteria) {
      for (const evidenceId of criterion.evidence_ids) {
        if (!evidenceIds.has(evidenceId)) {
          throw new Error(`[Publication Gate] Referenced Evidence ID "${evidenceId}" in ${slug} does not exist in evidence bundle`);
        }
      }
    }
  }

  const verdicts = new Set(review.evaluation.judges.map((judge: any) => judge.verdict));
  const concerns = new Set(review.evaluation.judges.map((judge: any) => judge.concerns.join(' ')));
  const questions = new Set(review.evaluation.judges.map((judge: any) => judge.decisive_question));
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

  if (review.schema_version === '2.0.0') {
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

  if (!metadata.presence?.package_manifest && !metadata.presence?.container_build) {
    const readme = bundle.evidences.find(evidence => evidence.type === 'readme')?.summary.toLowerCase() || '';
    const runHints = ['npm install', 'pip install', 'cargo install', 'go get', 'docker run', 'clone', 'execute'];
    if (!runHints.some(value => readme.includes(value))) {
      throw new Error(`[Publication Gate] Missing runnability evidence for ${slug}`);
    }
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

    if (review.evaluation.evaluation_integrity_version === '1.0.0') {
      if (!bundle) throw new Error(`[Publication Gate] Missing evidence bundle for refined review ${entry.slug}`);
      validateRefinedReviewIntegrity(review, bundle, entry.slug);
    }

    if (mode === 'production') {
      const statePath = path.join(publicationStateDir, `${entry.slug}.json`);
      if (!fs.existsSync(statePath)) throw new Error(`Missing publication state for slug: ${entry.slug}`);
      const state = PublicationStateSchema.parse(JSON.parse(fs.readFileSync(statePath, 'utf8')));
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
