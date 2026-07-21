import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { validateContent } from '../../src/lib/generation/validator';
import { repairContent } from '../../src/lib/generation/repair';
import { isEditorialPromptVersion } from '../../src/lib/evaluation/evaluator';
import { ingestMappingResponse, segmentArticleStatements } from '../../src/lib/evaluation/evidence-mapper';
import { applyVerdict } from '../../src/lib/generation/validator';
import { findSystemProtectionDefects } from '../../src/lib/generation/system-protection';
import { createEditorialFixture } from '../fixtures/refined-review';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  EvaluationOutputGenSchemaV3,
  EvaluationOutputGenSchemaV2_1,
  EvaluationOutputSchemaV3
} from '../../src/schemas/evaluation';
import { EvidenceMapGenSchema } from '../../src/schemas/evidence-map';

/**
 * The editorial-first pipeline's core promise: an opinionated, unhedged review passes
 * validation on the FIRST attempt, and nothing in the pipeline can rewrite its prose.
 *
 * Every case here would have failed under the audit-era rules — that is the point. The
 * corpus analysis behind this change found a 0% first-attempt pass rate, with every single
 * exclusion caused by a lexical wording rule rather than by anything a reader would call a
 * defect.
 */
describe('Editorial pipeline (V3) — minimal gate', () => {
  const EDITORIAL_PROMPT = '4.0.0';

  function editorialContent(): any {
    return JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  }

  function validate(content: any, evidences: any[] = [], overrides: Record<string, unknown> = {}) {
    return validateContent({
      content,
      originalContent: content,
      evidences,
      humanEdited: false,
      promptVersion: EDITORIAL_PROMPT,
      ...overrides
    });
  }

  it('routes 4.x prompt versions to the editorial rules and everything else to the legacy rules', () => {
    expect(isEditorialPromptVersion('4.0.0')).toBe(true);
    expect(isEditorialPromptVersion('5.2.1')).toBe(true);
    expect(isEditorialPromptVersion('3.0.0')).toBe(false);
    expect(isEditorialPromptVersion('2.1.0')).toBe(false);
    expect(isEditorialPromptVersion(null)).toBe(false);
    expect(isEditorialPromptVersion(undefined)).toBe(false);
  });

  it('passes an opinionated, unhedged article on the first attempt', () => {
    const verdict = validate(editorialContent(), createEditorialFixture().context.evidences);
    expect(verdict.errors).toEqual([]);
    expect(verdict.status).toBe('passed');
  });

  it('accepts strong editorial judgment with no attribution or calibration wording', () => {
    const content = editorialContent();
    content.article.headline = 'The digital twin is this project\'s sharpest idea';
    content.article.jury_summary = 'This is the best implementation of the pattern shipping today, and the maintainers clearly know it. Nothing else in the category comes close on start-up cost.';
    content.judges[0].verdict = 'Adopt it. The design is right and the tradeoffs are honest.';

    const verdict = validate(content, createEditorialFixture().context.evidences);
    expect(verdict.status).toBe('passed');
    // The prose survives byte-for-byte: no calibration substitution, no injected disclaimer.
    expect((verdict.content as any).article.jury_summary).toBe(content.article.jury_summary);
    expect((verdict.content as any).judges[0].verdict).toBe(content.judges[0].verdict);
  });

  it('allows empty limitations on a low/medium-confidence criterion', () => {
    const content = editorialContent();
    content.judges[0].criteria[0].confidence = 'low';
    content.judges[0].criteria[0].limitations = [];

    const verdict = validate(content, createEditorialFixture().context.evidences);
    expect(verdict.status).toBe('passed');
    expect((verdict.content as any).judges[0].criteria[0].limitations).toEqual([]);
  });

  it('never injects calibration boilerplate into reasoning', () => {
    const content = editorialContent();
    content.judges[0].criteria[0].confidence = 'low';
    const original = content.judges[0].criteria[0].reasoning;

    const { content: repaired, repairs } = repairContent(content, [], undefined, { mode: 'editorial' });
    expect((repaired as any).judges[0].criteria[0].reasoning).toBe(original);
    expect(repairs.map(r => r.code)).not.toContain('LOW_CONFIDENCE_REASONING_CALIBRATED');
    expect(repairs.map(r => r.code)).not.toContain('LOW_CONFIDENCE_LIMITATIONS_BACKFILLED');
    expect(repairs.map(r => r.code)).not.toContain('CALIBRATED_LANGUAGE_APPLIED');
  });

  it('does not rewrite absolute wording that the audit pipeline used to substitute', () => {
    const content = editorialContent();
    content.judges[0].strengths = ['The onboarding is close to perfect, and obviously deliberate.'];

    const { content: repaired } = repairContent(content, [], undefined, { mode: 'editorial' });
    expect((repaired as any).judges[0].strengths[0]).toBe('The onboarding is close to perfect, and obviously deliberate.');
  });

  describe('system protection survives', () => {
    it('still folds inline markup out of public text', () => {
      const content = editorialContent();
      content.article.standfirst = 'A tool with <script>alert(1)</script> in its docs.';

      const verdict = validate(content, createEditorialFixture().context.evidences);
      expect((verdict.content as any).article.standfirst).not.toContain('<script>');
      expect(verdict.status).toBe('passed');
    });

    it('fails a structurally invalid generation (missing judges)', () => {
      const content = editorialContent();
      content.judges = content.judges.slice(0, 3);

      const verdict = validate(content);
      expect(verdict.status).toBe('failed');
      expect(verdict.errors.some(e => e.code === 'SCHEMA_VALIDATION_FAILED')).toBe(true);
    });

    it('fails an off-grid score', () => {
      const content = editorialContent();
      content.judges[0].criteria[0].score = 3.7;

      const verdict = validate(content);
      expect(verdict.status).toBe('failed');
      expect(verdict.errors.some(e => e.message.includes('steps of 0.5'))).toBe(true);
    });

    it('fails a score present on a not_assessable criterion', () => {
      const content = editorialContent();
      content.judges[0].criteria[0].confidence = 'not_assessable';
      content.judges[0].criteria[0].score = 4;

      const verdict = validate(content);
      expect(verdict.status).toBe('failed');
      expect(verdict.errors.some(e => e.message.includes('not_assessable'))).toBe(true);
    });

    it('fails leaked fixture values', () => {
      const content = editorialContent();
      content.article.jury_summary = 'The repository has 1250 stars.';

      const verdict = validate(content);
      expect(verdict.status).toBe('failed');
      expect(verdict.errors.some(e => e.code === 'FIXTURE_VALUE_LEAKED')).toBe(true);
    });

    it('still pins scores against human edits', () => {
      const original = editorialContent();
      const edited = editorialContent();
      edited.judges[0].criteria[0].score = 1;

      const verdict = validateContent({
        content: edited,
        originalContent: original,
        evidences: [],
        humanEdited: true,
        promptVersion: EDITORIAL_PROMPT
      });
      expect(verdict.status).toBe('failed');
      expect(verdict.errors.some(e => e.code === 'IMMUTABLE_JUDGMENT_FIELD_CHANGED')).toBe(true);
    });
  });

  describe('no prose rules exist for editorial content', () => {
    const source = readFileSync('src/lib/generation/validator.ts', 'utf8');
    const editorialBranch = source.slice(source.indexOf('function validateEditorialContent'));

    it('the editorial branch calls no wording, claim or recommendation validator', () => {
      for (const forbidden of [
        'buildTrustedClaimReferences',
        'findAbsoluteAssertions',
        'collectRecommendationFindings',
        'classifyClaimError'
      ]) {
        expect(editorialBranch).not.toContain(forbidden);
      }
    });
  });
});

