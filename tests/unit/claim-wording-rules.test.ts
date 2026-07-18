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

describe('meta_description is a full coverage field', () => {
  const evaluation = { article: { meta_description: 'This article evaluates the product.', headline: 'A headline.' } };
  it('is present in the COVERAGE view (claims in it need provenance)', () => {
    expect(coverageTextFields(evaluation).some(f => f.path === 'article.meta_description')).toBe(true);
  });
  it('is present in the SCANNABLE view', () => {
    expect(scannableTextFields(evaluation).some(f => f.path === 'article.meta_description')).toBe(true);
  });
});

// --- narrow, content-based wording exemption -------------------------------------------------

function evidence(id: string, factClass: Evidence['claims'][number]['claim_type']): Evidence {
  return {
    evidence_id: id, type: 'source_file', url: 'https://raw.githubusercontent.com/o/r/main/x',
    title: 't', retrieved_at: '2026-07-18T00:00:00.000Z', content_hash: 'h', summary: 's',
    claims: [{ text: 'c', claim_type: factClass }]
  };
}

describe('wording exemption — path AND content predicate, never path alone', () => {
  // A repository_observation needs no in-statement attribution, isolating the wording rule.
  const evidenceById = new Map([['ev1', evidence('ev1', 'repository_observation')]]);

  function findingsFor(evaluation: any): string[] {
    const sink: any[] = [];
    buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, sink);
    return sink.map(f => `${f.code} ${f.path}`);
  }

  it('waives absence wording on the "The jury disagreed …" framing sentence only', () => {
    const evaluation = {
      article: { where_jury_disagreed: [{ summary: 'The jury disagreed on onboarding friction.' }] },
      public_statement_annotations: [
        { public_output_path: 'article.where_jury_disagreed.0.summary', statement_text: 'The jury disagreed on onboarding friction.', support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    expect(findingsFor(evaluation)).toEqual([]);
  });

  it('does NOT waive a product assertion sitting in the disagreement-framing slot', () => {
    const evaluation = {
      article: { where_jury_disagreed: [{ summary: 'The product is fully secure.' }] },
      public_statement_annotations: [
        { public_output_path: 'article.where_jury_disagreed.0.summary', statement_text: 'The product is fully secure.', support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    expect(findingsFor(evaluation).some(f => f.startsWith('CLAIM_ABSENCE_WORDING_MISSING'))).toBe(true);
  });

  it('waives calibration wording on a genuinely prescriptive recommended action only', () => {
    const evaluation = {
      article: {},
      judges: [{ recommended_next_step: { action: 'The maintainers should add a sustainability report.' } }],
      public_statement_annotations: [
        { public_output_path: 'judges.0.recommended_next_step.action', statement_text: 'The maintainers should add a sustainability report.', support_mode: 'inference', evidence_ids: ['ev1'] }
      ]
    };
    expect(findingsFor(evaluation)).toEqual([]);
  });

  it('does NOT waive a product assertion sitting in the recommended-action slot', () => {
    const evaluation = {
      article: {},
      judges: [{ recommended_next_step: { action: 'The product is fully secure.' } }],
      public_statement_annotations: [
        { public_output_path: 'judges.0.recommended_next_step.action', statement_text: 'The product is fully secure.', support_mode: 'inference', evidence_ids: ['ev1'] }
      ]
    };
    expect(findingsFor(evaluation).some(f => f.startsWith('CLAIM_CALIBRATION_WORDING_MISSING'))).toBe(true);
  });

  it('waives wording on an editorial-process meta_description sentence only', () => {
    const evaluation = {
      article: { meta_description: 'This article provides an evaluation of the product. The jury evaluated the curriculum.' },
      public_statement_annotations: [
        { public_output_path: 'article.meta_description', statement_text: 'This article provides an evaluation of the product.', support_mode: 'unverified', evidence_ids: [] },
        { public_output_path: 'article.meta_description', statement_text: 'The jury evaluated the curriculum.', support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    expect(findingsFor(evaluation)).toEqual([]);
  });

  it('does NOT waive a product assertion in meta_description — wording still required', () => {
    const evaluation = {
      article: { meta_description: 'The product is fully secure.' },
      public_statement_annotations: [
        { public_output_path: 'article.meta_description', statement_text: 'The product is fully secure.', support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    expect(findingsFor(evaluation).some(f => f.startsWith('CLAIM_ABSENCE_WORDING_MISSING'))).toBe(true);
  });

  it('a meta_description claim without ANY provenance annotation fails closed (coverage)', () => {
    const evaluation = {
      article: { meta_description: 'The product is fully secure.' },
      public_statement_annotations: []
    };
    expect(() => buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, []))
      .toThrow(/has no evidence-backed provenance annotation/i);
  });

  it('a process-verb-of-FINDING in meta_description is not treated as process wording', () => {
    // "The jury verified/confirmed X" asserts an outcome, not a process — stays subject to wording.
    const evaluation = {
      article: { meta_description: 'The jury verified the platform is fully secure.' },
      public_statement_annotations: [
        { public_output_path: 'article.meta_description', statement_text: 'The jury verified the platform is fully secure.', support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    expect(findingsFor(evaluation).some(f => f.startsWith('CLAIM_ABSENCE_WORDING_MISSING'))).toBe(true);
  });

  it.each([
    ['This article proves the product is fully secure.'],
    ['This review confirms the project has no vulnerabilities.'],
    ['The jury evaluated the product as fully secure.']
  ])('does NOT waive an assertion dressed in editorial framing: %s', (statement) => {
    // "This article/review" needs a process verb AND an evaluation noun; "The jury <verb>"
    // must not carry an "… as <verdict>" complement. None of these qualify.
    const evaluation = {
      article: { meta_description: statement },
      public_statement_annotations: [
        { public_output_path: 'article.meta_description', statement_text: statement, support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    expect(findingsFor(evaluation).some(f => f.startsWith('CLAIM_ABSENCE_WORDING_MISSING'))).toBe(true);
  });

  it('still waives the real FreeCodeCamp meta_description sentences', () => {
    const s1 = 'This article provides an evaluation of FreeCodeCamp based on its open learning platform codebase and documentation.';
    const s2 = 'The jury evaluated the interactive curriculum, monorepo architecture, and community adoption metrics.';
    const evaluation = {
      article: { meta_description: `${s1} ${s2}` },
      public_statement_annotations: [
        { public_output_path: 'article.meta_description', statement_text: s1, support_mode: 'unverified', evidence_ids: [] },
        { public_output_path: 'article.meta_description', statement_text: s2, support_mode: 'unverified', evidence_ids: [] }
      ]
    };
    expect(findingsFor(evaluation)).toEqual([]);
  });
});
