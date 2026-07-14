import { describe, it, expect } from 'vitest';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import * as fs from 'fs';
import * as path from 'path';

describe('Evaluator', () => {
  it('should correctly recalculate jury scores', () => {
    const evaluator = new Evaluator();
    
    // Mock the rubric parsing to ensure test consistency without file system
    (evaluator as any).rubric = {
      criteria: [
        { name: "innovation_creativity", weight: 20 },
        { name: "technical_implementation", weight: 20 },
        { name: "problem_solving_impact", weight: 20 },
        { name: "product_ux", weight: 15 },
        { name: "working_prototype", weight: 15 },
        { name: "presentation", weight: 10 }
      ]
    };

    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'review.json');
    const fixtureReview = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    const mockOutput = fixtureReview.evaluation;

    // Remove recalculated fields to simulate pre-calculation state
    delete mockOutput.recalculated_jury_score;
    delete mockOutput.judge_score_range;
    for (const judge of mockOutput.judges) {
      delete judge.judge_score;
      for (const crit of judge.criteria) {
        delete crit.weighted_score;
      }
    }
    
    // We need exactly 5 judges and 6 criteria each. The fixture provides 5 judges with 6 criteria each.
    // However, the test expects a specific score logic. The fixture uses all 4 and 5 scores.
    // Let's modify the first two judges' scores in the mockOutput to test the math precisely, 
    // and keep the other 3 as they are.

    mockOutput.judges[0].criteria[0].score = 4.0;
    mockOutput.judges[0].criteria[1].score = 3.0;
    mockOutput.judges[0].criteria[2].score = 4.0;
    mockOutput.judges[0].criteria[3].score = 5.0;
    mockOutput.judges[0].criteria[4].score = 4.0;
    mockOutput.judges[0].criteria[5].score = 3.0;

    mockOutput.judges[1].criteria[0].score = 3.0;
    mockOutput.judges[1].criteria[1].score = 5.0;
    mockOutput.judges[1].criteria[2].score = 3.0;
    mockOutput.judges[1].criteria[3].score = 3.0;
    mockOutput.judges[1].criteria[4].score = 5.0;
    mockOutput.judges[1].criteria[5].score = 4.0;

    const final = evaluator.recalculateScores(mockOutput);
    
    // Alex (judges[0]) total: (4/5)*20 + (3/5)*20 + (4/5)*20 + (5/5)*15 + (4/5)*15 + (3/5)*10 
    // = 16 + 12 + 16 + 15 + 12 + 6 = 77
    expect(final.judges[0].judge_score).toBe(77);

    // David (judges[1]) total: (3/5)*20 + (5/5)*20 + (3/5)*20 + (3/5)*15 + (5/5)*15 + (4/5)*10
    // = 12 + 20 + 12 + 9 + 15 + 8 = 76
    expect(final.judges[1].judge_score).toBe(76);

    // Lisa: 90, Sarah: 74, Marcus: 80
    
    // Total jury score = (77 + 76 + 90 + 74 + 80) / 5 = 397 / 5 = 79.4
    expect(final.recalculated_jury_score).toBe(79.4);
    expect(final.judge_score_range.min).toBe(74);
    expect(final.judge_score_range.max).toBe(90);
  });

  it('should correctly recalculate jury scores under V2 rubric and handle not_assessable by setting score to null', () => {
    const evaluator = new Evaluator();
    
    // Set V2 schema version
    const mockOutputV2: any = {
      schema_version: "2.0.0",
      product: {
        name: "Test OSS Tool",
        category: "DevTools",
        summary: "A mock tool",
        primary_audience: "Developers"
      },
      article: {
        headline: "A headline",
        standfirst: "standfirst",
        jury_summary: "summary",
        where_jury_agreed: [],
        where_jury_disagreed: [],
        evidence_limitations: [],
        evidence_classifications: [],
        final_verdict: "verdict",
        meta_description: "meta"
      },
      judges: [
        {
          judge_id: "alex",
          judge_name: "Alex",
          role: "Entrepreneur",
          verdict: "V",
          strengths: [],
          concerns: [],
          decisive_question: "Q",
          criteria: [
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "implementation_evidence", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "usability_onboarding", score: 5.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] }
          ]
        },
        {
          judge_id: "david",
          judge_name: "David",
          role: "Engineer",
          verdict: "V",
          strengths: [],
          concerns: [],
          decisive_question: "Q",
          criteria: [
            { criterion_id: "purpose_usefulness", score: null, confidence: "not_assessable", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "implementation_evidence", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "usability_onboarding", score: 5.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] }
          ]
        },
        {
          judge_id: "lisa",
          judge_name: "Lisa",
          role: "Designer",
          verdict: "V",
          strengths: [],
          concerns: [],
          decisive_question: "Q",
          criteria: [
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "implementation_evidence", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "usability_onboarding", score: 5.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] }
          ]
        },
        {
          judge_id: "sarah",
          judge_name: "Sarah",
          role: "PM",
          verdict: "V",
          strengths: [],
          concerns: [],
          decisive_question: "Q",
          criteria: [
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "implementation_evidence", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "usability_onboarding", score: 5.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] }
          ]
        },
        {
          judge_id: "marcus",
          judge_name: "Marcus",
          role: "VC",
          verdict: "V",
          strengths: [],
          concerns: [],
          decisive_question: "Q",
          criteria: [
            { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "implementation_evidence", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "usability_onboarding", score: 5.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] },
            { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high", reasoning: "R", evidence_ids: [], limitations: [] }
          ]
        }
      ]
    };

    // Calculate with not_assessable (must result in null jury score)
    const resultWithNull = evaluator.recalculateScores(mockOutputV2);
    expect(resultWithNull.recalculated_jury_score).toBeNull();
    expect(resultWithNull.judges[1].judge_score).toBeNull();
    expect(resultWithNull.judge_score_range.min).toBeNull();
    expect(resultWithNull.judge_score_range.max).toBeNull();

    // Now convert not_assessable to high and provide score (must calculate non-null score)
    mockOutputV2.judges[1].criteria[0].confidence = "high";
    mockOutputV2.judges[1].criteria[0].score = 4.0;

    const resultNonNull = evaluator.recalculateScores(mockOutputV2);
    expect(resultNonNull.recalculated_jury_score).not.toBeNull();
    expect(resultNonNull.judges[1].judge_score).toBe(77); // (4/5)*20 + (3/5)*20 + (4/5)*20 + (5/5)*15 + (4/5)*15 + (3/5)*10 = 16+12+16+15+12+6 = 77
    expect(resultNonNull.recalculated_jury_score).toBe(77); // All judges are 77
  });

  describe('Regression - Production Evaluation Refinement', () => {
    it('should allow Medium confidence for technical_quality when only README-only evidence is present', () => {
      const evaluator = new Evaluator();
      const mockOutput: any = {
        schema_version: "2.0.0",
        product: { name: "A", category: "B", summary: "C", primary_audience: "D" },
        article: {
          headline: "H", standfirst: "S", jury_summary: "JS",
          where_jury_agreed: [], where_jury_disagreed: [],
          evidence_limitations: [], evidence_classifications: [],
          final_verdict: "FV", meta_description: "M"
        },
        judges: [
          {
            judge_id: "alex", judge_name: "Alex", role: "R", verdict: "V", strengths: ["S1"], concerns: ["C1"], decisive_question: "Q1",
            criteria: [
              { criterion_id: "purpose_usefulness", score: 4.0, confidence: "medium", reasoning: "creator claim suggests R", evidence_ids: ["ev-1"], limitations: ["L1"] },
              { criterion_id: "implementation_evidence", score: 3.0, confidence: "medium", reasoning: "creator claim suggests R", evidence_ids: ["ev-1"], limitations: ["L1"] },
              { criterion_id: "technical_quality", score: 3.5, confidence: "medium", reasoning: "creator claim suggests R", evidence_ids: ["ev-1"], limitations: ["L1"] },
              { criterion_id: "usability_onboarding", score: 4.0, confidence: "medium", reasoning: "creator claim suggests R", evidence_ids: ["ev-1"], limitations: ["L1"] },
              { criterion_id: "differentiation_insight", score: 4.0, confidence: "medium", reasoning: "creator claim suggests R", evidence_ids: ["ev-1"], limitations: ["L1"] },
              { criterion_id: "project_health_stewardship", score: 3.0, confidence: "medium", reasoning: "creator claim suggests R", evidence_ids: ["ev-1"], limitations: ["L1"] }
            ]
          }
        ]
      };
      
      const judgeIds = ["alex", "david", "lisa", "sarah", "marcus"];
      mockOutput.judges = judgeIds.map((id, index) => ({
        ...mockOutput.judges[0],
        judge_id: id,
        judge_name: id,
        verdict: `verdict ${index}`,
        strengths: [`strength ${index}`],
        concerns: [`concern ${index}`],
        decisive_question: `question ${index}`,
        criteria: mockOutput.judges[0].criteria.map((c: any) => ({
          ...c,
          reasoning: `${c.reasoning} for ${id}`
        }))
      }));

      const evidences = [
        { evidence_id: "ev-1", type: "readme", url: "https://github.com/test/repo", title: "README", retrieved_at: "", content_hash: "", summary: "A", claims: [] }
      ];

      expect(() => (evaluator as any).verifyRules(mockOutput, evidences)).not.toThrow();

      mockOutput.judges[0].criteria[2].confidence = "high";
      expect(() => (evaluator as any).verifyRules(mockOutput, evidences)).toThrow(/cannot be High confidence under README-only evidence/);
    });

    it('should throw error if popularity misuse phrases appear in output', () => {
      const evaluator = new Evaluator();
      const mockOutput: any = {
        schema_version: "2.0.0",
        product: { name: "A", category: "B", summary: "C", primary_audience: "D" },
        article: {
          headline: "H", standfirst: "S", jury_summary: "JS",
          where_jury_agreed: [], where_jury_disagreed: [],
          evidence_limitations: [], evidence_classifications: [],
          final_verdict: "FV", meta_description: "M"
        },
        judges: []
      };

      const judgeIds = ["alex", "david", "lisa", "sarah", "marcus"];
      mockOutput.judges = judgeIds.map((id, index) => ({
        judge_id: id, judge_name: id, role: "R", verdict: `V ${index}`, strengths: [`S ${index}`], concerns: [`C ${index}`], decisive_question: `Q ${index}`,
        criteria: [
          { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "implementation_evidence", score: 3.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-2"], limitations: [] },
          { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: `stars prove reliability for ${id}`, evidence_ids: ["ev-2"], limitations: [] },
          { criterion_id: "usability_onboarding", score: 5.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-2"], limitations: [] }
        ]
      }));

      const evidences = [
        { evidence_id: "ev-1", type: "readme", url: "https://github.com/test/repo", title: "README", retrieved_at: "", content_hash: "", summary: "A", claims: [] },
        { evidence_id: "ev-2", type: "source_code", url: "https://github.com/test/repo/main.ts", title: "Main", retrieved_at: "", content_hash: "", summary: "A", claims: [] }
      ];

      expect(() => (evaluator as any).verifyRules(mockOutput, evidences)).toThrow(/Prohibited phrase "stars prove reliability" detected/);
    });

    it('should restrict overall evidence confidence to max 0.79 under requirements matching prompt_version 2.1.0', () => {
      const evaluator = new Evaluator();
      const mockOutput: any = {
        schema_version: "2.0.0",
        product: { name: "A", category: "B", summary: "C", primary_audience: "D" },
        article: {
          headline: "H", standfirst: "S", jury_summary: "JS",
          where_jury_agreed: [], where_jury_disagreed: [],
          evidence_limitations: [], evidence_classifications: [],
          final_verdict: "FV", meta_description: "M"
        },
        judges: []
      };

      const judgeIds = ["alex", "david", "lisa", "sarah", "marcus"];
      mockOutput.judges = judgeIds.map((id, index) => ({
        judge_id: id, judge_name: id, role: "R", verdict: `V ${index}`, strengths: [`S ${index}`], concerns: [`C ${index}`], decisive_question: `Q ${index}`,
        criteria: [
          { criterion_id: "purpose_usefulness", score: 4.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "implementation_evidence", score: 3.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "technical_quality", score: 4.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "usability_onboarding", score: 5.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "differentiation_insight", score: 4.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] },
          { criterion_id: "project_health_stewardship", score: 3.0, confidence: "high", reasoning: `R ${id}`, evidence_ids: ["ev-1"], limitations: [] }
        ]
      }));

      const evidences = [
        { evidence_id: "ev-1", type: "readme", url: "https://github.com/test/repo", title: "README", retrieved_at: "", content_hash: "", summary: "A", claims: [] }
      ];

      // Under prompt_version = "2.0.0", overall_evidence_confidence is unaffected (1.0)
      const resOld = evaluator.recalculateScores(mockOutput, evidences, { prompt_version: "2.0.0" });
      expect(resOld.overall_evidence_confidence).toBe(1.0);

      // Under prompt_version = "2.1.0", since there is no source code / test / CI, overall_evidence_confidence must be capped at 0.79
      const resNew = evaluator.recalculateScores(mockOutput, evidences, { prompt_version: "2.1.0" });
      expect(resNew.overall_evidence_confidence).toBe(0.79);
    });
  });
});