/**
 * The evidence mapper's contract is one-way: it records, it never edits. These cases pin the
 * structural properties that make that true regardless of what the model returns.
 */
describe('Evidence mapper (Request 2) — record keeper only', () => {
  const fixture = createEditorialFixture();
  const evidences = fixture.context.evidences;
  const articleHash = 'a'.repeat(64);

  function statements() {
    return segmentArticleStatements(fixture.generatedOutput, evidences);
  }

  function ingest(mapping: any[], content: any = fixture.generatedOutput) {
    return ingestMappingResponse({
      articleHash,
      mappedAt: '2026-07-19T00:00:00.000Z',
      model: 'mapping-model',
      statements: segmentArticleStatements(content, evidences),
      evidences,
      parsed: { article_hash: articleHash, mapping }
    });
  }

  it('segments the article deterministically', () => {
    expect(statements()).toEqual(statements());
    expect(statements().length).toBeGreaterThan(0);
  });

  it('authors statement_text itself, so a model can never mismatch a sentence', () => {
    const all = statements();
    const map = ingest(all.map(s => ({
      statement_id: s.statementId,
      classification: 'editorial_judgment' as const,
      evidence_ids: [],
      support: 'none' as const,
      note: null
    })));

    expect(map.status).toBe('complete');
    for (const claim of map.claims) {
      const source = all.find(s => s.path === claim.public_output_path && s.statementIndex === claim.statement_index);
      expect(claim.statement_text).toBe(source!.text);
    }
  });

  it('drops entries for unknown statement ids instead of failing', () => {
    const all = statements();
    const map = ingest([
      { statement_id: 999999, classification: 'directly_supported', evidence_ids: [], support: 'none', note: null },
      ...all.map(s => ({ statement_id: s.statementId, classification: 'editorial_judgment' as const, evidence_ids: [], support: 'none' as const, note: null }))
    ]);

    expect(map.status).toBe('complete');
    expect(map.claims).toHaveLength(all.length);
  });

  it('filters evidence ids that do not exist in the bundle', () => {
    const all = statements();
    const map = ingest(all.map((s, index) => ({
      statement_id: s.statementId,
      classification: 'directly_supported' as const,
      evidence_ids: index === 0 ? ['ev-api', 'ev-does-not-exist'] : [],
      support: 'strong' as const,
      note: null
    })));

    expect(map.claims[0].evidence_ids).toEqual(['ev-api']);
  });

  it('records skipped statements as unmapped and degrades to partial', () => {
    const all = statements();
    const map = ingest(all.slice(1).map(s => ({
      statement_id: s.statementId,
      classification: 'editorial_judgment' as const,
      evidence_ids: [],
      support: 'none' as const,
      note: null
    })));

    expect(map.status).toBe('partial');
    expect(map.unmapped_statements).toHaveLength(1);
    expect(map.unmapped_statements[0].reason).toBe('model_skipped');
  });

  it('surfaces contradictions as data without touching the article', () => {
    const all = statements();
    const before = JSON.parse(JSON.stringify(fixture.generatedOutput));
    const map = ingest(all.map((s, index) => ({
      statement_id: s.statementId,
      classification: index === 0 ? ('contradicted_by_evidence' as const) : ('editorial_judgment' as const),
      evidence_ids: index === 0 ? ['ev-readme'] : [],
      support: index === 0 ? ('strong' as const) : ('none' as const),
      note: index === 0 ? 'The README states the opposite.' : null
    })));

    expect(map.contradictions).toHaveLength(1);
    expect(map.claims[0].classification).toBe('contradicted_by_evidence');
    // The article is untouched: mapping is a record, not an edit.
    expect(fixture.generatedOutput).toEqual(before);
  });

  it('lists every collected evidence in evidence_usage, cited or not', () => {
    const all = statements();
    const map = ingest(all.map(s => ({
      statement_id: s.statementId,
      classification: 'editorial_judgment' as const,
      evidence_ids: [],
      support: 'none' as const,
      note: null
    })));

    expect(map.evidence_usage.map(u => u.evidence_id).sort())
      .toEqual(evidences.map(e => e.evidence_id).sort());
    expect(map.evidence_usage.every(u => u.cited_by_claims === 0)).toBe(true);
  });

  it('never asks the model to score, judge, or rewrite', () => {
    const source = readFileSync('src/lib/evaluation/evidence-mapper.ts', 'utf8');
    expect(source).toContain('Do not rewrite, rephrase, shorten, or "fix" any statement.');
    expect(source).toContain('Do not judge whether the article is good, fair, safe, or publishable.');
    expect(source).toContain('Do not change, comment on, or recompute any score.');
  });
});

