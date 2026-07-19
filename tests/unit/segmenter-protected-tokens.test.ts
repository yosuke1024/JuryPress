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

  it('does NOT protect a token that is a substring of a larger identifier', () => {
    // A protected token fused into a longer identifier run is not that token — its dot splits.
    // Identifier glue includes letters, digits, underscore and hyphen.
    for (const text of [
      'The package.jsonevil file is suspicious.',
      'The evilpackage.json file is suspicious.',
      'The site freecodecamp.orgevil is a lookalike.',
      'The site evilfreecodecamp.org is a lookalike.',
      'The evil_package.json file is suspicious.',
      'The package.json_evil file is suspicious.',
      'The evil-package.json file is suspicious.',
      'The package.json-evil file is suspicious.'
    ]) {
      expect(segmentStatements(text, ATTESTED).length, text).toBeGreaterThanOrEqual(2);
    }
  });

  it('DOES protect a whole token at a path separator or inside punctuation', () => {
    expect(segmentStatements('The manifest lives at src/package.json in the repo.', ATTESTED)).toHaveLength(1);
    expect(segmentStatements('The manifest (package.json) lists dependencies.', ATTESTED)).toHaveLength(1);
    // Trailing sentence period after a whole token is a boundary, not a fusion.
    expect(segmentStatements('The platform runs at freeCodeCamp.org.', ATTESTED)).toHaveLength(1);
  });
});

describe('segmentStatementsStrict — the explicit adversarial scan (no protection)', () => {
  it('over-splits a dotted token that only attestation can protect', () => {
    // A HOSTNAME still needs an attested token context: nothing about "freeCodeCamp.org" is
    // decidable lexically, so the strict scan splits it. (Well-known repository FILENAMES
    // like package.json are now recognised by name and no longer depend on attestation —
    // see dotted-token-segmentation.test.ts for why that exception exists and how narrow
    // the closed list is.)
    expect(segmentStatementsStrict('The freeCodeCamp.org site is live.')).toEqual([
      'The freeCodeCamp.',
      'org site is live.'
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

  it('attests the canonical/repository URL through its evidence entry (no per-caller URLs)', () => {
    // The repo landing page is itself an evidence URL, so its host/basename are covered by the
    // single evidence loop — no caller adds structuredUrls on top.
    const tokens = buildProtectedTokens([
      evidence({ url: 'https://github.com/freeCodeCamp/freeCodeCamp' })
    ]);
    expect(tokens.has('github.com')).toBe(true);
  });

  it('ignores non-http(s) schemes', () => {
    const tokens = buildProtectedTokens([
      evidence({ url: 'https://api.github.com/repos/o/r', summary: 'ftp://secret.evil.test/x mailto:a@b.test' })
    ]);
    expect(tokens.has('secret.evil.test')).toBe(false);
  });
});
