import { describe, it, expect } from 'vitest';
import { assertLosslessSegmentation, segmentStatementsStrict } from '../../src/lib/evaluation/public-claims';

/**
 * Dotted technical tokens must not be read as sentence ends.
 *
 * The attested-token mask only protects dots INTERIOR to a token that the evidence names, so
 * two very common shapes in open-source reviews were split mid-sentence and failed
 * CLAIM_STATEMENT_UNMATCHED — the model annotates one sentence, the segmenter produced three:
 *
 *   - a dotfile's LEADING dot (".gitignore"), which the interior-only mask can never cover
 *     even when the file is attested;
 *   - a filename the review says is ABSENT ("no SECURITY.md is present"), which by definition
 *     cannot appear in the collected evidence and so can never be attested.
 *
 * Both are now decided lexically. The tests below pin the fix AND the anti-evasion boundary
 * it must not cross: a real sentence boundary still splits, so two reader-visible sentences
 * can never merge into one statement and ride a single annotation.
 */

describe('dotted technical tokens are not sentence boundaries', () => {
  const ONE_STATEMENT: Array<[label: string, text: string]> = [
    ['leading-dot dotfiles (the season-2-manual-29667424637 failure)',
      'Support for standard .gitignore and .ignore patterns ensures the tool integrates naturally with developer workflows.'],
    ['an absent file the evidence cannot attest (the season-2-2026-07-18-daily failure)',
      'The API metadata reports that no SECURITY.md or security policy is currently present in the repository.'],
    ['a manifest filename', 'The package.json file shows that the project utilizes TypeScript.'],
    ['several dotted tokens at once', 'Configuration lives in .env and Cargo.toml files.'],
    ['a dot directory', 'The .github directory contains a CI workflow.'],
    ['an uppercase known filename', 'The README.MD file documents the install steps.'],
    ['a known filename ending the sentence', 'The project uses package.json.'],
    ['a decimal version', 'Version 3.5 is stable.']
  ];

  it.each(ONE_STATEMENT)('stays one statement: %s', (_label, text) => {
    expect(segmentStatementsStrict(text)).toEqual([text]);
  });

  // The widening must not let a real boundary hide — that is the property the whole
  // statement-coverage contract rests on.
  const STILL_SPLITS: Array<[label: string, text: string]> = [
    ['a normal sentence boundary', 'The tool is fast. It also scales well.'],
    ['no space after the terminator', 'The score is high.The risk is low.'],
    ['the classic smuggling shape', 'The tool passed.it also exposed data'],
    ['a space BEFORE the dot with a space after', 'One claim . Another claim'],
    ['an unknown extension is not protected', 'The build failed.zz something else happened'],
    ['a filename-shaped token that is not a known repo file', 'The claim is false.json the tool is safe'],
    ['an identifier riding on a known filename', 'The evilpackage.json file is suspicious.'],
    ['a known filename glued to a larger identifier', 'The package.json-evil file is suspicious.'],
    ['a question boundary', 'Is it maintained? The evidence says yes.']
  ];

  it.each(STILL_SPLITS)('still splits: %s', (_label, text) => {
    expect(segmentStatementsStrict(text).length).toBeGreaterThan(1);
  });

  // The codebase's own losslessness invariant, which holds for well-formed prose (the
  // no-space smuggling shapes normalize a space in by design, so they are out of its domain).
  it('keeps segmentation lossless for well-formed prose', () => {
    const wellFormed = [
      ...ONE_STATEMENT.map(([, text]) => text),
      'The tool is fast. It also scales well.',
      'Is it maintained? The evidence says yes.'
    ];
    for (const text of wellFormed) {
      expect(() => assertLosslessSegmentation(text)).not.toThrow();
    }
  });
});
