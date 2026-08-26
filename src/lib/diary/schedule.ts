import {
  DIARY_SCHEDULE_EXPLAINED_MOVEMENTS,
  DIARY_SCHEDULE_LEDGER,
  DIARY_SCHEDULE_MOVEMENTS,
  DIARY_SCHEDULE_RESOLVING_MOVEMENTS,
  type DiaryEntry,
  type DiaryScheduledEvent
} from '../../schemas/diary';
import { namesSameThing } from './focus';
import {
  addDays,
  resolveRelativeWindow,
  windowsOverlap,
  type DiaryDateWindow
} from './relative-dates';

/**
 * What the archive says a juror has already promised to do, and whether today's entry did it at
 * a time the archive can account for.
 *
 * Issue #120: on 2026-08-16 Alex wrote that Leo's mother wanted them "next month" to clear out
 * the attic. On 08-21 — five calendar days later — Alex and Leo were clearing it, and the entry
 * never said the visit had been brought forward, that anything had become urgent, or that "next
 * month" had been a mistake. Both entries are individually readable. Their calendars are not
 * compatible.
 *
 * This is the sibling of issue #111 and it needs the sibling answer. There, a project came back
 * to a stage it had already passed; here, a plan is carried out outside the window it was given.
 * A stage is a fact about the past and a plan is a claim about the future, so the ledger has to
 * hold a different kind of thing — the words the writer used for the time, resolved against the
 * day the writer used them (lib/diary/relative-dates.ts).
 *
 * What this deliberately is NOT:
 *
 *   - a gate. Nothing here can fail a day (brief §14). The outputs are a prompt section and a
 *     warning on the generation record; what actually prevents the contradiction is the ledger
 *     the next prompt carries, not the check that notices afterwards.
 *   - a ban on changing a plan. Plans move and plans fall through, and a visit brought forward
 *     because a roof started leaking is a better entry than one kept out of obligation to a
 *     sentence written five days ago. The only thing asked is that the entry say so.
 *   - a schedule the personas must obey. A commitment may lapse, and an entry may simply never
 *     mention it again; the ledger ages it out rather than nagging forever.
 *   - a body scan. It reads only what the writer said about its own plans, exactly as
 *     lib/diary/projects.ts reads only what the writer said about its own projects. A dinner
 *     mentioned in passing in the prose is invisible here.
 *
 * And it reads published entries only. Nothing in Private Canon, in a state file, in a memory
 * patch or in a raw response reaches this module, so nothing it puts in a prompt can carry any
 * of them into public prose.
 */

/** One commitment the archive has left standing, newest statement wins. */
export interface DiaryScheduleLedgerRow {
  /** What is going to happen, worded as the entry that last stated it worded it. */
  event: string;
  /** Who it involves, in the same words. Empty when the writer named nobody. */
  participants: string;
  /** The time it was given, in the writer's own words. Null when they gave it none. */
  when: string | null;
  /**
   * Those words resolved against `date`. Null when the phrase does not resolve — an open-ended
   * plan, or one worded in a way lib/diary/relative-dates.ts declines to guess at.
   */
  window: DiaryDateWindow | null;
  /** What the last entry to touch it did to it: `made` or `moved`. */
  movement: string;
  /** The entry that said so. */
  date: string;
  /** That entry's id, so a row can be traced back to the published diary that carries it. */
  diaryId: string;
}

/** A commitment kept outside the window the archive had for it, with the statement it misses. */
export interface DiaryScheduleConflict {
  /** `early` — the window had not opened yet. `late` — it had already closed. */
  kind: 'early' | 'late';
  event: string;
  /** The days the archive gave it. Never null: a commitment with no window is never a conflict. */
  window: DiaryDateWindow;
  /** The window this entry could plausibly be reporting from: the days since the last entry. */
  covered: DiaryDateWindow;
  previous: DiaryScheduleLedgerRow;
}

/** A standing commitment re-stated at a different time, with nothing said about the change. */
export interface DiaryRetimedCommitment {
  event: string;
  /** The time it has just been given, and the days those words cover. */
  when: string;
  window: DiaryDateWindow;
  previous: DiaryScheduleLedgerRow;
}

/** A plan moved or called off without the entry saying what changed. */
export interface DiaryUnexplainedScheduleChange {
  event: string;
  movement: string;
}

