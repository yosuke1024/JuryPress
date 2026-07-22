import { z } from 'zod';

/**
 * The generation record is the durable, response-first envelope for one Gemini generation.
 *
 * It exists so that a Gemini response is never lost to a downstream failure: the record is
 * written and pushed BEFORE any parse or quality check runs, and every later stage only
 * appends to it. A record is therefore the authoritative processing result of a run —
 * including runs whose output was rejected. Rejection is a normal outcome, not an error.
 *
 * Three success axes are tracked independently and never collapsed into one another:
 *
 *   generation  — did a Gemini response arrive and get persisted?
 *   quality     — did the persisted content pass validation?
 *   publication — was it published?
 *
 * A record with generation=succeeded / quality=failed / publication=excluded is a complete,
 * terminal, *successful* run. Only generation and persistence failures are errors.
 *
 * Immutability: `generation.rawResponse` and `generation.originalContent` are written once,
 * at generation time, and never rewritten — not by repair, not by revalidation, and not by
 * human editing. Human edits create new revisions under `editorial` instead.
 */

/** Bump when the envelope shape changes in a way stored records cannot satisfy. */
export const GENERATION_RECORD_SCHEMA_VERSION = 1;

/**
 * `succeeded` means a response arrived and its verbatim text is stored. `unavailable` is
 * reserved for migrated records whose response predates response-first persistence and is
 * unrecoverable — it can never be produced by a live run, and it never publishes.
 */
export const GenerationStatusSchema = z.enum(['succeeded', 'unavailable']);

export const QualityStatusSchema = z.enum(['pending', 'passed', 'failed']);

/**
 * Publication statuses. Only `published` is publicly visible; every other value — and any
 * value not in this enum — is withheld by the fail-closed public allow-list.
 *
 *   pending   — validation has not decided yet
 *   excluded  — withheld (quality failure, or unrecoverable generation)
 *   editing   — a human revision is in progress and has not been revalidated
 *   ready     — validation passed; awaiting the explicit publish operation
 *   published — live
 */
export const PublicationStatusSchema = z.enum(['pending', 'excluded', 'editing', 'ready', 'published']);

export const EditorialModeSchema = z.enum(['autonomous', 'human_edited']);

/**
 * Revision provenance. `gemini` is revision 0 — the model's own content, after deterministic
 * repair only (repairs preserve meaning and are reproducible from originalContent, so they
 * do not earn a revision of their own). `human_edited` is any human revision.
 */
export const RevisionSourceSchema = z.enum(['gemini', 'human_edited']);

export const SeveritySchema = z.enum(['error', 'warning']);

/**
 * A structured quality finding. `code` is a stable machine-readable identifier (callers may
 * branch on it); `path` is a JSONPath into the validated content. Messages are
 * human-readable explanations and never carry stack traces, secrets or environment values.
 */
export const QualityFindingSchema = z.object({
  code: z.string().min(1),
  path: z.string(),
  message: z.string(),
  severity: SeveritySchema,
  ruleVersion: z.string()
});

/** A repair that was applied deterministically, recorded for auditability. */
export const RepairRecordSchema = z.object({
  code: z.string().min(1),
  path: z.string(),
  message: z.string()
});

export const RevisionSchema = z.object({
  revision: z.number().int().min(0),
  source: RevisionSourceSchema,
  createdAt: z.string().datetime(),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/, 'contentHash must be a sha256 hex digest'),
  /** Free-text rationale for a human revision. Absent for revision 0. */
  reason: z.string().optional()
});

