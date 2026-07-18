import { describe, it, expect } from 'vitest';
import { isEligibleGateSource, isSupportedSourceUrl } from '../../src/lib/selection/eligibility';

/**
 * The supported-source checks are host-anchored: a supported host token appearing in the
 * path, query, or another hostname must never count as a supported source.
 */
describe('supported source host checks', () => {
  it('accepts supported hosts and their subdomains', () => {
    expect(isSupportedSourceUrl('https://github.com/owner/repo')).toBe(true);
    expect(isSupportedSourceUrl('https://owner.github.io/project/')).toBe(true);
    expect(isSupportedSourceUrl('https://huggingface.co/spaces/owner/space')).toBe(true);
    expect(isEligibleGateSource('https://github.com/owner/repo')).toBe(true);
    expect(isEligibleGateSource('https://huggingface.co/spaces/owner/space')).toBe(true);
  });

  it('rejects host tokens outside the hostname', () => {
    expect(isSupportedSourceUrl('https://evil.example/github.com/owner/repo')).toBe(false);
    expect(isSupportedSourceUrl('https://evil.example/?ref=github.com')).toBe(false);
    expect(isSupportedSourceUrl('https://github.com.evil.example/owner/repo')).toBe(false);
    expect(isEligibleGateSource('https://evil.example/huggingface.co/x')).toBe(false);
    expect(isEligibleGateSource('https://owner.github.io/project/')).toBe(false);
  });

  it('rejects non-URL strings', () => {
    expect(isSupportedSourceUrl('github.com/owner/repo')).toBe(false);
    expect(isSupportedSourceUrl('')).toBe(false);
  });
});
