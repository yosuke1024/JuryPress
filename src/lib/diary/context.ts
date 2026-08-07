import type { JudgeProfile, JudgeSlug } from '../../schemas/jury';
import type { DiaryEntry, DiaryEventCategory, DiaryTheme } from '../../schemas/diary';
import type { DiaryJurorStates, DiaryMemory } from '../../schemas/diary-state';
import { readAllDiaryEntries } from './entry-store';
import { listReviewSlugs, readRecentReviews, type DiaryReviewSummary } from './review-context';
import { selectReadingTarget, type DiaryReadingTarget } from './reading';

/**
 * Assembles what today's juror is allowed to remember.
 *
 * The whole diary body is never re-fed to the model. Instead the context is a selection:
 * current state, the juror's own last entry, a glance at what the others have been writing,
 * how the newest entries opened and closed, anything recently said about them, and the
 * memories that earned their place by importance.
 * That keeps one request affordable on a free tier and, more importantly, makes forgetting a
 * real property of these personas rather than an accident of a context limit (brief §9).
 *
 * Review context is included only on days whose theme actually involves work. On a private day
 * the model is given no articles at all — the surest way to stop a diary from turning back
 * into a review summary is to not put the reviews in front of it (brief §7.1).
 */

export const DIARY_CONTEXT_BUDGET = {
  /** The juror's own previous entry, the one continuity anchor that gets real space. */
  ownPreviousEntryChars: 2000,
  peerEntryExcerptChars: 280,
  mentionExcerptChars: 240,
  peerEntryCount: 4,
  mentionCount: 3,
  mentionSearchDepth: 12,
  /**
   * Arc glances: the newest entries across all five diarists, own included, each reduced to
   * its first and last sentences. Six covers a full rotation plus one, so the juror always
   * sees every diarist's latest shape and at least one of their own.
   */
  arcGlanceCount: 6,
  arcOpeningChars: 220,
  arcClosingChars: 220,
  topMemoriesByImportance: 8,
  recentMemories: 3,
  reviewCount: 3,
  reviewVerdictChars: 400
} as const;

export interface DiaryPeerGlance {
  jurorId: JudgeSlug;
  date: string;
  title: string;
  mood: string;
  excerpt: string;
}

export interface DiaryMention {
  jurorId: JudgeSlug;
  date: string;
  excerpt: string;
}

/**
 * One recent entry reduced to how it opened and how it closed — the two places where the
 * repeated arc issue #105 describes (private prop → professional metaphor → tidy lesson) is
 * visible. Peer glances cannot serve this purpose: they excerpt only the start of a body, so
 * a model reading them sees how everyone opens and never how everyone ends.
 */
export interface DiaryArcGlance {
  jurorId: JudgeSlug;
  date: string;
  theme: DiaryTheme;
  opening: string;
  closing: string;
}

export interface DiaryContext {
  juror: JudgeProfile;
  date: string;
  theme: DiaryTheme;
  privateEventCategory: DiaryEventCategory | null;
  states: DiaryJurorStates;
  ownPreviousEntry: { date: string; title: string; body: string } | null;
  peerGlances: DiaryPeerGlance[];
  /** Openings and closings of the newest entries, all diarists, so today can be shaped unlike them. */
  recentArcs: DiaryArcGlance[];
  mentionsOfSelf: DiaryMention[];
  /** The entry this juror was given to read in full today, on relationship days. */
  readingTarget: DiaryReadingTarget | null;
  memories: DiaryMemory[];
  reviews: DiaryReviewSummary[];
  /** Slugs the model may cite. Anything else is dropped by the validator. */
  allowedReviewSlugs: string[];
}

function truncate(text: string, limit: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  return `${trimmed.slice(0, limit).trimEnd()}…`;
}

