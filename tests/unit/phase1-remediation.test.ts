import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareCandidateWithIntegrityContext, finalizeRefinedEvaluation } from '../../src/lib/daily-evaluation';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { validateRefinedReviewIntegrity } from '../../src/lib/publication-integrity';
import { ReviewSchema, RefinedReviewSchemaV2 } from '../../src/schemas/review';
import { RunStateSchema } from '../../src/schemas/selection';
import { segmentStatements } from '../../src/lib/evaluation/public-claims';
import { createRefinedFixture } from '../fixtures/refined-review';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

// --- helpers for mutating a fully-covered review while keeping coverage intact ---

function setFieldByPath(root: any, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = root;
  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    if (part === '__proto__' || part === 'constructor' || part === 'prototype') {
      throw new Error(`unsafe path segment: ${part}`);
    }
    const key = /^\d+$/.test(part) ? Number(part) : part;
    if (i === parts.length - 1) {
      cur[key] = value;
    } else {
      cur = cur[key];
    }
  }
}

type Spec = { support_mode: string; fact_class: string; attribution_required: boolean; evidence_ids: string[] };
const REPO_OBS: Spec = { support_mode: 'evidence_backed', fact_class: 'repository_observation', attribution_required: false, evidence_ids: ['ev-source-1'] };
const API_FACT: Spec = { support_mode: 'evidence_backed', fact_class: 'confirmed_fact', attribution_required: false, evidence_ids: ['ev-api'] };
const UNVERIFIED: Spec = { support_mode: 'unverified', fact_class: 'unverified', attribution_required: false, evidence_ids: [] };

/** Sets a covered public field's text and rebuilds its statement references so coverage holds. */
function coverField(review: any, path: string, text: string, spec: Spec): void {
  setFieldByPath(review.evaluation, path, text);
  const statements = segmentStatements(text);
  review.evaluation.claim_references = review.evaluation.claim_references.filter((r: any) => r.public_output_path !== path);
  statements.forEach((statement, index) => {
    review.evaluation.claim_references.push({
      claim_id: `test-${path}-${index}`, public_output_path: path, statement_index: index, statement_text: statement,
      support_mode: spec.support_mode, fact_class: spec.fact_class, attribution_required: spec.attribution_required,
      evidence_ids: spec.evidence_ids, coverage_source: 'statement_annotation'
    });
  });
}

/** Removes a public field's annotations from raw generation output (for omission tests). */
function dropAnnotations(raw: any, path: string): void {
  raw.public_statement_annotations = raw.public_statement_annotations.filter((a: any) => a.public_output_path !== path);
}

