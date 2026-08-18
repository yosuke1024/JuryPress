import { describe, it, expect } from 'vitest';
import { buildDiaryPrompt } from '../../src/lib/diary/prompt';
import { validateDiaryResponse } from '../../src/lib/diary/validator';
import {
  DIARY_ABSTRACTION_LEVELS,
  DIARY_CANON_FACT_TYPES,
  DIARY_INTERACTION_LEVELS,
  DIARY_MEMORY_IMPORTANCE,
  DIARY_PATCH_LIMITS,
  DIARY_PROJECT_MOVEMENTS,
  DIARY_RECENT_CYCLE,
  DIARY_TEXT_LIMITS
} from '../../src/schemas/diary';
import { JUDGE_SLUGS } from '../../src/schemas/jury';
import type { DiaryContext } from '../../src/lib/diary/context';
import { detectRecurringFocus } from '../../src/lib/diary/focus';
import { detectEssayRun, type DiarySceneGlance } from '../../src/lib/diary/scene';
import { getJudge } from '../../src/lib/jury';
import {
  DIARY_CYCLE_SAMPLE,
  createDiaryResponse,
  createEntryFocus,
  createJurorStates
} from '../helpers/diary-fixtures';

/**
 * These tests exist because of 2026-08-01, the first day JuryDiary ever generated.
 *
 * The validator required `memoryCandidate.importance` to sit in [0, 1]. The prompt described the
 * field only as "worth remembering months from now" and never named a scale, and the response
 * schema typed it as a bare number, so nothing the model could read carried the bound. Gemini
 * answered 2 — the obvious reading of an unstated rating — and a structurally sound entry, its
 * canon fact and its life patches were all discarded over one number.
 *
 * The lesson generalises past that field: a bound the validator enforces and the prompt withholds
 * is not a strict gate, it is a trap. So the assertion here is not "the prompt mentions
 * importance" but "every numeric bound this prompt is judged against appears in the prompt".
 */

function context(overrides: Partial<DiaryContext> = {}): DiaryContext {
  return {
    juror: getJudge('david'),
    date: '2026-08-02',
    theme: 'mixed',
    privateEventCategory: 'small_success',
    states: createJurorStates('david'),
    ownPreviousEntry: null,
    peerGlances: [],
    recentArcs: [],
    recentCycle: [],
    essayRun: null,
    recentFocuses: [],
    recurringFocus: null,
    projectLedger: [],
    mentionsOfSelf: [],
    readingTarget: null,
    memories: [],
    reviews: [],
    allowedReviewSlugs: [],
    ...overrides
  };
}

