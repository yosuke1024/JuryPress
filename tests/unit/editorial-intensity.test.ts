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
import { INTENSITY_REPAIR_TARGET_CODES } from '../../src/lib/generation/intensity-repair';
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

/**
 * The three published reviews behind issue #128's 2026-08-26 regression report. Every overridden
 * field below is VERBATIM from the live pages (see scratchpad/article-texts.md from the Phase 1
 * research), at the real path the issue's own acceptance criteria name, exactly as
 * swiftletLike()/phoneHarnessLike() above pin the #109 regression. Judge index order is fixed by
 * the base fixture: alex=judges[0], david=judges[1], lisa=judges[2], sarah=judges[3],
 * marcus=judges[4].
 */

/**
 * am-will-gooey-pi-32a9e9, published 2026-08 (issue #128). Before the 1.1.0/1.3.0 lexicon
 * widening, this was the weakest of the three regressions: `INTENSITY_REPEATED_WORD_WARNING`
 * fired on a coincidental "highly"x3 and `INTENSITY_UNANCHORED_WARNING` fired on a stray
 * "exceptional", while every phrase the issue actually cited — "elegant cockpit", "notably
 * defensive", "uniquely elegant", "major ergonomic improvement" — was invisible, because
 * "elegant"/"elegantly" were absent from INTENSITY_LEXICON entirely. With "elegant" now in both
 * lexicons, `INTENSITY_UNANCHORED_WARNING` fires on the article's own headline-echoing phrase
 * ("...is uniquely elegant.") instead of an incidental "exceptional" — the detector is now
 * reading the sentence the issue is actually about. "notably", "major", and "defensive" remain
 * unmarked on purpose (see the INTENSITY_LEXICON doc comment in editorial-metrics.ts): they are
 * ordinary technical-review vocabulary, not unsupported intensity.
 */
function gooeyPiLike(): any {
  const content = JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  content.article.headline = 'GooeyPi builds an elegant cockpit for chaotic coding agents';
  content.article.jury_summary =
    "GooeyPi addresses a major friction point in the emerging AI developer stack: coordinating different, terminal-centric agent harnesses without losing local file context or security. The system's technical design is notably defensive.";
  content.article.where_jury_agreed[0] =
    'Git worktree integration is a major ergonomic improvement for agent branching.';
  const alex = content.judges[0];
  const lisa = content.judges[2];
  const marcus = content.judges[4];
  alex.criteria[0].reasoning =
    'Solves a massive pain point for developers using multiple CLI agents. Keeping local context in one place is incredibly valuable.';
  lisa.criteria[4].reasoning = // differentiation_insight
    'Shared context browsing where users and agents manipulate the same web view is uniquely elegant.';
  marcus.criteria[5].reasoning = 'Early growth trajectory is exceptional, but bus factor of one is a risk.'; // project_health_stewardship
  return withDistinctRecommendations(content);
}

/**
 * zcomplete-shell-typo-correction-5eab27, published 2026-08 (issue #128). Fires
 * `INTENSITY_REPEATED_WORD_WARNING` ("outstanding" x3), `INTENSITY_JUDGE_CONVERGENCE_WARNING`
 * ("outstanding" from david and lisa), and `INTENSITY_UNANCHORED_WARNING` ("outstanding" x3 plus
 * "superb") independent of the #128 lexicon widening — this article was already loud on the
 * generic booster/mid-tier vocabulary the lexicon already covered. What the widening adds is
 * "brilliant" (Alex's differentiation_insight reasoning, verbatim from the published page) as a
 * marked word, which is what makes this fixture collide with ocrItLike() below on the exact word
 * the issue cites for both articles (see the cross-article describe block). None of
 * "rigorous"/"robust"/"significant", three technical-prose words the issue also cites here,
 * should ever fire anything — they are deliberately excluded from both lexicons (see the
 * INTENSITY_LEXICON doc comment in editorial-metrics.ts).
 */
