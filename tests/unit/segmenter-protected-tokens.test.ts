import { describe, it, expect } from 'vitest';
import {
  segmentStatements,
  segmentStatementsStrict,
  buildProtectedTokens,
  EMPTY_PROTECTED_TOKENS,
  type ProtectedTokens
} from '../../src/lib/evaluation/public-claims';
import type { Evidence } from '../../src/schemas/evidence';

// A realistic attested context: the evidence-derived technical tokens for a typical repo. None
// of the adversarial "split" fixtures below appear here, so they must still fail closed.
const ATTESTED: ProtectedTokens = new Set([
  'package.json',
  'readme.md',
  'pyproject.toml',
  'freecodecamp.org',
  'example.com'
]);

describe('segmentStatements — protected technical tokens do NOT split', () => {
  it.each([
    ['package.json', 'The package.json file lists TypeScript, Turborepo, and pnpm workspaces.'],
    ['README.md', 'The README.md file documents the setup steps for contributors.'],
    ['pyproject.toml', 'The pyproject.toml file pins the supported Python versions.'],
    ['freeCodeCamp.org', 'The platform is running live at freeCodeCamp.org today.'],
    ['path URL', 'Docs live at https://example.com/docs/guide for reference.']
  ])('keeps a statement containing %s as one segment', (_label, text) => {
    expect(segmentStatements(text, ATTESTED)).toHaveLength(1);
  });

  it('still keeps decimals/versions single (independent of protected tokens)', () => {
    expect(segmentStatements('The jury scored it 3.5 out of 5.', ATTESTED)).toHaveLength(1);
    expect(segmentStatements('It requires v1.2 or later.', ATTESTED)).toHaveLength(1);
    // And with no tokens at all — the decimal guard is not token-dependent.
    expect(segmentStatements('The jury scored it 3.5 out of 5.', EMPTY_PROTECTED_TOKENS)).toHaveLength(1);
  });
});

describe('segmentStatements — unattested boundaries STILL split (fail closed)', () => {
  it.each([
    ['claim.It (capital)', 'claim.It has been verified.', 2],
    ['claim.it (lowercase)', 'claim.it has been verified.', 2],
    ['Claim one.Claim two.', 'Claim one.Claim two.', 2],
    ['Claim one.false claim follows.', 'Claim one.false claim follows.', 2],
    ['verified.42 tests passed.', 'verified.42 tests passed.', 2]
  ])('splits %s even with a full attested context', (_label, text, count) => {
    expect(segmentStatements(text, ATTESTED)).toHaveLength(count);
  });

  it('cannot launder a trailing assertion fused to a real word', () => {
    const segs = segmentStatements('The tests passed.it also exposed user data.', ATTESTED);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    // The smuggled assertion is its own statement and would need its own annotation.
    expect(segs.some(s => /it also exposed user data/.test(s))).toBe(true);
  });

  it('protects only INTERIOR dots — the dot after a token still splits', () => {
    // "README.md.The next sentence" — the internal ".", protected; the trailing ".", a boundary.
    const segs = segmentStatements('It uses README.md.The next sentence smuggles a claim.', ATTESTED);
    expect(segs.length).toBeGreaterThanOrEqual(2);
    expect(segs.some(s => /The next sentence smuggles a claim/.test(s))).toBe(true);
  });

  it('a lookalike token the model merely typed is not attested', () => {
    // "invoice.pdf" is not in ATTESTED → its dot splits, so any fused assertion fails closed.
    expect(segmentStatements('See invoice.pdf.All numbers are audited.', ATTESTED).length).toBeGreaterThanOrEqual(2);
  });
});

describe('segmentStatementsStrict — the explicit adversarial scan (no protection)', () => {
  it('reproduces the original over-split bug for a dotted token', () => {
    // This is exactly why the record failed: with no token context, package.json over-splits.
    expect(segmentStatementsStrict('The package.json file lists dependencies.')).toEqual([
      'The package.',
      'json file lists dependencies.'
    ]);
  });

  it('equals segmentStatements(text, EMPTY_PROTECTED_TOKENS)', () => {
    const text = 'The freeCodeCamp.org site is live. It could not be verified.';
    expect(segmentStatementsStrict(text)).toEqual(segmentStatements(text, EMPTY_PROTECTED_TOKENS));
  });
});

// --- buildProtectedTokens: the single application-owned source, restricted inputs -----------

function evidence(partial: Partial<Evidence> & { url: string }): Evidence {
  return {
    evidence_id: partial.evidence_id ?? 'ev-1',
    type: partial.type ?? 'source_file',
    url: partial.url,
    title: partial.title ?? 'title',
    retrieved_at: '2026-07-18T00:00:00.000Z',
    content_hash: 'hash',
    summary: partial.summary ?? '',
    claims: partial.claims ?? []
  };
}

describe('buildProtectedTokens — restricted, attested sources only', () => {
  it('takes the basename AND hostname of a structured evidence URL', () => {
    const tokens = buildProtectedTokens([
      evidence({ url: 'https://raw.githubusercontent.com/freeCodeCamp/freeCodeCamp/main/package.json' })
    ]);
    expect(tokens.has('package.json')).toBe(true);
    expect(tokens.has('raw.githubusercontent.com')).toBe(true);
  });

  it('takes body-URL hostnames and the www-stripped derivative, but NOT body basenames', () => {
    const tokens = buildProtectedTokens([
      evidence({
        url: 'https://api.github.com/repos/o/r',
        summary: 'The platform runs at https://www.freecodecamp.org/learn and ships https://cdn.example.com/lib/thing.min.js.'
      })
    ]);
    expect(tokens.has('www.freecodecamp.org')).toBe(true);
    expect(tokens.has('freecodecamp.org')).toBe(true); // www-stripped derivative
    expect(tokens.has('cdn.example.com')).toBe(true);   // body URL hostname
    expect(tokens.has('thing.min.js')).toBe(false);     // body URLs do NOT contribute basenames
  });

  it('does NOT treat a bare foo.bar in prose as a domain', () => {
    const tokens = buildProtectedTokens([
      evidence({
        url: 'https://api.github.com/repos/o/r',
        summary: 'The config.local file and the my.example handle are mentioned, but not as URLs.'
      })
    ]);
    expect(tokens.has('config.local')).toBe(false);
    expect(tokens.has('my.example')).toBe(false);
  });

  it('includes caller-supplied structured URLs (e.g. canonical repo URL)', () => {
    const tokens = buildProtectedTokens([], { structuredUrls: ['https://www.freecodecamp.org/'] });
    expect(tokens.has('www.freecodecamp.org')).toBe(true);
    expect(tokens.has('freecodecamp.org')).toBe(true);
  });

  it('ignores non-http(s) schemes', () => {
    const tokens = buildProtectedTokens([
      evidence({ url: 'https://api.github.com/repos/o/r', summary: 'ftp://secret.evil.test/x mailto:a@b.test' })
    ]);
    expect(tokens.has('secret.evil.test')).toBe(false);
  });
});
