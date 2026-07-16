import { existsSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { finalizeRefinedEvaluation } from '../../src/lib/daily-evaluation';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { validateRefinedReviewIntegrity } from '../../src/lib/publication-integrity';
import { ReviewSchema, RefinedReviewSchemaV2 } from '../../src/schemas/review';
import { segmentStatements, SOURCE_FACT_CLASS_ORDER } from '../../src/lib/evaluation/public-claims';
import { summarizeStatementProvenance, supportModeLabel, sourceProvenanceLabel } from '../../src/lib/evaluation/statement-provenance';
import { createRefinedFixture } from '../fixtures/refined-review';

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/** Replaces one public field's text and its statement annotations on raw generation output. */
function reannotate(raw: any, fieldPath: string, text: string, support_mode: string, evidence_ids: string[]): void {
  const parts = fieldPath.split('.');
  let cur: any = raw;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[/^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i]];
  cur[/^\d+$/.test(parts.at(-1)!) ? Number(parts.at(-1)!) : parts.at(-1)!] = text;
  raw.public_statement_annotations = raw.public_statement_annotations.filter((a: any) => a.public_output_path !== fieldPath);
  for (const statement of segmentStatements(text)) {
    raw.public_statement_annotations.push({ public_output_path: fieldPath, statement_text: statement, support_mode, evidence_ids });
  }
}

/** Rewrites one public field and its persisted references on a finalized review (gate-side tampering). */
function coverPersistedField(review: any, fieldPath: string, text: string, spec: Record<string, unknown>): void {
  const parts = fieldPath.split('.');
  let cur: any = review.evaluation;
  for (let i = 0; i < parts.length - 1; i++) cur = cur[/^\d+$/.test(parts[i]) ? Number(parts[i]) : parts[i]];
  cur[/^\d+$/.test(parts.at(-1)!) ? Number(parts.at(-1)!) : parts.at(-1)!] = text;
  review.evaluation.claim_references = review.evaluation.claim_references.filter((r: any) => r.public_output_path !== fieldPath);
  segmentStatements(text).forEach((statement, index) => {
    review.evaluation.claim_references.push({
      claim_id: `test-${fieldPath}-${index}`, public_output_path: fieldPath, statement_index: index,
      statement_text: statement, coverage_source: 'statement_annotation', ...spec
    });
  });
}

function addDiscussionEvidence(context: any): void {
  context.evidences.push({
    evidence_id: 'ev-discussion', type: 'source_discussion', url: 'https://news.ycombinator.com/item?id=1',
    title: 'Discussion', retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: 'disc-hash',
    summary: 'Reliability discussion.',
    claims: [{ claim_id: 'ev-disc-default', text: 'A commenter questioned reliability.', claim_type: 'community_opinion' }]
  });
}

/** Adds an evidence whose OWN fact class is weak (inference/unknown→unverified). */
function addClassifiedEvidence(evidences: any[], evidenceId: string, claimType: string): void {
  evidences.push({
    evidence_id: evidenceId, type: 'additional_evidence', url: 'https://example.invalid/extra',
    title: 'Supplementary note', retrieved_at: '2026-07-16T00:00:00.000Z', content_hash: `${evidenceId}-hash`,
    summary: 'Supplementary evidence note.',
    claims: [{ claim_id: `${evidenceId}-default`, text: 'A supplementary note.', claim_type: claimType }]
  });
}

const evaluator = () => new Evaluator();

