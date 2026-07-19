import { describe, it, expect } from 'vitest';
import { classifyRisk, selectStatementsForMapping } from '../../src/lib/evaluation/mapping-scope';
import { ingestMappingResponse } from '../../src/lib/evaluation/evidence-mapper';
import { segmentStatements, buildProtectedTokens } from '../../src/lib/evaluation/public-claims';
import { createEditorialFixture } from '../fixtures/refined-review';

/**
 * The evidence map covers the review's narrative plus the risk-bearing specifics found
 * elsewhere — not every sentence. The publication's purpose is a valuable review, not a
 * complete audit, and mapping per-criterion scoring commentary buys an appendix nobody reads
 * at the cost of extra requests and truncation.
 */
describe('Mapping scope', () => {
  const fixture = createEditorialFixture();
  const evidences = fixture.context.evidences;

  function select(content: any = fixture.generatedOutput) {
    return selectStatementsForMapping(content, evidences);
  }

  it('always covers the reader-facing narrative in full', () => {
    const paths = new Set(select().statements.map(s => s.path));
    for (const required of [
      'product.summary',
      'article.headline',
      'article.standfirst',
      'article.jury_summary',
      'article.final_verdict',
      'article.meta_description',
      'article.where_jury_agreed.0',
      'article.where_jury_disagreed.0.summary',
      'judges.0.verdict',
      'judges.0.concerns.0'
    ]) {
      expect(paths.has(required), `${required} must be in scope`).toBe(true);
    }
  });

  it('marks narrative statements as such and never drops one', () => {
    const selection = select();
    const narrative = selection.statements.filter(s => s.tier === 'narrative');
    const tokens = buildProtectedTokens(evidences);
    const expected = segmentStatements(
      fixture.generatedOutput.article.jury_summary,
      tokens,
      { recognizeFileExtensions: true }
    ).length;
    expect(narrative.filter(s => s.path === 'article.jury_summary')).toHaveLength(expected);
  });

  it('excludes ordinary per-criterion scoring commentary', () => {
    const content = JSON.parse(JSON.stringify(fixture.generatedOutput));
    content.judges[0].criteria[0].reasoning =
      'The scope here is coherent and the judgment is well founded. This reads as a deliberate choice.';

    const selection = selectStatementsForMapping(content, evidences);
    const paths = selection.statements.map(s => s.path);
    expect(paths).not.toContain('judges.0.criteria.0.reasoning');
    expect(selection.excludedStatementCount).toBeGreaterThan(0);
  });

  describe('risk-bearing specifics are pulled out of judge detail', () => {
    const cases: Array<[string, string]> = [
      ['numeric_claim', 'The repository has 1,060 stars and 12 open issues.'],
      ['runtime_result', 'The test suite passes on every supported runtime.'],
      ['security_claim', 'Admin credentials are encrypted with AES-256-GCM before storage.'],
      ['technical_composition', 'The whole frontend ships as a single ui.html file.'],
      ['absence_claim', 'The project does not provide any automated tests.'],
      ['competitor_claim', 'It is faster than the official CLI for bulk edits.']
    ];

    for (const [risk, statement] of cases) {
      it(`captures ${risk}`, () => {
        expect(classifyRisk(statement)).toBe(risk);

        const content = JSON.parse(JSON.stringify(fixture.generatedOutput));
        content.judges[0].criteria[0].reasoning = statement;
        const selection = selectStatementsForMapping(content, evidences);
        const picked = selection.statements.find(s => s.path === 'judges.0.criteria.0.reasoning');
        expect(picked, `${risk} statement must be in scope`).toBeDefined();
        expect(picked!.tier).toBe('risk_bearing');
      });
    }

    it('leaves general evaluative language alone', () => {
      expect(classifyRisk('The scope is coherent and the trade-offs are honest.')).toBeNull();
      expect(classifyRisk('This is a thoughtful piece of design work.')).toBeNull();
    });
  });

  it('reduces the mapped set well below the full article', () => {
    const selection = select();
    const total = selection.statements.length + selection.excludedStatementCount;
    expect(selection.statements.length).toBeLessThan(total);
    expect(selection.excludedStatementCount).toBeGreaterThan(0);
  });

  it('is deterministic — a remap of unchanged content yields identical ids', () => {
    expect(select().statements).toEqual(select().statements);
  });
});

/**
 * Real repository filenames appear constantly in a software review. The audit-era segmenter
 * split "a single ui.html file" into "a single ui." + "html file." — two nonsense rows in a
 * reader-facing appendix.
 */
