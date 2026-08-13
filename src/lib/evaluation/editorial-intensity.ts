import type { QualityFinding } from '../../schemas/generation-record';
import { articleProse, judgeProse, measureEditorialVoice, splitSentences } from './editorial-metrics';

/**
 * Cross-article and cross-judge intensity QA (issue #109) — deterministic, warning-only checks
 * on top of the editorial-metrics instrument, for records generated under prompt 4.6.0 or
 * later.
 *
 * `editorial-metrics.ts` measures a single article in isolation. Under prompt 4.5.0 two
 * published reviews regressed into a failure the single-article instrument cannot see:
 * "masterclass" appeared exactly once in each of three reviews inside one week (08-05, 08-09,
 * 08-10), invisible to any per-article density reading, and one of those reviews put all five
 * judges inside an 11.7–26.3 intensity-words-per-thousand band — a homogeneity the corpus-wide
 * within-article baseline was never built to flag at that height. Swiftlet's own density
 * (7.07) sat BELOW the regressed cluster; its defect was rare-superlative recurrence and
 * Marcus-only concentration, not volume, which is why density alone cannot be the check.
 *
 * Every finding here is WARNING severity, and nothing in this module may ever become an error.
 * The owner decision from issue #68 stands: a lexical gate rejects a finished article over
 * phrasing, and the INTENSITY section of the prompt — not a validator — is where the style is
 * governed. A warning is the instrument speaking where an operator reads it; it is not a
 * publication decision.
 *
 * `intensityContractApplies` gates every check on prompt 4.6.0, the version that states the
 * cross-review rarity and five-vocabularies rules in `buildEditorialPrompt` (see the
 * version-history comment there). This is #107's principle applied again: the rule the writer
 * is given and the rule the response is judged by must be one rule, so a record generated
 * before the prompt said any of this is never judged by it.
 */

export const EDITORIAL_INTENSITY_RULE_VERSION = '1.0.0';

/**
 * Whether a record's prompt version carries the intensity QA rules. 4.6.0 introduced them;
 * earlier editorial records (4.0.0–4.5.x) were generated without these instructions and are
 * never judged by rules they were not written to satisfy.
 */
export function intensityContractApplies(promptVersion: string | null | undefined): boolean {
  if (!promptVersion) return false;
  const [major, minor] = promptVersion.split('.').map(part => parseInt(part, 10));
  if (!Number.isFinite(major)) return false;
  return major > 4 || (major === 4 && Number.isFinite(minor) && minor >= 6);
}

/**
 * The peak-praise subset of INTENSITY_LEXICON — words rare enough that their recurrence across
 * judges or across consecutive reviews reads as house style rather than judgment ("masterclass"
 * once in each of three reviews in one week, observed 2026-08). Plain boosters ("highly",
 * "extremely") and mid-strength adjectives ("impressive", "massive", "remarkable", "seamless")
 * stay density-only: they are too common for cross-article recurrence to mean anything. Every
 * entry here must also be present in INTENSITY_LEXICON — the corresponding subset test in
 * editorial-intensity.test.ts pins the relationship.
 */
export const MARKED_INTENSITY_LEXICON: readonly string[] = [
  'brilliant',
  'brilliantly',
  'elite',
  'exceptional',
  'exceptionally',
  'extraordinary',
  'incredible',
  'masterclass',
  'outstanding',
  'phenomenal',
  'stellar',
  'stunning',
  'superb',
  'thrilling',
  'triumph'
];

const MARKED_SET = new Set(MARKED_INTENSITY_LEXICON);

export interface RecentReviewIntensity {
  slug: string;
  words: readonly string[];
}