/**
 * data.ts re-runs recalculateScores on EVERY review at EVERY site build — without an
 * integrityContext — and throws on any numeric mismatch against the published values. So a
 * V3 recalculation that is not pure and deterministic from the evaluation content alone is
 * not a subtle bug: it is a site build that fails for every article at once.
 */
describe('V3 score recalculation is build-safe', () => {
  const fixture = createEditorialFixture();

  it('reproduces every published number without the integrity context', () => {
    const evaluator = new Evaluator();
    const published: any = fixture.review.evaluation;
    // Exactly how data.ts calls it at build time: no integrityContext.
    const rebuilt: any = evaluator.recalculateScores(published, fixture.context.evidences, fixture.review);

    expect(rebuilt.recalculated_jury_score).toBe(published.recalculated_jury_score);
    expect(rebuilt.overall_evidence_confidence).toBe(published.overall_evidence_confidence);
    expect(rebuilt.judge_score_range).toEqual(published.judge_score_range);
    expect(rebuilt.criterion_averages).toEqual(published.criterion_averages);
    for (const [index, judge] of rebuilt.judges.entries()) {
      expect(judge.judge_score).toBe(published.judges[index].judge_score);
      for (const [criterionIndex, criterion] of judge.criteria.entries()) {
        expect(criterion.weighted_score).toBe(published.judges[index].criteria[criterionIndex].weighted_score);
      }
    }
  });

  it('is idempotent across repeated builds', () => {
    const evaluator = new Evaluator();
    const once: any = evaluator.recalculateScores(fixture.review.evaluation, fixture.context.evidences, fixture.review);
    const twice: any = evaluator.recalculateScores(once, fixture.context.evidences, fixture.review);
    expect(twice).toEqual(once);
  });

  it('forces technical quality Not Assessable when generation collected no source evidence', () => {
    // The Grok Build failure: the model scored technical quality at high confidence with no
    // source-code evidence. At generation (integrityContext present) code overrides that.
    const evaluator = new Evaluator();
    const evidencesNoSource = fixture.context.evidences.filter(e => e.type !== 'source_code');
    const out: any = evaluator.recalculateScores(
      JSON.parse(JSON.stringify(fixture.generatedOutput)),
      evidencesNoSource,
      { prompt_version: '4.0.0' },
      { integrityContext: { ...fixture.context, evidences: evidencesNoSource } }
    );
    expect(out.core_source_evidence.source_count).toBe(0);
    // One Not Assessable criterion nulls the whole score — the review will be evidence_limited
    // and unranked, exactly as the methodology says.
    expect(out.recalculated_jury_score).toBeNull();
    for (const judge of out.judges) {
      const tq = judge.criteria.find((c: any) => c.criterion_id === 'technical_quality');
      expect(tq.confidence).toBe('not_assessable');
      expect(tq.score).toBeNull();
    }
  });

  it('does NOT re-enforce at build time, so a pre-enforcement review still recomputes to its published score', () => {
    // The load-bearing build-safety property. A review published before this rule can have a
    // real jury_score AND a persisted source_count of 0 (the collector missed its language).
    // The build-time recompute must reproduce that score, not null it — review.json is
    // immutable, and a mismatch is a site build that fails for that article. Such reviews are
    // dropped from the rankings at read time instead (ranking-eligibility), never here.
    const evaluator = new Evaluator();
    const published: any = JSON.parse(JSON.stringify(fixture.review.evaluation));
    published.core_source_evidence.source_count = 0;
    const rebuilt: any = evaluator.recalculateScores(published, fixture.context.evidences, fixture.review);
    expect(rebuilt.recalculated_jury_score).toBe(published.recalculated_jury_score);
    expect(rebuilt.recalculated_jury_score).not.toBeNull();
  });

  it('never stamps evaluation_integrity_version onto a V3 evaluation', () => {
    // A V3 review carrying the refined marker would be routed into the audit-era dispatch by
    // validate-content.ts and [slug].astro, which is a hard site-build failure.
    const evaluator = new Evaluator();
    const rebuilt: any = evaluator.recalculateScores(
      fixture.review.evaluation,
      fixture.context.evidences,
      fixture.review,
      { integrityContext: fixture.context }
    );
    expect(rebuilt.evaluation_integrity_version).toBeUndefined();
  });
});

