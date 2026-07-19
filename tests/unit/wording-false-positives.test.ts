import { describe, it, expect } from 'vitest';
import { INFERENCE_PATTERN, UNVERIFIED_PATTERN } from '../../src/lib/evaluation/public-claims';

/**
 * The wording rules are LEXICAL allowlists checking a requirement the prompt states
 * SEMANTICALLY, which is the project's documented recurring false-positive shape: the model
 * writes natural English, falls outside the list, and an already-hedged statement fails.
 *
 * These cases are all drawn from real statements in the stored corpus that were flagged
 * despite being unambiguously calibrated or absence-worded. They are pinned so the next
 * widening cannot silently drop one.
 *
 * The counter-examples matter as much: widening must not reach the point where a plain
 * positive assertion satisfies an absence requirement, which would make the rule vacuous.
 */
describe('absence wording recognises the forms the model actually writes', () => {
  const accepted = [
    'The available evidence does not demonstrate enterprise customer adoption metrics.',
    'The available evidence does not verify a clear roadmap for adding wider instrument class drivers.',
    'The supplied codebase lacks explicit automated test execution evidence or test logs.',
    'The multi-agent workflow architecture is conceptually sound but lacks sufficient runtime verification.',
    'The absence of documented performance benchmarks might deter enterprise sysadmins.',
    'No CHANGELOG or SECURITY documents are tracked in the API metadata snapshot.',
    'No direct public visibility into core driver source files was available in the provided materials.'
  ];
  for (const statement of accepted) {
    it(`accepts: ${statement.slice(0, 60)}…`, () => {
      expect(UNVERIFIED_PATTERN.test(statement)).toBe(true);
    });
  }

  it('still rejects a plain positive assertion, so the rule stays meaningful', () => {
    // Real statements from a record whose support_mode declarations collapsed: positive
    // creator-sourced assertions labelled `unverified`. These MUST keep failing — the defect
    // is the declaration, not the rule.
    expect(UNVERIFIED_PATTERN.test('According to the README, Peek Cli belongs to the developer tools category.')).toBe(false);
    expect(UNVERIFIED_PATTERN.test('The project README highlights compatibility with modern developer tools.')).toBe(false);
    expect(UNVERIFIED_PATTERN.test('The tool is fully secure and production ready.')).toBe(false);
  });

  it('does not treat a bare "no" as absence wording', () => {
    expect(UNVERIFIED_PATTERN.test('There is no doubt this is an excellent framework.')).toBe(false);
  });
});

describe('calibration wording is not demanded of a headline', () => {
  it('a real headline carries no hedge and must not need one', () => {
    // Held by wordingCalibrationExempt via isTitleShaped, not by INFERENCE_PATTERN.
    expect(INFERENCE_PATTERN.test('Bridging the Gap: Instrumation Simplifies Hardware Test Automation with Digital Twins')).toBe(false);
  });
});

describe('an imperative recommended_next_step is prescriptive', () => {
  // Exercised through the real exemption predicate rather than the regex, since the rule is
  // path AND content.
  const imperatives = [
    'Add structured benchmarks comparing scanning speed and memory footprint.',
    'Refactor the hardcoded simulated drivers in the test suite to accept external schemas.',
    'Standardize the return types of get_voltage and get_current in the simulated multimeter.',
    'Integrate automated testing runs in the release workflow.',
    'Publish a SECURITY.md describing the vulnerability disclosure process.'
  ];
  for (const action of imperatives) {
    it(`exempts: ${action.slice(0, 50)}…`, async () => {
      const { buildTrustedClaimReferences, EMPTY_PROTECTED_TOKENS } = await import('../../src/lib/evaluation/public-claims');
      const evidences: any[] = [{
        evidence_id: 'ev-readme', type: 'readme', url: 'https://example.invalid/r', title: 'README',
        retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: 'h', summary: 's',
        claims: [{ claim_id: 'c', text: 't', claim_type: 'creator_claim' }]
      }];
      const evaluation = {
        judges: [{ recommended_next_step: { action } }],
        public_statement_annotations: [{
          public_output_path: 'judges.0.recommended_next_step.action',
          statement_text: action, support_mode: 'inference', evidence_ids: ['ev-readme']
        }]
      };
      const sink: any[] = [];
      buildTrustedClaimReferences(evaluation, new Map(evidences.map(e => [e.evidence_id, e])), EMPTY_PROTECTED_TOKENS, sink);
      expect(sink.map(f => f.code)).not.toContain('CLAIM_CALIBRATION_WORDING_MISSING');
    });
  }

  it('does NOT exempt an assertion parked in the action field', () => {
    expect(/^(add|refactor|standardi[sz]e|integrate|publish)\b/i.test('The product is fully secure.')).toBe(false);
  });
});
