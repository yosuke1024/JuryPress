import {
  DIARY_RECENT_CYCLE,
  type DiaryAbstractionLevel,
  type DiaryEntry,
  type DiaryInteractionLevel,
  type DiaryTheme
} from '../../schemas/diary';
import type { JudgeSlug } from '../../schemas/jury';

/**
 * How the diary has been spending its days — and whether the whole cycle has stopped having
 * any.
 *
 * Issue #113: Sarah's 2026-08-14 entry argues a product thesis about scope and cognitive load;
 * Marcus's 08-15 argues a venture thesis about platform leverage and rent extraction. They
 * share no subject, no object, no vocabulary and no argument, so neither #105's arc comparison
 * nor #110's centre comparison can see anything wrong with them. What they share is the *mode*:
 * a professional position stated near the top, the middle spent proving it with details from a
 * private life, a polished general principle at the end. Read alone each is articulate; read in
 * sequence they are two columnists whose private lives exist to illustrate their opinions.
 *
 * The mode is a property of the whole rotation, not of one persona, so it is measured across
 * all five diarists — which is the difference between this module and lib/diary/focus.ts. Two
 * jurors writing about their own kitchens is not a recurrence; two jurors writing an essay each
 * is the thing readers notice first.
 *
 * What this deliberately is NOT:
 *
 *   - a gate. Nothing here can fail a day (brief §14). An argument-led entry is a legitimate
 *     day and publishes like any other; the outputs are a prompt section and a warning.
 *   - a ban on professional subjects. A juror may write about their work, in their own
 *     vocabulary, every duty day. The request is that something happens while they do.
 *   - a requirement for dialogue. `direct` is one of three legal answers, not the target, and
 *     a day alone with a broken boiler can be as eventful as an argument.
 *   - a body scan. It reads only the writer's own account of its own entry, exactly as
 *     lib/diary/focus.ts and lib/diary/projects.ts do. A model that describes the day it meant
 *     to write rather than the one it wrote costs the next prompt a nudge, never a day.
 */

/** The scene half of one entry's focus: what happened, who was there, how abstract it stayed. */
export interface DiarySceneMode {
  sceneEvent: string | null;
  interactionLevel: string;
  abstractionLevel: string;
}

/** One recent entry reduced to how it spent its day, whoever wrote it. */
export interface DiarySceneGlance extends DiarySceneMode {
  jurorId: JudgeSlug;
  date: string;
  theme: DiaryTheme;
  endingState: string;
}

/** A stretch of the cycle spent arguing positions rather than living days. */
export interface DiaryEssayRun {
  /** How many of the entries counted were argument-led. */
  count: number;
  /** How many entries were counted. */
  total: number;
  /** Which diarists wrote them, newest first. The point is that it is not one persona. */
  jurorIds: JudgeSlug[];
}

/* Typed against the unions, so dropping either value from the schema fails to compile here. */
const ARGUMENT: DiaryAbstractionLevel = 'argument';
const NO_INTERACTION: DiaryInteractionLevel = 'none';

/**
 * Whether an entry, as its own writer described it, argued a position with nothing happening
 * in it.
 *
 * Both halves are required, and that is the whole judgement. `argument` alone is an ordinary
 * day — a juror is allowed to spend an evening thinking, and a reflection day whose event is
 * small is not this problem. What the issue describes is an argument with no day underneath it:
 * either nothing observable happened at all, or the only other person in it was the writer's
 * account of them.
 *
 * An unstated level is never argument-led. A pre-#113 entry, or a writer that left the field
 * blank, is a thing this cannot see rather than a thing it may assume the worst about.
 */
export function isArgumentLed(mode: DiarySceneMode): boolean {
  if (mode.abstractionLevel.trim().toLowerCase() !== ARGUMENT) return false;
  const scene = mode.sceneEvent?.trim() ?? '';
  return scene.length === 0 || mode.interactionLevel.trim().toLowerCase() === NO_INTERACTION;
}

export function countArgumentLed(modes: readonly DiarySceneMode[]): number {
  return modes.filter((mode) => isArgumentLed(mode)).length;
}

/**
 * The newest entries across all five diarists, reduced to how each spent its day.
 *
 * Strictly earlier entries only, so a re-run of any day sees the archive the first attempt saw.
 * An entry whose scene half is entirely unstated is skipped rather than shown as a row of
 * blanks: it predates issue #113 or its writer declined the fields, and either way there is
 * nothing about it to quote back.
 */
export function buildRecentSceneGlances(input: {
  entries: readonly DiaryEntry[];
  /** The day being written. Entries on or after it are not part of its past. */
  before: string;
  limit?: number;
}): DiarySceneGlance[] {
  const limit = input.limit ?? DIARY_RECENT_CYCLE.entryCount;

  return input.entries
    .filter((entry) => entry.date < input.before)
    .slice()
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((entry) => {
      const focus = entry.entryFocus;
      if (!focus) return [];
      const scene = focus.sceneEvent?.trim() ?? '';
      const interactionLevel = focus.interactionLevel.trim();
      const abstractionLevel = focus.abstractionLevel.trim();
      if (scene.length === 0 && interactionLevel.length === 0 && abstractionLevel.length === 0) {
        return [];
      }
      return [
        {
          jurorId: entry.jurorId,
          date: entry.date,
          theme: entry.theme,
          sceneEvent: scene.length > 0 ? scene : null,
          interactionLevel,
          abstractionLevel,
          endingState: focus.endingState
        }
      ];
    })
    .slice(0, limit);
}

/**
 * The run of argument-led entries in the cycle shown, or null when there is none to name.
 *
 * The threshold is a majority of one rotation (`DIARY_RECENT_CYCLE.essayRun`), counted over
 * whatever window the caller hands over — the prompt counts the five entries it is about to
 * show, and the validator counts today plus the same five. Neither can reject anything; the
 * strongest outcome is a paragraph of prompt text and a warning on the record.
 */
export function detectEssayRun(
  glances: readonly DiarySceneGlance[],
  threshold: number = DIARY_RECENT_CYCLE.essayRun
): DiaryEssayRun | null {
  const argued = glances.filter((glance) => isArgumentLed(glance));
  if (argued.length < threshold) return null;

  const jurorIds: JudgeSlug[] = [];
  for (const glance of argued) {
    if (!jurorIds.includes(glance.jurorId)) jurorIds.push(glance.jurorId);
  }
  return { count: argued.length, total: glances.length, jurorIds };
}
