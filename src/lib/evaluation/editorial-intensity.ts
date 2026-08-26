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
 *
 * Issue #128 added the path-carrying field enumerators and the word/anchor scanners to this
 * module's exports so the publication-time repair (generation/intensity-repair.ts) can name the
 * exact fields a warning is about. Nothing here changed in what it FINDS, and nothing here
 * changed in severity: the repair reads these findings, it does not create a new class of them,
 * and an unrepaired article still publishes with its warnings.
 */

/**
 * 1.0.0: initial cross-article and cross-judge intensity QA (issue #109).
 * 1.1.0: MARKED_INTENSITY_LEXICON gains "elegant"/"elegantly" and "masterful"/"masterfully"
 *        (issue #128, the 2026-08-26 regression — GooeyPi, zcomplete, OCR It). GooeyPi's
 *        "uniquely elegant" and OCR It's "incredibly elegant" now share a marked word, and OCR
 *        It's "a masterful design paradigm" — the single clearest unanchored, unearned
 *        superlative in that corpus — now reaches the unanchored and cross-article checks at
 *        all. "excellent" joins INTENSITY_LEXICON in the same change but stays density-only
 *        here: it is common enough (six uses across two judges in one review) that its
 *        recurrence across judges or across a week of reviews would not read as house style the
 *        way a genuinely rare word does, which is this list's own bar. "robust", "significant",
 *        "rigorous", "major", "notably", and "defensive" — six more words the issue cites for
 *        these same three reviews — were considered and rejected for the identical reason
 *        INTENSITY_LEXICON's 1.3.0 note gives: they are ordinary technical-review vocabulary
 *        that costs the reader real information if removed, not unsupported intensity, and
 *        banning them would violate acceptance criterion 5. No generation-prompt version bump
 *        accompanies this change: prompt 4.6.0's INTENSITY section already states its rule
 *        generically, over "a strong evaluative word," with examples — it was never a fixed
 *        word list the writer was given — so a wider MARKED_INTENSITY_LEXICON teaches this
 *        instrument to read more of the same rule the writer already has, never a new rule the
 *        writer was not told about. #107's one-rule principle stays intact, and the
 *        `EDITORIAL_INTENSITY_RULE_VERSION` stamp on every finding keeps old readings
 *        interpretable against the lexicon that produced them.
 */
