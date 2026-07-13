import { describe, it, expect } from 'vitest';
import { TimezoneUtil } from '../../src/lib/timezone';

describe('Idempotency Integration', () => {
  it('should generate same run key for same date', () => {
    const d1 = new Date('2026-07-14T00:15:00Z');
    const key1 = TimezoneUtil.getRunKey(1, d1);
    const key2 = TimezoneUtil.getRunKey(1, d1);
    expect(key1).toBe(key2);
    expect(key1).toContain('season-1-2026-07-14-daily');
  });
});