describe('Phase 1 source provenance — laundering fails closed at generation', () => {
  // Required regression 1: an inference must not shed its README (creator_claim) provenance.
  it('fails a README-cited inference whose statement carries no creator attribution', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'The tool may process ten thousand requests per second.', 'inference', ['ev-readme']);
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  // Required regression 2: the same inference passes once the statement attributes the README.
  it('accepts a README-cited inference when the statement itself attributes the README', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'According to the README, the tool may process ten thousand requests per second.', 'inference', ['ev-readme']);
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0')).not.toThrow();
  });

  // Required regression 3: the persisted reference keeps BOTH the statement mode and the source provenance.
  it('persists fact_class=inference with source_fact_classes=[creator_claim] for an attributed README inference', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'According to the README, the tool may process ten thousand requests per second.', 'inference', ['ev-readme']);
    const result = finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0');
    const ref = result.claim_references.find((r: any) => r.public_output_path === 'article.standfirst');
    expect(ref.support_mode).toBe('inference');
    expect(ref.fact_class).toBe('inference');
    expect(ref.source_fact_classes).toEqual(['creator_claim']);
    expect(ref.attribution_required).toBe(true);
  });

  // Required regression 4: community provenance must survive an inference the same way.
  it('fails a discussion-cited inference whose statement carries no community attribution', () => {
    const { context, generatedOutput } = createRefinedFixture();
    addDiscussionEvidence(context);
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'The tool may be unreliable under sustained load.', 'inference', ['ev-discussion']);
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/cites a community_opinion but the statement itself carries no attribution/i);
  });

  // Required regression 5.
  it('persists source_fact_classes=[community_opinion] for a community-attributed inference', () => {
    const { context, generatedOutput } = createRefinedFixture();
    addDiscussionEvidence(context);
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'Commenters in the discussion suggest the tool may be unreliable under sustained load.', 'inference', ['ev-discussion']);
    const result = finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0');
    const ref = result.claim_references.find((r: any) => r.public_output_path === 'article.standfirst');
    expect(ref.fact_class).toBe('inference');
    expect(ref.source_fact_classes).toEqual(['community_opinion']);
    expect(ref.attribution_required).toBe(true);
  });

  // Required regression 11: unverified statements citing creator evidence keep its provenance too.
  it('fails an unverified statement citing README evidence without creator attribution', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    reannotate(raw, 'judges.0.concerns.0', 'The stated performance figures could not be verified.', 'unverified', ['ev-readme']);
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  it('persists source_fact_classes=[creator_claim] for an attributed unverified statement citing the README', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    reannotate(raw, 'judges.0.concerns.0', 'The README performance figures could not be verified.', 'unverified', ['ev-readme']);
    const result = finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0');
    const ref = result.claim_references.find((r: any) => r.public_output_path === 'judges.0.concerns.0');
    expect(ref.support_mode).toBe('unverified');
    expect(ref.fact_class).toBe('unverified');
    expect(ref.source_fact_classes).toEqual(['creator_claim']);
    expect(ref.attribution_required).toBe(true);
  });

  // Required regression 12: the evidence-less unverified path is unchanged.
  it('accepts an evidence-less unverified statement with explicit absence wording and empty source_fact_classes', () => {
    const { review } = createRefinedFixture();
    const ref = review.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.evidence_limitations.0');
    expect(ref.support_mode).toBe('unverified');
    expect(ref.evidence_ids).toEqual([]);
    expect(ref.source_fact_classes).toEqual([]);
    expect(ref.attribution_required).toBe(false);
  });
});

describe('Phase 1 mode mismatch — inference/unverified evidence can never be evidence_backed', () => {
  // Required regression: community provenance survives an unverified statement.
  it('fails an unverified statement citing discussion evidence without community attribution', () => {
    const { context, generatedOutput } = createRefinedFixture();
    addDiscussionEvidence(context);
    const raw = clone(generatedOutput);
    reannotate(raw, 'judges.0.concerns.0', 'The reliability of the tool could not be verified.', 'unverified', ['ev-discussion']);
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/cites a community_opinion but the statement itself carries no attribution/i);
  });

  it('accepts the same unverified statement once it attributes the community discussion', () => {
    const { context, generatedOutput } = createRefinedFixture();
    addDiscussionEvidence(context);
    const raw = clone(generatedOutput);
    reannotate(raw, 'judges.0.concerns.0', 'Commenters raised reliability concerns that could not be verified.', 'unverified', ['ev-discussion']);
    const result = finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0');
    const ref = result.claim_references.find((r: any) => r.public_output_path === 'judges.0.concerns.0');
    expect(ref.support_mode).toBe('unverified');
    expect(ref.source_fact_classes).toEqual(['community_opinion']);
    expect(ref.attribution_required).toBe(true);
  });

  // Required regression: inference-class evidence cannot ground an unqualified assertion.
  it('fails an evidence_backed statement citing inference-class evidence at generation', () => {
    const { context, generatedOutput } = createRefinedFixture();
    addClassifiedEvidence(context.evidences, 'ev-inferred', 'inference');
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'The tool scales to enterprise workloads.', 'evidence_backed', ['ev-inferred']);
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/evidence_backed but cites inference-class evidence; use support_mode=inference/i);
  });

  // Required regression: unverified-class evidence cannot ground an unqualified assertion.
  it('fails an evidence_backed statement citing unverified-class evidence at generation', () => {
    const { context, generatedOutput } = createRefinedFixture();
    addClassifiedEvidence(context.evidences, 'ev-unknown', 'unknown');
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'The tool scales to enterprise workloads.', 'evidence_backed', ['ev-unknown']);
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/evidence_backed but cites unverified-class evidence; use support_mode=unverified/i);
  });

  // Required regression: the same mode mismatch fails at the publication gate too.
  it('rejects a persisted evidence_backed reference grounded on inference-class evidence at the gate', () => {
    const { review, bundle } = createRefinedFixture();
    addClassifiedEvidence(bundle.evidences as any[], 'ev-inferred', 'inference');
    const invalid = clone(review);
    coverPersistedField(invalid, 'article.standfirst', 'The tool scales to enterprise workloads.', {
      support_mode: 'evidence_backed', fact_class: 'inference', attribution_required: false,
      evidence_ids: ['ev-inferred'], source_fact_classes: ['inference']
    });
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/evidence_backed but cites inference-class evidence/i);
  });

  it('rejects a persisted evidence_backed reference grounded on unverified-class evidence at the gate', () => {
    const { review, bundle } = createRefinedFixture();
    addClassifiedEvidence(bundle.evidences as any[], 'ev-unknown', 'unknown');
    const invalid = clone(review);
    coverPersistedField(invalid, 'article.standfirst', 'The tool scales to enterprise workloads.', {
      support_mode: 'evidence_backed', fact_class: 'unverified', attribution_required: false,
      evidence_ids: ['ev-unknown'], source_fact_classes: ['unverified']
    });
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/evidence_backed but cites unverified-class evidence/i);
  });
});