describe('diary prompt', () => {
  it('states the importance scale, so a model cannot guess 1–5 and lose the day', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toContain('importance');
    expect(prompt).toContain(
      `${DIARY_MEMORY_IMPORTANCE.min} to ${DIARY_MEMORY_IMPORTANCE.max}`
    );
    // The failure mode by name: an unqualified "importance" invites a 1–5 reading.
    expect(prompt).toMatch(/NOT a 1–5/);
  });

  /*
   * Field-scoped on purpose. A bare `toContain(String(bound))` is close to vacuous here:
   * relationshipDelta and traitDelta are both 0.05, so either instruction could disappear
   * entirely and a numeric-substring check would still pass. Each bound is asserted next to the
   * field name it governs instead.
   */
  it('quotes every list cap next to the field it governs', () => {
    const prompt = buildDiaryPrompt(context());

    /*
     * Every key of DIARY_PATCH_LIMITS that caps a list, derived from the constant rather than
     * hand-listed, so a cap added to the schema without a prompt line fails here. The delta
     * bounds are not counts and are asserted separately below.
     */
    const deltas = new Set(['relationshipDelta', 'traitDelta', 'beliefConfidenceDelta']);
    const capped = Object.entries(DIARY_PATCH_LIMITS).filter(([field]) => !deltas.has(field));
    expect(capped.length).toBeGreaterThan(10);

    for (const [field, cap] of capped) {
      // "at most" is required so the field name and the number cannot drift apart unnoticed.
      expect(prompt, `${field} cap missing from the prompt`).toMatch(
        new RegExp(`${field}: at most ${cap}\\b`)
      );
    }
  });

  it('quotes each delta bound beside its own field', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(
      new RegExp(`±${DIARY_PATCH_LIMITS.relationshipDelta}[^]*?neutral is trust`)
    );
    expect(prompt).toMatch(
      new RegExp(`traitAdjustments[^\\n]*±${DIARY_PATCH_LIMITS.traitDelta}`)
    );
    expect(prompt).toMatch(
      new RegExp(`beliefAdjustments[^\\n]*±${DIARY_PATCH_LIMITS.beliefConfidenceDelta}`)
    );
  });

  it('spells out the canon fact types, which are enum values and not concepts', () => {
    const prompt = buildDiaryPrompt(context());

    /*
     * Scoped to the factType line. Several of these words ("home", "other", "habit") occur in
     * ordinary prose elsewhere in the prompt, so an unscoped toContain would pass on a prompt
     * that never listed the enum at all.
     */
    const line = prompt
      .split('\n')
      .find((candidate) => candidate.includes('factType must be exactly one of'));
    expect(line, 'no line enumerating the accepted factType values').toBeDefined();

    for (const factType of DIARY_CANON_FACT_TYPES) {
      expect(line, `canon fact type ${factType} missing`).toContain(factType);
    }
    // The trap the old wording set: it offered "an object", which is not an accepted value.
    expect(prompt).toContain('"possession"');
    expect(prompt).not.toMatch(/\(a habit, an object, a place, a past event\)/);
  });

  it('states the text floors that decide publication', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(new RegExp(`body\\.en at least ${DIARY_TEXT_LIMITS.minBodyEn}`));
    expect(prompt).toMatch(new RegExp(`body\\.ja at least ${DIARY_TEXT_LIMITS.minBodyJa}`));
    expect(prompt).toMatch(new RegExp(`title at least ${DIARY_TEXT_LIMITS.minTitle}`));
    expect(prompt).toMatch(new RegExp(`mood at least ${DIARY_TEXT_LIMITS.minMood}`));
    // The script floor is a number in the validator; prose alone would leave it unstated.
    expect(prompt).toMatch(
      new RegExp(`${Math.round(DIARY_TEXT_LIMITS.minJapaneseRatio * 100)}% of body\\.ja`)
    );
    expect(prompt).toMatch(
      new RegExp(`shareQuote at least ${DIARY_TEXT_LIMITS.minShareQuote} characters`)
    );
    expect(prompt).toMatch(new RegExp(`most ${DIARY_TEXT_LIMITS.maxShareQuote}`));
    expect(prompt).toContain(
      `${DIARY_TEXT_LIMITS.minLengthRatio}–${DIARY_TEXT_LIMITS.maxLengthRatio}`
    );
  });

  it('names the jurors a relationship patch may target, and excludes the writer', () => {
    const prompt = buildDiaryPrompt(context());

    for (const slug of JUDGE_SLUGS.filter((candidate) => candidate !== 'david')) {
      expect(prompt, `peer ${slug} missing from the allowed targets`).toMatch(
        new RegExp(`targetJurorId must be one of:[^\\n]*${slug}`)
      );
    }
    // The writer is never a legal target, and the validator rejects a repeated one separately.
    expect(prompt).not.toMatch(/targetJurorId must be one of:[^\n]*david/);
    expect(prompt).toContain('Never yourself');
    expect(prompt).toMatch(/never the same\s+juror twice/);
  });

  /*
   * Over-claiming what is fatal is the same defect as under-claiming, pointed the other way: it
   * buys caution at the price of entries nobody needed to lose. The validator checks relationship
   * *deltas*, never the resulting 0–1 value, and cannot check "only jurors you wrote about" at
   * all — so neither may be described as day-ending.
   */
  it('claims fatality for exactly what the validator enforces, and no more', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(/Extra notes beyond that are dropped rather than fatal/);
    expect(prompt).toMatch(/Hard limits, checked exactly/);
    expect(prompt).toMatch(/contradictionNotes is not one of them/);
    expect(prompt).toMatch(/Neither is the 0–1 relationship scale/);
    expect(prompt).not.toMatch(/Everything above/);
  });

  it('rejects the exact value that cost 2026-08-01, and accepts one on the stated scale', () => {
    const expected = {
      date: '2026-08-02',
      jurorId: 'david' as const,
      theme: 'mixed' as const,
      privateEventCategory: 'small_success' as const,
      allowedReviewSlugs: [],
      readingTargetId: null
    };
    const withImportance = (importance: number) =>
      validateDiaryResponse({
        parsed: createDiaryResponse({
          memoryCandidate: { summary: 'A memory worth keeping.', importance, tags: [] }
        }),
        expected
      });

    expect(withImportance(2).errors.map((finding) => finding.code)).toEqual([
      'DIARY_IMPORTANCE_OUT_OF_BOUNDS'
    ]);
    // Zero errors, not merely a different set: importance is the only thing separating the two.
    expect(withImportance(0.9).errors).toEqual([]);
  });
});