/** End-of-sentence punctuation, tolerating a closing quote or bracket after it. */
const SENTENCE_END = /[.!?…]["”’')\]]*(?=\s|$)/g;

/** Index just past each sentence end, in order. */
function sentenceEnds(text: string): number[] {
  const ends: number[] = [];
  for (const match of text.matchAll(SENTENCE_END)) {
    ends.push((match.index ?? 0) + match[0].length);
  }
  return ends;
}

/**
 * The leading whole sentences that fit within `limit` — the entry's opening device. Falls
 * back to a hard truncation when the first sentence alone is longer than the limit.
 */
export function extractOpening(body: string, limit: number): string {
  const text = body.trim();
  if (text.length <= limit) return text;
  let cut = 0;
  for (const end of sentenceEnds(text)) {
    if (end > limit) break;
    cut = end;
  }
  if (cut === 0) return `${text.slice(0, limit).trimEnd()}…`;
  return text.slice(0, cut);
}

/**
 * The trailing whole sentences that fit within `limit` — how the entry chose to end, which
 * is where the tidy-lesson habit lives. Falls back to a hard truncation that keeps the end.
 */
export function extractClosing(body: string, limit: number): string {
  const text = body.trim();
  if (text.length <= limit) return text;
  for (const end of sentenceEnds(text)) {
    if (end >= text.length) break;
    const tail = text.slice(end).trimStart();
    if (tail.length > 0 && tail.length <= limit) return tail;
  }
  return `…${text.slice(text.length - limit).trimStart()}`;
}

/** True when the theme has a work component, and review context is therefore relevant. */
export function themeUsesReviewContext(theme: DiaryTheme): boolean {
  return theme === 'work' || theme === 'mixed';
}

export function selectMemories(states: DiaryJurorStates): DiaryMemory[] {
  const all = states.memories.state.memories;

  const byImportance = [...all]
    .sort((a, b) =>
      b.importance === a.importance ? b.createdOn.localeCompare(a.createdOn) : b.importance - a.importance
    )
    .slice(0, DIARY_CONTEXT_BUDGET.topMemoriesByImportance);

  const byRecency = [...all]
    .sort((a, b) => b.createdOn.localeCompare(a.createdOn))
    .slice(0, DIARY_CONTEXT_BUDGET.recentMemories);

  const selected: DiaryMemory[] = [];
  const seen = new Set<string>();
  for (const memory of [...byImportance, ...byRecency]) {
    if (seen.has(memory.id)) continue;
    seen.add(memory.id);
    selected.push(memory);
  }
  return selected;
}

export function buildDiaryContext(input: {
  contentRoot: string;
  juror: JudgeProfile;
  date: string;
  theme: DiaryTheme;
  privateEventCategory: DiaryEventCategory | null;
  states: DiaryJurorStates;
  /** Injectable so tests and the CLI can share one archive read. */
  entries?: DiaryEntry[];
}): DiaryContext {
  const { contentRoot, juror, date, theme } = input;
  const entries = input.entries ?? readAllDiaryEntries(contentRoot);

  // Strictly earlier days only: a re-run must see the same past as the first attempt, and an
  // entry for today would mean this day is already written.
  const past = entries.filter((entry) => entry.date < date);

  const ownPrevious = past.find((entry) => entry.jurorId === juror.slug) ?? null;

  const peerGlances: DiaryPeerGlance[] = [];
  const seenPeers = new Set<string>();
  for (const entry of past) {
    if (entry.jurorId === juror.slug || seenPeers.has(entry.jurorId)) continue;
    seenPeers.add(entry.jurorId);
    peerGlances.push({
      jurorId: entry.jurorId,
      date: entry.date,
      title: entry.title.en,
      mood: entry.mood.en,
      excerpt: truncate(entry.body.en, DIARY_CONTEXT_BUDGET.peerEntryExcerptChars)
    });
    if (peerGlances.length >= DIARY_CONTEXT_BUDGET.peerEntryCount) break;
  }

  // Newest entries regardless of author — the duty juror's own included, because the repeated
  // arc is a property of the whole diary, not of any one persona (issue #105).
  const recentArcs: DiaryArcGlance[] = past
    .slice(0, DIARY_CONTEXT_BUDGET.arcGlanceCount)
    .map((entry) => ({
      jurorId: entry.jurorId,
      date: entry.date,
      theme: entry.theme,
      opening: extractOpening(entry.body.en, DIARY_CONTEXT_BUDGET.arcOpeningChars),
      closing: extractClosing(entry.body.en, DIARY_CONTEXT_BUDGET.arcClosingChars)
    }));

  const mentionsOfSelf: DiaryMention[] = [];
  const namePattern = new RegExp(`\\b${escapeRegExp(juror.name)}\\b`);
  for (const entry of past.slice(0, DIARY_CONTEXT_BUDGET.mentionSearchDepth)) {
    if (entry.jurorId === juror.slug) continue;
    const match = namePattern.exec(entry.body.en);
    if (!match) continue;
    mentionsOfSelf.push({
      jurorId: entry.jurorId,
      date: entry.date,
      excerpt: extractAround(entry.body.en, match.index, DIARY_CONTEXT_BUDGET.mentionExcerptChars)
    });
    if (mentionsOfSelf.length >= DIARY_CONTEXT_BUDGET.mentionCount) break;
  }

  const readingTarget = selectReadingTarget({
    date,
    jurorId: juror.slug,
    jurorName: juror.name,
    theme,
    entries: past
  });

  const reviews = themeUsesReviewContext(theme)
    ? readRecentReviews(contentRoot, juror.slug, DIARY_CONTEXT_BUDGET.reviewCount).map((review) => ({
        ...review,
        jurorVerdict: review.jurorVerdict
          ? truncate(review.jurorVerdict, DIARY_CONTEXT_BUDGET.reviewVerdictChars)
          : null
      }))
    : [];

  return {
    juror,
    date,
    theme,
    privateEventCategory: input.privateEventCategory,
    states: input.states,
    ownPreviousEntry: ownPrevious
      ? {
          date: ownPrevious.date,
          title: ownPrevious.title.en,
          body: truncate(ownPrevious.body.en, DIARY_CONTEXT_BUDGET.ownPreviousEntryChars)
        }
      : null,
    peerGlances,
    recentArcs,
    mentionsOfSelf,
    readingTarget,
    memories: selectMemories(input.states),
    reviews,
    // Validated against every published review, not only the ones offered: the requirement is
    // that a link resolves, and any real slug does.
    allowedReviewSlugs: listReviewSlugs(contentRoot)
  };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractAround(text: string, index: number, span: number): string {
  const start = Math.max(0, index - Math.floor(span / 3));
  return truncate(text.slice(start, start + span), span);
}
