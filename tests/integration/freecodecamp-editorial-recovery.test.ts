import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { readFileSync } from 'node:fs';
import { readRecord, writeRecord, recordsDir } from '../../src/lib/generation/record-store';
import { writeRunState } from '../../src/lib/publication/state-store';
import { validateAndPersist } from '../../src/lib/generation/pipeline';
import { buildReviewFromRecord } from '../../src/lib/generation/build-review';
import { publishRecord } from '../../src/lib/generation/publish';
import { validateRefinedReviewIntegrity } from '../../src/lib/publication-integrity';
import { EvidenceBundleSchema } from '../../src/schemas/evidence';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { VALIDATOR_VERSION } from '../../src/lib/generation/validator';
import type { GenerationRecord } from '../../src/schemas/generation-record';

/**
 * The real excluded record `season-2-manual-29626451493` (freeCodeCamp), driven through the
 * production services end to end — the E2E the segmenter fix must satisfy:
 *   excluded → validateAndPersist(+buildReview dry-run) → ready → publishRecord → published,
 * with the review.json clearing validateRefinedReviewIntegrity, no Gemini call, and the raw
 * response / original content / prior history all preserved.
 */
const dir = path.join(__dirname, '..', 'fixtures', 'freecodecamp-record');
const load = (f: string) => JSON.parse(readFileSync(path.join(dir, f), 'utf8'));

describe('freeCodeCamp record — service-level Editorial Recovery E2E', () => {
  let contentRoot: string;
  const recordId = 'season-2-manual-29626451493';
  let genSpy: ReturnType<typeof vi.spyOn>;

  const record = (): GenerationRecord => load('record.json');
  const collectionResult = () => load('collection-result.json');
  const runState = () => load('run-state.json');
  // The REAL production season config, exactly as run-daily and review:revalidate load it.
  const seasonConfig = () => JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));

  beforeEach(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-fcc-'));
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    writeRecord(contentRoot, record());
    writeRunState(contentRoot, runState());
    // Any Gemini call in this flow is a bug: recovery re-validates and publishes stored content.
    genSpy = vi.spyOn(Evaluator.prototype, 'generateRaw');
  });

  afterEach(() => {
    genSpy.mockRestore();
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  function revalidate(): GenerationRecord {
    validateAndPersist({
      contentRoot,
      recordId,
      evidences: collectionResult().evidences,
      // The buildability dry-run runs the FULL publish gate (finalizeRefinedEvaluation): if the
      // content could not become a review, validation fails here rather than at publish.
      buildPublishedContent: content => {
        buildReviewFromRecord({
          record: readRecord(contentRoot, recordId)!,
          collectionResult: collectionResult(),
          seasonConfig: seasonConfig(),
          date: new Date('2026-07-18T00:00:00.000Z'),
          content
        });
      }
    });
    return readRecord(contentRoot, recordId)!;
  }

  function publish() {
    const stored = readRecord(contentRoot, recordId)!;
    return publishRecord({
      contentRoot,
      recordId,
      expectedContentHash: stored.quality.validatedContentHash as string,
      collectionResult: collectionResult(),
      selection: runState().selection,
      seasonConfig: seasonConfig(),
      publishedAt: '2026-07-18T02:00:00.000Z',
      date: new Date('2026-07-18T00:00:00.000Z')
    });
  }

  it('goes excluded → ready → published and materializes a gate-passing review.json', () => {
    const before = record();
    expect(before.publication.status).toBe('excluded');

    // 1-3. revalidate → ready (the gate ran inside the buildability dry-run and passed).
    const ready = revalidate();
    expect(ready.quality.status).toBe('passed');
    expect(ready.quality.errors).toEqual([]);
    expect(ready.publication.status).toBe('ready');

    // Append-only history: prior excluded attempt preserved, a fresh 2.1.0 entry appended.
    expect(ready.quality.history!.length).toBe(before.quality.history!.length + 1);
    expect(ready.quality.history![0]).toEqual(before.quality.history![0]);
    expect(ready.quality.history!.at(-1)!.validatorVersion).toBe(VALIDATOR_VERSION);

    // Not published by ignoring findings: publish is gated on quality.status === 'passed'.
    // Whatever warnings exist are RECORDED on the record, never silently dropped.
    expect(Array.isArray(ready.quality.warnings)).toBe(true);

    // 4-6. publish → published, review.json written.
    const result = publish();
    expect(result.record.publication.status).toBe('published');
    const reviewPath = path.join(contentRoot, 'reviews', '2026', '07', before.slug!, 'review.json');
    expect(fs.existsSync(reviewPath)).toBe(true);
    expect(readRecord(contentRoot, recordId)!.publication.status).toBe('published');

    // 5 (explicit). The materialized review.json clears the COMPLETE production integrity gate —
    // the same validateRefinedReviewIntegrity that CI content validation runs — against the
    // evidence bundle publishRecord wrote next to it. Nothing is excluded: claim provenance,
    // judge-persona identity, confidence adjustments, metadata numbers, the lot.
    const review = JSON.parse(fs.readFileSync(reviewPath, 'utf8'));
    const bundlePath = path.join(path.dirname(reviewPath), 'evidence.json');
    const bundle = EvidenceBundleSchema.parse(JSON.parse(fs.readFileSync(bundlePath, 'utf8')));
    expect(() => validateRefinedReviewIntegrity(review, bundle, before.slug!)).not.toThrow();

    // Immutability: the generator's outputs are byte-identical to the persisted fixture.
    const published = readRecord(contentRoot, recordId)!;
    expect(published.generation.rawResponse).toEqual(before.generation.rawResponse);
    expect(published.generation.originalContent).toEqual(before.generation.originalContent);

    // No Gemini anywhere in the recovery.
    expect(genSpy).not.toHaveBeenCalled();
  });

  it('re-publishing the published record is an idempotent no-op (byte-identical review.json)', () => {
    revalidate();
    publish();
    const reviewPath = path.join(contentRoot, 'reviews', '2026', '07', record().slug!, 'review.json');
    const firstBytes = fs.readFileSync(reviewPath);

    const again = publish();
    expect(again.alreadyPublished).toBe(true);
    expect(fs.readFileSync(reviewPath).equals(firstBytes)).toBe(true);
    expect(genSpy).not.toHaveBeenCalled();
  });
});