/*
 * Issue #105: the first week of entries, in five voices, all told the same day — a tactile
 * private prop, turned into a professional metaphor, closed with a tidy lesson. Shape is
 * steered in the prompt and only in the prompt — the structural gate must never grow an
 * opinion on narrative technique — which makes the prompt text the only enforceable surface.
 * These tests pin that surface.
 */
describe('diary prompt — narrative shape (issue #105)', () => {
  it('names the default arc as the thing not to repeat', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toContain('THE SHAPE OF THE ENTRY');
    // The arc in its three stages: prop, metaphor, lesson.
    expect(prompt).toMatch(/private-life object/);
    expect(prompt).toMatch(/metaphor for a professional contradiction/);
    expect(prompt).toMatch(/polished lesson/);
    expect(prompt).toMatch(/Do not\s+default to that arc/);
  });

  it('permits unresolved, non-moralizing and non-professional entries', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(/owes nobody a lesson/);
    expect(prompt).toMatch(/end unresolved/);
    expect(prompt).toMatch(/state a problem and not solve it/);
    expect(prompt).toMatch(/A private thing may stay private/);
    expect(prompt).toMatch(/without meaning anything/);
    // A sample of the alternative modes, so the list cannot quietly vanish.
    expect(prompt).toMatch(/actual\s+dialogue/);
    expect(prompt).toMatch(/never becomes self-analysis/);
    expect(prompt).toMatch(/consequences have not landed/);
  });

  it('bans no single technique — reflection and domestic detail stay legal', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(/None of this bans reflection, domestic detail/);
  });

  it('shows how recent entries opened and closed, when any exist', () => {
    const prompt = buildDiaryPrompt(
      context({
        recentArcs: [
          {
            jurorId: 'alex',
            date: '2026-08-01',
            theme: 'private',
            opening: 'I spent forty minutes wrestling with a ribbon.',
            closing: 'You just have to do it right the first time.'
          }
        ]
      })
    );

    expect(prompt).toContain('HOW RECENT ENTRIES OPENED AND CLOSED');
    expect(prompt).toContain('- alex, 2026-08-01 (private day)');
    expect(prompt).toContain('opened: "I spent forty minutes wrestling with a ribbon."');
    expect(prompt).toContain('closed: "You just have to do it right the first time."');
    // With arcs on show, the shape brief points back at them.
    expect(prompt).toMatch(/If that arc is what the latest\s+entries did/);
  });

  it('omits the arc section on an empty archive, but keeps the standing guidance', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).not.toContain('HOW RECENT ENTRIES OPENED AND CLOSED');
    expect(prompt).toContain('THE SHAPE OF THE ENTRY');
    // Nothing to point back at, so the pointer must not dangle.
    expect(prompt).not.toMatch(/If that arc is what the latest/);
  });

  /*
   * The 2026-08-01 lesson pointed the other way: describing a preference as day-ending is the
   * same defect as withholding a real bound. Shape guidance is style, the gate is structural,
   * and the section must never claim otherwise.
   */
  it('never claims a shape violation costs the day', () => {
    const prompt = buildDiaryPrompt(context());
    const shapeSection = prompt.split('[THE SHAPE OF THE ENTRY')[1]?.split('\n\n[')[0] ?? '';

    expect(shapeSection.length).toBeGreaterThan(0);
    expect(shapeSection).not.toMatch(/discard|fatal|reject|hard limit/i);
  });
});

/*
 * Issue #110: Alex's 2026-08-01, 08-06 and 08-11 entries all turned on the Hermes Baby ribbon
 * and the same friction thesis — across two prompt versions, and with the newest of the three
 * the best written. So this is not a regression, it is continuity context re-electing one
 * subject as the centre of the story every time.
 *
 * The fix is prompt-only, exactly like #105's: the writer is shown what its own last entries
 * were about, told the difference between a prop that is present and a prop that is carrying
 * the entry, and — when two consecutive days already agree on a centre — asked for a different
 * one. These tests pin that surface, including the parts that must NOT appear: no ban, and no
 * claim that any of it can cost a day.
 */
