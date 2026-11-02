import type { SourceMetric } from '../../schemas/selection';

export type SourceMetricPlatform = SourceMetric['platform'];

/** Resolve curation-metric provenance without inferring it from the product URL. */
export function resolveSourceMetricPlatform(
  source: string | null | undefined,
  unit: string | null | undefined
): SourceMetricPlatform {
  const normalizedUnit = (unit ?? '').toLowerCase();
  if (normalizedUnit === 'points') return 'hacker-news';
  if (normalizedUnit === 'likes') return 'hugging-face';
  if (normalizedUnit === 'stars') return 'github';

  const normalizedSource = (source ?? '').toLowerCase().replace(/[_\s]+/g, '-');
  if (normalizedSource.includes('show-hn') || normalizedSource === 'hn' || normalizedSource.includes('hacker-news')) {
    return 'hacker-news';
  }
  if (normalizedSource.includes('hugging-face') || normalizedSource.includes('huggingface')) {
    return 'hugging-face';
  }
  return 'github';
}

/**
 * Render legacy metrics from metric identity. This repairs old records where
 * `platform: github` was saved beside `metric: points`.
 */
export function sourceMetricDisplay(metric: Pick<SourceMetric, 'platform' | 'metric'>): {
  platform: 'GitHub' | 'Hacker News' | 'Hugging Face';
  unit: 'stars' | 'points' | 'likes';
} {
  if (metric.metric === 'points') return { platform: 'Hacker News', unit: 'points' };
  if (metric.metric === 'likes') return { platform: 'Hugging Face', unit: 'likes' };
  return { platform: 'GitHub', unit: 'stars' };
}
