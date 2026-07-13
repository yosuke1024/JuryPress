import { describe, it, expect, vi } from 'vitest';
import { getAllReviews } from '../../src/lib/data';
import * as fs from 'fs';
import * as path from 'path';

describe('Data Integrity Check', () => {
  it('should throw an error if review.json is tampered with', () => {
    const fixturePath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'review.json');
    const validReview = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
    
    // Tamper with the score
    const tamperedReview = JSON.parse(JSON.stringify(validReview));
    tamperedReview.jury_score = 99.9; // fake score
    
    const selectionPath = path.join(process.cwd(), 'tests', 'fixtures', 'reviews', '2026', '07', 'fixture-product', 'selection.json');
    const validSelection = fs.readFileSync(selectionPath, 'utf8');

    // Create a temporary tampered fixture on disk
    const tempDir = path.join(process.cwd(), 'data', 'reviews', '2099', '12', 'temp-fixture');
    fs.mkdirSync(tempDir, { recursive: true });
    
    try {
      fs.writeFileSync(path.join(tempDir, 'review.json'), JSON.stringify(tamperedReview));
      fs.writeFileSync(path.join(tempDir, 'selection.json'), validSelection);
      
      expect(() => getAllReviews()).toThrow(/mismatch/);
    } finally {
      // Cleanup
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
