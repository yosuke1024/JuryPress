import { describe, it, expect } from 'vitest';
import { collectMetadataConsistencyFindings } from '../../src/lib/evaluation/metadata-consistency';
import { collectEditorialRecommendationFindings, documentsWithoutValidation, documentationValidationContractApplies } from '../../src/lib/evaluation/editorial-recommendations';
import { validateContent } from '../../src/lib/generation/validator';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { createEditorialFixture } from '../fixtures/refined-review';
import type { GitHubMetadataSnapshot } from '../../src/schemas/evidence';

const snapshot: GitHubMetadataSnapshot = {
  snapshot_id: 'saved-numen-snapshot', fetched_at: '2026-09-09T00:00:00Z',
  repository_full_name: 'example/numen', repository_url: 'https://github.com/example/numen',
  stars: 2, forks: 0, open_issues: 0
};

// Distilled concern/action pairs from the published Shepherdr regression in #139.
const regression = [
  { judge_id: 'sarah', concerns: ['Strong compatibility coupling to a specific Herdr minor version'],
    recommended_next_step: { action: 'Publish a formal compatibility specification' } },
  { judge_id: 'marcus', concerns: ['Full Herdr dependency with low traction and unproven integration demand'],
    recommended_next_step: { action: 'Create a marketing and developer integration guide' } }
];
const corrected = [
  { ...regression[0], recommended_next_step: { action: 'Build versioned socket fixtures and run contract tests for Herdr compatibility; derive the specification from passing results.' } },
  { ...regression[1], recommended_next_step: { action: 'Create one integration prototype for the socket adapter and measure usage before publishing a guide or widening scope.' } }
];

describe('document-only recommendations (#139)', () => {
  it('flags both structural concerns as warnings, with separate actionable corrections', () => {
    const findings = collectEditorialRecommendationFindings({ judges: regression }, '4.8.1');
    const warnings = findings.filter(f => f.code === 'RECOMMENDATION_DOCUMENT_WITHOUT_VALIDATION');
    expect(warnings).toHaveLength(2);
    expect(warnings.every(f => f.severity === 'warning')).toBe(true);
    expect(collectEditorialRecommendationFindings({ judges: corrected }, '4.8.1')).toEqual([]);
  });
  it('leaves old prompt contracts and legitimate missing-doc fixes alone', () => {
    expect(documentationValidationContractApplies('4.8.0')).toBe(false);
    expect(documentationValidationContractApplies('4.9.0')).toBe(true);
    expect(documentationValidationContractApplies(undefined)).toBe(false);
    expect(collectEditorialRecommendationFindings({ judges: regression }, '4.8.0')
      .some(f => f.code === 'RECOMMENDATION_DOCUMENT_WITHOUT_VALIDATION')).toBe(false);
    expect(documentsWithoutValidation('Missing documentation of compatibility requirements', 'Publish a compatibility guide')).toBe(false);
  });
  it('does not mistake a description of tests for executing them', () => {
    expect(documentsWithoutValidation('Strong compatibility coupling', 'Create a guide describing contract tests')).toBe(true);
    expect(documentsWithoutValidation('Strong compatibility coupling', 'Create a guide and run versioned contract tests')).toBe(false);
    expect(documentsWithoutValidation('Low traction', 'Publish a policy and measure adoption funnel conversion')).toBe(false);
  });
  it('states both self-checks only from 4.8.1', () => {
    const evaluator = new Evaluator() as any;
    const prompt = (promptVersion: string) => evaluator.buildEditorialPrompt({
      canonicalDisplayName: 'Numen', candidate: { canonicalUrl: 'https://example.com' },
      sanitizedMetadata: {}, metadataSnapshot: snapshot, budgeted: [], promptVersion
    });
    expect(prompt('4.8.1')).toContain('after it is published, what observable change');
    expect(prompt('4.8.1')).toContain('Written numbers such as "one star"');
    expect(prompt('4.8.0')).not.toContain('after it is published, what observable change');
  });
});

describe('saved snapshot consistency (#144)', () => {
  it('finds Wayfinder and Numen word-number disagreements across every field and occurrence', () => {
    const content = createEditorialFixture().generatedOutput;
    content.article.headline = 'Numen has one star';
    content.article.standfirst = 'Only 1 star; a single fork.';
    content.article.jury_summary = 'Numen has one star. It still has one star.';
    content.article.final_verdict = 'Its single star leaves demand unproven.';
    content.judges[3].verdict = 'Only one star.';
    content.judges[4].concerns = ['The repository has only one star.'];
    content.judges[0].criteria[0].reasoning = 'A lone star.';
    content.judges[1].recommended_next_step.action = 'Investigate why only one star.';
    content.product.summary = 'A repository with one star.';
    const findings = collectMetadataConsistencyFindings(content, snapshot);
    expect(findings).toHaveLength(11);
    expect(new Set(findings.map(f => f.path)).size).toBe(9);
    expect(findings.every(f => f.severity === 'warning')).toBe(true);
  });
  it('accepts matching numeric and qualitative descriptions, and absent snapshots', () => {
    const content = { article: { jury_summary: 'Two stars, zero forks; low traction and near-zero stars.' } };
    expect(collectMetadataConsistencyFindings(content, snapshot)).toEqual([]);
    expect(collectMetadataConsistencyFindings(content)).toEqual([]);
    expect(collectMetadataConsistencyFindings(null, snapshot)).toEqual([]);
    expect(collectMetadataConsistencyFindings({ article: { jury_summary: '1,234 stars and twenty-one forks.' } }, { ...snapshot, stars: 1234, forks: 21 })).toEqual([]);
  });
  it.each([false, true])('records a warning without changing prose or scores (humanEdited=%s)', humanEdited => {
    const { generatedOutput, context } = createEditorialFixture();
    generatedOutput.article.jury_summary = 'Numen has only one star.';
    const original = structuredClone(generatedOutput);
    const verdict = validateContent({ content: generatedOutput, originalContent: original,
      evidences: context.evidences, metadataSnapshot: snapshot, humanEdited, promptVersion: '4.0.0' });
    expect(verdict.status).toBe('passed');
    expect(verdict.warnings.filter(f => f.code === 'METADATA_NUMBER_MISMATCH')).toHaveLength(1);
    expect((verdict.content as any).article.jury_summary).toBe(original.article.jury_summary);
    expect((verdict.content as any).judges.map((j: any) => j.criteria.map((c: any) => c.score)))
      .toEqual(original.judges.map(j => j.criteria.map(c => c.score)));
    expect(generatedOutput).toEqual(original);
  });
});
