import type { Evidence } from '../../schemas/evidence';
import { buildProtectedTokens, segmentStatements } from './public-claims';

/**
 * Which statements the evidence map covers, and why the rest are deliberately outside it.
 *
 * The publication's purpose is a valuable review, not a complete audit. Mapping every
 * sentence — 138 of them on a typical article, most of which are per-judge scoring
 * commentary — costs several requests, degrades into truncation, and produces an appendix
 * nobody reads. Worse, it re-frames the product around the audit again.
 *
 * So the scope is deliberately two-tier:
 *
 *   TIER 1 — the reader-facing narrative. Everything a reader actually reads as the review's
 *   claims: the product summary, the headline and standfirst, the jury summary, the points of
 *   agreement and disagreement, the stated limitations, the verdict, the meta description, and
 *   each judge's verdict plus the concern they lead with. Always mapped, in full.
 *
 *   TIER 2 — risk-bearing specifics anywhere else. The remaining judge detail (criteria
 *   reasoning, secondary concerns, strengths, per-criterion limitations, recommended next
 *   step) is NOT mapped as prose. From it we extract only the statement classes that could
 *   actually harm someone if wrong: figures, claimed runtime/test results, security
 *   assertions, concrete technical composition, absence claims about a real project, and
 *   named-competitor feature claims. Selection is by CODE, not by the model — the model is
 *   never asked which of its own sentences deserve scrutiny.
 *
 * What is excluded is excluded on purpose and is stated to the reader (see the appendix note
 * in reviews/[slug].astro): general evaluative commentary inside per-criterion scoring is an
 * opinion about a score, and an opinion needs no evidence citation.
 */

export const MAPPING_SCOPE_VERSION = '1.0.0';

export interface ScopedStatement {
  /** Sequential id across the selection; the join key for model responses. */
  statementId: number;
  path: string;
  statementIndex: number;
  text: string;
  /** Why this statement is in scope — surfaced in the map for auditability. */
  tier: 'narrative' | 'risk_bearing';
}

export interface MappingSelection {
  statements: ScopedStatement[];
  /** Statements that exist in the article but are deliberately out of scope. */
  excludedStatementCount: number;
}

/** Tier-1 paths: the reader-facing narrative, always mapped in full. */
function narrativeFields(content: any): Array<{ path: string; text: string }> {
  const fields: Array<{ path: string; text: string }> = [];
  const push = (path: string, value: unknown) => {
    if (typeof value === 'string' && value.trim().length > 0) fields.push({ path, text: value });
  };

  push('product.summary', content.product?.summary);
  push('article.headline', content.article?.headline);
  push('article.standfirst', content.article?.standfirst);
  push('article.jury_summary', content.article?.jury_summary);
  content.article?.where_jury_agreed?.forEach((value: string, index: number) =>
    push(`article.where_jury_agreed.${index}`, value));
  content.article?.where_jury_disagreed?.forEach((entry: any, index: number) =>
    push(`article.where_jury_disagreed.${index}.summary`, entry?.summary));
  content.article?.evidence_limitations?.forEach((value: string, index: number) =>
    push(`article.evidence_limitations.${index}`, value));
  push('article.final_verdict', content.article?.final_verdict);
  push('article.meta_description', content.article?.meta_description);

  content.judges?.forEach((judge: any, judgeIndex: number) => {
    push(`judges.${judgeIndex}.verdict`, judge?.verdict);
    // The primary concern only — the one each judge leads with. Secondary concerns fall to
    // tier 2 and are picked up only if they carry a risk-bearing specific.
    push(`judges.${judgeIndex}.concerns.0`, judge?.concerns?.[0]);
  });

  return fields;
}

/** Tier-2 candidate paths: judge detail, scanned for risk-bearing specifics only. */
function detailFields(content: any): Array<{ path: string; text: string }> {
  const fields: Array<{ path: string; text: string }> = [];
  const push = (path: string, value: unknown) => {
    if (typeof value === 'string' && value.trim().length > 0) fields.push({ path, text: value });
  };

  content.judges?.forEach((judge: any, judgeIndex: number) => {
    judge?.strengths?.forEach((value: string, index: number) =>
      push(`judges.${judgeIndex}.strengths.${index}`, value));
    // concerns[0] is tier 1; the rest are candidates.
    judge?.concerns?.forEach((value: string, index: number) => {
      if (index === 0) return;
      push(`judges.${judgeIndex}.concerns.${index}`, value);
    });
    push(`judges.${judgeIndex}.recommended_next_step.action`, judge?.recommended_next_step?.action);
    judge?.criteria?.forEach((criterion: any, criterionIndex: number) => {
      push(`judges.${judgeIndex}.criteria.${criterionIndex}.reasoning`, criterion?.reasoning);
      criterion?.limitations?.forEach((value: string, index: number) =>
        push(`judges.${judgeIndex}.criteria.${criterionIndex}.limitations.${index}`, value));
    });
  });

  return fields;
}

