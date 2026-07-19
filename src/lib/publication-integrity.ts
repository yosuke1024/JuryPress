import { isDeepStrictEqual } from 'node:util';
import type { EvidenceBundle } from '../schemas/evidence';
import { GitHubMetadataSnapshotSchema } from '../schemas/evidence';
import { RefinedReviewSchemaV2, RefinedReviewSchemaV2_1 } from '../schemas/review';
import { isValidDisplayName } from './identity';
import { getJudges } from './jury';
import { factClassForEvidence as evidenceFactClass, getFieldValue, validateClaimReferences, buildProtectedTokens, scannableTextFields, assertionScanFields, findAbsoluteAssertions, type TrustedClaimReference } from './evaluation/public-claims';
import { validateRecommendations } from './evaluation/recommendations';

function meaningfulTokens(text: string): Set<string> {
  const stopWords = new Set(['about', 'after', 'again', 'also', 'because', 'could', 'does', 'from', 'have', 'into', 'just', 'more', 'only', 'project', 'that', 'their', 'there', 'these', 'they', 'this', 'with', 'would']);
  return new Set((text.toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || []).filter(token => !stopWords.has(token)));
}

function hasTopicOverlap(left: string, right: string): boolean {
  const leftTokens = meaningfulTokens(left);
  const rightTokens = meaningfulTokens(right);
  return [...leftTokens].some(token => rightTokens.has(token));
}

/**
 * Metric mention patterns. These are regex literals rather than strings composed
 * at runtime: composing them from strings silently degraded `\s` to a literal
 * "s", which stopped "999 open issues" from ever being compared to the snapshot.
 * Each pattern captures the number either before the metric ("17 open issues")
 * or after it ("open issues: 17").
 */
function metadataChecks(snapshot: any): Array<{ metric: string; pattern: RegExp; expected: number }> {
  return [
    { metric: 'stars', pattern: /\b(\d[\d,]*)\s+stars?\b|\bstars?:?\s*(\d[\d,]*)\b/gi, expected: snapshot.stars },
    { metric: 'forks', pattern: /\b(\d[\d,]*)\s+forks?\b|\bforks?:?\s*(\d[\d,]*)\b/gi, expected: snapshot.forks },
    { metric: 'open issues', pattern: /\b(\d[\d,]*)\s+(?:open\s+)?issues?\b|\b(?:open\s+)?issues?:?\s*(\d[\d,]*)\b/gi, expected: snapshot.open_issues }
  ];
}

function assertMetadataText(text: string, path: string, snapshot: any, slug: string): void {
  for (const check of metadataChecks(snapshot)) {
    for (const match of text.matchAll(check.pattern)) {
      const actual = Number((match[1] ?? match[2]).replace(/,/g, ''));
      if (actual !== check.expected) {
        throw new Error(`[Publication Gate] Inconsistent ${check.metric} count in ${path} for ${slug}: text says ${actual}, snapshot has ${check.expected}`);
      }
    }
  }
}

/**
 * Re-derives the application-owned public classifications from the trusted claim references,
 * mirroring the evaluator's buildRefinedClassifications so the gate and generator agree byte
 * for byte. One entry per cited evidence (fact class re-derived from the evidence), then one
 * runtime_observed entry per verified execution.
 */
function deriveRefinedClassifications(evaluation: any, evidenceById: Map<string, any>): Array<{ evidence_id: string; classification: string; claim: string }> {
  const cited = new Set<string>();
  for (const reference of evaluation.claim_references || []) {
    for (const id of reference.evidence_ids || []) cited.add(id);
  }
  const out: Array<{ evidence_id: string; classification: string; claim: string }> = [];
  for (const [id, evidence] of evidenceById) {
    if (!cited.has(id)) continue;
    out.push({ evidence_id: id, classification: evidenceFactClass(evidence), claim: evidence.claims?.[0]?.text || '' });
  }
  const snapshotSha = evaluation.metadata_snapshot?.latest_commit_sha;
  for (const [id, evidence] of evidenceById) {
    if (evidence.type !== 'test_result_artifact') continue;
    try {
      const parsed = JSON.parse(evidence.summary);
      if (parsed.status !== 'success' || !parsed.commit_sha || parsed.commit_sha !== snapshotSha) continue;
      out.push({ evidence_id: id, classification: 'runtime_observed', claim: evidence.claims?.[0]?.text || 'A verified test execution result was observed.' });
    } catch {
      // ignore unparseable artifacts; they cannot become verified executions
    }
  }
  return out;
}

