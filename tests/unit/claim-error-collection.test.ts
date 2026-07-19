import { describe, it, expect } from 'vitest';
import {
  buildTrustedClaimReferences,
  EMPTY_PROTECTED_TOKENS
} from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * Why this file exists.
 *
 * The claim builder aborted on the first provenance violation, so a failing record reported
 * exactly ONE defect however many it held — which is why six consecutive productions each
 * failed on a single rule, and fixing it merely surfaced the next. Measured on the stored
 * corpus, a record reporting one `CLAIM_MIXED_FACT_CLASSES` actually held ten.
 *
 * The fix is a severity split on the existing sink, NOT a relaxation: with no sink (the
 * publication gate, the generation-time builder) the first defect still throws; with a sink
 * (the quality validator) every defect is recorded as an error and the verdict is still
 * `failed`. These tests pin both halves.
 */

const evidences: Evidence[] = [{
  evidence_id: 'ev-readme',
  type: 'readme',
  url: 'https://example.invalid/readme',
  title: 'README',
  retrieved_at: '2026-07-16T00:00:00.000Z',
  content_hash: 'readme-hash',
  summary: 'The README describes the tool.',
  claims: [{ claim_id: 'ev-readme-default', text: 'The README describes the tool.', claim_type: 'creator_claim' }]
} as unknown as Evidence];

const evidenceById = new Map(evidences.map(e => [e.evidence_id, e]));

/** Three statements, none annotated — three independent provenance violations. */
const evaluation = {
  article: { final_verdict: 'First sentence. Second sentence. Third sentence.' },
  public_statement_annotations: []
};

describe('a failing record reports its complete defect set in one pass', () => {
  it('collects every uncovered statement, not just the first', () => {
    const sink: any[] = [];
    buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, sink);
    const errors = sink.filter(f => f.severity === 'error');
    expect(errors).toHaveLength(3);
    expect(new Set(errors.map(f => f.code))).toEqual(new Set(['CLAIM_PROVENANCE_MISSING']));
    // Each finding names its own statement, so all three are actionable together.
    expect(errors.map(f => f.path)).toEqual([
      '$.article.final_verdict statement 0',
      '$.article.final_verdict statement 1',
      '$.article.final_verdict statement 2'
    ]);
  });

  it('is fail-closed, not a downgrade — every collected provenance defect is an error', () => {
    const sink: any[] = [];
    buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, sink);
    expect(sink.every(f => f.severity === 'error')).toBe(true);
  });

  it('still aborts on the first defect when no sink is supplied (publication gate contract)', () => {
    expect(() => buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, undefined))
      .toThrow(/statement 0.*has no evidence-backed provenance annotation/i);
  });
});