describe('diary prompt — the centre of the entry (issue #110)', () => {
  const RIBBON_DAY = {
    date: '2026-08-06',
    title: 'Friction and Soul',
    theme: 'private' as const,
    focus: createEntryFocus({
      dominantSubject: 'replacing the ribbon on the Hermes Baby',
      anchorObject: 'the Hermes Baby typewriter',
      centralTension: 'Manual friction gives a hobby its soul but has no place in software.',
      endingState: 'settled into a lesson'
    })
  };
  const EARLIER_RIBBON_DAY = {
    date: '2026-08-01',
    title: 'Ink on my Hands',
    theme: 'private' as const,
    focus: createEntryFocus({
      dominantSubject: 'a failed ribbon change on the Hermes Baby',
      anchorObject: 'the Hermes Baby typewriter',
      centralTension: 'You cannot optimize your way out of manual mechanics.',
      endingState: 'resigned'
    })
  };

  /** A context carrying real focus records, with the recurrence computed the way code does. */
  function withFocuses(...recentFocuses: Array<typeof RIBBON_DAY>) {
    return context({
      recentFocuses,
      recurringFocus: detectRecurringFocus(recentFocuses.map((glance) => glance.focus))
    });
  }

  it('summarizes the recent entries by all four fields the issue names', () => {
    const prompt = buildDiaryPrompt(withFocuses(RIBBON_DAY, EARLIER_RIBBON_DAY));

    expect(prompt).toContain('WHAT YOUR OWN LAST ENTRIES WERE ABOUT');
    expect(prompt).toContain('- 2026-08-06 (private day) — Friction and Soul');
    expect(prompt).toContain('dominant subject: replacing the ribbon on the Hermes Baby');
    expect(prompt).toContain('anchor object: the Hermes Baby typewriter');
    expect(prompt).toContain(
      'central tension: Manual friction gives a hobby its soul but has no place in software.'
    );
    expect(prompt).toContain('ended: settled into a lesson');
    // Both entries, not just the newest — the question is about a third consecutive day.
    expect(prompt).toContain('- 2026-08-01 (private day) — Ink on my Hands');
  });

  it('renders a day that had no anchor object as having none, rather than an empty line', () => {
    const prompt = buildDiaryPrompt(
      withFocuses({
        ...RIBBON_DAY,
        focus: createEntryFocus({ dominantSubject: 'a phone call with Leo', anchorObject: null })
      })
    );

    expect(prompt).toContain('anchor object: (none)');
  });

  it('separates a prop that is present from a prop that is carrying the entry', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toContain('THE CENTRE OF THE ENTRY');
    expect(prompt).toMatch(/Continuity is not repetition/);
    expect(prompt).toMatch(/Background continuity: a thing is present/);
    expect(prompt).toMatch(/It carries no argument and proves no point/);
    expect(prompt).toMatch(/Central engine: the same thing is what the day turns on/);
    expect(prompt).toMatch(/The test is the role, not the noun/);
  });

  /*
   * The acceptance criterion this issue turns on. Two consecutive entries sharing a centre must
   * produce an explicit ask for a materially new dominant event or tension — and the carve-out
   * that keeps it honest, because a day that genuinely changes the belief is not a repeat.
   */
  it('asks a third consecutive entry for a materially new centre', () => {
    const prompt = buildDiaryPrompt(withFocuses(RIBBON_DAY, EARLIER_RIBBON_DAY));

    expect(prompt).toContain('YOUR LAST TWO ENTRIES ALREADY SHARE A CENTRE.');
    expect(prompt).toMatch(/Both were about the same thing:[^\n]*ribbon/);
    // "manual", not "friction": these are the two theses as the issue quotes them, and the
    // word they actually share is the one the writer gets told about.
    expect(prompt).toMatch(/Both carried the same argument:[^\n]*manual/);
    expect(prompt).toMatch(/materially different dominant event or tension/);
    expect(prompt).toMatch(/must not be the engine a\s+third time/);
    // The exception, stated as an exception: a real change is not a repeat.
    expect(prompt).toMatch(/a belief you actually revise/);
    expect(prompt).toMatch(/A new angle on\s+the same conclusion is not a change/);
  });

  it('says which half repeated when only the argument did', () => {
    const prompt = buildDiaryPrompt(
      withFocuses(
        {
          ...RIBBON_DAY,
          focus: createEntryFocus({
            dominantSubject: "Leo's marketplace rebuild",
            anchorObject: null,
            centralTension: 'Manual effort is worth keeping in a hobby and nowhere else.',
            endingState: 'left open'
          })
        },
        EARLIER_RIBBON_DAY
      )
    );

    expect(prompt).toContain('YOUR LAST TWO ENTRIES ALREADY SHARE A CENTRE.');
    expect(prompt).toContain('They were about different things.');
    expect(prompt).toMatch(/Both carried the same argument:[^\n]*manual/);
  });

  it('keeps the standing guidance but withholds the escalation when the centre moved', () => {
    const prompt = buildDiaryPrompt(
      withFocuses(
        {
          ...RIBBON_DAY,
          focus: createEntryFocus({
            dominantSubject: 'a phone call with Leo that ended badly',
            anchorObject: null,
            centralTension: 'Advising a friend for free costs more than it looks.',
            endingState: 'unfinished'
          })
        },
        EARLIER_RIBBON_DAY
      )
    );

    expect(prompt).toContain('THE CENTRE OF THE ENTRY');
    expect(prompt).not.toContain('YOUR LAST TWO ENTRIES ALREADY SHARE A CENTRE.');
  });

  /*
   * The archive on the day this ships carries no focus at all, and a juror's first duty day
   * under this prompt leaves exactly one. Neither may dangle a pointer at a section that is
   * not there.
   */
  it('omits the summary section on an archive with no focus recorded', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).not.toContain('WHAT YOUR OWN LAST ENTRIES WERE ABOUT');
    expect(prompt).not.toContain('YOUR LAST TWO ENTRIES ALREADY SHARE A CENTRE.');
    expect(prompt).toContain('THE CENTRE OF THE ENTRY');
  });

  it('asks for the four focus fields, and says what they are read for', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toContain('DESCRIBING WHAT YOU WROTE (entryFocus)');
    for (const field of ['dominantSubject', 'anchorObject', 'centralTension', 'endingState']) {
      expect(prompt, `${field} missing from the entryFocus instruction`).toContain(`- ${field}:`);
    }
    // Null is offered explicitly: a model forced to name an object would invent a prop.
    expect(prompt).toMatch(/or null\. Null is the honest answer/);
    expect(prompt).toMatch(/read back to you on your next duty day/);
    expect(prompt).toMatch(/never published/);
  });

  /*
   * Acceptance criterion, stated as a prohibition: the fix must not become a ban list. The
   * shared terms are quoted back from the writer's own focus records, which is a description
   * of what happened, not a forbidden-word list — and the section says so itself.
   */
  it('bans no object, topic, callback or reply', () => {
    const prompt = buildDiaryPrompt(withFocuses(RIBBON_DAY, EARLIER_RIBBON_DAY));
    const section = prompt.split('[THE CENTRE OF THE ENTRY')[1]?.split('\n\n[')[0] ?? '';

    expect(section.length).toBeGreaterThan(0);
    expect(section).toMatch(/Nothing in this section bans anything/);
    expect(section).toMatch(/No object, hobby, topic, callback, running joke or\s+reply/);
    expect(section).toMatch(/a subject you have written about before may be\s+written about again/);
    // Even under escalation, the recurring subject stays legal as background.
    expect(section).toMatch(/The old subject is not forbidden/);
    expect(section).not.toMatch(/\bnever (write|mention|use)\b|forbidden word|do not mention/i);
  });

  /* Shape guidance is style; the gate is structural. This section must not claim otherwise. */
  it('never claims a repeated centre costs the day', () => {
    const prompt = buildDiaryPrompt(withFocuses(RIBBON_DAY, EARLIER_RIBBON_DAY));
    const section = prompt.split('[THE CENTRE OF THE ENTRY')[1]?.split('\n\n[')[0] ?? '';

    expect(section).not.toMatch(/discard|fatal|reject|hard limit|excluded/i);
  });
});

