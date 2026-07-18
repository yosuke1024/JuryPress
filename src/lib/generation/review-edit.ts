import type { GenerationRecord } from '../../schemas/generation-record';
import { contentHash } from './record-store';
import { recoverImmutableBaseline } from './baseline';

/**
 * Turns an excluded record into an editable human revision (§10).
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

export function prepareEdit(record: GenerationRecord, opts: { reason: string; editedAt: string }): PrepareEditResult {
  if (record.publication.status !== 'excluded') {
    throw new Error(
      `[Prepare Edit] ${record.recordId} is "${record.publication.status}", not "excluded"; only an excluded ` +
      `record can be opened for human editing.`
    );
  }

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
        publishedAt: null
      }
    },
    revision: nextRevision,
    recoveredBaseline: recovered
  };
}
