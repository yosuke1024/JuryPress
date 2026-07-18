import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  buildTrustedClaimReferences,
  validateClaimReferences,
  EMPTY_PROTECTED_TOKENS,
  type TrustedClaimReference
} from '../../src/lib/evaluation/public-claims';
import { validateContent } from '../../src/lib/generation/validator';
import { createRecommendationFixture } from '../fixtures/refined-review';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * Adjacent-statement attribution inheritance (CLAIM_RULE_VERSION 2.1.0).
 *
 * A HEDGED inference may inherit creator/community attribution from the IMMEDIATELY
 * preceding statement of the same field when that statement explicitly attributes the same
 * (or a superset of the) cited evidence. Everything else — no attribution in the direct
 * predecessor, different evidence, an intervening statement, an unhedged follower, an
 * evidence_backed or unverified statement, mixed source voices — still fails closed, and it
 * fails IDENTICALLY on the generation side and at the publication gate: the two share one
 * predicate and attribution violations always throw, sink or no sink.
 */

function evidence(id: string, type: string, claimType: string): Evidence {
  return {
    evidence_id: id, type, url: `https://example.invalid/${id}`,
    title: id, retrieved_at: '2026-07-18T00:00:00.000Z', content_hash: `${id}-hash`, summary: 's',
    claims: [{ claim_id: `${id}-default`, text: 'c', claim_type: claimType }]
  } as unknown as Evidence;
}

const evidenceById = new Map<string, Evidence>([
  ['ev-readme', evidence('ev-readme', 'readme', 'creator_claim')],
  ['ev-doc', evidence('ev-doc', 'official_site', 'creator_claim')],
  ['ev-src', evidence('ev-src', 'source_code', 'repository_observation')],
  ['ev-disc', evidence('ev-disc', 'source_discussion', 'community_opinion')]
]);

type Ann = { text: string; support_mode: string; evidence_ids: string[] };

function evaluationWith(annotations: Ann[]) {
  return {
    article: { final_verdict: annotations.map(a => a.text).join(' ') },
    public_statement_annotations: annotations.map(a => ({
      public_output_path: 'article.final_verdict',
      statement_text: a.text,
      support_mode: a.support_mode,
      evidence_ids: a.evidence_ids
    }))
  };
}

function build(annotations: Ann[], sink?: any[]): TrustedClaimReference[] {
  return buildTrustedClaimReferences(evaluationWith(annotations), evidenceById, EMPTY_PROTECTED_TOKENS, sink);
}

