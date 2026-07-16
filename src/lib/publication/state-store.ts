import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  AnyRunStateSchema,
  AnyPublicationStateSchema,
  RunStateSchema,
  RunStateSchemaV2,
  PublicationStateSchema,
  PublicationStateSchemaV2,
  type AnyRunState,
  type AnyPublicationState,
  type RunStateV2,
  type RunStatusV2
} from '../../schemas/selection';
import { assertSafeRunKey } from './run-keys';

/**
 * Versioned, monotonic persistence for run states and publication states.
 *
 * Lifecycle (2.0.0): reserved → generating → generated → validated → committed → published.
 * `failed` is reachable from any non-published status and records the status to resume
 * from; every other backward transition is rejected. Legacy 1.0.0 states stay readable and
 * are never bulk-migrated — their `selected` status normalizes to `reserved` semantics.
 */

export const RUN_STATUS_ORDER: Record<string, number> = {
  reserved: 0,
  generating: 1,
  generated: 2,
  validated: 3,
  committed: 4,
  published: 5
};

export const ACTIVE_RUN_STATUSES_V2: ReadonlySet<string> = new Set([
  'reserved', 'generating', 'generated', 'validated', 'committed', 'published'
]);

const ACTIVE_RUN_STATUSES_V1: ReadonlySet<string> = new Set(['selected', 'generated', 'published']);

const ACTIVE_PUBLICATION_STATUSES: ReadonlySet<string> = new Set([
  'generated', 'validated', 'committed', 'published'
]);

export function isRunStateV2(state: AnyRunState): state is RunStateV2 {
  return (state as any).schema_version === '2.0.0';
}

/** Normalizes a legacy status to 2.0.0 lifecycle semantics. */
export function normalizeRunStatus(state: AnyRunState): RunStatusV2 {
  const status = (state as any).status as string;
  if (status === 'selected') return 'reserved';
  return status as RunStatusV2;
}

/**
 * Rejects state regressions. Same-status rewrites are allowed (idempotent updates);
 * `failed` is allowed from any non-published status; resuming from `failed` may only
 * restart at or after the recorded previous status.
 */
export function assertRunStatusTransition(existing: AnyRunState, nextStatus: RunStatusV2): void {
  const currentStatus = normalizeRunStatus(existing);

  if (currentStatus === 'failed') {
    if (nextStatus === 'failed') return;
    const previous = isRunStateV2(existing) && existing.failure
      ? existing.failure.previous_status
      : 'reserved';
    const previousOrder = RUN_STATUS_ORDER[previous === 'failed' ? 'reserved' : previous] ?? 0;
    if ((RUN_STATUS_ORDER[nextStatus] ?? -1) < previousOrder) {
      throw new Error(`[State Machine] Run ${(existing as any).run_key} cannot resume at "${nextStatus}" before its failed status "${previous}"`);
    }
    return;
  }

  if (nextStatus === 'failed') {
    if (currentStatus === 'published') {
      throw new Error(`[State Machine] Run ${(existing as any).run_key} is published and cannot be marked failed`);
    }
    return;
  }

  const currentOrder = RUN_STATUS_ORDER[currentStatus];
  const nextOrder = RUN_STATUS_ORDER[nextStatus];
  if (currentOrder === undefined || nextOrder === undefined) {
    throw new Error(`[State Machine] Unknown run status transition "${currentStatus}" -> "${nextStatus}"`);
  }
  if (nextOrder < currentOrder) {
    throw new Error(`[State Machine] Run ${(existing as any).run_key} cannot regress from "${currentStatus}" to "${nextStatus}"`);
  }
}

function runStatePath(contentRoot: string, runKey: string): string {
  assertSafeRunKey(runKey);
  return path.join(contentRoot, 'runs', `${runKey}.json`);
}

export function readRunState(contentRoot: string, runKey: string): AnyRunState | null {
  const filePath = runStatePath(contentRoot, runKey);
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  return AnyRunStateSchema.parse(raw);
}

/**
 * Writes a run state after schema validation and (when a previous state exists)
 * monotonicity validation. New states are always 2.0.0; legacy files may be rewritten in
 * their own 1.0.0 shape but still may not regress.
 */
