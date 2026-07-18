import { describe, it, expect } from 'vitest';
import {
  CREATOR_ATTRIBUTION,
  COMMUNITY_ATTRIBUTION,
  buildTrustedClaimReferences,
  validateClaimReferences,
  EMPTY_PROTECTED_TOKENS
} from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * Regression tests for the two attribution-rule defects observed in production
 * (season-2-request-36 and season-2-2026-07-18-daily — the only two quality failures the
 * pipeline had ever produced, both from this one rule):
 *
 *   A. the creator-attribution check was a closed six-phrase list, so natural prose that
 *      attributes perfectly well ("the archived repository page indicates that …") was
 *      rejected;
 *   B. the same check was applied to short LABEL fields, where prose attribution is
 *      linguistically inappropriate — it rejected a correct category
 *      ("Agentic Software Development Framework") while a sentence stuffed into the field
 *      passed, publishing "Category: According to the README, …" to the live page.
 *
 * Both fixes are strictly widening: every phrase accepted before must still be accepted.
 */

describe('CREATOR_ATTRIBUTION — defect A (lexical allowlist too narrow)', () => {
  // The exact phrases the previous six-alternative list accepted. Any regression here
  // would fail content that used to publish.
  const PREVIOUSLY_ACCEPTED = [
    'According to the README, the tool converts pages.',
    'The README lists the supported formats.',
    'The project describes itself as a scraper.',
    'The creator states that it is experimental.',
    'The creator reports weekly releases.',
    'The creator claims high throughput.',
    'The repository documents the API surface.',
    'The documentation states that setup takes minutes.',
    'The documentation says the API is stable.'
  ];

  it.each(PREVIOUSLY_ACCEPTED)('still accepts previously-accepted wording: %s', text => {
    expect(CREATOR_ATTRIBUTION.test(text)).toBe(true);
  });

  // The production failure and its near neighbours: a source noun plus a reporting verb.
  const NEWLY_ACCEPTED = [
    'However, the archived repository page indicates that the project is no longer maintained, which limits its practical usefulness.',
    'The repository page states that the project is archived.',
    'The maintainer notes that support ended.',
    'The docs explain that configuration is optional.',
    'The changelog documents a breaking change.',
    'The official website describes a hosted option.',
    'The release notes mention a migration step.',
    'Per the project documentation, the server is stateless.'
  ];

  it.each(NEWLY_ACCEPTED)('accepts semantically valid attribution: %s', text => {
    expect(CREATOR_ATTRIBUTION.test(text)).toBe(true);
  });

  // The widening must not become a hole: a statement that names no source stays a
  // violation, otherwise a creator claim could be laundered into an unattributed assertion.
  const STILL_REJECTED = [
    'The tool provides direct utility for AI agents.',
    'The product indicates strong performance.',
    'The project achieves sub-second latency.',
    'The documentation is comprehensive.',
    'It converts web pages to Markdown.',
    'The architecture is modular and well factored.'
  ];

  it.each(STILL_REJECTED)('still rejects unattributed assertions: %s', text => {
    expect(CREATOR_ATTRIBUTION.test(text)).toBe(false);
  });

  it('leaves community attribution untouched', () => {
    expect(COMMUNITY_ATTRIBUTION.test('Commenters noted a packaging issue.')).toBe(true);
    expect(COMMUNITY_ATTRIBUTION.test('The tool is fast.')).toBe(false);
  });
});

// ── defect B — the rule applied to label fields ──────────────────────────────────

function evidence(id: string, type: string, claimType: string): Evidence {
  return {
    evidence_id: id, type, url: `https://example.invalid/${id}`,
    title: id, retrieved_at: '2026-07-18T00:00:00.000Z', content_hash: `${id}-hash`, summary: 's',
    claims: [{ claim_id: `${id}-default`, text: 'c', claim_type: claimType }]
  } as unknown as Evidence;
}

