import { describe, it, expect, vi } from 'vitest';
import { 
  resolveProjectIdentity, 
  normalizeRepositoryName, 
  extractReadmeH1,
  inferFromSourceTitle
} from '../../src/lib/identity';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { EvaluationOutputSchema } from '../../src/schemas/evaluation';

describe('JuryPress Evaluation Integrity Refinement Tests', () => {

  // 1. Title extraction prevention (I RL)
  it('should not extract "I RL" as a canonical product name', () => {
    const rawTitle = "I RL-trained an agent that trains models with RL";
    const inferred = inferFromSourceTitle(rawTitle);
    expect(inferred).not.toBe("I RL");
    expect(inferred).not.toContain("I RL");
    expect(inferred).toBe("RL-trained an agent");
  });

  // 2. README H1 priority
  it('should adopt first valid README H1 if present', () => {
    const readme = "# Cool Product\nSome description";
    const identity = resolveProjectIdentity({
      readmeText: readme,
      sourceTitle: "I RL-trained an agent..."
    });
    expect(identity.canonical_display_name).toBe("Cool Product");
    expect(identity.identity_source).toBe("readme_h1");
  });

  // 3. Normalize Repository Name
  it('should safely normalize repository name to display name', () => {
    const normalized = normalizeRepositoryName("ai-trains-ai");
    expect(normalized).toBe("AI Trains AI");
  });

  // 4. Separate full name and canonical display name fields
  it('should manage repository_full_name and canonical_display_name separately', () => {
    const identity = resolveProjectIdentity({
      repositoryFullName: "Danau5tin/ai-trains-ai",
      sourceTitle: "I RL-trained an agent..."
    });
    expect(identity.repository_full_name).toBe("Danau5tin/ai-trains-ai");
    expect(identity.repository_name).toBe("ai-trains-ai");
    expect(identity.canonical_display_name).toBe("AI Trains AI");
  });

  // 5. Overall Confidence Ceilings tests
  describe('Confidence Ceilings inside recalculateScoresV2', () => {
    const baseEvaluationOutput = {
      schema_version: "2.0.0",
      project_identity: {
        canonical_display_name: "AI Trains AI",
        source_title: "I RL-trained an agent",
        identity_source: "readme_h1"
      },
      product: {
        name: "AI Trains AI",
        category: "AI Agent",
        summary: "An RL trained agent.",
        primary_audience: "ML Engineers"
      },
      article: {
        headline: "Revolutionary Agent",
        standfirst: "RL agent description",
        jury_summary: "Summary here",
        where_jury_agreed: [],
        where_jury_disagreed: [],
        evidence_limitations: [],
        evidence_classifications: [
          { evidence_id: "ev-1", classification: "creator_claim", claim: "High performance" }
        ],
        final_verdict: "A great agent.",
        meta_description: "Meta description."
      },
      judges: [
        {
          judge_id: "david",
          judge_name: "David",
          role: "Engineer",
          verdict: "Solid implementation.",
          strengths: [],
          concerns: [],
          decisive_question: "How does it scale?",
          criteria: [
            { criterion_id: "technical_quality", score: 4.5, confidence: "high", reasoning: "Code looks good.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "implementation_evidence", score: 4.0, confidence: "high", reasoning: "Tests look robust.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "purpose_usefulness", score: 4.5, confidence: "high", reasoning: "Very useful.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "usability_onboarding", score: 4.0, confidence: "high", reasoning: "Easy setup.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "Highly differentiated.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 4.0, confidence: "high", reasoning: "Active.", evidence_ids: ["ev-1"], limitations: [] }
          ]
        },
        // Duplicate for 5 judges requirement
        {
          judge_id: "alex", judge_name: "Alex", role: "Entrepreneur", verdict: "Nice", strengths: [], concerns: [], decisive_question: "A",
          criteria: [
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "implementation_evidence", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "usability_onboarding", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] }
          ]
        },
        {
          judge_id: "lisa", judge_name: "Lisa", role: "Designer", verdict: "Nice", strengths: [], concerns: [], decisive_question: "A",
          criteria: [
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "implementation_evidence", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "usability_onboarding", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] }
          ]
        },
        {
          judge_id: "sarah", judge_name: "Sarah", role: "PM", verdict: "Nice", strengths: [], concerns: [], decisive_question: "A",
          criteria: [
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "implementation_evidence", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "usability_onboarding", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] }
          ]
        },
        {
          judge_id: "marcus", judge_name: "Marcus", role: "VC", verdict: "Nice", strengths: [], concerns: [], decisive_question: "A",
          criteria: [
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "implementation_evidence", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "usability_onboarding", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 4.0, confidence: "high", reasoning: "According to readme.", evidence_ids: ["ev-1"], limitations: [] }
          ]
        }
      ]
    };

    // 15. Technical High Confidence requires Core Source Evidence >= 2
    it('should cap Technical Quality Confidence to MEDIUM if core sources < 2', () => {
      const evaluator = new Evaluator();
      
      // Evidences with 0 source_code files
      const mockEvidences = [
        {
          evidence_id: "ev-1", type: "readme", url: "https://example.com/readme",
          title: "Readme", retrieved_at: new Date().toISOString(), content_hash: "1",
          summary: "Just readme", claims: []
        }
      ];

      const recalculated = evaluator.recalculateScores(baseEvaluationOutput, mockEvidences as any);
      
      // Verify david's technical quality confidence was capped to medium
      const davidTQ = recalculated.judges[0].criteria.find(c => c.criterion_id === 'technical_quality');
      expect(davidTQ?.confidence).toBe('medium');
      
      const adjustments = (recalculated as any).confidence_adjustments;
      expect(adjustments.some((adj: any) => adj.reason_codes.includes('INSUFFICIENT_CORE_SOURCE'))).toBe(true);
    });

    // 13. Test Confidence is LOW if actual test files are missing
    it('should cap Test Confidence to LOW if actual test files are missing', () => {
      const evaluator = new Evaluator();
      
      // Evidences with 0 test_file
      const mockEvidences = [
        {
          evidence_id: "ev-1", type: "readme", url: "https://example.com/readme",
          title: "Readme", retrieved_at: new Date().toISOString(), content_hash: "1",
          summary: "conftest.py exists.", claims: []
        }
      ];

      const recalculated = evaluator.recalculateScores(baseEvaluationOutput, mockEvidences as any);
      
      const davidIE = recalculated.judges[0].criteria.find(c => c.criterion_id === 'implementation_evidence');
      expect(davidIE?.confidence).toBe('low');
    });

    // 14. Test Confidence is MEDIUM if test files are present but no run commands/CI results
    it('should cap Test Confidence to MEDIUM if test files present but execution evidence is missing', () => {
      const evaluator = new Evaluator();
      
      // Evidences with test_file but no run command in readme
      const mockEvidences = [
        {
          evidence_id: "ev-1", type: "readme", url: "https://example.com/readme",
          title: "Readme", retrieved_at: new Date().toISOString(), content_hash: "1",
          summary: "No test commands mentioned here.", claims: []
        },
        {
          evidence_id: "ev-2", type: "test_file", url: "https://example.com/test_core.py",
          title: "test_core.py", retrieved_at: new Date().toISOString(), content_hash: "2",
          summary: "def test_function(): pass", claims: []
        }
      ];

      const recalculated = evaluator.recalculateScores(baseEvaluationOutput, mockEvidences as any);
      
      const davidIE = recalculated.judges[0].criteria.find(c => c.criterion_id === 'implementation_evidence');
      expect(davidIE?.confidence).toBe('medium');
    });

    // 18. Empirical claim is creator_claim only -> Overall Confidence <= MEDIUM
    it('should cap Overall Confidence to MEDIUM if empirical claims rely solely on creator claim', () => {
      const evaluator = new Evaluator();
      
      const mockEvidences = [
        {
          evidence_id: "ev-1", type: "readme", url: "https://example.com/readme",
          title: "Readme", retrieved_at: new Date().toISOString(), content_hash: "1",
          summary: "Creator reports performance.", claims: []
        }
      ];

      const recalculated = evaluator.recalculateScores(baseEvaluationOutput, mockEvidences as any);
      expect(recalculated.overall_evidence_confidence).toBeLessThanOrEqual(0.66);
    });
  });
});
