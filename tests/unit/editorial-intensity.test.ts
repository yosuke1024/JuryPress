import { describe, it, expect } from 'vitest';
import {
  collectIntensityFindings,
  collectMarkedIntensity,
  intensityContractApplies,
  MARKED_INTENSITY_LEXICON,
  EDITORIAL_INTENSITY_RULE_VERSION,
  type RecentReviewIntensity
} from '../../src/lib/evaluation/editorial-intensity';
import { INTENSITY_LEXICON, measureEditorialVoice } from '../../src/lib/evaluation/editorial-metrics';
import { validateContent } from '../../src/lib/generation/validator';
import { createEditorialFixture } from '../fixtures/refined-review';

/**
 * Cross-article and cross-judge intensity QA (issue #109), pinned against the two prompt-4.5.0
 * reviews that exposed it: leonickson1-swiftlet (2026-08-09) and shawnpana-phone-harness
 * (2026-08-10). The sentences below are VERBATIM from those published generation records, at
 * their real paths, exactly as the issue's acceptance criteria name them.
 */

/**
 * The base fixture's default recommended_next_step actions differ only by an embedded ordinal
 * ("...so perspective 1 can judge...", "...so perspective 2 can judge..."), which the
 * recommendation contract (issue #85) reads as five near-duplicate actions — a pre-existing
 * fixture property unrelated to intensity. Rewritten to five genuinely distinct,
 * concern-echoing actions so the zero-error baseline in the version-gating test below is not
 * fighting an unrelated contract violation.
 */
function withDistinctRecommendations(content: any): any {
  const actions: Record<string, string> = {
    alex: 'Publish a short walkthrough video of the install and first run so this perspective can be checked end to end.',
    david: 'Publish the existing test suite output from CI so this perspective is backed by an artifact, not a claim.',
    lisa: 'Publish annotated before-and-after screenshots of the onboarding flow so this perspective has something concrete to react to.',
    sarah: 'Publish a comparison table against the two nearest alternatives so this perspective is checkable against the field.',
    marcus: 'Publish quarterly adoption numbers on the project site so this perspective can be verified independently.'
  };
  for (const judge of content.judges) {
    if (actions[judge.judge_id]) {
      judge.recommended_next_step = { ...judge.recommended_next_step, action: actions[judge.judge_id] };
    }
  }
  return content;
}

/** leonickson1-swiftlet, 2026-08-09: marcus = judges[4]. */
function swiftletLike(): any {
  const content = JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  content.article.jury_summary =
    'Swiftlet represents a major shift in how developers can deploy large language models on consumer hardware.';
  content.article.where_jury_agreed[0] =
    'The custom .qpack file format is an exceptionally clever solution to the latency and page-cache thrashing issues commonly associated with memory-mapped MoE runtimes.';
  const marcus = content.judges[4];
  marcus.strengths[0] = 'Outstanding ecosystem positioning as a native Swift alternative to llama.cpp on Apple hardware.';
  marcus.criteria[0].reasoning = 'Enabling base iPhones to run models of this scale is a massive leap in local AI capabilities.';
  marcus.criteria[4].reasoning = 'This is a masterclass in exploiting hardware characteristics for AI inference.';
  return withDistinctRecommendations(content);
}

/** shawnpana-phone-harness, 2026-08-10: lisa = judges[2], marcus = judges[4]. */
function phoneHarnessLike(): any {
  const content = JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  const lisa = content.judges[2];
  const marcus = content.judges[4];
  lisa.verdict = 'The developer experience of having an LLM agent execute its own installation is exceptional.';
  lisa.criteria[4].reasoning =
    'Recognizing that the mirroring app is a direct video feed without an accessibility tree, and using OCR to solve it, is brilliant.';
  marcus.verdict =
    'This is a brilliant ecosystem exploit that achieves in 500 lines of code what Appium requires gigabytes of software to perform.';
  marcus.strengths[0] = "Incredible leverage of Sequoia's native mirroring framework to completely bypass mobile security walls.";
  marcus.criteria[0].reasoning =
    'A phenomenal local developer tool, but blocked from scaling to enterprise automation due to the physical device limitation.';
  marcus.criteria[4].reasoning = 'Absolute masterclass in lean engineering.';
  return withDistinctRecommendations(content);
}

