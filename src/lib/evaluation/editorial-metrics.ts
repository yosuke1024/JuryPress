/**
 * Editorial voice measurement — an instrument, never a gate.
 *
 * The published corpus showed a measurable drift when the pipeline moved from the audit-era
 * prompt to the editorial one: unsupported-intensity words rose from ~4.0 per thousand words
 * (prompt 2.x, five reviews) to ~10.6 (prompt 4.0.0, seven reviews), and every judge landed in
 * the same narrow intensity band (6.6–14.8 per thousand) even though their content vocabulary
 * barely overlapped (mean pairwise Jaccard 0.10). Five judges were picking different subjects
 * and describing all of them at the same volume, which is what makes a corpus read as one
 * generator wearing five hats.
 *
 * That is a real signal, so it is worth measuring. It is NOT worth gating on, and nothing in
 * this module may ever become a publication gate:
 *
 *   - `buildEditorialPrompt` states the rule directly: no validator may scan prose for the
 *     presence or absence of wording. That mistake is what prompt 4.x exists to end.
 *   - `recent-articles.ts` solved the sibling problem (consecutive headlines converging on one
 *     shape) by showing the writer its own last three openings rather than adding a similarity
 *     gate — for the same reason: a lexical gate rejects finished articles over phrasing.
 *   - A lexical gate is a retry engine. "brilliant" earned by the sentence around it and
 *     "brilliant" as filler are the same six letters; only the prompt can tell them apart.
 *
 * So this produces numbers, attached to the generation record and asserted in fixtures. A
 * number that moves the wrong way is a prompt bug to fix at the prompt, not an article to
 * reject. Everything here is pure, deterministic, and non-throwing.
 */

/**
 * Words that assert intensity without carrying information — the measurement instrument, not a
 * ban list. Every entry was observed repeating across the 2026-07 corpus. A word belongs here
 * when removing it from a sentence costs the reader no fact, only volume; that is why
 * "modular" and "undocumented" are absent while "masterclass" and "phenomenal" are present.
 *
 * Matched as whole words, case-insensitively. Adding an entry changes the readings, so the
 * fixture expectations move with it — deliberately, because the instrument is versioned by its
 * test.
 *
 * The plain adverbial boosters ("highly", "extremely", "truly", ...) were added in 1.1.0. The
 * first review written against prompt 4.1.0 dropped from 10.09 intensity words per thousand to
 * 6.14 while using "highly" nine times — a word the 1.0.0 lexicon did not count. Whether that
 * substitution was avoidance or coincidence does not matter: an instrument that misses the
 * writer's actual habit reports an improvement that did not happen, which is worse than not
 * measuring at all. Readings are not comparable across instrument versions.
 */
export const INTENSITY_LEXICON: readonly string[] = [
  'beautifully',
  'brilliant',
  'brilliantly',
  'deeply',
  'dramatically',
  'elite',
  'exceptional',
  'exceptionally',
  'extraordinary',
  'extremely',
  'highly',
  'hugely',
  'impressive',
  'impressively',
  'incredible',
  'incredibly',
  'massive',
  'massively',
  'masterclass',
  'perfectly',
  'phenomenal',
  'profoundly',
  'remarkable',
  'remarkably',
  'seamless',
  'seamlessly',
  'stellar',
  'stunning',
  'superb',
  'thrilling',
  'triumph',
  'truly',
  'undeniably',
  'vastly'
];

const INTENSITY_SET = new Set(INTENSITY_LEXICON);

/**
 * Function words excluded from the echo measurement. Short and deliberately generic: the point
 * is to compare what two passages are ABOUT, and a stop list tuned per project would make the
 * readings incomparable between reviews.
 */
const ECHO_STOPWORDS = new Set([
  'about', 'after', 'all', 'also', 'and', 'any', 'are', 'because', 'been', 'before', 'both',
  'but', 'can', 'could', 'does', 'each', 'even', 'for', 'from', 'had', 'has', 'have', 'how',
  'into', 'its', 'itself', 'more', 'most', 'much', 'not', 'now', 'off', 'once', 'only', 'other',
  'our', 'out', 'over', 'own', 'same', 'she', 'should', 'some', 'such', 'than', 'that', 'the',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'too', 'under',
  'until', 'very', 'was', 'were', 'what', 'when', 'where', 'which', 'while', 'who', 'will',
  'with', 'would', 'you', 'your'
]);

export interface JudgeVoiceMetrics {
  judgeId: string;
  wordCount: number;
  intensityCount: number;
  /** Intensity words per thousand words of that judge's own prose. */
  intensityPerThousand: number;
}

export interface EchoMetric {
  /** Which two passages were compared, e.g. "jury_summary~final_verdict". */
  pair: string;
  /** Content-word Jaccard overlap, 0..1. High means the two say the same thing twice. */
  jaccard: number;
}