describe('Phase 1 mode match — the four allowed evidence_backed source classes', () => {
  // Required regression: confirmed_fact alone stays valid.
  it('persists fact_class=confirmed_fact for an evidence_backed statement citing api metadata alone', () => {
    const { review } = createRefinedFixture();
    const ref = review.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.jury_summary');
    expect(ref.support_mode).toBe('evidence_backed');
    expect(ref.fact_class).toBe('confirmed_fact');
    expect(ref.source_fact_classes).toEqual(['confirmed_fact']);
    expect(ref.attribution_required).toBe(false);
  });

  // Required regression: repository_observation alone stays valid.
  it('persists fact_class=repository_observation for an evidence_backed statement citing source files alone', () => {
    const { review } = createRefinedFixture();
    const ref = review.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.0');
    expect(ref.support_mode).toBe('evidence_backed');
    expect(ref.fact_class).toBe('repository_observation');
    expect(ref.source_fact_classes).toEqual(['repository_observation']);
    expect(ref.attribution_required).toBe(false);
  });

  // Required regression: creator_claim alone stays valid when the statement attributes it.
  it('accepts a creator-attributed evidence_backed statement citing the README alone', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    reannotate(raw, 'article.standfirst', 'According to the README, the project documents an npm test command.', 'evidence_backed', ['ev-readme']);
    const result = finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0');
    const ref = result.claim_references.find((r: any) => r.public_output_path === 'article.standfirst');
    expect(ref.support_mode).toBe('evidence_backed');
    expect(ref.fact_class).toBe('creator_claim');
    expect(ref.source_fact_classes).toEqual(['creator_claim']);
    expect(ref.attribution_required).toBe(true);
  });
});

describe('Phase 1 source provenance — evidence order can never change classification', () => {
  // Required regression 6: heterogeneous fact classes fail closed instead of resolving by array order.
  it('fails an evidence_backed statement citing api_metadata and source_code together', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    const annotation = raw.public_statement_annotations.find((a: any) => a.public_output_path === 'article.jury_summary');
    annotation.evidence_ids = ['ev-api', 'ev-source-1'];
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/mixed fact classes \(confirmed_fact, repository_observation\).*split/i);
  });

  // Required regression 7: reversing the same citation gives the identical result.
  it('fails the same mixed citation with evidence_ids reversed', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const raw = clone(generatedOutput);
    const annotation = raw.public_statement_annotations.find((a: any) => a.public_output_path === 'article.jury_summary');
    annotation.evidence_ids = ['ev-source-1', 'ev-api'];
    expect(() => finalizeRefinedEvaluation(evaluator(), raw, context, '2.1.0'))
      .toThrow(/mixed fact classes \(confirmed_fact, repository_observation\).*split/i);
  });

  // Required regression 8 (generation side).
  it('produces identical fact_class and source_fact_classes when evidence_ids are permuted at generation', () => {
    const { context, generatedOutput } = createRefinedFixture();
    const findRef = (result: any) => result.claim_references.find((r: any) => r.public_output_path === 'judges.0.criteria.0.reasoning');

    const baseline = finalizeRefinedEvaluation(evaluator(), clone(generatedOutput), clone(context), '2.1.0');
    const permuted = clone(generatedOutput);
    for (const annotation of permuted.public_statement_annotations) {
      if (annotation.public_output_path === 'judges.0.criteria.0.reasoning') annotation.evidence_ids = ['ev-source-2', 'ev-source-1'];
    }
    const reordered = finalizeRefinedEvaluation(evaluator(), permuted, clone(context), '2.1.0');

    expect(findRef(baseline).fact_class).toBe('repository_observation');
    expect(findRef(reordered).fact_class).toBe(findRef(baseline).fact_class);
    expect(findRef(reordered).source_fact_classes).toEqual(findRef(baseline).source_fact_classes);
  });

  // Required regression 8 (gate side).
  it('keeps a persisted review valid when a reference merely reorders its evidence_ids', () => {
    const { review, bundle } = createRefinedFixture();
    const reordered = clone(review);
    const ref = reordered.evaluation.claim_references.find((r: any) => r.public_output_path === 'judges.0.criteria.0.reasoning');
    ref.evidence_ids = [...ref.evidence_ids].reverse();
    expect(() => validateRefinedReviewIntegrity(reordered, bundle, reordered.slug)).not.toThrow();
  });
});

