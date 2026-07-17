import type { Candidate } from '../../schemas/selection';
import type { Evidence } from '../../schemas/evidence';
import type { GenerationRecord, QualityFinding } from '../../schemas/generation-record';
import { Evaluator, type RawGenerationResult } from '../evaluation/evaluator';
import { buildInitialRecord, readRecord, writeRecord } from './record-store';
import { applyVerdict, validateContent, VALIDATOR_VERSION } from './validator';

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
  const raw = await evaluator.generateRaw(input.candidate, input.evidences);

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
      totalTokens: raw.tokenUsage.total_tokens
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
    originalContent: stored.generation.originalContent,
    evidences: input.evidences,
    humanEdited: stored.editorial.mode === 'human_edited'
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

  const updated = applyVerdict(stored, verdict, new Date().toISOString());
  return writeRecord(input.contentRoot, updated);
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