/**
 * A differentiated fixture: five judges in clearly different registers, at most two intensity
 * words in the whole review, each anchored, and no marked word shared between judges. This is
 * the fixture that proves the checks stay quiet on healthy content — the acceptance criterion
 * that five personas NOT converging is confirmable, not just five personas converging.
 */
function restrained(): any {
  const content = JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  const alex = content.judges[0];
  const david = content.judges[1];
  alex.strengths[0] = 'The one-command install (shipped in v1.2.0) is stellar, and nothing about it needs explaining twice.';
  david.criteria[0].reasoning = 'The `core.ts` module is brilliant in its restraint: two files, no hidden state, nothing left to guess at.';
  return withDistinctRecommendations(content);
}

describe('MARKED_INTENSITY_LEXICON', () => {
  it('is a subset of INTENSITY_LEXICON — every marked word is also a measured word', () => {
    for (const word of MARKED_INTENSITY_LEXICON) {
      expect(INTENSITY_LEXICON, word).toContain(word);
    }
  });
});

describe('intensityContractApplies — the version gate', () => {
  it('applies from prompt 4.6.0 onward', () => {
    expect(intensityContractApplies('4.6.0')).toBe(true);
    expect(intensityContractApplies('4.6.1')).toBe(true);
    expect(intensityContractApplies('5.0.0')).toBe(true);
  });

  it('never judges records generated before the prompt stated the rules', () => {
    expect(intensityContractApplies('4.5.0')).toBe(false);
    expect(intensityContractApplies('4.0.0')).toBe(false);
    expect(intensityContractApplies('2.1.0')).toBe(false);
    expect(intensityContractApplies(null)).toBe(false);
    expect(intensityContractApplies(undefined)).toBe(false);
    expect(intensityContractApplies('not-a-version')).toBe(false);
  });
});

describe('the 1.2.0 lexicon addition — "outstanding"', () => {
  it('the instrument counts it, and the Swiftlet Marcus sentence registers', () => {
    const content = {
      article: { headline: 'x' },
      judges: [{
        judge_id: 'marcus',
        strengths: ['Outstanding ecosystem positioning as a native Swift alternative to llama.cpp on Apple hardware.']
      }]
    };
    expect(measureEditorialVoice(content)!.intensityCount).toBe(1);
  });
});

describe('collectMarkedIntensity', () => {
  it('collects the rare superlatives Swiftlet actually spent', () => {
    const words = collectMarkedIntensity(swiftletLike());
    expect(words).toContain('masterclass');
    expect(words).toContain('exceptionally');
    expect(words).toContain('outstanding');
  });

  it('returns [] for content that is not V3-shaped, without throwing', () => {
    expect(collectMarkedIntensity(null)).toEqual([]);
    expect(collectMarkedIntensity('not content')).toEqual([]);
    expect(collectMarkedIntensity({})).toEqual([]);
    expect(collectMarkedIntensity({ article: {} })).toEqual([]);
  });
});

describe('INTENSITY_CROSS_ARTICLE_WARNING — the pinned #109 regression', () => {
  it('fires on Phone Harness against a recent-reviews list carrying the Swiftlet words, naming "masterclass" and the slug', () => {
    const recentReviews: RecentReviewIntensity[] = [
      { slug: 'leonickson1-swiftlet-2eb900', words: collectMarkedIntensity(swiftletLike()) }
    ];
    const findings = collectIntensityFindings({ content: phoneHarnessLike(), recentReviews });
    const cross = findings.find(f => f.code === 'INTENSITY_CROSS_ARTICLE_WARNING');
    expect(cross).toBeDefined();
    expect(cross!.message).toContain('masterclass');
    expect(cross!.message).toContain('leonickson1-swiftlet-2eb900');
    expect(cross!.severity).toBe('warning');
  });

  it('never fires when there are no recent reviews to compare against, and never throws', () => {
    const findings = collectIntensityFindings({ content: phoneHarnessLike() });
    expect(findings.some(f => f.code === 'INTENSITY_CROSS_ARTICLE_WARNING')).toBe(false);

    const emptyList = collectIntensityFindings({ content: phoneHarnessLike(), recentReviews: [] });
    expect(emptyList.some(f => f.code === 'INTENSITY_CROSS_ARTICLE_WARNING')).toBe(false);
  });
});

