import { z } from 'zod';
import { JudgeSlugSchema } from './jury';
import { DiaryThemeSchema, DiaryEventCategorySchema } from './diary';
import {
  DiaryCanonFactSchema,
  DiaryMemorySchema,
  DiaryRecentEventSchema
} from './diary-state';

/**
 * JuryDiary durable records: the generation record (one per duty day), the applied-patch
 * event, and the failure note.
 *
 * The generation record is the response-first anchor — the verbatim Gemini response lands
 * here before anything parses it, and never changes afterwards. Its axes deliberately mirror
 * the article pipeline's record without inheriting its quality axis: JuryDiary has no
 * editorial quality gate at all (brief §14). A diary is published when it is structurally
 * sound, and a dull or slightly self-contradictory day is a result, not a defect.
 *
 * `structural` therefore answers only: did it parse, does it fit the schema, are the patches
 * within their limits, are both languages present.
 */

export const DIARY_RECORD_SCHEMA_VERSION = 1;

const SHA256_PATTERN = /^[a-f0-9]{64}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const DiaryFindingSchema = z.object({
  code: z.string().min(1),
  path: z.string(),
  message: z.string().min(1),
  severity: z.enum(['error', 'warning'])
});

export type DiaryFinding = z.infer<typeof DiaryFindingSchema>;

const DiaryUsageSchema = z.object({
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  thinkingTokens: z.number().int().nullable(),
  totalTokens: z.number().int().nullable()
});

const DiaryRouteSchema = z.object({
  attempts: z.number().int().min(0),
  /**
   * Which credential served the call: a JuryDiary-only key or the shared free-tier key.
   * There is no paid route to record — JuryDiary never fails over to a billed key (brief §12.2).
   */
  keySource: z.enum(['dedicated', 'shared'])
}).nullable();

export const DiaryGenerationRecordSchema = z
  .object({
    schemaVersion: z.literal(DIARY_RECORD_SCHEMA_VERSION),
    recordId: z.string().min(1),
    date: z.string().regex(DATE_PATTERN),
    jurorId: JudgeSlugSchema,
    theme: DiaryThemeSchema,
    privateEventCategory: DiaryEventCategorySchema.nullable(),
    /**
     * The entry this juror was given to read today, assigned by code before the call.
     *
     * Recorded here rather than recomputed at apply time so validation cannot drift: the
     * assignment is part of what this run was, in exactly the same way the date, the juror and
     * the theme are.
     */
    readingTargetId: z.string().nullable().default(null),
    generation: z.object({
      status: z.enum(['succeeded', 'unavailable']),
      generatedAt: z.string().nullable(),
      requestedModel: z.string().nullable(),
      /** What the API reported serving. Null when unreported — never fabricated. */
      modelUsed: z.string().nullable(),
      promptVersion: z.string().nullable(),
      /** Schema version of the response contract (`DIARY_RESPONSE_SCHEMA_VERSION`). */
      responseSchemaVersion: z.string().nullable(),
      promptHash: z.string().nullable(),
      rawResponse: z.string().nullable(),
      usage: DiaryUsageSchema,
      route: DiaryRouteSchema
    }),
    structural: z.object({
      status: z.enum(['pending', 'passed', 'failed']),
      checkedAt: z.string().nullable(),
      validatorVersion: z.string().nullable(),
      errors: z.array(DiaryFindingSchema),
      warnings: z.array(DiaryFindingSchema)
    }),
    application: z.object({
      status: z.enum(['pending', 'applied', 'skipped']),
      eventId: z.string().nullable(),
      appliedAt: z.string().nullable()
    }),
    publication: z.object({
      status: z.enum(['pending', 'published', 'excluded']),
      reason: z.string().nullable(),
      publishedAt: z.string().nullable()
    })
  })
  .strict()
  .superRefine((record, ctx) => {
    const fail = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (record.generation.status === 'succeeded' && record.generation.rawResponse === null) {
      fail(['generation', 'rawResponse'], 'A succeeded generation must carry its verbatim response.');
    }
    // `unavailable` is the terminal shape for a run whose response was never obtained. It must
    // never look publishable, and it must never claim to hold a response it does not have.
    if (record.generation.status === 'unavailable') {
      if (record.generation.rawResponse !== null) {
        fail(['generation', 'rawResponse'], 'An unavailable generation cannot carry a response.');
      }
      if (record.publication.status !== 'excluded') {
        fail(['publication', 'status'], 'An unavailable generation must be excluded.');
      }
    }

    if (record.structural.status === 'failed' && record.structural.errors.length === 0) {
      fail(['structural', 'errors'], 'A failed structural check must record at least one error.');
    }
    if (record.structural.status === 'passed' && record.structural.errors.length > 0) {
      fail(['structural', 'errors'], 'A passed structural check cannot carry errors.');
    }
    if (record.structural.status !== 'pending' && record.structural.validatorVersion === null) {
      fail(['structural', 'validatorVersion'], 'A completed structural check must record its validator version.');
    }

    if (record.application.status === 'applied' && record.application.eventId === null) {
      fail(['application', 'eventId'], 'An applied record must reference the event it produced.');
    }

    // Publication is downstream of both gates: nothing reaches the site whose patches were
    // not applied, so a published diary and its persona state can never disagree (brief §15).
    if (record.publication.status === 'published') {
      if (record.structural.status !== 'passed') {
        fail(['publication', 'status'], 'Only a structurally valid diary can be published.');
      }
      if (record.application.status !== 'applied') {
        fail(['publication', 'status'], 'A published diary must have had its state patches applied.');
      }
      if (record.publication.publishedAt === null) {
        fail(['publication', 'publishedAt'], 'A published diary must record when it was published.');
      }
    }
    if (record.publication.status === 'excluded' && !record.publication.reason) {
      fail(['publication', 'reason'], 'An excluded record must record why.');
    }
  });

