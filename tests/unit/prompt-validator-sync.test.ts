import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CREATOR_ATTRIBUTION, COMMUNITY_ATTRIBUTION } from '../../src/lib/evaluation/public-claims';

/**
 * Prompt/validator synchronisation.
 *
 * The recurring false-positive source in claim provenance was a desync: the prompt states
 * the attribution requirement semantically ("the SAME sentence must attribute the creator")
 * while the validator enforces it with a pattern. When the prompt's own examples drift out
 * of what the validator accepts, the model is being taught to fail — so every attribution
 * example the prompt shows is asserted against the real pattern here.
 *
 * These are the exact strings that appear in the prompt (src/lib/evaluation/evaluator.ts);
 * the last test asserts they are still present there, so editing the prompt without
 * updating this file fails instead of silently desyncing.
 */

const PROMPT_PATH = path.join(__dirname, '..', '..', 'src', 'lib', 'evaluation', 'evaluator.ts');
const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');

/**
 * Full sentences the prompt shows verbatim as PASS examples. Each must satisfy the
 * validator, and each must still be present in the prompt (asserted below), so editing
 * one without revisiting this file fails loudly.
 */
const PROMPT_VERBATIM_EXAMPLES = [
  'According to the README, the tool may scale to enterprise workloads.',
  'According to the README, the project describes a modular architecture.',
  'According to the README, the tool converts pages to Markdown.',
  'The README reports that subsequent benchmarks did not validate the token efficiency hypothesis.',
  'The repository page indicates that the project is archived.'
];

/**
 * Wording the prompt teaches as an ellipsis fragment ("The changelog documents..."), paired
 * with a full sentence in that shape. The fragment must be in the prompt and the sentence
 * must satisfy the validator — that pairing is what proves the taught form is usable.
 */
const PROMPT_FRAGMENT_FORMS: Array<[fragment: string, sentence: string]> = [
  ['The project describes itself as', 'The project describes itself as a scraper.'],
  ['The creator states that', 'The creator states that it is experimental.'],
  ['The changelog documents', 'The changelog documents a breaking change.'],
  ['The maintainers note that', 'The maintainers note that support ended.'],
  ['The project documentation states', 'The project documentation states the API is stable.'],
  ['The repository page indicates that', 'The repository page indicates that the project is archived.']
];

const PROMPT_CREATOR_EXAMPLES = [
  ...PROMPT_VERBATIM_EXAMPLES,
  ...PROMPT_FRAGMENT_FORMS.map(([, sentence]) => sentence)
];

/** Wording the prompt presents as a FAILURE — must not satisfy the validator. */
const PROMPT_CREATOR_COUNTEREXAMPLES = [
  'The tool may scale to enterprise workloads.',
  'However, subsequent benchmarks did not validate the token efficiency hypothesis.'
];

const PROMPT_COMMUNITY_EXAMPLES = [
  'Commenters noted a packaging issue.',
  'The community discussion raised reproducibility concerns.'
];

describe('prompt/validator synchronisation — creator attribution', () => {
  it.each(PROMPT_CREATOR_EXAMPLES)('the prompt teaches an accepted form: %s', text => {
    expect(CREATOR_ATTRIBUTION.test(text)).toBe(true);
  });

  it.each(PROMPT_CREATOR_COUNTEREXAMPLES)('the prompt teaches a rejected form: %s', text => {
    expect(CREATOR_ATTRIBUTION.test(text)).toBe(false);
  });

  it.each(PROMPT_COMMUNITY_EXAMPLES)('the prompt teaches an accepted community form: %s', text => {
    expect(COMMUNITY_ATTRIBUTION.test(text)).toBe(true);
  });
});

describe('prompt content the synchronisation depends on', () => {
  it('still instructs varying the attribution wording', () => {
    expect(prompt).toMatch(/VARY that attribution wording across the article/);
  });

  it('still states that attribution is per sentence and never carries over', () => {
    expect(prompt).toMatch(/Attribution is PER SENTENCE/);
    expect(prompt).toMatch(/does NOT cover the sentences that follow it/);
  });

  it('still lists the source-noun + reporting-verb alternative, not just "According to"', () => {
    expect(prompt).toMatch(/followed by a REPORTING VERB/);
    for (const source of ['changelog', 'repository page', 'maintainers']) {
      expect(prompt).toContain(source);
    }
  });

  it('keeps every verbatim example and counterexample it shows in sync with this file', () => {
    for (const example of [...PROMPT_VERBATIM_EXAMPLES, ...PROMPT_CREATOR_COUNTEREXAMPLES]) {
      expect(prompt).toContain(example);
    }
  });

  it('still teaches each attribution fragment this file validates', () => {
    for (const [fragment] of PROMPT_FRAGMENT_FORMS) {
      expect(prompt).toContain(fragment);
    }
  });
});