const evidenceById = new Map<string, Evidence>([
  ['ev-readme', evidence('ev-readme', 'readme', 'creator_claim')]
]);

function evaluationWithField(path: 'product.category' | 'product.primary_audience' | 'article.final_verdict', text: string, supportMode = 'evidence_backed') {
  const evaluation: any = { public_statement_annotations: [{
    public_output_path: path,
    statement_text: text,
    support_mode: supportMode,
    evidence_ids: ['ev-readme']
  }] };
  if (path.startsWith('product.')) {
    evaluation.product = { [path.split('.')[1]]: text };
  } else {
    evaluation.article = { final_verdict: text };
  }
  return evaluation;
}

function build(path: any, text: string, supportMode?: string) {
  return buildTrustedClaimReferences(evaluationWithField(path, text, supportMode), evidenceById, EMPTY_PROTECTED_TOKENS, []);
}

describe('attribution wording scope — defect B (label fields)', () => {
  // The exact value the production daily run was rejected for.
  it('accepts a bare category label citing creator evidence', () => {
    expect(() => build('product.category', 'Agentic Software Development Framework', 'inference')).not.toThrow();
  });

  it('accepts a bare primary_audience label', () => {
    expect(() => build('product.primary_audience', 'Developers and ML researchers')).not.toThrow();
  });

  it('still records the creator provenance of an exempt label', () => {
    const refs = build('product.category', 'Agentic Software Development Framework', 'inference');
    expect(refs).toHaveLength(1);
    // Only the WORDING is waived: the creator origin is still persisted, so it can never be
    // laundered away by putting a claim in a label field.
    expect(refs[0].source_fact_classes).toContain('creator_claim');
    expect(refs[0].attribution_required).toBe(true);
    expect(refs[0].evidence_ids).toEqual(['ev-readme']);
  });

  it('still requires attribution once a label field holds an actual sentence', () => {
    expect(() => build('product.category', 'The project is a curated directory of public APIs.'))
      .toThrow(/carries no attribution wording/);
  });

  it('still requires attribution for a long, prose-like value in a label field', () => {
    const longValue = 'a curated directory of public APIs spanning many categories and maintained by a large community of contributors worldwide';
    expect(() => build('product.category', longValue)).toThrow(/carries no attribution wording/);
  });

  it('does not exempt prose fields', () => {
    expect(() => build('article.final_verdict', 'A capable scraper')).toThrow(/carries no attribution wording/);
  });

  it('accepts the attributed sentence form that previously passed (strictly widening)', () => {
    expect(() => build('product.category', 'According to the README, the project is a curated directory of public APIs.')).not.toThrow();
  });

  it('waives calibration wording for a label too, without silencing it for prose', () => {
    // A label can no more hedge than it can attribute; the sibling calibration rule uses
    // the same waiver so a category is not asked for wording it has no room for.
    const labelSink: any[] = [];
    buildTrustedClaimReferences(
      evaluationWithField('product.category', 'Agentic Software Development Framework', 'inference'),
      evidenceById, EMPTY_PROTECTED_TOKENS, labelSink
    );
    expect(labelSink.map(f => f.code)).not.toContain('CLAIM_CALIBRATION_WORDING_MISSING');

    const proseSink: any[] = [];
    buildTrustedClaimReferences(
      evaluationWithField('article.final_verdict', 'According to the README, the project standardizes agent workflows.', 'inference'),
      evidenceById, EMPTY_PROTECTED_TOKENS, proseSink
    );
    expect(proseSink.map(f => f.code)).toContain('CLAIM_CALIBRATION_WORDING_MISSING');
  });

  it('applies the same scope at the publication gate', () => {
    const refs = build('product.category', 'Agentic Software Development Framework', 'inference');
    expect(() => validateClaimReferences(
      evaluationWithField('product.category', 'Agentic Software Development Framework', 'inference'),
      refs,
      evidenceById,
      EMPTY_PROTECTED_TOKENS,
      []
    )).not.toThrow();
  });
});
