/**
 * Client-side analytics for JuryDiary.
 *
 * Runs in the browser, so this module must stay free of node imports.
 *
 * Events are pushed onto `dataLayer` rather than calling `gtag` directly, because GA is loaded
 * inside a Partytown worker (see Layout.astro) and `dataLayer.push` is the one channel the
 * worker forwards. When GA is not configured the push simply lands in an array nobody reads,
 * which is the intended no-op — there is no separate analytics backend and no user id here.
 *
 * The questions these are meant to answer later: which juror people come back for, whether
 * English and Japanese readers prefer different personas, and which single sentence travelled
 * furthest (brief §22, §24).
 */

export const DIARY_ANALYTICS_EVENTS = {
  view: 'jury_diary_view',
  share: 'jury_diary_share',
  quoteCopy: 'jury_diary_quote_copy',
  languageChange: 'jury_diary_language_change',
  relatedReviewClick: 'jury_diary_related_review_click',
  jurorArchiveView: 'jury_diary_juror_archive_view'
} as const;

export type DiaryAnalyticsEvent =
  (typeof DIARY_ANALYTICS_EVENTS)[keyof typeof DIARY_ANALYTICS_EVENTS];

export interface DiaryAnalyticsParams {
  juror_slug?: string;
  theme?: string;
  language?: 'en' | 'ja';
  entry_date?: string;
  method?: string;
}

export function trackDiaryEvent(
  eventName: DiaryAnalyticsEvent | string,
  params: DiaryAnalyticsParams = {}
): void {
  if (typeof window === 'undefined') return;
  const scope = window as unknown as { dataLayer?: unknown[] };
  scope.dataLayer = scope.dataLayer || [];
  // gtag.js reads array-like command entries from the queue; this is the same shape
  // `gtag('event', name, params)` would push.
  scope.dataLayer.push(['event', eventName, params]);
}
