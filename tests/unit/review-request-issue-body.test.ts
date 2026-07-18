import { describe, it, expect } from 'vitest';
import { parseReviewRequestIssueBody } from '../../src/lib/review-requests/issue-body';

/**
 * Parser tests for issue-form bodies. GitHub renders each form field as a `### <label>`
 * section; bodies are editable after creation, so every failure mode an edit can produce
 * must map to a stable decline code.
 */

function formBody(overrides: Partial<Record<string, string | null>> = {}): string {
  const sections: Record<string, string | null> = {
    'Product name': 'Great Tool',
    'Canonical public repository URL': 'https://github.com/owner/great-tool',
    'One-sentence purpose': 'A command-line tool that automates dependency updates safely.',
    'Your relationship to the product': 'User',
    'Official website / Demo URL': '_No response_',
    'Additional official documentation URLs': '_No response_',
    'Acknowledgement': '- [x] I understand this request is a public GitHub Issue (no personal or confidential information), and that submitting it guarantees neither publication nor a favorable score.',
    ...overrides
  };
  return Object.entries(sections)
    .filter(([, value]) => value !== null)
    .map(([label, value]) => `### ${label}\n\n${value}`)
    .join('\n\n');
}

describe('parseReviewRequestIssueBody (issue form)', () => {
  it('parses a complete form submission', () => {
    const parsed = parseReviewRequestIssueBody(formBody());
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request).toEqual({
        product_name: 'Great Tool',
        canonical_repository_url: 'https://github.com/owner/great-tool',
        official_url: null,
        purpose: 'A command-line tool that automates dependency updates safely.',
        requester_relationship: 'user',
        additional_official_urls: []
      });
    }
  });

  it('parses optional URLs and maps every relationship label', () => {
    const parsed = parseReviewRequestIssueBody(formBody({
      'Your relationship to the product': 'Creator / Maintainer',
      'Official website / Demo URL': 'https://great-tool.dev',
      'Additional official documentation URLs': 'https://great-tool.dev/docs\nhttps://great-tool.dev/changelog'
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.requester_relationship).toBe('creator_maintainer');
      expect(parsed.request.official_url).toBe('https://great-tool.dev');
      expect(parsed.request.additional_official_urls).toEqual([
        'https://great-tool.dev/docs',
        'https://great-tool.dev/changelog'
      ]);
    }

    for (const [label, expected] of [['Contributor', 'contributor'], ['User', 'user'], ['Other', 'other']] as const) {
      const result = parseReviewRequestIssueBody(formBody({ 'Your relationship to the product': label }));
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.request.requester_relationship).toBe(expected);
    }
  });

  it('collapses multi-line purposes into a single normalized line', () => {
    const parsed = parseReviewRequestIssueBody(formBody({
      'One-sentence purpose': 'A tool that does things\nacross multiple   lines of text.'
    }));
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.request.purpose).toBe('A tool that does things across multiple lines of text.');
    }
  });

  it('rejects a missing or empty body', () => {
    expect(parseReviewRequestIssueBody(null)).toEqual({ ok: false, code: 'issue_body_missing' });
    expect(parseReviewRequestIssueBody('   ')).toEqual({ ok: false, code: 'issue_body_missing' });
  });

  it('rejects an oversized body', () => {
    const parsed = parseReviewRequestIssueBody(formBody() + '\n' + 'x'.repeat(60001));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('issue_body_too_large');
  });

  it('rejects bodies missing a required section (e.g. a hand-written issue)', () => {
    const handWritten = 'Please review my tool: https://github.com/owner/great-tool — thanks!';
    const parsed = parseReviewRequestIssueBody(handWritten);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('form_section_missing');

    const missingPurpose = parseReviewRequestIssueBody(formBody({ 'One-sentence purpose': null }));
    expect(missingPurpose.ok).toBe(false);
    if (!missingPurpose.ok) expect(missingPurpose.code).toBe('form_section_missing');
  });

  it('rejects duplicated sections (edited to be ambiguous)', () => {
    const body = formBody() + '\n\n### Product name\n\nSecond Name';
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('form_section_duplicated');
  });

  it('rejects an unchecked acknowledgement', () => {
    const parsed = parseReviewRequestIssueBody(formBody({
      'Acknowledgement': '- [ ] I understand this request is a public GitHub Issue.'
    }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('acknowledgement_missing');
  });

  it('rejects a required field edited to _No response_ or emptiness', () => {
    const parsed = parseReviewRequestIssueBody(formBody({ 'Product name': '_No response_' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('form_field_invalid');
  });

  it('rejects unsupported or malformed URLs after edits', () => {
    for (const url of [
      'https://gitlab.com/owner/project',
      'http://github.com/owner/project',
      'https://evil.example/github.com/owner/project',
      'not a url'
    ]) {
      const parsed = parseReviewRequestIssueBody(formBody({ 'Canonical public repository URL': url }));
      expect(parsed.ok).toBe(false);
      if (!parsed.ok) expect(parsed.code).toBe('form_field_invalid');
    }
  });

  it('rejects more than five additional URLs', () => {
    const urls = Array.from({ length: 6 }, (_, i) => `https://great-tool.dev/docs/${i}`).join('\n');
    const parsed = parseReviewRequestIssueBody(formBody({ 'Additional official documentation URLs': urls }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('form_field_invalid');
  });

  it('rejects purpose and product-name bound violations', () => {
    const shortPurpose = parseReviewRequestIssueBody(formBody({ 'One-sentence purpose': 'too short' }));
    expect(shortPurpose.ok).toBe(false);

    const longName = parseReviewRequestIssueBody(formBody({ 'Product name': 'x'.repeat(121) }));
    expect(longName.ok).toBe(false);
  });

  it('treats an unknown relationship label as invalid', () => {
    const parsed = parseReviewRequestIssueBody(formBody({ 'Your relationship to the product': 'Investor' }));
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('form_field_invalid');
  });

  it('ignores content before the first section and markdown noise around values', () => {
    const body = 'Some free text the requester typed above the form output.\n\n' + formBody();
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(true);
  });
});
