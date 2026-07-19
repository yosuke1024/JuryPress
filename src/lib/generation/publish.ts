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

/**
 * Whether the published evidence-map file disagrees with what the record now says it should
 * be. Used only to decide whether an otherwise-idempotent republish still has work to do —
 * it can never make a publish fail, and it never inspects the article itself.
 */
function evidenceMapNeedsWrite(
  contentRoot: string,
  record: GenerationRecord,
  slug: string,
  currentHash: string,
  date: Date | undefined
): boolean {
  const mapping = record.evidenceMapping;
  const shouldExist = mapping?.status === 'succeeded' && !!mapping.map && mapping.articleHash === currentHash;
  const { year, month } = TimezoneUtil.getJSTYearMonth(
    date ?? (record.publication.publishedAt ? new Date(record.publication.publishedAt) : new Date())
  );
  const mapPath = path.join(contentRoot, 'reviews', year, month, slug, 'evidence-map.json');
  return shouldExist !== fs.existsSync(mapPath);
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
  //
  // The evidence map is deliberately EXCLUDED from that no-op: mapping runs after validation
  // and can be re-run at any time, so a record can be legitimately "already published" while
  // its map is newly available (or newly stale). Short-circuiting on content alone would make
  // `review remap` on a published record a silent no-op — the map would exist on the record
  // and never reach the site.
  if (record.publication.status === 'published' &&
      record.quality.validatedContentHash === currentHash &&
      currentHash === input.expectedContentHash &&
      !evidenceMapNeedsWrite(input.contentRoot, record, slug, currentHash, input.date)) {
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

  // A record that was published before and is being republished after a human correction
  // keeps its original publication date: correcting an article does not make it a new one,
  // and re-dating it would reorder the whole site around a typo fix.
  const originalPublishedAt = record.publication.publishedAt;
  const publishedAt = originalPublishedAt ?? input.publishedAt;
  const date = input.date ?? (originalPublishedAt ? new Date(originalPublishedAt) : new Date());
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

  // Evidence map (V3): published as a sibling file, never merged into review.json — the map
  // is regenerable bookkeeping and review.json stays immutable-after-publish. Written only
  // when the recorded map is bound to exactly the content being published (hash match); a
  // stale or failed map is treated as absent and the review publishes without one. Mapping
  // presence NEVER enters the publish gate above.
  const mapping = record.evidenceMapping;
  if (mapping?.status === 'succeeded' && mapping.map && mapping.articleHash === currentHash) {
    writeFile('evidence-map.json', mapping.map);
  } else {
    // A previously published map that no longer matches this content must not linger.
    const stalePath = path.join(outDir, 'evidence-map.json');
    if (fs.existsSync(stalePath)) fs.unlinkSync(stalePath);
  }

  // Record last: review.json presence is the de-facto public gate, so the record's
  // published state is bookkeeping that follows it. A crash between the two is recoverable by
  // re-running publish, which is idempotent.
  const published: GenerationRecord = {
    ...record,
    publication: {
      status: 'published',
      reason: null,
      publishedAt
    }
  };
  const saved = writeRecord(input.contentRoot, published);

  return { record: saved, slug, writtenPaths, alreadyPublished: false };
}
