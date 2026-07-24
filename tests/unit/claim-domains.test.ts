import { describe, it, expect } from 'vitest';
import {
  CLAIM_DOMAINS,
  assessClaimEvidenceReach,
  domainsForSourcePath,
  repoRelativePathFromRawUrl
} from '../../src/lib/evidence/claim-domains';
import { pickTargetedSourceFiles } from '../../src/lib/evidence/source-detection';

/**
 * The issue-74 invariant: whether the collected evidence reaches a severe-claim domain must
 * be decidable, deterministically, from the bundle alone — so the prompt, the confidence
 * policy and the published page all answer "did the jury examine the implementation this
 * claim is about?" identically.
 */

function sourceEvidence(id: string, path: string, summary = 'export const x = 1;') {
  return {
    evidence_id: id,
    type: 'source_code',
    url: `https://raw.githubusercontent.com/example/product/main/${path}`,
    title: `Core Source File (${path.slice(path.lastIndexOf('/') + 1)})`,
    retrieved_at: '2026-07-24T00:00:00.000Z',
    content_hash: `hash-${id}`,
    summary,
    claims: []
  } as any;
}

describe('repoRelativePathFromRawUrl', () => {
  it('extracts the repository-relative path from a raw.githubusercontent URL', () => {
    expect(repoRelativePathFromRawUrl('https://raw.githubusercontent.com/o/r/main/src/db/writer.rs'))
      .toBe('src/db/writer.rs');
  });

  it('returns null for non-raw hosts and malformed paths', () => {
    expect(repoRelativePathFromRawUrl('https://github.com/o/r/blob/main/src/a.ts')).toBeNull();
    expect(repoRelativePathFromRawUrl('https://raw.githubusercontent.com/o/r')).toBeNull();
    expect(repoRelativePathFromRawUrl('not a url')).toBeNull();
  });
});

describe('domainsForSourcePath', () => {
  it('recognises execution-security paths', () => {
    expect(domainsForSourcePath('src/sandbox/runner.rs')).toContain('execution_security');
    expect(domainsForSourcePath('crates/core/src/agent_executor.rs')).toContain('execution_security');
    expect(domainsForSourcePath('lib/oauth.ts')).toContain('execution_security');
  });

  it('recognises data-write-safety paths, including a bare db segment', () => {
    expect(domainsForSourcePath('src/db/connection.py')).toContain('data_write_safety');
    expect(domainsForSourcePath('internal/warehouse/query.go')).toContain('data_write_safety');
  });

  it('recognises cost-control and reliability paths', () => {
    expect(domainsForSourcePath('src/cost_tracker.py')).toContain('resource_cost_control');
    expect(domainsForSourcePath('src/rate_limiter.go')).toContain('resource_cost_control');
    expect(domainsForSourcePath('pkg/retry/backoff.go')).toContain('production_reliability');
  });

  it('does not match risk tokens buried inside ordinary words', () => {
    // "delimiter" contains "limit"; "author" contains "auth". Boundary guards keep both out.
    expect(domainsForSourcePath('src/parser/delimiter.rs')).toEqual([]);
    expect(domainsForSourcePath('src/authors.ts')).toEqual([]);
  });

  it('leaves an ordinary entry point in no domain', () => {
    expect(domainsForSourcePath('src/main.rs')).toEqual([]);
    expect(domainsForSourcePath('src/index.ts')).toEqual([]);
  });
});

describe('assessClaimEvidenceReach', () => {
  it('marks a domain examined when a collected file path lives on its implementation path', () => {
    const reach = assessClaimEvidenceReach([
      sourceEvidence('ev-1', 'src/sandbox/executor.rs')
    ]);
    const exec = reach.domains.find(d => d.domain_id === 'execution_security')!;
    expect(exec.examined).toBe(true);
    expect(exec.evidence_ids).toEqual(['ev-1']);
    expect(exec.matched_files).toEqual(['src/sandbox/executor.rs']);
  });

  it('marks a domain examined when the collected content implements it, whatever the path', () => {
    const reach = assessClaimEvidenceReach([
      sourceEvidence('ev-1', 'src/engine.py', 'conn.autocommit = False\nrollback on failure')
    ]);
    expect(reach.domains.find(d => d.domain_id === 'data_write_safety')!.examined).toBe(true);
  });

  it('never grants reach from README or docs evidence — a described sandbox is a creator claim', () => {
    const reach = assessClaimEvidenceReach([
      {
        evidence_id: 'ev-readme',
        type: 'readme',
        url: 'https://raw.githubusercontent.com/example/product/main/README.md',
        title: 'README',
        retrieved_at: '2026-07-24T00:00:00.000Z',
        content_hash: 'h',
        summary: 'Runs every command in a sandbox with strict permission boundaries and rollback.',
        claims: []
      } as any
    ]);
    expect(reach.domains.every(d => !d.examined)).toBe(true);
  });

  it('reports all four domains unexamined for an entry-point-only sample', () => {
    // The CodeAlmanac shape: files were collected, none of them on the paths the severe
    // claims were about. The record must say so rather than leaving it to inference.
    const reach = assessClaimEvidenceReach([
      sourceEvidence('ev-1', 'src/main.ts'),
      sourceEvidence('ev-2', 'src/index.ts')
    ]);
    expect(reach.domains).toHaveLength(CLAIM_DOMAINS.length);
    expect(reach.domains.every(d => !d.examined)).toBe(true);
  });

  it('is deterministic and preserves bundle order in its evidence ids', () => {
    const bundle = [
      sourceEvidence('ev-1', 'src/db/reader.go'),
      sourceEvidence('ev-2', 'src/db/writer.go')
    ];
    const first = assessClaimEvidenceReach(bundle);
    expect(assessClaimEvidenceReach(bundle)).toEqual(first);
    expect(first.domains.find(d => d.domain_id === 'data_write_safety')!.evidence_ids)
      .toEqual(['ev-1', 'ev-2']);
  });
});

describe('pickTargetedSourceFiles', () => {
  const tree = [
    'src/main.rs',
    'src/lib.rs',
    'src/sandbox/executor.rs',
    'src/db/writer.rs',
    'src/cost/budget.rs',
    'src/retry/backoff.rs',
    'tests/sandbox_test.rs',
    'vendor/auth/other.rs'
  ];

  it('picks one file per domain, round-robin, skipping already-collected paths', () => {
    const picked = pickTargetedSourceFiles(tree, 2, new Set(['src/main.rs', 'src/lib.rs']));
    // Domain order: execution_security first, then data_write_safety.
    expect(picked).toEqual(['src/sandbox/executor.rs', 'src/db/writer.rs']);
  });

  it('never picks from excluded trees (tests, vendor)', () => {
    const picked = pickTargetedSourceFiles(tree, 8, new Set());
    expect(picked).not.toContain('tests/sandbox_test.rs');
    expect(picked).not.toContain('vendor/auth/other.rs');
  });

  it('returns nothing when no file matches any domain', () => {
    expect(pickTargetedSourceFiles(['src/main.rs', 'src/render.rs'], 2, new Set())).toEqual([]);
  });

  it('is deterministic', () => {
    expect(pickTargetedSourceFiles(tree, 3, new Set()))
      .toEqual(pickTargetedSourceFiles(tree, 3, new Set()));
  });
});