/**
 * The wire schema is the ONE remaining fail-closed gate on a first attempt. A schema Gemini
 * cannot satisfy is not a validation error — it is a 400 with no article at all, which is
 * precisely how this pipeline reached a 0% first-attempt pass rate before. So the editorial
 * wire schema is held to the construct set of the 2.x schema that is proven in production,
 * and every structural rule it therefore omits is asserted app-side instead.
 */
describe('V3 wire schema stays within the proven construct set', () => {
  function constructsUsed(schema: any): string[] {
    const serialized = JSON.stringify(zodToJsonSchema(schema, { $refStrategy: 'none' }));
    const matches = serialized.matchAll(/"(anyOf|oneOf|allOf|not|minItems|maxItems|minimum|maximum|minLength|maxLength|pattern|format)"/g);
    return [...new Set([...matches].map(m => m[1]))].sort();
  }

  it('uses no construct the production-proven 2.1.0 schema does not', () => {
    const proven = new Set(constructsUsed(EvaluationOutputGenSchemaV2_1));
    for (const construct of constructsUsed(EvaluationOutputGenSchemaV3)) {
      expect(proven.has(construct), `V3 wire schema introduces "${construct}", unproven against structured output`).toBe(true);
    }
  });

  it('emits no union type anywhere, including for the nullable score', () => {
    const serialized = JSON.stringify(zodToJsonSchema(EvaluationOutputGenSchemaV3, { $refStrategy: 'none' }));
    expect(serialized).not.toMatch(/"(anyOf|oneOf|allOf)"/);
    expect(serialized).not.toContain('$ref');
    const score = (zodToJsonSchema(EvaluationOutputGenSchemaV3, { $refStrategy: 'none' }) as any)
      .properties.judges.items.properties.criteria.items.properties.score;
    expect(score).toEqual({ type: ['number', 'null'] });
  });

  it('the mapping wire schema is equally plain', () => {
    const serialized = JSON.stringify(zodToJsonSchema(EvidenceMapGenSchema, { $refStrategy: 'none' }));
    expect(serialized).not.toMatch(/"(anyOf|oneOf|allOf)"/);
    expect(serialized).not.toContain('$ref');
  });

  describe('the app-side gate enforces everything the wire schema no longer states', () => {
    const criteria = () => [
      'purpose_usefulness', 'implementation_evidence', 'technical_quality',
      'usability_onboarding', 'differentiation_insight', 'project_health_stewardship'
    ].map(criterion_id => ({ criterion_id, score: 4, confidence: 'medium', reasoning: 'r', limitations: [] }));
    const judge = (judge_id: string) => ({
      judge_id, judge_name: 'n', role: 'r', verdict: 'v', strengths: [], concerns: [],
      recommended_next_step: { action: 'a', criterion_id: 'purpose_usefulness' },
      criteria: criteria()
    });
    const evaluation = (judges: any[]) => ({
      schema_version: '3.0.0',
      product: { name: 'x', category: 'x', summary: 'x', primary_audience: 'x' },
      article: {
        headline: 'x', standfirst: 'x', jury_summary: 'x', where_jury_agreed: [],
        where_jury_disagreed: [], evidence_limitations: [], final_verdict: 'x', meta_description: 'x'
      },
      judges
    });
    const FIVE = ['alex', 'david', 'lisa', 'sarah', 'marcus'];

    it('accepts a well-formed five-judge evaluation', () => {
      expect(EvaluationOutputSchemaV3.safeParse(evaluation(FIVE.map(judge))).success).toBe(true);
    });

    it('rejects a sixth judge even when it duplicates an existing id', () => {
      // Uniqueness alone would pass this: six judges, five distinct ids.
      expect(EvaluationOutputSchemaV3.safeParse(evaluation([...FIVE, 'alex'].map(judge))).success).toBe(false);
    });

    it('rejects a judge scoring the wrong number of criteria', () => {
      const short = evaluation(FIVE.map(judge));
      short.judges[0].criteria = short.judges[0].criteria.slice(0, 5);
      expect(EvaluationOutputSchemaV3.safeParse(short).success).toBe(false);
    });

    it('rejects a score outside 0..5', () => {
      const bad = evaluation(FIVE.map(judge));
      bad.judges[0].criteria[0].score = 9;
      expect(EvaluationOutputSchemaV3.safeParse(bad).success).toBe(false);
    });
  });
});