function isKnownMovement(movement: string): boolean {
  return DIARY_SCHEDULE_MOVEMENTS.includes(movement as (typeof DIARY_SCHEDULE_MOVEMENTS)[number]);
}

/** True when a movement takes the commitment off the pending list rather than leaving it there. */
function resolvesCommitment(movement: string): boolean {
  return DIARY_SCHEDULE_RESOLVING_MOVEMENTS.includes(
    movement as (typeof DIARY_SCHEDULE_RESOLVING_MOVEMENTS)[number]
  );
}

/** True when the movement is one whose whole content is that the plan changed. */
function owesAnExplanation(movement: string): boolean {
  return DIARY_SCHEDULE_EXPLAINED_MOVEMENTS.includes(
    movement as (typeof DIARY_SCHEDULE_EXPLAINED_MOVEMENTS)[number]
  );
}

function stated(text: string | null | undefined): boolean {
  return (text ?? '').trim().length > 0;
}

/**
 * The commitments this juror has made and not yet resolved, newest statement first.
 *
 * Own entries only, and only entries strictly earlier than the day being written — a plan
 * belongs to the persona who made it, and a re-run of any day must see the archive the first
 * attempt saw.
 *
 * Unlike the project ledger, a resolved commitment is *dropped*. A project that is finished can
 * still be quietly put back on the workbench, so it stays; a visit that has happened, or been
 * called off, is not a plan any more, and carrying it forward as one is how a writer ends up
 * being told to keep an appointment it already kept. The newest statement decides that: an
 * entry that kept or dropped a commitment closes it, and an older entry that made it can no
 * longer reopen it.
 *
 * A movement this pipeline does not recognise closes the commitment too, and never opens one.
 * The validator drops unknown movements before they reach an entry, so this only arises for an
 * entry written by some other version of the pipeline — and between inventing a pending plan
 * and forgetting one, forgetting is the error that cannot produce a false accusation.
 */
export function buildDiaryScheduleLedger(input: {
  entries: readonly DiaryEntry[];
  jurorId: string;
  /** The day being written. Entries on or after it are not part of its past. */
  before: string;
  ownEntryLookback?: number;
  maxEvents?: number;
}): DiaryScheduleLedgerRow[] {
  const lookback = input.ownEntryLookback ?? DIARY_SCHEDULE_LEDGER.ownEntryLookback;
  const maxEvents = input.maxEvents ?? DIARY_SCHEDULE_LEDGER.maxEvents;

  const own = input.entries
    .filter((entry) => entry.jurorId === input.jurorId && entry.date < input.before)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, lookback);

  const rows: DiaryScheduleLedgerRow[] = [];
  const settled: string[] = [];

  for (const entry of own) {
    for (const scheduled of entry.scheduledEvents) {
      const event = scheduled.event.trim();
      if (event.length === 0) continue;
      // Newest first, so the first statement of a commitment is the current one — whether it
      // left the plan standing or closed it.
      if (rows.some((row) => namesSameThing(row.event, event))) continue;
      if (settled.some((closed) => namesSameThing(closed, event))) continue;

      if (!isKnownMovement(scheduled.movement) || resolvesCommitment(scheduled.movement)) {
        settled.push(event);
        continue;
      }

      const when = stated(scheduled.when) ? scheduled.when!.trim() : null;
      rows.push({
        event,
        participants: scheduled.participants.trim(),
        when,
        window: when === null ? null : resolveRelativeWindow(when, entry.date),
        movement: scheduled.movement,
        date: entry.date,
        diaryId: entry.id
      });
      if (rows.length >= maxEvents) return rows;
    }
  }
  return rows;
}

/**
 * The days an entry can plausibly be reporting from: everything since the writer's own previous
 * entry, up to and including the day being written.
 *
 * This is the difference between a schedule check that works and one that fires constantly.
 * Duty comes round every fifth day, so an entry is never only about the day at the top of it —
 * a plan made for "tomorrow" is kept the day after, off-page, and told four days later. Judging
 * the keeping against the entry's own date alone would report a contradiction on almost every
 * short-horizon plan a diarist ever makes.
 *
 * With no previous entry the span is the single day: an archive with nothing before it has
 * nothing for the entry to be catching up on.
 */