describe('Phase 1 trusted integrity context', () => {
  it('preserves canonical identity, snapshot, and discussion in the daily candidate context', () => {
    const { context } = createRefinedFixture();
    const candidate = {
      source: 'show_hn', sourceId: '1', name: 'Untrusted Source Name',
      canonicalUrl: 'https://github.com/example/refined-product',
      sourceUrl: 'https://news.ycombinator.com/item?id=1', sourceRank: 1,
      popularityValue: 42, popularityUnit: 'stars', collectedAt: '2026-07-16T00:00:00.000Z', metadata: {}
    };
    const prepared = prepareCandidateWithIntegrityContext(candidate, context);
    expect(prepared.context).toEqual(context);
    expect(prepared.candidate.metadata.project_identity).toEqual(context.project_identity);
    expect(prepared.candidate.metadata.metadata_snapshot).toEqual(context.metadata_snapshot);
  });

  it('persists the complete collection result in run state', () => {
    const { context } = createRefinedFixture();
    const parsed = RunStateSchema.parse({
      schema_version: '1.0.0', data_class: 'production', status: 'selected',
      run_key: 'run', collection_result: context
    });
    expect(parsed.collection_result?.project_identity.canonical_display_name).toBe('Refined Product');
    expect(parsed.collection_result?.discussion_evidence).toEqual({ items: [] });
  });

  it('injects trusted identity even when Gemini omits project_identity', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.product.name = 'Gemini Name';
    const result = finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0');
    expect(result.product.name).toBe('Refined Product');
    expect(result.project_identity).toEqual(context.project_identity);
    expect(result.metadata_snapshot).toEqual(context.metadata_snapshot);
  });

  it('applies the 0.66 ceiling from explicit context when Gemini omits integrity fields', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.judges.forEach((judge: any) => judge.criteria.forEach((criterion: any) => { criterion.confidence = 'high'; }));
    const result = finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0');
    expect(result.overall_evidence_confidence).toBeLessThanOrEqual(0.66);
  });

  it('fails closed when the trusted collection context is incomplete', () => {
    const { context } = createRefinedFixture();
    expect(() => prepareCandidateWithIntegrityContext({
      source: 'github', sourceId: '1', name: 'Product', canonicalUrl: 'https://github.com/example/product',
      sourceUrl: 'https://github.com/example/product', sourceRank: 1, popularityValue: 1,
      popularityUnit: 'stars', collectedAt: '2026-07-16T00:00:00.000Z', metadata: {}
    }, { ...context, metadata_snapshot: undefined } as any)).toThrow(/metadata snapshot/i);
  });

  it('keeps legacy reviews readable without refined fields (regression 16)', () => {
    const legacy = JSON.parse(readFileSync('tests/fixtures/reviews/2026/07/fixture-product/review.json', 'utf8'));
    expect(ReviewSchema.parse(legacy).schema_version).toBe('1.0.0');
  });
});

describe('Phase 1 publication gate — invariants preserved', () => {
  it('accepts the fully covered refined fixture (regression 15)', () => {
    const { review, bundle } = createRefinedFixture();
    expect(() => validateRefinedReviewIntegrity(review, bundle, review.slug)).not.toThrow();
  });

  it('rejects matching snapshot IDs with different values', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.metadata_snapshot.stars += 1;
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug)).toThrow(/Snapshot content mismatch/i);
  });

  it.each([
    ['999 open issues', 'The repository has 999 open issues.'],
    ['open issues: 999', 'Backlog stats — open issues: 999'],
    ['comma-formatted', 'The repository has 1,999 open issues.'],
    ['case-insensitive', 'The repository has 999 Open Issues.']
  ])('rejects an open issues count that contradicts the snapshot (%s)', (_label, text) => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.article.standfirst = text;
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug)).toThrow(/Inconsistent open issues count/i);
  });

  it.each([
    ['number first', (snapshot: any) => `The repository has ${snapshot.open_issues} open issues.`],
    ['label first', (snapshot: any) => `Backlog stats — open issues: ${snapshot.open_issues}`]
  ])('accepts an open issues count that matches the snapshot (%s)', (_label, render) => {
    const { review, bundle } = createRefinedFixture();
    const valid = clone(review);
    coverField(valid, 'article.standfirst', render(valid.evaluation.metadata_snapshot), API_FACT);
    expect(() => validateRefinedReviewIntegrity(valid, bundle, valid.slug)).not.toThrow();
  });

  it('rejects a forks count that contradicts the snapshot', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.article.standfirst = 'The project has 999 forks.';
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug)).toThrow(/Inconsistent forks count/i);
  });

  it('does not treat a documented README command as verified execution', () => {
    const { review } = createRefinedFixture();
    expect(review.evaluation.test_evidence_summary.documented_test_commands).toContain('npm test');
    expect(review.evaluation.test_evidence_summary.verified_execution_results).toEqual([]);
    expect(review.evaluation.test_evidence_summary.confidence).not.toBe('HIGH');
    expect(review.evaluation.overall_evidence_confidence).toBeLessThanOrEqual(0.66);
  });

  it('rejects missing claim references for a refined review', () => {
    const { review } = createRefinedFixture();
    const invalid = clone(review);
    delete invalid.evaluation.claim_references;
    expect(() => RefinedReviewSchemaV2.parse(invalid)).toThrow(/claim_references/i);
  });

  it('keeps the single Gemini call and primary/fallback routing intact (regressions 17, 18)', () => {
    const source = readFileSync('src/lib/evaluation/evaluator.ts', 'utf8');
    expect((source.match(/\.generateContent\(/g) || []).length).toBe(1);
    expect(source).toContain('GEMINI_FALLBACK_API_KEY');
    expect(source).toContain("route = 'fallback'");
    expect(source).toContain('GEMINI_PRIMARY_MAX_ATTEMPTS');
  });

  it('uses canonical product names for search, RSS, and latest JSON output', () => {
    const searchSource = readFileSync('src/lib/review-archive.ts', 'utf8');
    const rssSource = readFileSync('src/pages/rss.xml.ts', 'utf8');
    const latestSource = readFileSync('src/pages/reviews/latest.json.ts', 'utf8');
    expect(searchSource).toContain('entry.review.evaluation.product.name');
    expect(rssSource).toContain('r.review.evaluation.product.name');
    expect(latestSource).toContain('latest.review.evaluation.product.name');
    expect(`${rssSource}\n${latestSource}`).not.toContain('selection.candidate_name');
  });
});

