import { describe, expect, it } from 'vitest';
import { resolveSourceMetricPlatform, sourceMetricDisplay } from '../../src/lib/selection/source-metrics';

describe('source metric provenance (#144 recurrence)', () => {
  it('treats Show HN popularity as Hacker News points even when the product URL is GitHub', () => {
    expect(resolveSourceMetricPlatform('show_hn', 'points')).toBe('hacker-news');
    expect(resolveSourceMetricPlatform('show-hn', 'points')).toBe('hacker-news');
    expect(resolveSourceMetricPlatform('github', 'points')).toBe('hacker-news');
  });

  it('keeps repository and Hugging Face metrics on their own platforms', () => {
    expect(resolveSourceMetricPlatform('github', 'stars')).toBe('github');
    expect(resolveSourceMetricPlatform('hugging_face', 'likes')).toBe('hugging-face');
  });

  it('repairs the Peregrine and bootgpt legacy display shape from metric identity', () => {
    for (const value of [2, 87]) {
      const legacy = { platform: 'github' as const, metric: 'points' as const, value };
      expect(sourceMetricDisplay(legacy)).toEqual({ platform: 'Hacker News', unit: 'points' });
    }
    expect(sourceMetricDisplay({ platform: 'github', metric: 'stars' }))
      .toEqual({ platform: 'GitHub', unit: 'stars' });
  });
});
