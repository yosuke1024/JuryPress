import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { validateAndPersist } from '../../src/lib/generation/pipeline';
import { buildInitialRecord, readRecord, recordsDir, writeRecord } from '../../src/lib/generation/record-store';
import {
  measureEditorialVoice,
  INTENSITY_LEXICON,
  EDITORIAL_METRICS_VERSION
} from '../../src/lib/evaluation/editorial-metrics';
import { validateContent } from '../../src/lib/generation/validator';
import { createEditorialFixture } from '../fixtures/refined-review';

/**
 * The drift these readings exist to catch, measured across the 2026-07 corpus:
 *
 *   prompt 2.x (5 reviews)    4.0 intensity words per 1,000
 *   prompt 4.0.0 (7 reviews) 10.6 intensity words per 1,000
 *
 * with every judge inside one narrow band (6.6–14.8) despite a mean pairwise content-word
 * Jaccard of only 0.10. The judges were picking different subjects and describing all of them
 * at the same volume.
 *
 * The instrument is a thermometer. The last test in this file is the important one: it pins
 * down that a hot reading still publishes. If that test ever has to change, the change is
 * reintroducing the audit-era failure mode.
 */

/** Restrained prose, in the register prompt 4.1.0 asks for: specifics, no unearned volume. */
function measuredArticle() {
  return {
    article: {
      headline: 'A two-file core that reads well and proves nothing yet',
      standfirst: 'The design is unusually legible. Whether it survives contact with a real workload is untested.',
      jury_summary:
        'The tool keeps its entire control flow in two files and refuses a daemon. That decision explains its start-up cost, its small surface, and its ceiling. Nothing published shows it running against a repository larger than the sample.',
      where_jury_agreed: ['The scope decisions follow from a stated point of view.'],
      where_jury_disagreed: [{ criterion_id: 'differentiation_insight', summary: 'David reads the small core as discipline; Marcus reads it as a ceiling.' }],
      evidence_limitations: ['No runtime output was available.'],
      final_verdict:
        'Use it if you already work in a terminal and want repository state without ceremony. Wait if you need a shared view. A published CI run against the reviewed commit would settle the open question.',
      meta_description: 'A small terminal tool with a clear design and an untested claim.'
    },
    judges: [
      { judge_id: 'alex', verdict: 'A four-person team can install it before standup and know by lunch whether it fits.', strengths: ['First run costs one command.'], concerns: ['Nothing addresses a shared workflow.'], recommended_next_step: { action: 'Publish a walkthrough for a team of four.' }, criteria: [{ reasoning: 'The friction it removes is measurable in commands, not in feeling.', limitations: [] }] },
      { judge_id: 'david', verdict: 'Two files of control flow, explicit error paths, no hidden state.', strengths: ['Error paths are readable end to end.'], concerns: ['No test execution output exists.'], recommended_next_step: { action: 'Publish a CI run of the existing test files.' }, criteria: [{ reasoning: 'The module boundary sits where the state changes, which is where it should sit.', limitations: [] }] },
      { judge_id: 'lisa', verdict: 'You run one command and the output tells you what it just did. That is the whole onboarding.', strengths: ['The first run explains itself.'], concerns: ['The error text names an internal function, not the fix.'], recommended_next_step: { action: 'Rewrite the three failure messages to name the next action.' }, criteria: [{ reasoning: 'A person lands on a readable screen at step one and stalls at step four, where the error names a function.', limitations: [] }] },
      { judge_id: 'sarah', verdict: 'If the goal is inspection, the scope fits. If it is collaboration, it does not.', strengths: ['The stated scope matches what ships.'], concerns: ['The roadmap does not say which of the two it wants.'], recommended_next_step: { action: 'State in the README which of the two directions is out of scope.' }, criteria: [{ reasoning: 'Scope coherence holds only under the narrower of the two goals the README implies.', limitations: [] }] },
      { judge_id: 'marcus', verdict: 'Sharper than the incumbent at one task, dependent on it for everything else.', strengths: ['It occupies a gap the larger tools ignore.'], concerns: ['No path off the dependency.'], recommended_next_step: { action: 'Document the upstream version range the tool commits to.' }, criteria: [{ reasoning: 'Against the established alternatives it wins on start-up cost and loses on reach.', limitations: [] }] }
    ]
  };
}