export interface EditorialVoiceMetrics {
  /** The lexicon revision the readings were taken with, so old records stay interpretable. */
  instrumentVersion: string;
  wordCount: number;
  intensityCount: number;
  intensityPerThousand: number;
  /**
   * Intensity words used more than once in the same article, most repeated first. Issue #68's
   * first two requirements are about repetition, not presence: one earned "brilliant" is a
   * judgment, four of them are a house style.
   */
  repeatedIntensity: { word: string; count: number }[];
  judges: JudgeVoiceMetrics[];
  /**
   * Highest minus lowest per-judge intensity rate. Near zero means all five judges write at
   * one volume — the homogeneity Issue #68 describes, which content-word similarity misses
   * entirely because the judges do pick different subjects.
   *
   * Only informative when the counts are large enough to carry a rate. Once the article is
   * restrained, four judges using exactly one intensity word each produce a spread of ~6 that
   * says nothing about their registers; the first 4.1.0 review read that way while its judges
   * were, on inspection, clearly written in different voices. Read a low spread as a signal
   * only alongside a high `intensityCount`.
   */
  judgeIntensitySpread: number;
  echo: EchoMetric[];
}

/** Bumped whenever the lexicon or a formula changes; readings across versions are not comparable. */
export const EDITORIAL_METRICS_VERSION = '1.1.0';

function words(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
}

function round(value: number, places = 2): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function asText(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(asText);
  return [];
}

/** Every reader-facing string a judge wrote, in one blob. */
function judgeProse(judge: any): string {
  return [
    ...asText(judge?.verdict),
    ...asText(judge?.strengths),
    ...asText(judge?.concerns),
    ...asText(judge?.recommended_next_step?.action),
    ...(Array.isArray(judge?.criteria)
      ? judge.criteria.flatMap((c: any) => [...asText(c?.reasoning), ...asText(c?.limitations)])
      : [])
  ].join(' ');
}

/** Every reader-facing string in the article body, in one blob. */
function articleProse(article: any): string {
  return [
    ...asText(article?.headline),
    ...asText(article?.standfirst),
    ...asText(article?.jury_summary),
    ...asText(article?.where_jury_agreed),
    ...(Array.isArray(article?.where_jury_disagreed)
      ? article.where_jury_disagreed.flatMap((d: any) => asText(d?.summary))
      : []),
    ...asText(article?.evidence_limitations),
    ...asText(article?.final_verdict),
    ...asText(article?.meta_description)
  ].join(' ');
}

function contentWords(text: string): Set<string> {
  return new Set(words(text).filter(w => w.length > 2 && !ECHO_STOPWORDS.has(w)));
}

function jaccard(a: string, b: string): number {
  const setA = contentWords(a);
  const setB = contentWords(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let shared = 0;
  for (const word of setA) if (setB.has(word)) shared++;
  return shared / (setA.size + setB.size - shared);
}

function countIntensity(text: string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const word of words(text)) {
    if (INTENSITY_SET.has(word)) counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return counts;
}

/**
 * Reads voice metrics off editorial (V3) content.
 *
 * Returns null for anything that is not shaped like V3 content — audit-era records, an
 * unparseable response, a partially repaired object. Callers treat null as "not measured",
 * never as a defect: this function has no opinion about whether content is valid.
 */
export function measureEditorialVoice(content: unknown): EditorialVoiceMetrics | null {
  const root = content as any;
  if (!root || typeof root !== 'object') return null;
  if (!root.article || typeof root.article !== 'object') return null;
  if (!Array.isArray(root.judges)) return null;

  const article = root.article;
  const judgeTexts: { judgeId: string; prose: string }[] = root.judges.map((judge: any, index: number) => ({
    judgeId: typeof judge?.judge_id === 'string' ? judge.judge_id : `judge_${index}`,
    prose: judgeProse(judge)
  }));

  const wholeArticle = [articleProse(article), ...judgeTexts.map(j => j.prose)].join(' ');
  const totalWords = words(wholeArticle).length;
  const totalIntensity = countIntensity(wholeArticle);
  const intensityCount = [...totalIntensity.values()].reduce((sum, n) => sum + n, 0);

  const judges: JudgeVoiceMetrics[] = judgeTexts.map(({ judgeId, prose }) => {
    const judgeWords = words(prose).length;
    const judgeIntensity = [...countIntensity(prose).values()].reduce((sum, n) => sum + n, 0);
    return {
      judgeId,
      wordCount: judgeWords,
      intensityCount: judgeIntensity,
      intensityPerThousand: judgeWords === 0 ? 0 : round((judgeIntensity / judgeWords) * 1000)
    };
  });

  const rates = judges.map(j => j.intensityPerThousand);

  return {
    instrumentVersion: EDITORIAL_METRICS_VERSION,
    wordCount: totalWords,
    intensityCount,
    intensityPerThousand: totalWords === 0 ? 0 : round((intensityCount / totalWords) * 1000),
    repeatedIntensity: [...totalIntensity.entries()]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([word, count]) => ({ word, count })),
    judges,
    judgeIntensitySpread: rates.length === 0 ? 0 : round(Math.max(...rates) - Math.min(...rates)),
    echo: [
      { pair: 'jury_summary~final_verdict', jaccard: round(jaccard(asText(article.jury_summary).join(' '), asText(article.final_verdict).join(' '))) },
      { pair: 'standfirst~jury_summary', jaccard: round(jaccard(asText(article.standfirst).join(' '), asText(article.jury_summary).join(' '))) },
      { pair: 'headline~standfirst', jaccard: round(jaccard(asText(article.headline).join(' '), asText(article.standfirst).join(' '))) }
    ]
  };
}