export function writeRunState(contentRoot: string, state: AnyRunState): AnyRunState {
  const runKey = (state as any).run_key as string;
  const filePath = runStatePath(contentRoot, runKey);
  const parsed = (state as any).schema_version === '2.0.0'
    ? RunStateSchemaV2.parse(state)
    : RunStateSchema.parse(state);

  if (fs.existsSync(filePath)) {
    const existing = AnyRunStateSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    assertRunStatusTransition(existing, normalizeRunStatus(parsed as AnyRunState));
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
  return parsed as AnyRunState;
}

export function readAllRunStates(contentRoot: string): AnyRunState[] {
  const runsDir = path.join(contentRoot, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const states: AnyRunState[] = [];
  for (const file of fs.readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'));
      states.push(AnyRunStateSchema.parse(raw));
    } catch {
      // Unreadable run states never widen the candidate pool; they are simply not
      // usable as exclusions. Reservation writes go through the schemas above.
    }
  }
  return states;
}

export function readPublicationState(contentRoot: string, slug: string): AnyPublicationState | null {
  const filePath = path.join(contentRoot, 'publication-state', `${slug}.json`);
  if (!fs.existsSync(filePath)) return null;
  return AnyPublicationStateSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export function writePublicationState(contentRoot: string, state: AnyPublicationState): AnyPublicationState {
  const parsed = (state as any).schema_version === '2.0.0'
    ? PublicationStateSchemaV2.parse(state)
    : PublicationStateSchema.parse(state);
  const filePath = path.join(contentRoot, 'publication-state', `${(parsed as any).slug}.json`);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
  return parsed;
}

export function readAllPublicationStates(contentRoot: string): AnyPublicationState[] {
  const stateDir = path.join(contentRoot, 'publication-state');
  if (!fs.existsSync(stateDir)) return [];
  const states: AnyPublicationState[] = [];
  for (const file of fs.readdirSync(stateDir)) {
    if (!file.endsWith('.json')) continue;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
      states.push(AnyPublicationStateSchema.parse(raw));
    } catch {
      // Same posture as run states: unparseable entries cannot serve as exclusions.
    }
  }
  return states;
}

export function normalizeCanonicalUrl(url: string): string {
  return (url || '').replace(/\/$/, '').toLowerCase();
}

export interface CandidateExclusions {
  canonicalUrls: Set<string>;
  contentIds: Set<string>;
}

/**
 * Candidate exclusion set for reservation-aware duplicate prevention: every canonical URL
 * and content id held by ANY run or publication state in an active (reserved → published)
 * status. Failed states do not reserve — their retry path reuses the stored candidate via
 * the run key, never via re-selection.
 */
export function collectActiveExclusions(contentRoot: string): CandidateExclusions {
  const canonicalUrls = new Set<string>();
  const contentIds = new Set<string>();

  for (const state of readAllRunStates(contentRoot)) {
    const status = (state as any).status as string;
    if (isRunStateV2(state)) {
      if (!ACTIVE_RUN_STATUSES_V2.has(status)) continue;
      canonicalUrls.add(normalizeCanonicalUrl(state.candidate_reservation.canonical_url));
      contentIds.add(state.candidate_reservation.content_id);
    } else {
      if (!ACTIVE_RUN_STATUSES_V1.has(status)) continue;
      const candidateUrl = (state as any).candidate?.canonical_url;
      if (candidateUrl) canonicalUrls.add(normalizeCanonicalUrl(candidateUrl));
      const selection = (state as any).selection;
      if (selection?.canonical_url) canonicalUrls.add(normalizeCanonicalUrl(selection.canonical_url));
      if (selection?.source_id) contentIds.add(selection.source_id);
    }
  }

  for (const state of readAllPublicationStates(contentRoot)) {
    if (!ACTIVE_PUBLICATION_STATUSES.has((state as any).publication_status)) continue;
    canonicalUrls.add(normalizeCanonicalUrl((state as any).source_canonical_url));
    contentIds.add((state as any).content_id);
  }

  return { canonicalUrls, contentIds };
}
