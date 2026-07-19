import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  buildTrustedClaimReferences,
  validateClaimReferences,
  EMPTY_PROTECTED_TOKENS
} from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * Claim rule 3.0.0 — in-prose source attribution is no longer required.
 *
 * Source disclosure lives in the machine-readable layer, which the article renders three
 * ways (a per-statement evidence-id badge, the end-of-article Sources list, and the
 * Classifications block). Requiring the sentence to also say "According to the README" made
 * that phrase 59% of all attribution wording across the published articles and was the sole
 * cause of every quality failure the pipeline produced.
 *
 * These tests pin what that removal must NOT take with it: traceability is unchanged, and a
 * statement still may not carry two source voices.
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
  ['ev-site', evidence('ev-site', 'official_site', 'creator_claim')],
  ['ev-disc', evidence('ev-disc', 'source_discussion', 'community_opinion')],
  ['ev-meta', evidence('ev-meta', 'api_metadata', 'confirmed_fact')]
]);

type Ann = { text: string; support_mode: string; evidence_ids: string[] };

function evaluationWith(annotations: Ann[], path = 'article.final_verdict') {
  const evaluation: any = {
    public_statement_annotations: annotations.map(a => ({
      public_output_path: path,
      statement_text: a.text,
      support_mode: a.support_mode,
      evidence_ids: a.evidence_ids
    }))
  };
  const joined = annotations.map(a => a.text).join(' ');
  if (path.startsWith('product.')) evaluation.product = { [path.split('.')[1]]: joined };
  else evaluation.article = { final_verdict: joined };
  return evaluation;
}

function build(annotations: Ann[], path?: string, sink: any[] = []) {
  return buildTrustedClaimReferences(evaluationWith(annotations, path), evidenceById, EMPTY_PROTECTED_TOKENS, sink);
}

