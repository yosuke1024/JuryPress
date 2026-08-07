import type { QualityFinding } from '../../schemas/generation-record';

/**
 * The editorial recommendation contract (issue #85) — deterministic checks on each judge's
 * recommended_next_step for records generated under prompt 4.5.0 or later.
 *
 * The scriptc review exposed three failure modes: an action that does not address the concern
 * it is paired with (Lisa), actions the maintainer cannot execute because they demand a new
 * institution (Alex's governance model, Marcus's foundation transfer), and two judges
 * converging on the same organizational solution class. The 4.5.0 prompt states the contract
 * to the writer; this module enforces the deterministically checkable slice of it.
 *
 * Severity classification is grounded in a scan of every editorial record published before
 * this module existed (27 records, 135 recommendations):
 *
 * ERROR (withholds publication) — empirically near-zero false positives:
 *  - An organizational end state posing as a next step (create a governance body, transfer
 *    to a foundation, secure funding). Every historical match was a genuine defect, and the
 *    pattern recurred in 4 of 27 records — this is the failure mode the issue exists to stop.
 *  - Two judges recommending substantially the same action. The highest containment a real
 *    pair of distinct recommendations reached was 0.44; the 0.75 threshold sits far above it.
 *  - A missing action or missing primary concern — the article would lack a required section.
 *
 * WARNING (recorded, published):
 *  - No shared vocabulary between the concern and its action. As an error this would have
 *    excluded 24 of the 27 scanned records: a legitimate action routinely answers a concern
 *    in solution words ("installation friction" → "package it as a desktop bundle"), so
 *    lexical overlap is a proxy too weak to withhold publication on — exactly the false
 *    negative the audit-era pipeline documented before downgrading its twin of this rule.
 *    The 4.5.0 prompt now asks the writer to reuse a concern word in the action, which makes
 *    the surviving warnings rare enough to be worth an operator's eyes.
 *  - Genericness, brevity, question phrasing — style, not correctness.
 *
 * This module is deliberately self-contained rather than importing from recommendations.ts:
 * that file is the FROZEN audit-era (≤3.x) contract, and sharing its tokenizer or word lists
 * would let a change for one era silently rewrite the other's rules. The two contracts may
 * only evolve independently.
 */

export const EDITORIAL_RECOMMENDATION_RULE_VERSION = '1.0.0';

/**
 * Whether a record's prompt version carries the recommendation contract. 4.5.0 introduced it;
 * earlier editorial records (4.0.0–4.4.0) were generated without these instructions and are
 * never judged by rules they were not written to satisfy.
 */
export function recommendationContractApplies(promptVersion: string | null | undefined): boolean {
  if (!promptVersion) return false;
  const [major, minor] = promptVersion.split('.').map(part => parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  return major > 4 || (major === 4 && Number.isFinite(minor) && minor >= 5);
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'could', 'does', 'from', 'have', 'into',
  'just', 'more', 'only', 'project', 'that', 'their', 'there', 'these', 'they', 'this',
  'with', 'would'
]);

/**
 * Crude suffix stemming so "tests" meets "testing" and "synchronize" meets "synchronized".
 * The historical scan showed plain-token matching misses exactly these morphological pairs,
 * which is noise in a signal that is already only a proxy.
 */
function stem(token: string): string {
  for (const suffix of ['ing', 'ed', 'es', 's']) {
    if (token.endsWith(suffix) && token.length - suffix.length >= 3) {
      return token.slice(0, token.length - suffix.length);
    }
  }
  return token;
}

