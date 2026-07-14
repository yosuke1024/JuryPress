import { describe, it, expect } from 'vitest';
import { withUtm } from '../../src/lib/url';

describe('withUtm safe URL generator', () => {
  it('should add utm parameters to a clean URL', () => {
    const res = withUtm('https://judgie.ai', 'hero_judgie');
    const url = new URL(res);
    expect(url.searchParams.get('utm_source')).toBe('jurypress');
    expect(url.searchParams.get('utm_medium')).toBe('referral');
    expect(url.searchParams.get('utm_campaign')).toBe('product_ecosystem');
    expect(url.searchParams.get('utm_content')).toBe('hero_judgie');
  });

  it('should append utm parameters to a URL with existing query params', () => {
    const res = withUtm('https://judgie.ai?ref=homepage&foo=bar', 'footer_judgie');
    const url = new URL(res);
    expect(url.searchParams.get('ref')).toBe('homepage');
    expect(url.searchParams.get('foo')).toBe('bar');
    expect(url.searchParams.get('utm_source')).toBe('jurypress');
    expect(url.searchParams.get('utm_content')).toBe('footer_judgie');
  });

  it('should throw on invalid URL instead of silently returning', () => {
    expect(() => withUtm('not-a-valid-url', 'test')).toThrow();
  });

  it('should produce utm_content that varies by placement', () => {
    const hero = withUtm('https://judgie.ai', 'hero_judgie');
    const footer = withUtm('https://judgie.ai', 'footer_judgie');
    const heroUrl = new URL(hero);
    const footerUrl = new URL(footer);
    expect(heroUrl.searchParams.get('utm_content')).not.toBe(
      footerUrl.searchParams.get('utm_content')
    );
  });

  it('should handle article-specific utm_content', () => {
    const res = withUtm('https://judgie.ai', 'article_judgie_fixture-product');
    const url = new URL(res);
    expect(url.searchParams.get('utm_content')).toBe('article_judgie_fixture-product');
  });
});
