import { describe, it, expect } from 'vitest';
import { Selector } from '../../src/lib/selection/selector';

describe('Selector', () => {
  it('should exist and define selection methods', () => {
    const selector = new Selector();
    expect(selector.selectForDate).toBeDefined();
  });
});
