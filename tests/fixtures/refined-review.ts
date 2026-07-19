import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { finalizeRefinedEvaluation } from '../../src/lib/daily-evaluation';
import { segmentStatementsStrict } from '../../src/lib/evaluation/public-claims';
import type { EvidenceCollectionResult } from '../../src/schemas/evidence';

const criterionIds = [
  'purpose_usefulness',
  'implementation_evidence',
  'technical_quality',
  'usability_onboarding',
  'differentiation_insight',
  'project_health_stewardship'
] as const;
const judgeIds = ['alex', 'david', 'lisa', 'sarah', 'marcus'] as const;

type StatementSpec = { support_mode: 'evidence_backed' | 'inference' | 'unverified'; evidence_ids: string[] };

/**
 * Emits one statement annotation per sentence of `text`, using the shared segmenter so the
 * annotation's `statement_text` always matches what the validator will segment. `specs` gives
 * the support_mode/evidence per statement index; a single spec applies to every statement.
 */
function annotate(path: string, text: string, specs: StatementSpec | StatementSpec[]): any[] {
  const statements = segmentStatementsStrict(text);
  return statements.map((statement, index) => {
    const spec = Array.isArray(specs) ? specs[index] : specs;
    return {
      public_output_path: path,
      statement_text: statement,
      support_mode: spec.support_mode,
      evidence_ids: spec.evidence_ids
    };
  });
}

export function createRefinedFixture() {
  return createFixtureForVersion('2.0.0');
}

/** 2.1.0 fixture: judges carry recommended_next_step instead of decisive_question. */
export function createRecommendationFixture() {
  return createFixtureForVersion('2.1.0');
}

/**
 * 3.0.0 editorial fixture. The point of the contrast with the 2.x fixtures is what it does
 * NOT contain: no statement annotations, no evidence ids on criteria, no hedge or attribution
 * wording anywhere. The prose is deliberately opinionated and unhedged — under the editorial
 * pipeline that must validate and publish cleanly.
 */
export function createEditorialFixture() {
  const base = createFixtureForVersion('2.1.0');
  const { context } = base;

  const product = {
    name: 'Untrusted Gemini Name',
    category: 'Developer command-line tool',
    summary: 'Refined Product is a terminal-first tool that treats the repository itself as the interface. It trades discoverability for speed, and the trade is deliberate.',
    primary_audience: 'Terminal-native developers'
  };

  const article = {
    headline: 'Refined Product bets everything on the terminal, and mostly wins',
    standfirst: 'A small, opinionated tool with an unusually clear point of view. The jury split on whether its narrow scope is discipline or a ceiling.',
    jury_summary: 'Refined Product does one thing: it makes repository state legible from the command line without a daemon or a GUI. That constraint is the whole design, and it pays off in start-up cost and in how little the tool asks a reader to learn. The cost is equally real — everything the tool does well happens inside a terminal, and nothing about its current shape suggests an answer for teams that want a shared view. David reads the two-file core as admirable restraint; Marcus reads the same two files as a ceiling on what this can become. Both are right, and which one matters depends entirely on whether you want a tool or a platform.',
    where_jury_agreed: [
      'The tool has a genuine point of view, and its scope decisions follow from it.',
      'The absence of any runtime verification is the biggest open question about the implementation.'
    ],
    where_jury_disagreed: [
      { criterion_id: 'differentiation_insight', summary: 'David sees a small core as engineering discipline; Marcus sees it as a ceiling on growth. The disagreement is about whether narrow scope is a strategy or a stage.' }
    ],
    evidence_limitations: ['The jury could not run the tool, so nothing here speaks to its behaviour under load.'],
    final_verdict: 'Adopt this if you already live in a terminal and want repository state without ceremony. Skip it if you need a shared or hosted view, because nothing in the current design points that way. What would change the jury\'s mind is evidence of the tool holding up in a real workflow: a published test run, or a team using it for something larger than inspection.',
    meta_description: 'A small, opinionated terminal tool with a clear point of view and an unresolved question about scale.'
  };

  const canonicalRoles: Record<string, string> = {
    alex: 'Serial Entrepreneur',
    david: 'Principal Software Engineer',
    lisa: 'Head of Product Design',
    sarah: 'Senior Product Manager',
    marcus: 'Venture Capitalist'
  };
  const judgeVoice: Record<string, string> = {
    alex: 'The friction it removes is real, and it removes it on the first run.',
    david: 'Two files of core logic, no hidden state, and error paths I can actually read.',
    lisa: 'The first run teaches the tool by itself, which is rarer than it should be.',
    sarah: 'The scope is honest: it does not promise anything it has not built.',
    marcus: 'A sharp tool in a crowded category, with no obvious second act.'
  };

  const judges = judgeIds.map((judgeId, judgeIndex) => ({
    judge_id: judgeId,
    judge_name: judgeId[0].toUpperCase() + judgeId.slice(1),
    role: canonicalRoles[judgeId],
    verdict: judgeVoice[judgeId],
    strengths: [`Perspective ${judgeIndex + 1}: the implementation is small enough to read end to end.`],
    concerns: [`Perspective ${judgeIndex + 1}: nothing published shows the tool running in anger.`],
    recommended_next_step: {
      action: `Publish a CI run of the existing test files against the reviewed commit so perspective ${judgeIndex + 1} can judge behaviour rather than structure.`,
      criterion_id: 'implementation_evidence'
    },
    criteria: criterionIds.map((criterionId, criterionIndex) => ({
      criterion_id: criterionId,
      // Varied scores: the editorial prompt asks judges not to cluster in the safe middle.
      score: [3.5, 4, 4.5, 3, 4, 3.5][(judgeIndex + criterionIndex) % 6],
      confidence: 'medium',
      reasoning: `On ${criterionId}, the two-file core is the whole story for perspective ${judgeIndex + 1}: it is legible, it is small, and it makes the tool's limits obvious rather than hiding them. Whether that reads as discipline or as an unfinished product is the real question here.`,
      limitations: []
    }))
  }));

  const generatedOutput = {
    schema_version: '3.0.0',
    product,
    article,
    judges
  };

  const evaluation = finalizeRefinedEvaluation(new Evaluator(), generatedOutput, context, '4.0.0');
  const generationRoute = {
    successful_route: 'primary' as const,
    failover_used: false,
    primary_attempts: 1,
    fallback_attempts: 0,
    total_attempts: 1
  };

  const review: any = {
    ...base.review,
    schema_version: '3.0.0',
    slug: 'editorial-product',
    prompt_version: '4.0.0',
    evidence_map_status: 'unavailable',
    generation_route: generationRoute,
    generation_metadata: {
      requested_model: 'fixture-model',
      used_model: 'fixture-model',
      thinking_level: 'HIGH',
      ...generationRoute,
      token_usage: {
        input_tokens: 0,
        output_tokens: 0,
        thinking_tokens: null,
        total_tokens: null,
        cached_input_tokens: null
      }
    },
    jury_score: evaluation.recalculated_jury_score,
    judge_score_range: evaluation.judge_score_range,
    evaluation
  };
  delete review.recommendation_contract_version;

  return {
    context,
    review,
    bundle: base.bundle,
    selection: { ...(base.selection as any), run_key: 'season-2-2026-07-19' },
    generatedOutput
  };
}

