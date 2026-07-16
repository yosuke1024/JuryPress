import { describe, it, expect } from 'vitest';
import { isValidDisplayName, normalizeRepositoryName } from '../../src/lib/identity';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import type { Evidence } from '../../src/schemas/evidence';

describe('Canonical Identity Validation Rules', () => {
  it('should accept valid display names', () => {
    expect(isValidDisplayName('AI Trains AI')).toBe(true);
    expect(isValidDisplayName('JuryPress')).toBe(true);
    expect(isValidDisplayName('Vitest Framework')).toBe(true);
  });

  it('should reject names containing only Markdown or HTML image elements', () => {
    expect(isValidDisplayName('![badge](https://img.shields.io)')).toBe(false);
    expect(isValidDisplayName('[link](https://github.com)')).toBe(false);
    expect(isValidDisplayName('<img src="badge.png" />')).toBe(false);
  });

  it('should reject names exceeding 35 characters', () => {
    expect(isValidDisplayName('This Display Name Is Way Too Long To Be A Product Name')).toBe(false);
  });

  it('should reject names starting with subjective or HN personal prefixes', () => {
    expect(isValidDisplayName('Show HN: I built an agent')).toBe(false);
    expect(isValidDisplayName('Ask HN: What is this')).toBe(false);
    expect(isValidDisplayName('I RL-trained a cool neural network')).toBe(false);
    expect(isValidDisplayName('We created an agent')).toBe(false);
  });

  it('should normalize repository names, handling scoped packages properly', () => {
    expect(normalizeRepositoryName('ai-trains-ai')).toBe('AI Trains AI');
    expect(normalizeRepositoryName('@npm/pkg')).toBe('Pkg');
    expect(normalizeRepositoryName('@scoped/some-package')).toBe('Some Package');
    expect(normalizeRepositoryName('my-pkg')).toBe('My Pkg');
  });
});

