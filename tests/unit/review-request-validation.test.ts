import { describe, it, expect } from 'vitest';
import {
  ReviewRequestSubmissionSchema,
  validateCanonicalRepositoryUrl,
  validatePublicHttpsUrl
} from '../../src/schemas/review-request';

describe('validatePublicHttpsUrl', () => {
  it('accepts a public https URL and strips trailing slashes', () => {
    expect(validatePublicHttpsUrl('https://docs.jurypress-demo.dev/guide/')).toBe('https://docs.jurypress-demo.dev/guide');
  });

  it('rejects http URLs', () => {
    expect(validatePublicHttpsUrl('http://github.com/owner/repo')).toBeNull();
  });

  it('rejects localhost and .local hosts', () => {
    expect(validatePublicHttpsUrl('https://localhost/x')).toBeNull();
    expect(validatePublicHttpsUrl('https://foo.localhost/x')).toBeNull();
    expect(validatePublicHttpsUrl('https://printer.local/x')).toBeNull();
  });

  it('rejects IP literals, including private ranges', () => {
    expect(validatePublicHttpsUrl('https://192.168.1.10/x')).toBeNull();
    expect(validatePublicHttpsUrl('https://10.0.0.1/x')).toBeNull();
    expect(validatePublicHttpsUrl('https://8.8.8.8/x')).toBeNull();
    expect(validatePublicHttpsUrl('https://[::1]/x')).toBeNull();
  });

  it('rejects URL shorteners', () => {
    expect(validatePublicHttpsUrl('https://bit.ly/abc')).toBeNull();
    expect(validatePublicHttpsUrl('https://t.co/abc')).toBeNull();
  });

  it('rejects credentials and fragments', () => {
    expect(validatePublicHttpsUrl('https://user:pass@host.dev/x')).toBeNull();
    expect(validatePublicHttpsUrl('https://user@host.dev/x')).toBeNull();
    expect(validatePublicHttpsUrl('https://host.dev/x#fragment')).toBeNull();
  });

  it('rejects query strings unless explicitly allowed', () => {
    expect(validatePublicHttpsUrl('https://host.dev/x?y=1')).toBeNull();
    expect(validatePublicHttpsUrl('https://host.dev/x?y=1', { allowQuery: true })).toBe('https://host.dev/x?y=1');
  });

  it('rejects control characters, whitespace and oversized URLs', () => {
    expect(validatePublicHttpsUrl('https://host.dev/x y')).toBeNull();
    expect(validatePublicHttpsUrl('https://host.dev/x\ty')).toBeNull();
    expect(validatePublicHttpsUrl('https://host.dev/x\u0000y')).toBeNull();
    expect(validatePublicHttpsUrl(`https://host.dev/${'a'.repeat(2100)}`)).toBeNull();
  });

  it('rejects dotless hosts and non-URL strings', () => {
    expect(validatePublicHttpsUrl('https://intranet/x')).toBeNull();
    expect(validatePublicHttpsUrl('not a url')).toBeNull();
  });
});

describe('validateCanonicalRepositoryUrl', () => {
  it('accepts a GitHub repository URL and normalizes it', () => {
    expect(validateCanonicalRepositoryUrl('https://github.com/owner/project/')).toEqual({
      url: 'https://github.com/owner/project',
      platform: 'github',
      path: 'owner/project'
    });
  });

  it('accepts a Hugging Face Space URL', () => {
    expect(validateCanonicalRepositoryUrl('https://huggingface.co/spaces/owner/space')).toEqual({
      url: 'https://huggingface.co/spaces/owner/space',
      platform: 'hugging-face',
      path: 'owner/space'
    });
  });

  it('rejects unsupported hosts and shapes', () => {
    expect(validateCanonicalRepositoryUrl('https://gitlab.com/owner/project')).toBeNull();
    expect(validateCanonicalRepositoryUrl('https://owner.github.io/project')).toBeNull();
    expect(validateCanonicalRepositoryUrl('https://github.com/owner')).toBeNull();
    expect(validateCanonicalRepositoryUrl('https://github.com/owner/project/tree/main')).toBeNull();
    expect(validateCanonicalRepositoryUrl('https://huggingface.co/owner/model')).toBeNull();
    expect(validateCanonicalRepositoryUrl('https://github.com/owner/project.git')).toBeNull();
    expect(validateCanonicalRepositoryUrl('http://github.com/owner/project')).toBeNull();
    expect(validateCanonicalRepositoryUrl('https://github.com/owner/project?tab=readme')).toBeNull();
  });
});

describe('ReviewRequestSubmissionSchema', () => {
  const validSubmission = {
    product_name: 'Great Tool',
    canonical_repository_url: 'https://github.com/owner/great-tool',
    purpose: 'A command-line tool that automates dependency updates safely.',
    requester_relationship: 'user',
    consent_public_issue: true,
    consent_no_guarantee: true,
    turnstile_token: 'tok-123',
    website: ''
  };

  it('accepts a valid submission', () => {
    expect(ReviewRequestSubmissionSchema.safeParse(validSubmission).success).toBe(true);
  });

  it('accepts optional official and additional URLs', () => {
    const result = ReviewRequestSubmissionSchema.safeParse({
      ...validSubmission,
      official_url: 'https://great-tool.dev',
      additional_official_urls: ['https://great-tool.dev/docs', 'https://great-tool.dev/changelog']
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing consents', () => {
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, consent_public_issue: false }).success).toBe(false);
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, consent_no_guarantee: false }).success).toBe(false);
  });

  it('rejects a filled honeypot', () => {
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, website: 'https://spam.dev' }).success).toBe(false);
  });

  it('enforces product name and purpose bounds', () => {
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, product_name: '' }).success).toBe(false);
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, product_name: 'x'.repeat(121) }).success).toBe(false);
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, purpose: 'too short' }).success).toBe(false);
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, purpose: 'x'.repeat(501) }).success).toBe(false);
  });

  it('rejects line breaks and control characters in text fields', () => {
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, product_name: 'two\nlines' }).success).toBe(false);
    expect(ReviewRequestSubmissionSchema.safeParse({
      ...validSubmission,
      purpose: 'A tool that does things.\nAnd injects a second paragraph into the issue.'
    }).success).toBe(false);
  });

  it('rejects more than five additional URLs', () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://great-tool.dev/docs/${i}`);
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, additional_official_urls: urls }).success).toBe(false);
  });

  it('rejects unknown keys (strict payload)', () => {
    expect(ReviewRequestSubmissionSchema.safeParse({ ...validSubmission, admin: true }).success).toBe(false);
  });

  it('rejects unsupported canonical repository URLs', () => {
    expect(ReviewRequestSubmissionSchema.safeParse({
      ...validSubmission,
      canonical_repository_url: 'https://gitlab.com/owner/project'
    }).success).toBe(false);
  });
});