function createFixtureForVersion(reviewVersion: '2.0.0' | '2.1.0') {
  const snapshot = {
    snapshot_id: 'snap-refined-fixture',
    fetched_at: '2026-07-16T00:00:00.000Z',
    repository_full_name: 'example/refined-product',
    repository_url: 'https://github.com/example/refined-product',
    default_branch: 'main',
    stars: 42,
    forks: 7,
    open_issues: 3,
    latest_commit_sha: 'abcdef1234567890',
    latest_commit_at: '2026-07-15T00:00:00.000Z',
    license: 'MIT',
    archived: false
  };

  const context: EvidenceCollectionResult = {
    evaluation_integrity_version: '1.0.0',
    project_identity: {
      canonical_display_name: 'Refined Product',
      repository_full_name: 'example/refined-product',
      repository_name: 'refined-product',
      source_title: 'Show HN: Refined Product',
      identity_source: 'readme_h1'
    },
    metadata_snapshot: snapshot,
    discussion_evidence: { items: [] },
    evidences: [
      {
        evidence_id: 'ev-api',
        type: 'api_metadata',
        url: 'https://api.github.com/repos/example/refined-product',
        title: 'GitHub API Metadata',
        retrieved_at: snapshot.fetched_at,
        content_hash: 'api-hash',
        snapshot_id: snapshot.snapshot_id,
        summary: JSON.stringify({
          stargazers_count: snapshot.stars,
          forks_count: snapshot.forks,
          open_issues_count: snapshot.open_issues,
          license_spdx: 'MIT',
          presence: { package_manifest: true, container_build: false }
        }),
        claims: [{ claim_id: 'ev-api-default', text: 'GitHub metadata was captured.', claim_type: 'confirmed_fact' }]
      },
      {
        evidence_id: 'ev-readme',
        type: 'readme',
        url: 'https://raw.githubusercontent.com/example/refined-product/main/README.md',
        title: 'README',
        retrieved_at: snapshot.fetched_at,
        content_hash: 'readme-hash',
        snapshot_id: snapshot.snapshot_id,
        summary: '# Refined Product\nInstall with npm install. The README documents npm test.',
        claims: [{ claim_id: 'ev-readme-default', text: 'The README describes installation.', claim_type: 'creator_claim' }]
      },
      ...['src/core.ts', 'src/runner.ts'].map((file, index) => ({
        evidence_id: `ev-source-${index + 1}`,
        type: 'source_code',
        url: `https://raw.githubusercontent.com/example/refined-product/main/${file}`,
        title: file,
        retrieved_at: snapshot.fetched_at,
        content_hash: `source-hash-${index + 1}`,
        snapshot_id: snapshot.snapshot_id,
        summary: `export const source${index + 1} = true;`,
        claims: [{ claim_id: `ev-source-${index + 1}-default`, text: `${file} exists in the repository.`, claim_type: 'repository_observation' as const }]
      }))
    ]
  };

  // Convenience support specs.
  const repoObs: StatementSpec = { support_mode: 'evidence_backed', evidence_ids: ['ev-source-1'] };
  const apiFact: StatementSpec = { support_mode: 'evidence_backed', evidence_ids: ['ev-api'] };
  const unverified: StatementSpec = { support_mode: 'unverified', evidence_ids: [] };
  const inference: StatementSpec = { support_mode: 'inference', evidence_ids: ['ev-source-1'] };

  const product = {
    name: 'Untrusted Gemini Name',
    category: 'A developer command-line tool.',
    summary: 'Refined Product is a repository-backed developer tool.',
    primary_audience: 'The repository shows the tool targets developers working in the terminal.'
  };

  const article: any = {
    headline: 'Refined Product is an inspectable repository-backed tool',
    standfirst: 'The available source evidence suggests a medium-confidence assessment.',
    jury_summary: 'The GitHub snapshot reports 42 stars, 7 forks, and 3 open issues.',
    where_jury_agreed: [
      'The repository contains inspectable source files.',
      // README-grounded inference with in-statement creator attribution: persists
      // fact_class=inference with source_fact_classes=[creator_claim].
      'According to the README, the documented npm test command suggests the project intends automated testing.'
    ],
    where_jury_disagreed: [],
    evidence_limitations: ['No verified test execution result was collected.'],
    // Overwritten by the application for refined reviews; kept structurally valid.
    evidence_classifications: [],
    final_verdict: 'Refined Product exposes inspectable implementation files. No verified runtime result was collected during the review. The available evidence does not establish long-term sustainability.',
    meta_description: 'Refined Product is an inspectable repository-backed developer tool.'
  };

  const canonicalRoles: Record<string, string> = {
    alex: 'Serial Entrepreneur',
    david: 'Principal Software Engineer',
    lisa: 'Head of Product Design',
    sarah: 'Senior Product Manager',
    marcus: 'Venture Capitalist'
  };
  const judges = judgeIds.map((judgeId, judgeIndex) => {
    const n = judgeIndex + 1;
    const base: any = {
      judge_id: judgeId,
      judge_name: judgeId[0].toUpperCase() + judgeId.slice(1),
      role: canonicalRoles[judgeId],
      verdict: `The repository source for perspective ${n} is inspectable.`,
      strengths: [`The repository includes inspectable implementation files for perspective ${n}.`],
      concerns: [`No verified runtime result was collected for perspective ${n}.`],
      criteria: criterionIds.map(criterionId => ({
        criterion_id: criterionId,
        score: 4,
        confidence: 'medium',
        reasoning: `Source review shows implementation files are present for ${criterionId}, but the available evidence does not establish verified runtime results.`,
        evidence_ids: ['ev-source-1', 'ev-source-2'],
        limitations: [`No verified execution result was collected for ${criterionId}.`]
      }))
    };
    if (reviewVersion === '2.1.0') {
      base.recommended_next_step = {
        action: `Publish a verified runtime result for perspective ${n} by running the repository test files in CI and attaching the output for the reviewed commit.`,
        primary_concern_index: 0,
        criterion_id: 'implementation_evidence',
        evidence_ids: ['ev-source-1']
      };
    } else {
      base.decisive_question = `What verified runtime result could not be confirmed for perspective ${n}?`;
    }
    return base;
  });

  // Build full statement coverage for every public field.
  const public_statement_annotations: any[] = [
    ...annotate('product.category', product.category, repoObs),
    ...annotate('product.summary', product.summary, repoObs),
    ...annotate('product.primary_audience', product.primary_audience, repoObs),
    ...annotate('article.headline', article.headline, repoObs),
    ...annotate('article.standfirst', article.standfirst, inference),
    ...annotate('article.jury_summary', article.jury_summary, apiFact),
    ...annotate('article.where_jury_agreed.0', article.where_jury_agreed[0], repoObs),
    ...annotate('article.where_jury_agreed.1', article.where_jury_agreed[1], { support_mode: 'inference', evidence_ids: ['ev-readme'] }),
    ...annotate('article.evidence_limitations.0', article.evidence_limitations[0], unverified),
    ...annotate('article.final_verdict', article.final_verdict, [repoObs, unverified, unverified]),
    ...annotate('article.meta_description', article.meta_description, repoObs)
  ];
  judges.forEach((judge, judgeIndex) => {
    public_statement_annotations.push(
      ...annotate(`judges.${judgeIndex}.verdict`, judge.verdict, repoObs),
      ...annotate(`judges.${judgeIndex}.strengths.0`, judge.strengths[0], repoObs),
      ...annotate(`judges.${judgeIndex}.concerns.0`, judge.concerns[0], unverified)
    );
    if (judge.decisive_question !== undefined) {
      public_statement_annotations.push(
        ...annotate(`judges.${judgeIndex}.decisive_question`, judge.decisive_question, unverified)
      );
    }
    if (judge.recommended_next_step !== undefined) {
      public_statement_annotations.push(
        ...annotate(`judges.${judgeIndex}.recommended_next_step.action`, judge.recommended_next_step.action, {
          support_mode: 'evidence_backed',
          evidence_ids: [...judge.recommended_next_step.evidence_ids]
        })
      );
    }
    judge.criteria.forEach((criterion: any, criterionIndex: number) => {
      public_statement_annotations.push(
        ...annotate(`judges.${judgeIndex}.criteria.${criterionIndex}.reasoning`, criterion.reasoning, { support_mode: 'evidence_backed', evidence_ids: ['ev-source-1', 'ev-source-2'] }),
        ...annotate(`judges.${judgeIndex}.criteria.${criterionIndex}.limitations.0`, criterion.limitations[0], unverified)
      );
    });
  });

  const generatedOutput = {
    schema_version: reviewVersion,
    public_statement_annotations,
    product,
    article,
    judges
  };

  const evaluation = finalizeRefinedEvaluation(new Evaluator(), generatedOutput, context, '2.1.0');
  const generationRoute = {
    successful_route: 'primary' as const,
    failover_used: false,
    primary_attempts: 1,
    fallback_attempts: 0,
    total_attempts: 1
  };
  const review: any = {
    schema_version: reviewVersion,
    ...(reviewVersion === '2.1.0' ? {
      recommendation_contract_version: '1.0.0',
      generation_route: generationRoute,
      generation_metadata: {
        requested_model: 'fixture-model',
        used_model: 'fixture-model',
        thinking_level: 'HIGH',
        ...generationRoute,
        token_usage: {
          input_tokens: 0,
          output_tokens: 0,
          thinking_tokens: null,
          total_tokens: null,
          cached_input_tokens: null
        }
      }
    } : {}),
    data_class: 'production',
    content_license: 'all-rights-reserved',
    copyright_holder: 'Yosuke Suzuki',
    season: 2,
    review_scope: 'open-source-software-product',
    slug: reviewVersion === '2.1.0' ? 'recommended-product' : 'refined-product',
    published_at: '2026-07-16T00:00:00.000Z',
    model: 'fixture-model',
    attempt_count: 1,
    prompt_version: '2.1.0',
    rubric_id: 'open-source-product',
    rubric_version: '2.0.0',
    selection_policy_id: 'open-source-product',
    selection_policy_version: '2.0.0',
    evaluation_status: 'complete',
    assessment_coverage: 1,
    human_reviewed: false,
    jury_score: evaluation.recalculated_jury_score,
    judge_score_range: evaluation.judge_score_range,
    evaluation,
    usage: { input_tokens: 0, output_tokens: 0, estimated_cost: 0 },
    provenance: {
      no_fixture_provenance: true,
      api_metadata_verified: true,
      recalculated_by_code: true,
      verified_at: '2026-07-16T00:00:00.000Z'
    },
    relationship: 'independent',
    ranking_eligible: true
  };

  const bundle = {
    data_class: 'production' as const,
    evidences: context.evidences,
    metadata_snapshot: snapshot,
    evaluation_integrity_version: '1.0.0' as const
  };

  const selection = {
    schema_version: '1.0.0',
    data_class: 'production',
    run_key: 'season-2-2026-07-16',
    source: 'show_hn',
    source_rank: 1,
    popularity_value: 42,
    popularity_unit: 'stars',
    selection_rule: 'fixture',
    selected_at: '2026-07-16T00:00:00.000Z',
    canonical_url: snapshot.repository_url,
    source_url: 'https://news.ycombinator.com/item?id=123',
    algorithm_version: '2.0.0',
    human_selected: false,
    candidate_name: 'Refined Product',
    source_id: 'refined-product-id',
    candidate_metadata: {},
    selection_mode: 'automated-daily',
    selected_by: 'system',
    source_metrics: [{
      platform: 'github',
      metric: 'stars',
      value: 42,
      source_url: snapshot.repository_url,
      retrieved_at: snapshot.fetched_at
    }]
  };

  return { context, review, bundle, selection, generatedOutput };
}
