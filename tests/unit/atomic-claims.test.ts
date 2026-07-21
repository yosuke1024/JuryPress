import { describe, it, expect } from 'vitest';
import { ingestMappingResponse, type NumberedStatement } from '../../src/lib/evaluation/evidence-mapper';
import { aggregateSupport, type AtomicClaim } from '../../src/schemas/evidence-map';
import type { Evidence } from '../../src/schemas/evidence';

/**
 * The failure these exist to prevent, taken from a real published review:
 *
 *   "the CLI immediately directs users to a browser-based SaaS authentication flow, meaning
 *    Grok Build is primarily a high-performance delivery vehicle for SpaceXAI's paid models"
 *
 * The README establishes the browser flow and says nothing about paid models. Mapped as one
 * unit it was recorded creator_claim / strong, and an inference nothing supported was
 * published wearing the evidence of the clause beside it.
 */

const EVIDENCES = [
  { evidence_id: 'ev-readme', url: 'https://example.com', type: 'readme', title: 'README', summary: '', claims: [] },
  { evidence_id: 'ev-repo', url: 'https://example.com/repo', type: 'repository', title: 'Repo', summary: '', claims: [] }
] as unknown as Evidence[];

function statement(id: number, text: string): NumberedStatement {
  return { statementId: id, path: 'article.jury_summary', statementIndex: id - 1, text } as NumberedStatement;
}

function ingest(entries: unknown[], statements: NumberedStatement[]) {
  return ingestMappingResponse({
    articleHash: 'a'.repeat(64),
    mappedAt: '2026-07-20T03:00:00.000Z',
    model: 'test-model',
    statements,
    evidences: EVIDENCES,
    parsed: { article_hash: 'a'.repeat(64), mapping: entries }
  });
}

const COMPOUND = statement(
  1,
  'The CLI opens a browser for authentication, meaning it is primarily a delivery vehicle for paid models.'
);

const splitEntry = (overrides: Record<string, unknown> = {}) => ({
  statement_id: 1,
  classification: 'creator_claim',
  evidence_ids: ['ev-readme'],
  support: 'strong',
  note: null,
  atomic_claims: [
    {
      clause_index: 0,
      text: 'The CLI opens a browser for authentication',
      classification: 'creator_claim',
      evidence_ids: ['ev-readme'],
      support: 'strong'
    },
    {
      clause_index: 1,
      text: 'it is primarily a delivery vehicle for paid models',
      classification: 'reasonable_inference',
      evidence_ids: [],
      support: 'none'
    }
  ],
  ...overrides
});

describe('aggregateSupport', () => {
  const claim = (classification: string, support: string): AtomicClaim =>
    ({ clause_index: 0, text: 't', classification, evidence_ids: [], support }) as AtomicClaim;

  it('takes the weakest factual clause, not the strongest', () => {
    expect(aggregateSupport([claim('creator_claim', 'strong'), claim('reasonable_inference', 'none')]))
      .toBe('none');
  });

  it('ignores editorial clauses when they sit beside a supported fact', () => {
    // An opinion carries no evidential weight, so its presence must not drag a sourced
    // factual statement down to "none" either.
    expect(aggregateSupport([claim('creator_claim', 'strong'), claim('editorial_judgment', 'none')]))
      .toBe('strong');
  });

  it('reports none when every clause is opinion', () => {
    expect(aggregateSupport([claim('editorial_judgment', 'none'), claim('editorial_judgment', 'none')]))
      .toBe('none');
  });

  it('reports none for an empty split', () => {
    expect(aggregateSupport([])).toBe('none');
  });
});

describe('ingesting a split statement', () => {
  it('downgrades the statement to its weakest factual clause', () => {
    const map = ingest([splitEntry()], [COMPOUND]);
    const claim = map.claims[0];
    // The model said "strong" for the sentence. The clauses say otherwise, and they win.
    expect(claim.support).toBe('none');
    expect(claim.atomic_claims).toHaveLength(2);
  });

  it('does not alter the statement text, path or index', () => {
    const map = ingest([splitEntry()], [COMPOUND]);
    expect(map.claims[0].statement_text).toBe(COMPOUND.text);
    expect(map.claims[0].public_output_path).toBe('article.jury_summary');
    expect(map.claims[0].statement_index).toBe(0);
  });

  it('strips evidence from an editorial clause so it cannot inherit a fact\'s sources', () => {
    const map = ingest(
      [
        splitEntry({
          atomic_claims: [
            {
              clause_index: 0,
              text: 'The CLI opens a browser for authentication',
              classification: 'creator_claim',
              evidence_ids: ['ev-readme'],
              support: 'strong'
            },
            {
              clause_index: 1,
              text: 'which is a poor choice',
              classification: 'editorial_judgment',
              evidence_ids: ['ev-readme'],
              support: 'strong'
            }
          ]
        })
      ],
      [COMPOUND]
    );
    const parts = map.claims[0].atomic_claims!;
    expect(parts[1].evidence_ids).toEqual([]);
    expect(parts[1].support).toBe('none');
    // The factual clause keeps its own source.
    expect(parts[0].evidence_ids).toEqual(['ev-readme']);
  });

  it('derives statement evidence from the factual clauses', () => {
    const map = ingest(
      [
        splitEntry({
          evidence_ids: ['ev-readme', 'ev-repo'],
          atomic_claims: [
            { clause_index: 0, text: 'a', classification: 'creator_claim', evidence_ids: ['ev-readme'], support: 'strong' },
            { clause_index: 1, text: 'b', classification: 'reasonable_inference', evidence_ids: [], support: 'none' }
          ]
        })
      ],
      [COMPOUND]
    );
    expect(map.claims[0].evidence_ids).toEqual(['ev-readme']);
  });

  it('drops unknown evidence ids inside clauses', () => {
    const map = ingest(
      [
        splitEntry({
          atomic_claims: [
            { clause_index: 0, text: 'a', classification: 'creator_claim', evidence_ids: ['ev-readme', 'ev-nope'], support: 'strong' },
            { clause_index: 1, text: 'b', classification: 'reasonable_inference', evidence_ids: ['ev-ghost'], support: 'weak' }
          ]
        })
      ],
      [COMPOUND]
    );
    const parts = map.claims[0].atomic_claims!;
    expect(parts[0].evidence_ids).toEqual(['ev-readme']);
    expect(parts[1].evidence_ids).toEqual([]);
  });

  it('renumbers clause_index into reading order', () => {
    const map = ingest(
      [
        splitEntry({
          atomic_claims: [
            { clause_index: 7, text: 'a', classification: 'creator_claim', evidence_ids: [], support: 'weak' },
            { clause_index: 9, text: 'b', classification: 'creator_claim', evidence_ids: [], support: 'weak' }
          ]
        })
      ],
      [COMPOUND]
    );
    expect(map.claims[0].atomic_claims!.map(c => c.clause_index)).toEqual([0, 1]);
  });
});