/*
 * Issue #111: David's cedar bookcase was on its third coat of varnish on 2026-08-02 and on its
 * third coat again on 08-12, with one unrelated entry in between and nothing anywhere saying
 * the finish had come off. This is the opposite problem to #110 — the subject *should* come
 * back; it is the stage that must not — so the prompt gets a ledger of where the archive left
 * each project, and asks a returning project to resume from there.
 *
 * Prompt-only, again: the ledger cannot reject anything, and these tests pin the parts that
 * must not appear as hard as the parts that must.
 */
describe('diary prompt — the stage a project is at (issue #111)', () => {
  const BOOKCASE_LEDGER = [
    {
      project: 'the cedar bookcase',
      stage: 'third coat of varnish applied',
      movement: 'advanced',
      date: '2026-08-02'
    },
    {
      project: 'the spice jars',
      stage: 'labels printed, none stuck on yet',
      movement: 'started',
      date: '2026-08-07'
    }
  ];

  it('shows each ongoing project with the stage, movement and day that stated it', () => {
    const prompt = buildDiaryPrompt(context({ projectLedger: BOOKCASE_LEDGER }));

    expect(prompt).toContain('WHERE YOUR ONGOING PROJECTS STAND');
    expect(prompt).toContain('- the cedar bookcase: third coat of varnish applied');
    expect(prompt).toContain('  (advanced, last written 2026-08-02)');
    expect(prompt).toContain('- the spice jars: labels printed, none stuck on yet');
    // The ledger is state, not a writing assignment — a model handed a list writes about it.
    expect(prompt).toMatch(/It is not a list of things to\s+write about/);
  });

  it('asks a returning project to resume from the stage shown, not to restate it', () => {
    const prompt = buildDiaryPrompt(context({ projectLedger: BOOKCASE_LEDGER }));

    expect(prompt).toContain('THE STAGE YOUR PROJECTS ARE AT (projectUpdates)');
    expect(prompt).toMatch(/must not come back is a stage you have already passed/);
    expect(prompt).toMatch(/If today touches one, it resumes from there/);
    expect(prompt).toMatch(/Do not narrate a stage that entry already\s+recorded/);
    // Going backwards is a legitimate day, and the way to say so is stated.
    expect(prompt).toMatch(/A project is allowed to go backwards/);
    expect(prompt).toMatch(/record the movement as restarted or failed/);
  });

  /*
   * The frozen life-state line is half of how 08-12 happened: "Applying another coat of varnish
   * to a custom-built cedar bookcase" is a stage stored as an activity, with no date, and it is
   * still in the prompt above. The two sources must be ranked, or the older one wins by being
   * nearer the top.
   */
  it('ranks the ledger above the undated ongoing-activities list', () => {
    const prompt = buildDiaryPrompt(context({ projectLedger: BOOKCASE_LEDGER }));

    expect(prompt).toMatch(/CURRENT LIFE STATE lists ongoing activities with no stage and no date/);
    expect(prompt).toMatch(/the projects above are the\s+newer statement/);
  });

  it('names every movement the validator accepts', () => {
    const prompt = buildDiaryPrompt(context());
    const line = prompt.split('\n').find((candidate) => candidate.includes('- movement: exactly one of'));

    expect(line, 'no line enumerating the accepted movements').toBeDefined();
    for (const movement of DIARY_PROJECT_MOVEMENTS) {
      expect(line, `movement ${movement} missing`).toContain(movement);
    }
  });

  it('states the cap and, because the validator truncates, that it is not fatal', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(
      new RegExp(`projectUpdates: at most ${DIARY_PATCH_LIMITS.projectUpdates}\\b`)
    );
    expect(prompt).toMatch(/Neither is projectUpdates, wherever it is quoted/);
    expect(prompt).toMatch(/an unrecognised movement is dropped/);
  });

  it('keeps the field instruction on an empty archive, without pointing at an absent ledger', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).not.toContain('WHERE YOUR ONGOING PROJECTS STAND, above');
    expect(prompt).not.toMatch(/^\[WHERE YOUR ONGOING PROJECTS STAND\]$/m);
    expect(prompt).toContain('THE STAGE YOUR PROJECTS ARE AT (projectUpdates)');
    expect(prompt).toMatch(/- project: what it is/);
  });

  /*
   * The entry is still two languages and the description of it is still one. Asking for the
   * ledger fields in the entry's languages would put Japanese project names in a section the
   * matcher reads with an English stop list, and would quote them back in a prompt written in
   * English — so this follows entryFocus, and the bilingual floors are untouched by it.
   */
  it('asks for the project fields in English while the entry stays bilingual', () => {
    const prompt = buildDiaryPrompt(context({ projectLedger: BOOKCASE_LEDGER }));

    expect(prompt).toMatch(/record what it did to your projects, in English/);
    expect(prompt).toMatch(/body\.en at least/);
    expect(prompt).toMatch(/It is a translation, not a second entry/);
  });

  /* The acceptance criterion stated as a prohibition: recurring hobbies stay legal. */
  it('forbids no project, hobby or possession', () => {
    const prompt = buildDiaryPrompt(context({ projectLedger: BOOKCASE_LEDGER }));
    const section = prompt.split('[THE STAGE YOUR PROJECTS ARE AT')[1]?.split('\n\n[')[0] ?? '';

    expect(section.length).toBeGreaterThan(0);
    expect(section).toMatch(/Nothing here forbids a subject/);
    expect(section).toMatch(/may return as often as\s+it likes/);
    expect(section).toMatch(/may be abandoned and picked up again/);
  });

  /* Continuity guidance is style; the gate is structural. This section must not claim otherwise. */
  it('never claims a repeated stage costs the day', () => {
    const prompt = buildDiaryPrompt(context({ projectLedger: BOOKCASE_LEDGER }));
    const section = prompt.split('[THE STAGE YOUR PROJECTS ARE AT')[1]?.split('\n\n[')[0] ?? '';

    expect(section).not.toMatch(/discard|fatal|reject|hard limit|excluded/i);
  });
});

