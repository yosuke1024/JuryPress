import { describe, it, expect } from 'vitest';
import { withUtm } from '../../src/lib/url';

describe('withUtm safe URL generator', () => {
  it('should add utm parameters to a clean URL', () => {
    const res = withUtm('https://judgie.ai', 'test-product');
    const url = new URL(res);
    expect(url.searchParams.get('utm_source')).toBe('jurypress');
    expect(url.searchParams.get('utm_medium')).toBe('owned_media');
    expect(url.searchParams.get('utm_campaign')).toBe('season_1');
    expect(url.searchParams.get('utm_content')).toBe('test-product');
  });

  it('should append utm parameters to a URL with existing query params', () => {
    const res = withUtm('https://judgie.ai?ref=homepage&foo=bar', 'test-product');
    const url = new URL(res);
    expect(url.searchParams.get('ref')).toBe('homepage');
    expect(url.searchParams.get('foo')).toBe('bar');
    expect(url.searchParams.get('utm_source')).toBe('jurypress');
    expect(url.searchParams.get('utm_content')).toBe('test-product');
  });

  it('should return original string if URL parsing fails', () => {
    const res = withUtm('not-a-valid-url', 'test-product');
    expect(res).toBe('not-a-valid-url');
  });
});
