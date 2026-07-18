import * as fs from 'node:fs';
import * as path from 'node:path';
import crypto from 'node:crypto';
import {
  GenerationRecordSchema,
  GENERATION_RECORD_SCHEMA_VERSION,
  type GenerationRecord
} from '../../schemas/generation-record';
import { assertSafeRunKey } from '../publication/run-keys';

/**
 * Durable storage for generation records (see schemas/generation-record.ts).
 *
 * Writes are atomic (temp file + rename within the same directory) so a crash mid-write can
 * never leave a half-written record where a whole Gemini response used to be. Every write
 * re-validates the envelope, refuses to mutate the immutable generation fields, and refuses
 * to persist anything containing a known secret value.
 *
 * The record id is the run key: one Gemini call per run, so one record per run, and the id
 * stays human-readable for the review CLIs (`--id season-2-manual-123`).
 */

/** Env vars whose values must never reach a stored record. */
const SECRET_ENV_VARS = [
  'GEMINI_API_KEY',
  'GEMINI_FALLBACK_API_KEY',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
  'GITHUB_TOKEN'
];

/** Below this length a value is too short to be a credential and too likely to collide. */
const MIN_SECRET_LENGTH = 12;

export function recordsDir(contentRoot: string): string {
  return path.join(contentRoot, 'generations');
}

export function recordPath(contentRoot: string, recordId: string): string {
  assertSafeRunKey(recordId);
  return path.join(recordsDir(contentRoot), `${recordId}.json`);
}

/**
 * Deterministic JSON with sorted object keys, so a content hash depends on the content and
 * not on property insertion order. Arrays keep their order — order is meaning.
 */
export function canonicalStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry === undefined) continue;
      sorted[key] = canonicalize(entry);
    }
    return sorted;
  }
  return value;
}

/** sha256 of the canonical JSON form. Null content hashes as the literal `null`. */
export function contentHash(content: unknown): string {
  return crypto.createHash('sha256').update(canonicalStringify(content ?? null)).digest('hex');
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex');
}

/**
 * Fail-closed secret guard. Runs against the serialized record rather than specific fields:
 * a secret that reached any field is a leak regardless of which field it landed in.
 */
export function assertNoSecrets(serialized: string, env: NodeJS.ProcessEnv = process.env): void {
  for (const name of SECRET_ENV_VARS) {
    const value = env[name];
    if (!value || value.length < MIN_SECRET_LENGTH) continue;
    if (serialized.includes(value)) {
      throw new Error(`[Record Store] Refusing to persist a record containing the value of ${name}.`);
    }
  }
}

/**
 * Generation fields are written once and never rewritten. Enforced here, at the storage
 * layer, rather than trusting callers or git history: a diff against the stored record is
 * the only check a human editor cannot route around.
 */