/**
 * Regressions for defects the adversarial review found in this change. Each one is a rule an
 * ordinary, correct article could trip and could not satisfy — the exact failure class the
 * editorial pipeline exists to eliminate, reintroduced by accident.
 */
describe('Review regressions — no gate an honest article cannot pass', () => {
  function editorialContent(): any {
    return JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  }
  function validate(content: any) {
    return validateContent({
      content, originalContent: content, evidences: [], humanEdited: false, promptVersion: '4.0.0'
    });
  }

  it('does not reject real repository metrics that merely contain a fixture number', () => {
    // "1250" and "106" were substring-matched against the whole article. A project with
    // 1,060 stars or 106,000 downloads is not a fixture leak.
    const content = editorialContent();
    content.article.jury_summary = 'With 1,060 stars and 106,000 downloads, adoption is real but early.';
    content.judges[0].verdict = 'A commit count of 1250 across two years says something about pace.';

    const verdict = validate(content);
    expect(verdict.errors.filter(e => e.code === 'FIXTURE_VALUE_LEAKED')).toEqual([]);
    expect(verdict.status).toBe('passed');
  });

  it('still rejects the actual fixture values', () => {
    const content = editorialContent();
    content.article.jury_summary = 'The repository shows 1250 stars.';
    expect(validate(content).errors.some(e => e.code === 'FIXTURE_VALUE_LEAKED')).toBe(true);
  });

  it('does not fail on angle brackets that only form a tag once fields are concatenated', () => {
    // Each field is clean; only JSON.stringify's separators put a '<' and a '>' in sequence.
    // A whole-document scan makes this unsatisfiable — no per-field repair can fix it.
    const content = editorialContent();
    content.article.standfirst = 'It scales to <n workers before contention shows.';
    content.article.final_verdict = 'Adopt it when the ratio is 3>2 in your workload. Skip it otherwise. It earns its scope.';

    const verdict = validate(content);
    expect(verdict.errors.filter(e => e.code === 'HTML_TAGS_IN_OUTPUT')).toEqual([]);
    expect(verdict.status).toBe('passed');
  });

  it('still reports markup that survives repair inside a single field', () => {
    const defects = findSystemProtectionDefects({ article: { headline: 'A <b>bold</b> claim' } });
    expect(defects.some(d => d.code === 'HTML_TAGS_IN_OUTPUT')).toBe(true);
  });

  it('keeps the publication date when an edit fails validation', () => {
    // Losing it sends the republish into a different year/month directory, leaving two
    // directories with the same slug and failing the whole site build on a duplicate.
    const published: any = {
      ...baseRecord(),
      publication: { status: 'published', reason: null, publishedAt: '2026-07-18T04:47:36.162Z' }
    };
    const failing = applyVerdict(published, {
      content: {}, status: 'failed',
      errors: [{ code: 'X', path: '$', message: 'm', severity: 'error', ruleVersion: '3.0.0' }],
      warnings: [], repairs: [], contentHash: 'b'.repeat(64)
    } as any, '2026-08-03T00:00:00.000Z');

    expect(failing.publication.status).toBe('excluded');
    expect(failing.publication.publishedAt).toBe('2026-07-18T04:47:36.162Z');
  });
});

