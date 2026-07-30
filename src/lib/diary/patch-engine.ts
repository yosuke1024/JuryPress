import crypto from 'node:crypto';
import {
  DIARY_STATE_CAPS,
  DiaryCharacterStateSchema,
  DiaryLifeStateSchema,
  DiaryMemoriesSchema,
  DiaryPrivateCanonSchema,
  DiaryRelationshipsSchema,
  type DiaryJurorStates
} from '../../schemas/diary-state';
import type { DiaryResponse } from '../../schemas/diary';
import type { DiaryEvent } from '../../schemas/diary-record';
import { DiaryEventSchema } from '../../schemas/diary-record';
import { contentHash } from '../generation/record-store';
import { toEpochDay } from './rotation';

/**
 * Applies one day's patches to one juror's five state files, and produces the event that
 * records exactly what changed.
 *
 * A pure function over states — it reads and writes nothing. The caller persists the returned
 * states and event together, which is what makes "a published diary whose persona state was
 * never updated" unrepresentable (brief §15).
 *
 * Three rules shape everything here:
 *
 * 1. **Nudges, not rewrites.** Deltas arrive pre-validated within ±0.05 and are applied to a
 *    saturating [0, 1] scale. Saturation is a documented boundary, not silent clamping of an
 *    illegal value — anything out of range was already rejected upstream as structurally
 *    invalid (brief §10.2).
 * 2. **Bounded working memory.** Recent-state lists are FIFO with caps; what falls off is
 *    recorded in the event, so the git history keeps what the state file drops.
 * 3. **Canon is additive.** A candidate that collides with an established fact is never
 *    written over it. It becomes a contradiction note — kept as tension to be read later,
 *    not resolved (brief §10.3, §11).
 */

/** Facts a juror can only have one of. A second one is a contradiction, not an addition. */
const SINGLE_VALUED_CANON_TYPES = new Set(['home', 'companion']);

export class DiaryStateConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DiaryStateConflictError';
  }
}

export interface ApplyDiaryPatchesInput {
  states: DiaryJurorStates;
  /** A response that already passed the structural gate. */
  response: DiaryResponse;
  diaryId: string;
  date: string;
  appliedAt: string;
  model: string | null;
  promptVersion: string;
  responseSchemaVersion: string;
}

export interface ApplyDiaryPatchesResult {
  states: DiaryJurorStates;
  event: DiaryEvent;
}

