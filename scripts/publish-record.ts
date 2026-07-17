import 'dotenv/config';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { resolveContentRoot } from '../src/lib/content-root';
import { recordPath, contentHash } from '../src/lib/generation/record-store';
import { publishRecord, PublishGateError } from '../src/lib/generation/publish';
import { readRunState } from '../src/lib/publication/state-store';
import { EvidenceCollectionResultSchema } from '../src/schemas/evidence';
import { GenerationRecordSchema, type GenerationRecord } from '../src/schemas/generation-record';
import { assertSafeRunKey } from '../src/lib/publication/run-keys';

/**
 * The explicit publish operation (§12). Materializes a validated record into review.json and
 * marks it published — the same publishRecord() service the autonomous path uses.
 *
 *   publish-record --id <record-id> --expected-commit-sha <sha> --expected-content-hash <hash>
 *
 * There is no flag that skips quality: publishRecord() enforces quality.status === 'passed'
 * and the three-way content-hash equality, and this CLI adds a per-record commit check so a
 * concurrent multi-publish that touches *other* records cannot block a safe publish here.
 *
 * Per-record verification (not a blanket HEAD match): the target record must hash to
 * expected-content-hash both at expected-commit-sha and on disk now. Unrelated files or other
 * records changing in between does not matter — only that THIS record is the one that was
 * validated and has not moved.
 */

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const allowed = new Set(['id', 'expected-commit-sha', 'expected-content-hash']);
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    if (!allowed.has(key)) throw new Error(`Unknown flag: --${key}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    out[key] = value;
  }
  return out;
}

/** Repo root of the content repository, so record paths can be addressed at a commit. */
function gitRoot(dir: string): string {
  return execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
}

/** The target record's currentContent hash at a given commit, or null if absent/unreadable. */
function recordHashAtCommit(repoRoot: string, relPath: string, sha: string): string | null {
  let blob: string;
  try {
    blob = execFileSync('git', ['-C', repoRoot, 'show', `${sha}:${relPath}`], { encoding: 'utf8' });
  } catch {
    return null;
  }
  const parsed = GenerationRecordSchema.safeParse(JSON.parse(blob));
  if (!parsed.success) return null;
  return contentHash(parsed.data.editorial.currentContent);
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  const id = args.id;
  const expectedCommitSha = args['expected-commit-sha'];
  const expectedContentHash = args['expected-content-hash'];
  if (!id || !expectedCommitSha || !expectedContentHash) {
    throw new Error('publish-record requires --id, --expected-commit-sha and --expected-content-hash.');
  }
  assertSafeRunKey(id);

  const contentRoot = resolveContentRoot();
  const runState = readRunState(contentRoot, id);
  if (!runState) throw new Error(`[Publish] No run state exists for ${id}; cannot resolve the evidence bundle.`);
  const collectionResult = EvidenceCollectionResultSchema.parse((runState as any).collection_result);
  const seasonConfig = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'config', 'season.json'), 'utf8'));

  // Resolve both through realpath before diffing: `git rev-parse --show-toplevel` returns a
  // canonical path, and on macOS a content root under /var (symlinked to /private/var) would
  // otherwise diverge at the root and produce a bogus ../../ relative path.
  const repoRoot = fs.realpathSync(gitRoot(contentRoot));
  const relPath = path.relative(repoRoot, fs.realpathSync(recordPath(contentRoot, id)));

  // Per-record commit verification: the target must hash to expected-content-hash at the
  // caller's commit. This is what lets a multi-publish that changed other records proceed.
  const assertRecordUnchanged = (record: GenerationRecord) => {
    const hashAtCommit = recordHashAtCommit(repoRoot, relPath, expectedCommitSha);
    if (hashAtCommit === null) {
      throw new PublishGateError(
        `Could not read a valid record for ${id} at commit ${expectedCommitSha}.`
      );
    }
    if (hashAtCommit !== expectedContentHash) {
      throw new PublishGateError(
        `At commit ${expectedCommitSha} the record's content hash is ${hashAtCommit}, not the expected ` +
        `${expectedContentHash}; the caller's commit does not describe the content being published.`
      );
    }
    // On-disk unchanged since (publishRecord also enforces expected === current, so this is a
    // clear, early failure with a per-record message).
    const onDisk = contentHash(record.editorial.currentContent);
    if (onDisk !== expectedContentHash) {
      throw new PublishGateError(
        `The record for ${id} has changed on disk (hash ${onDisk}) since commit ${expectedCommitSha}; ` +
        `re-validate before publishing.`
      );
    }
  };

  try {
    const result = publishRecord({
      contentRoot,
      recordId: id,
      expectedContentHash,
      collectionResult,
      selection: (runState as any).selection,
      seasonConfig,
      publishedAt: new Date().toISOString(),
      assertRecordUnchanged
    });
    if (result.alreadyPublished) {
      console.log(`[Publish] ${id}: already published with matching content — no-op.`);
    } else {
      console.log(`[Publish] ${id}: published ${result.slug}.`);
      for (const p of result.writtenPaths) console.log(`  wrote ${path.relative(contentRoot, p)}`);
    }
  } catch (e) {
    if (e instanceof PublishGateError) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

main();
