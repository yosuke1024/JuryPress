import crypto from 'node:crypto';
import { ThinkingLevel } from '@google/genai';
import { zodToJsonSchema } from 'zod-to-json-schema';
import type { ZodTypeAny } from 'zod';
import { generateWithFailover } from '../evaluation/gemini-transport';

/**
 * JuryDiary's Gemini access: one request per day, one credential, no billing.
 *
 * Model and credential resolve independently of the article pipeline's, so the two can be
 * tuned or rolled back separately — changing `GEMINI_MODEL` for reviews must not silently
 * change what writes the diaries (brief §12.1).
 *
 * The no-billing contract is structural rather than procedural: this module can only reach
 * the transport's `primaryOnly` mode, which has no fallback route at all. When the free tier
 * is out for the day, the day is lost. That is the intended outcome (brief §12.2) — a gap in
 * the archive costs nothing, and an experiment that quietly starts billing is a different
 * experiment.
 */

export const DIARY_DEFAULT_MODEL = 'gemini-3.5-flash';

/**
 * Two attempts, not three. There is no second credential to escalate to, so the only failure
 * this budget can rescue is a transient one; a per-minute rate limit clears in a minute and a
 * daily quota does not clear at all.
 */
export const DIARY_DEFAULT_MAX_ATTEMPTS = 2;

export const DIARY_THINKING_LEVEL = ThinkingLevel.HIGH;

export type DiaryKeySource = 'dedicated' | 'shared';

export interface DiaryGenerationResult {
  rawResponse: string;
  parsed: unknown | null;
  promptHash: string;
  requestedModel: string;
  modelUsed: string | null;
  usage: {
    inputTokens: number | null;
    outputTokens: number | null;
    thinkingTokens: number | null;
    totalTokens: number | null;
  };
  attempts: number;
  keySource: DiaryKeySource;
}

export function resolveDiaryModel(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.JURYDIARY_GEMINI_MODEL?.trim();
  return configured && configured.length > 0 ? configured : DIARY_DEFAULT_MODEL;
}

/**
 * Prefers a JuryDiary-only key so the experiment can be given its own free-tier project and
 * its own quota, and falls back to the shared free-tier key. Never the billed key: that one
 * is only reachable through the article pipeline's failover, which this module cannot enter.
 */
export function resolveDiaryCredential(env: NodeJS.ProcessEnv = process.env): {
  apiKey: string;
  keySource: DiaryKeySource;
} {
  const dedicated = env.JURYDIARY_GEMINI_API_KEY?.trim();
  if (dedicated) return { apiKey: dedicated, keySource: 'dedicated' };

  const shared = env.GEMINI_API_KEY?.trim();
  if (shared) return { apiKey: shared, keySource: 'shared' };

  throw new Error(
    '[Diary Gemini] No free-tier credential available. Set JURYDIARY_GEMINI_API_KEY or GEMINI_API_KEY.'
  );
}

export function resolveDiaryMaxAttempts(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.JURYDIARY_GEMINI_MAX_ATTEMPTS?.trim();
  if (!raw) return DIARY_DEFAULT_MAX_ATTEMPTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return DIARY_DEFAULT_MAX_ATTEMPTS;
  return parsed;
}

/**
 * No numeric ranges and no array lengths reach the wire — those live in the validator. This
 * mirrors the editorial request, where constraining them in the schema drove the first-attempt
 * pass rate to zero.
 */
export function buildDiaryGenerationConfig(schemaDefinition: object): object {
  return Object.freeze({
    responseMimeType: 'application/json' as const,
    responseJsonSchema: schemaDefinition,
    thinkingConfig: Object.freeze({ thinkingLevel: DIARY_THINKING_LEVEL })
  });
}

/**
 * One structured call. Returns the response verbatim alongside a best-effort parse; the caller
 * persists this before interpreting any of it.
 */
export async function generateDiaryStructured(input: {
  prompt: string;
  schema: ZodTypeAny;
  env?: NodeJS.ProcessEnv;
}): Promise<DiaryGenerationResult> {
  const env = input.env ?? process.env;
  const model = resolveDiaryModel(env);
  const credential = resolveDiaryCredential(env);
  const maxAttempts = resolveDiaryMaxAttempts(env);

  const schemaDefinition = zodToJsonSchema(input.schema, { $refStrategy: 'none' });
  const generationConfig = buildDiaryGenerationConfig(schemaDefinition);

  const transport = await generateWithFailover({
    model,
    prompt: input.prompt,
    generationConfig,
    primaryOnly: { apiKey: credential.apiKey, maxAttempts }
  });

  return {
    rawResponse: transport.rawResponse,
    parsed: transport.parsed,
    promptHash: crypto.createHash('sha256').update(input.prompt).digest('hex'),
    requestedModel: model,
    // Null when the API did not report it. Never backfilled with the requested alias.
    modelUsed: transport.modelUsed,
    usage: {
      inputTokens: transport.usageMetadata.promptTokenCount,
      outputTokens: transport.usageMetadata.candidatesTokenCount,
      thinkingTokens: transport.usageMetadata.thoughtsTokenCount,
      totalTokens: transport.usageMetadata.totalTokenCount
    },
    attempts: transport.attemptCount,
    keySource: credential.keySource
  };
}
