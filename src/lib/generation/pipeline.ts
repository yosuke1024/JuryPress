import type { Candidate } from '../../schemas/selection';
import type { Evidence } from '../../schemas/evidence';
import type { GenerationRecord, QualityFinding } from '../../schemas/generation-record';
import { Evaluator, isEditorialPromptVersion, type RawGenerationResult } from '../evaluation/evaluator';
import { mapEvidence, type EvidenceMappingResult } from '../evaluation/evidence-mapper';
import { measureEditorialVoice } from '../evaluation/editorial-metrics';
import { buildInitialRecord, contentHash, readRecord, writeRecord } from './record-store';
import { applyVerdict, validateContent, VALIDATOR_VERSION } from './validator';
import { readRecentArticleOpenings } from '../evaluation/recent-articles';
import { resolveContentRoot } from '../content-root';

/**
 * The response-first generation pipeline, in the order the ordering exists to guarantee:
 *
 *   1. generate  — one Gemini call; the verbatim response is persisted before anything reads
 *                  it. The workflow commits and pushes the record here, so the response is
 *                  durable on the remote before any code can reject it.
 *   2. validate  — re-read what was persisted, repair, judge, append the verdict. A failing
 *                  verdict is a normal terminal result (excluded), not an error.
 *   3. publish   — a separate, explicit operation. Never reached automatically from a
 *                  revalidation; see the publish gate.
 *
 * Each phase is a separate CLI invocation precisely so a commit can happen between them.
 * Doing all three in one process would put the whole response back at the mercy of a crash in
 * the code that judges it — which is how ~34 responses were lost before this existed.
 */

export interface GenerationPhaseResult {
  record: GenerationRecord;
  raw: RawGenerationResult;
}

/**
 * Phase 1. Calls Gemini once and persists the response verbatim.
 *
 * Everything between receiving the response and writing it to disk is non-throwing by
 * construction: the parse attempt is wrapped, and no validation runs. If this function
 * returns, the response is on disk; if it throws, no response was ever received.
 */
export async function generateAndPersist(input: {
  contentRoot: string;
  runKey: string;
  candidate: Candidate;
  evidences: Evidence[];
  slug: string;
  promptVersion: string;
  evaluator?: Evaluator;
}): Promise<GenerationPhaseResult> {
  const evaluator = input.evaluator ?? new Evaluator();
  // Shown to the writer so consecutive reviews do not converge on one headline shape. Read
  // best effort: if the archive cannot be listed, generation proceeds without the contrast.
  const recentArticles = readRecentArticleOpenings(resolveContentRoot());
  const raw = await evaluator.generateRaw(input.candidate, input.evidences, {
    promptVersion: input.promptVersion,
    recentArticles
  });

  const record = buildInitialRecord({
    recordId: input.runKey,
    candidateId: input.candidate.sourceId,
    runKey: input.runKey,
    canonicalUrl: input.candidate.canonicalUrl ?? null,
    candidateName: input.candidate.name ?? null,
    slug: input.slug,
    receivedAt: new Date().toISOString(),
    model: raw.requestedModel,
    modelVersion: raw.modelUsed,
    promptVersion: input.promptVersion,
    promptHash: raw.promptHash,
    rawResponse: raw.rawResponse,
    originalContent: raw.parsed,
    usage: {
      promptTokens: raw.tokenUsage.input_tokens,
      completionTokens: raw.tokenUsage.output_tokens,
      totalTokens: raw.tokenUsage.total_tokens,
      thinkingTokens: raw.tokenUsage.thinking_tokens,
      cachedInputTokens: raw.tokenUsage.cached_input_tokens
    },
    route: {
      requestedModel: raw.requestedModel,
      thinkingLevel: raw.thinkingLevel,
      successfulRoute: raw.successfulRoute,
      failoverUsed: raw.failoverUsed,
      primaryAttempts: raw.primaryAttemptCount,
      fallbackAttempts: raw.fallbackAttemptCount,
      totalAttempts: raw.attemptCount,
      charactersSentToModel: raw.characters_sent_to_model
    }
  });

  // A persistence failure here IS a workflow failure: a response that exists only in this
  // process's memory is exactly the state this design exists to prevent.
  writeRecord(input.contentRoot, record);
  return { record, raw };
}

/**
 * Phase 2. Re-reads the persisted record and judges it.
 *
 * Reading back from disk rather than reusing the in-memory object is deliberate: it proves
 * the thing that was persisted is the thing that gets validated and published, so a bug in
 * the write path surfaces here instead of at the publish gate.
 *
 * `buildPublishedContent` lets the caller prove the validated content can actually be turned
 * into a publishable review. A build failure is a content defect, not a system error, so it
 * becomes a quality error and the record is excluded — it must never turn the workflow red.
 */
export function validateAndPersist(input: {
  contentRoot: string;
  recordId: string;
  evidences: Evidence[];
  buildPublishedContent?: (content: unknown) => void;
}): GenerationRecord {
  const stored = readRecord(input.contentRoot, input.recordId);
  if (!stored) {
    throw new Error(`[Pipeline] No generation record exists for ${input.recordId}; refusing to validate nothing.`);
  }

  const verdict = validateContent({
    content: stored.editorial.currentContent,
    // A human revision is checked against the recovered baseline when the original never
    // parsed, so its scores stay pinned even for an otherwise-unparseable response.
    originalContent: stored.generation.originalContent ?? stored.generation.recoveredBaseline ?? null,
    evidences: input.evidences,
    humanEdited: stored.editorial.mode === 'human_edited',
    // The immutable prompt version is the validator's rule-set dispatch key: editorial (4.x)
    // records get the minimal gate, audit-era records keep their frozen rules.
    promptVersion: stored.generation.promptVersion
  });

  if (verdict.status === 'passed' && input.buildPublishedContent) {
    try {
      input.buildPublishedContent(verdict.content);
    } catch (e: any) {
      const finding: QualityFinding = {
        code: 'PUBLISHED_CONTENT_NOT_BUILDABLE',
        path: '$',
        message: sanitizeBuildError(String(e?.message ?? e)),
        severity: 'error',
        ruleVersion: VALIDATOR_VERSION
      };
      verdict.errors.push(finding);
      verdict.status = 'failed';
    }
  }

  const updated = attachEditorialMetrics(
    applyVerdict(stored, verdict, new Date().toISOString()),
    verdict.content
  );
  return writeRecord(input.contentRoot, updated);
}