function zcompleteLike(): any {
  const content = JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  content.article.jury_summary =
    'The jury appreciated the rigorous engineering discipline visible in the path caching system. While highly effective for individual developers looking to streamline local CLI workflows, it remains a highly personal luxury rather than an essential team standard.';
  content.article.where_jury_agreed[0] =
    'The performance of the tool is outstanding, with the path caching mechanism successfully avoiding the performance penalties typical of shell wrappers.';
  content.article.where_jury_agreed[1] =
    'The inclusion of safety.rs provides a robust safeguard against accidental execution of destructive commands like dd or rm.';
  content.article.final_verdict =
    'Until then, it remains a beautifully optimized local workflow enhancer for developers comfortable managing custom shell configurations.';
  const alex = content.judges[0];
  const david = content.judges[1];
  const lisa = content.judges[2];
  const sarah = content.judges[3];
  alex.criteria[4].reasoning = // differentiation_insight
    'Lightyears ahead of thefuck in speed. The frecency weighting with directory-level context is brilliant.';
  david.verdict =
    'zcomplete demonstrates impressive performance optimizations, particularly in its PATH caching logic.';
  david.criteria[2].reasoning =
    'Outstanding latency control. Using raw file descriptors for quick input capture bypasses standard terminal overhead.';
  lisa.criteria[4].reasoning = // differentiation_insight
    "The dynamic subcommand suggestion by parsing '--help' outputs on the fly shows outstanding interactive design ingenuity.";
  sarah.criteria[0].reasoning =
    'Superb scope management. The project does not try to be an AI CLI assistant; it strictly focuses on typographical errors.';
  return withDistinctRecommendations(content);
}

/**
 * ocr-it-pull-text-out-of-un-copyable-documents-for-your-llm-04946d, published 2026-08 (issue
 * #128). Fires `INTENSITY_UNANCHORED_WARNING` on "masterful", "incredible", and "brilliant".
 * Deliberately does NOT fire `INTENSITY_JUDGE_CONVERGENCE_WARNING`: david/sarah/marcus each use a
 * DIFFERENT marked word ("exceptionally"/"incredible"/"brilliant"), so no pair shares one — the
 * convergence-defeats-by-varying-the-word gap #109 already documents. Before the #128 lexicon
 * widening, "a masterful design paradigm" (Lisa, differentiation_insight) was invisible to every
 * one of the six intensity codes, because "masterful" was in neither lexicon — arguably the
 * single most on-the-nose "unearned superlative, no anchor" sentence in the whole corpus. It is
 * now the first entry in this article's `INTENSITY_UNANCHORED_WARNING` finding. Participates in
 * `INTENSITY_CROSS_ARTICLE_WARNING` with gooeyPiLike() on "elegant" and with zcompleteLike() on
 * "brilliant" (see the cross-article describe block).
 */
