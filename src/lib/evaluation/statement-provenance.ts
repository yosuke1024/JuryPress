import type { EvidenceFactClass } from '../../schemas/evidence';
import { SOURCE_FACT_CLASS_ORDER, type SupportMode } from './public-claims';

/**
 * Display model for the refined review "Statement Provenance" block. Statement mode
 * (support_mode) and source provenance (source_fact_classes) are kept as separate axes so
 * the UI can say "Jury inference, grounded on creator claims" — an inference never absorbs
 * or hides the provenance of the evidence it cites, and a README-grounded statement can
 * never surface as anything stronger than a creator claim.
 */
export interface StatementProvenanceGroup {
  support_mode: SupportMode;
  source_fact_classes: EvidenceFactClass[];
  statement_count: number;
}

const SUPPORT_MODE_ORDER: readonly SupportMode[] = ['evidence_backed', 'inference', 'unverified'];

const SUPPORT_MODE_LABELS: Record<SupportMode, string> = {
  evidence_backed: 'Evidence-backed',
  inference: 'Jury inference',
  unverified: 'Unverified'
};

const SOURCE_FACT_CLASS_LABELS: Record<EvidenceFactClass, string> = {
  confirmed_fact: 'confirmed facts',
  creator_claim: 'creator claims',
  community_opinion: 'community opinion',
  repository_observation: 'repository observations',
  inference: 'jury inferences',
  unverified: 'unverified sources'
};

export function supportModeLabel(mode: SupportMode): string {
  return SUPPORT_MODE_LABELS[mode];
}

/** e.g. "grounded on creator claims" / "no cited evidence". */
export function sourceProvenanceLabel(sourceFactClasses: EvidenceFactClass[]): string {
  if (sourceFactClasses.length === 0) return 'no cited evidence';
  return `grounded on ${sourceFactClasses.map(fc => SOURCE_FACT_CLASS_LABELS[fc]).join(' and ')}`;
}

/**
 * Groups trusted claim references by (support_mode, source_fact_classes) with deterministic
 * ordering: support modes in SUPPORT_MODE_ORDER, then source classes in
 * SOURCE_FACT_CLASS_ORDER. Legacy reviews have no claim_references and produce no groups,
 * so their existing display is untouched.
 */
export function summarizeStatementProvenance(claimReferences: unknown): StatementProvenanceGroup[] {
  if (!Array.isArray(claimReferences)) return [];
  const groups = new Map<string, StatementProvenanceGroup>();
  for (const reference of claimReferences) {
    const mode = reference?.support_mode as SupportMode | undefined;
    if (!mode || !SUPPORT_MODE_ORDER.includes(mode)) continue;
    const sources: EvidenceFactClass[] = Array.isArray(reference.source_fact_classes)
      ? SOURCE_FACT_CLASS_ORDER.filter(fc => reference.source_fact_classes.includes(fc))
      : [];
    const key = `${mode}|${sources.join(',')}`;
    const group = groups.get(key) || { support_mode: mode, source_fact_classes: sources, statement_count: 0 };
    group.statement_count += 1;
    groups.set(key, group);
  }
  return [...groups.values()].sort((a, b) => {
    const modeDelta = SUPPORT_MODE_ORDER.indexOf(a.support_mode) - SUPPORT_MODE_ORDER.indexOf(b.support_mode);
    if (modeDelta !== 0) return modeDelta;
    const rank = (g: StatementProvenanceGroup) => g.source_fact_classes.length === 0
      ? SOURCE_FACT_CLASS_ORDER.length
      : SOURCE_FACT_CLASS_ORDER.indexOf(g.source_fact_classes[0]);
    return rank(a) - rank(b) || a.source_fact_classes.join(',').localeCompare(b.source_fact_classes.join(','));
  });
}
