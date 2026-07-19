import type { GenerationRecord } from '../../schemas/generation-record';
import { contentHash } from './record-store';
import { recoverImmutableBaseline } from './baseline';

/**
 * Turns a record into an editable human revision (§10).
 *
 * Editable states: `excluded` (fix a quality failure), `ready` (revise before publishing) and
 * `published` (correct a live article). The editorial-first pipeline makes the last one
 * routine: prose can be corrected without regenerating anything, and only the evidence map
 * has to be re-run afterwards.
 *
 * Editing a PUBLISHED record does NOT take the article off the site. The live page is served
 * from the already-published review.json, which publishRecord alone writes and which
 * therefore always holds content that passed validation; an open revision lives only on the
 * record until it is validated and republished. So a correction is safe by construction —
 * readers keep seeing the last validated version rather than a gap — and the flow is
 * edit → validate → remap → publish.
 *
 * What a human may do here is rewrite prose to fix a quality failure; what they may never do
 * is author the jury's judgment. Those two are kept apart by the baseline:
 *
 *  - If the original parsed, it is the baseline and the editor starts from the repaired
 *    content. The immutability check pins every score to that original.
 *  - If the original never parsed, the judgment is recovered deterministically from the raw
 *    response (see recoverImmutableBaseline). Recovery re-parses the model's own bytes; it
 *    never fabricates. The editor starts from the recovered judgment, still score-pinned.
 *  - If no judgment can be recovered, there is nothing to pin the scores to, so a revision
 *    would let a human invent the judgment. That is refused outright — the raw response and
 *    its errors stay on the record, and the run is not regenerated.
 *
 * Pure: returns the next record for the caller to persist. The Gemini original (rawResponse,
 * originalContent) is never touched, and the append-only quality.history is carried forward.
 */

export class BaselineUnavailableError extends Error {
  readonly code = 'IMMUTABLE_JUDGMENT_BASELINE_UNAVAILABLE';
  constructor(recordId: string) {
    super(
      `[Prepare Edit] ${recordId}: the original response did not parse and no jury judgment could be ` +
      `recovered from it. A human may not author the scores, so no editable revision was created. ` +
      `The raw response and its errors remain on the record.`
    );
    this.name = 'BaselineUnavailableError';
  }
}

export interface PrepareEditResult {
  record: GenerationRecord;
  /** The revision number that was created, for the caller to report. */
  revision: number;
  /** Whether a judgment baseline had to be recovered from the raw response. */
  recoveredBaseline: boolean;
}

/** Publication states a human may open for editing. */
const EDITABLE_STATUSES = new Set(['excluded', 'ready', 'published']);

export function prepareEdit(record: GenerationRecord, opts: { reason: string; editedAt: string }): PrepareEditResult {
  if (!EDITABLE_STATUSES.has(record.publication.status)) {
    throw new Error(
      `[Prepare Edit] ${record.recordId} is "${record.publication.status}"; only an excluded, ready or ` +
      `published record can be opened for human editing.`
    );
  }
  const wasPublished = record.publication.status === 'published';

  let generation = record.generation;
  let editable: unknown;
  let recovered = false;

  if (record.generation.originalContent !== null && record.generation.originalContent !== undefined) {
    // The original parsed; start from the repaired content the editor should improve, falling
    // back to the original if no repaired content was ever stored.
    editable = structuredClone(record.editorial.currentContent ?? record.generation.originalContent);
  } else if (record.generation.recoveredBaseline !== null && record.generation.recoveredBaseline !== undefined) {
    // A baseline was recovered on an earlier prepare-edit; reuse it.
    editable = structuredClone(record.generation.recoveredBaseline);
    recovered = true;
  } else {
    const recovery = recoverImmutableBaseline(record.generation.rawResponse);
    if (!recovery) {
      throw new BaselineUnavailableError(record.recordId);
    }
    generation = {
      ...record.generation,
      recoveredBaseline: recovery.baseline,
      baselineRecovery: {
        recoveredAt: opts.editedAt,
        method: recovery.method,
        reason: 'originalContent did not parse; judgment recovered deterministically from rawResponse for editing.'
      }
    };
    editable = structuredClone(recovery.baseline);
    recovered = true;
  }

  const nextRevision = record.editorial.currentRevision + 1;

  return {
    record: {
      ...record,
      generation,
      editorial: {
        ...record.editorial,
        mode: 'human_edited',
        currentRevision: nextRevision,
        currentContent: editable,
        revisions: [
          ...record.editorial.revisions,
          {
            revision: nextRevision,
            source: 'human_edited',
            createdAt: opts.editedAt,
            contentHash: contentHash(editable),
            reason: opts.reason
          }
        ]
      },
      // Reset the materialized verdict to "not yet validated" for the new revision. The
      // append-only history is preserved, so why the record was excluded stays provable.
      quality: {
        ...record.quality,
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
        status: 'editing',
        reason: 'human_edit_in_progress',
        // The original publication date survives the edit: correcting a live article does
        // not make it a new article, and republishing must not silently re-date it.
        publishedAt: wasPublished ? record.publication.publishedAt : null
      }
    },
    revision: nextRevision,
    recoveredBaseline: recovered
  };
}