describe('Phase 1 source provenance — publication gate rejects persisted tampering', () => {
  // Gate-side counterpart of regression 1: correct source_fact_classes cannot excuse missing attribution.
  it('fails a persisted README-grounded inference whose statement carries no creator attribution', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    coverPersistedField(invalid, 'article.standfirst', 'The tool may process ten thousand requests per second.', {
      support_mode: 'inference', fact_class: 'inference', attribution_required: true,
      evidence_ids: ['ev-readme'], source_fact_classes: ['creator_claim']
    });
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/cites a creator_claim but the statement itself carries no attribution/i);
  });

  // Required regression 9.
  it('rejects a persisted reference whose source_fact_classes was relabelled away from its evidence', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    const ref = invalid.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.1');
    expect(ref.source_fact_classes).toEqual(['creator_claim']);
    ref.source_fact_classes = ['repository_observation'];
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/misstates source_fact_classes/i);
  });

  it('rejects a persisted refined reference that drops source_fact_classes entirely', () => {
    const { review } = createRefinedFixture();
    const invalid = clone(review);
    const ref = invalid.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.1');
    delete ref.source_fact_classes;
    expect(() => RefinedReviewSchemaV2.parse(invalid)).toThrow(/source_fact_classes is required/i);
  });

  // Required regression 10.
  it('rejects tampering an inference reference from creator_claim provenance to confirmed_fact', () => {
    const { review, bundle } = createRefinedFixture();
    const bySource = clone(review);
    const sourceRef = bySource.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.1');
    sourceRef.source_fact_classes = ['confirmed_fact'];
    expect(() => validateRefinedReviewIntegrity(bySource, bundle, bySource.slug))
      .toThrow(/misstates source_fact_classes/i);

    const byFactClass = clone(review);
    const factClassRef = byFactClass.evaluation.claim_references.find((r: any) => r.public_output_path === 'article.where_jury_agreed.1');
    factClassRef.fact_class = 'confirmed_fact';
    expect(() => validateRefinedReviewIntegrity(byFactClass, bundle, byFactClass.slug))
      .toThrow(/tampered inference reference/i);
  });

  it('rejects a system_generated reference tampered with fabricated source_fact_classes', () => {
    const { review, bundle } = createRefinedFixture();
    const invalid = clone(review);
    // A genuine application-injected statement, but its persisted reference forges provenance.
    coverPersistedField(invalid, 'judges.0.criteria.0.limitations.0',
      'The available evidence does not describe detailed limitations metadata.', {
        support_mode: 'unverified', fact_class: 'unverified', attribution_required: false,
        evidence_ids: [], source_fact_classes: ['confirmed_fact'], coverage_source: 'system_generated'
      });
    expect(() => validateRefinedReviewIntegrity(invalid, bundle, invalid.slug))
      .toThrow(/tampered system-generated reference/i);
  });

  // Required regression 13.
  it('accepts the fully covered refined fixture with source provenance on every reference', () => {
    const { review, bundle } = createRefinedFixture();
    expect(() => validateRefinedReviewIntegrity(review, bundle, review.slug)).not.toThrow();
    for (const ref of review.evaluation.claim_references) {
      expect(Array.isArray(ref.source_fact_classes)).toBe(true);
      const sorted = SOURCE_FACT_CLASS_ORDER.filter(fc => ref.source_fact_classes.includes(fc));
      expect(ref.source_fact_classes).toEqual(sorted);
    }
  });
});

