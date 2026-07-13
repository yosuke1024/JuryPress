import { describe, it, expect } from 'vitest';
import { getAllReviews } from '../../src/lib/data';
import * as fs from 'fs';
import * as path from 'path';

describe('Data Integrity Check', () => {
  const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'review.json');
  const selectionPath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'selection.json');
  const validSelection = fs.readFileSync(selectionPath, 'utf8');

  function testTampering(modifyFn: (review: any) => void, expectedErrorRegex: RegExp) {
    const validReview = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    modifyFn(validReview);
    
    const tempDir = path.join(process.cwd(), 'data', 'reviews', '2099', '12', 'temp-fixture');
    fs.mkdirSync(tempDir, { recursive: true });
    
    try {
      fs.writeFileSync(path.join(tempDir, 'review.json'), JSON.stringify(validReview));
      fs.writeFileSync(path.join(tempDir, 'selection.json'), validSelection);
      
      expect(() => getAllReviews()).toThrow(expectedErrorRegex);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  }

  it('should throw error if jury_score is tampered', () => {
    testTampering((review) => {
      review.jury_score = 99.9;
    }, /Jury score mismatch/);
  });

  it('should throw error if recalculated_jury_score is tampered', () => {
    testTampering((review) => {
      review.evaluation.recalculated_jury_score = 99.9;
    }, /Evaluation recalculated jury score mismatch/);
  });

  it('should throw error if judge_score_range is tampered', () => {
    testTampering((review) => {
      review.judge_score_range.min = 0;
    }, /Judge score range mismatch/);
  });

  it('should throw error if overall_evidence_confidence is tampered', () => {
    testTampering((review) => {
      review.evaluation.overall_evidence_confidence = 0.99;
    }, /Evidence confidence mismatch/);
  });

  it('should throw error if criterion_averages are tampered', () => {
    testTampering((review) => {
      const keys = Object.keys(review.evaluation.criterion_averages);
      if (keys.length > 0) {
        review.evaluation.criterion_averages[keys[0]] = 9.9;
      }
    }, /Criterion average mismatch/);
  });

  it('should throw error if judge.judge_score is tampered', () => {
    testTampering((review) => {
      review.evaluation.judges[0].judge_score = 99.9;
    }, /score mismatch/);
  });

  it('should throw error if criterion.weighted_score is tampered', () => {
    testTampering((review) => {
      review.evaluation.judges[0].criteria[0].weighted_score = 99.9;
    }, /weighted score mismatch/);
  });
});
