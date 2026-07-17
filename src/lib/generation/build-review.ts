import type { GenerationRecord } from '../../schemas/generation-record';
import type { EvidenceCollectionResult } from '../../schemas/evidence';
import { RefinedReviewSchemaV2_1 } from '../../schemas/review';
import { Evaluator } from '../evaluation/evaluator';
import { finalizeRefinedEvaluation } from '../daily-evaluation';
import { TimezoneUtil } from '../timezone';
import { contentHash } from './record-store';

/**
 * Builds the published review from a validated generation record.
 *
 * The record — not a live evaluator result — is the source of truth. That is what makes the
 * publish step re-runnable and what lets a human-edited revision publish through exactly the
 * same path as an autonomous one: this function cannot tell the difference, and does not try.
 *
 * It is deterministic, so the validator runs it as a buildability check and the publish step
 * runs it again for real; the two cannot disagree.
 */
export function buildReviewFromRecord(input: {
  record: GenerationRecord;
  collectionResult: EvidenceCollectionResult;
  seasonConfig: any;
  date: Date;
  evaluator?: Evaluator;
  /** Content override, used by the validator to check content it has not yet persisted. */
  content?: unknown;
}): any {
  const { record, collectionResult, seasonConfig } = input;
  const content = input.content ?? record.editorial.currentContent;
  if (content === null || content === undefined) {
    throw new Error('[Build Review] The record has no content to publish.');
  }
  if (!record.slug) {
    throw new Error('[Build Review] The record has no slug.');
  }

  const evaluator = input.evaluator ?? new Evaluator();
  const promptVersion = record.generation.promptVersion || seasonConfig.evaluation_prompt_version || '2.1.0';
  const evaluationFinal = finalizeRefinedEvaluation(evaluator, content, collectionResult, promptVersion);

  if (collectionResult.project_identity) {
    evaluationFinal.product.name = collectionResult.project_identity.canonical_display_name;
  }

  const rawCount = collectionResult.evidence_usage?.raw_character_count || 0;
  const sanitizedCount = collectionResult.evidence_usage?.sanitized_character_count || 0;
  const sentCount = record.generation.route?.charactersSentToModel || 0;
  const ratio = rawCount > 0 ? (1 - sentCount / rawCount) : null;

  const route = record.generation.route;
  const evidences = collectionResult.evidences || [];

  const review = {
    schema_version: '2.1.0',
    recommendation_contract_version: '1.0.0',
    data_class: 'production',
    content_license: 'all-rights-reserved',
    copyright_holder: 'Yosuke Suzuki',
    season: 2,
    review_scope: 'open-source-software-product',
    slug: record.slug,
    published_at: TimezoneUtil.getJSTString(input.date),
    // The actually-served model reported by the API, carried through the record.
    model: record.generation.modelVersion,
    attempt_count: route?.totalAttempts || 1,
    generation_route: {
      successful_route: route?.successfulRoute,
      failover_used: route?.failoverUsed ?? false,
      primary_attempts: route?.primaryAttempts ?? 0,
      fallback_attempts: route?.fallbackAttempts ?? 0,
      total_attempts: route?.totalAttempts ?? 1
    },
    generation_metadata: {
      requested_model: route?.requestedModel,
      used_model: record.generation.modelVersion,
      thinking_level: route?.thinkingLevel,
      successful_route: route?.successfulRoute,
      failover_used: route?.failoverUsed ?? false,
      primary_attempts: route?.primaryAttempts ?? 0,
      fallback_attempts: route?.fallbackAttempts ?? 0,
      total_attempts: route?.totalAttempts ?? 1,
      token_usage: {
        input_tokens: record.generation.usage.promptTokens,
        output_tokens: record.generation.usage.completionTokens,
        thinking_tokens: record.generation.usage.thinkingTokens,
        total_tokens: record.generation.usage.totalTokens,
        cached_input_tokens: record.generation.usage.cachedInputTokens
      }
    },
    prompt_version: record.generation.promptVersion || '2.1.0',
    rubric_id: 'open-source-product',
    rubric_version: '2.0.0',
    selection_policy_id: 'open-source-product',
    selection_policy_version: '2.0.0',
    /**
     * Provenance the reader sees (§13). A human revision publishes through the same
     * validator as an autonomous one and cannot change any score — what differs is only
     * whether a person rewrote the prose, and the reader is told which it was.
     */
    human_reviewed: record.editorial.mode === 'human_edited',
    editorial_provenance: record.editorial.mode === 'human_edited' ? 'ai_generated_human_edited' : 'autonomously_generated',
    editorial_revision: record.editorial.currentRevision,
    relationship: 'independent' as const,
    ranking_eligible: evaluationFinal.recalculated_jury_score !== null,
    ranking_exclusion_reason: evaluationFinal.recalculated_jury_score === null ? 'evidence-limited-project' : undefined,
    evaluation_status: evaluationFinal.recalculated_jury_score === null ? 'evidence_limited' as const : 'complete' as const,
    assessment_coverage: evaluationFinal.recalculated_jury_score === null ? 0.8 : 1.0,
    jury_score: evaluationFinal.recalculated_jury_score,
    judge_score_range: evaluationFinal.judge_score_range,
    provenance: {
      no_fixture_provenance: true,
      api_metadata_verified: evidences.some((e: any) => e.type === 'api_metadata'),
      recalculated_by_code: true,
      verified_at: new Date().toISOString(),
      /**
       * The hash of the record content this review was built from. The publish gate compares
       * it against the record's validatedContentHash, which is what proves the published
       * article is the article that passed validation rather than something edited after.
       */
      generation_record_id: record.recordId,
      validated_content_hash: contentHash(content)
    },
    evaluation: evaluationFinal,
    // Unreported usage stays null — never fabricated zeros.
    usage: {
      input_tokens: record.generation.usage.promptTokens,
      output_tokens: record.generation.usage.completionTokens,
      estimated_cost: null
    },
    evidence_usage: {
      raw_character_count: rawCount,
      sanitized_character_count: sanitizedCount,
      characters_sent_to_model: sentCount,
      budget_limit: 24000,
      reduction_ratio: ratio
    }
  };

  return RefinedReviewSchemaV2_1.parse(review);
}
