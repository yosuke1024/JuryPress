import type { Evidence } from '../../schemas/evidence';

/**
 * Claim domains: the subjects of severe technical and security claims, and whether the
 * collected evidence actually reaches them.
 *
 * Two published reviews asserted, at verdict strength, things their evidence never touched:
 * one called background agent execution a security nightmare after examining 3 of 590 source
 * files — none of them on the execution path — and one promised reliable cost enforcement and
 * zero accidental writes from 3 of 59 files, none implementing either. The problem is not the
 * ratio; a review that read the three files that implement a claim may speak about it. The
 * problem is that nothing recorded WHICH implementation paths the review saw, so neither the
 * prompt, the confidence policy, nor the reader could tell a targeted reading from an
 * incidental one.
 *
 * This module is that record. Each domain names one class of severe claim and carries two
 * deliberately coarse matchers: a path pattern (does a collected file live on that
 * implementation path?) and a content pattern (does its collected text implement it?). They
 * are heuristics and stay heuristics — a match means "the review had material bearing on
 * this", never "the claim is true"; a miss means "a severe claim in this domain rests on
 * documentation or inference", never "the project lacks the protection". Consumers must
 * preserve that asymmetry: reach gates claim STRENGTH, not claim direction.
 *
 * Matching is a pure function of the evidence bundle, so generation, the confidence policy
 * and the published page all derive the same answer from the same collected material.
 */

export interface ClaimDomain {
  id: string;
  /** Reader- and prompt-facing name of the domain. */
  label: string;
  /** The kind of severe claim this domain governs, for the prompt. */
  claim_kinds: string;
  /** Matched against the lowercased repository-relative path of a collected file. */
  pathPattern: RegExp;
  /** Matched against the collected file content (the evidence summary). */
  contentPattern: RegExp;
}

/**
 * A token must start at a non-letter boundary ("(^|[^a-z])" in the patterns below): "limit"
 * must match rate_limit.py and limits.go but never delimiter.rs, and "exec" must match
 * src/executor.rs but not indexec... — short risk tokens are too common as substrings to
 * match bare.
 */
export const CLAIM_DOMAINS: readonly ClaimDomain[] = [
  {
    id: 'execution_security',
    label: 'execution & permission safety',
    claim_kinds: 'code or agent execution risk, sandboxing, permission boundaries, prompt-injection or supply-chain exposure, credential handling',
    pathPattern: /(^|[^a-z])(sandbox|security|permission|privileg|credential|secret|oauth|auth(?!or)|acl|exec|spawn|shell|subprocess|runner|agent|isolat)/,
    contentPattern: /(^|[^a-zA-Z])(sandbox|seccomp|chroot|subprocess|child_process|execve|spawn|shlex|allowlist|denylist|privileg|credential|api[_-]?key|oauth|permission)/i
  },
  {
    id: 'data_write_safety',
    label: 'data write safety',
    claim_kinds: 'destructive or accidental writes, read-only guarantees, transaction and rollback behaviour',
    pathPattern: /(^|[^a-z])(database|sql|postgres|mysql|sqlite|duckdb|snowflake|redshift|bigquery|warehouse|storage|persist|migrat|transaction|connection|writer|mutation)|(^|[^a-z])db([^a-z]|$)/,
    contentPattern: /(^|[^a-zA-Z])(read[_-]?only|readonly|autocommit|rollback|transaction|insert\s+into|delete\s+from|drop\s+table|dry[_-]?run|write[_-]?mode)/i
  },
  {
    id: 'resource_cost_control',
    label: 'cost & resource controls',
    claim_kinds: 'cost or quota enforcement, budget thresholds, rate limiting',
    pathPattern: /(^|[^a-z])(cost|budget|quota|billing|credit|throttl|limit)/,
    contentPattern: /(^|[^a-zA-Z])(costs?|budgets?|quotas?|billing|bytes[_-]?scanned|rate[_-]?limit\w*|throttl\w*|credits?)([^a-zA-Z]|$)/i
  },
  {
    id: 'production_reliability',
    label: 'production reliability',
    claim_kinds: 'production readiness, failure handling, recovery, concurrency behaviour at scale',
    pathPattern: /(^|[^a-z])(retry|backoff|timeout|resilien|recover|circuit|health|heartbeat|reconnect|pool|queue|worker|concurren|schedul)/,
    contentPattern: /(^|[^a-zA-Z])(retry|backoff|timeout|circuit[_-]?breaker|graceful|reconnect|connection[_-]?pool|health[_-]?check|idempoten)/i
  }
];

/** One domain's reach: whether any collected implementation evidence bears on it. */
export interface ClaimDomainReach {
  domain_id: string;
  label: string;
  examined: boolean;
  evidence_ids: string[];
  matched_files: string[];
}

export interface ClaimEvidenceReach {
  reach_version: '1.0.0';
  domains: ClaimDomainReach[];
}

/**
 * Evidence types that count as implementation evidence for reach purposes: the project's own
 * source, its tests, and its CI configuration. README/docs/discussion never grant reach — a
 * README describing a sandbox is a creator claim about one, which is the exact confusion this
 * module exists to keep out of verdict-strength claims.
 */
const IMPLEMENTATION_EVIDENCE_TYPES = new Set(['source_code', 'test_file', 'ci_workflow']);

/** The repository-relative path of a raw.githubusercontent.com evidence URL, or null. */
export function repoRelativePathFromRawUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.hostname !== 'raw.githubusercontent.com') return null;
    const segments = parsed.pathname.split('/').filter(Boolean);
    // /{owner}/{repo}/{branch}/{path...}
    if (segments.length < 4) return null;
    return segments.slice(3).join('/');
  } catch {
    return null;
  }
}

/** The claim domains whose path pattern a repository file path matches. */
export function domainsForSourcePath(path: string): string[] {
  const lower = path.toLowerCase();
  return CLAIM_DOMAINS.filter(d => d.pathPattern.test(lower)).map(d => d.id);
}

/**
 * Which claim domains the collected evidence reaches. Deterministic in the bundle order, so
 * the generation-time record, any later recomputation and every test agree byte for byte.
 */
export function assessClaimEvidenceReach(evidences: readonly Evidence[]): ClaimEvidenceReach {
  const domains = CLAIM_DOMAINS.map(domain => {
    const evidenceIds: string[] = [];
    const matchedFiles: string[] = [];
    for (const evidence of evidences) {
      if (!IMPLEMENTATION_EVIDENCE_TYPES.has(evidence.type)) continue;
      const path = repoRelativePathFromRawUrl(evidence.url);
      const pathHit = path !== null && domain.pathPattern.test(path.toLowerCase());
      const contentHit = domain.contentPattern.test(evidence.summary || '');
      if (pathHit || contentHit) {
        evidenceIds.push(evidence.evidence_id);
        matchedFiles.push(path ?? evidence.title);
      }
    }
    return {
      domain_id: domain.id,
      label: domain.label,
      examined: evidenceIds.length > 0,
      evidence_ids: evidenceIds,
      matched_files: matchedFiles
    };
  });
  return { reach_version: '1.0.0', domains };
}
