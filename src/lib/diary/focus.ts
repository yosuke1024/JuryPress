import type { DiaryEntryFocus } from '../../schemas/diary';

/**
 * Whether a juror is about to put the same thing at the centre of a third consecutive entry.
 *
 * Issue #110: Alex's 2026-08-01, 08-06 and 08-11 entries all turned on the Hermes Baby ribbon
 * and the same friction-versus-practicality thesis. Nothing had regressed — the newest of the
 * three was the best written — but continuity context kept re-electing one object and one
 * argument as the centre of the story, and a persona whose every day is about the same thing
 * stops accumulating and starts looping.
 *
 * What this deliberately is NOT:
 *
 *   - a ban list. No noun is forbidden. The typewriter, friction, the hobbies and the replies
 *     are Alex's, permanently, and the only thing this affects is prompt wording.
 *   - a gate. Nothing here can fail a day. The strongest outcome is a paragraph asking for a
 *     different centre, which the model is free to answer with "the subject changed, here is
 *     how" (brief §14: publication is decided by structure alone).
 *   - a body scan. It reads only the four `entryFocus` fields — the writer's own account of
 *     what its entry was *about*. A typewriter mentioned in passing in the prose is invisible
 *     here, which is the point: the issue is the same subject being central twice, not the same
 *     word appearing twice. Comparing bodies would flag exactly the background continuity this
 *     is meant to protect.
 */

/** Shortest token worth comparing. Below this, matches are grammar rather than subject. */
const MIN_TERM_LENGTH = 3;

/**
 * Words that recur across any two diary entries regardless of subject. Matching on these would
 * report a recurrence for every pair of days, and an alarm that is always on is ignored.
 */
const STOP_TERMS = new Set([
  'the', 'and', 'but', 'for', 'with', 'without', 'from', 'into', 'onto', 'over', 'under',
  'about', 'after', 'before', 'between', 'during', 'while', 'than', 'then', 'that', 'this',
  'these', 'those', 'there', 'here', 'what', 'when', 'which', 'who', 'whom', 'whose', 'why',
  'how', 'not', 'nothing', 'something', 'anything', 'everything', 'someone', 'anyone',
  'are', 'was', 'were', 'been', 'being', 'has', 'have', 'had', 'does', 'did', 'doing',
  'can', 'could', 'will', 'would', 'should', 'may', 'might', 'must',
  'his', 'her', 'hers', 'its', 'their', 'theirs', 'our', 'ours', 'your', 'yours', 'mine',
  'him', 'she', 'they', 'them', 'you', 'own', 'self',
  'all', 'any', 'both', 'each', 'more', 'most', 'much', 'many', 'some', 'few', 'one', 'two',
  'very', 'just', 'still', 'again', 'also', 'only', 'even', 'ever', 'never', 'yet',
  'day', 'days', 'today', 'tonight', 'night', 'morning', 'evening', 'week', 'weekend',
  'entry', 'diary', 'thing', 'things', 'way', 'time', 'times', 'bit', 'lot', 'kind', 'sort'
]);

/**
 * The subject terms of one focus: what the entry was about and what object it hung on. Kept
 * separate from the tension terms because the two answer different questions, and an entry
 * that changes its subject while keeping its argument is a different (milder) kind of repeat
 * from one that changes neither.
 */
function subjectTerms(focus: DiaryEntryFocus): Map<string, string> {
  return termsOf(`${focus.dominantSubject} ${focus.anchorObject ?? ''}`);
}

function tensionTerms(focus: DiaryEntryFocus): Map<string, string> {
  return termsOf(focus.centralTension);
}

/**
 * Comparable terms of a phrase, keyed by a folded form and valued by the word as written.
 *
 * The two halves are separate because they are read by different audiences. Matching wants
 * "ribbons" and "ribbon" to be one subject, so the key is folded. The prompt then quotes the
 * shared terms back to the writer, and a fold is not something to say out loud: the plural
 * rule turns "Hermes" into "herme", which matches perfectly well and reads like a typo in an
 * instruction. So the surface form is kept and the stem never leaves this module.
 */
export function termsOf(text: string): Map<string, string> {
  const terms = new Map<string, string>();
  for (const raw of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < MIN_TERM_LENGTH) continue;
    const key = singularize(raw);
    if (key.length < MIN_TERM_LENGTH || STOP_TERMS.has(key)) continue;
    if (!terms.has(key)) terms.set(key, raw);
  }
  return terms;
}

/** Plural folding only, never real stemming: "ribbons"→"ribbon", but "friction" is left alone. */
function singularize(term: string): string {
  if (term.length > 4 && term.endsWith('ies')) return `${term.slice(0, -3)}y`;
  if (term.length > 4 && term.endsWith('ses')) return term.slice(0, -2);
  if (term.length > 3 && term.endsWith('s') && !term.endsWith('ss')) return term.slice(0, -1);
  return term;
}

/** Shared terms, worded as the newest entry worded them. */
function intersect(newest: Map<string, string>, previous: Map<string, string>): string[] {
  return [...newest].filter(([key]) => previous.has(key)).map(([, surface]) => surface);
}

/**
 * What two consecutive entries had in common at their centre. Either half may be empty: a
 * juror can keep the same subject while the argument moves on, or keep arguing the same thing
 * about a different subject, and the prompt says which of the two happened.
 */
export interface RecurringFocus {
  /** Terms central to the subject or anchor object of both entries. */
  sharedSubjectTerms: string[];
  /** Terms central to the tension or thesis of both entries. */
  sharedTensionTerms: string[];
}

/**
 * The recurrence in the writer's own last entries, or null when there is none to report.
 *
 * Fewer than two focus records is not a recurrence — it is an archive that has not accumulated
 * one yet, which is also the state of every juror on the day this ships, since entries written
 * before `entryFocus` existed carry none.
 */
export function detectRecurringFocus(focuses: readonly DiaryEntryFocus[]): RecurringFocus | null {
  if (focuses.length < 2) return null;

  const [newest, previous] = focuses;
  const sharedSubjectTerms = intersect(subjectTerms(newest), subjectTerms(previous));
  const sharedTensionTerms = intersect(tensionTerms(newest), tensionTerms(previous));

  if (sharedSubjectTerms.length === 0 && sharedTensionTerms.length === 0) return null;
  return { sharedSubjectTerms, sharedTensionTerms };
}