function ocrItLike(): any {
  const content = JSON.parse(JSON.stringify(createEditorialFixture().generatedOutput));
  content.article.where_jury_agreed[0] =
    'The use of absolute viewport coordinates combined with nested postMessage cascades is an incredibly elegant solution to Manifest V3 sandboxing constraints.';
  const david = content.judges[1];
  const lisa = content.judges[2];
  const sarah = content.judges[3];
  const marcus = content.judges[4];
  david.criteria[1].reasoning =
    'The codebase is exceptionally complete, containing helper tools, structured schemas, and comprehensive end-to-end configuration layouts in tools/.';
  david.criteria[4].reasoning = // differentiation_insight
    'Replacing DOM selector matching with precise physical pointer event chains inside frames is a highly effective workaround for MV3 sandboxing.';
  lisa.criteria[4].reasoning = // differentiation_insight
    'Using pointer cascades to resolve clicks through Shadow DOMs is a masterful design paradigm.';
  sarah.verdict =
    'OCR It shows incredible scope control by targeting document extraction specifically for LLM context curation.';
  marcus.verdict =
    'This utility offers brilliant ecosystem leverage by bypassing expensive cloud APIs and localizing OCR.';
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

/**
 * The 2026-08-26 regression that motivated the 1.1.0 MARKED_INTENSITY_LEXICON / 1.3.0
 * INTENSITY_LEXICON widening (issue #128): three published reviews inside one week (GooeyPi,
 * zcomplete, OCR It) carried the exact unearned-superlative pattern #109 exists to catch, and
 * every one of the issue's cited phrases — "elegant cockpit", "uniquely elegant", "a masterful
 * design paradigm" — was invisible to the pre-widening lexicons. These tests pin each article's
 * NEW reading and, per Phase 2's acceptance criterion, confirm each is now repair-eligible: at
 * least one of the four warning codes `intensity-repair.ts` can act on
 * (`INTENSITY_REPAIR_TARGET_CODES`) fires for every one of the three.
 */
describe('issue #128 regression fixtures — GooeyPi, zcomplete, OCR It', () => {
  function repairEligible(codes: ReadonlySet<string>): boolean {
    return (INTENSITY_REPAIR_TARGET_CODES as readonly string[]).some(code => codes.has(code));
  }

  describe('gooeyPiLike() — am-will-gooey-pi-32a9e9', () => {
    it('fires INTENSITY_UNANCHORED_WARNING on "elegant" and "exceptional", and nothing else', () => {
      const findings = collectIntensityFindings({ content: gooeyPiLike() });
      const codes = new Set(findings.map(f => f.code));

      expect(codes).toEqual(new Set(['INTENSITY_UNANCHORED_WARNING']));
      expect(repairEligible(codes)).toBe(true);

      const unanchored = findings.find(f => f.code === 'INTENSITY_UNANCHORED_WARNING')!;
      expect(unanchored.message).toContain('"elegant"');
      expect(unanchored.message).toContain('uniquely elegant');
      expect(unanchored.message).toContain('"exceptional"');
      expect(unanchored.severity).toBe('warning');
    });
  });

  describe('zcompleteLike() — zcomplete-shell-typo-correction-5eab27', () => {
    it('fires REPEATED_WORD, JUDGE_CONVERGENCE, and UNANCHORED on "outstanding", never on the excluded technical prose', () => {
      const findings = collectIntensityFindings({ content: zcompleteLike() });
      const codes = new Set(findings.map(f => f.code));

      expect(codes).toEqual(new Set([
        'INTENSITY_REPEATED_WORD_WARNING',
        'INTENSITY_JUDGE_CONVERGENCE_WARNING',
        'INTENSITY_UNANCHORED_WARNING'
      ]));
      expect(repairEligible(codes)).toBe(true);

      const repeated = findings.find(f => f.code === 'INTENSITY_REPEATED_WORD_WARNING')!;
      expect(repeated.message).toContain('"outstanding" (3x)');

      const convergence = findings.find(f => f.code === 'INTENSITY_JUDGE_CONVERGENCE_WARNING')!;
      expect(convergence.message).toContain('"outstanding"');
      expect(convergence.message).toContain('david');
      expect(convergence.message).toContain('lisa');

      // "rigorous", "robust", and "significant" are three of the words issue #128 cites for this
      // article. None of them may ever contribute to a finding — they are ordinary
      // technical-review vocabulary, deliberately excluded from both lexicons.
      for (const finding of findings) {
        expect(finding.message).not.toMatch(/\brigorous\b/i);
        expect(finding.message).not.toMatch(/\brobust\b/i);
        expect(finding.message).not.toMatch(/\bsignificant\b/i);
      }
    });
  });

  describe('ocrItLike() — ocr-it-pull-text-out-of-un-copyable-documents-for-your-llm-04946d', () => {
    it('fires INTENSITY_UNANCHORED_WARNING on "masterful", "incredible", and "brilliant", and never on JUDGE_CONVERGENCE', () => {
      const findings = collectIntensityFindings({ content: ocrItLike() });
      const codes = new Set(findings.map(f => f.code));

      expect(codes).toEqual(new Set(['INTENSITY_UNANCHORED_WARNING']));
      expect(repairEligible(codes)).toBe(true);
      // Marcus/david/sarah each spend a DIFFERENT marked word (brilliant/exceptionally/
      // incredible), so no two judges share one — the convergence-defeats-by-varying-the-word
      // gap #109 documents, demonstrated on real content rather than a constructed example.
      expect(codes.has('INTENSITY_JUDGE_CONVERGENCE_WARNING')).toBe(false);

      const unanchored = findings.find(f => f.code === 'INTENSITY_UNANCHORED_WARNING')!;
      expect(unanchored.message).toContain('"masterful" in "Using pointer cascades to resolve clicks through Shadow DOMs is a masterful design paradigm."');
      expect(unanchored.message).toContain('"incredible"');
      expect(unanchored.message).toContain('"brilliant"');
    });
  });

  describe('cross-article recurrence between the three regressed reviews', () => {
    it('fires between GooeyPi and OCR It on "elegant", the word both use as headline peak-praise', () => {
      const recentReviews: RecentReviewIntensity[] = [
        { slug: 'ocr-it-pull-text-out-of-un-copyable-documents-for-your-llm-04946d', words: collectMarkedIntensity(ocrItLike()) }
      ];
      const findings = collectIntensityFindings({ content: gooeyPiLike(), recentReviews });
      const cross = findings.find(f => f.code === 'INTENSITY_CROSS_ARTICLE_WARNING');
      expect(cross).toBeDefined();
      expect(cross!.message).toContain('"elegant"');
      expect(cross!.message).toContain('ocr-it-pull-text-out-of-un-copyable-documents-for-your-llm-04946d');

      // Symmetric: OCR It against a recent-reviews list carrying GooeyPi's words collides too.
      const reverseReviews: RecentReviewIntensity[] = [
        { slug: 'am-will-gooey-pi-32a9e9', words: collectMarkedIntensity(gooeyPiLike()) }
      ];
      const reverseFindings = collectIntensityFindings({ content: ocrItLike(), recentReviews: reverseReviews });
      const reverseCross = reverseFindings.find(f => f.code === 'INTENSITY_CROSS_ARTICLE_WARNING');
      expect(reverseCross).toBeDefined();
      expect(reverseCross!.message).toContain('"elegant"');
    });

    it('fires between zcomplete and OCR It on "brilliant", pinning the #128 regression', () => {
      const recentReviews: RecentReviewIntensity[] = [
        { slug: 'ocr-it-pull-text-out-of-un-copyable-documents-for-your-llm-04946d', words: collectMarkedIntensity(ocrItLike()) }
      ];
      const findings = collectIntensityFindings({ content: zcompleteLike(), recentReviews });
      const cross = findings.find(f => f.code === 'INTENSITY_CROSS_ARTICLE_WARNING');
      expect(cross).toBeDefined();
      expect(cross!.message).toContain('"brilliant"');
      expect(cross!.message).toContain('ocr-it-pull-text-out-of-un-copyable-documents-for-your-llm-04946d');
    });
  });

  describe('restrained() stays completely silent under the widened lexicons', () => {
    it('produces zero findings — the widened lexicon does not blanket-ban ordinary praise', () => {
      // restrained() uses real, earned praise ("stellar", "brilliant") that is anchored and used
      // once each; none of the five #128 candidate words (elegant, elegantly, excellent,
      // masterful, masterfully) appear in it at all. This is acceptance criterion 5's "praise
      // must not be blanket-banned" requirement, pinned as an empirical zero rather than an
      // absence of a specific code.
      const findings = collectIntensityFindings({ content: restrained() });
      expect(findings).toEqual([]);
    });
  });
});
