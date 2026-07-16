import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { finalizeRefinedEvaluation } from '../../src/lib/daily-evaluation';
import type { EvidenceCollectionResult } from '../../src/schemas/evidence';

const criterionIds = [
  'purpose_usefulness',
  'implementation_evidence',
  'technical_quality',
  'usability_onboarding',
  'differentiation_insight',
  'project_health_stewship'
] as const;

// Keep the typo out of generated data while retaining a compact literal list.
const normalizedCriterionIds = criterionIds.map(id => id === 'project_health_stewship' ? 'project_health_stewardship' : id);
const judgeIds = ['alex', 'david', 'lisa', 'sarah', 'marcus'] as const;

export function createRefinedFixture() {
  const snapshot = {
    snapshot_id: 'snap-refined-fixture',
    fetched_at: '2026-07-16T00:00:00.000Z',
    repository_full_name: 'example/refined-product',
    repository_url: 'https://github.com/example/refined-product',
    default_branch: 'main',
    stars: 42,
    forks: 7,
    open_issues: 3,
    watchers: 5,
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

  const generatedOutput = {
    schema_version: '2.0.0',
    product: {
      name: 'Untrusted Gemini Name',
      category: 'Developer Tool',
      summary: 'Refined Product is a repository-backed tool with 42 stars.',
      primary_audience: 'Developers'
    },
    article: {
      headline: 'Refined Product receives a measured review',
      standfirst: 'The repository evidence supports a medium-confidence assessment.',
      jury_summary: 'The GitHub snapshot reports 42 stars, 7 forks, and 3 open issues.',
      where_jury_agreed: ['The repository contains inspectable source files.'],
      where_jury_disagreed: [],
      evidence_limitations: ['No verified test execution result was collected.'],
      evidence_classifications: [{ evidence_id: 'ev-source-1', classification: 'source_confirmed', claim: 'A source file exists.' }],
      final_verdict: 'The repository includes inspectable implementation files. The evidence supports a measured assessment. No verified test execution result was collected. Further runtime verification would improve confidence.',
      meta_description: 'Evidence-based review of Refined Product.'
    },
    judges: judgeIds.map((judgeId, judgeIndex) => ({
      judge_id: judgeId,
      judge_name: judgeId[0].toUpperCase() + judgeId.slice(1),
      role: `Role ${judgeIndex + 1}`,
      verdict: `According to repository source ${judgeIndex + 1}, the implementation is inspectable.`,
      strengths: [`Repository observation ${judgeIndex + 1}`],
      concerns: [`Runtime verification gap ${judgeIndex + 1}`],
      decisive_question: `What verified runtime result is available for perspective ${judgeIndex + 1}?`,
      criteria: normalizedCriterionIds.map(criterionId => ({
        criterion_id: criterionId,
        score: 4,
        confidence: 'medium',
        reasoning: 'Source confirmed that implementation files are present, but the available evidence does not establish verified runtime results.',
        evidence_ids: ['ev-source-1', 'ev-source-2'],
        limitations: ['No verified execution result was collected.']
      }))
    }))
  };

  const evaluation = finalizeRefinedEvaluation(new Evaluator(), generatedOutput, context, '2.1.0');
  const review = {
    schema_version: '2.0.0',
    data_class: 'production',
    content_license: 'all-rights-reserved',
    copyright_holder: 'Yosuke Suzuki',
    season: 2,
    review_scope: 'open-source-software-product',
    slug: 'refined-product',
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

  return { context, review, bundle, selection };
}
