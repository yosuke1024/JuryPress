import { describe, it, expect } from 'vitest';
import { buildManualRunKey, buildScheduledRunKey, isValidRunKey, assertSafeRunKey } from '../../src/lib/publication/run-keys';

describe('Run keys', () => {
  it('builds the scheduled daily run key from the JST date', () => {
    // 16:00 UTC is already the next day in JST (+09:00).
    expect(buildScheduledRunKey(2, new Date('2026-07-14T16:00:00Z'))).toBe('season-2-2026-07-15-daily');
    expect(buildScheduledRunKey(2, new Date('2026-07-14T00:15:00Z'))).toBe('season-2-2026-07-14-daily');
  });

  it('builds manual run keys from github.run_id only — run_attempt never changes the key', () => {
    const key = buildManualRunKey(2, '16543219876');
    expect(key).toBe('season-2-manual-16543219876');
    // Same run id (a GitHub re-run keeps run_id, bumps run_attempt) → identical key.
    expect(buildManualRunKey(2, '16543219876')).toBe(key);
    // A fresh dispatch gets a new run id → a different key.
    expect(buildManualRunKey(2, '16543219877')).not.toBe(key);
  });

  it('rejects non-numeric workflow run ids', () => {
    expect(() => buildManualRunKey(2, 'abc')).toThrow();
    expect(() => buildManualRunKey(2, '123/456')).toThrow();
    expect(() => buildManualRunKey(0, '123')).toThrow();
  });

  it('validates supported run key formats', () => {
    expect(isValidRunKey('season-2-2026-07-15-daily')).toBe(true);
    expect(isValidRunKey('season-2-manual-16543219876')).toBe(true);
    // Legacy bootstrap keys carried a slug suffix.
    expect(isValidRunKey('season-2-2026-07-14-daily-jurypress-d331d2')).toBe(true);
    expect(isValidRunKey('season-2-weekly-1')).toBe(false);
    expect(isValidRunKey('')).toBe(false);
  });

  it('fails closed on path traversal and forbidden characters', () => {
    for (const bad of [
      '../etc/passwd',
      'season-2-manual-1/../../x',
      'season-2-manual-1/evil',
      'season-2-manual-1\\evil',
      'season-2-2026-07-15-daily/..',
      'season-2-manual-1\0'
    ]) {
      expect(() => assertSafeRunKey(bad)).toThrow();
    }
    expect(() => assertSafeRunKey('season-2-2026-07-15-daily')).not.toThrow();
    expect(() => assertSafeRunKey('season-2-manual-42')).not.toThrow();
  });
});
