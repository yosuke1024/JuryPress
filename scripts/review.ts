import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveContentRoot } from '../src/lib/content-root';
import { readRecord, writeRecord, readAllRecords } from '../src/lib/generation/record-store';
import { mapEvidenceAndPersist, validateAndPersist } from '../src/lib/generation/pipeline';
import { buildReviewFromRecord } from '../src/lib/generation/build-review';
import { prepareEdit, BaselineUnavailableError } from '../src/lib/generation/review-edit';
import { readRunState } from '../src/lib/publication/state-store';
import { EvidenceCollectionResultSchema, type EvidenceCollectionResult } from '../src/schemas/evidence';
import { assertSafeRunKey } from '../src/lib/publication/run-keys';

/**
 * Operator CLI for the manual-edit lifecycle. None of these subcommands call Gemini, and none
 * of them publish — publication is a separate, explicit operation (scripts/publish-record.ts).
 *
 *   review prepare-edit --id <record-id> [--reason <text>]
 *       Opens an excluded record for human editing: creates a human revision, resets the
 *       verdict to pending, and moves publication to `editing`. Refuses if the original never
 *       parsed and no jury judgment can be recovered (a human may not author the scores).
 *
 *   review validate --id <record-id>
 *       Runs the quality validator against the current revision and records the verdict. A
 *       pass stops at `ready`; it never publishes.
 *
 *   review revalidate (--id <record-id> | --all-excluded)
 *       Re-runs the validator over stored content without touching the response — for a
 *       validator-version bump. Appends to the append-only history; a pass stops at `ready`.
 *
 *   review remap --id <record-id>
 *       Re-runs ONLY the evidence-mapping request (Gemini call #2) against the record's
 *       current editorial content. Never touches the article, the scores or the verdict, and
 *       exits 0 even when mapping fails — a review without a map is a valid published state.
 *       This is the step a human edit needs: edit → validate → remap → publish.
 */

function parseArgs(argv: string[]): { flags: Record<string, string | boolean> } {
  const flags: Record<string, string | boolean> = {};
  const allowed = new Set(['id', 'reason', 'all-excluded']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown flag: --${key}`);
    if (key === 'all-excluded') { flags[key] = true; continue; }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    flags[key] = value;
  }
  return { flags };
}

function loadEvidences(contentRoot: string, recordId: string): { collectionResult: EvidenceCollectionResult; selection: unknown } {
  const runState = readRunState(contentRoot, recordId);
  if (!runState) {
    throw new Error(`[Review] No run state exists for ${recordId}; cannot resolve the evidence bundle.`);
  }
  const collectionResult = EvidenceCollectionResultSchema.parse((runState as any).collection_result);
  return { collectionResult, selection: (runState as any).selection };
}

function seasonConfig(): unknown {
  return JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));
}

function reportVerdict(recordId: string, record: ReturnType<typeof readRecord>): void {
  if (!record) return;
  console.log(`[Review] ${recordId}: generation=${record.generation.status} quality=${record.quality.status} publication=${record.publication.status}`);
  for (const finding of record.quality.errors) {
    console.log(`  error   [${finding.code}] ${finding.path}: ${finding.message}`);
  }
  for (const finding of record.quality.warnings) {
    console.log(`  warning [${finding.code}] ${finding.path}: ${finding.message}`);
  }
}

function validateOne(contentRoot: string, recordId: string): void {
  const { collectionResult } = loadEvidences(contentRoot, recordId);
  const cfg = seasonConfig();
  validateAndPersist({
    contentRoot,
    recordId,
    evidences: collectionResult.evidences,
    // Prove the content can become a review without writing one: publication is the only
    // path that materializes review.json.
    buildPublishedContent: content => {
      buildReviewFromRecord({ record: readRecord(contentRoot, recordId)!, collectionResult, seasonConfig: cfg, date: new Date(), content });
    }
  });
  reportVerdict(recordId, readRecord(contentRoot, recordId));
}

function main(): void | Promise<void> {
  const [subcommand, ...rest] = process.argv.slice(2);
  const { flags } = parseArgs(rest);
  const contentRoot = resolveContentRoot();

  if (subcommand === 'prepare-edit') {
    const id = flags.id as string;
    if (!id) throw new Error('review prepare-edit requires --id <record-id>.');
    assertSafeRunKey(id);
    const record = readRecord(contentRoot, id);
    if (!record) throw new Error(`[Review] No record found for ${id}.`);
    try {
      const result = prepareEdit(record, {
        reason: (flags.reason as string) || 'Manual editorial revision.',
        editedAt: new Date().toISOString()
      });
      writeRecord(contentRoot, result.record);
      console.log(
        `[Review] Opened ${id} for editing: revision ${result.revision}` +
        `${result.recoveredBaseline ? ' (judgment baseline recovered from raw response)' : ''}.`
      );
      console.log(`  Edit editorial.currentContent in data/generations/${id}.json, then: npm run review:validate -- --id ${id}`);
    } catch (e) {
      if (e instanceof BaselineUnavailableError) {
        // A terminal, expected refusal — not a crash. Surface it and exit non-zero so an
        // operator script does not mistake it for success, but do not touch the record.
        console.error(e.message);
        process.exit(2);
      }
      throw e;
    }
    return;
  }

  if (subcommand === 'validate') {
    const id = flags.id as string;
    if (!id) throw new Error('review validate requires --id <record-id>.');
    assertSafeRunKey(id);
    validateOne(contentRoot, id);
    return;
  }

  if (subcommand === 'revalidate') {
    if (flags['all-excluded']) {
      const excluded = readAllRecords(contentRoot).filter(r => r.publication.status === 'excluded' && r.generation.status === 'succeeded');
      console.log(`[Review] Revalidating ${excluded.length} excluded record(s) with succeeded generation.`);
      for (const record of excluded) {
        try {
          validateOne(contentRoot, record.recordId);
        } catch (e: any) {
          console.error(`[Review] ${record.recordId}: ${e?.message ?? e}`);
        }
      }
      return;
    }
    const id = flags.id as string;
    if (!id) throw new Error('review revalidate requires --id <record-id> or --all-excluded.');
    assertSafeRunKey(id);
    validateOne(contentRoot, id);
    return;
  }

  if (subcommand === 'remap') {
    const id = flags.id as string;
    if (!id) throw new Error('review remap requires --id <record-id>.');
    assertSafeRunKey(id);
    return remapOne(contentRoot, id);
  }

  throw new Error(`Unknown subcommand: ${subcommand ?? '(none)'}. Use prepare-edit | validate | revalidate | remap.`);
}

/**
 * Re-runs the evidence mapping for one record. Mapping failure is reported and exits 0: the
 * map is regenerable, its absence is a legitimate published state, and a record-keeping
 * failure must never look like an article failure to an operator script.
 */
async function remapOne(contentRoot: string, recordId: string): Promise<void> {
  const { collectionResult } = loadEvidences(contentRoot, recordId);
  const result = await mapEvidenceAndPersist({
    contentRoot,
    recordId,
    evidences: collectionResult.evidences
  });
  if (result.status === 'succeeded') {
    console.log(`[Review] ${recordId}: evidence map regenerated.`);
  } else if (result.status === 'skipped') {
    console.log(`[Review] ${recordId}: not an editorial record with passing quality; nothing to map.`);
  } else {
    console.log(`[Review] ${recordId}: evidence mapping failed (${result.failureCategory}); the article is unaffected and may publish without a map.`);
  }
  if (result.record.publication.status === 'published') {
    console.log(`  Republish to materialize the map on the site: npm run publish:record -- --id ${recordId}`);
  }
}

void main();