describe('INTENSITY_JUDGE_CONVERGENCE_WARNING — five judges, five vocabularies', () => {
  it('fires on Phone Harness, naming "brilliant" with lisa and marcus', () => {
    const findings = collectIntensityFindings({ content: phoneHarnessLike() });
    const convergence = findings.find(f => f.code === 'INTENSITY_JUDGE_CONVERGENCE_WARNING');
    expect(convergence).toBeDefined();
    expect(convergence!.message).toContain('brilliant');
    expect(convergence!.message).toContain('lisa');
    expect(convergence!.message).toContain('marcus');
  });

  it('stays quiet when no judge repeats another judge\'s marked word', () => {
    const findings = collectIntensityFindings({ content: restrained() });
    expect(findings.some(f => f.code === 'INTENSITY_JUDGE_CONVERGENCE_WARNING')).toBe(false);
  });
});

describe('INTENSITY_UNANCHORED_WARNING — the reason must be beside the conclusion', () => {
  it('flags the Phone Harness Marcus sentence that names no mechanism', () => {
    const findings = collectIntensityFindings({ content: phoneHarnessLike() });
    const unanchored = findings.find(f => f.code === 'INTENSITY_UNANCHORED_WARNING');
    expect(unanchored).toBeDefined();
    expect(unanchored!.message).toContain('Absolute masterclass in lean engineering.');
  });

  it('does not flag the Marcus verdict sentence, because the digit anchors it', () => {
    const findings = collectIntensityFindings({ content: phoneHarnessLike() });
    const unanchored = findings.find(f => f.code === 'INTENSITY_UNANCHORED_WARNING');
    expect(unanchored!.message).not.toContain('500 lines of code');
  });

  it('does not let a pure ALL-CAPS acronym anchor a sentence', () => {
    const content = {
      article: { headline: 'x' },
      judges: [{ judge_id: 'marcus', strengths: ['AI powers this brilliant workflow from end to end without exception.'] }]
    };
    const findings = collectIntensityFindings({ content });
    const unanchored = findings.find(f => f.code === 'INTENSITY_UNANCHORED_WARNING');
    expect(unanchored).toBeDefined();
    expect(unanchored!.message).toContain('brilliant');
  });
});

describe('INTENSITY_REPEATED_WORD_WARNING and INTENSITY_DENSITY_WARNING', () => {
  /** The same overheated register editorial-metrics.test.ts uses to exercise the instrument. */
  function overheatedFixture(): any {
    return {
      article: {
        headline: 'A brilliant, exceptional, and incredibly massive triumph',
        standfirst: 'The design is brilliant. The execution is exceptional. The result is a massive step forward.',
        jury_summary:
          'This is a masterclass in restraint. The core is incredibly elegant, and the result is a massive improvement over everything adjacent to it.',
        where_jury_agreed: ['The design is exceptional.'],
        where_jury_disagreed: [],
        evidence_limitations: [],
        final_verdict: 'An exceptional tool with a brilliant core and a massive lead on its alternatives. A genuine triumph.',
        meta_description: 'A brilliant, exceptional terminal tool.'
      },
      judges: ['alex', 'david', 'lisa', 'sarah', 'marcus'].map(judge_id => ({
        judge_id,
        verdict: 'An incredibly brilliant piece of engineering and a massive step forward.',
        strengths: ['The architecture is exceptional.'],
        concerns: ['The roadmap is less brilliant than the core.'],
        recommended_next_step: { action: 'Keep the exceptional core and publish a benchmark.' },
        criteria: [{ reasoning: 'The design here is incredibly well judged and the trade-offs are beautifully made.', limitations: [] }]
      }))
    };
  }

  it('fires both on an overheated review', () => {
    const findings = collectIntensityFindings({ content: overheatedFixture() });
    const repeated = findings.find(f => f.code === 'INTENSITY_REPEATED_WORD_WARNING');
    const density = findings.find(f => f.code === 'INTENSITY_DENSITY_WARNING');
    expect(repeated).toBeDefined();
    expect(density).toBeDefined();
    expect(repeated!.severity).toBe('warning');
    expect(density!.severity).toBe('warning');
  });

  it('stays quiet on the restrained fixture', () => {
    const findings = collectIntensityFindings({ content: restrained() });
    expect(findings.some(f => f.code === 'INTENSITY_REPEATED_WORD_WARNING')).toBe(false);
    expect(findings.some(f => f.code === 'INTENSITY_DENSITY_WARNING')).toBe(false);
  });
});