export const GenerationSchema = z.object({
  status: GenerationStatusSchema,
  receivedAt: z.string().datetime().nullable(),
  /** The model alias that was requested. */
  model: z.string().nullable(),
  /** The model version the API reported as actually serving the request. */
  modelVersion: z.string().nullable(),
  promptVersion: z.string().nullable(),
  promptHash: z.string().nullable(),
  /**
   * The response text exactly as Gemini returned it, before any normalization, repair or
   * parse. Stored as an opaque string so an unparseable or schema-violating response is
   * still fully recoverable. `null` only for `unavailable` records.
   */
  rawResponse: z.string().nullable(),
  /**
   * The parsed Gemini content before any deterministic repair, or `null` when the response
   * could not be parsed. Immutable — the baseline every immutability check compares against.
   */
  originalContent: z.unknown().nullable(),
  /**
   * A judgment baseline recovered deterministically from `rawResponse` when `originalContent`
   * is null (e.g. the model fenced its JSON in markdown, so the strict parse failed but a
   * fence-strip succeeds). Set at most once, and only from a real recovery — never authored
   * by a human. The immutability check falls back to it, so a human editing an
   * otherwise-unparseable record still cannot change the jury's scores. `null` when no
   * baseline could be recovered, in which case the record can never be edited into publication
   * (a human must not invent the judgment). See recoverImmutableBaseline().
   */
  recoveredBaseline: z.unknown().nullable().default(null),
  /** How and why a recoveredBaseline was derived. Absent unless recovery ran. */
  baselineRecovery: z.object({
    recoveredAt: z.string().datetime(),
    method: z.string(),
    reason: z.string()
  }).nullable().default(null),
  usage: z.object({
    promptTokens: z.number().int().nullable(),
    completionTokens: z.number().int().nullable(),
    totalTokens: z.number().int().nullable(),
    thinkingTokens: z.number().int().nullable().default(null),
    cachedInputTokens: z.number().int().nullable().default(null)
  }),
  /**
   * Provenance of the call itself: which route served it and how many attempts it took.
   * Recorded here because the published review reports it, and the publish step builds that
   * review from this record rather than from a live evaluator result.
   *
   * `totalAttempts` counts transport attempts only — a response is never re-requested for
   * being low quality, so this can no longer be inflated by content rejections.
   */
  route: z.object({
    requestedModel: z.string().nullable(),
    thinkingLevel: z.string().nullable(),
    successfulRoute: z.enum(['primary', 'fallback']).nullable(),
    failoverUsed: z.boolean(),
    primaryAttempts: z.number().int().min(0),
    fallbackAttempts: z.number().int().min(0),
    totalAttempts: z.number().int().min(0),
    charactersSentToModel: z.number().int().min(0).nullable()
  }).nullable()
});

export const EditorialSchema = z.object({
  mode: EditorialModeSchema,
  currentRevision: z.number().int().min(0),
  /** The content that would be published. `null` when the response never parsed. */
  currentContent: z.unknown().nullable(),
  revisions: z.array(RevisionSchema).min(1)
});

/**
 * One validation attempt, recorded for good. The append-only `quality.history` is the audit
 * trail the top-level `quality` fields cannot be: those are a materialized view of the latest
 * attempt and are overwritten every time, so on their own they cannot show that a record that
 * now passes first failed for a specific reason — which is exactly what a human editor, or a
 * validator-version bump, must be able to prove from the JSON alone.
 *
 * `validationId` is deterministic (validatorVersion + revision + contentHash), so re-running
 * the identical validation over the identical content is idempotent: it refreshes that entry
 * in place instead of appending a duplicate. A different validator version or different
 * content produces a different id and therefore a new entry.
 */
export const ValidationHistoryEntrySchema = z.object({
  validationId: z.string().min(1),
  revision: z.number().int().min(0),
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  checkedAt: z.string().datetime(),
  validatorVersion: z.string(),
  status: z.enum(['passed', 'failed']),
  errors: z.array(QualityFindingSchema),
  warnings: z.array(QualityFindingSchema)
});

export const QualitySchema = z.object({
  status: QualityStatusSchema,
  checkedAt: z.string().datetime().nullable(),
  validatorVersion: z.string().nullable(),
  /** Which revision the verdict below applies to. */
  validatedRevision: z.number().int().min(0).nullable(),
  /** The hash of the exact content that was validated; re-checked at publish time. */
  validatedContentHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(),
  errors: z.array(QualityFindingSchema),
  warnings: z.array(QualityFindingSchema),
  repairs: z.array(RepairRecordSchema).default([]),
  /** Append-only log of every validation attempt. Never rewritten or pruned. */
  history: z.array(ValidationHistoryEntrySchema).default([])
});

export const PublicationSchema = z.object({
  status: PublicationStatusSchema,
  reason: z.string().nullable(),
  publishedAt: z.string().datetime().nullable()
});

/**
 * Evidence-mapping outcome (V3 editorial-first pipeline). Optional and additive: pre-V3
 * records never carry it, and it is deliberately OUTSIDE the immutable generation fields and
 * the revalidation fingerprint — a map is regenerable bookkeeping, never judgment.
 *
 * The full map payload lives in `map` so it is durable between the mapping step and the
 * publish step (publish re-reads all state from disk; an in-memory-only map would not survive
 * the standalone publish CLI or a crash-resume). A failed attempt records the failure and a
 * null map; the record publishes without one. There are no publication-status enum values for
 * this — "published without evidence map" is DERIVED from publication.status +
 * evidenceMapping, so existing state files keep parsing.
 */