function clampUnit(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Rounds to 4 decimals so repeated ±0.03 nudges do not accumulate float noise in stored state. */
function roundUnit(value: number): number {
  return Math.round(clampUnit(value) * 10_000) / 10_000;
}

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function isBlank(text: string): boolean {
  return text.trim().length === 0;
}

/**
 * Append-with-dedupe, then trim to the cap from the front. Returns what fell off so the event
 * can record it — a dropped concern is still part of the persona's history even after it
 * stops being part of the persona's present.
 */
function appendCapped(
  existing: string[],
  additions: string[],
  cap: number,
  label: string
): { list: string[]; pruned: string[] } {
  const list = [...existing];
  const seen = new Set(list.map(normalize));
  for (const addition of additions) {
    if (isBlank(addition)) continue;
    const key = normalize(addition);
    if (seen.has(key)) continue;
    seen.add(key);
    list.push(addition.trim());
  }
  const pruned: string[] = [];
  while (list.length > cap) {
    pruned.push(`${label}: ${list.shift()}`);
  }
  return { list, pruned };
}

function removeMatching(existing: string[], removals: string[]): string[] {
  if (removals.length === 0) return [...existing];
  const targets = new Set(removals.filter((item) => !isBlank(item)).map(normalize));
  return existing.filter((item) => !targets.has(normalize(item)));
}

function stableId(prefix: string, ...parts: string[]): string {
  const digest = crypto.createHash('sha256').update(parts.join('|')).digest('hex');
  return `${prefix}-${digest.slice(0, 12)}`;
}

/** True when this exact day has already been applied to these states. */
export function isAlreadyApplied(states: DiaryJurorStates, diaryId: string): boolean {
  return Object.values(states).every((doc) => doc.lastEventId === diaryId);
}

/**
 * Fails closed on any state set that is not cleanly ready for this day: a partially applied
 * set (the five files disagree about where they are), a replay of an older day, or a day
 * already applied. Detecting these is the entire point of carrying `lastEventId` on every file.
 */
export function assertApplicable(states: DiaryJurorStates, diaryId: string, date: string): void {
  const markers = Object.entries(states).map(([name, doc]) => [name, doc.lastEventId] as const);
  const distinct = new Set(markers.map(([, marker]) => marker));

  if (distinct.size !== 1) {
    throw new DiaryStateConflictError(
      `[Diary Patch] State files disagree about the last applied event (${markers
        .map(([name, marker]) => `${name}=${marker}`)
        .join(', ')}). Refusing to apply ${diaryId} onto a partially updated persona.`
    );
  }

  const marker = markers[0][1];
  if (marker === diaryId) {
    throw new DiaryStateConflictError(
      `[Diary Patch] ${diaryId} has already been applied to this persona.`
    );
  }

  const markerDate = /^diary-(\d{4}-\d{2}-\d{2})-/.exec(marker)?.[1];
  if (markerDate && toEpochDay(markerDate) >= toEpochDay(date)) {
    throw new DiaryStateConflictError(
      `[Diary Patch] Refusing to apply ${diaryId} after a newer event (${marker}). Persona state only moves forward.`
    );
  }
}

export function applyDiaryPatches(input: ApplyDiaryPatchesInput): ApplyDiaryPatchesResult {
  const { states, response, diaryId, date, appliedAt } = input;
  assertApplicable(states, diaryId, date);

  const before = {
    canon: contentHash(states.canon.state),
    character: contentHash(states.character.state),
    life: contentHash(states.life.state),
    relationships: contentHash(states.relationships.state),
    memories: contentHash(states.memories.state)
  };

  const prunedCharacter: string[] = [];
  const prunedLife: string[] = [];
  const prunedMemories: string[] = [];
  const contradictionNotes = [...response.contradictionNotes];

  /* ---------------------------------------------------------------- character state -- */

  const characterPatch = response.characterStatePatch;
  const characterBefore = states.character.state;

  const concerns = appendCapped(
    characterBefore.recentConcerns,
    characterPatch.addRecentConcerns,
    DIARY_STATE_CAPS.recentConcerns,
    'recentConcerns'
  );
  prunedCharacter.push(...concerns.pruned);

  const thoughts = appendCapped(
    removeMatching(characterBefore.unresolvedThoughts, characterPatch.resolveUnresolvedThoughts),
    characterPatch.addUnresolvedThoughts,
    DIARY_STATE_CAPS.unresolvedThoughts,
    'unresolvedThoughts'
  );
  prunedCharacter.push(...thoughts.pruned);

  const traits = characterBefore.emergingTraits.map((trait) => ({ ...trait }));
  for (const adjustment of characterPatch.traitAdjustments) {
    if (isBlank(adjustment.trait)) continue;
    const key = normalize(adjustment.trait);
    const existing = traits.find((trait) => normalize(trait.trait) === key);
    if (existing) {
      existing.strength = roundUnit(existing.strength + adjustment.delta);
      existing.evidenceCount += 1;
      continue;
    }
    // A trait the persona has never shown cannot be weakened. It starts accumulating only
    // when the evidence points towards it.
    if (adjustment.delta > 0) {
      traits.push({
        trait: adjustment.trait.trim(),
        strength: roundUnit(adjustment.delta),
        evidenceCount: 1
      });
    }
  }
  while (traits.length > DIARY_STATE_CAPS.emergingTraits) {
    // Drop the faintest trait: the one with the least evidence behind it.
    let weakestIndex = 0;
    for (let i = 1; i < traits.length; i++) {
      if (traits[i].strength < traits[weakestIndex].strength) weakestIndex = i;
    }
    prunedCharacter.push(`emergingTraits: ${traits[weakestIndex].trait}`);
    traits.splice(weakestIndex, 1);
  }

  const beliefs = characterBefore.beliefsUnderPressure.map((belief) => ({ ...belief }));
  for (const adjustment of characterPatch.beliefAdjustments) {
    if (isBlank(adjustment.belief)) continue;
    const key = normalize(adjustment.belief);
    const existing = beliefs.find((belief) => normalize(belief.belief) === key);
    if (existing) {
      existing.confidence = roundUnit(existing.confidence + adjustment.confidenceDelta);
      existing.reason = adjustment.reason;
      continue;
    }
    // A belief newly under pressure starts from "held, but now questioned".
    beliefs.push({
      belief: adjustment.belief.trim(),
      confidence: roundUnit(0.5 + adjustment.confidenceDelta),
      reason: adjustment.reason
    });
  }
  while (beliefs.length > DIARY_STATE_CAPS.beliefsUnderPressure) {
    prunedCharacter.push(`beliefsUnderPressure: ${beliefs[0].belief}`);
    beliefs.shift();
  }

  const nextCharacter = DiaryCharacterStateSchema.parse({
    ...states.character,
    updatedAt: appliedAt,
    lastEventId: diaryId,
    state: {
      currentMood: isBlank(characterPatch.currentMood)
        ? characterBefore.currentMood
        : characterPatch.currentMood.trim(),
      recentConcerns: concerns.list,
      emergingTraits: traits,
      beliefsUnderPressure: beliefs,
      unresolvedThoughts: thoughts.list
    }
  });

  /* --------------------------------------------------------------------- life state -- */

  const lifePatch = response.lifeStatePatch;
  const lifeBefore = states.life.state;

  const currentConcerns = appendCapped(
    removeMatching(lifeBefore.currentConcerns, lifePatch.resolveCurrentConcerns),
    lifePatch.addCurrentConcerns,
    DIARY_STATE_CAPS.currentConcerns,
    'currentConcerns'
  );
  prunedLife.push(...currentConcerns.pruned);

  const activities = appendCapped(
    removeMatching(lifeBefore.ongoingActivities, lifePatch.completeOngoingActivities),
    lifePatch.addOngoingActivities,
    DIARY_STATE_CAPS.ongoingActivities,
    'ongoingActivities'
  );
  prunedLife.push(...activities.pruned);

  const threads = appendCapped(
    removeMatching(lifeBefore.unresolvedThreads, lifePatch.resolveUnresolvedThreads),
    lifePatch.addUnresolvedThreads,
    DIARY_STATE_CAPS.unresolvedThreads,
    'unresolvedThreads'
  );
  prunedLife.push(...threads.pruned);

  const addedRecentEvents = lifePatch.addRecentEvents
    .filter((event) => !isBlank(event))
    .map((event) => ({ date, event: event.trim() }));
  const recentEvents = [...lifeBefore.recentEvents, ...addedRecentEvents];
  while (recentEvents.length > DIARY_STATE_CAPS.recentEvents) {
    const dropped = recentEvents.shift();
    if (dropped) prunedLife.push(`recentEvents: ${dropped.date} ${dropped.event}`);
  }

  const nextLife = DiaryLifeStateSchema.parse({
    ...states.life,
    updatedAt: appliedAt,
    lastEventId: diaryId,
    state: {
      currentConcerns: currentConcerns.list,
      ongoingActivities: activities.list,
      recentEvents,
      unresolvedThreads: threads.list
    }
  });

  /* ------------------------------------------------------------------ relationships -- */

  const relationships = { ...states.relationships.state };
  for (const patch of response.relationshipPatches) {
    const current = relationships[patch.targetJurorId as keyof typeof relationships];
    if (!current) {
      throw new DiaryStateConflictError(
        `[Diary Patch] No relationship entry for ${patch.targetJurorId} on ${states.relationships.jurorId}.`
      );
    }
    relationships[patch.targetJurorId as keyof typeof relationships] = {
      trust: roundUnit(current.trust + patch.trustDelta),
      respect: roundUnit(current.respect + patch.respectDelta),
      tension: roundUnit(current.tension + patch.tensionDelta),
      currentView: isBlank(patch.currentView) ? current.currentView : patch.currentView.trim(),
      // An explicit null clears the incident: that is how a grudge gets resolved.
      unresolvedIncident: patch.unresolvedIncident,
      lastInteractionOn: date
    };
  }

  const nextRelationships = DiaryRelationshipsSchema.parse({
    ...states.relationships,
    updatedAt: appliedAt,
    lastEventId: diaryId,
    state: relationships
  });

  /* ------------------------------------------------------------------------ memories -- */

  const memories = states.memories.state.memories.map((memory) => ({ ...memory }));
  let memoryAdded: DiaryEvent['memoryAdded'] = null;
  const candidate = response.memoryCandidate;
  if (candidate && !isBlank(candidate.summary)) {
    const key = normalize(candidate.summary);
    const duplicate = memories.some((memory) => normalize(memory.summary) === key);
    if (!duplicate) {
      memoryAdded = {
        id: stableId('mem', diaryId, candidate.summary),
        summary: candidate.summary.trim(),
        importance: roundUnit(candidate.importance),
        tags: candidate.tags.filter((tag) => !isBlank(tag)).map((tag) => tag.trim()),
        createdOn: date,
        sourceDiaryId: diaryId
      };
      memories.push(memoryAdded);
    }
  }
  while (memories.length > DIARY_STATE_CAPS.memories) {
    // Forget the least important thing first; among equals, the oldest.
    let weakestIndex = 0;
    for (let i = 1; i < memories.length; i++) {
      const weakest = memories[weakestIndex];
      if (
        memories[i].importance < weakest.importance ||
        (memories[i].importance === weakest.importance && memories[i].createdOn < weakest.createdOn)
      ) {
        weakestIndex = i;
      }
    }
    prunedMemories.push(`memories: ${memories[weakestIndex].summary}`);
    memories.splice(weakestIndex, 1);
  }

  const nextMemories = DiaryMemoriesSchema.parse({
    ...states.memories,
    updatedAt: appliedAt,
    lastEventId: diaryId,
    state: { memories }
  });

  /* --------------------------------------------------------------------------- canon -- */

  const facts = states.canon.state.facts.map((fact) => ({ ...fact }));
  let canonAdded: DiaryEvent['canonAdded'] = null;
  const canonCandidate = response.canonCandidate;
  if (canonCandidate && !isBlank(canonCandidate.fact)) {
    const factKey = normalize(canonCandidate.fact);
    const duplicate = facts.find((fact) => normalize(fact.fact) === factKey);
    const conflicting = SINGLE_VALUED_CANON_TYPES.has(canonCandidate.factType)
      ? facts.find((fact) => fact.factType === canonCandidate.factType && normalize(fact.fact) !== factKey)
      : undefined;

    if (conflicting) {
      // Kept as tension rather than resolved: a juror who suddenly lives somewhere else is
      // interesting, and overwriting the canon would erase the evidence that it happened.
      contradictionNotes.push({
        previousState: conflicting.fact,
        currentState: canonCandidate.fact.trim(),
        interpretation: `Canon candidate rejected: ${canonCandidate.factType} is already established. Recorded as a contradiction rather than applied.`
      });
    } else if (!duplicate) {
      canonAdded = {
        id: stableId('fact', diaryId, canonCandidate.fact),
        factType: canonCandidate.factType as (typeof facts)[number]['factType'],
        fact: canonCandidate.fact.trim(),
        addedOn: date,
        source: 'diary',
        diaryId
      };
      facts.push(canonAdded);
    }
  }

  const nextCanon = DiaryPrivateCanonSchema.parse({
    ...states.canon,
    updatedAt: appliedAt,
    lastEventId: diaryId,
    state: { facts }
  });

  /* --------------------------------------------------------------------------- event -- */

  const nextStates: DiaryJurorStates = {
    canon: nextCanon,
    character: nextCharacter,
    life: nextLife,
    relationships: nextRelationships,
    memories: nextMemories
  };

  const event = DiaryEventSchema.parse({
    schema_version: '1.0',
    eventId: diaryId,
    diaryId,
    date,
    jurorId: states.character.jurorId,
    appliedAt,
    characterStatePatch: {
      currentMood: nextCharacter.state.currentMood,
      addedRecentConcerns: characterPatch.addRecentConcerns,
      addedUnresolvedThoughts: characterPatch.addUnresolvedThoughts,
      resolvedUnresolvedThoughts: characterPatch.resolveUnresolvedThoughts,
      traitAdjustments: characterPatch.traitAdjustments,
      beliefAdjustments: characterPatch.beliefAdjustments
    },
    lifeStatePatch: {
      addedCurrentConcerns: lifePatch.addCurrentConcerns,
      resolvedCurrentConcerns: lifePatch.resolveCurrentConcerns,
      addedOngoingActivities: lifePatch.addOngoingActivities,
      completedOngoingActivities: lifePatch.completeOngoingActivities,
      addedRecentEvents,
      addedUnresolvedThreads: lifePatch.addUnresolvedThreads,
      resolvedUnresolvedThreads: lifePatch.resolveUnresolvedThreads
    },
    relationshipPatches: response.relationshipPatches,
    memoryAdded,
    canonAdded,
    contradictionNotes,
    pruned: {
      characterState: prunedCharacter,
      lifeState: prunedLife,
      memories: prunedMemories
    },
    stateHashes: {
      canon: { before: before.canon, after: contentHash(nextCanon.state) },
      character: { before: before.character, after: contentHash(nextCharacter.state) },
      life: { before: before.life, after: contentHash(nextLife.state) },
      relationships: { before: before.relationships, after: contentHash(nextRelationships.state) },
      memories: { before: before.memories, after: contentHash(nextMemories.state) }
    },
    generation: {
      model: input.model,
      promptVersion: input.promptVersion,
      responseSchemaVersion: input.responseSchemaVersion
    }
  });

  return { states: nextStates, event };
}
