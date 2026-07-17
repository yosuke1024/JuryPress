import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRecommendationFixture } from '../fixtures/refined-review';
import {
  buildInitialRecord,
  readRecord,
  writeRecord,
  contentHash,
  recordsDir
} from '../../src/lib/generation/record-store';
import { validateAndPersist } from '../../src/lib/generation/pipeline';
import { buildReviewFromRecord } from '../../src/lib/generation/build-review';
import { prepareEdit, BaselineUnavailableError } from '../../src/lib/generation/review-edit';
import { publishRecord, PublishGateError } from '../../src/lib/generation/publish';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * The manual-edit lifecycle end to end, exercised at the service layer:
 * excluded -> prepare-edit -> edit -> validate -> ready -> publish -> published.
 */
describe('Manual edit flow', () => {
  let contentRoot: string;
  let fixture: ReturnType<typeof createRecommendationFixture>;
  const recordId = 'season-2-manual-777001';

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-manual-edit-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    fixture = createRecommendationFixture();
  });

  afterEach(() => {
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  const seasonConfig = () => ({ season: 2 });

  function seedRecord(overrides: Partial<Parameters<typeof buildInitialRecord>[0]> = {}): GenerationRecord {
    const record = buildInitialRecord({
      recordId,
      candidateId: 'refined-product-id',
      runKey: recordId,
      canonicalUrl: 'https://github.com/example/refined-product',
      candidateName: 'Refined Product',
      slug: 'recommended-product',
      receivedAt: '2026-07-17T00:00:00.000Z',
      model: 'fixture-model',
      modelVersion: 'fixture-model',
      promptVersion: '2.1.0',
      promptHash: 'a'.repeat(64),
      rawResponse: JSON.stringify(fixture.generatedOutput),
      originalContent: fixture.generatedOutput,
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3, thinkingTokens: null, cachedInputTokens: null },
      route: {
        requestedModel: 'fixture-model', thinkingLevel: 'HIGH', successfulRoute: 'primary',
        failoverUsed: false, primaryAttempts: 1, fallbackAttempts: 0, totalAttempts: 1, charactersSentToModel: 10
      },
      ...overrides
    });
    return writeRecord(contentRoot, record);
  }

  function validate(id = recordId): GenerationRecord {
    validateAndPersist({
      contentRoot,
      recordId: id,
      evidences: fixture.context.evidences,
      buildPublishedContent: content => {
        buildReviewFromRecord({
          record: readRecord(contentRoot, id)!,
          collectionResult: fixture.context,
          seasonConfig: seasonConfig(),
          date: new Date('2026-07-17T00:00:00.000Z'),
          content
        });
      }
    });
    return readRecord(contentRoot, id)!;
  }

  function publish(id = recordId, expectedHash?: string) {
    const record = readRecord(contentRoot, id)!;
    return publishRecord({
      contentRoot,
      recordId: id,
      expectedContentHash: expectedHash ?? (record.quality.validatedContentHash as string),
      collectionResult: fixture.context,
      selection: fixture.selection,
      seasonConfig: seasonConfig(),
      publishedAt: '2026-07-17T02:00:00.000Z',
      date: new Date('2026-07-17T00:00:00.000Z')
    });
  }

  /** Excludes a validated record the way a real quality failure would (for edit tests). */
  function forceExcluded(id = recordId): void {
    const record = readRecord(contentRoot, id)!;
    writeRecord(contentRoot, {
      ...record,
      quality: {
        ...record.quality,
        status: 'failed',
        errors: [{ code: 'CLAIM_PROVENANCE_MISSING', path: '$.article.summary', message: 'seeded failure', severity: 'error', ruleVersion: '2.0.0' }],
        history: [
          ...record.quality.history,
          { validationId: 'seed-fail', revision: 0, contentHash: contentHash(record.editorial.currentContent), checkedAt: '2026-07-17T00:30:00.000Z', validatorVersion: '1.0.0', status: 'failed', errors: [{ code: 'CLAIM_PROVENANCE_MISSING', path: '$.article.summary', message: 'seeded failure', severity: 'error', ruleVersion: '1.0.0' }], warnings: [] }
        ]
      },
      publication: { status: 'excluded', reason: 'quality_validation_failed', publishedAt: null }
    });
  }

  it('validates an autonomous record to ready without publishing', () => {
    seedRecord();
    const record = validate();
    expect(record.quality.status).toBe('passed');
    expect(record.publication.status).toBe('ready');
    // Validation NEVER writes review.json.
    expect(fs.existsSync(path.join(contentRoot, 'reviews'))).toBe(false);
  });

  it('publishes only through the publish service, and materializes review.json there', () => {
    seedRecord();
    validate();
    const result = publish();
    expect(result.alreadyPublished).toBe(false);
    const reviewPath = path.join(contentRoot, 'reviews', '2026', '07', 'recommended-product', 'review.json');
    expect(fs.existsSync(reviewPath)).toBe(true);
    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');
  });

  it('opens an excluded record for editing as a new human revision', () => {
    seedRecord();
    validate();
    forceExcluded();
    const excluded = readRecord(contentRoot, recordId)!;
    const result = prepareEdit(excluded, { reason: 'fix wording', editedAt: '2026-07-17T01:00:00.000Z' });
    writeRecord(contentRoot, result.record);

    const edited = readRecord(contentRoot, recordId)!;
    expect(edited.editorial.mode).toBe('human_edited');
    expect(edited.editorial.currentRevision).toBe(1);
    expect(edited.editorial.revisions).toHaveLength(2);
    expect(edited.editorial.revisions[1].source).toBe('human_edited');
    expect(edited.publication.status).toBe('editing');
    // The Gemini original is untouched.
    expect(edited.generation.rawResponse).toBe(excluded.generation.rawResponse);
    expect(contentHash(edited.generation.originalContent)).toBe(contentHash(excluded.generation.originalContent));
  });

  it('cannot overwrite the original response or original content via an edit', () => {
    seedRecord();
    validate();
    forceExcluded();
    const excluded = readRecord(contentRoot, recordId)!;
    const result = prepareEdit(excluded, { reason: 'x', editedAt: '2026-07-17T01:00:00.000Z' });
    const tampered: GenerationRecord = {
      ...result.record,
      generation: { ...result.record.generation, rawResponse: 'REWRITTEN' }
    };
    expect(() => writeRecord(contentRoot, tampered)).toThrow(/rawResponse.*immutable/i);
  });

  it('runs the same validator on a human revision and rejects a changed overall score', () => {
    seedRecord();
    validate();
    forceExcluded();
    const result = prepareEdit(readRecord(contentRoot, recordId)!, { reason: 'x', editedAt: '2026-07-17T01:00:00.000Z' });
    // Human tampers with the recalculated jury score in the editable content.
    const edited = structuredClone(result.record);
    (edited.editorial.currentContent as any).recalculated_jury_score = 4.99;
    writeRecord(contentRoot, edited);

    const validated = validate();
    expect(validated.quality.status).toBe('failed');
    expect(validated.quality.errors.some(e => e.code === 'IMMUTABLE_JUDGMENT_FIELD_CHANGED')).toBe(true);
  });

  it('rejects a changed criterion score on a human revision', () => {
    seedRecord();
    validate();
    forceExcluded();
    const result = prepareEdit(readRecord(contentRoot, recordId)!, { reason: 'x', editedAt: '2026-07-17T01:00:00.000Z' });
    const edited = structuredClone(result.record);
    (edited.editorial.currentContent as any).judges[0].criteria[0].score = 0;
    writeRecord(contentRoot, edited);
    const validated = validate();
    expect(validated.quality.status).toBe('failed');
    expect(validated.quality.errors.some(e => e.code === 'IMMUTABLE_JUDGMENT_FIELD_CHANGED')).toBe(true);
  });

  it('rejects a changed candidate identity at the storage layer', () => {
    seedRecord();
    const record = readRecord(contentRoot, recordId)!;
    expect(() => writeRecord(contentRoot, { ...record, candidate: { ...record.candidate, id: 'someone-else' } }))
      .toThrow(/candidate identity.*immutable/i);
  });

  it('rejects changed model/prompt/token provenance at the storage layer', () => {
    seedRecord();
    const record = readRecord(contentRoot, recordId)!;
    expect(() => writeRecord(contentRoot, { ...record, generation: { ...record.generation, model: 'other' } }))
      .toThrow(/generation.model.*immutable/i);
    expect(() => writeRecord(contentRoot, { ...record, generation: { ...record.generation, promptHash: 'b'.repeat(64) } }))
      .toThrow(/promptHash.*immutable/i);
    expect(() => writeRecord(contentRoot, {
      ...record,
      generation: { ...record.generation, usage: { ...record.generation.usage, totalTokens: 999 } }
    })).toThrow(/generation.usage.*immutable/i);
  });

  it('rejects an edit that adds a nonexistent evidence reference', () => {
    seedRecord();
    validate();
    forceExcluded();
    const result = prepareEdit(readRecord(contentRoot, recordId)!, { reason: 'x', editedAt: '2026-07-17T01:00:00.000Z' });
    const edited = structuredClone(result.record);
    const step = (edited.editorial.currentContent as any).judges[0].recommended_next_step;
    step.evidence_ids = [...step.evidence_ids, 'ev-does-not-exist'];
    writeRecord(contentRoot, edited);
    const validated = validate();
    expect(validated.quality.status).toBe('failed');
    expect(validated.quality.errors.some(e => e.code === 'EVIDENCE_ID_NOT_FOUND')).toBe(true);
  });

  it('refuses to publish when the content hash does not match the validated hash', () => {
    seedRecord();
    validate();
    expect(() => publish(recordId, 'f'.repeat(64))).toThrow(PublishGateError);
  });

  it('refuses to publish a record whose quality is not passed (no skip)', () => {
    seedRecord();
    validate();
    forceExcluded();
    const record = readRecord(contentRoot, recordId)!;
    expect(() => publish(recordId, record.quality.validatedContentHash ?? 'f'.repeat(64)))
      .toThrow(/quality.*not.*passed|is never skippable/i);
  });

  it('holds a human-edited revision at ready until an explicit publish', () => {
    seedRecord();
    validate();
    forceExcluded();
    const result = prepareEdit(readRecord(contentRoot, recordId)!, { reason: 'reword only', editedAt: '2026-07-17T01:00:00.000Z' });
    writeRecord(contentRoot, result.record); // no content change beyond the clone
    const validated = validate();
    expect(validated.quality.status).toBe('passed');
    expect(validated.publication.status).toBe('ready');
    expect(fs.existsSync(path.join(contentRoot, 'reviews'))).toBe(false);
    // Explicit publish then materializes it.
    const published = publish();
    expect(published.record.publication.status).toBe('published');
    expect(published.record.editorial.mode).toBe('human_edited');
  });
});