export const EvidenceMappingSchema = z.object({
  status: z.enum(['succeeded', 'failed']),
  attemptedAt: z.string().datetime(),
  /** contentHash of the editorial content the map (or attempt) was bound to. */
  articleHash: z.string().regex(/^[a-f0-9]{64}$/),
  mappingPromptVersion: z.string(),
  /** The model alias that was requested. */
  model: z.string().nullable(),
  /** The model version the API reported as actually serving the request. */
  modelVersion: z.string().nullable(),
  /** Sanitized failure category (never a stack trace); null on success. */
  failureCategory: z.string().nullable().default(null),
  usage: z.object({
    promptTokens: z.number().int().nullable(),
    completionTokens: z.number().int().nullable(),
    totalTokens: z.number().int().nullable(),
    thinkingTokens: z.number().int().nullable().default(null),
    cachedInputTokens: z.number().int().nullable().default(null)
  }).nullable().default(null),
  /** The full EvidenceMap payload (see schemas/evidence-map.ts); null when status is 'failed'. */
  map: z.unknown().nullable()
});

export type EvidenceMapping = z.infer<typeof EvidenceMappingSchema>;

/**
 * Editorial voice readings (see lib/evaluation/editorial-metrics.ts). Optional, additive, and
 * OUTSIDE the revalidation fingerprint for the same reason the evidence map is: it is derived
 * bookkeeping, never judgment.
 *
 * Nothing reads this to decide anything. It exists so a prompt change's effect on the corpus is
 * observable without re-parsing published reviews by hand, and so a regression shows up as a
 * number instead of as a reader noticing the site sounds like an advertisement. `z.unknown()`
 * keeps the shape owned by the module that produces it — the readings are versioned by
 * `instrumentVersion` inside the payload, not by this schema, so adding a metric never
 * invalidates a stored record.
 */
