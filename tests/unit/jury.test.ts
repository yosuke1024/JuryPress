import { describe, it, expect } from 'vitest';
import { getJudges, getJudge, getRubric } from '../../src/lib/jury';
import { JUDGE_SLUGS } from '../../src/schemas/jury';
import * as fs from 'fs';
import * as path from 'path';

describe('Jury Loader', () => {
  it('should load exactly 5 judges', () => {
    const judges = getJudges();
    expect(judges.length).toBe(5);
  });

  it('should have correct slugs matching JUDGE_SLUGS', () => {
    const judges = getJudges();
    const slugs = judges.map(j => j.slug).sort();
    expect(slugs).toEqual([...JUDGE_SLUGS].sort());
  });

  it('should have correct names and roles', () => {
    const judges = getJudges();
    const nameRoleMap: Record<string, string> = {
      alex: 'Serial Entrepreneur',
      david: 'Principal Software Engineer',
      lisa: 'Head of Product Design',
      sarah: 'Senior Product Manager',
      marcus: 'Venture Capitalist',
    };
    for (const judge of judges) {
      expect(judge.name).toBe(judge.slug.charAt(0).toUpperCase() + judge.slug.slice(1));
      expect(judge.role).toBe(nameRoleMap[judge.slug]);
    }
  });

  it('should parse required sections for each judge', () => {
    const judges = getJudges();
    for (const judge of judges) {
      expect(judge.background.length).toBeGreaterThan(10);
      expect(judge.personalityAndTone.length).toBeGreaterThan(10);
      expect(judge.expertise.length).toBeGreaterThan(0);
    }
  });

  it('should parse Loves for each judge', () => {
    const judges = getJudges();
    for (const judge of judges) {
      expect(judge.loves.length).toBeGreaterThan(0);
      for (const love of judge.loves) {
        expect(love.length).toBeGreaterThan(0);
      }
    }
  });

  it('should parse Hates for each judge', () => {
    const judges = getJudges();
    for (const judge of judges) {
      expect(judge.hates.length).toBeGreaterThan(0);
      for (const hate of judge.hates) {
        expect(hate.length).toBeGreaterThan(0);
      }
    }
  });

  it('should parse Evaluation Framework for each judge', () => {
    const judges = getJudges();
    for (const judge of judges) {
      expect(judge.evaluationLenses.length).toBeGreaterThan(0);
      for (const lens of judge.evaluationLenses) {
        expect(lens.label.length).toBeGreaterThan(0);
        expect(lens.question.length).toBeGreaterThan(0);
      }
    }
  });

  it('should retrieve individual judge by slug', () => {
    for (const slug of JUDGE_SLUGS) {
      const judge = getJudge(slug);
      expect(judge.slug).toBe(slug);
    }
  });

  it('should have avatar files for all 5 judges', () => {
    for (const slug of JUDGE_SLUGS) {
      const avatarPath = path.join(process.cwd(), 'public', 'avatars', `${slug}.jpg`);
      expect(fs.existsSync(avatarPath)).toBe(true);
    }
  });
});

describe('Rubric Loader', () => {
  it('should load exactly 6 criteria', () => {
    const rubric = getRubric();
    expect(rubric.length).toBe(6);
  });

  it('should have weights summing to 100', () => {
    const rubric = getRubric();
    const totalWeight = rubric.reduce((sum, c) => sum + c.weight, 0);
    expect(totalWeight).toBe(100);
  });

  it('should parse "What judges evaluate" for each criterion', () => {
    const rubric = getRubric();
    for (const criterion of rubric) {
      expect(criterion.whatJudgesEvaluate.length).toBeGreaterThan(0);
      for (const item of criterion.whatJudgesEvaluate) {
        expect(item.length).toBeGreaterThan(0);
      }
    }
  });

  it('should parse "Strong signals" for each criterion', () => {
    const rubric = getRubric();
    for (const criterion of rubric) {
      expect(criterion.strongSignals.length).toBeGreaterThan(0);
      for (const item of criterion.strongSignals) {
        expect(item.length).toBeGreaterThan(0);
      }
    }
  });

  it('should have correct criterion names', () => {
    const rubric = getRubric();
    const expectedNames = [
      'Innovation & Creativity',
      'Technical Implementation',
      'Problem Solving & Impact',
      'Product & UX',
      'Working Prototype',
      'Presentation',
    ];
    expect(rubric.map(c => c.name)).toEqual(expectedNames);
  });

  it('should have correct weights', () => {
    const rubric = getRubric();
    const expectedWeights = [20, 20, 20, 15, 15, 10];
    expect(rubric.map(c => c.weight)).toEqual(expectedWeights);
  });
});