describe('Phase 1 statement provenance — fail-closed regressions', () => {
  // Regression 1 + canonical negative fixture.
  it('fails the canonical bypass: an unannotated second sentence stating an unattributed creator claim', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.article.final_verdict = 'According to the README, it is a CLI. It has been independently proven secure.';
    dropAnnotations(raw, 'article.final_verdict');
    raw.public_statement_annotations.push({
      public_output_path: 'article.final_verdict', statement_text: 'According to the README, it is a CLI.',
      support_mode: 'evidence_backed', evidence_ids: ['ev-readme']
    });
    // Sentence 2 is left unannotated: fail-closed at generation.
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/statement 1 .*has no evidence-backed provenance annotation/i);
  });

  it('and the same canonical bypass fails at the publication gate when persisted', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.article.final_verdict = 'According to the README, it is a CLI. It has been independently proven secure.';
    invalid.evaluation.claim_references = invalid.evaluation.claim_references.filter((r: any) => r.public_output_path !== 'article.final_verdict');
    invalid.evaluation.claim_references.push({
      claim_id: 'v0', public_output_path: 'article.final_verdict', statement_index: 0,
      statement_text: 'According to the README, it is a CLI.', support_mode: 'evidence_backed',
      fact_class: 'creator_claim', attribution_required: true, evidence_ids: ['ev-readme'], coverage_source: 'statement_annotation'
    });
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/statement 1 .*is not covered/i);
  });

  // Regression 2.
  it('rejects an annotation whose statement_text is only "According to"', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    dropAnnotations(raw, 'article.jury_summary');
    raw.public_statement_annotations.push({
      public_output_path: 'article.jury_summary', statement_text: 'According to', support_mode: 'evidence_backed', evidence_ids: ['ev-readme']
    });
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/matches no statement of that field/i);
  });

  // Regression 3.
  it('fails when product.primary_audience is left unannotated', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    dropAnnotations(raw, 'product.primary_audience');
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/product\.primary_audience statement 0 .*has no evidence-backed provenance annotation/i);
  });

  // Regression 4.
  it('fails an unannotated creator claim in judges[0].strengths[0]', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.judges[0].strengths[0] = 'The tool is the fastest CLI available and has zero known vulnerabilities.';
    dropAnnotations(raw, 'judges.0.strengths.0');
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/judges\.0\.strengths\.0 statement 0 .*has no evidence-backed provenance annotation/i);
  });

  // Regression 5.
  it('fails a decisive_question smuggling an unhedged factual premise', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.judges[0].decisive_question = 'Given that the tool is proven secure, how will it scale?';
    dropAnnotations(raw, 'judges.0.decisive_question');
    raw.public_statement_annotations.push({
      public_output_path: 'judges.0.decisive_question', statement_text: 'Given that the tool is proven secure, how will it scale?',
      support_mode: 'unverified', evidence_ids: []
    });
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/unverified but uses no absence wording/i);
  });

  // Regression 6.
  it('fails an unannotated claim in a criterion limitation', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.judges[0].criteria[0].limitations[0] = 'The tool has zero memory leaks.';
    dropAnnotations(raw, 'judges.0.criteria.0.limitations.0');
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/limitations\.0 statement 0 .*has no evidence-backed provenance annotation/i);
  });

  // Regression 7.
  it('fails an unannotated claim in article.evidence_limitations', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.article.evidence_limitations[0] = 'The tool is fully secure and audited.';
    dropAnnotations(raw, 'article.evidence_limitations.0');
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/evidence_limitations\.0 statement 0 .*has no evidence-backed provenance annotation/i);
  });

  // Regression 8.
  it('rejects persisting a README evidence as a confirmed classification', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.article.evidence_classifications.push({ evidence_id: 'ev-readme', classification: 'source_confirmed', claim: 'The tool is a production-ready CLI.' });
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/evidence_classifications are not the application-derived set/i);
  });

  // Regression 9.
  it('fails a creator claim whose attribution lives in a different statement', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.article.final_verdict = 'According to the README, the project has a license. The tool eliminates all security risk.';
    dropAnnotations(raw, 'article.final_verdict');
    raw.public_statement_annotations.push(
      { public_output_path: 'article.final_verdict', statement_text: 'According to the README, the project has a license.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] },
      { public_output_path: 'article.final_verdict', statement_text: 'The tool eliminates all security risk.', support_mode: 'evidence_backed', evidence_ids: ['ev-readme'] }
    );
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/statement itself carries no attribution/i);
  });

  // Regression 10.
  it('preserves community opinion as community_opinion through to the public classification', () => {
    const { context, generatedOutput } = createRefinedFixture();
    context.evidences.push({
      evidence_id: 'ev-discussion', type: 'source_discussion', url: 'https://news.ycombinator.com/item?id=1',
      title: 'Discussion', retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: 'disc-hash',
      summary: 'Reliability discussion.', claims: [{ claim_id: 'ev-disc-default', text: 'A commenter questioned reliability.', claim_type: 'community_opinion' }]
    } as any);
    const raw = clone(generatedOutput);
    raw.judges[0].concerns[0] = 'Commenters flagged a reliability concern in the discussion.';
    dropAnnotations(raw, 'judges.0.concerns.0');
    raw.public_statement_annotations.push({
      public_output_path: 'judges.0.concerns.0', statement_text: 'Commenters flagged a reliability concern in the discussion.',
      support_mode: 'evidence_backed', evidence_ids: ['ev-discussion']
    });
    const result = finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0');
    const cls = result.article.evidence_classifications.find((c: any) => c.evidence_id === 'ev-discussion');
    expect(cls?.classification).toBe('community_opinion');
    const ref = result.claim_references.find((r: any) => r.public_output_path === 'judges.0.concerns.0');
    expect(ref.fact_class).toBe('community_opinion');
    expect(ref.attribution_required).toBe(true);
  });

  // Regression 11.
  it('keeps a repository observation and an inference on the same evidence as distinct classes', () => {
    const { review } = createRefinedFixture();
    const agreedRef = review.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.0');
    const standfirstRef = review.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.standfirst');
    expect(agreedRef.evidence_ids).toEqual(['ev-source-1']);
    expect(standfirstRef.evidence_ids).toEqual(['ev-source-1']);
    expect(agreedRef.fact_class).toBe('repository_observation');
    expect(standfirstRef.fact_class).toBe('inference');
  });

  // Regression 12.
  it('preserves an unverified statement as unverified', () => {
    const { review } = createRefinedFixture();
    const ref = review.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.evidence_limitations.0');
    expect(ref.support_mode).toBe('unverified');
    expect(ref.fact_class).toBe('unverified');
    expect(ref.evidence_ids).toEqual([]);
  });

  // Regression 13.
  it('rejects an annotation citing a non-existent evidence id', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    const ann = raw.public_statement_annotations.find((a: any) => a.public_output_path === 'article.jury_summary');
    ann.evidence_ids = ['ev-does-not-exist'];
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/references missing evidence "ev-does-not-exist"/i);
  });

  // Regression 14.
  it('rejects a persisted reference that relabels its evidence fact class', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    const ref = invalid.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.0');
    ref.fact_class = 'confirmed_fact'; // evidence is source_code -> repository_observation
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug)).toThrow(/changes fact class/i);
  });

  it('rejects a persisted reference that forges attribution on a repository observation', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    const ref = invalid.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.0');
    ref.attribution_required = true;
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug)).toThrow(/misstates attribution_required/i);
  });
});