function assertImmutableGenerationFields(existing: GenerationRecord, next: GenerationRecord): void {
  if (existing.generation.rawResponse !== next.generation.rawResponse) {
    throw new Error(
      `[Record Store] generation.rawResponse of ${existing.recordId} is immutable and cannot be rewritten.`
    );
  }
  if (contentHash(existing.generation.originalContent) !== contentHash(next.generation.originalContent)) {
    throw new Error(
      `[Record Store] generation.originalContent of ${existing.recordId} is immutable and cannot be rewritten.`
    );
  }
  if (existing.candidate.id !== next.candidate.id || existing.candidate.runKey !== next.candidate.runKey) {
    throw new Error(
      `[Record Store] candidate identity of ${existing.recordId} is immutable and cannot be rewritten.`
    );
  }
  if (existing.recordId !== next.recordId) {
    throw new Error('[Record Store] recordId is immutable.');
  }

  // The generation provenance — which model served the call, under which prompt, and what it
  // cost — is a record of what happened, not an editable field. A human fixing prose has no
  // business rewriting the token usage or the prompt hash, and a diff against the stored
  // record is the check they cannot route around.
  const gen = existing.generation;
  const nextGen = next.generation;
  const provenanceFields: Array<[unknown, unknown, string]> = [
    [gen.model, nextGen.model, 'generation.model'],
    [gen.modelVersion, nextGen.modelVersion, 'generation.modelVersion'],
    [gen.promptVersion, nextGen.promptVersion, 'generation.promptVersion'],
    [gen.promptHash, nextGen.promptHash, 'generation.promptHash']
  ];
  for (const [before, after, name] of provenanceFields) {
    if (before !== after) {
      throw new Error(`[Record Store] ${name} of ${existing.recordId} is immutable and cannot be rewritten.`);
    }
  }
  if (contentHash(gen.usage) !== contentHash(nextGen.usage)) {
    throw new Error(`[Record Store] generation.usage of ${existing.recordId} is immutable and cannot be rewritten.`);
  }
  // A recovered baseline is written once (null → value) and then frozen: it is the immutability
  // anchor for an unparseable original, so letting it change would defeat its whole purpose.
  if (gen.recoveredBaseline !== null && gen.recoveredBaseline !== undefined &&
      contentHash(gen.recoveredBaseline) !== contentHash(nextGen.recoveredBaseline ?? null)) {
    throw new Error(`[Record Store] generation.recoveredBaseline of ${existing.recordId} is immutable once set.`);
  }

  // Validation history is strictly append-only: every existing entry is frozen in full. The
  // top-level quality fields are a materialized view and can change every validation, but the
  // audit trail beneath them cannot lose, reorder, or alter — by any field — what already
  // happened. A re-run with an existing validationId must leave its entry byte-for-byte intact
  // (checkedAt, status, errors and warnings included); only genuinely new validations append.
  const priorHistory = existing.quality.history ?? [];
  const nextHistory = next.quality.history ?? [];
  if (nextHistory.length < priorHistory.length) {
    throw new Error(
      `[Record Store] quality.history of ${existing.recordId} is append-only; entries cannot be removed.`
    );
  }
  for (let i = 0; i < priorHistory.length; i++) {
    // Whole-entry equality: not just the validationId, but every field of a past entry is
    // frozen. This rejects an in-place refresh of checkedAt/status/errors/warnings, as well as
    // any reorder or replacement of the existing prefix.
    if (contentHash(priorHistory[i]) !== contentHash(nextHistory[i] ?? null)) {
      throw new Error(
        `[Record Store] quality.history of ${existing.recordId} is append-only; entry ${i} is frozen and cannot be modified, reordered, or replaced.`
      );
    }
  }
  // Deliberately NOT locked here: revisions[0].contentHash tracks the content as of revision
  // 0, which the deterministic repair pass legitimately rewrites. The Gemini original's
  // anchors are rawResponse and originalContent above — both immutable, and both sufficient
  // to detect any edit to the model's own judgement.
}

export function readRecord(contentRoot: string, recordId: string): GenerationRecord | null {
  const filePath = recordPath(contentRoot, recordId);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return GenerationRecordSchema.parse(raw);
}

/**
 * Validates, then writes atomically. The temp file is created in the destination directory
 * so the rename stays on one filesystem and is therefore atomic.
 */
export function writeRecord(contentRoot: string, record: GenerationRecord): GenerationRecord {
  const parsed = GenerationRecordSchema.parse(record);
  const filePath = recordPath(contentRoot, parsed.recordId);

  const existing = readRecordUnsafe(filePath);
  if (existing) {
    assertImmutableGenerationFields(existing, parsed);
  }

  const serialized = `${JSON.stringify(parsed, null, 2)}\n`;
  assertNoSecrets(serialized);

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, serialized);
    fs.renameSync(tempPath, filePath);
  } catch (error) {
    if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
    throw error;
  }
  return parsed;
}

