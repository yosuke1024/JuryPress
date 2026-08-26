import {
  DIARY_PROJECT_LEDGER,
  DIARY_PROJECT_RESET_MOVEMENTS,
  type DiaryEntry,
  type DiaryProjectUpdate
} from '../../schemas/diary';
import { namesSameThing, termsOf } from './focus';

/**
 * What the archive last said about a juror's ongoing projects, and whether today's entry put
 * one of them back where it already was.
 *
 * Issue #111: David applied "the third coat of varnish to the cedar bookcase" on 2026-08-02,
 * wrote about something else on 08-07, and on 08-12 was "on the third coat of varnish on the
 * cedar bookcase" again — treating a bubble in the second layer as a live decision the third
 * coat had not yet sealed. No entry in between said the finish had been stripped or had
 * failed. Each entry is fine on its own; read in sequence the bookcase un-advanced itself.
 *
 * This is a narrower problem than #105 (every entry the same shape) or #110 (every entry about
 * the same subject), and it needs a different answer. Both of those ask the writer to move on
 * from something. This one asks it to stay consistent with something — a hobby that comes back
 * is exactly what a diary accumulating over months should do, and the only thing wrong with
 * the second bookcase entry is that it forgot which coat it was on.
 *
 * What this deliberately is NOT:
 *
 *   - a gate. Nothing here can fail a day (brief §14). The outputs are a prompt section and a
 *     warning on the generation record.
 *   - a ban on returning to a project. Returning is the point; the ledger exists so a return
 *     has somewhere to resume from.
 *   - a body scan. It reads only what the writer said about its own projects, so a bookcase
 *     leaned against in passing is invisible here, exactly as in lib/diary/focus.ts.
 */

/** One project as the archive last left it, newest statement wins. */
export interface DiaryProjectLedgerRow {
  /** The project, worded as the entry that last reported it worded it. */
  project: string;
  /** The stage it stood at then. */
  stage: string;
  /** What that entry did to it. */
  movement: string;
  /** The entry that said so. */
  date: string;
}

/** A project today put back where it already stood, with the statement it contradicts. */
export interface DiaryRepeatedProjectStage {
  project: string;
  stage: string;
  movement: string;
  previous: DiaryProjectLedgerRow;
}

function termKeys(text: string): Set<string> {
  return new Set(termsOf(text).keys());
}

/** Whether every term of the smaller set appears in the larger one. */
function contains(smaller: Set<string>, larger: Set<string>): boolean {
  for (const key of smaller) {
    if (!larger.has(key)) return false;
  }
  return true;
}

/**
 * Whether two project names denote the same project. `namesSameThing` in lib/diary/focus.ts owns
 * the rule and the reasons for it; the schedule ledger (issue #120) asks the same question of a
 * commitment, and one matcher answering both is one matcher to get right.
 */
function isSameProject(a: string, b: string): boolean {
  return namesSameThing(a, b);
}

/**
 * Whether today's stage says nothing the last stated stage did not already say.
 *
 * Containment in that one direction, not similarity and not equality. A stage that has moved
 * always brings a word the old one did not have — a fourth coat, a bubble sanded out, hardware
 * fitted — so requiring a new term is the same question as "did anything happen", asked in a
 * way that cannot be answered by rephrasing. Equality alone would miss the case the issue is
 * about: 08-12's "the third coat of varnish" is a shorter restatement of 08-02's, not a copy.
 *
 * The other direction is deliberately not checked. "Sanding the shelves" followed by "sanding
 * the shelves and cutting the back panel" contains the old stage whole and is still a day of
 * work, and an advisory that fires on it is an advisory nobody reads.
 */
function restatesStage(today: string, previous: string): boolean {
  const todayKeys = termKeys(today);
  const previousKeys = termKeys(previous);
  if (todayKeys.size === 0 || previousKeys.size === 0) return false;
  return contains(todayKeys, previousKeys);
}

/** True when a project reaching the same stage again is accounted for rather than forgotten. */
function explainsReturn(movement: string): boolean {
  return DIARY_PROJECT_RESET_MOVEMENTS.includes(movement as (typeof DIARY_PROJECT_RESET_MOVEMENTS)[number]);
}

/**
 * The writer's own open projects, newest statement first.
 *
 * Own entries only, and only entries strictly earlier than the day being written: a project
 * belongs to the persona who has it, and a re-run of any day must see the same archive the
 * first attempt saw.
 *
 * Completed projects stay in the ledger. A finished bookcase is exactly the thing a later
 * entry might silently put back on the workbench, and dropping it from the ledger would leave
 * that return unanchored — the failure this whole module exists to catch, one stage further on.
 */
export function buildDiaryProjectLedger(input: {
  entries: readonly DiaryEntry[];
  jurorId: string;
  /** The day being written. Entries on or after it are not part of its past. */
  before: string;
  ownEntryLookback?: number;
  maxProjects?: number;
}): DiaryProjectLedgerRow[] {
  const lookback = input.ownEntryLookback ?? DIARY_PROJECT_LEDGER.ownEntryLookback;
  const maxProjects = input.maxProjects ?? DIARY_PROJECT_LEDGER.maxProjects;

  const own = input.entries
    .filter((entry) => entry.jurorId === input.jurorId && entry.date < input.before)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, lookback);

  const rows: DiaryProjectLedgerRow[] = [];
  for (const entry of own) {
    for (const update of entry.projectUpdates) {
      if (rows.length >= maxProjects) return rows;
      // Newest first, so the first statement of a project is the current one.
      if (rows.some((row) => isSameProject(row.project, update.project))) continue;
      rows.push({
        project: update.project,
        stage: update.stage,
        movement: update.movement,
        date: entry.date
      });
    }
  }
  return rows;
}

/**
 * Projects today's entry returned to a stage the archive had already reached, without saying
 * what undid it.
 *
 * A project absent from the ledger cannot repeat: it is either new or older than the lookback,
 * and inventing a contradiction against a stage nobody can see would be guessing.
 */
export function detectRepeatedProjectStages(
  updates: readonly DiaryProjectUpdate[],
  ledger: readonly DiaryProjectLedgerRow[]
): DiaryRepeatedProjectStage[] {
  const repeats: DiaryRepeatedProjectStage[] = [];
  for (const update of updates) {
    const previous = ledger.find((row) => isSameProject(row.project, update.project));
    if (!previous) continue;
    if (!restatesStage(update.stage, previous.stage)) continue;
    if (explainsReturn(update.movement)) continue;
    repeats.push({
      project: update.project,
      stage: update.stage,
      movement: update.movement,
      previous
    });
  }
  return repeats;
}