export type DiaryGenerationRecord = z.infer<typeof DiaryGenerationRecordSchema>;

/* -------------------------------------------------------------------------- */
/* Event — the audit record of what one day actually changed.                 */
/* -------------------------------------------------------------------------- */

const HashPairSchema = z.object({
  before: z.string().regex(SHA256_PATTERN),
  after: z.string().regex(SHA256_PATTERN)
});

/**
 * One applied day. Current state is a cache that this stream can rebuild:
 *
 *     bootstrap state + every event in date order = current state
 *
 * so the event carries the normalized patch actually applied (not what the model asked for),
 * what was pruned to respect the caps, and the before/after hash of each state file. The
 * hashes are what make double-application detectable rather than merely unlikely.
 */
export const DiaryEventSchema = z
  .object({
    schema_version: z.literal('1.0'),
    eventId: z.string().min(1),
    diaryId: z.string().min(1),
    date: z.string().regex(DATE_PATTERN),
    jurorId: JudgeSlugSchema,
    appliedAt: z.string().min(1),
    characterStatePatch: z.object({
      currentMood: z.string(),
      addedRecentConcerns: z.array(z.string()),
      addedUnresolvedThoughts: z.array(z.string()),
      resolvedUnresolvedThoughts: z.array(z.string()),
      traitAdjustments: z.array(
        z.object({ trait: z.string(), delta: z.number(), reason: z.string() })
      ),
      beliefAdjustments: z.array(
        z.object({ belief: z.string(), confidenceDelta: z.number(), reason: z.string() })
      )
    }),
    lifeStatePatch: z.object({
      addedCurrentConcerns: z.array(z.string()),
      resolvedCurrentConcerns: z.array(z.string()),
      addedOngoingActivities: z.array(z.string()),
      completedOngoingActivities: z.array(z.string()),
      addedRecentEvents: z.array(DiaryRecentEventSchema),
      addedUnresolvedThreads: z.array(z.string()),
      resolvedUnresolvedThreads: z.array(z.string())
    }),
    relationshipPatches: z.array(
      z.object({
        targetJurorId: JudgeSlugSchema,
        trustDelta: z.number(),
        respectDelta: z.number(),
        tensionDelta: z.number(),
        currentView: z.string(),
        unresolvedIncident: z.string().nullable(),
        reason: z.string()
      })
    ),
    memoryAdded: DiaryMemorySchema.nullable(),
    canonAdded: DiaryCanonFactSchema.nullable(),
    /**
     * Emotional and narrative inconsistencies, kept rather than corrected. Also where a canon
     * candidate lands when it collides with an established fact: recorded as tension, not
     * applied as a rewrite (brief §10.3, §11).
     */
    contradictionNotes: z.array(
      z.object({
        previousState: z.string(),
        currentState: z.string(),
        interpretation: z.string()
      })
    ),
    pruned: z.object({
      characterState: z.array(z.string()),
      lifeState: z.array(z.string()),
      memories: z.array(z.string())
    }),
    stateHashes: z.object({
      canon: HashPairSchema,
      character: HashPairSchema,
      life: HashPairSchema,
      relationships: HashPairSchema,
      memories: HashPairSchema
    }),
    generation: z.object({
      model: z.string().nullable(),
      promptVersion: z.string(),
      responseSchemaVersion: z.string()
    })
  })
  .strict();

export type DiaryEvent = z.infer<typeof DiaryEventSchema>;

/* -------------------------------------------------------------------------- */
/* Failure — a day that produced no response.                                 */
/* -------------------------------------------------------------------------- */

/**
 * A missing day is left missing. Nothing backfills it and the rotation does not shift, so a
 * gap in the archive is a truthful record of an outage rather than a silently rewritten past
 * (brief §5). `error_summary` carries a sanitized category only — never a credential.
 */
export const DiaryFailureSchema = z.object({
  data_class: z.literal('production'),
  run_key: z.string().min(1),
  status: z.literal('failed'),
  stage: z.enum(['rotation', 'context', 'generation', 'validation', 'application', 'persistence']),
  jurorId: z.string().nullable(),
  date: z.string().nullable(),
  attempts: z.number().int().min(0),
  error_code: z.string().min(1),
  error_summary: z.string().min(1),
  failed_at: z.string().min(1)
});

export type DiaryFailure = z.infer<typeof DiaryFailureSchema>;