describe('statements that were not really split', () => {
  it('ignores a single-clause "split" and keeps the whole-statement answer', () => {
    // One clause restating the sentence would present unsplit work as split.
    const map = ingest(
      [
        splitEntry({
          atomic_claims: [
            { clause_index: 0, text: 'the whole sentence again', classification: 'creator_claim', evidence_ids: ['ev-readme'], support: 'strong' }
          ]
        })
      ],
      [COMPOUND]
    );
    expect(map.claims[0].atomic_claims).toBeUndefined();
    expect(map.claims[0].support).toBe('strong');
  });

  it('leaves a statement with no atomic_claims exactly as before', () => {
    const simple = statement(1, 'The repository contains two crates.');
    const map = ingest(
      [{ statement_id: 1, classification: 'repository_observation', evidence_ids: ['ev-repo'], support: 'strong', note: null }],
      [simple]
    );
    expect(map.claims[0].atomic_claims).toBeUndefined();
    expect(map.claims[0].support).toBe('strong');
    expect(map.claims[0].evidence_ids).toEqual(['ev-repo']);
    expect(map.status).toBe('complete');
  });

  it('discards blank clause text rather than recording an empty claim', () => {
    const map = ingest(
      [
        splitEntry({
          atomic_claims: [
            { clause_index: 0, text: '   ', classification: 'creator_claim', evidence_ids: [], support: 'strong' },
            { clause_index: 1, text: 'a real clause', classification: 'creator_claim', evidence_ids: [], support: 'weak' }
          ]
        })
      ],
      [COMPOUND]
    );
    // Only one usable clause remains, so this is not a split at all.
    expect(map.claims[0].atomic_claims).toBeUndefined();
  });
});

describe('enumeration splitting and atomic-level contradiction (prompt + ingest)', () => {
  it('the mapping prompt teaches splitting enumerations, not only linked clauses', () => {
    const src = require('node:fs').readFileSync('src/lib/evaluation/evidence-mapper.ts', 'utf8');
    expect(src).toMatch(/Enumerations/);
    expect(src).toMatch(/one clause per assertion/);
    // and still keeps the linked-clause case
    expect(src).toMatch(/Linked assertions/);
  });

  it('the mapping prompt asks for an active contradiction check against official material', () => {
    const src = require('node:fs').readFileSync('src/lib/evaluation/evidence-mapper.ts', 'utf8');
    expect(src).toMatch(/CHECKING FOR CONTRADICTION/);
    expect(src).toMatch(/does any collected evidence say the OPPOSITE/);
    expect(src).toMatch(/official_docs/);
  });

  it('surfaces a contradiction found in one clause of an enumeration', () => {
    // The Grok Build shape: "It rejects PRs, has no tracker, and requires a paid subscription."
    // The evidence supports the first two; the third contradicts the docs. The whole statement's
    // top-level classification is creator_claim, but the contradiction must still surface.
    const statement = {
      statementId: 1,
      path: 'article.jury_summary',
      statementIndex: 0,
      text: 'It rejects external contributions, has no issue tracker, and requires a paid subscription.'
    } as NumberedStatement;
    const map = ingestMappingResponse({
      articleHash: 'a'.repeat(64),
      mappedAt: '2026-07-21T00:00:00.000Z',
      model: 'm',
      statements: [statement],
      evidences: EVIDENCES,
      parsed: {
        article_hash: 'a'.repeat(64),
        mapping: [
          {
            statement_id: 1,
            classification: 'creator_claim',
            evidence_ids: ['ev-readme'],
            support: 'strong',
            note: null,
            atomic_claims: [
              { clause_index: 0, text: 'It rejects external contributions', classification: 'creator_claim', evidence_ids: ['ev-readme'], support: 'strong' },
              { clause_index: 1, text: 'has no issue tracker', classification: 'repository_observation', evidence_ids: ['ev-repo'], support: 'moderate' },
              { clause_index: 2, text: 'and requires a paid subscription', classification: 'contradicted_by_evidence', evidence_ids: ['ev-readme'], support: 'strong' }
            ]
          }
        ]
      }
    });
    // The derived contradictions list includes this statement, even though its top-level
    // classification is creator_claim, because a clause contradicts the evidence.
    expect(map.contradictions).toEqual(['claim-1']);
  });
})