export const EditorialMetricsSchema = z.object({
  measuredAt: z.string().datetime(),
  /** contentHash of the content the readings were taken from. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  readings: z.unknown()
});

export type EditorialMetrics = z.infer<typeof EditorialMetricsSchema>;

/** Why a migrated record carries no raw response. Only ever set by the migration CLI. */
export const MigrationSchema = z.object({
  migratedAt: z.string().datetime(),
  reason: z.string(),
  recoverable: z.boolean(),
  /** What the migration could still find, for audit purposes. */
  recoveredFrom: z.array(z.string()).default([]),
  notes: z.string().optional()
});

export const GenerationRecordSchema = z.object({
  schemaVersion: z.literal(GENERATION_RECORD_SCHEMA_VERSION),
  recordId: z.string().min(1),
  candidate: z.object({
    id: z.string(),
    runKey: z.string().min(1),
    canonicalUrl: z.string().nullable(),
    name: z.string().nullable()
  }),
  /** The slug the review would publish under. Null until generation resolves one. */
  slug: z.string().nullable(),
  generation: GenerationSchema,
  editorial: EditorialSchema,
  quality: QualitySchema,
  publication: PublicationSchema,
  /** Present only once an evidence-mapping attempt has run (V3 pipeline). */
  evidenceMapping: EvidenceMappingSchema.optional(),
  /** Voice readings for editorial (V3) content. Observational only; never gates anything. */
  editorialMetrics: EditorialMetricsSchema.optional(),
  migration: MigrationSchema.optional()
})
  .strict()
  .superRefine((record, ctx) => {
    // A stored response is what makes a record `succeeded`; the two can never disagree.
    if (record.generation.status === 'succeeded' && record.generation.rawResponse === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['generation', 'rawResponse'],
        message: 'generation.status "succeeded" requires a stored rawResponse.'
      });
    }
    if (record.generation.status === 'unavailable') {
      if (record.generation.rawResponse !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['generation', 'rawResponse'],
          message: 'generation.status "unavailable" must not carry a rawResponse.'
        });
      }
      if (record.publication.status !== 'excluded') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['publication', 'status'],
          message: 'An unavailable generation can only be excluded.'
        });
      }
    }

    // A recovered baseline and its provenance are set together, and only when there was no
    // parsed original to begin with — recovery is a fallback for a null originalContent, never
    // a second, competing baseline alongside a real one.
    const hasBaseline = record.generation.recoveredBaseline !== null && record.generation.recoveredBaseline !== undefined;
    const hasBaselineMeta = record.generation.baselineRecovery !== null && record.generation.baselineRecovery !== undefined;
    if (hasBaseline !== hasBaselineMeta) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['generation', 'baselineRecovery'],
        message: 'generation.recoveredBaseline and generation.baselineRecovery must be set together.'
      });
    }
    if (hasBaseline && record.generation.originalContent !== null && record.generation.originalContent !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['generation', 'recoveredBaseline'],
        message: 'generation.recoveredBaseline is only for a null originalContent; a parsed original is already the baseline.'
      });
    }

    // currentRevision must name a revision that actually exists.
    const revisionNumbers = new Set(record.editorial.revisions.map(r => r.revision));
    if (!revisionNumbers.has(record.editorial.currentRevision)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['editorial', 'currentRevision'],
        message: `currentRevision ${record.editorial.currentRevision} has no matching entry in editorial.revisions.`
      });
    }
    if (revisionNumbers.size !== record.editorial.revisions.length) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['editorial', 'revisions'],
        message: 'editorial.revisions must not contain duplicate revision numbers.'
      });
    }
    // Revision 0 is always the model's own output; a human revision can never claim it.
    const revisionZero = record.editorial.revisions.find(r => r.revision === 0);
    if (revisionZero && revisionZero.source !== 'gemini') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['editorial', 'revisions', 0, 'source'],
        message: 'Revision 0 is the Gemini original and must have source "gemini".'
      });
    }
    if (record.editorial.mode === 'human_edited' && record.editorial.currentRevision === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['editorial', 'mode'],
        message: 'human_edited mode requires a revision above 0; revision 0 is the Gemini original.'
      });
    }

    // A passed verdict must name the exact revision and hash it applies to, so the publish
    // gate can prove the content it is about to publish is the content that was validated.
    if (record.quality.status === 'passed') {
      if (record.quality.validatedContentHash === null || record.quality.validatedRevision === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quality'],
          message: 'A passed quality verdict must record validatedRevision and validatedContentHash.'
        });
      }
      if (record.quality.errors.length > 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quality', 'errors'],
          message: 'A passed quality verdict must not carry errors.'
        });
      }
    }
    if (record.quality.status === 'failed' && record.quality.errors.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['quality', 'errors'],
        message: 'A failed quality verdict must record at least one error.'
      });
    }
    // Errors and warnings must not be mislabelled: severity is what the public summary and
    // the publication gate branch on.
    for (const [index, finding] of record.quality.errors.entries()) {
      if (finding.severity !== 'error') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quality', 'errors', index, 'severity'],
          message: 'Findings under quality.errors must have severity "error".'
        });
      }
    }
    for (const [index, finding] of record.quality.warnings.entries()) {
      if (finding.severity !== 'warning') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['quality', 'warnings', index, 'severity'],
          message: 'Findings under quality.warnings must have severity "warning".'
        });
      }
    }

    // Publishing is only ever reachable through a passing verdict.
    if (record.publication.status === 'published' && record.quality.status !== 'passed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publication', 'status'],
        message: 'Only content with quality.status "passed" can be published.'
      });
    }
    if (record.publication.status === 'ready' && record.quality.status !== 'passed') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publication', 'status'],
        message: 'Only content with quality.status "passed" can be marked ready.'
      });
    }
    if (record.publication.status === 'published' && record.publication.publishedAt === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publication', 'publishedAt'],
        message: 'A published record must record publishedAt.'
      });
    }
    if (record.publication.status === 'excluded' && !record.publication.reason) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['publication', 'reason'],
        message: 'An excluded record must record a reason.'
      });
    }
  });

export type GenerationRecord = z.infer<typeof GenerationRecordSchema>;
export type QualityFinding = z.infer<typeof QualityFindingSchema>;
export type RepairRecord = z.infer<typeof RepairRecordSchema>;
export type Revision = z.infer<typeof RevisionSchema>;
export type PublicationStatus = z.infer<typeof PublicationStatusSchema>;
export type QualityStatus = z.infer<typeof QualityStatusSchema>;
export type GenerationStatus = z.infer<typeof GenerationStatusSchema>;