/** The same review written in the 4.0.0 register the corpus actually produced. */
function overheatedArticle() {
  return {
    article: {
      headline: 'A brilliant two-file core and an incredibly polished result',
      standfirst: 'The design is brilliant. The execution is exceptional. The result is a massive step forward for the category.',
      jury_summary:
        'This is a masterclass in restraint. The two-file core is incredibly elegant, the refusal of a daemon is a brilliant decision, and the start-up cost is exceptional. The tool is a massive improvement over everything adjacent to it, and the ergonomics are beautifully judged throughout.',
      where_jury_agreed: ['The design is exceptional.'],
      where_jury_disagreed: [{ criterion_id: 'differentiation_insight', summary: 'Both judges call it brilliant; they disagree on what happens next.' }],
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

describe('measureEditorialVoice', () => {
  it('reads restrained prose as within budget and overheated prose as far outside it', () => {
    const measured = measureEditorialVoice(measuredArticle())!;
    const overheated = measureEditorialVoice(overheatedArticle())!;

    expect(measured.intensityCount).toBe(0);
    expect(measured.repeatedIntensity).toEqual([]);

    // The published 4.0.0 corpus averaged 10.6 per thousand; the audit-era corpus 4.0.
    expect(overheated.intensityPerThousand).toBeGreaterThan(10);
    expect(measured.intensityPerThousand).toBeLessThan(4);
  });

  it('reports which words repeat, which is what Issue #68 is actually about', () => {
    const repeated = measureEditorialVoice(overheatedArticle())!.repeatedIntensity;
    const words = repeated.map(entry => entry.word);

    expect(words).toContain('brilliant');
    expect(words).toContain('exceptional');
    expect(words).toContain('massive');
    // Sorted by count, so the worst offender is readable at a glance.
    expect(repeated[0].count).toBeGreaterThanOrEqual(repeated[repeated.length - 1].count);

    // One earned superlative is good writing, not a finding.
    const once = measureEditorialVoice({
      article: { ...measuredArticle().article, headline: 'A brilliant refusal to run a daemon, and the ceiling it buys' },
      judges: measuredArticle().judges
    })!;
    expect(once.intensityCount).toBe(1);
    expect(once.repeatedIntensity).toEqual([]);
  });

  it('separates per-judge volume from per-judge vocabulary', () => {
    const readings = measureEditorialVoice(overheatedArticle())!;

    expect(readings.judges).toHaveLength(5);
    expect(readings.judges.map(j => j.judgeId)).toEqual(['alex', 'david', 'lisa', 'sarah', 'marcus']);
    // Every judge writing the same way is exactly the homogeneity the issue describes, and it
    // shows up here as a spread near zero — something content-word similarity cannot see,
    // because those judges do pick different subjects.
    expect(readings.judgeIntensitySpread).toBe(0);

    const varied = measureEditorialVoice(measuredArticle())!;
    expect(varied.judges.every(j => j.intensityCount === 0)).toBe(true);
  });

  it('measures whether the summary and the final verdict say the same thing twice', () => {
    const echoed = {
      article: {
        ...measuredArticle().article,
        jury_summary: 'The tool keeps its control flow in two files and refuses a daemon, which explains its ceiling.',
        final_verdict: 'The tool keeps its control flow in two files and refuses a daemon, which explains its ceiling.'
      },
      judges: measuredArticle().judges
    };

    const distinct = measureEditorialVoice(measuredArticle())!;
    const duplicated = measureEditorialVoice(echoed)!;

    const pairOf = (r: typeof distinct) => r.echo.find(e => e.pair === 'jury_summary~final_verdict')!.jaccard;
    expect(pairOf(duplicated)).toBe(1);
    expect(pairOf(distinct)).toBeLessThan(0.3);
  });

  it('returns null rather than throwing on anything that is not editorial content', () => {
    expect(measureEditorialVoice(null)).toBeNull();
    expect(measureEditorialVoice('not content')).toBeNull();
    expect(measureEditorialVoice({})).toBeNull();
    expect(measureEditorialVoice({ article: {} })).toBeNull();
    expect(measureEditorialVoice({ article: {}, judges: [] })).not.toBeNull();
  });

  it('counts the plain adverbial boosters a restrained-looking article substitutes in', () => {
    // The first prompt-4.1.0 review read as a 39% improvement under the 1.0.0 lexicon while
    // using "highly" nine times. Whether that was avoidance or coincidence, an instrument that
    // misses it reports an improvement that did not happen.
    const substituted = measureEditorialVoice({
      article: {
        ...measuredArticle().article,
        standfirst: 'A highly coherent scope and a truly seamless install. The connectors are extremely capable.',
        final_verdict: 'A highly recommended tool that fits its niche perfectly.'
      },
      judges: measuredArticle().judges
    })!;

    const counted = substituted.repeatedIntensity.map(entry => entry.word);
    expect(counted).toContain('highly');
    expect(substituted.intensityCount).toBeGreaterThanOrEqual(6);

    // The words the earlier lexicon already caught are still caught.
    expect(measureEditorialVoice(overheatedArticle())!.intensityCount).toBeGreaterThan(15);
  });

  it('stamps the instrument version, because readings across lexicons are not comparable', () => {
    expect(measureEditorialVoice(measuredArticle())!.instrumentVersion).toBe(EDITORIAL_METRICS_VERSION);
    expect(new Set(INTENSITY_LEXICON).size).toBe(INTENSITY_LEXICON.length);
    expect(INTENSITY_LEXICON.every(word => word === word.toLowerCase())).toBe(true);
  });
});

describe('editorial voice readings are never a publication gate', () => {
  /**
   * The load-bearing test of this whole change.
   *
   * `buildEditorialPrompt` states that no validator may scan prose for wording, and
   * `recent-articles.ts` records why: a lexical gate rejects finished articles over phrasing,
   * which is the audit-era failure the editorial pipeline was built to end. The readings are a
   * thermometer, and a thermometer does not get a veto.
   *
   * If a future change makes this test fail, the change is the bug.
   */
  it('validates content the instrument reads as overheated', () => {
    const fixture = createEditorialFixture();
    const evidences = fixture.context.evidences;

    const hot = JSON.parse(JSON.stringify(fixture.review.evaluation));
    hot.article.headline = 'A brilliant, exceptional, incredibly massive triumph';
    hot.article.standfirst = 'Brilliant, exceptional, and beautifully massive throughout. A masterclass.';
    hot.article.final_verdict = 'An exceptional and brilliant triumph. Incredibly, massively recommended.';

    const readings = measureEditorialVoice(hot)!;
    expect(readings.repeatedIntensity.length).toBeGreaterThan(0);

    const verdict = validateContent({
      content: hot,
      originalContent: hot,
      evidences,
      humanEdited: false,
      promptVersion: '4.1.0'
    });

    expect(verdict.status).toBe('passed');
    expect(verdict.errors).toEqual([]);
  });
});

describe('validateAndPersist attaches readings without touching the verdict', () => {
  const recordId = 'season-2-manual-90001';

  function seed(contentRoot: string, content: unknown, promptVersion: string) {
    fs.mkdirSync(recordsDir(contentRoot), { recursive: true });
    writeRecord(contentRoot, buildInitialRecord({
      recordId,
      candidateId: 'candidate-1',
      runKey: 'season-2-manual-90001',
      canonicalUrl: 'https://example.com/project',
      candidateName: 'Refined Product',
      slug: 'editorial-product',
      receivedAt: '2026-07-22T00:00:00.000Z',
      model: 'fixture-model',
      modelVersion: 'fixture-model',
      promptVersion,
      promptHash: 'a'.repeat(64),
      rawResponse: JSON.stringify(content),
      originalContent: content,
      usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0, thinkingTokens: null, cachedInputTokens: null },
      route: {
        requestedModel: 'fixture-model',
        thinkingLevel: 'HIGH',
        successfulRoute: 'primary',
        failoverUsed: false,
        primaryAttempts: 1,
        fallbackAttempts: 0,
        totalAttempts: 1,
        charactersSentToModel: 0
      }
    }));
  }

  function withRoot<T>(fn: (root: string) => T): T {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-metrics-'));
    try {
      return fn(root);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }

  it('records readings on an editorial record and still passes it', () => {
    withRoot(root => {
      const fixture = createEditorialFixture();
      seed(root, fixture.review.evaluation, '4.1.0');

      const updated = validateAndPersist({ contentRoot: root, recordId, evidences: fixture.context.evidences });

      expect(updated.quality.status).toBe('passed');
      const readings = updated.editorialMetrics!.readings as any;
      expect(readings.instrumentVersion).toBe(EDITORIAL_METRICS_VERSION);
      expect(readings.judges).toHaveLength(5);
      expect(readings.wordCount).toBeGreaterThan(0);
    });
  });

  it('does not rewrite the readings when revalidating unchanged content', () => {
    withRoot(root => {
      const fixture = createEditorialFixture();
      seed(root, fixture.review.evaluation, '4.1.0');

      const first = validateAndPersist({ contentRoot: root, recordId, evidences: fixture.context.evidences });
      const second = validateAndPersist({ contentRoot: root, recordId, evidences: fixture.context.evidences });

      // Records are committed to the content repository; a revalidation of unchanged content
      // must not produce a diff whose only substance is a new timestamp.
      expect(second.editorialMetrics).toEqual(first.editorialMetrics);
      expect(readRecord(root, recordId)!.editorialMetrics).toEqual(first.editorialMetrics);
    });
  });

  it('leaves audit-era records unmeasured', () => {
    withRoot(root => {
      const fixture = createEditorialFixture();
      seed(root, fixture.review.evaluation, '2.1.0');

      const updated = validateAndPersist({ contentRoot: root, recordId, evidences: fixture.context.evidences });

      expect(updated.editorialMetrics).toBeUndefined();
    });
  });
});