/*
 * Issue #113: Sarah's 2026-08-14 and Marcus's 2026-08-15 entries share no subject, no object,
 * no vocabulary and no argument — and read alike anyway, because both state a professional
 * position, prove it with private detail, and close on a general principle. The centre
 * comparison (#110) sees two unrelated days; the arc comparison (#105) sees two different
 * shapes. What is left to steer is the mode, so the prompt shows the whole rotation what its
 * days were made of and asks today to contain something that happens.
 *
 * Prompt-only, again. These tests pin the parts that must not appear as hard as the parts that
 * must: no topic is banned, dialogue is never required, and no wording here may suggest that a
 * day could be discarded over any of it.
 */
describe('diary prompt — the day itself (issue #113)', () => {
  const CYCLE: DiarySceneGlance[] = DIARY_CYCLE_SAMPLE.map((sample) => ({
    jurorId: sample.jurorId,
    date: sample.date,
    theme: sample.theme,
    sceneEvent: sample.focus.sceneEvent,
    interactionLevel: sample.focus.interactionLevel,
    abstractionLevel: sample.focus.abstractionLevel,
    endingState: sample.focus.endingState
  }));

  /** A cycle whose first `count` entries argued a position with nothing happening in them. */
  function essayCycle(count: number): DiarySceneGlance[] {
    return CYCLE.map((glance, index) =>
      index < count
        ? {
            ...glance,
            sceneEvent: null,
            interactionLevel: 'none',
            abstractionLevel: 'argument'
          }
        : { ...glance, abstractionLevel: 'scene' }
    );
  }

  function withCycle(recentCycle: DiarySceneGlance[]) {
    return context({ recentCycle, essayRun: detectEssayRun(recentCycle) });
  }

  /* Acceptance criterion: the cycle context carries all four structural fields, per juror. */
  it('shows what each recent entry was made of, for the other diarists too', () => {
    const prompt = buildDiaryPrompt(withCycle(CYCLE));

    expect(prompt).toContain('HOW RECENT ENTRIES SPENT THE DAY');
    expect(prompt).toContain('- sarah, 2026-08-24 (mixed day)');
    expect(prompt).toContain(
      '  what happened: Marcus answered the scope question with a retention figure I could not argue with'
    );
    expect(prompt).toContain('  another person in it: direct');
    expect(prompt).toContain('  the entry was mostly: mixed');
    expect(prompt).toContain('  ended: conceded, and irritated at having conceded so quickly');
    // All five, not only the writer's own: the mode is a property of the rotation (#113).
    for (const sample of DIARY_CYCLE_SAMPLE) {
      expect(prompt, `${sample.jurorId} missing from the cycle`).toContain(
        `- ${sample.jurorId}, ${sample.date}`
      );
    }
  });

  it('renders a day where nothing happened as one, rather than as a blank line', () => {
    const prompt = buildDiaryPrompt(withCycle(CYCLE));

    expect(prompt).toContain('  what happened: (nothing on the page — reflection only)');
  });

  it('names the essay as the anti-pattern and asks for something that occurs', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toContain('THE DAY ITSELF (something has to happen in it)');
    expect(prompt).toMatch(/in character, well written, and still be an essay/);
    expect(prompt).toMatch(/a position\s+from your professional life stated near the top/);
    expect(prompt).toMatch(/Something has to happen where the reader can see it/);
    expect(prompt).toMatch(/acts, answers, refuses,/);
    // Reported-as-having-happened is the half Sarah's 08-14 entry satisfies and still fails.
    expect(prompt).toMatch(/rather than be reported as having happened/);
  });

  /* The order of operations is the request, not the presence of an event. */
  it('asks the event to complicate the position rather than illustrate it', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(/The event happens first and the thinking has\s+to deal with it/);
    expect(prompt).toMatch(/the event was decoration and the entry is a position paper/);
    expect(prompt).toMatch(/complicate the position rather than confirm it/);
    // And the ending: a maxim is one option, not the destination.
    expect(prompt).toMatch(/An ending may be a consequence, an unanswered message/);
  });

  it('escalates once the rotation has spent a majority of it arguing', () => {
    const prompt = buildDiaryPrompt(withCycle(essayCycle(DIARY_RECENT_CYCLE.essayRun)));

    expect(prompt).toContain('THE LAST CYCLE HAS BEEN ARGUING.');
    expect(prompt).toMatch(
      new RegExp(`${DIARY_RECENT_CYCLE.essayRun} of the last ${DIARY_RECENT_CYCLE.entryCount} entries`)
    );
    expect(prompt).toMatch(/Today is not another one/);
    // Named diarists, because the point is that this is not one persona repeating itself.
    expect(prompt).toMatch(/alex, david, lisa/);
  });

  it('keeps the standing guidance but withholds the escalation below the threshold', () => {
    const prompt = buildDiaryPrompt(withCycle(essayCycle(DIARY_RECENT_CYCLE.essayRun - 1)));

    expect(prompt).toContain('THE DAY ITSELF (something has to happen in it)');
    expect(prompt).not.toContain('THE LAST CYCLE HAS BEEN ARGUING.');
  });

  /*
   * The archive on the day this ships carries no scene record at all — every published entry
   * predates the fields. The section must stand on its own, and must not point at a cycle that
   * is not in the prompt.
   */
  it('omits the cycle section on an archive that never described a scene', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).not.toContain('HOW RECENT ENTRIES SPENT THE DAY');
    expect(prompt).not.toContain('THE LAST CYCLE HAS BEEN ARGUING.');
    expect(prompt).toContain('THE DAY ITSELF (something has to happen in it)');
  });

  it('asks for the three scene fields, with the values the validator accepts', () => {
    const prompt = buildDiaryPrompt(context());

    for (const field of ['sceneEvent', 'interactionLevel', 'abstractionLevel']) {
      expect(prompt, `${field} missing from the entryFocus instruction`).toContain(`- ${field}:`);
    }

    const interaction = prompt
      .split('\n')
      .find((line) => line.includes('- interactionLevel: exactly one of'));
    expect(interaction, 'no line enumerating the interaction levels').toBeDefined();
    for (const level of DIARY_INTERACTION_LEVELS) {
      expect(interaction, `interaction level ${level} missing`).toContain(level);
    }

    const abstraction = prompt
      .split('\n')
      .find((line) => line.includes('- abstractionLevel: exactly one of'));
    expect(abstraction, 'no line enumerating the abstraction levels').toBeDefined();
    for (const level of DIARY_ABSTRACTION_LEVELS) {
      expect(abstraction, `abstraction level ${level} missing`).toContain(level);
    }

    // Null is offered, so a day with no event has something honest to answer.
    expect(prompt).toMatch(/or null if the entry contains no such/);
    expect(prompt).toMatch(/Describe what you wrote, not what you meant to write/);
  });

  /*
   * The validator sets an unrecognised level aside and publishes the day. A prompt that
   * described that as fatal would buy caution at the price of entries nobody needed to lose —
   * the same defect as a bound the prompt withholds, pointed the other way.
   */
  it('says that a level it cannot read costs a line of context, not the day', () => {
    const prompt = buildDiaryPrompt(context());

    expect(prompt).toMatch(/A word outside the two lists above is set aside with a warning/);
    expect(prompt).toMatch(/Nor is entryFocus, including its two level/);
  });

  /* Acceptance criteria, stated as prohibitions: no banned subject, no required technique. */
  it('bans no professional subject and requires no dialogue', () => {
    const prompt = buildDiaryPrompt(withCycle(essayCycle(DIARY_RECENT_CYCLE.essayRun)));
    const section = prompt.split('[THE DAY ITSELF')[1]?.split('\n\n[')[0] ?? '';

    expect(section.length).toBeGreaterThan(0);
    expect(section).toMatch(/Nothing here bans a subject or prescribes a technique/);
    expect(section).toMatch(/vocabulary of your job are welcome in any entry/);
    expect(section).toMatch(/Dialogue is not\s+required, and neither is another person/);
    expect(section).toMatch(/a single day that is one long argument with yourself is a fine\s+day/);
    expect(section).not.toMatch(/\bnever (write|mention|use)\b|forbidden word|do not mention/i);
  });

  /* Shape guidance is style; the gate is structural. This section must not claim otherwise. */
  it('never claims an argument-led day costs the day', () => {
    const prompt = buildDiaryPrompt(withCycle(essayCycle(DIARY_RECENT_CYCLE.essayRun)));
    const section = prompt.split('[THE DAY ITSELF')[1]?.split('\n\n[')[0] ?? '';

    expect(section).not.toMatch(/discard|fatal|reject|hard limit|excluded/i);
  });

  /* The single call and the two languages are untouched by any of this. */
  it('leaves the bilingual contract and the one-request budget alone', () => {
    const prompt = buildDiaryPrompt(withCycle(CYCLE));

    expect(prompt).toMatch(/Finish the English entry first/);
    expect(prompt).toMatch(/It is a translation, not a second entry/);
    expect(prompt).toMatch(/body\.ja at least/);
  });
});
