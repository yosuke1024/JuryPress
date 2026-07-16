import type { Evidence, EvidenceFactClass } from '../../schemas/evidence';

/**
 * Enumerates every reader-facing string in an evaluation, keyed by its dotted
 * path. This is the single source of truth for "what counts as public prose",
 * shared by claim-reference construction (generation side) and the publication
 * gate (validation side) so the two can never drift apart.
 */
export function publicTextFields(evaluation: any): Array<{ path: string; text: string }> {
  const fields: Array<{ path: string; text: string }> = [];
  const add = (path: string, value: unknown) => {
    if (typeof value === 'string' && value.trim().length > 0) fields.push({ path, text: value });
  };

  add('product.summary', evaluation.product?.summary);
  add('article.headline', evaluation.article?.headline);
  add('article.standfirst', evaluation.article?.standfirst);
  add('article.jury_summary', evaluation.article?.jury_summary);
  add('article.final_verdict', evaluation.article?.final_verdict);
  add('article.meta_description', evaluation.article?.meta_description);
  evaluation.article?.where_jury_agreed?.forEach((value: string, index: number) => add(`article.where_jury_agreed.${index}`, value));
  evaluation.article?.where_jury_disagreed?.forEach((value: any, index: number) => add(`article.where_jury_disagreed.${index}.summary`, value?.summary));
  evaluation.judges?.forEach((judge: any, judgeIndex: number) => {
    add(`judges.${judgeIndex}.verdict`, judge.verdict);
    judge.strengths?.forEach((value: string, index: number) => add(`judges.${judgeIndex}.strengths.${index}`, value));
    judge.concerns?.forEach((value: string, index: number) => add(`judges.${judgeIndex}.concerns.${index}`, value));
    judge.criteria?.forEach((criterion: any, criterionIndex: number) => add(`judges.${judgeIndex}.criteria.${criterionIndex}.reasoning`, criterion.reasoning));
  });
  return fields;
}

export function getFieldValue(root: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((current, segment) => {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    return (current as Record<string, unknown>)[segment];
  }, root);
}

/**
 * Public fields that state a claim about the product by construction and are
 * where the audit found creator claims laundered as fact. A non-empty field
 * here must carry at least one validated claim reference, so an empty annotation
 * set can never quietly pass on exactly these fields. Kept narrow deliberately:
 * fields that can be legitimately fully hedged (verdicts, concerns) are not
 * forced to cite evidence, which would be unsatisfiable for a negative.
 */
export const MANDATORY_CLAIM_FIELDS = [
  'product.summary',
  'article.jury_summary',
  'article.final_verdict'
] as const;

export function factClassForEvidence(evidence: Evidence): EvidenceFactClass {
  const raw = evidence.claims?.[0]?.claim_type as string | undefined;
  if (raw === 'verified_fact') return 'confirmed_fact';
  if (raw === 'unknown') return 'unverified';
  if (raw && ['confirmed_fact', 'creator_claim', 'community_opinion', 'repository_observation', 'inference', 'unverified'].includes(raw)) {
    return raw as EvidenceFactClass;
  }
  if (evidence.type === 'api_metadata') return 'confirmed_fact';
  if (['source_code', 'test_file', 'ci_workflow', 'dependency_manifest'].includes(evidence.type)) return 'repository_observation';
  if (evidence.type === 'source_discussion') return 'community_opinion';
  if (['readme', 'official_site', 'additional_evidence'].includes(evidence.type)) return 'creator_claim';
  return 'unverified';
}

/** A cited claim must be attributed when any supporting evidence is a claim, not a fact. */
export function attributionRequired(factClasses: EvidenceFactClass[]): boolean {
  return factClasses.some(fc => fc === 'creator_claim' || fc === 'community_opinion');
}

export const CREATOR_ATTRIBUTION = /\b(according to|readme|project describes|creator (?:states|reports|claims)|repository documents|documentation (?:states|says))\b/i;
export const COMMUNITY_ATTRIBUTION = /\b(commenter|commenters|community|discussion|community opinion|a user|users questioned|criticism|criticized)\b/i;

export function attributionPatternFor(factClass: EvidenceFactClass): RegExp {
  return factClass === 'community_opinion' ? COMMUNITY_ATTRIBUTION : CREATOR_ATTRIBUTION;
}
