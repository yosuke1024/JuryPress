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
 * ERROR (withholds publication):
 *  - The action reuses no word from concerns[0]. This is not a semantic judgement about
 *    whether the action addresses the concern — it is the 4.5.0 prompt's own instruction,
 *    which requires at least one concrete word (4+ characters) from concerns[0] verbatim in
 *    the action, checked exactly as written: case-normalized token equality, no stemming, so
 *    the rule the writer is given and the rule the validator applies are the same rule.
 *    Compliance is not hypothetical: the audit-era 2.1.0 prompt carried the same self-check,
 *    and all 40 recommendations generated under it echo their concern. The 51-of-135
 *    disconnect rate in the 4.0.0–4.4.0 corpus is what the editorial prompt produced with no
 *    echo rule at all, so it predicts nothing about records generated with one — and those
 *    records are never judged here regardless (see recommendationContractApplies).
 *  - An organizational end state posing as a next step: founding or joining an institution,
 *    transferring the project to one, or acquiring external funding. Scoped to requiring a
 *    NEW external or independent organization, so the first-step artifacts that answer the
 *    same concern — a GOVERNANCE.md, an ownership policy, a documented governance model —
 *    stay publishable. Every match across the 27-record corpus was a genuine defect.
 *  - Two judges recommending substantially the same action. The highest containment a real
 *    pair of distinct recommendations reached was 0.44; the 0.75 threshold sits far above it.
 *  - A missing action or missing primary concern — the article would lack a required section.
 *
 * WARNING (recorded, published):
 *  - Genericness, brevity, question phrasing — style, not correctness.
 *  - A document answering a friction concern (issue #114, prompt 4.7.0): the concern names
 *    user-facing friction and the action's deliverable is a document that teaches users to
 *    endure it. Warning, not error, because both sides are curated lexicons — a semantic
 *    judgement approximated, not a rule the writer can verify mechanically the way the echo
 *    rule can be. The 4.6.0 corpus scan (fourteen records, 2026-08-13 – 08-26) found the
 *    pattern three times, every one of them Lisa; the same scan found same-deliverable
 *    convergence once in fourteen, which is why that defect got a prompt bullet and no
 *    machinery of its own.
 *  - An oversized scope expansion (issue #137, prompt 4.8.0): the action's own deliverable
 *    moves the project onto a new distribution surface, into another ecosystem, or into a
 *    new market, with no validation artifact in front of it. Warning for the same reason as
 *    the rule above: the lexicons are curated, so the finding is a signal, never a gate.
 *
 * This module is deliberately self-contained rather than importing from recommendations.ts:
 * that file is the FROZEN audit-era (≤3.x) contract, and sharing its tokenizer or word lists
 * would let a change for one era silently rewrite the other's rules. The two contracts may
 * only evolve independently.
 */

export const EDITORIAL_RECOMMENDATION_RULE_VERSION = '1.2.0';

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

/**
 * Whether a record's prompt version carries the design-intervention rule for friction
 * concerns (issue #114). 4.7.0 introduced it — "reduce the problem; do not document it" —
 * and earlier editorial records were generated without the instruction, so they are never
 * judged by it.
 */
export function designInterventionContractApplies(promptVersion: string | null | undefined): boolean {
  if (!promptVersion) return false;
  const [major, minor] = promptVersion.split('.').map(part => parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  return major > 4 || (major === 4 && Number.isFinite(minor) && minor >= 7);
}

/**
 * Whether a record's prompt version carries the validate-before-you-expand rule for scope
 * expansions (issue #137). 4.8.0 introduced it — name the smaller proving artifact before a
 * web/SaaS surface, an enterprise edition, an ecosystem migration, or a new market — and
 * earlier editorial records were generated without the instruction, so they are never judged
 * by it.
 */
export function scopeValidationContractApplies(promptVersion: string | null | undefined): boolean {
  if (!promptVersion) return false;
  const [major, minor] = promptVersion.split('.').map(part => parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  return major > 4 || (major === 4 && Number.isFinite(minor) && minor >= 8);
}

const STOP_WORDS = new Set([
  'about', 'after', 'again', 'also', 'because', 'could', 'does', 'from', 'have', 'into',
  'just', 'more', 'only', 'project', 'that', 'their', 'there', 'these', 'they', 'this',
  'with', 'would'
]);

/**
 * The words the echo rule is about: 4+ characters, not a stop word, case-normalized. This is
 * the tokenizer for the BLOCKING rule, so it is deliberately literal — the prompt says
 * "verbatim", and a validator that quietly accepts "testing" for "tests" would be enforcing a
 * rule the writer was never given. Case folding is the only normalization: a concern that
 * opens with "Tests" and an action that says "tests" are the same word to a reader.
 */
function meaningfulTokens(text: string): Set<string> {
  return new Set(
    ((text || '').toLowerCase().match(/[a-z0-9][a-z0-9_-]{3,}/g) || [])
      .filter(token => !STOP_WORDS.has(token))
  );
}

/**
 * Crude suffix stemming, used ONLY by the cross-judge duplication measure — never by the echo
 * rule. There, morphological folding is what makes "Publish a roadmap" and "Publishing the
 * roadmaps" read as the same recommendation, which is the thing being measured.
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
  return new Set([...meaningfulTokens(text)].map(stem));
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
 * Organizational end states a project maintainer cannot execute as a next step.
 *
 * What makes an action out of scope is that it requires a NEW EXTERNAL OR INDEPENDENT
 * ORGANIZATION — one the maintainer cannot bring into existence, join, or be funded by on
 * their own. The governance VOCABULARY is not the defect and must not be treated as one: a
 * GOVERNANCE.md, a documented governance model, an ownership or succession policy, a
 * contribution guide and a sponsors page are exactly the first-step artifacts this contract
 * asks for when stewardship is the concern, and all of them use these nouns.
 *
 * So the patterns are anchored on the organization, not the topic:
 *   - an institutional BODY (a committee, a consortium, a working group) is an organization by
 *     definition, so founding or joining one is out of scope whatever it is called;
 *   - a governance MODEL/STRUCTURE/FRAMEWORK is a document until it is qualified as
 *     independent of the current maintainers, so only the independence marker makes it one;
 *   - "foundation" carries a common metaphor ("a solid foundation for the test suite"), so it
 *     is matched only behind a curated organizational qualifier.
 *
 * Verb-to-object distance is bounded at a few words of the same clause rather than left open,
 * so an action that legitimately mentions a committee elsewhere in the sentence ("add a CI
 * check and send the result to the review committee") cannot be matched across it.
 */

/** Filler between a verb and its object: whole words only, so a comma breaks the chain. */
const WORDS = (max: number) => String.raw`(?:\s+[\w'’/&-]+){0,${max}}\s+`;

/** Founding an organization — the verbs that bring one into existence. */
const FOUNDING_VERBS = String.raw`(?:creat(?:e|ing)|establish(?:ing)?|form(?:ing)?|found(?:ing)?|institut(?:e|ing)|sett?(?:ing)?\s+up|stand(?:ing)?\s+up|launch(?:ing)?|incorporat(?:e|ing)|spin(?:ning)?\s+(?:out|off))`;

/** Entering an organization that already exists — equally outside a maintainer's own power. */
const JOINING_VERBS = String.raw`(?:join(?:ing)?|affiliat(?:e|ing)\s+with|appl(?:y|ying)\s+to|partner(?:ing)?\s+with)`;

/**
 * Bodies that ARE organizations, with no ordinary metaphorical use. "board" and "committee"
 * appear only in compounds ("oversight board", "steering committee") so a project's own
 * "issue board" or "review committee" is untouched.
 */
const INSTITUTIONAL_BODY = String.raw`(?:consortium|steering\s+committee|technical\s+committee|advisory\s+(?:board|committee)|oversight\s+(?:board|body|committee)|governance\s+(?:board|body|committee)|working\s+group|standards\s+body|trade\s+association|non-?profit(?:\s+(?:organization|organisation|entity))?)`;

/** What turns a governance document into a separate institution. */
const INDEPENDENCE_MARKER = String.raw`(?:independent|independently|neutral|vendor-neutral|third-party|external|separate|autonomous|community-run|foundation-backed)`;

const BEYOND_MAINTAINER_SCOPE_PATTERNS: RegExp[] = [
  // Founding or joining an institutional body: "form a research consortium", "join a
  // recognized aerospace working group".
  new RegExp(String.raw`\b(?:${FOUNDING_VERBS}|${JOINING_VERBS})\b${WORDS(6)}${INSTITUTIONAL_BODY}\b`, 'i'),
  // Founding a governance structure that is independent of the current maintainers. Without
  // the marker this is a document the maintainer writes, which the contract encourages.
  new RegExp(
    String.raw`\b${FOUNDING_VERBS}\b${WORDS(4)}${INDEPENDENCE_MARKER}${WORDS(3)}` +
    String.raw`(?:governance|ownership|stewardship|maintainership)\s+(?:model|structure|framework|process)\b`,
    'i'
  ),
  // Founding a foundation. The qualifier list is curated so "create a solid foundation for the
  // test suite" — the metaphor — stays out of reach.
  new RegExp(
    String.raw`\b${FOUNDING_VERBS}\s+(?:a|an|the)?\s*` +
    String.raw`(?:(?:new|independent|neutral|vendor-neutral|nonprofit|non-profit|open|open-source|community-led|community|software|charitable|umbrella)\s+){0,3}foundation\b`,
    'i'
  ),
  // Transferring the project to an institution: "transfer the runtime to a neutral foundation".
  new RegExp(
    String.raw`\b(?:transfer(?:ring)?|donat(?:e|ing)|hand(?:ing)?\s+(?:over|off)|migrat(?:e|ing)|mov(?:e|ing)|contribut(?:e|ing)|relinquish(?:ing)?)\b[^.;]*?\b(?:to|into)\s+(?:a|an|the)\s+(?:[\w-]+\s+){0,2}?(?:foundation|consortium|steering\s+committee|governance\s+body|nonprofit|non-profit)\b`,
    'i'
  ),
  // Landing an external institution's money: "secure corporate sponsorship". Setting up a
  // sponsors page is a maintainer's own next step and uses none of these verbs.
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
 * The documents-the-problem warning (issue #114): a judge whose concern is user-facing
 * friction answering it with a document that teaches users to endure that friction. Three of
 * the fourteen 4.6.0 records did this, every one of them Lisa: "cognitive load of
 * terminal-centric developer setup commands" answered with a troubleshooting walkthrough
 * guide (HermesOffice, 08-15), a missing in-product refinement loop answered with a guidance
 * document for manual sub-prompts (08-20), and theme layout glitches answered with documented
 * workarounds (08-23). Dated records here and below live in the private JuryPress-content
 * repository as data/generations/season-2-<date>-daily.json; the concern/action texts they
 * contributed are carried verbatim in tests/unit/editorial-recommendations.test.ts.
 *
 * Both lexicons are deliberately narrow — precision over recall, because a warning that cries
 * wolf gets ignored. FRICTION_CONCERN_TERMS is the vocabulary the three regressions and the
 * 4.7.0 prompt rule actually use for user-facing friction; broader hardship words ("fragile",
 * "complexity", "impractical") stay out because the corpus shows documents legitimately
 * answering them (a private-proxy configuration guide for fragile external dependencies,
 * 08-26). DOCUMENT_DELIVERABLE_TERMS names document artifacts that teach; the bare noun
 * "document" is absent on purpose, because the corpus's legitimate first steps are full of
 * it — policy documents, roadmap documents, migration documents — and those are exactly the
 * artifacts the maintainer-scope rule tells judges to recommend.
 *
 * The carve-out: when the concern's own subject is missing documentation — absent
 * troubleshooting tips, an undocumented migration path — a document IS the product-side fix
 * (08-25: "error responses ... lack descriptive troubleshooting tips" answered with a
 * troubleshooting guide), so no warning fires. The carve-out only ever suppresses, so a term
 * that matches over-broadly costs recall, never a false report.
 *
 * Two lookbehinds come from scanning the whole archive, not just the 4.6.0 window: "to guide
 * users" is the verb, not the artifact (a 4.0.0 minio action recommending in-product
 * tooltips), and an "interactive walkthrough" is a product flow, not a document (the 08-10
 * startup-routine walkthrough). Both are exactly what a compliant Lisa writes once the 4.7.0
 * rule pushes her toward the product, so flagging them would punish compliance. The archive
 * scan's sixth hit — the 08-12 README troubleshooting section for a driver-hunting concern —
 * is a true instance of the pattern on a record the version gate keeps unjudged.
 */
const FRICTION_CONCERN_TERMS: RegExp[] = [
  /\bfriction\b/i,
  /\bcognitive load\b/i,
  /\bmanual(?:ly)?\b/i,
  /\bglitch(?:es|y)?\b/i,
  /\bconfus(?:ing|ion|ed)\b/i,
  /\bcumbersome\b/i,
  /\btedious\b/i,
  /\bburden(?:some)?\b/i
];

const DOCUMENT_DELIVERABLE_TERMS: RegExp[] = [
  /\b(?<!to )guides?\b/i,
  /\b(?<!interactive )walkthroughs?\b/i,
  /\btutorials?\b/i,
  /\bfaqs?\b/i,
  /\bhow-to\b/i,
  // "workaround" alone also names a code intervention ("implement a compatibility
  // workaround"), so it counts as a document only under a documenting verb in the same
  // clause. The capture group is what gets reported.
  /\b(?:document(?:ing|ed)?|writ(?:e|ing)|draft(?:ing)?|list(?:ing)?)\b[^.;]*?\b(workarounds?)\b/i,
  /\btroubleshooting\b/i,
  /\bguidance\b/i
];

/** A concern about documentation itself: a document is then the fix, not the dodge. */
const CONCERN_IS_ABOUT_DOCS_TERMS: RegExp[] = [
  /\bdocument(?:ation|ed)?s?\b/i,
  /\bundocumented\b/i,
  /\bdocs\b/i,
  /\breadme\b/i,
  /\bguides?\b/i,
  /\bguidance\b/i,
  /\btutorials?\b/i,
  /\bwalkthroughs?\b/i,
  /\btroubleshooting\b/i,
  /\btips\b/i,
  /\binstructions\b/i
];

function firstMatch(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = (text || '').match(pattern);
    if (match) return match[1] ?? match[0];
  }
  return null;
}

/**
 * Exposed for tests: the friction term and document term that pair a concern with a
 * documenting action, or null when the pair is not the documents-the-problem pattern.
 */
export function documentsTheProblemMatch(
  primaryConcern: string,
  action: string
): { frictionTerm: string; documentTerm: string } | null {
  const frictionTerm = firstMatch(primaryConcern, FRICTION_CONCERN_TERMS);
  if (!frictionTerm) return null;
  if (firstMatch(primaryConcern, CONCERN_IS_ABOUT_DOCS_TERMS)) return null;
  const documentTerm = firstMatch(action, DOCUMENT_DELIVERABLE_TERMS);
  if (!documentTerm) return null;
  return { frictionTerm, documentTerm };
}

/**
 * The oversized-scope-expansion warning (issue #137): a judge's next step commanding a change
 * of distribution surface, ecosystem, or market outright, with no validation artifact in
 * front of it. The pound0423 record (2026-08-29, the first 4.7.0 regression) did this three
 * times in one article — Alex deploying a web-based playground for an installation-friction
 * concern, Sarah institutionalizing new drama genres for a missing-guidelines concern on a
 * project the same article praises for its narrow focus, Marcus migrating to the LangChain
 * ecosystem for a desktop-dependency concern — three personas converging on one solution
 * class: a bigger distribution surface.
 *
 * Each class is anchored on a verb committing to the expansion plus the expansion's own noun,
 * never on the vocabulary alone, because the archive is full of legitimate uses of these
 * words. Calibrated over all 285 archived recommendations (every editorial record through
 * 2026-08-29): the three regressions match, nothing else does. The near misses that shaped
 * the anchors:
 *   - "web-based" (and SaaS/hosted/cloud/enterprise-tier nouns) is the surface marker, not
 *     "browser" or "web" alone — a web-native project's "zero-install interactive browser
 *     playground" (Bonsai, 08-xx 4.4.0) is a demo inside the project's own medium, and an
 *     assistant "inside the web interface" (4.7.0) improves a surface that already exists;
 *   - the ecosystem class needs a committing verb directly on an "... ecosystem" object —
 *     "draft a standard ecosystem integration document" (4.5.0) is the first-step artifact
 *     this contract asks for, and stays out of reach because "draft" commits to a document,
 *     not a migration;
 *   - the market class needs (new|additional|more) between verb and market noun, so adding
 *     "multi-language AST parsing tests" or expanding "support to Linux environments" —
 *     feature work inside the current scope — never matches.
 *
 * The carve-out: an action that names a minimal proving artifact — a prototype, a fixture, a
 * benchmark, an RFC, an example PR, a test — IS the validation-first step the 4.8.0 rule asks
 * for, even when it names the expansion as the direction being tested ("... before adding new
 * drama genres"). Like the documents-the-problem carve-out above, it only ever suppresses, so
 * a term that matches over-broadly costs recall, never a false report. That is also why this
 * is a warning and never an error: legitimate expansion recommendations exist, the lexicons
 * are curated, and a signal that cries wolf gets ignored.
 */
const EXPANSION_BUILD_VERBS = String.raw`(?:deploy(?:ing)?|build(?:ing)?|creat(?:e|ing)|launch(?:ing)?|ship(?:ping)?|releas(?:e|ing)|develop(?:ing)?|host(?:ing)?|offer(?:ing)?|publish(?:ing)?|provid(?:e|ing)|stand(?:ing)?\s+up|convert(?:ing)?|turn(?:ing)?)`;

/**
 * Surfaces a project is not on today. "web UI", "web interface" and bare "browser"/"web" are
 * deliberately absent: they name surfaces the corpus shows projects already having.
 */
const NEW_DISTRIBUTION_SURFACE = String.raw`(?:web-based|web\s+(?:app|application|version)|browser-based|saas|software-as-a-service|hosted\s+(?:service|version|platform)|cloud(?:-hosted)?\s+(?:version|service|platform|offering)|online\s+platform|enterprise\s+(?:edition|tier|offering|version|plan))`;

/** Verbs that commit the project to another ecosystem, rather than describing or documenting one. */
const ECOSYSTEM_COMMITMENT_VERBS = String.raw`(?:support(?:ing)?|target(?:ing)?|adopt(?:ing)?|embrac(?:e|ing)|integrat(?:e|ing)\s+with|migrat(?:e|ing)|port(?:ing)?|rewrit(?:e|ing)|re-?platform(?:ing)?)`;

const MARKET_EXPANSION_VERBS = String.raw`(?:add(?:ing)?|introduc(?:e|ing)|expand(?:ing)?|extend(?:ing)?|support(?:ing)?|open(?:ing)?|target(?:ing)?|enter(?:ing)?|pursu(?:e|ing)|onboard(?:ing)?)`;

const MARKET_NOUNS = String.raw`(?:genres?|markets?|verticals?|languages?|locales?|audiences?|geographies|user\s+segments?)`;

export type ScopeExpansionClass = 'distribution_surface' | 'ecosystem_migration' | 'market_expansion';

const SCOPE_EXPANSION_CLASSES: { expansionClass: ScopeExpansionClass; pattern: RegExp }[] = [
  // Standing up a distribution surface the project does not have: "Deploy a web-based
  // playground", "offer an enterprise tier", "launch a SaaS version".
  {
    expansionClass: 'distribution_surface',
    pattern: new RegExp(String.raw`\b${EXPANSION_BUILD_VERBS}\b${WORDS(4)}${NEW_DISTRIBUTION_SURFACE}\b`, 'i')
  },
  // Committing to another ecosystem: "support the LangChain ecosystem", "migrate to the X
  // ecosystem". Anchored on the noun "ecosystem" itself — a named framework alone is
  // unmatchable without guessing, and the regression says "ecosystem" in as many words.
  {
    expansionClass: 'ecosystem_migration',
    pattern: new RegExp(
      String.raw`\b${ECOSYSTEM_COMMITMENT_VERBS}\b${WORDS(4)}(?:the\s+)?[\w.-]+(?:\s+[\w.-]+){0,2}\s+ecosystem\b`,
      'i'
    )
  },
  // Opening a market the project does not serve: "adding new drama genres", "expand into
  // additional markets". The (new|additional|more) qualifier is what separates expansion
  // from feature work on the audiences already served.
  {
    expansionClass: 'market_expansion',
    pattern: new RegExp(
      String.raw`\b${MARKET_EXPANSION_VERBS}\b${WORDS(3)}(?:new|additional|more)\s+(?:[\w-]+\s+){0,2}${MARKET_NOUNS}\b`,
      'i'
    )
  }
];

/**
 * The minimal proving artifacts the 4.8.0 rule names. An action carrying one of these is
 * validating the direction rather than committing to it, whatever else the sentence says.
 */
const VALIDATION_FIRST_TERMS: RegExp[] = [
  /\bprototypes?\b/i,
  /\bproof[-\s]of[-\s]concept\b/i,
  /\bspikes?\b/i,
  /\bpilots?\b/i,
  /\bexperiments?\b/i,
  /\bbenchmark(?:s|ing)?\b/i,
  /\bfixtures?\b/i,
  /\brfcs?\b/i,
  /\bexample\s+(?:pr|pull\s+request)s?\b/i,
  /\bchecklists?\b/i,
  /\bdry[-\s]runs?\b/i,
  /\bmock-?ups?\b/i,
  /\bsurveys?\b/i,
  /\btest(?:s|ing)?\b/i,
  /\bcanary\b/i
];

/**
 * Exposed for tests: the clause that commits the action to a scope expansion and which class
 * it belongs to, or null when the action either commands no expansion or already names the
 * proving artifact the rule asks to see first.
 */
export function oversizedScopeExpansionMatch(
  action: string
): { expansionTerm: string; expansionClass: ScopeExpansionClass } | null {
  for (const { expansionClass, pattern } of SCOPE_EXPANSION_CLASSES) {
    const match = (action || '').match(pattern);
    if (!match) continue;
    if (firstMatch(action, VALIDATION_FIRST_TERMS)) return null;
    return { expansionTerm: match[0], expansionClass };
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
export function collectEditorialRecommendationFindings(
  content: any,
  promptVersion?: string | null
): QualityFinding[] {
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

    actionStems[judgeIndex] = meaningfulStems(action);
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

    // The prompt's echo rule, enforced exactly as the prompt states it.
    const concernTokens = meaningfulTokens(primaryConcern);
    const actionTokens = meaningfulTokens(action);
    if (![...actionTokens].some(token => concernTokens.has(token))) {
      findings.push(error(
        'RECOMMENDATION_CONCERN_ECHO_MISSING',
        `${base}.recommended_next_step.action`,
        `The recommended action reuses no word from judge ${judgeName}'s primary concern, so it does not ` +
        `visibly address it. The contract requires at least one concrete word (4+ characters) from ` +
        `concerns[0] verbatim in the action.`
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
    if (designInterventionContractApplies(promptVersion)) {
      const documentsMatch = documentsTheProblemMatch(primaryConcern, action);
      if (documentsMatch) {
        findings.push(warning(
          'RECOMMENDATION_DOCUMENTS_THE_PROBLEM',
          `${base}.recommended_next_step.action`,
          `Judge ${judgeName}'s concern names user-facing friction ("${documentsMatch.frictionTerm}") and the ` +
          `action answers it with a document ("${documentsMatch.documentTerm}") that teaches users to endure ` +
          `that friction instead of reducing it in the product. The contract asks for the product-side ` +
          `intervention; a document is the right step only when the missing document is itself the concern.`
        ));
      }
    }
    if (scopeValidationContractApplies(promptVersion)) {
      const expansion = oversizedScopeExpansionMatch(action);
      if (expansion) {
        findings.push(warning(
          'RECOMMENDATION_OVERSIZED_SCOPE_EXPANSION',
          `${base}.recommended_next_step.action`,
          `Judge ${judgeName}'s action jumps to a scope expansion ("${expansion.expansionTerm}") as the next ` +
          `step, with no validation artifact in front of it. The contract asks for the smaller proving step ` +
          `first — a test, a fixture, a benchmark, an RFC, a minimal prototype — and for keeping the current ` +
          `scope as a live option until the evidence shows demand for the expansion.`
        ));
      }
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
