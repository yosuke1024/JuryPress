import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveContentRoot } from '../src/lib/content-root';
import { buildUnavailableRecord, readRecord, recordPath, writeRecord } from '../src/lib/generation/record-store';
import { assertSafeRunKey } from '../src/lib/publication/run-keys';

/**
 * One-off migration for runs that failed BEFORE response-first persistence existed. Those
 * runs retried the Gemini call until a quality bar was met and never durably stored a
 * response, so no raw output survives to migrate. This script does NOT call Gemini and does
 * NOT reconstruct content — it gives such a run key a terminal, fail-closed home in the new
 * generation-record model: generation.status = unavailable, publication = excluded.
 *
 * Inputs come from whatever DID survive — the historical run-state and failure JSON of the
 * original run. Point --run-state / --failure at those files (recovered from the content
 * repo's git history) and the script lifts candidate identity, run key and timestamps from
 * them. It refuses to overwrite an existing record: a run that was later re-generated under
 * the new pipeline must keep its real response.
 *
 * Usage:
 *   tsx scripts/migrate-failed-run.ts \
 *     --run-state <path/to/runs/season-2-manual-XXXX.json> \
 *     [--failure <path/to/failures/season-2-manual-XXXX.json>] \
 *     [--migrated-at <ISO>] [--dry-run]
 */

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const allowed = new Set(['run-state', 'failure', 'migrated-at', 'dry-run']);
    if (!allowed.has(key)) throw new Error(`Unknown flag: --${key}`);
    if (key === 'dry-run') {
      out[key] = true;
      continue;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    out[key] = value;
  }
  return out;
}

function readJson(file: string): any {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const runStatePath = args['run-state'];
  if (typeof runStatePath !== 'string') {
    throw new Error('--run-state <file> is required (the surviving run-state JSON of the failed run).');
  }

  const runState = readJson(runStatePath);
  const runKey: string = runState.run_key;
  if (!runKey) throw new Error(`No run_key in ${runStatePath}.`);
  assertSafeRunKey(runKey);
  if (runState.status !== 'failed') {
    throw new Error(`Refusing to migrate run ${runKey}: its recorded status is "${runState.status}", not "failed".`);
  }

  const candidate = runState.candidate || {};
  const reservation = runState.candidate_reservation || {};
  const candidateId: string = candidate.sourceId || reservation.content_id || runKey;
  const candidateName: string | null = candidate.name || reservation.candidate_name || null;
  const canonicalUrl: string | null = candidate.canonicalUrl || reservation.canonical_url || null;

  const recoveredFrom = [path.basename(runStatePath)];
  let notes = `stage=${runState.status === 'failed' ? (runState.failure?.stage ?? 'unknown') : 'unknown'}`;

  const failurePath = args['failure'];
  if (typeof failurePath === 'string') {
    const failure = readJson(failurePath);
    recoveredFrom.push(path.basename(failurePath));
    notes = `original stage=${failure.stage ?? 'unknown'}, error_code=${failure.error_code ?? 'unknown'}, ` +
      `error_summary=${failure.error_summary ?? 'unknown'}, attempts=${failure.attempts ?? 'unknown'}. ` +
      'Raw Gemini response was not persisted by the pre-response-first pipeline; ' +
      'not present in run-state, failure record, run artifacts, or Actions logs.';
  }

  const originalFailedAt: string = runState.updated_at || runState.failed_at || new Date(0).toISOString();
  const migratedAt = typeof args['migrated-at'] === 'string'
    ? (args['migrated-at'] as string)
    : new Date().toISOString();

  const record = buildUnavailableRecord({
    recordId: runKey,
    candidateId,
    runKey,
    canonicalUrl,
    candidateName,
    slug: null,
    originalFailedAt,
    migratedAt,
    reason: 'Failed before response-first persistence; the raw Gemini response was retried away and cannot be recovered.',
    recoveredFrom,
    notes
  });

  const contentRoot = resolveContentRoot();
  const existing = readRecord(contentRoot, runKey);
  if (existing) {
    throw new Error(
      `A generation record already exists for ${runKey} (status ${existing.generation.status}). ` +
      'Refusing to overwrite — a run re-generated under the new pipeline keeps its real response.'
    );
  }

  const target = recordPath(contentRoot, runKey);
  if (args['dry-run']) {
    console.log(`[dry-run] would write ${target}:`);
    console.log(JSON.stringify(record, null, 2));
    return;
  }

  writeRecord(contentRoot, record);
  console.log(`Wrote unavailable migration record: ${target}`);
  console.log(`  candidate: ${candidateName ?? candidateId} (${canonicalUrl ?? 'no url'})`);
  console.log(`  generation.status=unavailable  publication.status=excluded`);
}

main();
