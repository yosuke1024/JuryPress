import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { prepareCandidateWithIntegrityContext, finalizeRefinedEvaluation } from '../../src/lib/daily-evaluation';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { validateRefinedReviewIntegrity } from '../../src/lib/publication-integrity';
import { ReviewSchema, RefinedReviewSchemaV2 } from '../../src/schemas/review';
import { RunStateSchema } from '../../src/schemas/selection';
import { createRefinedFixture } from '../fixtures/refined-review';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
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
    const { context, review } = createRefinedFixture();
    const raw = clone(review.evaluation);
    delete raw.project_identity;
    delete raw.metadata_snapshot;
    delete raw.evaluation_integrity_version;
    delete raw.core_source_evidence;
    delete raw.test_evidence_summary;
    delete raw.confidence_adjustments;
    delete raw.claim_references;
    delete raw.counter_evidence_references;
    delete raw.discussion_evidence;
    raw.product.name = 'Gemini Name';
    const result = finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0');
    expect(result.product.name).toBe('Refined Product');
    expect(result.project_identity).toEqual(context.project_identity);
    expect(result.metadata_snapshot).toEqual(context.metadata_snapshot);
  });

  it('applies the 0.66 ceiling from explicit context when Gemini omits integrity fields', () => {
    const { context, review } = createRefinedFixture();
    const raw = clone(review.evaluation);
    raw.judges.forEach((judge: any) => judge.criteria.forEach((criterion: any) => {
      criterion.confidence = 'high';
      criterion.limitations = [];
    }));
    for (const field of ['project_identity', 'metadata_snapshot', 'evaluation_integrity_version', 'core_source_evidence', 'test_evidence_summary', 'confidence_adjustments', 'claim_references', 'counter_evidence_references', 'discussion_evidence']) delete raw[field];
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

  it('keeps legacy reviews readable without refined fields', () => {
    const legacy = JSON.parse(readFileSync('tests/fixtures/reviews/2026/07/fixture-product/review.json', 'utf8'));
    expect(ReviewSchema.parse(legacy).schema_version).toBe('1.0.0');
  });
});

