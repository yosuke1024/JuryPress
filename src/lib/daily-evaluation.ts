import type { Candidate } from '../schemas/selection';
import { EvidenceCollectionResultSchema, type EvidenceCollectionResult } from '../schemas/evidence';
import type { Evaluator } from './evaluation/evaluator';

export function prepareCandidateWithIntegrityContext(
  candidate: Candidate,
  contextInput: EvidenceCollectionResult
): { candidate: Candidate; context: EvidenceCollectionResult } {
  const context = EvidenceCollectionResultSchema.parse(contextInput);
  const isGitHub = new URL(candidate.canonicalUrl).hostname.toLowerCase() === 'github.com';
  if (isGitHub && !context.metadata_snapshot) {
    throw new Error('[Integrity Violation] GitHub-backed refined articles require a metadata snapshot.');
  }

  return {
    context,
    candidate: {
      ...candidate,
      metadata: {
        ...candidate.metadata,
        project_identity: context.project_identity,
        metadata_snapshot: context.metadata_snapshot
      }
    }
  };
}

export function finalizeRefinedEvaluation(
  evaluator: Evaluator,
  generatedOutput: unknown,
  contextInput: EvidenceCollectionResult,
  promptVersion: string
): any {
  const context = EvidenceCollectionResultSchema.parse(contextInput);
  const evaluation = evaluator.recalculateScores(
    generatedOutput,
    context.evidences,
    { prompt_version: promptVersion },
    { integrityContext: context }
  ) as any;

  if (evaluation.evaluation_integrity_version !== '1.0.0'
    || !evaluation.project_identity
    || !evaluation.core_source_evidence
    || !evaluation.test_evidence_summary
    || !evaluation.confidence_adjustments
    || !evaluation.claim_references
    || !evaluation.counter_evidence_references
    || !evaluation.discussion_evidence) {
    throw new Error('[Integrity Violation] Mandatory evaluation integrity metadata is missing.');
  }
  return evaluation;
}
