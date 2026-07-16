import { isDeepStrictEqual } from 'node:util';
import type { Evidence, EvidenceBundle, EvidenceFactClass } from '../schemas/evidence';
import { GitHubMetadataSnapshotSchema } from '../schemas/evidence';
import { RefinedReviewSchemaV2 } from '../schemas/review';
import { isValidDisplayName } from './identity';

function getFieldValue(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, root);
}

function evidenceFactClass(evidence: Evidence): EvidenceFactClass {
  const claimType = evidence.claims[0]?.claim_type;
  if (claimType === 'verified_fact') return 'confirmed_fact';
  if (claimType === 'unknown') return 'unverified';
  if (claimType && ['confirmed_fact', 'creator_claim', 'community_opinion', 'repository_observation', 'inference', 'unverified'].includes(claimType)) {
    return claimType as EvidenceFactClass;
  }
  if (evidence.type === 'api_metadata') return 'confirmed_fact';
  if (['source_code', 'test_file', 'ci_workflow', 'dependency_manifest'].includes(evidence.type)) return 'repository_observation';
  if (evidence.type === 'source_discussion') return 'community_opinion';
  if (['readme', 'official_site', 'additional_evidence'].includes(evidence.type)) return 'creator_claim';
  return 'unverified';
}

function publicTextFields(evaluation: any): Array<{ path: string; text: string }> {
  const fields: Array<{ path: string; text: string }> = [];
  const add = (path: string, value: unknown) => {
    if (typeof value === 'string') fields.push({ path, text: value });
  };

  add('product.summary', evaluation.product?.summary);
  add('article.headline', evaluation.article?.headline);
  add('article.standfirst', evaluation.article?.standfirst);
  add('article.jury_summary', evaluation.article?.jury_summary);
  add('article.final_verdict', evaluation.article?.final_verdict);
  evaluation.article?.where_jury_agreed?.forEach((value: string, index: number) => add(`article.where_jury_agreed.${index}`, value));
  evaluation.article?.where_jury_disagreed?.forEach((value: any, index: number) => add(`article.where_jury_disagreed.${index}.summary`, value.summary));
  evaluation.judges?.forEach((judge: any, judgeIndex: number) => {
    add(`judges.${judgeIndex}.verdict`, judge.verdict);
    judge.strengths?.forEach((value: string, index: number) => add(`judges.${judgeIndex}.strengths.${index}`, value));
    judge.concerns?.forEach((value: string, index: number) => add(`judges.${judgeIndex}.concerns.${index}`, value));
    judge.criteria?.forEach((criterion: any, criterionIndex: number) => add(`judges.${judgeIndex}.criteria.${criterionIndex}.reasoning`, criterion.reasoning));
  });
  return fields;
}

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
 * Deterministic Phase 1 publication validation. This is intentionally separate
 * from the CLI so regression tests exercise the same gate used before publish.
 */
export function validateRefinedReviewIntegrity(reviewInput: unknown, bundle: EvidenceBundle, slug: string): void {
  const review = RefinedReviewSchemaV2.parse(reviewInput);
  const evaluation: any = review.evaluation;
  const identity = evaluation.project_identity;

  if (!isValidDisplayName(identity.canonical_display_name)) {
    throw new Error(`[Publication Gate] Invalid canonical_display_name in ${slug}: "${identity.canonical_display_name}"`);
  }
  if (evaluation.product.name !== identity.canonical_display_name) {
    throw new Error(`[Publication Gate] Product name mismatch in ${slug}: expected "${identity.canonical_display_name}", found "${evaluation.product.name}"`);
  }

  const evidenceById = new Map(bundle.evidences.map(evidence => [evidence.evidence_id, evidence]));
  for (const evidence of bundle.evidences) {
    if (evidence.claims.length === 0) {
      throw new Error(`[Publication Gate] Refined evidence ${evidence.evidence_id} has no classified claims in ${slug}`);
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
    for (const field of publicTextFields(evaluation)) {
      assertMetadataText(field.text, field.path, reviewSnapshot, slug);
    }
  }

  if (!evaluation.claim_references?.length) {
    throw new Error(`[Publication Gate] Refined review has no claim_references in ${slug}`);
  }
  for (const reference of evaluation.claim_references) {
    const evidenceIds: string[] = reference.evidence_ids?.length ? reference.evidence_ids : [reference.evidence_id].filter(Boolean);
    for (const evidenceId of evidenceIds) {
      const evidence = evidenceById.get(evidenceId);
      if (!evidence) throw new Error(`[Publication Gate] Claim ${reference.claim_id} references missing evidence ${evidenceId} in ${slug}`);
      if (evidenceFactClass(evidence) !== reference.fact_class) {
        throw new Error(`[Publication Gate] Claim ${reference.claim_id} changes fact class for ${evidenceId} in ${slug}`);
      }
    }

    const outputPath = reference.public_output_path || reference.target_field;
    const outputText = getFieldValue(evaluation, outputPath);
    if (typeof outputText !== 'string' || outputText.length === 0) {
      throw new Error(`[Publication Gate] Claim ${reference.claim_id} has an invalid public output path ${outputPath} in ${slug}`);
    }
    if (reference.attribution_required) {
      const creatorAttribution = /\b(according to|readme|project describes|creator (?:states|reports|claims)|repository documents)\b/i;
      const communityAttribution = /\b(commenter|commenters|community|discussion|community opinion|a user|users questioned|criticism|criticized)\b/i;
      const requiredPattern = reference.fact_class === 'community_opinion' ? communityAttribution : creatorAttribution;
      if (!requiredPattern.test(outputText)) {
        throw new Error(`[Publication Gate] Claim ${reference.claim_id} lacks attribution in its own public field ${outputPath} in ${slug}`);
      }
    }
  }

  const testSummary = evaluation.test_evidence_summary;
  const snapshotSha = evaluation.metadata_snapshot?.latest_commit_sha;
  const verifiedExecutions = testSummary.verified_execution_results || [];
  if (verifiedExecutions.some((result: any) => result.status !== 'success' || !snapshotSha || result.commit_sha !== snapshotSha)) {
    throw new Error(`[Publication Gate] Verified test execution does not match the metadata snapshot commit in ${slug}`);
  }
  if (verifiedExecutions.length === 0) {
    if (testSummary.confidence === 'HIGH') {
      throw new Error(`[Publication Gate] Test confidence cannot be HIGH without a verified execution result in ${slug}`);
    }
    if (evaluation.overall_evidence_confidence > 0.66) {
      throw new Error(`[Publication Gate] Overall confidence exceeds 0.66 without a verified execution result in ${slug}`);
    }
    const prohibitedAssertions = /\b(tests? pass(?:ed|es)?|ci is healthy|runtime behavior (?:is|was) verified|reliability is demonstrated)\b/i;
    const invalidField = publicTextFields(evaluation).find(field => prohibitedAssertions.test(field.text));
    if (invalidField) {
      throw new Error(`[Publication Gate] Unverified test execution assertion in ${invalidField.path} for ${slug}`);
    }
  }

  for (const adjustment of evaluation.confidence_adjustments) {
    if (!adjustment.ceiling_applied || adjustment.original_confidence === adjustment.final_confidence) {
      throw new Error(`[Publication Gate] Confidence adjustment does not describe an actual change in ${slug}`);
    }
  }
  const internalPhrase = publicTextFields(evaluation).find(field => /\[?confidence ceiling|deterministic rules?/i.test(field.text));
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