export function coveredWindow(entryDate: string, previousEntryDate: string | null): DiaryDateWindow {
  if (previousEntryDate === null || previousEntryDate >= entryDate) {
    return { start: entryDate, end: entryDate };
  }
  return { start: addDays(previousEntryDate, 1), end: entryDate };
}

/**
 * Commitments today's entry carried out at a time the archive cannot account for.
 *
 * Only `kept` is checked, and only against a commitment the ledger holds with a window that
 * actually resolved. A plan the ledger has never seen cannot conflict — it is new, or older
 * than the lookback, or worded in a way nothing here would guess at — and inventing a
 * contradiction against a window nobody stated is exactly the failure mode this must not have.
 *
 * A `changeReason` clears it. That is the whole bargain of the section: a plan may be brought
 * forward or run late, and the entry that does so has said in its own prose that it did. The
 * check cannot read the prose, so it reads the writer's statement that the prose is there — the
 * same standing every other self-reported continuity field in this pipeline has.
 */
export function detectScheduleConflicts(input: {
  events: readonly DiaryScheduledEvent[];
  ledger: readonly DiaryScheduleLedgerRow[];
  entryDate: string;
  /** The writer's own previous entry, or null when this is their first. */
  previousEntryDate?: string | null;
}): DiaryScheduleConflict[] {
  const covered = coveredWindow(input.entryDate, input.previousEntryDate ?? null);
  const conflicts: DiaryScheduleConflict[] = [];

  for (const scheduled of input.events) {
    if (scheduled.movement !== 'kept') continue;
    if (stated(scheduled.changeReason)) continue;

    const previous = input.ledger.find((row) => namesSameThing(row.event, scheduled.event));
    if (!previous?.window) continue;
    if (windowsOverlap(previous.window, covered)) continue;

    conflicts.push({
      kind: previous.window.start > covered.end ? 'early' : 'late',
      event: scheduled.event,
      window: previous.window,
      covered,
      previous
    });
  }
  return conflicts;
}

/**
 * Standing commitments this entry re-states at a different time without calling it a move.
 *
 * The hole the window check leaves on its own. An entry that simply says "we are doing the attic
 * this weekend", of a plan the archive has for next month, resets the window silently — and the
 * entry that then keeps it lands inside the new window and draws no finding at all. Read in
 * sequence that is the same contradiction as issue #120's, spread over one more entry.
 *
 * Only `made` is checked, and only when both windows resolve: a plan already reported as `moved`
 * has said what this is asking for, and two times that cannot be compared are not a difference.
 * Re-stating a plan in the same words, or in different words that mean the same days, is not a
 * change and is passed over.
 */
export function detectRetimedCommitments(input: {
  events: readonly DiaryScheduledEvent[];
  ledger: readonly DiaryScheduleLedgerRow[];
  entryDate: string;
}): DiaryRetimedCommitment[] {
  const retimed: DiaryRetimedCommitment[] = [];

  for (const scheduled of input.events) {
    if (scheduled.movement !== 'made') continue;
    if (stated(scheduled.changeReason)) continue;
    if (!stated(scheduled.when)) continue;

    const previous = input.ledger.find((row) => namesSameThing(row.event, scheduled.event));
    if (!previous?.window) continue;

    const when = scheduled.when!.trim();
    const window = resolveRelativeWindow(when, input.entryDate);
    if (!window) continue;
    if (window.start === previous.window.start && window.end === previous.window.end) continue;

    retimed.push({ event: scheduled.event, when, window, previous });
  }
  return retimed;
}

/**
 * Plans this entry moved or called off without saying what changed.
 *
 * `moved` and `dropped` report nothing except that a plan is no longer what it was, so an
 * unexplained one is a ledger row that will be quoted back to the writer with a change nobody
 * can account for — which is the original defect, one step earlier. Reported, never fatal.
 */
export function detectUnexplainedScheduleChanges(
  events: readonly DiaryScheduledEvent[]
): DiaryUnexplainedScheduleChange[] {
  return events
    .filter((scheduled) => owesAnExplanation(scheduled.movement) && !stated(scheduled.changeReason))
    .map((scheduled) => ({ event: scheduled.event, movement: scheduled.movement }));
}