describe('Phase 1 publication gate', () => {
  it('accepts the valid refined fixture', () => {
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
    ['article.standfirst', (review: any) => { review.evaluation.article.standfirst = 'The repository has 999 stars.'; }],
    ['judge strength', (review: any) => { review.evaluation.judges[0].strengths[0] = '999 stars indicate interest.'; }]
  ])('rejects inconsistent metadata in %s', (_label, mutate) => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    mutate(invalid);
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug)).toThrow(/Inconsistent stars count/i);
  });

  it.each([
    ['999 open issues', 'The repository has 999 open issues.'],
    ['open issues: 999', 'Backlog stats — open issues: 999'],
    ['999 issues', 'The tracker lists 999 issues.'],
    ['issues: 999', 'Tracker summary, issues: 999'],
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
    valid.evaluation.article.standfirst = render(valid.evaluation.metadata_snapshot);
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

  it('does not treat CI configuration alone as verified execution', () => {
    const { context, review } = createRefinedFixture();
    const raw = clone(review.evaluation);
    context.evidences.push({
      evidence_id: 'ev-ci', type: 'ci_workflow', url: 'https://raw.githubusercontent.com/example/refined-product/main/.github/workflows/ci.yml',
      title: 'CI workflow', retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: 'ci-hash',
      summary: 'runs npm test', claims: [{ claim_id: 'ev-ci-default', text: 'CI configuration exists.', claim_type: 'repository_observation' }]
    });
    const result = finalizeRefinedEvaluation(new Evaluator(), raw, context, '2.1.0');
    expect(result.test_evidence_summary.ci_workflows).toContain('CI workflow');
    expect(result.test_evidence_summary.confidence).not.toBe('HIGH');
    expect(result.overall_evidence_confidence).toBeLessThanOrEqual(0.66);
  });

  it('rejects missing claim references for a refined review', () => {
    const { review } = createRefinedFixture();
    const invalid = clone(review);
    delete invalid.evaluation.claim_references;
    expect(() => RefinedReviewSchemaV2.parse(invalid)).toThrow(/claim_references/i);
  });

  it('requires attribution in the referenced public field itself', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    invalid.evaluation.article.jury_summary = 'According to the README, this is a creator claim.';
    invalid.evaluation.claim_references[0] = {
      claim_id: 'creator-claim', evidence_id: 'ev-readme', evidence_ids: ['ev-readme'],
      fact_class: 'creator_claim', attribution_required: true,
      public_output_path: 'judges.0.strengths.0', target_field: 'judges.0.strengths.0'
    };
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug)).toThrow(/lacks attribution in its own public field/i);
  });

  it('does not accept a generic concern as target-specific counter-evidence', () => {
    const { review, bundle } = createRefinedFixture();
    const invalidReview = clone(review);
    const invalidBundle = clone(bundle);
    invalidBundle.evidences.push({
      evidence_id: 'ev-discussion', type: 'source_discussion', url: 'https://news.ycombinator.com/item?id=1',
      title: 'Discussion', retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: 'discussion-hash',
      summary: 'Deployment complexity makes setup difficult.',
      claims: [{ claim_id: 'ev-discussion-default', text: 'A commenter discussed deployment complexity.', claim_type: 'community_opinion' }]
    });
    invalidReview.evaluation.discussion_evidence = { items: [{
      discussion_item_id: 'discussion-1', parent_evidence_id: 'ev-discussion',
      source_url: 'https://news.ycombinator.com/item?id=1', excerpt: 'Deployment complexity makes setup difficult.',
      fact_class: 'community_opinion', classification: 'critical', materiality_reason_code: 'DEPLOYMENT_COMPLEXITY',
      included_in_model_input: true, requires_public_response: true
    }] };
    invalidReview.evaluation.counter_evidence_references = [{
      discussion_item_id: 'discussion-1', parent_evidence_id: 'ev-discussion',
      public_output_path: 'judges.0.concerns.0', target_field: 'judges.0.concerns.0'
    }];
    invalidReview.evaluation.judges[0].concerns[0] = 'The community raised a generic concern.';
    expect(() => validateRefinedReviewIntegrity(invalidReview, invalidBundle, invalidReview.slug)).toThrow(/not specifically reflected/i);
  });

  describe('discussion scope matches what the model was given', () => {
    function discussionItem(index: number, overrides: Record<string, unknown> = {}) {
      return {
        discussion_item_id: `discussion-${index}`,
        parent_evidence_id: 'ev-discussion',
        source_url: 'https://news.ycombinator.com/item?id=1',
        excerpt: `Critical comment ${index} about deployment complexity.`,
        fact_class: 'community_opinion',
        classification: 'critical',
        materiality_reason_code: 'DEPLOYMENT_COMPLEXITY',
        included_in_model_input: true,
        requires_public_response: true,
        ...overrides
      };
    }

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

    it('does not require a public response for critical comments the model never received', () => {
      // Six critical comments, but only the five that fit the model input cap
      // were sent. The sixth must not be able to fail the publish.
      const items = [
        ...Array.from({ length: 5 }, (_, index) => discussionItem(index + 1)),
        discussionItem(6, { included_in_model_input: false, requires_public_response: false })
      ];
      const { review, bundle } = withDiscussion(items);
      review.evaluation.judges[0].concerns[0] = 'Commenters flagged deployment complexity in the discussion.';
      review.evaluation.counter_evidence_references = items
        .filter(item => item.requires_public_response)
        .map(item => ({
          discussion_item_id: item.discussion_item_id, parent_evidence_id: 'ev-discussion',
          public_output_path: 'judges.0.concerns.0', target_field: 'judges.0.concerns.0'
        }));
      expect(() => validateRefinedReviewIntegrity(review, bundle, review.slug)).not.toThrow();
    });

    it('still fails when material criticism the model did receive is unaddressed', () => {
      const items = [discussionItem(1)];
      const { review, bundle } = withDiscussion(items);
      review.evaluation.counter_evidence_references = [];
      expect(() => validateRefinedReviewIntegrity(review, bundle, review.slug)).toThrow(/not linked to public output/i);
    });
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
