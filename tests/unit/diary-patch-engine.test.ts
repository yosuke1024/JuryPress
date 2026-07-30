import { describe, it, expect } from 'vitest';
import {
  applyDiaryPatches,
  assertApplicable,
  isAlreadyApplied,
  DiaryStateConflictError
} from '../../src/lib/diary/patch-engine';
import { DIARY_STATE_CAPS } from '../../src/schemas/diary-state';
import { DIARY_RESPONSE_SCHEMA_VERSION } from '../../src/schemas/diary';
import { contentHash } from '../../src/lib/generation/record-store';
import { createDiaryResponse, createJurorStates } from '../helpers/diary-fixtures';

const DIARY_ID = 'diary-2026-08-02-david';
const DATE = '2026-08-02';
const APPLIED_AT = '2026-08-02T18:30:00+09:00';

function apply(
  responseOverrides = {},
  statesOverride = createJurorStates('david')
) {
  return applyDiaryPatches({
    states: statesOverride,
    response: createDiaryResponse(responseOverrides),
    diaryId: DIARY_ID,
    date: DATE,
    appliedAt: APPLIED_AT,
    model: 'gemini-3.5-flash',
    promptVersion: 'diary-v1',
    responseSchemaVersion: DIARY_RESPONSE_SCHEMA_VERSION
  });
}

