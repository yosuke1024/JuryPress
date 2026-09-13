import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { measureSentenceRhythm, measureEditorialVoice } from '../../src/lib/evaluation/editorial-metrics';
import { Evaluator } from '../../src/lib/evaluation/evaluator';
import { EditorialMetricsSchema } from '../../src/schemas/generation-record';

describe('rhythm readings (#142)', () => {
  it('measures population SD and absolute adjacent delta deterministically', () => {
    expect(measureSentenceRhythm('Two words. Here are four words. Now this sentence has six words.'))
      .toEqual({ sentenceCount: 3, meanSentenceWords: 4, sentenceLengthStdDev: 1.63, meanAdjacentLengthDelta: 2 });
  });
  it('has explicit empty and single-sentence semantics', () => {
    expect(measureSentenceRhythm('')).toEqual({ sentenceCount: 0, meanSentenceWords: null,
      sentenceLengthStdDev: null, meanAdjacentLengthDelta: null });
    expect(measureSentenceRhythm('Two words.')).toEqual({ sentenceCount: 1, meanSentenceWords: 2,
      sentenceLengthStdDev: 0, meanAdjacentLengthDelta: null });
    expect(measureSentenceRhythm(null as any).sentenceCount).toBe(0);
    expect(measureEditorialVoice({ article: { headline: null }, judges: [null, {}] })?.rhythm.sentenceCount).toBe(0);
  });
  it('records whole-article and individual judge readings and retains the old metrics', () => {
    const readings = measureEditorialVoice({ article: { headline: 'Two words.' },
      judges: [{ judge_id: 'alex', verdict: 'Four words are here.' }, { judge_id: 'david', verdict: 'Six words form this next sentence.' }] })!;
    expect(readings.instrumentVersion).toBe('2.0.0');
    expect(readings.rhythm.meanSentenceWords).toBe(4);
    expect(readings.judges.map(j => j.rhythm.meanSentenceWords)).toEqual([4, 6]);
    expect(readings.judgeWordCountSpread).toBe(2);
    expect(readings.wordCount).toBe(12);
    expect(readings.intensityCount).toBe(0);
    expect(readings.echo).toHaveLength(3);
    expect(measureEditorialVoice({ article: {}, judges: [] })?.judgeWordCountSpread).toBe(0);
  });
  it('keeps old readings parseable and the new readings out of validator/repair decisions', () => {
    const old = { measuredAt: '2026-09-09T00:00:00Z', contentHash: 'a'.repeat(64),
      readings: { instrumentVersion: '1.3.0', wordCount: 12 } };
    expect(EditorialMetricsSchema.parse(old)).toEqual(old);
    for (const file of ['src/lib/generation/validator.ts', 'src/lib/generation/intensity-repair.ts', 'src/lib/evaluation/editorial-intensity.ts']) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/measureSentenceRhythm|sentenceLengthStdDev|meanAdjacentLengthDelta|\.rhythm\b|judgeWordCountSpread/);
    }
  });
});

describe('4.9 candidate prompt stays isolated from production', () => {
  async function promptFor(promptVersion: string): Promise<string> {
    let prompt = '';
    const transport: any = { provider: 'gemini', generate: async (request: any) => {
      prompt = request.prompt;
      throw new Error('__CAPTURE_ONLY__');
    } };
    try {
      await new Evaluator({ transport }).generateRaw({ name: 'Example', canonicalUrl: 'https://example.com', metadata: {} } as any, [], {
        promptVersion, recentArticles: [{ headline: 'Prior', standfirstOpening: '', verdictOpening: '',
          jurySummaryOpening: 'A previous middle opening.', intensityWords: [] }]
      });
    } catch (error) { expect(String(error)).toContain('__CAPTURE_ONLY__'); }
    return prompt;
  }
  it('sends candidate craft and middle contrast through the real generation entry point', async () => {
    const candidate = await promptFor('4.9.0');
    for (const text of ['Uneven depth is allowed', 'Do not narrate the outline', 'reversal condition', 'Persona remains primary', 'Jury summary opened: A previous middle opening.']) {
      expect(candidate).toContain(text);
    }
    for (const version of ['4.8.0', '4.8.1']) {
      const baseline = await promptFor(version);
      expect(baseline).not.toContain('WRITING CRAFT — DEPTH AND DISCOURSE');
      expect(baseline).not.toContain('Jury summary opened:');
    }
    expect(JSON.parse(readFileSync('config/season.json', 'utf8')).evaluation_prompt_version).toBe('4.8.1');
  });
});
