import { describe, it, expect } from 'vitest';
import { buildUnavailableRecord, contentHash } from '../../src/lib/generation/record-store';
import { GenerationRecordSchema } from '../../src/schemas/generation-record';
import { isPubliclyVisible } from '../../src/lib/generation/public-visibility';

/**
 * Migration records for runs whose Gemini response predates response-first persistence and
 * cannot be recovered. The invariant: a well-formed, terminal, fail-closed record that never
 * fabricates content and can never reach a public surface.
 */
describe('buildUnavailableRecord', () => {
  const base = {
    recordId: 'season-2-manual-29527296315',
    candidateId: '1136590548',
    runKey: 'season-2-manual-29527296315',
    canonicalUrl: 'https://github.com/affaan-m/ECC',
    candidateName: 'affaan-m/ECC',
    slug: null,
    originalFailedAt: '2026-07-16T20:17:04.031Z',
    migratedAt: '2026-07-17T10:00:00.000Z',
    reason: 'Failed before response-first persistence; raw response unrecoverable.',
    recoveredFrom: ['season-2-manual-29527296315.json', 'season-2-manual-29527296315.failure.json'],
    notes: 'error_code=GeminiEvaluationExhaustedError, attempts=6'
  };

  it('produces a schema-valid record', () => {
    const record = buildUnavailableRecord(base);
    expect(() => GenerationRecordSchema.parse(record)).not.toThrow();
  });

  it('marks generation unavailable with no raw response and no reconstructed content', () => {
    const record = buildUnavailableRecord(base);
    expect(record.generation.status).toBe('unavailable');
    expect(record.generation.rawResponse).toBeNull();
    expect(record.generation.originalContent).toBeNull();
    expect(record.editorial.currentContent).toBeNull();
  });

  it('is terminal and excluded, never pending publication', () => {
    const record = buildUnavailableRecord(base);
    expect(record.publication.status).toBe('excluded');
    expect(record.publication.reason).toBe('generation_unavailable');
  });

  it('does not file the generation gap as a fabricated quality failure', () => {
    const record = buildUnavailableRecord(base);
    expect(record.quality.status).toBe('pending');
    expect(record.quality.errors).toHaveLength(0);
  });

  it('records why nothing was recovered and what was consulted, for audit', () => {
    const record = buildUnavailableRecord(base);
    expect(record.migration?.recoverable).toBe(false);
    expect(record.migration?.recoveredFrom).toEqual(base.recoveredFrom);
    expect(record.migration?.reason).toContain('response-first persistence');
    expect(record.migration?.notes).toContain('attempts=6');
  });

  it('keeps a well-formed revision 0 standing in for the lost Gemini original', () => {
    const record = buildUnavailableRecord(base);
    expect(record.editorial.revisions).toHaveLength(1);
    expect(record.editorial.revisions[0].revision).toBe(0);
    expect(record.editorial.revisions[0].source).toBe('gemini');
    expect(record.editorial.revisions[0].contentHash).toBe(contentHash(null));
  });

  it('can never be publicly visible', () => {
    const record = buildUnavailableRecord(base);
    expect(isPubliclyVisible(record)).toBe(false);
  });

  it('preserves candidate identity from the recovered run data', () => {
    const record = buildUnavailableRecord(base);
    expect(record.candidate.id).toBe('1136590548');
    expect(record.candidate.name).toBe('affaan-m/ECC');
    expect(record.candidate.canonicalUrl).toBe('https://github.com/affaan-m/ECC');
    expect(record.candidate.runKey).toBe('season-2-manual-29527296315');
  });
});