describe('Phase 1 adversarial hardening', () => {
  // Segmenter: a non-ASCII / no-space terminator must not merge two reader-visible sentences.
  it('splits a Unicode full stop so a laundered second sentence fails closed', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.article.final_verdict = 'No verified runtime result was collected․ It has been independently proven secure.';
    dropAnnotations(raw, 'article.final_verdict');
    raw.public_statement_annotations.push({
      public_output_path: 'article.final_verdict', statement_text: 'No verified runtime result was collected.',
      support_mode: 'unverified', evidence_ids: []
    });
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/statement 1 .*has no evidence-backed provenance annotation/i);
  });

  it('splits a run-together "secure.It" sentence pair', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.article.final_verdict = 'The evidence could not confirm the claim.It has been independently proven secure.';
    dropAnnotations(raw, 'article.final_verdict');
    raw.public_statement_annotations.push({
      public_output_path: 'article.final_verdict', statement_text: 'The evidence could not confirm the claim.',
      support_mode: 'unverified', evidence_ids: []
    });
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/statement 1 .*has no evidence-backed provenance annotation/i);
  });

  // Semicolon: a hedge clause cannot license an asserting clause in the same statement.
  it('splits a semicolon so an unhedged clause cannot ride an absence clause', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.product.summary = 'The tool is production-ready and enterprise-grade; we could not find any issues.';
    dropAnnotations(raw, 'product.summary');
    raw.public_statement_annotations.push({
      public_output_path: 'product.summary', statement_text: 'The tool is production-ready and enterprise-grade; we could not find any issues.',
      support_mode: 'unverified', evidence_ids: []
    });
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0'))
      .toThrow(/matches no statement of that field/i);
  });

  // Fabricated verified execution: no backing test artifact evidence in the bundle.
  it('rejects a verified execution result with no backing test artifact evidence', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.test_evidence_summary.verified_execution_results = [{
      source: 'fabricated', status: 'success',
      commit_sha: invalid.evaluation.metadata_snapshot.latest_commit_sha, verified_at: '2026-07-16T00:00:00.000Z'
    }];
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/no backing test artifact evidence/i);
  });

  // Judge identity: name/role are pinned to the canonical persona, not model free text.
  it('rejects an injected claim in judge role', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.judges[0].role = 'Principal Engineer who verified all tests pass and confirmed 42000 stars';
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/name\/role do not match the canonical persona/i);
  });

  it('rejects an injected fabricated metric in judge name', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.judges[1].judge_name = 'David (confirmed 42000 stars and flawless security)';
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/name\/role do not match the canonical persona/i);
  });

  // Segmenter round 2: property-based Unicode terminators, closing punctuation, invisible chars.
  it.each([
    ['double exclamation U+203C', 'The system is fully secure and production-ready‼ It could not be verified.'],
    ['ellipsis U+2026', 'The tool is flawless… It could not be verified.'],
    ['devanagari danda', 'The tool is flawless। It could not be verified.'],
    ['closing quote then sentence', 'The tool is flawless.” It could not be verified.'],
    ['zero-width space after period', 'The system is production-ready.​ It could not be verified.'],
    ['digit-fused next sentence', 'The evidence could not be verified.42 tests pass reliably.']
  ])('splits a %s so the trailing assertion is a separate uncovered statement', (_label, verdict) => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    raw.article.final_verdict = verdict;
    dropAnnotations(raw, 'article.final_verdict');
    // Annotate only the first (benign) statement; the trailing assertion must fail closed.
    const first = segmentStatements(verdict)[0];
    raw.public_statement_annotations.push({
      public_output_path: 'article.final_verdict', statement_text: first, support_mode: 'unverified', evidence_ids: []
    });
    expect(() => finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0')).toThrow();
  });

  it('keeps decimals and versions as single statements (no false split)', () => {
    expect(segmentStatements('The jury scored it 3.5 out of 5.')).toHaveLength(1);
    expect(segmentStatements('It requires v1.2 or later.')).toHaveLength(1);
  });

  // criteria[].evidence_ids is rendered "Evidence: …" and must resolve to real bundle evidence.
  it('rejects free-text prose smuggled into a criterion evidence_ids array', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.judges[0].criteria[0].evidence_ids = ['ev-source-1', 'BEST TOOL EVER — independently verified'];
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/cites unknown evidence/i);
  });
});

