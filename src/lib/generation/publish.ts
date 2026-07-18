import * as fs from 'node:fs';
import * as path from 'node:path';
import type { GenerationRecord } from '../../schemas/generation-record';
import type { EvidenceCollectionResult } from '../../schemas/evidence';
import { EvidenceBundleSchema } from '../../schemas/evidence';
import { TimezoneUtil } from '../timezone';
import { buildReviewFromRecord } from './build-review';
import { contentHash, readRecord, writeRecord } from './record-store';

/**
 * The one place a review.json is ever produced (§ publish gate).
 *
 * Validation and revalidation decide *whether* content may publish; they never materialize
 * it. Publication is a separate, explicit act — for an autonomous run it follows a passing
 * validation automatically, for a human-edited run it waits for an explicit publish workflow —
 * but both go through exactly this function, so nothing reaches the public reviews/ directory
 * without clearing the same gate.
 *
 * The gate, checked before a single byte is written:
 *   generation.status === 'succeeded'
 *   quality.status    === 'passed'
 *   contentHash(currentContent) === quality.validatedContentHash === expectedContentHash
 * The three-way hash equality is the core safety property: the bytes about to be published are
 * provably the bytes that passed validation, not something edited afterward. Because the check
 * precedes every write, a failure here can never leave unvalidated content on a public surface.
 *
 * Quality is never skippable: there is no flag that bypasses these conditions.
 */

export class PublishGateError extends Error {
  constructor(message: string) {
    super(`[Publish Gate] ${message}`);
    this.name = 'PublishGateError';
  }
}

export interface PublishResult {
  record: GenerationRecord;
  slug: string;
  writtenPaths: string[];
  /** True when the record was already published with matching content (idempotent no-op). */
  alreadyPublished: boolean;
}

export function publishRecord(input: {
  contentRoot: string;
  recordId: string;
  /** The content hash the caller expects to publish; must match the validated hash. */
  expectedContentHash: string;
  collectionResult: EvidenceCollectionResult;
  selection: unknown;
  seasonConfig: unknown;
  publishedAt: string;
  /**
   * Optional guard the CLI supplies to prove the on-disk record has not changed since the
   * expected commit (TOCTOU protection). Kept out of this function so it stays unit-testable
   * without git; the CLI does the per-record git verification. Must throw to abort.
   */
  assertRecordUnchanged?: (record: GenerationRecord) => void;
  date?: Date;
}): PublishResult {
  const record = readRecord(input.contentRoot, input.recordId);
  if (!record) {
    throw new PublishGateError(`No generation record exists for ${input.recordId}.`);
  }
  if (!record.slug) {
    throw new PublishGateError(`Record ${input.recordId} has no slug; nothing to publish.`);
  }
  const slug = record.slug;

  const currentHash = contentHash(record.editorial.currentContent);

  // The commit guard runs BEFORE the idempotent early return, not after: an already-published
  // record must still prove it is the record the caller's expected commit describes. Skipping
  // it here would let a bad or nonexistent expected-commit SHA return a false "already
  // published" success without ever verifying the commit. Must throw to abort.
  if (input.assertRecordUnchanged) input.assertRecordUnchanged(record);

  // Idempotent: a record already published with exactly this content is a no-op success, so a
  // re-run after a mid-publish crash converges instead of erroring. The three-way hash equality
  // still holds here (current === validated === expected), and the commit guard above has
  // already confirmed the on-disk record matches the caller's commit.
  if (record.publication.status === 'published' &&
      record.quality.validatedContentHash === currentHash &&
      currentHash === input.expectedContentHash) {
    return { record, slug, writtenPaths: [], alreadyPublished: true };
  }

  if (record.generation.status !== 'succeeded') {
    throw new PublishGateError(`generation.status is "${record.generation.status}", not "succeeded".`);
  }
  if (record.quality.status !== 'passed') {
    throw new PublishGateError(
      `quality.status is "${record.quality.status}", not "passed"; quality is never skippable at publish.`
    );
  }
  if (record.quality.validatedContentHash === null) {
    throw new PublishGateError(`Record ${input.recordId} has no validated content hash.`);
  }
  if (record.quality.validatedContentHash !== currentHash) {
    throw new PublishGateError(
      `The current content hash (${currentHash}) does not match the validated hash ` +
      `(${record.quality.validatedContentHash}); the content changed after validation.`
    );
  }
  if (input.expectedContentHash !== currentHash) {
    throw new PublishGateError(
      `The expected content hash (${input.expectedContentHash}) does not match the record's ` +
      `content (${currentHash}); refusing to publish content the caller did not validate.`
    );
  }

  // assertRecordUnchanged already ran above, before the idempotent early return, so the commit
  // guard applies uniformly to first-publish and already-published paths.

  const date = input.date ?? new Date();
  // Build the review from the record — the only invocation of this that writes to disk. A
  // build failure here means the validated content cannot become a review; it must surface
  // before any file is written, never after.
  const built = buildReviewFromRecord({
    record,
    collectionResult: input.collectionResult,
    seasonConfig: input.seasonConfig,
    date
  });

  const evidenceBundle = EvidenceBundleSchema.parse({
    data_class: 'production',
    evidences: input.collectionResult.evidences,
    metadata_snapshot: input.collectionResult.metadata_snapshot,
    evaluation_integrity_version: input.collectionResult.evaluation_integrity_version
  });

  const { year, month } = TimezoneUtil.getJSTYearMonth(date);
  const outDir = path.join(input.contentRoot, 'reviews', year, month, slug);
  fs.mkdirSync(outDir, { recursive: true });
  const writtenPaths: string[] = [];
  const writeFile = (name: string, data: unknown) => {
    const file = path.join(outDir, name);
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`);
    writtenPaths.push(file);
  };
  writeFile('evidence.json', evidenceBundle);
  writeFile('selection.json', input.selection);
  writeFile('review.json', built);

  // Record last: review.json presence is the de-facto public gate, so the record's
  // published state is bookkeeping that follows it. A crash between the two is recoverable by
  // re-running publish, which is idempotent.
  const published: GenerationRecord = {
    ...record,
    publication: {
      status: 'published',
      reason: null,
      publishedAt: input.publishedAt
    }
  };
  const saved = writeRecord(input.contentRoot, published);

  return { record: saved, slug, writtenPaths, alreadyPublished: false };
}