/**
 * Risk classes. Each pattern targets a statement that could be materially wrong about a real,
 * named project — the cases where a mistake is checkable, screenshottable, and damaging.
 * General evaluative language ("the scope is coherent", "this is well judged") matches none of
 * them, which is the point.
 */
const RISK_PATTERNS: Array<{ risk: string; pattern: RegExp }> = [
  // Figures: any digit run that is not a bare rubric score reference.
  { risk: 'numeric_claim', pattern: /\b\d[\d,.]*\s*(?:%|k\b|m\b|stars?|forks?|issues?|commits?|contributors?|users?|downloads?|releases?|files?|lines?|tests?|ms\b|seconds?|minutes?|hours?|days?|weeks?|months?|years?|x\b)/i },
  // Claimed execution / verification outcomes.
  { risk: 'runtime_result', pattern: /\b(?:tests?|suite|ci|pipeline|build|benchmark)\s+(?:pass(?:es|ed|ing)?|fail(?:s|ed|ing)?|run(?:s|ning)?|green|red)\b|\b(?:passes|fails)\s+(?:all|its|the)\b|\bverified\s+(?:at\s+)?runtime\b|\bbenchmarked\s+at\b/i },
  // Security assertions in either direction.
  { risk: 'security_claim', pattern: /\b(?:secure|insecure|vulnerab\w*|exploit\w*|CVE-\d|injection|XSS|CSRF|SSRF|sandbox\w*|auth(?:entication|orization)?|credential\w*|token\w*|encrypt\w*|decrypt\w*|hash(?:ed|ing)?|TLS|SSL|HTTPS|sanitiz\w*|escap(?:e|ed|ing))\b/i },
  // Concrete technical composition: named files, named deps, named protocols/algorithms.
  { risk: 'technical_composition', pattern: /\b[\w-]+\.(?:html|htm|css|js|mjs|cjs|jsx|ts|tsx|py|rb|go|rs|java|kt|php|sh|json|jsonc|yaml|yml|toml|ini|cfg|conf|xml|sql|md|lock)\b|\b(?:AES|RSA|SHA-?\d|HMAC|JWT|OAuth|SAML|gRPC|GraphQL|WebSocket|Redis|Postgres\w*|MySQL|SQLite|MongoDB|Kafka|Docker|Kubernetes|Terraform)\b/i },
  // Absence claims about the project — the classic defamation-adjacent shape.
  { risk: 'absence_claim', pattern: /\b(?:no|not|never|without|lacks?|lacking|missing|absent|omits?|fails to (?:include|provide|ship|offer)|does(?:n't| not) (?:have|include|provide|ship|offer|support|implement))\b/i },
  // Named-competitor feature claims.
  { risk: 'competitor_claim', pattern: /\b(?:unlike|compared to|versus|vs\.?|competitors?|alternatives?|rivals?)\b|\b(?:better|worse|faster|slower|cheaper|safer)\s+than\b/i }
];

function riskFor(statement: string): string | null {
  for (const { risk, pattern } of RISK_PATTERNS) {
    if (pattern.test(statement)) return risk;
  }
  return null;
}

/** Exposed for tests and for the appendix copy — the human-readable risk vocabulary. */
export function classifyRisk(statement: string): string | null {
  return riskFor(statement);
}

/**
 * Selects the statements the evidence map should cover.
 *
 * Segmentation runs with editorial file-extension recognition on, so a review that names
 * `ui.html` maps that sentence whole instead of producing an "html file." fragment.
 */
export function selectStatementsForMapping(
  content: any,
  evidences: readonly Evidence[]
): MappingSelection {
  const tokens = buildProtectedTokens(evidences);
  const segment = (text: string) =>
    segmentStatements(text, tokens, { recognizeFileExtensions: true });

  const statements: ScopedStatement[] = [];
  let statementId = 0;
  let excludedStatementCount = 0;

  for (const field of narrativeFields(content)) {
    segment(field.text).forEach((text, statementIndex) => {
      statements.push({ statementId: statementId++, path: field.path, statementIndex, text, tier: 'narrative' });
    });
  }

  for (const field of detailFields(content)) {
    segment(field.text).forEach((text, statementIndex) => {
      if (riskFor(text) === null) {
        excludedStatementCount++;
        return;
      }
      statements.push({ statementId: statementId++, path: field.path, statementIndex, text, tier: 'risk_bearing' });
    });
  }

  return { statements, excludedStatementCount };
}
