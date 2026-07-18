import { describe, it, expect } from 'vitest';
import {
  buildIssueBody,
  buildIssueTitle,
  escapeMarkdown,
  parseReviewRequestIssueBody
} from '../../src/lib/review-requests/issue-body';
import { REVIEW_REQUEST_BLOCK_MARKER } from '../../src/config/review-requests';
import type { ReviewRequestBlock } from '../../src/schemas/review-request';

const baseBlock: ReviewRequestBlock = {
  schema_version: '1.0.0',
  request_id: '7f9c1c3a-2f6e-4a44-9d3c-2b1f5a8e9d10',
  product_name: 'Great Tool',
  canonical_repository_url: 'https://github.com/owner/great-tool',
  official_url: 'https://great-tool.dev',
  purpose: 'A command-line tool that automates dependency updates safely.',
  requester_relationship: 'user',
  additional_official_urls: ['https://great-tool.dev/docs']
};

describe('buildIssueTitle', () => {
  it('uses the [Review Request] prefix', () => {
    expect(buildIssueTitle('Great Tool')).toBe('[Review Request] Great Tool');
  });
});

describe('buildIssueBody / parseReviewRequestIssueBody round trip', () => {
  it('round-trips a valid request through the machine-readable block', () => {
    const body = buildIssueBody(baseBlock);
    expect(body).toContain('## Product');
    expect(body).toContain('## Request Notice');
    expect(body.split(REVIEW_REQUEST_BLOCK_MARKER).length - 1).toBe(1);

    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.block).toEqual(baseBlock);
    }
  });

  it('neutralizes markdown and HTML-comment injection in requester text', () => {
    const hostile: ReviewRequestBlock = {
      ...baseBlock,
      // "-->" would terminate the HTML comment early; "## " would forge a heading;
      // shell metacharacters must survive as inert text.
      product_name: 'Tool --> <img src=x> `rm -rf` $(evil) ## Fake Heading',
      purpose: 'It does things; also | && $(injection) <!-- sneaky comment attempt here -->.'
    };
    const body = buildIssueBody(hostile);

    // The human-readable section must not contain a raw comment terminator or heading
    // from user text: every markdown-significant character is escaped or HTML-encoded.
    const humanSection = body.slice(0, body.indexOf(`<!-- ${REVIEW_REQUEST_BLOCK_MARKER}`));
    expect(humanSection).not.toContain('-->');
    expect(humanSection).not.toContain('<img');
    expect(humanSection).not.toMatch(/^## Fake Heading/m);

    // The machine block still terminates exactly once and round-trips the raw values.
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(true);
    if (parsed.ok) {
      expect(parsed.block.product_name).toBe(hostile.product_name);
      expect(parsed.block.purpose).toBe(hostile.purpose);
    }
  });

  it('escapeMarkdown escapes heading, link and emphasis characters', () => {
    const escaped = escapeMarkdown('# Head [link](https://x.dev) *bold* <b>');
    expect(escaped).not.toMatch(/^# /);
    expect(escaped).toContain('\\[');
    expect(escaped).toContain('\\*');
    expect(escaped).toContain('&lt;b&gt;');
  });
});

describe('parseReviewRequestIssueBody failure modes', () => {
  it('rejects a missing body', () => {
    expect(parseReviewRequestIssueBody(null)).toEqual({ ok: false, code: 'issue_body_missing' });
    expect(parseReviewRequestIssueBody('   ')).toEqual({ ok: false, code: 'issue_body_missing' });
  });

  it('rejects an oversized body', () => {
    const body = buildIssueBody(baseBlock) + '\n' + 'x'.repeat(60001);
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('issue_body_too_large');
  });

  it('rejects a body with no machine block, even with forged headings', () => {
    const forged = ['## Product', '', 'Fake Product', '', '## Canonical Repository', '', 'https://github.com/x/y'].join('\n');
    const parsed = parseReviewRequestIssueBody(forged);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('machine_block_missing');
  });

  it('rejects multiple machine blocks', () => {
    const body = buildIssueBody(baseBlock) + '\n' + buildIssueBody(baseBlock);
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('machine_block_multiple');
  });

  it('rejects malformed JSON in the block', () => {
    const body = `<!-- ${REVIEW_REQUEST_BLOCK_MARKER}\n{ not json\n-->`;
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('machine_block_malformed');
  });

  it('rejects an unsupported schema version', () => {
    const payload = JSON.stringify({ ...baseBlock, schema_version: '9.0.0' });
    const body = `<!-- ${REVIEW_REQUEST_BLOCK_MARKER}\n${payload}\n-->`;
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('machine_block_unsupported_version');
  });

  it('rejects missing or invalid required fields', () => {
    const { purpose, ...withoutPurpose } = baseBlock;
    const body = `<!-- ${REVIEW_REQUEST_BLOCK_MARKER}\n${JSON.stringify(withoutPurpose)}\n-->`;
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('machine_block_invalid_fields');
  });

  it('rejects an edited block whose canonical URL became unsupported', () => {
    const payload = JSON.stringify({ ...baseBlock, canonical_repository_url: 'https://gitlab.com/x/y' });
    const body = `<!-- ${REVIEW_REQUEST_BLOCK_MARKER}\n${payload}\n-->`;
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('machine_block_invalid_fields');
  });

  it('rejects unknown keys added by later edits (strict schema)', () => {
    const payload = JSON.stringify({ ...baseBlock, injected_key: 'x' });
    const body = `<!-- ${REVIEW_REQUEST_BLOCK_MARKER}\n${payload}\n-->`;
    const parsed = parseReviewRequestIssueBody(body);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.code).toBe('machine_block_invalid_fields');
  });
});