describe('Evaluation Integrity & Confidence Ceilings', () => {
  const dummyEvidences: Evidence[] = [
    {
      evidence_id: 'ev-1',
      type: 'readme',
      url: 'https://github.com/test/project/blob/main/README.md',
      title: 'Project README',
      retrieved_at: new Date().toISOString(),
      content_hash: 'hash-1',
      summary: 'Test project readme. conftest.py exists.',
      claims: []
    },
    {
      evidence_id: 'ev-2',
      type: 'api_metadata',
      url: 'https://api.github.com/repos/test/project',
      title: 'Project API Metadata',
      retrieved_at: new Date().toISOString(),
      content_hash: 'hash-2',
      summary: 'stars: 10, forks: 2',
      claims: []
    }
  ];

  // Helper to build a standard V2 criteria list for a judge
  const buildV2Criteria = () => {
    const ids = [
      'purpose_usefulness',
      'implementation_evidence',
      'technical_quality',
      'usability_onboarding',
      'differentiation_insight',
      'project_health_stewardship'
    ];
    return ids.map(id => ({
      criterion_id: id,
      score: 4,
      confidence: 'high', // Use high to avoid complex limitations rules for medium/low during test bootstrap
      reasoning: 'according to the README, excellent implementation.',
      evidence_ids: ['ev-1'],
      limitations: []
    }));
  };

  const dummyEvaluationInput = {
    schema_version: "2.0.0" as const,
    evaluation_integrity_version: "1.0.0" as const,
    product: {
      name: "Test Project",
      category: "Developer Tool",
      summary: "A test project description",
      primary_audience: "Developers"
    },
    article: {
      headline: "Headline",
      standfirst: "Standfirst",
      jury_summary: "Jury summary.",
      where_jury_agreed: ["agreed point"],
      where_jury_disagreed: [],
      evidence_limitations: [],
      evidence_classifications: [],
      final_verdict: "Final verdict.",
      meta_description: "Meta description."
    },
    judges: [
      {
        judge_id: "alex",
        judge_name: "Alex",
        role: "Technical Expert",
        verdict: "Good tech.",
        strengths: ["strength"],
        concerns: ["concern"],
        decisive_question: "Will it work?",
        criteria: buildV2Criteria()
      },
      {
        judge_id: "david",
        judge_name: "David",
        role: "Product Manager",
        verdict: "Good product.",
        strengths: [],
        concerns: [],
        decisive_question: "Will users like it?",
        criteria: buildV2Criteria()
      },
      {
        judge_id: "lisa",
        judge_name: "Lisa",
        role: "UX Designer",
        verdict: "Good UX.",
        strengths: [],
        concerns: [],
        decisive_question: "Is it intuitive?",
        criteria: buildV2Criteria()
      },
      {
        judge_id: "sarah",
        judge_name: "Sarah",
        role: "Security Engineer",
        verdict: "Secure.",
        strengths: [],
        concerns: [],
        decisive_question: "Is it secure?",
        criteria: buildV2Criteria()
      },
      {
        judge_id: "marcus",
        judge_name: "Marcus",
        role: "QA Lead",
        verdict: "Tested.",
        strengths: [],
        concerns: [],
        decisive_question: "Does it pass?",
        criteria: buildV2Criteria()
      }
    ],
    overall_evidence_confidence: 0.9,
    project_identity: {
      canonical_display_name: "Test Project",
      identity_source: "readme_h1" as const,
      source_title: "Test Project"
    },
    metadata_snapshot: {
      snapshot_id: "snap-123",
      fetched_at: new Date().toISOString(),
      repository_full_name: "test/project",
      repository_url: "https://github.com/test/project",
      default_branch: "main",
      stars: 10,
      forks: 2,
      open_issues: 0,
      watchers: 5,
      latest_commit_sha: "sha123",
      latest_commit_at: new Date().toISOString(),
      license: "MIT",
      archived: false
    },
    core_source_evidence: {
      source_count: 3,
      source_files: ["src/index.ts"]
    },
    test_evidence_summary: {
      has_pytest_configuration: true,
      actual_test_files: ["tests/test_main.py"],
      ci_workflows: [".github/workflows/ci.yml"],
      documented_test_commands: ["pytest"],
      test_result_artifacts: [],
      test_badges: [],
      relevant_source_files: ["src/index.ts"],
      confidence: "HIGH" as const,
      limitations: [],
      verified_execution_results: [] // EMPTY: Trigger downgrade
    },
    claim_references: [],
    counter_evidence_references: [],
    confidence_adjustments: [],
    discussion_evidence: { items: [] }
  };

  it('should enforce LOW cap for implementation_evidence and 0.66 overall ceiling when verified_execution_results is empty', () => {
    const evaluator = new Evaluator();
    const result = evaluator.recalculateScores(dummyEvaluationInput as any, dummyEvidences, { prompt_version: "2.1.0" }) as any;
    
    // In V2, implementation_evidence is used.
    const alexCrit = result.judges[0].criteria.find((c: any) => c.criterion_id === 'implementation_evidence');
    expect(alexCrit).toBeDefined();
    expect(alexCrit?.confidence).toBe('low');

    // Check overall confidence ceiling capped at 0.66
    expect(result.overall_evidence_confidence).toBeLessThanOrEqual(0.66);

    // Verify adjustments details including scope, judge_id, and criterion_id
    expect(result.confidence_adjustments).toBeDefined();
    expect(result.confidence_adjustments.length).toBeGreaterThan(0);
    
    const criterionAdj = result.confidence_adjustments.find((a: any) => a.scope === 'criterion');
    expect(criterionAdj).toBeDefined();
    expect(criterionAdj?.judge_id).toBe('alex');
    expect(criterionAdj?.criterion_id).toBe('implementation_evidence');
    expect(criterionAdj?.original_confidence).toBe('HIGH');
    expect(criterionAdj?.final_confidence).toBe('LOW');

    const overallAdj = result.confidence_adjustments.find((a: any) => a.scope === 'overall');
    expect(overallAdj).toBeDefined();
    expect(overallAdj?.original_confidence).toBe('HIGH');
    expect(overallAdj?.final_confidence).toBe('MEDIUM');
  });
});
