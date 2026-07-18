import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { CREATOR_ATTRIBUTION, COMMUNITY_ATTRIBUTION } from '../../src/lib/evaluation/public-claims';

/**
 * Prompt/validator synchronisation.
 *
 * The recurring false-positive source in claim provenance is a desync: the prompt states
 * the attribution requirement semantically ("the SAME sentence must attribute the creator")
 * while the validator enforces it with a pattern. Both of the pipeline's quality failures
 * came from that gap. When the prompt's own examples drift outside what the validator
 * accepts, the model is being taught to fail.
 *
 * So every attribution example the prompt shows is asserted against the real patterns here,
 * and the prompt is asserted to still contain them — editing either side without the other
 * fails loudly instead of drifting silently.
 *
 * This file deliberately only LOCKS the existing contract; it does not ask the prompt to say
 * anything new. An attempt to also teach varied wording (prompt 2.2.0) was reverted after it
 * shifted support_mode selection — see the revert commit for the measurements.
 */

const PROMPT_PATH = path.join(__dirname, '..', '..', 'src', 'lib', 'evaluation', 'evaluator.ts');
const prompt = fs.readFileSync(PROMPT_PATH, 'utf8');

/** Full sentences the prompt shows verbatim as PASS examples for CREATOR evidence. */
const PROMPT_VERBATIM_PASS = [
  'According to the README, the tool may scale to enterprise workloads.',
  'According to the README, the project describes a modular architecture.'
];

/** Wording the prompt shows verbatim as a FAILURE — must not satisfy the validator. */
const PROMPT_VERBATIM_FAIL = [
  'The tool may scale to enterprise workloads.'
];

/**
 * A prompt PASS example that cites api_metadata (confirmed_fact), not creator evidence, so
 * it deliberately carries NO creator attribution. Asserted only for presence: matching
 * CREATOR_ATTRIBUTION is neither required nor expected of it.
 */
const PROMPT_NON_CREATOR_PASS = [
  'The API metadata reports strong adoption.'
];

/**
 * Attribution wording the prompt teaches as an ellipsis fragment ("The creator states..."),
 * paired with a full sentence in that shape: the fragment must be in the prompt and the
 * sentence must satisfy the validator, which is what proves the taught form is usable.
 */
const PROMPT_FRAGMENT_FORMS: Array<[fragment: string, sentence: string]> = [
  ['The project describes itself as', 'The project describes itself as a scraper.'],
  ['According to the README', 'According to the README, the tool converts pages.'],
  ['The creator states that', 'The creator states that it is experimental.'],
  ['The project documentation states', 'The project documentation states the API is stable.']
];

const PROMPT_COMMUNITY_FORMS: Array<[fragment: string, sentence: string]> = [
  ['Commenters noted', 'Commenters noted a packaging issue.'],
  ['The community discussion raised', 'The community discussion raised reproducibility concerns.']
];

describe('prompt/validator synchronisation — creator attribution', () => {
  it.each([...PROMPT_VERBATIM_PASS, ...PROMPT_FRAGMENT_FORMS.map(([, s]) => s)])(
    'the prompt teaches an accepted form: %s',
    text => expect(CREATOR_ATTRIBUTION.test(text)).toBe(true)
  );

  it.each(PROMPT_VERBATIM_FAIL)(
    'the prompt teaches a rejected form: %s',
    text => expect(CREATOR_ATTRIBUTION.test(text)).toBe(false)
  );

  it.each(PROMPT_COMMUNITY_FORMS.map(([, s]) => s))(
    'the prompt teaches an accepted community form: %s',
    text => expect(COMMUNITY_ATTRIBUTION.test(text)).toBe(true)
  );
});

describe('prompt content the synchronisation depends on', () => {
  it('still shows every verbatim PASS/FAIL example this file validates', () => {
    for (const example of [...PROMPT_VERBATIM_PASS, ...PROMPT_VERBATIM_FAIL, ...PROMPT_NON_CREATOR_PASS]) {
      expect(prompt).toContain(example);
    }
  });

  it('still teaches every attribution fragment this file validates', () => {
    for (const [fragment] of [...PROMPT_FRAGMENT_FORMS, ...PROMPT_COMMUNITY_FORMS]) {
      expect(prompt).toContain(fragment);
    }
  });

  it('still requires in-sentence attribution for creator and community evidence', () => {
    expect(prompt).toMatch(/the SAME sentence must attribute the creator/);
    expect(prompt).toMatch(/the SAME sentence must attribute the community/);
  });
});