describe('Phase 1 source provenance — legacy compatibility and renderer', () => {
  // Required regression 14.
  it('keeps the legacy fixture readable with no source_fact_classes anywhere', () => {
    const raw = readFileSync('tests/fixtures/reviews/2026/07/fixture-product/review.json', 'utf8');
    expect(raw).not.toContain('source_fact_classes');
    expect(() => ReviewSchema.parse(JSON.parse(raw))).not.toThrow();
  });

  // Required regression 15 (the detailed assertions live in phase1-remediation.test.ts).
  it('keeps the single Gemini call and primary/fallback routing intact', () => {
    const source = readFileSync('src/lib/evaluation/evaluator.ts', 'utf8');
    expect((source.match(/\.generateContent\(/g) || []).length).toBe(1);
    expect(source).toContain('GEMINI_FALLBACK_API_KEY');
    expect(source).toContain("route = 'fallback'");
  });

  // Required regression 16: the refined display model keeps mode and provenance as separate axes.
  it('renders statement mode and source provenance without conflating them', () => {
    const { review } = createRefinedFixture();
    const groups = summarizeStatementProvenance(review.evaluation.claim_references);
    const inferenceGroup = groups.find(g => g.support_mode === 'inference' && g.source_fact_classes.includes('creator_claim'));
    expect(inferenceGroup, 'README-grounded inference must keep creator provenance').toBeDefined();
    expect(supportModeLabel(inferenceGroup!.support_mode)).toBe('Jury inference');
    expect(sourceProvenanceLabel(inferenceGroup!.source_fact_classes)).toContain('creator claims');
    expect(sourceProvenanceLabel(inferenceGroup!.source_fact_classes)).not.toMatch(/confirmed/i);

    const unverifiedGroup = groups.find(g => g.support_mode === 'unverified' && g.source_fact_classes.length === 0);
    expect(unverifiedGroup).toBeDefined();
    expect(sourceProvenanceLabel([])).toBe('no cited evidence');
  });

  it('wires the statement provenance block into the refined renderer only', () => {
    const source = readFileSync('src/pages/reviews/[slug].astro', 'utf8');
    expect(source).toContain('summarizeStatementProvenance(review.evaluation.claim_references)');
    expect(source).toContain('Statement Provenance');
    expect(source).toContain('supportModeLabel(group.support_mode)');
    expect(source).toContain('sourceProvenanceLabel(group.source_fact_classes)');
    // The block is derived only for refined evaluations; legacy branches stay untouched.
    expect(source).toContain("isRefinedEvaluation\n  ? summarizeStatementProvenance");
    expect(source).toContain('Could Not Assess / Unknown');
  });

  it('summarizes legacy reviews (no claim_references) to zero groups, leaving legacy display unchanged', () => {
    expect(summarizeStatementProvenance(undefined)).toEqual([]);
    expect(summarizeStatementProvenance([])).toEqual([]);
  });
});

// Required regression 17: the three published production articles (all legacy, generated by the
// scheduled daily pipeline on the pre-Phase-1 public main) must load without migration. Runs
// against the private content repository when it is checked out locally; skipped otherwise (CI
// has no access to the private repository).
const PRIVATE_CONTENT_ROOT = process.env.JURYPRESS_PRIVATE_CONTENT_ROOT
  || path.resolve(process.cwd(), '..', 'JuryPress-content', 'data');
const PRODUCTION_SLUGS = [
  'i-rl-3b2306',
  'vinhhien112-three-js-object-sculptor-codex-plugin-dca0c7',
  'open-llm-leaderboard-2a55de'
];

describe.skipIf(!existsSync(PRIVATE_CONTENT_ROOT))('Phase 1 source provenance — existing production content', () => {
  it.each(PRODUCTION_SLUGS)('loads published production article %s as legacy, without migration', slug => {
    const raw = readFileSync(path.join(PRIVATE_CONTENT_ROOT, 'reviews', '2026', '07', slug, 'review.json'), 'utf8');
    expect(raw).not.toContain('source_fact_classes');
    const review: any = ReviewSchema.parse(JSON.parse(raw));
    // Legacy: the refined gate (and therefore the new provenance requirements) must not apply.
    expect(review.evaluation.evaluation_integrity_version).toBeUndefined();
    expect(review.evaluation.claim_references).toBeUndefined();
  });
});