function lowercaseWords(text: string): string[] {
  return text.toLowerCase().match(/[a-z][a-z'-]*/g) ?? [];
}

/** Unique marked words a string contains, lowercased, in no particular reading order. */
function markedWordsIn(text: string): string[] {
  const found = new Set<string>();
  for (const word of lowercaseWords(text)) {
    if (MARKED_SET.has(word)) found.add(word);
  }
  return [...found];
}

/**
 * Unique marked intensity words spent across the whole article — the article body plus every
 * judge's prose. Non-throwing, and [] for anything that is not shaped like V3 content: this is
 * a reader, not a validator, so an unparseable shape is "nothing spent" rather than a defect.
 */
export function collectMarkedIntensity(content: unknown): string[] {
  const root = content as any;
  if (!root || typeof root !== 'object' || !root.article || typeof root.article !== 'object' || !Array.isArray(root.judges)) {
    return [];
  }
  const prose = [articleProse(root.article), ...root.judges.map((judge: any) => judgeProse(judge))].join(' ');
  return markedWordsIn(prose).sort();
}

/**
 * Every individually addressable reader-facing string in the article body — the same fields
 * `articleProse` joins, kept separate here because the unanchored check must compare a sentence
 * only to its neighbors WITHIN the same field, never across two different bullet points or
 * sections that merely happen to sit next to each other in the joined blob.
 */
function articleTextFields(article: any): string[] {
  const fields: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') fields.push(value);
  };
  push(article?.headline);
  push(article?.standfirst);
  push(article?.jury_summary);
  if (Array.isArray(article?.where_jury_agreed)) article.where_jury_agreed.forEach(push);
  if (Array.isArray(article?.where_jury_disagreed)) article.where_jury_disagreed.forEach((entry: any) => push(entry?.summary));
  if (Array.isArray(article?.evidence_limitations)) article.evidence_limitations.forEach(push);
  push(article?.final_verdict);
  push(article?.meta_description);
  return fields;
}

/** The judge-side equivalent of `articleTextFields`, field by field rather than joined. */
function judgeTextFields(judge: any): string[] {
  const fields: string[] = [];
  const push = (value: unknown) => {
    if (typeof value === 'string' && value.trim() !== '') fields.push(value);
  };
  push(judge?.verdict);
  if (Array.isArray(judge?.strengths)) judge.strengths.forEach(push);
  if (Array.isArray(judge?.concerns)) judge.concerns.forEach(push);
  push(judge?.recommended_next_step?.action);
  if (Array.isArray(judge?.criteria)) {
    judge.criteria.forEach((criterion: any) => {
      push(criterion?.reasoning);
      if (Array.isArray(criterion?.limitations)) criterion.limitations.forEach(push);
    });
  }
  return fields;
}

/**
 * A token with an internal `.`/`_`/`/`/`-` between alphanumerics ("llama.cpp", "page-cache"),
 * or the leading-dot filename convention (".qpack", ".env") where nothing but whitespace
 * precedes the dot.
 */
const COMPOUND_TOKEN_PATTERN = /[A-Za-z0-9]+[._/-][A-Za-z0-9](?:[A-Za-z0-9._/-]*[A-Za-z0-9])?|(?:^|\s)\.[A-Za-z0-9]{2,}/;

/** A double-quoted span, straight or curly quotes. */
const QUOTED_SPAN_PATTERN = /["“][^"”]+["”]/;

/**
 * A lowercase letter immediately followed by an uppercase one ("iPhones", "macOS"). A pure
 * ALL-CAPS acronym like "AI" or "LLM" never matches this — there is no lowercase letter to
 * transition from — and deliberately anchors nothing: an acronym names a category, not the
 * specific mechanism a superlative needs beside it.
 */
const MIXED_CASE_TRANSITION_PATTERN = /[a-z][A-Z]/;

/**
 * Whether a sentence contains a concrete anchor: a digit, a compound technical token, a mixed
 * case name, or a quoted span. This is a heuristic proxy for "the reason is beside the
 * conclusion", not a parse of meaning — it will miss some real anchors (a spelled-out number,
 * a named person) and accept some hollow ones (a stray digit in an unrelated clause). It is a
 * warning precisely because of that gap: an operator reads the sentence named in the finding
 * and judges it, the way #68 always intended prose checks to work.
 */
function hasAnchor(sentence: string): boolean {
  return /\d/.test(sentence)
    || COMPOUND_TOKEN_PATTERN.test(sentence)
    || MIXED_CASE_TRANSITION_PATTERN.test(sentence)
    || QUOTED_SPAN_PATTERN.test(sentence);
}

/** One unanchored occurrence: which marked word, in which sentence. */
interface UnanchoredInstance {
  word: string;
  sentence: string;
}

/** Scans one field's text for marked words sitting in a sentence with no anchor nearby. */
function unanchoredInField(text: string): UnanchoredInstance[] {
  const sentences = splitSentences(text);
  const instances: UnanchoredInstance[] = [];
  sentences.forEach((sentence, index) => {
    const marked = markedWordsIn(sentence);
    if (marked.length === 0) return;
    const neighbors = [sentences[index - 1], sentences[index + 1]].filter((s): s is string => typeof s === 'string');
    if (hasAnchor(sentence) || neighbors.some(hasAnchor)) return;
    for (const word of marked) instances.push({ word, sentence });
  });
  return instances;
}

/** Restrained (4.5.0) reviews measured 6.37–7.07 intensity words per thousand; the regressed
 * cluster measured 13.22–17.65. 9.0 sits between the two clusters, closer to the restrained
 * side, so a review must clear a real gap — not a rounding difference — before this fires. */
const INTENSITY_DENSITY_THRESHOLD = 9.0;

/** #68's own words: one earned "brilliant" is a judgment, four of them are a house style; two
 * can be coincidence, three is a habit. */
const INTENSITY_REPEATED_WORD_THRESHOLD = 3;

/** Phone Harness put every judge between 11.67 and 26.32 intensity words per thousand;
 * smnetstudio-wechat-ai's floor was 11.36. Restrained reviews always left at least one judge
 * near zero, so a floor this high is itself the signal. Gated on a minimum total count per
 * `judgeIntensitySpread`'s own documented caveat: a rate built from one or two words per judge
 * is not a volume, so it cannot be read as uniform. */
const INTENSITY_UNIFORM_VOLUME_THRESHOLD = 8.0;
const INTENSITY_UNIFORM_VOLUME_MIN_COUNT = 10;

function warning(code: string, path: string, message: string): QualityFinding {
  return { code, path, message, severity: 'warning', ruleVersion: EDITORIAL_INTENSITY_RULE_VERSION };
}

/**
 * Collects every intensity-QA finding on editorial (V3) content. Every finding is
 * severity 'warning', at most one finding per code, aggregating however many instances that
 * code found so an operator sees the whole picture in one line rather than one finding per
 * word. Returns [] for content that is not V3-shaped, or once `measureEditorialVoice` finds
 * nothing to read.
 *
 * `recentReviews` is best-effort context from the rest of the publication (see
 * `readRecentReviewIntensity` in recent-articles.ts). Its absence is not a defect — an archive
 * that could not be listed simply means the cross-article check has nothing to compare
 * against — so `INTENSITY_CROSS_ARTICLE_WARNING` is skipped entirely rather than firing on an
 * empty or missing list.
 */
export function collectIntensityFindings(input: {
  content: unknown;
  recentReviews?: readonly RecentReviewIntensity[];
}): QualityFinding[] {
  const root = input.content as any;
  if (!root || typeof root !== 'object' || !root.article || typeof root.article !== 'object' || !Array.isArray(root.judges)) {
    return [];
  }

  const readings = measureEditorialVoice(root);
  if (!readings) return [];

  const findings: QualityFinding[] = [];

  if (readings.intensityPerThousand >= INTENSITY_DENSITY_THRESHOLD) {
    findings.push(warning(
      'INTENSITY_DENSITY_WARNING',
      '$',
      `The article carries ${readings.intensityPerThousand} intensity words per thousand, at or above the ` +
      `${INTENSITY_DENSITY_THRESHOLD} threshold that sits between the restrained 4.5.0 corpus (6.37-7.07 per ` +
      `thousand) and the regressed cluster that followed it (13.22-17.65).`
    ));
  }

  const repeatedThreeOrMore = readings.repeatedIntensity.filter(entry => entry.count >= INTENSITY_REPEATED_WORD_THRESHOLD);
  if (repeatedThreeOrMore.length > 0) {
    findings.push(warning(
      'INTENSITY_REPEATED_WORD_WARNING',
      '$',
      `${repeatedThreeOrMore.map(entry => `"${entry.word}" (${entry.count}x)`).join(', ')} repeat ` +
      `${INTENSITY_REPEATED_WORD_THRESHOLD} or more times in this article; two uses of an intensity word can be ` +
      `coincidence, three is a habit.`
    ));
  }

  const judgeWordMap = new Map<string, string[]>();
  root.judges.forEach((judge: any, index: number) => {
    const judgeId = typeof judge?.judge_id === 'string' ? judge.judge_id : `judge_${index}`;
    for (const word of markedWordsIn(judgeProse(judge))) {
      const judges = judgeWordMap.get(word) ?? [];
      judges.push(judgeId);
      judgeWordMap.set(word, judges);
    }
  });
  const convergent = [...judgeWordMap.entries()].filter(([, judges]) => new Set(judges).size >= 2);
  if (convergent.length > 0) {
    findings.push(warning(
      'INTENSITY_JUDGE_CONVERGENCE_WARNING',
      '$.judges',
      convergent.map(([word, judges]) => `"${word}" (${[...new Set(judges)].sort().join(', ')})`).join('; ') +
      ' — the same rare superlative from more than one judge in the same review reads as one generator behind ' +
      'five personas, not five independent readings.'
    ));
  }

  const allJudgesAtOrAboveFloor = readings.judges.length > 0
    && readings.judges.every(judge => judge.intensityPerThousand >= INTENSITY_UNIFORM_VOLUME_THRESHOLD);
  if (allJudgesAtOrAboveFloor && readings.intensityCount >= INTENSITY_UNIFORM_VOLUME_MIN_COUNT) {
    findings.push(warning(
      'INTENSITY_UNIFORM_VOLUME_WARNING',
      '$.judges',
      `Every judge writes at ${INTENSITY_UNIFORM_VOLUME_THRESHOLD}+ intensity words per thousand ` +
      `(${readings.judges.map(judge => `${judge.judgeId}: ${judge.intensityPerThousand}`).join(', ')}), ` +
      `${readings.intensityCount} words total; restrained reviews always left at least one judge near zero.`
    ));
  }

  if (input.recentReviews && input.recentReviews.length > 0) {
    const currentMarked = collectMarkedIntensity(root);
    const collisions = currentMarked
      .map(word => ({ word, slugs: input.recentReviews!.filter(review => review.words.includes(word)).map(review => review.slug) }))
      .filter(collision => collision.slugs.length > 0);
    if (collisions.length > 0) {
      findings.push(warning(
        'INTENSITY_CROSS_ARTICLE_WARNING',
        '$',
        collisions.map(collision => `"${collision.word}" (also in ${collision.slugs.join(', ')})`).join('; ') +
        ' already appeared in a recent review; a rare superlative repeated across the publication inside one ' +
        'week stops being a judgment about any single project.'
      ));
    }
  }

  const unanchored: UnanchoredInstance[] = [
    ...articleTextFields(root.article).flatMap(unanchoredInField),
    ...root.judges.flatMap((judge: any) => judgeTextFields(judge).flatMap(unanchoredInField))
  ];
  if (unanchored.length > 0) {
    const unique = [...new Map(unanchored.map(instance => [`${instance.word} ${instance.sentence}`, instance])).values()];
    findings.push(warning(
      'INTENSITY_UNANCHORED_WARNING',
      '$',
      unique.map(instance => `"${instance.word}" in "${instance.sentence}"`).join('; ') +
      ' — no digit, code or file token, mixed-case name, or quoted span in the sentence or its neighbors ties ' +
      'the word to a specific reason.'
    ));
  }

  return findings;
}