describe('Phase 1 counter-evidence scope', () => {
  function withDiscussion(items: any[]) {
    const { review, bundle } = createRefinedFixture();
    const nextReview = clone(review);
    const nextBundle = clone(bundle);
    nextBundle.evidences.push({
      evidence_id: 'ev-discussion', type: 'source_discussion', url: 'https://news.ycombinator.com/item?id=1',
      title: 'Discussion', retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: 'discussion-hash',
      summary: 'Discussion analysis.',
      claims: [{ claim_id: 'ev-discussion-default', text: 'Commenters discussed the project.', claim_type: 'community_opinion' }]
    });
    nextReview.evaluation.discussion_evidence = { items };
    return { review: nextReview, bundle: nextBundle };
  }

  function discussionItem(index: number, overrides: Record<string, unknown> = {}) {
    return {
      discussion_item_id: `discussion-${index}`, parent_evidence_id: 'ev-discussion',
      source_url: 'https://news.ycombinator.com/item?id=1',
      excerpt: `Critical comment ${index} about deployment complexity.`,
      fact_class: 'community_opinion', classification: 'critical', materiality_reason_code: 'DEPLOYMENT_COMPLEXITY',
      included_in_model_input: true, requires_public_response: true, ...overrides
    };
  }

  it('does not accept a generic concern as target-specific counter-evidence', () => {
    const { review, bundle } = withDiscussion([discussionItem(1, { excerpt: 'Deployment complexity makes setup difficult.' })]);
    coverField(review, 'judges.0.concerns.0', 'The community raised a concern that could not be verified.', UNVERIFIED);
    review.evaluation.counter_evidence_references = [{
      discussion_item_id: 'discussion-1', parent_evidence_id: 'ev-discussion',
      public_output_path: 'judges.0.concerns.0', target_field: 'judges.0.concerns.0'
    }];
    expect(() => validateRefinedReviewIntegrity(review, bundle, review.slug)).toThrow(/not specifically reflected/i);
  });

  it('does not require a public response for critical comments the model never received', () => {
    const items = [
      ...Array.from({ length: 5 }, (_, index) => discussionItem(index + 1, { excerpt: 'Deployment complexity makes setup difficult.' })),
      discussionItem(6, { included_in_model_input: false, requires_public_response: false })
    ];
    const { review, bundle } = withDiscussion(items);
    coverField(review, 'judges.0.concerns.0', 'Commenters flagged deployment complexity that could not be fully verified.', UNVERIFIED);
    review.evaluation.counter_evidence_references = items
      .filter(item => item.requires_public_response)
      .map(item => ({ discussion_item_id: item.discussion_item_id, parent_evidence_id: 'ev-discussion', public_output_path: 'judges.0.concerns.0', target_field: 'judges.0.concerns.0' }));
    expect(() => validateRefinedReviewIntegrity(review, bundle, review.slug)).not.toThrow();
  });

  it('still fails when material criticism the model did receive is unaddressed', () => {
    const { review, bundle } = withDiscussion([discussionItem(1)]);
    review.evaluation.counter_evidence_references = [];
    expect(() => validateRefinedReviewIntegrity(review, bundle, review.slug)).toThrow(/not linked to public output/i);
  });
});