/** Minimal well-formed record for applyVerdict, which only reads editorial/quality/publication. */
function baseRecord(): any {
  return {
    schemaVersion: 1,
    recordId: 'season-2-manual-1',
    candidate: { id: 'c', runKey: 'season-2-manual-1', canonicalUrl: null, name: null },
    slug: 'a-slug',
    generation: {
      status: 'succeeded', receivedAt: '2026-07-18T00:00:00.000Z', model: 'm', modelVersion: 'm',
      promptVersion: '4.0.0', promptHash: 'a'.repeat(64), rawResponse: '{}', originalContent: {},
      recoveredBaseline: null, baselineRecovery: null,
      usage: { promptTokens: null, completionTokens: null, totalTokens: null, thinkingTokens: null, cachedInputTokens: null },
      route: null
    },
    editorial: {
      mode: 'autonomous', currentRevision: 0, currentContent: {},
      revisions: [{ revision: 0, source: 'gemini', createdAt: '2026-07-18T00:00:00.000Z', contentHash: 'a'.repeat(64) }]
    },
    quality: {
      status: 'passed', checkedAt: '2026-07-18T00:00:00.000Z', validatorVersion: '3.0.0',
      validatedRevision: 0, validatedContentHash: 'a'.repeat(64),
      errors: [], warnings: [], repairs: [], history: []
    },
    publication: { status: 'pending', reason: null, publishedAt: null }
  };
}

describe('Evidence mapper resilience', () => {
  const fixture = createEditorialFixture();

  it('drops one malformed entry instead of discarding the whole map', () => {
    const statements = segmentArticleStatements(fixture.generatedOutput, fixture.context.evidences);
    const mapping: any[] = statements.map(s => ({
      statement_id: s.statementId, classification: 'editorial_judgment',
      evidence_ids: [], support: 'none', note: null
    }));
    // One entry the model got wrong: an invented classification.
    mapping[1] = { ...mapping[1], classification: 'definitely_true' };

    const map = ingestMappingResponse({
      articleHash: 'c'.repeat(64), mappedAt: '2026-07-19T00:00:00.000Z', model: 'm',
      statements, evidences: fixture.context.evidences,
      parsed: { article_hash: 'c'.repeat(64), mapping }
    });

    expect(map.status).toBe('partial');
    expect(map.claims.length).toBe(statements.length - 1);
    expect(map.unmapped_statements).toHaveLength(1);
    expect(map.unmapped_statements[0].reason).toBe('entry_invalid');
  });
});
