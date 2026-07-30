import * as fs from 'node:fs';
import {
  DIARY_RECORD_SCHEMA_VERSION,
  DiaryGenerationRecordSchema,
  type DiaryGenerationRecord
} from '../../schemas/diary-record';
import { contentHash } from '../generation/record-store';
import {
  diaryRecordPath,
  diaryRecordsDir,
  readJsonIfExists,
  writeJsonAtomic
} from './storage';
import * as path from 'node:path';

/**
 * Durable storage for diary generation records — the response-first anchor.
 *
 * The contract inherited from the article pipeline, unchanged: the verbatim Gemini response
 * is written here *before* anything parses it, and can never be rewritten afterwards. A run
 * whose response is already stored never calls Gemini again, so resuming a broken day is free
 * and re-running one is impossible to do by accident (brief §14).
 *
 * What is deliberately absent is a quality axis. JuryDiary judges structure and nothing else,
 * so there is no field here in which "this entry was disappointing" could be recorded, and no
 * path by which it could withhold publication.
 */

function assertImmutableFields(
  existing: DiaryGenerationRecord,
  next: DiaryGenerationRecord
): void {
  const frozen: Array<[unknown, unknown, string]> = [
    [existing.recordId, next.recordId, 'recordId'],
    [existing.date, next.date, 'date'],
    [existing.jurorId, next.jurorId, 'jurorId'],
    [existing.theme, next.theme, 'theme'],
    [existing.privateEventCategory, next.privateEventCategory, 'privateEventCategory'],
    [existing.generation.rawResponse, next.generation.rawResponse, 'generation.rawResponse'],
    [existing.generation.promptHash, next.generation.promptHash, 'generation.promptHash'],
    [existing.generation.generatedAt, next.generation.generatedAt, 'generation.generatedAt'],
    [existing.generation.requestedModel, next.generation.requestedModel, 'generation.requestedModel'],
    [existing.generation.modelUsed, next.generation.modelUsed, 'generation.modelUsed'],
    [existing.generation.promptVersion, next.generation.promptVersion, 'generation.promptVersion'],
    [
      existing.generation.responseSchemaVersion,
      next.generation.responseSchemaVersion,
      'generation.responseSchemaVersion'
    ]
  ];

  for (const [before, after, name] of frozen) {
    if (before !== after) {
      throw new Error(
        `[Diary Record] ${name} of ${existing.recordId} is immutable and cannot be rewritten.`
      );
    }
  }

  if (contentHash(existing.generation.usage) !== contentHash(next.generation.usage)) {
    throw new Error(
      `[Diary Record] generation.usage of ${existing.recordId} is immutable and cannot be rewritten.`
    );
  }
}

export function readDiaryRecord(
  contentRoot: string,
  runKey: string
): DiaryGenerationRecord | null {
  const raw = readJsonIfExists(diaryRecordPath(contentRoot, runKey));
  if (raw === null) return null;
  return DiaryGenerationRecordSchema.parse(raw);
}

export function writeDiaryRecord(
  contentRoot: string,
  record: DiaryGenerationRecord
): DiaryGenerationRecord {
  const parsed = DiaryGenerationRecordSchema.parse(record);
  const filePath = diaryRecordPath(contentRoot, parsed.recordId);

  const existingRaw = readJsonIfExists(filePath);
  if (existingRaw !== null) {
    assertImmutableFields(DiaryGenerationRecordSchema.parse(existingRaw), parsed);
  }

  writeJsonAtomic(filePath, parsed);
  return parsed;
}

/**
 * Fail-closed inventory: an unparseable record cannot be proven published or excluded, so it
 * stops the caller rather than being skipped.
 */
export function readAllDiaryRecords(contentRoot: string): DiaryGenerationRecord[] {
  const dir = diaryRecordsDir(contentRoot);
  if (!fs.existsSync(dir)) return [];
  const records: DiaryGenerationRecord[] = [];
  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    } catch (error: any) {
      throw new Error(`[Diary Record Inventory] ${file} is not valid JSON: ${error.message}`);
    }
    const parsed = DiaryGenerationRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[Diary Record Inventory] ${file} failed schema validation: ${parsed.error.message}`);
    }
    records.push(parsed.data);
  }
  return records;
}

/**
 * The record for a response that has just arrived. Does no parsing on purpose: an unparseable
 * response still produces a complete, storable record, which is the whole point of persisting
 * before validating.
 */
export function buildInitialDiaryRecord(input: {
  recordId: string;
  date: string;
  jurorId: string;
  theme: string;
  privateEventCategory: string | null;
  generatedAt: string;
  requestedModel: string;
  modelUsed: string | null;
  promptVersion: string;
  responseSchemaVersion: string;
  promptHash: string;
  rawResponse: string;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
    totalTokens: number | null;
  };
  route: { attempts: number; keySource: 'dedicated' | 'shared' };
}): DiaryGenerationRecord {
  return DiaryGenerationRecordSchema.parse({
    schemaVersion: DIARY_RECORD_SCHEMA_VERSION,
    recordId: input.recordId,
    date: input.date,
    jurorId: input.jurorId,
    theme: input.theme,
    privateEventCategory: input.privateEventCategory,
    generation: {
      status: 'succeeded',
      generatedAt: input.generatedAt,
      requestedModel: input.requestedModel,
      modelUsed: input.modelUsed,
      promptVersion: input.promptVersion,
      responseSchemaVersion: input.responseSchemaVersion,
      promptHash: input.promptHash,
      rawResponse: input.rawResponse,
      usage: input.usage,
      route: input.route
    },
    structural: {
      status: 'pending',
      checkedAt: null,
      validatorVersion: null,
      errors: [],
      warnings: []
    },
    application: { status: 'pending', eventId: null, appliedAt: null },
    publication: { status: 'pending', reason: null, publishedAt: null }
  });
}
