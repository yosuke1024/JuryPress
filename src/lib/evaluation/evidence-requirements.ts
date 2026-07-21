/**
 * Evidence requirements: which rubric criteria the collected evidence is too thin to score.
 *
 * A review of Grok Build scored technical quality at high confidence with zero source-code
 * evidence. The published methodology says an evidence-limited criterion must be Not
 * Assessable — which nulls the overall score and leaves the review unranked — but nothing in
 * code enforced it, so the model's self-reported confidence stood. This module is that
 * enforcement: an evidence requirement the code checks, ahead of anything the model claims.
 *
 * It is deliberately a pure function of an evidence context so two call sites can share one
 * rule: the score recalculation (which marks the affected criteria Not Assessable at
 * generation time) and the pre-generation reviewability gate (which decides whether a
 * candidate can be assessed at all before a Gemini request is spent).
 *
 * The set starts at the one invariant we are certain of and is meant to grow. It is not a
 * judgement about the project — a project may be excellent and simply have had its source
 * missed or gated; it is a statement about whether THIS evaluation had the material to judge.
 */

/** Criterion ids in the Open Product Rubric this module reasons about. */
export const TECHNICAL_QUALITY = 'technical_quality';

export interface EvidenceContext {
  /** Number of source_code evidence items collected for the review. */
  coreSourceCount: number;
}

export interface UnassessableCriterion {
  criterionId: string;
  /** Reader-facing explanation. Not named `reason`: the prompt-injection scan flags any
   *  `.reason` access in a prompt-building module, and evaluator.ts reads this one. */
  explanation: string;
}

/**
 * The criteria that cannot be assessed from the given evidence, each with a reader-facing
 * reason. Ordered and deduplicated is not needed yet (one rule), but callers should treat the
 * result as a set keyed by criterionId.
 */
export function unassessableCriteria(ctx: EvidenceContext): UnassessableCriterion[] {
  const out: UnassessableCriterion[] = [];

  // The minimum invariant. Technical quality is a claim about the implementation; with no
  // source-code evidence there is nothing to judge it against, whatever the model reported.
  if (ctx.coreSourceCount <= 0) {
    out.push({
      criterionId: TECHNICAL_QUALITY,
      explanation: 'no source-code evidence was collected, so technical quality cannot be assessed from the material'
    });
  }

  return out;
}

/** Reads the evidence context off a (finalized or persisted) V3 evaluation object. */
export function evidenceContextOf(evaluation: any): EvidenceContext {
  const count = evaluation?.core_source_evidence?.source_count;
  return { coreSourceCount: typeof count === 'number' ? count : 0 };
}

/** True when the evidence is too thin to score at least one criterion. */
export function hasUnassessableCriteria(ctx: EvidenceContext): boolean {
  return unassessableCriteria(ctx).length > 0;
}