function meaningfulStems(text: string): Set<string> {
  return new Set(
    ((text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [])
      .filter(token => !STOP_WORDS.has(token))
      .map(stem)
  );
}

function normalizeAction(action: string): string {
  return (action || '').toLowerCase().replace(/[.!?\s]+$/g, '').replace(/\s+/g, ' ').trim();
}

/** Exact-match blacklist of generic recommendations, as literal as the audit-era one. */
const GENERIC_RECOMMENDATIONS = new Set([
  'improve documentation',
  'improve the documentation',
  'add more tests',
  'add tests',
  'enhance usability',
  'consider security',
  'listen to users',
  'continue improving the product',
  'address the concern',
  'make the project more robust'
]);

const MIN_ACTION_LENGTH = 30;

/**
 * Organizational end states a project maintainer cannot execute as a next step. Each pattern
 * is a verb-of-establishment-or-transfer anchored to an institutional object, because the
 * nouns alone are legitimate in first-step form: "publish a GOVERNANCE.md" and "document the
 * ownership policy" are exactly the corrections the contract asks for, and only pairing the
 * noun with founding or transferring makes it an end state. `[^.;]` keeps a match inside one
 * clause so a two-sentence action cannot match across its sentence boundary.
 *
 * "data/access/AI governance" is excluded: for a product in the governance-tooling space
 * those words name a feature, not a restructuring.
 */
const BEYOND_MAINTAINER_SCOPE_PATTERNS: RegExp[] = [
  // Founding a governance structure: "create an independent governance model",
  // "form a research consortium or steering committee".
  /\b(?:creat(?:e|ing)|establish(?:ing)?|form(?:ing)?|found(?:ing)?|institut(?:e|ing)|sett?(?:ing)?\s+up|launch(?:ing)?|adopt(?:ing)?|implement(?:ing)?|build(?:ing)?|spin(?:ning)?\s+(?:out|off))\b[^.;]*?\b(?:(?<!data\s)(?<!access\s)(?<!ai\s)governance\s+(?:model|structure|framework|body|board|committee)|steering\s+committee|oversight\s+(?:board|body|committee)|technical\s+committee|working\s+group|consortium)\b/i,
  // Founding a foundation. The adjective list is curated so "create a solid foundation for
  // testing" — the metaphor — stays out of reach.
  /\b(?:creat(?:e|ing)|establish(?:ing)?|form(?:ing)?|found(?:ing)?|sett?(?:ing)?\s+up|launch(?:ing)?)\s+(?:a|an|the)?\s*(?:(?:new|independent|neutral|vendor-neutral|nonprofit|non-profit|open|open-source|community-led|community)\s+){0,3}foundation\b/i,
  // Transferring the project to an institution: "transfer the runtime to a neutral foundation".
  /\b(?:transfer(?:ring)?|donat(?:e|ing)|hand(?:ing)?\s+(?:over|off)|migrat(?:e|ing)|mov(?:e|ing)|contribut(?:e|ing)|relinquish(?:ing)?)\b[^.;]*?\b(?:to|into)\s+(?:a|an|the)\s+(?:[\w-]+\s+){0,2}?(?:foundation|consortium|steering\s+committee|governance\s+body|nonprofit|non-profit)\b/i,
  // Landing an external institution's money: "secure corporate sponsorship". Setting up a
  // sponsorship page is a maintainer's own next step and uses none of these verbs.
  /\b(?:secur(?:e|ing)|rais(?:e|ing)|obtain(?:ing)?)\b[^.;]*?\b(?:funding|investment|sponsorship|acquisition)\b/i
];

/** Exposed for tests: which clause of an action put it beyond maintainer scope, if any. */
export function beyondMaintainerScopeMatch(action: string): string | null {
  for (const pattern of BEYOND_MAINTAINER_SCOPE_PATTERNS) {
    const match = (action || '').match(pattern);
    if (match) return match[0];
  }
  return null;
}

/**
 * Duplication threshold: share of the smaller action's stems that the larger also contains.
 * Real distinct recommendations peaked at 0.44 in the historical scan; rewordings of the same
 * action sit near 1.0. The minimum-size guard keeps two three-word actions from being judged
 * on almost no signal — actions that short are already warned as too short.
 */
const DUPLICATE_CONTAINMENT_THRESHOLD = 0.75;
const DUPLICATE_MIN_STEMS = 3;

function containment(a: Set<string>, b: Set<string>): number {
  const smaller = a.size <= b.size ? a : b;
  const larger = a.size <= b.size ? b : a;
  if (smaller.size === 0) return 0;
  let shared = 0;
  for (const value of smaller) if (larger.has(value)) shared++;
  return shared / smaller.size;
}

function error(code: string, path: string, message: string): QualityFinding {
  return { code, path, message, severity: 'error', ruleVersion: EDITORIAL_RECOMMENDATION_RULE_VERSION };
}

function warning(code: string, path: string, message: string): QualityFinding {
  return { code, path, message, severity: 'warning', ruleVersion: EDITORIAL_RECOMMENDATION_RULE_VERSION };
}

/**
 * Collects every recommendation-contract finding on editorial (V3) content, classified by
 * severity. Reports the whole picture in one pass, so an editor fixing an excluded record
 * sees every defect rather than peeling one error per revalidation.
 *
 * Structure (five judges, criteria arrays, criterion_id enum membership) is the schema gate's
 * job and is assumed here; this module reads only concerns and recommended_next_step. There is
 * no deterministic repair for any of these findings — a recommendation cannot be rewritten
 * without a judgment call — so unlike the audit-era contract this one only rejects or records.
 */
export function collectEditorialRecommendationFindings(content: any): QualityFinding[] {
  const findings: QualityFinding[] = [];
  const judges: any[] = content?.judges || [];

  const actionStems: (Set<string> | null)[] = [];
  const normalizedActions: (string | null)[] = [];

  judges.forEach((judge, judgeIndex) => {
    const base = `$.judges.${judgeIndex}`;
    const judgeName = judge?.judge_id || `judge ${judgeIndex}`;
    const action = typeof judge?.recommended_next_step?.action === 'string'
      ? judge.recommended_next_step.action.trim()
      : '';
    actionStems.push(null);
    normalizedActions.push(null);

    if (action.length === 0) {
      findings.push(error(
        'REQUIRED_SECTION_MISSING',
        `${base}.recommended_next_step.action`,
        `Judge ${judgeName} has no recommended next step, so the published article would be missing a required section.`
      ));
      return;
    }

    const primaryConcern = judge?.concerns?.[0];
    if (typeof primaryConcern !== 'string' || primaryConcern.trim().length === 0) {
      findings.push(error(
        'REQUIRED_SECTION_MISSING',
        `${base}.concerns.0`,
        `Judge ${judgeName} has no primary concern for the recommended next step to address.`
      ));
      return;
    }

    const stems = meaningfulStems(action);
    actionStems[judgeIndex] = stems;
    normalizedActions[judgeIndex] = normalizeAction(action);

    const scopeMatch = beyondMaintainerScopeMatch(action);
    if (scopeMatch) {
      findings.push(error(
        'RECOMMENDATION_BEYOND_MAINTAINER_SCOPE',
        `${base}.recommended_next_step.action`,
        `The recommended action asks for an organizational end state ("${scopeMatch}") rather than a ` +
        `first step the maintainer can begin. Recommend the artifact that starts it instead — a published ` +
        `policy, plan, document, check, or prototype.`
      ));
    }

    const concernStems = meaningfulStems(primaryConcern);
    if (![...stems].some(token => concernStems.has(token))) {
      findings.push(warning(
        'RECOMMENDATION_CONCERN_DISCONNECTED',
        `${base}.recommended_next_step.action`,
        `The recommended action shares no meaningful word with judge ${judgeName}'s primary concern; ` +
        `it may not address it.`
      ));
    }

    if (GENERIC_RECOMMENDATIONS.has(normalizeAction(action))) {
      findings.push(warning(
        'RECOMMENDATION_GENERIC',
        `${base}.recommended_next_step.action`,
        'The recommended action is a known generic recommendation.'
      ));
    }
    if (action.length < MIN_ACTION_LENGTH) {
      findings.push(warning(
        'RECOMMENDATION_TOO_SHORT',
        `${base}.recommended_next_step.action`,
        `The recommended action is shorter than ${MIN_ACTION_LENGTH} characters and may not be actionable.`
      ));
    }
    if (/\?\s*$/.test(action)) {
      findings.push(warning(
        'RECOMMENDATION_PHRASED_AS_QUESTION',
        `${base}.recommended_next_step.action`,
        'The recommended action is phrased as a question rather than an action.'
      ));
    }
  });

  for (let i = 0; i < judges.length; i++) {
    for (let j = i + 1; j < judges.length; j++) {
      const a = actionStems[i];
      const b = actionStems[j];
      if (!a || !b) continue;
      const identical = normalizedActions[i] === normalizedActions[j];
      const nearDuplicate = Math.min(a.size, b.size) >= DUPLICATE_MIN_STEMS
        && containment(a, b) >= DUPLICATE_CONTAINMENT_THRESHOLD;
      if (identical || nearDuplicate) {
        findings.push(error(
          'RECOMMENDATION_DUPLICATED_ACROSS_JUDGES',
          `$.judges.${j}.recommended_next_step.action`,
          `Judges ${judges[i]?.judge_id || i} and ${judges[j]?.judge_id || j} recommend substantially ` +
          `the same next step; each judge's recommendation must add distinct value.`
        ));
      }
    }
  }

  return findings;
}