function readRecordUnsafe(filePath: string): GenerationRecord | null {
  if (!fs.existsSync(filePath)) return null;
  return GenerationRecordSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

/**
 * Fail-closed inventory read: an unparseable record cannot be proven publishable *or*
 * excluded, so it aborts the caller rather than being skipped. Skipping would let an
 * excluded record fall through a public filter that never saw it.
 */
export function readAllRecords(contentRoot: string): GenerationRecord[] {
  const dir = recordsDir(contentRoot);
  if (!fs.existsSync(dir)) return [];
  const records: GenerationRecord[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (error: any) {
      throw new Error(`[Record Inventory] ${file} is not valid JSON: ${error.message}`);
    }
    const parsed = GenerationRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[Record Inventory] ${file} failed schema validation: ${parsed.error.message}`);
    }
    records.push(parsed.data);
  }
  return records;
}

/**
 * Builds the initial record for a response that has just arrived. Deliberately does no
 * parsing: the caller persists this first, and only then reads it back to validate. An
 * unparseable response still produces a complete, storable record.
 */
export function buildInitialRecord(input: {
  recordId: string;
  candidateId: string;
  runKey: string;
  canonicalUrl: string | null;
  candidateName: string | null;
  slug: string | null;
  receivedAt: string;
  model: string | null;
  modelVersion: string | null;
  promptVersion: string | null;
  promptHash: string | null;
  rawResponse: string;
  originalContent: unknown | null;
  usage: {
    promptTokens: number | null;
    completionTokens: number | null;
    totalTokens: number | null;
    thinkingTokens: number | null;
    cachedInputTokens: number | null;
  };
  route: GenerationRecord['generation']['route'];
}): GenerationRecord {
  return GenerationRecordSchema.parse({
    schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
    recordId: input.recordId,
    candidate: {
      id: input.candidateId,
      runKey: input.runKey,
      canonicalUrl: input.canonicalUrl,
      name: input.candidateName
    },
    slug: input.slug,
    generation: {
      status: 'succeeded',
      receivedAt: input.receivedAt,
      model: input.model,
      modelVersion: input.modelVersion,
      promptVersion: input.promptVersion,
      promptHash: input.promptHash,
      rawResponse: input.rawResponse,
      originalContent: input.originalContent ?? null,
      usage: input.usage,
      route: input.route
    },
    editorial: {
      mode: 'autonomous',
      currentRevision: 0,
      currentContent: input.originalContent ?? null,
      revisions: [
        {
          revision: 0,
          source: 'gemini',
          createdAt: input.receivedAt,
          contentHash: contentHash(input.originalContent ?? null)
        }
      ]
    },
    quality: {
      status: 'pending',
      checkedAt: null,
      validatorVersion: null,
      validatedRevision: null,
      validatedContentHash: null,
      errors: [],
      warnings: [],
      repairs: []
    },
    publication: {
      status: 'pending',
      reason: null,
      publishedAt: null
    }
  });
}

/**
 * Builds a record for a run whose Gemini response can no longer be recovered — a failure
 * that predates response-first persistence, where the raw response was retried away and
 * never durably stored. We do not re-run Gemini and we do not reconstruct content: the
 * record exists only to give that run key a terminal, fail-closed home in the new model.
 *
 * `generation.status` is `unavailable`, `rawResponse` is null, and publication is `excluded`
 * — the schema enforces that combination. Revision 0 still stands for the (lost) Gemini
 * original, represented as null content, so the editorial history is well-formed. The
 * `migration` block records why nothing was recovered and what evidence was consulted.
 */
export function buildUnavailableRecord(input: {
  recordId: string;
  candidateId: string;
  runKey: string;
  canonicalUrl: string | null;
  candidateName: string | null;
  slug: string | null;
  /** When the original run terminated, reused as revision 0's timestamp. */
  originalFailedAt: string;
  migratedAt: string;
  reason: string;
  /** Sources consulted while trying to recover the response (for audit). */
  recoveredFrom: string[];
  notes?: string;
}): GenerationRecord {
  return GenerationRecordSchema.parse({
    schemaVersion: GENERATION_RECORD_SCHEMA_VERSION,
    recordId: input.recordId,
    candidate: {
      id: input.candidateId,
      runKey: input.runKey,
      canonicalUrl: input.canonicalUrl,
      name: input.candidateName
    },
    slug: input.slug,
    generation: {
      status: 'unavailable',
      receivedAt: null,
      model: null,
      modelVersion: null,
      promptVersion: null,
      promptHash: null,
      rawResponse: null,
      originalContent: null,
      usage: {
        promptTokens: null,
        completionTokens: null,
        totalTokens: null,
        thinkingTokens: null,
        cachedInputTokens: null
      },
      route: null
    },
    editorial: {
      mode: 'autonomous',
      currentRevision: 0,
      currentContent: null,
      revisions: [
        {
          revision: 0,
          source: 'gemini',
          createdAt: input.originalFailedAt,
          contentHash: contentHash(null)
        }
      ]
    },
    // Quality was never assessed: there is no recovered content to validate. The terminal
    // signal is publication.status === 'excluded', not a fabricated quality failure — a
    // RESPONSE_UNAVAILABLE finding here would file a generation gap under the quality rubric.
    quality: {
      status: 'pending',
      checkedAt: null,
      validatorVersion: null,
      validatedRevision: null,
      validatedContentHash: null,
      errors: [],
      warnings: [],
      repairs: []
    },
    publication: {
      status: 'excluded',
      reason: 'generation_unavailable',
      publishedAt: null
    },
    migration: {
      migratedAt: input.migratedAt,
      reason: input.reason,
      recoverable: false,
      recoveredFrom: input.recoveredFrom,
      ...(input.notes ? { notes: input.notes } : {})
    }
  });
}