describe('Editorial segmentation recognizes real repository filenames', () => {
  const tokens = buildProtectedTokens([]);
  const editorial = (text: string) => segmentStatements(text, tokens, { recognizeFileExtensions: true });

  it('keeps single-extension filenames whole', () => {
    expect(editorial('The frontend is a single ui.html file. That is deliberate.'))
      .toEqual(['The frontend is a single ui.html file.', 'That is deliberate.']);
    expect(editorial('It ships app.js and index.html at the root.'))
      .toEqual(['It ships app.js and index.html at the root.']);
  });

  it('keeps multi-dot filenames whole', () => {
    expect(editorial('Tests live in vitest.config.ts. Nothing else does.'))
      .toEqual(['Tests live in vitest.config.ts.', 'Nothing else does.']);
    expect(editorial('See docker-compose.dev.yml for the setup. It works.'))
      .toEqual(['See docker-compose.dev.yml for the setup.', 'It works.']);
  });

  it('still splits a real sentence boundary', () => {
    expect(editorial('The work ends here. html follows next.'))
      .toEqual(['The work ends here.', 'html follows next.']);
    expect(editorial('The whole UI is ui.html. Nothing else.'))
      .toEqual(['The whole UI is ui.html.', 'Nothing else.']);
  });

  it('leaves the legacy (default) segmentation byte-identical', () => {
    // The 1.0.0 reviews' persisted claim_references were derived under the old rule and are
    // re-derived and compared on every deploy — a global change would fail the site build.
    for (const text of [
      'The frontend is a single ui.html file. That is deliberate.',
      'Tests live in vitest.config.ts. Nothing else does.',
      'Node.js 22 is required. See README.md for details.'
    ]) {
      expect(segmentStatements(text, tokens)).toEqual(segmentStatements(text, tokens, {}));
    }
    expect(segmentStatements('The frontend is a single ui.html file.', tokens))
      .toEqual(['The frontend is a single ui.', 'html file.']);
  });
});

/** The one-shot completion pass may only ADD coverage — never rewrite the first pass. */
describe('Evidence map completion pass', () => {
  const fixture = createEditorialFixture();
  const evidences = fixture.context.evidences;
  const hash = 'd'.repeat(64);

  function ingest(first: any[], additional?: any[][]) {
    const statements = selectStatementsForMapping(fixture.generatedOutput, evidences).statements;
    return ingestMappingResponse({
      articleHash: hash,
      mappedAt: '2026-07-19T00:00:00.000Z',
      model: 'mapping-model',
      statements,
      evidences,
      excludedStatementCount: 7,
      parsed: { article_hash: hash, mapping: first },
      additionalParsed: additional?.map(mapping => ({ article_hash: hash, mapping }))
    });
  }

  const entry = (id: number, classification = 'editorial_judgment') => ({
    statement_id: id, classification, evidence_ids: [], support: 'none', note: null
  });

  function allIds() {
    return selectStatementsForMapping(fixture.generatedOutput, evidences).statements.map(s => s.statementId);
  }

  it('records the scope counts', () => {
    const map = ingest(allIds().map(id => entry(id)));
    expect(map.scope).toBeDefined();
    expect(map.scope!.selected_statement_count).toBe(allIds().length);
    expect(map.scope!.excluded_statement_count).toBe(7);
    expect(map.status).toBe('complete');
  });

  it('a completion pass closes the gap left by the first', () => {
    const ids = allIds();
    const firstPass = ids.slice(0, 3).map(id => entry(id));
    const partial = ingest(firstPass);
    expect(partial.status).toBe('partial');
    expect(partial.claims).toHaveLength(3);

    const completed = ingest(firstPass, [ids.slice(3).map(id => entry(id))]);
    expect(completed.status).toBe('complete');
    expect(completed.claims).toHaveLength(ids.length);
  });

  it('a completion pass cannot overwrite a first-pass classification', () => {
    const ids = allIds();
    const completed = ingest(
      [entry(ids[0], 'directly_supported')],
      [ids.map(id => entry(id, 'contradicted_by_evidence'))]
    );
    expect(completed.claims.find(c => c.claim_id === `claim-${ids[0]}`)!.classification)
      .toBe('directly_supported');
  });

  it('a malformed completion pass leaves the first pass intact', () => {
    const ids = allIds();
    const firstPass = ids.slice(0, 3).map(id => entry(id));
    const map = ingest(firstPass, [[{ nonsense: true }] as any]);
    expect(map.claims).toHaveLength(3);
    expect(map.status).toBe('partial');
  });
});

/**
 * The scope change altered two shapes that a record published minutes earlier already used.
 * Reading that record has to keep working, or the site build fails — and the remap workflow
 * that would migrate it runs a site build itself, so a hard break is a deadlock, not a
 * one-time inconvenience.
 */
describe('Pre-scope records still read', () => {
  it('accepts a map with no scope block', async () => {
    const { EvidenceMapSchema } = await import('../../src/schemas/evidence-map');
    const legacy = {
      map_schema_version: '1.0.0',
      article_hash: 'e'.repeat(64),
      mapping_prompt_version: '1.0.0',
      mapped_at: '2026-07-19T00:00:00.000Z',
      model: 'mapping-model',
      status: 'partial',
      claims: [],
      unmapped_statements: [],
      contradictions: [],
      evidence_usage: []
    };
    const parsed = EvidenceMapSchema.safeParse(legacy);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.scope).toBeUndefined();
  });

  it('reads the legacy "available" review status as partial, never complete', async () => {
    const { createEditorialFixture } = await import('../fixtures/refined-review');
    const { ReviewSchemaV3 } = await import('../../src/schemas/review');
    const review = JSON.parse(JSON.stringify(createEditorialFixture().review));
    review.evidence_map_status = 'available';

    const parsed = ReviewSchemaV3.safeParse(review);
    expect(parsed.success).toBe(true);
    // Completeness was never recorded for those maps, so it must not be asserted now.
    if (parsed.success) expect(parsed.data.evidence_map_status).toBe('partial');
  });

  it('still rejects an unknown status', async () => {
    const { createEditorialFixture } = await import('../fixtures/refined-review');
    const { ReviewSchemaV3 } = await import('../../src/schemas/review');
    const review = JSON.parse(JSON.stringify(createEditorialFixture().review));
    review.evidence_map_status = 'mostly';
    expect(ReviewSchemaV3.safeParse(review).success).toBe(false);
  });
});