describe('diary patch engine', () => {
  it('applies a day and stamps every state file with the event id', () => {
    const { states, event } = apply();

    expect(event.eventId).toBe(DIARY_ID);
    for (const doc of Object.values(states)) {
      expect(doc.lastEventId).toBe(DIARY_ID);
      expect(doc.updatedAt).toBe(APPLIED_AT);
    }
  });

  it('adds concerns, records the mood and dates new life events', () => {
    const { states } = apply();

    expect(states.character.state.currentMood).toBe('unsettled but steady');
    expect(states.character.state.recentConcerns).toContain('teams confusing velocity with progress');
    expect(states.life.state.recentEvents.at(-1)).toEqual({
      date: DATE,
      event: 'found the cold solder joint by accident'
    });
  });

  it('nudges an existing trait and counts the evidence behind it', () => {
    const { states } = apply();
    const trait = states.character.state.emergingTraits.find(
      (candidate) => candidate.trait === 'patience with small teams'
    );
    expect(trait?.strength).toBeCloseTo(0.23, 5);
    expect(trait?.evidenceCount).toBe(2);
  });

  it('creates a trait only when the evidence points towards it', () => {
    const grown = apply({
      characterStatePatch: {
        ...createDiaryResponse().characterStatePatch,
        traitAdjustments: [{ trait: 'tolerance for ambiguity', delta: 0.04, reason: 'fixture' }]
      }
    });
    expect(
      grown.states.character.state.emergingTraits.some((t) => t.trait === 'tolerance for ambiguity')
    ).toBe(true);

    const weakened = apply({
      characterStatePatch: {
        ...createDiaryResponse().characterStatePatch,
        traitAdjustments: [{ trait: 'never-shown trait', delta: -0.04, reason: 'fixture' }]
      }
    });
    expect(
      weakened.states.character.state.emergingTraits.some((t) => t.trait === 'never-shown trait')
    ).toBe(false);
  });

  it('saturates persona values at the ends of the scale', () => {
    const states = createJurorStates('david');
    states.relationships.state.alex!.trust = 0.99;
    states.relationships.state.alex!.tension = 0.01;

    const { states: next } = apply(
      {
        relationshipPatches: [
          {
            targetJurorId: 'alex',
            trustDelta: 0.05,
            respectDelta: 0,
            tensionDelta: -0.05,
            currentView: 'Optimistic, but he was right this time.',
            unresolvedIncident: null,
            reason: 'fixture'
          }
        ]
      },
      states
    );

    expect(next.relationships.state.alex!.trust).toBe(1);
    expect(next.relationships.state.alex!.tension).toBe(0);
  });

  it('records the interaction date and clears a resolved incident', () => {
    const states = createJurorStates('david');
    states.relationships.state.sarah!.unresolvedIncident = 'Dismissed my concern during a review.';

    const { states: next } = apply(
      {
        relationshipPatches: [
          {
            targetJurorId: 'sarah',
            trustDelta: 0.02,
            respectDelta: 0.04,
            tensionDelta: -0.01,
            currentView: 'Her prioritisation argument was stronger than I admitted.',
            unresolvedIncident: null,
            reason: 'fixture'
          }
        ]
      },
      states
    );

    expect(next.relationships.state.sarah!.unresolvedIncident).toBeNull();
    expect(next.relationships.state.sarah!.lastInteractionOn).toBe(DATE);
    expect(next.relationships.state.sarah!.respect).toBeCloseTo(0.54, 5);
  });

  it('never writes a relationship entry for the juror themselves', () => {
    const { states } = apply();
    expect(Object.keys(states.relationships.state).sort()).toEqual([
      'alex',
      'lisa',
      'marcus',
      'sarah'
    ]);
  });

  /* ---------------------------------------------------------------- idempotence -- */

  it('refuses to apply the same day twice', () => {
    const { states } = apply();
    expect(isAlreadyApplied(states, DIARY_ID)).toBe(true);
    expect(() => assertApplicable(states, DIARY_ID, DATE)).toThrow(DiaryStateConflictError);
    expect(() => assertApplicable(states, DIARY_ID, DATE)).toThrow(/already been applied/);
  });

  it('refuses to replay an older day over newer state', () => {
    const { states } = apply();
    expect(() =>
      assertApplicable(states, 'diary-2026-08-01-alex', '2026-08-01')
    ).toThrow(/only moves forward/);
  });

  it('refuses to apply onto a partially updated persona', () => {
    const states = createJurorStates('david');
    states.life.lastEventId = 'diary-2026-08-01-alex';
    expect(() => assertApplicable(states, DIARY_ID, DATE)).toThrow(/disagree about the last applied event/);
  });

  it('leaves the input states untouched', () => {
    const states = createJurorStates('david');
    const before = contentHash(states.character.state);
    apply({}, states);
    expect(contentHash(states.character.state)).toBe(before);
  });

  /* ------------------------------------------------------------------- hashes -- */

  it('records a before hash that matches the state it was applied to', () => {
    const states = createJurorStates('david');
    const beforeHashes = {
      canon: contentHash(states.canon.state),
      character: contentHash(states.character.state),
      life: contentHash(states.life.state),
      relationships: contentHash(states.relationships.state),
      memories: contentHash(states.memories.state)
    };

    const { states: next, event } = apply({}, states);

    expect(event.stateHashes.character.before).toBe(beforeHashes.character);
    expect(event.stateHashes.character.after).toBe(contentHash(next.character.state));
    expect(event.stateHashes.canon.before).toBe(beforeHashes.canon);
    expect(event.stateHashes.life.after).toBe(contentHash(next.life.state));
  });

  /* -------------------------------------------------------------------- caps -- */

  it('prunes recent state past its cap and records what fell off', () => {
    const states = createJurorStates('david');
    states.character.state.recentConcerns = Array.from(
      { length: DIARY_STATE_CAPS.recentConcerns },
      (_, i) => `existing concern ${i}`
    );

    const { states: next, event } = apply({}, states);

    expect(next.character.state.recentConcerns).toHaveLength(DIARY_STATE_CAPS.recentConcerns);
    expect(next.character.state.recentConcerns).toContain('teams confusing velocity with progress');
    expect(next.character.state.recentConcerns).not.toContain('existing concern 0');
    expect(event.pruned.characterState).toContain('recentConcerns: existing concern 0');
  });

  it('caps recent events and keeps the newest', () => {
    const states = createJurorStates('david');
    states.life.state.recentEvents = Array.from(
      { length: DIARY_STATE_CAPS.recentEvents },
      (_, i) => ({ date: '2026-07-20', event: `old event ${i}` })
    );

    const { states: next, event } = apply({}, states);

    expect(next.life.state.recentEvents).toHaveLength(DIARY_STATE_CAPS.recentEvents);
    expect(next.life.state.recentEvents.at(-1)?.event).toBe('found the cold solder joint by accident');
    expect(event.pruned.lifeState.some((entry) => entry.includes('old event 0'))).toBe(true);
  });

  it('forgets the least important memory when the archive is full', () => {
    const states = createJurorStates('david');
    states.memories.state.memories = Array.from({ length: DIARY_STATE_CAPS.memories }, (_, i) => ({
      id: `mem-existing-${i}`,
      summary: `existing memory ${i}`,
      importance: i === 0 ? 0.01 : 0.9,
      tags: [],
      createdOn: '2026-07-20',
      sourceDiaryId: 'bootstrap'
    }));

    const { states: next, event } = apply(
      { memoryCandidate: { summary: 'A new and important realisation.', importance: 0.8, tags: ['belief-change'] } },
      states
    );

    expect(next.memories.state.memories).toHaveLength(DIARY_STATE_CAPS.memories);
    expect(next.memories.state.memories.some((m) => m.summary === 'existing memory 0')).toBe(false);
    expect(next.memories.state.memories.some((m) => m.summary === 'A new and important realisation.')).toBe(true);
    expect(event.pruned.memories.some((entry) => entry.includes('existing memory 0'))).toBe(true);
  });

  it('does not add a memory it already holds', () => {
    const states = createJurorStates('david');
    const existing = states.memories.state.memories[0].summary;

    const { states: next, event } = apply(
      { memoryCandidate: { summary: existing, importance: 0.9, tags: [] } },
      states
    );

    expect(next.memories.state.memories).toHaveLength(1);
    expect(event.memoryAdded).toBeNull();
  });

  /* -------------------------------------------------------------------- canon -- */

  it('adds a new canon fact and attributes it to the diary that produced it', () => {
    const { states, event } = apply({
      canonCandidate: {
        factType: 'past_event',
        fact: 'Learned to repair radios from his grandfather.',
        reason: 'It explains the existing radio-repair hobby.'
      }
    });

    expect(event.canonAdded?.fact).toBe('Learned to repair radios from his grandfather.');
    expect(event.canonAdded?.source).toBe('diary');
    expect(event.canonAdded?.diaryId).toBe(DIARY_ID);
    expect(states.canon.state.facts).toHaveLength(3);
  });

  /**
   * The brief's rule: a collision with established canon is preserved as tension, never
   * applied as a rewrite. A juror does not quietly move house.
   */
  it('records a colliding canon candidate as a contradiction instead of overwriting canon', () => {
    const { states, event } = apply({
      canonCandidate: {
        factType: 'home',
        fact: 'Lives in a top-floor apartment across the city.',
        reason: 'fixture collision'
      }
    });

    expect(event.canonAdded).toBeNull();
    expect(states.canon.state.facts).toHaveLength(2);
    expect(event.contradictionNotes.some((note) => note.interpretation.includes('Canon candidate rejected'))).toBe(true);
  });

  it('allows several facts of a repeatable kind', () => {
    const { states, event } = apply({
      canonCandidate: { factType: 'hobby', fact: 'Bakes bread badly.', reason: 'fixture' }
    });
    expect(event.canonAdded).not.toBeNull();
    expect(states.canon.state.facts.filter((fact) => fact.factType === 'hobby')).toHaveLength(2);
  });

  it('does not duplicate a canon fact it already holds', () => {
    const states = createJurorStates('david');
    const { states: next, event } = apply(
      {
        canonCandidate: {
          factType: 'hobby',
          fact: 'Repairs old radios.',
          reason: 'fixture duplicate'
        }
      },
      states
    );
    expect(event.canonAdded).toBeNull();
    expect(next.canon.state.facts).toHaveLength(2);
  });

  it('carries the model contradiction notes through to the event', () => {
    const { event } = apply({
      contradictionNotes: [
        {
          previousState: 'I prefer living alone.',
          currentState: 'The flat felt unusually empty tonight.',
          interpretation: 'Emotional tension, not a canon change.'
        }
      ]
    });
    expect(event.contradictionNotes).toHaveLength(1);
  });

  it('resolves thoughts and threads that the day closed out', () => {
    const { states } = apply({
      characterStatePatch: {
        ...createDiaryResponse().characterStatePatch,
        resolveUnresolvedThoughts: ['Was I too blunt in the last review?']
      },
      lifeStatePatch: {
        ...createDiaryResponse().lifeStatePatch,
        resolveUnresolvedThreads: ['has not replied to a message from a friend']
      }
    });

    expect(states.character.state.unresolvedThoughts).not.toContain('Was I too blunt in the last review?');
    expect(states.life.state.unresolvedThreads).toHaveLength(0);
  });
});