describe('INTENSITY_UNIFORM_VOLUME_WARNING — the low-count guard', () => {
  function overheatedFixture(): any {
    return {
      article: { headline: 'x' },
      judges: ['alex', 'david', 'lisa', 'sarah', 'marcus'].map(judge_id => ({
        judge_id,
        verdict: 'An incredibly brilliant piece of engineering and a massive step forward.',
        strengths: ['The architecture is exceptional.'],
        concerns: ['The roadmap is less brilliant than the core.'],
        recommended_next_step: { action: 'Keep the exceptional core and publish a benchmark.' },
        criteria: [{ reasoning: 'The design here is incredibly well judged and the trade-offs are beautifully made.', limitations: [] }]
      }))
    };
  }

  it('fires when every judge is loud and the total count is real', () => {
    const findings = collectIntensityFindings({ content: overheatedFixture() });
    const uniform = findings.find(f => f.code === 'INTENSITY_UNIFORM_VOLUME_WARNING');
    expect(uniform).toBeDefined();
  });

  it('stays quiet on the restrained fixture, which always leaves a judge near zero', () => {
    const findings = collectIntensityFindings({ content: restrained() });
    expect(findings.some(f => f.code === 'INTENSITY_UNIFORM_VOLUME_WARNING')).toBe(false);
  });

  it('does not fire on five judges with one intensity word each, even though every rate is nonzero', () => {
    const content = {
      article: { headline: 'x' },
      judges: ['alex', 'david', 'lisa', 'sarah', 'marcus'].map(judge_id => ({
        judge_id,
        verdict: 'The setup here is highly straightforward and nothing else needs to be said about it today.'
      }))
    };
    const readings = measureEditorialVoice(content)!;
    // Every judge carries a real rate...
    expect(readings.judges.every(j => j.intensityPerThousand > 0)).toBe(true);
    // ...but the total is too small to call it a volume.
    expect(readings.intensityCount).toBeLessThan(10);
    const findings = collectIntensityFindings({ content });
    expect(findings.some(f => f.code === 'INTENSITY_UNIFORM_VOLUME_WARNING')).toBe(false);
  });
});

describe('validateContent — version-dispatched enforcement (the #68 load-bearing property, restated)', () => {
  it('produces none of the new warning codes under 4.5.0, and all of them under 4.6.0 — passing both times', () => {
    const content = phoneHarnessLike();
    const evidences = createEditorialFixture().context.evidences;
    const intensityCodes = new Set([
      'INTENSITY_DENSITY_WARNING',
      'INTENSITY_REPEATED_WORD_WARNING',
      'INTENSITY_JUDGE_CONVERGENCE_WARNING',
      'INTENSITY_UNIFORM_VOLUME_WARNING',
      'INTENSITY_CROSS_ARTICLE_WARNING',
      'INTENSITY_UNANCHORED_WARNING'
    ]);

    const before = validateContent({ content, originalContent: content, evidences, humanEdited: false, promptVersion: '4.5.0' });
    expect(before.status).toBe('passed');
    expect(before.errors).toEqual([]);
    expect(before.warnings.filter(w => intensityCodes.has(w.code))).toEqual([]);

    const after = validateContent({ content, originalContent: content, evidences, humanEdited: false, promptVersion: '4.6.0' });
    expect(after.status).toBe('passed');
    expect(after.errors).toEqual([]);
    const afterCodes = new Set(after.warnings.filter(w => intensityCodes.has(w.code)).map(w => w.code));
    expect(afterCodes.has('INTENSITY_JUDGE_CONVERGENCE_WARNING')).toBe(true);
    expect(afterCodes.has('INTENSITY_UNANCHORED_WARNING')).toBe(true);
  });
});

describe('every finding carries the module\'s own severity and rule version', () => {
  it('stamps warning severity and EDITORIAL_INTENSITY_RULE_VERSION on everything produced', () => {
    const recentReviews: RecentReviewIntensity[] = [
      { slug: 'leonickson1-swiftlet-2eb900', words: collectMarkedIntensity(swiftletLike()) }
    ];
    const allFindings = [
      ...collectIntensityFindings({ content: phoneHarnessLike(), recentReviews }),
      ...collectIntensityFindings({ content: swiftletLike() }),
      ...collectIntensityFindings({ content: restrained() })
    ];
    expect(allFindings.length).toBeGreaterThan(0);
    for (const finding of allFindings) {
      expect(finding.severity).toBe('warning');
      expect(finding.ruleVersion).toBe(EDITORIAL_INTENSITY_RULE_VERSION);
    }
  });
});