/**
 * Attaches voice readings to an editorial record. Purely observational: it never touches the
 * verdict, never adds a finding, and swallows its own failures — a broken instrument must not
 * cost a run its content. The verdict is already decided when this is called, and it stays
 * decided whatever the numbers say.
 *
 * Idempotent by content hash. Records are committed to the content repository, so re-running
 * validation over unchanged content must not produce a diff whose only substance is a new
 * timestamp — `review:revalidate` is run to re-judge, and its diff should show what changed.
 */
function attachEditorialMetrics(record: GenerationRecord, content: unknown): GenerationRecord {
  if (!isEditorialPromptVersion(record.generation.promptVersion)) return record;
  try {
    const readings = measureEditorialVoice(content);
    if (!readings) return record;

    const hash = contentHash(content);
    const existing = record.editorialMetrics;
    if (
      existing?.contentHash === hash &&
      (existing.readings as any)?.instrumentVersion === readings.instrumentVersion
    ) {
      return record;
    }

    return {
      ...record,
      editorialMetrics: { measuredAt: new Date().toISOString(), contentHash: hash, readings }
    };
  } catch {
    // Measurement is not worth a failed run.
    return record;
  }
}

/**
 * Keeps a build failure's message publishable: first line only, length-capped, and never a
 * stack trace. Quality errors are surfaced in the Actions summary and stored in the record,
 * so they must carry an explanation and nothing else.
 */
function sanitizeBuildError(message: string): string {
  const firstLine = message.split('\n')[0].trim();
  const capped = firstLine.length > 300 ? `${firstLine.slice(0, 297)}...` : firstLine;
  return capped || 'The validated content could not be assembled into a publishable review.';
}

export interface EvidenceMappingPhaseResult {
  record: GenerationRecord;
  /** The mapping outcome; 'skipped' when the record is not an editorial (V3) record. */
  status: 'succeeded' | 'failed' | 'skipped';
  failureCategory: string | null;
}

/**
 * Phase 2.5 (editorial pipeline only). Runs the evidence-mapping request against the
 * persisted, validated editorial content and stores the outcome — including the full map
 * payload — on the record, so the later publish step (a separate CLI invocation reading only
 * from disk) can materialize evidence-map.json.
 *
 * Non-blocking BY CONSTRUCTION: a mapping-content failure is recorded and returned as a
 * normal result — the record stays 'ready'/'published' and the review publishes without a
 * map. Only a persistence failure throws, because a result that exists only in this
 * process's memory is exactly the state the response-first design exists to prevent.
 */
export async function mapEvidenceAndPersist(input: {
  contentRoot: string;
  recordId: string;
  evidences: Evidence[];
  model?: string;
}): Promise<EvidenceMappingPhaseResult> {
  const stored = readRecord(input.contentRoot, input.recordId);
  if (!stored) {
    throw new Error(`[Pipeline] No generation record exists for ${input.recordId}; refusing to map nothing.`);
  }
  if (!isEditorialPromptVersion(stored.generation.promptVersion)) {
    return { record: stored, status: 'skipped', failureCategory: null };
  }
  if (stored.quality.status !== 'passed' || stored.editorial.currentContent === null) {
    return { record: stored, status: 'skipped', failureCategory: null };
  }

  const articleHash = contentHash(stored.editorial.currentContent);
  const result: EvidenceMappingResult = await mapEvidence({
    content: stored.editorial.currentContent,
    articleHash,
    evidences: input.evidences,
    mappedAt: new Date().toISOString(),
    model: input.model
  });

  // A failed attempt must not destroy a good map. When the record already holds a successful
  // mapping bound to THIS content, a transient failure (a 503, an exhausted quota) leaves it
  // in place: overwriting it would strip the appendix off a live page, and a re-dispatch of
  // the very workflow meant to repair a map would instead delete the one already published.
  // Only a mapping bound to different content is genuinely stale and safe to replace.
  const existing = stored.evidenceMapping;
  const existingIsUsable = existing?.status === 'succeeded'
    && !!existing.map
    && existing.articleHash === articleHash;

  if (result.status === 'failed' && existingIsUsable) {
    console.warn(
      `[Pipeline] Evidence mapping failed (${result.failureCategory}) for ${input.recordId}; ` +
      `keeping the existing map, which still matches the current content.`
    );
    return { record: stored, status: 'failed', failureCategory: result.failureCategory };
  }

  const updated: GenerationRecord = {
    ...stored,
    evidenceMapping: {
      status: result.status,
      attemptedAt: new Date().toISOString(),
      articleHash,
      mappingPromptVersion: result.map?.mapping_prompt_version ?? '1.0.0',
      model: result.requestedModel,
      modelVersion: result.modelVersion,
      failureCategory: result.failureCategory,
      usage: result.usage,
      map: result.map
    }
  };

  const saved = writeRecord(input.contentRoot, updated);
  return { record: saved, status: result.status, failureCategory: result.failureCategory };
}