/**
 * Deterministic Phase 1 publication validation. This is intentionally separate
 * from the CLI so regression tests exercise the same gate used before publish.
 */
export function validateRefinedReviewIntegrity(reviewInput: unknown, bundle: EvidenceBundle, slug: string): void {
  const isV2_1 = (reviewInput as any)?.schema_version === '2.1.0';
  const review = isV2_1
    ? RefinedReviewSchemaV2_1.parse(reviewInput)
    : RefinedReviewSchemaV2.parse(reviewInput);
  const evaluation: any = review.evaluation;
  const identity = evaluation.project_identity;

  // 2.1.0 recommendation contract: re-validated fail-closed at the gate, never
  // trusted from generation time alone.
  if (isV2_1) {
    try {
      validateRecommendations(evaluation, bundle.evidences);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`[Publication Gate] ${message} (${slug})`);
    }
  }

  if (!isValidDisplayName(identity.canonical_display_name)) {
    throw new Error(`[Publication Gate] Invalid canonical_display_name in ${slug}: "${identity.canonical_display_name}"`);
  }
  if (evaluation.product.name !== identity.canonical_display_name) {
    throw new Error(`[Publication Gate] Product name mismatch in ${slug}: expected "${identity.canonical_display_name}", found "${evaluation.product.name}"`);
  }

  // Judge name and role are application-owned persona identity, not model prose. Pin them to
  // the canonical persona profiles so a refined review cannot smuggle an unprovenanced claim or
  // a fabricated metric through these reader-facing but coverage-exempt free-text fields.
  const canonicalProfiles = new Map(getJudges((review as any).rubric_id).map(profile => [profile.slug, profile]));
  for (const judge of evaluation.judges) {
    const profile = canonicalProfiles.get(judge.judge_id);
    if (!profile) {
      throw new Error(`[Publication Gate] Unknown judge_id "${judge.judge_id}" in ${slug}`);
    }
    if (judge.judge_name !== profile.name || judge.role !== profile.role) {
      throw new Error(`[Publication Gate] Judge ${judge.judge_id} name/role do not match the canonical persona in ${slug}`);
    }
  }

  const evidenceById = new Map(bundle.evidences.map(evidence => [evidence.evidence_id, evidence]));
  for (const evidence of bundle.evidences) {
    if (evidence.claims.length === 0) {
      throw new Error(`[Publication Gate] Refined evidence ${evidence.evidence_id} has no classified claims in ${slug}`);
    }
  }

  // Every criterion evidence_id is rendered reader-facing ("Evidence: …") and must resolve to a
  // real bundle evidence, so this model-authored array cannot carry arbitrary free-text prose.
  for (const judge of evaluation.judges) {
    for (const criterion of judge.criteria) {
      for (const evidenceId of criterion.evidence_ids || []) {
        if (!evidenceById.has(evidenceId)) {
          throw new Error(`[Publication Gate] Criterion ${criterion.criterion_id} cites unknown evidence "${evidenceId}" in ${slug}`);
        }
      }
    }
  }

  const githubBacked = bundle.evidences.some(evidence => evidence.type === 'api_metadata' && evidence.url.startsWith('https://api.github.com/repos/'));
  if (githubBacked) {
    const reviewSnapshot = GitHubMetadataSnapshotSchema.parse(evaluation.metadata_snapshot);
    const bundleSnapshot = GitHubMetadataSnapshotSchema.parse(bundle.metadata_snapshot);
    if (!isDeepStrictEqual(reviewSnapshot, bundleSnapshot)) {
      throw new Error(`[Publication Gate] Immutable Metadata Snapshot content mismatch in ${slug}`);
    }

    const apiEvidence = bundle.evidences.find(evidence => evidence.type === 'api_metadata');
    if (!apiEvidence || apiEvidence.snapshot_id !== reviewSnapshot.snapshot_id) {
      throw new Error(`[Publication Gate] API metadata evidence snapshot mismatch in ${slug}`);
    }
    const metadata = JSON.parse(apiEvidence.summary);
    if (metadata.stargazers_count !== reviewSnapshot.stars || metadata.forks_count !== reviewSnapshot.forks || metadata.open_issues_count !== reviewSnapshot.open_issues) {
      throw new Error(`[Publication Gate] API metadata values do not match the immutable snapshot in ${slug}`);
    }
    for (const field of scannableTextFields(evaluation)) {
      assertMetadataText(field.text, field.path, reviewSnapshot, slug);
    }
  }

  if (!evaluation.claim_references?.length) {
    throw new Error(`[Publication Gate] Refined review has no claim_references in ${slug}`);
  }
  // Statement-level whole-field coverage. The shared module re-derives every trusted field
  // (fact_class, attribution_required, source_fact_classes, coverage_source) from the
  // evidence and re-checks that every statement of every public coverage field is
  // provenance-covered, that each statement citing creator/community evidence — whatever its
  // support_mode — is attributed IN ITSELF, that inference/unverified statements carry their
  // calibrated wording, and that persisted source_fact_classes exactly equal a fresh
  // re-derivation from evidence_ids (deduplicated, fixed enum order, independent of
  // evidence_ids order). A persisted reference can therefore never relabel its evidence,
  // forge attribution, launder a creator/community source behind an inference label, cite
  // missing evidence, or leave a sentence unannotated. Generation and this gate call the
  // identical function.
  try {
    const protectedTokens = buildProtectedTokens(bundle.evidences);
    // No wording sink BY DESIGN: the publication gate is strict, so a persisted reference whose
    // statement launders a creator/community source or drops its absence/calibration hedge fails
    // closed here even though generation only warned. See the phase-1 fail-closed suite.
    validateClaimReferences(evaluation, evaluation.claim_references as TrustedClaimReference[], evidenceById, protectedTokens);
  } catch (error) {
    throw new Error(`[Publication Gate] ${(error as Error).message} (${slug})`);
  }

  // Refined public classifications must be exactly the application-derived set: one entry per
  // evidence cited by a trusted claim reference, classified by re-deriving fact_class from the
  // evidence itself, plus a runtime_observed entry per verified execution. This makes it
  // impossible to persist a README (creator_claim) evidence as "confirmed", or to relabel any
  // classification, independent of what the model reported.
  const expectedClassifications = deriveRefinedClassifications(evaluation, evidenceById);
  const actualClassifications = (evaluation.article.evidence_classifications || [])
    .map((entry: any) => ({ evidence_id: entry.evidence_id, classification: entry.classification, claim: entry.claim }));
  if (!isDeepStrictEqual(actualClassifications, expectedClassifications)) {
    throw new Error(`[Publication Gate] Refined evidence_classifications are not the application-derived set in ${slug}`);
  }

  const testSummary = evaluation.test_evidence_summary;
  const snapshotSha = evaluation.metadata_snapshot?.latest_commit_sha;
  const verifiedExecutions = testSummary.verified_execution_results || [];
  if (verifiedExecutions.some((result: any) => result.status !== 'success' || !snapshotSha || result.commit_sha !== snapshotSha)) {
    throw new Error(`[Publication Gate] Verified test execution does not match the metadata snapshot commit in ${slug}`);
  }
  // Every claimed verified execution must be backed by a real test_result_artifact evidence in
  // the bundle whose parsed result actually succeeded at the snapshot commit. Without this, a
  // fabricated verified_execution_results entry (commit_sha is the public snapshot sha) would
  // disable the 0.66 confidence ceiling and the "tests pass" assertion scan with no real run.
  const backedExecutionShas = new Set(
    bundle.evidences
      .filter(evidence => evidence.type === 'test_result_artifact')
      .flatMap(evidence => {
        try {
          const parsed = JSON.parse(evidence.summary);
          return parsed.status === 'success' && typeof parsed.commit_sha === 'string' ? [parsed.commit_sha] : [];
        } catch {
          return [];
        }
      })
  );
  for (const result of verifiedExecutions) {
    if (!backedExecutionShas.has(result.commit_sha)) {
      throw new Error(`[Publication Gate] Verified execution result has no backing test artifact evidence in ${slug}`);
    }
  }
  if (verifiedExecutions.length === 0) {
    if (testSummary.confidence === 'HIGH') {
      throw new Error(`[Publication Gate] Test confidence cannot be HIGH without a verified execution result in ${slug}`);
    }
    if (evaluation.overall_evidence_confidence > 0.66) {
      throw new Error(`[Publication Gate] Overall confidence exceeds 0.66 without a verified execution result in ${slug}`);
    }
    const prohibitedAssertions = /\b(tests? pass(?:ed|es)?|ci is healthy|runtime behavior (?:is|was) verified|reliability is demonstrated)\b/i;
    // Assertion scan excludes the hedge/limitation-class fields so a legitimately hedged
    // limitation ("could not verify that the tests pass") does not hard-fail the publish.
    const invalidField = assertionScanFields(evaluation).find(field => prohibitedAssertions.test(field.text));
    if (invalidField) {
      throw new Error(`[Publication Gate] Unverified test execution assertion in ${invalidField.path} for ${slug}`);
    }
  }

  // Unsupportable absolutes ("proven secure", "zero vulnerabilities"), asserted in the jury's
  // own voice. Unconditional — unlike the test-execution scan above it does not depend on
  // whether a verified execution exists, because no evidence this pipeline collects can
  // establish the absence of a defect. Shares one predicate with the validator so generation
  // and publication cannot disagree.
  const absolute = findAbsoluteAssertions(evaluation, buildProtectedTokens(bundle.evidences))[0];
  if (absolute) {
    throw new Error(
      `[Publication Gate] Unsupportable absolute assertion in ${absolute.path} for ${slug}: "${absolute.statement}"`
    );
  }

  for (const adjustment of evaluation.confidence_adjustments) {
    if (!adjustment.ceiling_applied || adjustment.original_confidence === adjustment.final_confidence) {
      throw new Error(`[Publication Gate] Confidence adjustment does not describe an actual change in ${slug}`);
    }
  }
  const internalPhrase = scannableTextFields(evaluation).find(field => /\[?confidence ceiling|deterministic rules?/i.test(field.text));
  if (internalPhrase) {
    throw new Error(`[Publication Gate] Internal confidence implementation text leaked into ${internalPhrase.path} in ${slug}`);
  }

  const discussionItems = evaluation.discussion_evidence.items || [];
  for (const item of discussionItems) {
    const parent = evidenceById.get(item.parent_evidence_id);
    if (!parent || evidenceFactClass(parent) !== 'community_opinion') {
      throw new Error(`[Publication Gate] Discussion item ${item.discussion_item_id} has no community-opinion parent evidence in ${slug}`);
    }
  }
  // Only items the model actually received can be required in public output.
  // Every comment is kept in discussion_evidence for the record, but the summary
  // sent to the model is capped and truncated; demanding a response to criticism
  // that was never supplied as input would fail the publish over unseen evidence.
  for (const item of discussionItems.filter((entry: any) => entry.requires_public_response)) {
    const reference = evaluation.counter_evidence_references.find((entry: any) => entry.discussion_item_id === item.discussion_item_id);
    if (!reference || reference.parent_evidence_id !== item.parent_evidence_id) {
      throw new Error(`[Publication Gate] Critical discussion item ${item.discussion_item_id} is not linked to public output in ${slug}`);
    }
    const outputPath = reference.public_output_path || reference.target_field;
    const outputText = getFieldValue(evaluation, outputPath);
    if (typeof outputText !== 'string' || !/\b(commenter|commenters|community|discussion|community opinion|a user|users questioned|criticism|criticized)\b/i.test(outputText) || !hasTopicOverlap(item.excerpt, outputText)) {
      throw new Error(`[Publication Gate] Critical discussion item ${item.discussion_item_id} is not specifically reflected in ${outputPath} for ${slug}`);
    }
  }
}
