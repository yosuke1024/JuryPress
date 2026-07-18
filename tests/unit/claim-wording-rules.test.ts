import { describe, it, expect } from 'vitest';
import {
  INFERENCE_PATTERN,
  UNVERIFIED_PATTERN,
  coverageTextFields,
  scannableTextFields,
  buildTrustedClaimReferences,
  EMPTY_PROTECTED_TOKENS
} from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';

describe('INFERENCE_PATTERN — calibrated inference wording', () => {
  it('recognizes the present participle "suggesting" (the common emitted form)', () => {
    expect(INFERENCE_PATTERN.test('…, suggesting a highly sustainable ecosystem.')).toBe(true);
    expect(INFERENCE_PATTERN.test('The package.json suggests active tooling.')).toBe(true);
    expect(INFERENCE_PATTERN.test('The jury inferred a modular structure.')).toBe(true);
  });
  it('still rejects a bare unhedged assertion', () => {
    expect(INFERENCE_PATTERN.test('The project is fully secure and production ready.')).toBe(false);
  });
});

describe('UNVERIFIED_PATTERN — absence/uncertainty wording', () => {
  it('recognizes the full "does/did not <verb>" absence family', () => {
    for (const verb of ['contain', 'provide', 'include', 'outline', 'specify', 'document', 'detail', 'mention', 'list']) {
      expect(UNVERIFIED_PATTERN.test(`The available evidence does not ${verb} a setup guide.`), verb).toBe(true);
    }
    expect(UNVERIFIED_PATTERN.test('The evidence could not verify the claim.')).toBe(true);
  });
  it('still rejects an unhedged claim with no absence wording', () => {
    expect(UNVERIFIED_PATTERN.test('The tool is the best learning platform available.')).toBe(false);
  });
});

describe('meta_description is scanned but not claim-covered', () => {
  const evaluation = { article: { meta_description: 'This article evaluates the product.', headline: 'A headline.' } };
  it('is absent from the COVERAGE view', () => {
    expect(coverageTextFields(evaluation).some(f => f.path === 'article.meta_description')).toBe(false);
  });
  it('is present in the SCANNABLE view (metadata-number / leak scans still see it)', () => {
    expect(scannableTextFields(evaluation).some(f => f.path === 'article.meta_description')).toBe(true);
  });
});

// --- field-class wording exemption, exercised through the real reference builder --------------

function evidence(id: string, factClass: Evidence['claims'][number]['claim_type']): Evidence {
  return {
    evidence_id: id, type: 'source_file', url: 'https://raw.githubusercontent.com/o/r/main/x',
    title: 't', retrieved_at: '2026-07-18T00:00:00.000Z', content_hash: 'h', summary: 's',
    claims: [{ text: 'c', claim_type: factClass }]
  };
}

describe('wording-calibration exemption for non-claim fields', () => {
  // A repository_observation needs no in-statement attribution, isolating the wording rule.
  const evidenceById = new Map([['ev1', evidence('ev1', 'repository_observation')]]);

  function findingsFor(evaluation: any): string[] {
    const sink: any[] = [];
    buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, sink);
    return sink.map(f => `${f.code} ${f.path}`);
  }

  it('waives absence wording on the jury-disagreement framing sentence, but NOT on a body claim', () => {
    const evaluation = {
      article: {
        where_jury_disagreed: [{ summary: 'The jury disagreed on onboarding friction.' }],
        final_verdict: 'The platform is the best tool available.'
      },
      public_statement_annotations: [
        { public_output_path: 'article.where_jury_disagreed.0.summary', statement_text: 'The jury disagreed on onboarding friction.', support_mode: 'unverified', evidence_ids: [] },
        { public_output_path: 'article.final_verdict', statement_text: 'The platform is the best tool available.', support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    const findings = findingsFor(evaluation);
    // Exempt field: no wording finding.
    expect(findings.some(f => f.includes('where_jury_disagreed'))).toBe(false);
    // Non-exempt field: absence wording still required — the gate is not weakened.
    expect(findings.some(f => f.startsWith('CLAIM_ABSENCE_WORDING_MISSING') && f.includes('final_verdict'))).toBe(true);
  });

  it('waives calibration wording on a recommended action', () => {
    const evaluation = {
      article: {},
      judges: [{ recommended_next_step: { action: 'The maintainers should add a sustainability report.' } }],
      public_statement_annotations: [
        { public_output_path: 'judges.0.recommended_next_step.action', statement_text: 'The maintainers should add a sustainability report.', support_mode: 'inference', evidence_ids: ['ev1'] }
      ]
    };
    expect(findingsFor(evaluation).some(f => f.includes('recommended_next_step'))).toBe(false);
  });
});