const ATTRIBUTED_README = { text: 'According to the README, the project curates a large list of public APIs.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] };
const HEDGED_FOLLOWER = { text: 'The jury inferred that this community curation may keep the list relevant.', support_mode: 'inference', evidence_ids: ['ev-readme'] };

describe('adjacent-statement attribution inheritance — allowed shape', () => {
  it('accepts the production shape: "According to the README, X. The jury inferred that this X may Y."', () => {
    const sink: any[] = [];
    const references = build([ATTRIBUTED_README, HEDGED_FOLLOWER], sink);
    expect(references).toHaveLength(2);
    expect(sink).toEqual([]);
    // Condition 9: inheritance changes nothing about the derived provenance fields.
    const follower = references.find(r => r.statement_index === 1)!;
    expect(follower.support_mode).toBe('inference');
    expect(follower.fact_class).toBe('inference');
    expect(follower.attribution_required).toBe(true);
    expect(follower.source_fact_classes).toEqual(['creator_claim']);
    expect(follower.evidence_ids).toEqual(['ev-readme']);
  });

  it('accepts adjacent creator-grounded inferences citing the same evidence', () => {
    const references = build([
      { text: 'According to the README, the project may primarily target hobbyists.', support_mode: 'inference', evidence_ids: ['ev-readme'] },
      { text: 'The jury inferred that this focus may limit enterprise adoption.', support_mode: 'inference', evidence_ids: ['ev-readme'] }
    ]);
    expect(references).toHaveLength(2);
  });

  it('the publication gate accepts the same inherited shape (parity, strict no-sink path)', () => {
    const references = build([ATTRIBUTED_README, HEDGED_FOLLOWER], []);
    expect(() => validateClaimReferences(evaluationWith([ATTRIBUTED_README, HEDGED_FOLLOWER]), references, evidenceById, EMPTY_PROTECTED_TOKENS))
      .not.toThrow();
  });
});

describe('adjacent-statement attribution inheritance — every ambiguity fails closed', () => {
  it('fails when the immediately preceding statement carries no attribution', () => {
    expect(() => build([
      { text: 'The repository contains a large curated list.', support_mode: 'evidence_backed', evidence_ids: ['ev-src'] },
      HEDGED_FOLLOWER
    ])).toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  it('fails when the follower cites different evidence than the attributing statement', () => {
    expect(() => build([
      ATTRIBUTED_README,
      { text: 'The jury inferred that the official site may overstate adoption.', support_mode: 'inference', evidence_ids: ['ev-doc'] }
    ])).toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  it('fails when another statement sits between the attribution and the inference', () => {
    expect(() => build([
      ATTRIBUTED_README,
      { text: 'The repository contains inspectable source files.', support_mode: 'evidence_backed', evidence_ids: ['ev-src'] },
      HEDGED_FOLLOWER
    ])).toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  it('fails when the follower is an unhedged factual assertion', () => {
    expect(() => build([
      ATTRIBUTED_README,
      { text: 'This community curation keeps the list relevant.', support_mode: 'inference', evidence_ids: ['ev-readme'] }
    ])).toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  it('never lends attribution to an evidence_backed statement, however hedged', () => {
    expect(() => build([
      ATTRIBUTED_README,
      { text: 'The project may curate thousands of public APIs.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] }
    ])).toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  it('never lends attribution to an unverified statement', () => {
    expect(() => build([
      ATTRIBUTED_README,
      { text: 'The stated coverage figures could not be verified.', support_mode: 'unverified', evidence_ids: ['ev-readme'] }
    ])).toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  it('still hard-fails a statement mixing creator and community sources', () => {
    expect(() => build([
      ATTRIBUTED_README,
      { text: 'The jury inferred that community reception may be mixed.', support_mode: 'inference', evidence_ids: ['ev-readme', 'ev-disc'] }
    ])).toThrow(/mixes creator and community sources/i);
  });

  it('the publication gate rejects a persisted non-inheriting inference identically (parity)', () => {
    const follower = { text: 'The jury inferred that the official site may overstate adoption.', support_mode: 'inference', evidence_ids: ['ev-doc'] };
    const annotations = [ATTRIBUTED_README, follower];
    const references: TrustedClaimReference[] = [
      {
        claim_id: 't0', public_output_path: 'article.final_verdict', statement_index: 0,
        statement_text: ATTRIBUTED_README.text, support_mode: 'evidence_backed', fact_class: 'creator_claim',
        attribution_required: true, evidence_ids: ['ev-readme'], source_fact_classes: ['creator_claim'],
        coverage_source: 'statement_annotation'
      },
      {
        claim_id: 't1', public_output_path: 'article.final_verdict', statement_index: 1,
        statement_text: follower.text, support_mode: 'inference', fact_class: 'inference',
        attribution_required: true, evidence_ids: ['ev-doc'], source_fact_classes: ['creator_claim'],
        coverage_source: 'statement_annotation'
      }
    ];
    expect(() => validateClaimReferences(evaluationWith(annotations), references, evidenceById, EMPTY_PROTECTED_TOKENS))
      .toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });
});

describe('adjacent-statement attribution inheritance — end-to-end through validateContent', () => {
  let originalMode: string | undefined;
  beforeAll(() => {
    originalMode = process.env.JURYPRESS_DATA_MODE;
    process.env.JURYPRESS_DATA_MODE = 'fixture';
  });
  afterAll(() => {
    process.env.JURYPRESS_DATA_MODE = originalMode;
  });

  const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

  function fixtureWithAgreedField(statements: Ann[]) {
    const { generatedOutput, context } = createRecommendationFixture();
    const g = clone(generatedOutput) as any;
    g.article.where_jury_agreed[1] = statements.map(s => s.text).join(' ');
    g.public_statement_annotations = g.public_statement_annotations.filter(
      (a: any) => a.public_output_path !== 'article.where_jury_agreed.1'
    );
    for (const s of statements) {
      g.public_statement_annotations.push({
        public_output_path: 'article.where_jury_agreed.1',
        statement_text: s.text, support_mode: s.support_mode, evidence_ids: s.evidence_ids
      });
    }
    return { g, evidences: context.evidences };
  }

  it('passes the production false-positive shape with no attribution finding at all', () => {
    const { g, evidences } = fixtureWithAgreedField([
      { text: 'According to the README, this project distinguishes itself by curating public APIs.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] },
      { text: 'The jury inferred that this community curation may keep the list relevant.', support_mode: 'inference', evidence_ids: ['ev-readme'] }
    ]);
    const v = validateContent({ content: g, originalContent: g, evidences, humanEdited: false });
    expect(v.status).toBe('passed');
    expect(v.errors).toHaveLength(0);
    expect(v.warnings.map(w => w.code)).not.toContain('CLAIM_ATTRIBUTION_WORDING_MISSING');
  });

  it('classifies a genuine attribution violation as a validator ERROR (symmetric with the publish build)', () => {
    const { g, evidences } = fixtureWithAgreedField([
      { text: 'The documented npm test command may indicate automated testing.', support_mode: 'inference', evidence_ids: ['ev-readme'] }
    ]);
    const v = validateContent({ content: g, originalContent: g, evidences, humanEdited: false });
    expect(v.status).toBe('failed');
    expect(v.errors.map(e => e.code)).toContain('CLAIM_ATTRIBUTION_WORDING_MISSING');
    // No warning-passed-but-unbuildable split: the claim gate itself reports the defect.
    expect(v.errors.map(e => e.code)).not.toContain('PUBLISHED_CONTENT_NOT_BUILDABLE');
  });
});