describe('in-prose attribution is no longer required', () => {
  it('accepts an unattributed statement citing creator evidence', () => {
    expect(() => build([
      { text: 'The tool converts web pages to clean Markdown.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] }
    ])).not.toThrow();
  });

  it('accepts a second sentence that drops the attribution of the first', () => {
    // The exact shape that failed season-2-request-36 in production.
    expect(() => build([
      { text: 'According to the README, the tool converts pages to Markdown.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] },
      { text: 'However, subsequent benchmarks did not validate the token efficiency hypothesis.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] }
    ])).not.toThrow();
  });

  it('accepts an unattributed inference and an unattributed unverified statement', () => {
    expect(() => build([
      { text: 'This may indicate a sustainable maintenance cadence.', support_mode: 'inference', evidence_ids: ['ev-readme'] }
    ])).not.toThrow();
    expect(() => build([
      { text: 'The available evidence does not establish runtime performance.', support_mode: 'unverified', evidence_ids: ['ev-site'] }
    ])).not.toThrow();
  });

  it('accepts an unattributed statement citing community evidence', () => {
    expect(() => build([
      { text: 'Packaging friction was raised during launch week.', support_mode: 'evidence_backed', evidence_ids: ['ev-disc'] }
    ])).not.toThrow();
  });

  it('still accepts attributed prose — removal is permissive, not prescriptive', () => {
    expect(() => build([
      { text: 'According to the README, the project is a curated directory.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] }
    ])).not.toThrow();
  });
});

describe('what the removal must not take with it', () => {
  it('still records the source fact class of an unattributed statement', () => {
    const refs = build([
      { text: 'The tool converts web pages to clean Markdown.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] }
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0].source_fact_classes).toEqual(['creator_claim']);
    expect(refs[0].attribution_required).toBe(true);
    expect(refs[0].evidence_ids).toEqual(['ev-readme']);
  });

  it('still records provenance for an unattributed inference (no laundering)', () => {
    const refs = build([
      { text: 'This may indicate a sustainable maintenance cadence.', support_mode: 'inference', evidence_ids: ['ev-readme'] }
    ]);
    expect(refs[0].fact_class).toBe('inference');
    expect(refs[0].source_fact_classes).toEqual(['creator_claim']);
    expect(refs[0].attribution_required).toBe(true);
  });

  it('still refuses a statement mixing creator and community sources', () => {
    expect(() => build([
      { text: 'The project and its commenters both describe a packaging issue.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme', 'ev-disc'] }
    ])).toThrow(/mixes creator and community sources/);
  });

  it('still refuses an evidence_backed statement mixing fact classes', () => {
    expect(() => build([
      { text: 'Metadata reports adoption and the project documents a modular architecture.', support_mode: 'evidence_backed', evidence_ids: ['ev-meta', 'ev-readme'] }
    ])).toThrow(/mixed fact classes/);
  });

  it('still requires every statement to be annotated', () => {
    const evaluation: any = {
      article: { final_verdict: 'First sentence. Second sentence.' },
      public_statement_annotations: [{
        public_output_path: 'article.final_verdict',
        statement_text: 'First sentence.',
        support_mode: 'evidence_backed',
        evidence_ids: ['ev-readme']
      }]
    };
    expect(() => buildTrustedClaimReferences(evaluation, evidenceById, EMPTY_PROTECTED_TOKENS, []))
      .toThrow();
  });

  it('applies the identical contract at the publication gate', () => {
    const annotations = [
      { text: 'The tool converts web pages to clean Markdown.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] }
    ];
    const refs = build(annotations);
    expect(() => validateClaimReferences(
      evaluationWith(annotations), refs, evidenceById, EMPTY_PROTECTED_TOKENS, []
    )).not.toThrow();
  });
});

describe('label fields still waive calibration and absence wording', () => {
  it('accepts a bare category label without calibrated wording', () => {
    const sink: any[] = [];
    build([{ text: 'Agentic Software Development Framework', support_mode: 'inference', evidence_ids: ['ev-readme'] }], 'product.category', sink);
    expect(sink.map(f => f.code)).not.toContain('CLAIM_CALIBRATION_WORDING_MISSING');
  });

  it('still asks prose fields for calibrated wording', () => {
    const sink: any[] = [];
    build([{ text: 'The project standardizes agent workflows.', support_mode: 'inference', evidence_ids: ['ev-readme'] }], 'article.final_verdict', sink);
    expect(sink.map(f => f.code)).toContain('CLAIM_CALIBRATION_WORDING_MISSING');
  });

  it('still asks a label field for wording once it holds a sentence', () => {
    const sink: any[] = [];
    build([{ text: 'The project is a curated directory of public APIs.', support_mode: 'inference', evidence_ids: ['ev-readme'] }], 'product.category', sink);
    expect(sink.map(f => f.code)).toContain('CLAIM_CALIBRATION_WORDING_MISSING');
  });
});

// ── the one place in-prose attribution is still load-bearing ─────────────────────

/**
 * Removing the blanket attribution rule must not silently break the counter-evidence
 * linkage: the publication gate proves that material community criticism was actually
 * answered by requiring the responding field to NAME the community. If the prompt stopped
 * asking for that wording, reviews sourced from a discussion would fail at publish — a
 * harder failure than the quality gate. So the prompt keeps that one narrow requirement,
 * and these tests pin both halves together.
 */
describe('community attribution is still required where the publish gate depends on it', () => {
  const promptPath = path.join(__dirname, '..', '..', 'src', 'lib', 'evaluation', 'evaluator.ts');
  const prompt = fs.readFileSync(promptPath, 'utf8');
  const gate = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'lib', 'publication-integrity.ts'), 'utf8'
  );

  it('the prompt still requires naming the community when answering its criticism', () => {
    expect(prompt).toContain('ONE case still REQUIRES naming the source');
    expect(prompt).toContain('Commenters noted');
    expect(prompt).toContain('The community discussion raised');
  });

  it('the prompt no longer demands routine creator attribution anywhere', () => {
    expect(prompt).not.toContain('the SAME sentence must attribute the creator');
    expect(prompt).not.toContain('carry creator/community attribution in the sentence');
    expect(prompt).toContain('Do NOT prefix sentences with source attribution as a matter of routine');
  });

  it('every community phrase the prompt teaches satisfies the publish gate pattern', () => {
    // The gate's own pattern, kept in sync by construction: a phrase the prompt teaches
    // that the gate would reject is a review that generates cleanly and fails at publish.
    const gatePattern = /\b(commenter|commenters|community|discussion|community opinion|a user|users questioned|criticism|criticized)\b/i;
    for (const taught of ['Commenters noted a packaging issue.', 'The community discussion raised reproducibility concerns.']) {
      expect(gatePattern.test(taught)).toBe(true);
    }
    expect(gate).toContain('commenter|commenters|community');
  });

  it('the calibration requirement no longer accepts a source prefix as calibration', () => {
    expect(prompt).toContain('A source prefix is NOT calibration and does not satisfy this.');
    expect(prompt).not.toContain("at least one calibrated phrase (e.g. 'according to'");
  });
});