export const EDITORIAL_INTENSITY_RULE_VERSION = '1.1.0';

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
 *
 * "elegant"/"elegantly" and "masterful"/"masterfully" joined in 1.1.0 (issue #128): three
 * reviews published within one week of 2026-08-26 (GooeyPi, zcomplete, OCR It) used "elegant" as
 * their headline peak-praise word — GooeyPi's "uniquely elegant" and OCR It's "incredibly
 * elegant" — the exact cross-article recurrence this list exists to catch, and OCR It separately
 * called a design choice "a masterful design paradigm" with no mechanism beside it, the same
 * register as the already-marked "masterclass" that motivated this list in the first place.
 * "excellent" was added to INTENSITY_LEXICON in the same change but deliberately left out of
 * this list: it is common enough (six uses across two judges in one zcomplete review alone) that
 * its repetition would not read as a rare superlative being spent twice, only as an ordinary
 * word being used often — see EDITORIAL_INTENSITY_RULE_VERSION's 1.1.0 note above for the full
 * account, including the six ordinary technical words (robust, significant, rigorous, major,
 * notably, defensive) that were considered and rejected for both lexicons.
 */
export const MARKED_INTENSITY_LEXICON: readonly string[] = [
  'brilliant',
  'brilliantly',
  'elegant',
  'elegantly',
  'elite',
  'exceptional',
  'exceptionally',
  'extraordinary',
  'incredible',
  'masterclass',
  'masterful',
  'masterfully',
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

/**
 * Unique marked words a string contains, lowercased, in no particular reading order.
 *
 * Exported for the publication-time repair (issue #128), which has to know WHICH words a
 * specific field spent before it can ask for that field — and only that field — to be rewritten.
 * Deriving the offending words by re-running this scanner over the content is the only honest
 * way to do it: the alternative, parsing them back out of a finding's human-readable message,
 * would make the message text a machine interface and break the moment someone improves the
 * wording of a warning.
 */
export function markedWordsIn(text: string): string[] {
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
 * One reader-facing string, addressed by the dotted path that reaches it.
 *
 * The path form is deliberately the one `getFieldValue`/`setFieldValue` already speak
 * (`article.headline`, `judges.2.strengths.0`, `judges.0.criteria.3.reasoning`) rather than the
 * `$.`-prefixed JSONPath a QualityFinding carries. A finding's path is for a human to read; this
 * one has to be writable, because issue #128's repair rewrites exactly these fields and nothing
 * else. Keeping the two forms distinct is what stops a display string from being mistaken for an
 * address.
 */
export interface IntensityTextField {
  path: string;
  text: string;
}

function pushField(fields: IntensityTextField[], path: string, value: unknown): void {
  if (typeof value === 'string' && value.trim() !== '') fields.push({ path, text: value });
}

/**
 * Every individually addressable reader-facing string in the article body — the same fields
 * `articleProse` joins, kept separate here because the unanchored check must compare a sentence
 * only to its neighbors WITHIN the same field, never across two different bullet points or
 * sections that merely happen to sit next to each other in the joined blob.
 */
export function articleTextFields(article: any): IntensityTextField[] {
  const fields: IntensityTextField[] = [];
  pushField(fields, 'article.headline', article?.headline);
  pushField(fields, 'article.standfirst', article?.standfirst);
  pushField(fields, 'article.jury_summary', article?.jury_summary);
  if (Array.isArray(article?.where_jury_agreed)) {
    article.where_jury_agreed.forEach((value: unknown, index: number) =>
      pushField(fields, `article.where_jury_agreed.${index}`, value));
  }
  if (Array.isArray(article?.where_jury_disagreed)) {
    article.where_jury_disagreed.forEach((entry: any, index: number) =>
      pushField(fields, `article.where_jury_disagreed.${index}.summary`, entry?.summary));
  }
  if (Array.isArray(article?.evidence_limitations)) {
    article.evidence_limitations.forEach((value: unknown, index: number) =>
      pushField(fields, `article.evidence_limitations.${index}`, value));
  }
  pushField(fields, 'article.final_verdict', article?.final_verdict);
  pushField(fields, 'article.meta_description', article?.meta_description);
  return fields;
}

/** The judge-side equivalent of `articleTextFields`, field by field rather than joined. */
export function judgeTextFields(judge: any, judgeIndex: number): IntensityTextField[] {
  const fields: IntensityTextField[] = [];
  const base = `judges.${judgeIndex}`;
  pushField(fields, `${base}.verdict`, judge?.verdict);
  if (Array.isArray(judge?.strengths)) {
    judge.strengths.forEach((value: unknown, index: number) => pushField(fields, `${base}.strengths.${index}`, value));
  }
  if (Array.isArray(judge?.concerns)) {
    judge.concerns.forEach((value: unknown, index: number) => pushField(fields, `${base}.concerns.${index}`, value));
  }
  pushField(fields, `${base}.recommended_next_step.action`, judge?.recommended_next_step?.action);
  if (Array.isArray(judge?.criteria)) {
    judge.criteria.forEach((criterion: any, criterionIndex: number) => {
      pushField(fields, `${base}.criteria.${criterionIndex}.reasoning`, criterion?.reasoning);
      if (Array.isArray(criterion?.limitations)) {
        criterion.limitations.forEach((value: unknown, index: number) =>
          pushField(fields, `${base}.criteria.${criterionIndex}.limitations.${index}`, value));
      }
    });
  }
  return fields;
}

/**
 * Every reader-facing string the intensity checks read, across the article body and all five
 * judges, each with the path that addresses it. Non-throwing and [] for anything that is not
 * V3-shaped, for the same reason `collectMarkedIntensity` is: this is a reader, not a validator.
 *
 * This is the enumeration the repair rewrites against, and it is deliberately the SAME
 * enumeration the warnings are computed from. A repair that could reach a field the checks never
 * read would be editing prose nothing complained about.
 */
export function intensityTextFields(content: unknown): IntensityTextField[] {
  const root = content as any;
  if (!root || typeof root !== 'object' || !root.article || typeof root.article !== 'object' || !Array.isArray(root.judges)) {
    return [];
  }
  return [
    ...articleTextFields(root.article),
    ...root.judges.flatMap((judge: any, index: number) => judgeTextFields(judge, index))
  ];
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
export function hasAnchor(sentence: string): boolean {
  return /\d/.test(sentence)
    || COMPOUND_TOKEN_PATTERN.test(sentence)
    || MIXED_CASE_TRANSITION_PATTERN.test(sentence)
    || QUOTED_SPAN_PATTERN.test(sentence);
}

/** One unanchored occurrence: which marked word, in which sentence. */
export interface UnanchoredInstance {
  word: string;
  sentence: string;
}

/**
 * Scans one field's text for marked words sitting in a sentence with no anchor nearby.
 *
 * Exported alongside `hasAnchor` for the same reason as `markedWordsIn`: the repair (issue #128)
 * must be able to tell an operator, and the writer, exactly which sentence in which field is
 * missing its reason — and it must derive that from the content, never from a warning's prose.
 */
export function unanchoredInField(text: string): UnanchoredInstance[] {
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
 * can be coincidence, three is a habit. Exported so the repair (issue #128) selects the same
 * words this warning names — two modules with two thresholds would let the repair rewrite a
 * field for a habit the warning does not consider one, or leave one it does. */
export const INTENSITY_REPEATED_WORD_THRESHOLD = 3;

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

  const unanchored: UnanchoredInstance[] = intensityTextFields(root)
    .flatMap(field => unanchoredInField(field.text));
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
