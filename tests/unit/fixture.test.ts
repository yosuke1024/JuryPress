import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

describe('Review Fixtures', () => {
  it('should meet all validation constraints for public preview', () => {
    const reviewPath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'review.json');
    const evidencePath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'evidence.json');
    
    expect(fs.existsSync(reviewPath)).toBe(true);
    expect(fs.existsSync(evidencePath)).toBe(true);
    
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
    
    const evalData = review.evaluation;
    const judges = evalData.judges;
    
    // 5人が一意
    expect(judges.length).toBe(5);
    const judgeIds = new Set(judges.map((j: any) => j.judge_id));
    expect(judgeIds.size).toBe(5);
    
    // 6基準が一意 (per judge)
    for (const judge of judges) {
      expect(judge.criteria.length).toBe(6);
      const critIds = new Set(judge.criteria.map((c: any) => c.criterion_id));
      expect(critIds.size).toBe(6);
    }
    
    // Verdictが全員同一ではない
    const verdicts = new Set(judges.map((j: any) => j.verdict));
    expect(verdicts.size).toBeGreaterThan(1);
    
    // Evidenceが2件以上
    expect(evidence.length).toBeGreaterThanOrEqual(2);
    
    // Evidence参照が有効
    const validEvidenceIds = new Set(evidence.map((e: any) => e.evidence_id));
    for (const judge of judges) {
      for (const crit of judge.criteria) {
        for (const evId of crit.evidence_ids) {
          expect(validEvidenceIds.has(evId)).toBe(true);
        }
      }
    }
    
    // Score再計算が一致
    const totalScore = judges.reduce((sum: number, j: any) => sum + j.judge_score, 0);
    const calculatedAvg = totalScore / 5;
    expect(evalData.recalculated_jury_score).toBeCloseTo(calculatedAvg, 1);
    expect(review.jury_score).toBeCloseTo(calculatedAvg, 1);
    
    const minScore = Math.min(...judges.map((j: any) => j.judge_score));
    const maxScore = Math.max(...judges.map((j: any) => j.judge_score));
    
    expect(review.judge_score_range.min).toBe(minScore);
    expect(review.judge_score_range.max).toBe(maxScore);
  });
});
