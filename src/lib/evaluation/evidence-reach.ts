import type { Evidence } from '../../schemas/evidence';
import {
  assessClaimEvidenceReach,
  repoRelativePathFromRawUrl,
  type ClaimEvidenceReach
} from '../evidence/claim-domains';

/**
 * The EVIDENCE REACH block of the editorial prompt, and the reach clause of the
 * confidence-cap limitation. Both render the same assessment (claim-domains.ts) into words,
 * so the instruction the writer receives, the limitation the reader sees and the persisted
 * claim_evidence_reach record can never describe three different collections.
 *
 * Prompt-injection surface: this module reads ONLY collector-fetched evidence fields
 * (evidence_id, type, url, title, summary) and a numeric total. Nothing here may ever read
 * reader-submitted text — it feeds a prompt builder, and prompt-input-isolation.test.ts
 * scans it like the other prompt-side modules.
 */

/**
 * The EVIDENCE REACH section injected into the editorial (4.3.0+) prompt. States what the
 * jury actually examined and holds severe-claim strength to it. The rules live here rather
 * than only in the field specs because they need the examined-file list beside them; the
 * field specs carry one-line reminders (see buildEditorialPrompt).
 */
export function buildEvidenceReachBlock(
  evidences: readonly Evidence[],
  totalSourceFileCount: number | undefined
): string {
  const reach = assessClaimEvidenceReach(evidences);
  const sourceFiles = evidences
    .filter(e => e.type === 'source_code')
    .map(e => repoRelativePathFromRawUrl(e.url) ?? e.title);
  const examined = reach.domains.filter(d => d.examined);
  const unexamined = reach.domains.filter(d => !d.examined);

  const countClause = typeof totalSourceFileCount === 'number' && totalSourceFileCount > 0
    ? ` (${sourceFiles.length} of the ${totalSourceFileCount} source files in the repository)`
    : '';

  const examinedLine = examined.length > 0
    ? examined.map(d => `${d.label} — via ${[...new Set(d.matched_files)].join(', ')}`).join('; ')
    : 'none';
  const unexaminedLine = unexamined.length > 0
    ? unexamined.map(d => d.label).join('; ')
    : 'none';

  return `=== EVIDENCE REACH ===
Source files the jury examined${countClause}: ${sourceFiles.length > 0 ? sourceFiles.join(', ') : 'none'}.
Sensitive claim domains the examined implementation material reaches: ${examinedLine}.
Sensitive claim domains it does NOT reach: ${unexaminedLine}.

A severe claim about security, permissions, sandboxing, destructive writes, cost enforcement, or production reliability is a claim about specific implementation paths. Deliver it at verdict strength only when the examined material above reaches those paths. When it does not, the honest finding is the open question: state what the material does and does not show, frame the risk or the guarantee as a hypothesis the maintainers should answer, and let the relevant criterion's confidence and limitations carry that uncertainty. An unexamined path is never evidence that a protection is missing — or present.
Reach is relevance, not ratio. A few files that implement a claim's subject outweigh many that do not: judge what you read at full strength, and flag what you did not read.
The same limit governs recommendations. Do not endorse production or enterprise adoption whose safety rests on runtime, security, or scale behaviour in a domain listed as not reached; condition the endorsement on exactly what remains unverified.
======================`;
}

/**
 * The reach clause appended to the coverage limitation when technical-quality confidence is
 * capped. Turns "3 of 590 source files were examined" from a bare ratio into a statement of
 * what the sample did and did not bear on — the relevance the cap's critics rightly asked
 * for, in the reader's view of the criterion.
 */
export function reachLimitationClause(reach: ClaimEvidenceReach | undefined): string {
  if (!reach || !Array.isArray(reach.domains) || reach.domains.length === 0) return '';
  const examined = reach.domains.filter(d => d.examined);
  const unexamined = reach.domains.filter(d => !d.examined);
  if (examined.length === 0) {
    return ' None of the examined files bear on security- or reliability-sensitive implementation paths.';
  }
  const examinedLabels = examined.map(d => d.label).join(', ');
  if (unexamined.length === 0) {
    return ` The examined files bear on ${examinedLabels}.`;
  }
  const unexaminedLabels = unexamined.map(d => d.label).join(', ');
  return ` The examined files bear on ${examinedLabels}; ${unexaminedLabels} were not examined.`;
}
