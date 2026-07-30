import crypto from 'node:crypto';
import {
  DIARY_EVENT_CATEGORIES,
  DIARY_THEME_WEIGHTS,
  type DiaryEventCategory,
  type DiaryTheme
} from '../../schemas/diary';

/**
 * What today's diary is about.
 *
 * The theme is chosen by code and handed to Gemini, never chosen by Gemini. Two reasons:
 * a model asked to pick its own subject drifts back to work every time — which is exactly the
 * failure mode the brief calls out (§7.1) — and a code-side choice can be made deterministic.
 *
 * Determinism here is the resume contract. The seed is (date, juror), so re-running a day
 * after a crash produces the same brief as the first attempt, and a diary regenerated from a
 * stored response is never inconsistent with the theme recorded alongside it.
 */

function unitHash(seed: string): number {
  // Top 32 bits of the digest, scaled into [0, 1). Uniform enough for a five-way weighted
  // choice, and stable across platforms and Node versions in a way Math.random can never be.
  const digest = crypto.createHash('sha256').update(seed).digest('hex');
  return parseInt(digest.slice(0, 8), 16) / 0x1_0000_0000;
}

export function resolveTheme(date: string, jurorId: string): DiaryTheme {
  const roll = unitHash(`diary-theme:${date}:${jurorId}`);
  let cumulative = 0;
  for (const [theme, weight] of DIARY_THEME_WEIGHTS) {
    cumulative += weight;
    if (roll < cumulative) return theme;
  }
  // Only reachable through floating-point drift in the cumulative sum; the final bucket owns
  // the remainder by definition.
  return DIARY_THEME_WEIGHTS[DIARY_THEME_WEIGHTS.length - 1][0];
}

/**
 * An everyday-life category, given only on days that actually have a private component. On a
 * work, relationship or reflection day it is null: handing the model a domestic prompt it was
 * not asked to use is how a diary ends up mentioning a burnt dinner in every entry.
 */
export function resolveEventCategory(
  date: string,
  jurorId: string,
  theme: DiaryTheme
): DiaryEventCategory | null {
  if (theme !== 'private' && theme !== 'mixed') return null;
  const digest = crypto.createHash('sha256').update(`diary-event:${date}:${jurorId}`).digest('hex');
  const index = parseInt(digest.slice(0, 8), 16) % DIARY_EVENT_CATEGORIES.length;
  return DIARY_EVENT_CATEGORIES[index];
}

export interface DiaryDailyBrief {
  theme: DiaryTheme;
  privateEventCategory: DiaryEventCategory | null;
}

export function resolveDailyBrief(date: string, jurorId: string): DiaryDailyBrief {
  const theme = resolveTheme(date, jurorId);
  return { theme, privateEventCategory: resolveEventCategory(date, jurorId, theme) };
}
