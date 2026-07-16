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

/**
 * Statuses whose candidate stays reserved for exclusion purposes. Non-terminal runs hold
 * their reservation, and so do failed runs: a failed run's candidate may only be reused by
 * resuming that exact run key, never by a fresh publish_new selection. Published runs are
 * deliberately absent — re-review of published articles is governed by the selector's
 * 90-day publication-history policy, not by permanent state exclusion.
 */
export const EXCLUDED_RUN_STATUSES_V2: ReadonlySet<string> = new Set([
  'reserved', 'generating', 'generated', 'validated', 'committed', 'failed'
]);

const EXCLUDED_RUN_STATUSES_V1: ReadonlySet<string> = new Set(['selected', 'generated', 'failed']);

const EXCLUDED_PUBLICATION_STATUSES: ReadonlySet<string> = new Set([
  'generated', 'validated', 'committed', 'failed'
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

/**
 * Fail-closed inventory read: a run state that cannot be parsed cannot serve as an
 * exclusion, so silently skipping it would let publish_new re-reserve a candidate that a
 * corrupted state still holds. Any unreadable file aborts the caller instead.
 */
export function readAllRunStates(contentRoot: string): AnyRunState[] {
  const runsDir = path.join(contentRoot, 'runs');
  if (!fs.existsSync(runsDir)) return [];
  const states: AnyRunState[] = [];
  for (const file of fs.readdirSync(runsDir)) {
    if (!file.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(runsDir, file), 'utf8'));
    } catch (error: any) {
      throw new Error(`[State Inventory] Run state ${file} is not valid JSON: ${error.message}`);
    }
    const parsed = AnyRunStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[State Inventory] Run state ${file} failed schema validation: ${parsed.error.message}`);
    }
    states.push(parsed.data);
  }
  return states;
}

function assertSafeSlug(slug: string): void {
  if (typeof slug !== 'string' || slug.length === 0 || !/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
    throw new Error(`Slug contains forbidden path characters: "${slug}"`);
  }
}

export function readPublicationState(contentRoot: string, slug: string): AnyPublicationState | null {
  assertSafeSlug(slug);
  const filePath = path.join(contentRoot, 'publication-state', `${slug}.json`);
  if (!fs.existsSync(filePath)) return null;
  return AnyPublicationStateSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
}

export const PUBLICATION_STATUS_ORDER: Record<string, number> = {
  generated: 0,
  validated: 1,
  committed: 2,
  published: 3
};

/**
 * Storage-layer twin of assertRunStatusTransition for publication states. Same-status
 * rewrites are idempotent; `failed` may re-enter the pipeline at any stage (publication
 * states carry no previous_status, and the pipeline re-enters them at validation);
 * published never regresses and can never be marked failed.
 */
export function assertPublicationStatusTransition(existing: AnyPublicationState, nextStatus: string): void {
  const currentStatus = (existing as any).publication_status as string;
  const slug = (existing as any).slug;

  if (currentStatus === nextStatus) return;
  if (currentStatus === 'failed') return;

  if (nextStatus === 'failed') {
    if (currentStatus === 'published') {
      throw new Error(`[State Machine] Publication ${slug} is published and cannot be marked failed`);
    }
    return;
  }

  const currentOrder = PUBLICATION_STATUS_ORDER[currentStatus];
  const nextOrder = PUBLICATION_STATUS_ORDER[nextStatus];
  if (currentOrder === undefined || nextOrder === undefined) {
    throw new Error(`[State Machine] Unknown publication status transition "${currentStatus}" -> "${nextStatus}"`);
  }
  if (nextOrder < currentOrder) {
    throw new Error(`[State Machine] Publication ${slug} cannot regress from "${currentStatus}" to "${nextStatus}"`);
  }
}

export function writePublicationState(contentRoot: string, state: AnyPublicationState): AnyPublicationState {
  const parsed = (state as any).schema_version === '2.0.0'
    ? PublicationStateSchemaV2.parse(state)
    : PublicationStateSchema.parse(state);
  assertSafeSlug((parsed as any).slug);
  const filePath = path.join(contentRoot, 'publication-state', `${(parsed as any).slug}.json`);

  if (fs.existsSync(filePath)) {
    const existing = AnyPublicationStateSchema.parse(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    assertPublicationStatusTransition(existing, (parsed as any).publication_status);
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(parsed, null, 2));
  return parsed;
}

/** Fail-closed inventory read; see readAllRunStates for the rationale. */
export function readAllPublicationStates(contentRoot: string): AnyPublicationState[] {
  const stateDir = path.join(contentRoot, 'publication-state');
  if (!fs.existsSync(stateDir)) return [];
  const states: AnyPublicationState[] = [];
  for (const file of fs.readdirSync(stateDir)) {
    if (!file.endsWith('.json')) continue;
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'));
    } catch (error: any) {
      throw new Error(`[State Inventory] Publication state ${file} is not valid JSON: ${error.message}`);
    }
    const parsed = AnyPublicationStateSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[State Inventory] Publication state ${file} failed schema validation: ${parsed.error.message}`);
    }
    states.push(parsed.data);
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
 * and content id held by a non-terminal (reserved → committed) OR failed run/publication
 * state. A failed run still holds its reservation — only a resume of that exact run key
 * may reuse the stored candidate, so a fresh publish_new must not re-reserve it. Published
 * states are handled by the selector's 90-day publication-history policy instead of a
 * permanent state exclusion.
 */
export function collectActiveExclusions(contentRoot: string): CandidateExclusions {
  const canonicalUrls = new Set<string>();
  const contentIds = new Set<string>();

  for (const state of readAllRunStates(contentRoot)) {
    const status = (state as any).status as string;
    if (isRunStateV2(state)) {
      if (!EXCLUDED_RUN_STATUSES_V2.has(status)) continue;
      canonicalUrls.add(normalizeCanonicalUrl(state.candidate_reservation.canonical_url));
      contentIds.add(state.candidate_reservation.content_id);
    } else {
      if (!EXCLUDED_RUN_STATUSES_V1.has(status)) continue;
      const candidateUrl = (state as any).candidate?.canonical_url;
      if (candidateUrl) canonicalUrls.add(normalizeCanonicalUrl(candidateUrl));
      const selection = (state as any).selection;
      if (selection?.canonical_url) canonicalUrls.add(normalizeCanonicalUrl(selection.canonical_url));
      if (selection?.source_id) contentIds.add(selection.source_id);
    }
  }

  for (const state of readAllPublicationStates(contentRoot)) {
    if (!EXCLUDED_PUBLICATION_STATUSES.has((state as any).publication_status)) continue;
    canonicalUrls.add(normalizeCanonicalUrl((state as any).source_canonical_url));
    contentIds.add((state as any).content_id);
  }

  return { canonicalUrls, contentIds };
}
