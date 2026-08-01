import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/**
 * Static guarantees about the shadow CLI.
 *
 * Shadow generation's whole claim is that it measures without touching anything. That claim has
 * to hold against the CLI's own arguments, not just against the workflow that happens to call
 * it correctly — a guarantee that depends on the caller is not a guarantee.
 */
describe('shadow generation cannot reach production', () => {
  const source = readFileSync('scripts/shadow-generate.ts', 'utf8');

  it('refuses an --out directory inside the content repository', () => {
    expect(source).toContain('function assertOutsideContentRoot');
    // Called before anything is generated, so a mistyped path fails before the model is
    // invoked rather than after the quota is spent.
    const callIndex = source.indexOf('assertOutsideContentRoot(args.outDir');
    const generateIndex = source.indexOf('evaluator.generateRaw');
    expect(callIndex).toBeGreaterThan(-1);
    expect(callIndex).toBeLessThan(generateIndex);
  });

  it('compares canonical paths so a symlink cannot tunnel into production', () => {
    // A lexical check is defeated by an --out that resolves outside the repository but is a
    // link INTO data/. Both sides are canonicalized, and the output directory may not exist
    // yet, so its deepest existing ancestor is the component that gets resolved.
    expect(source).toContain('realpathSync');
    expect(source).toContain('nearestExistingAncestor');
    // `/x/data-scratch` next to `/x/data` must still be allowed; a bare startsWith would
    // reject it and quietly push people toward disabling the check.
    expect(source).toContain('canonicalRoot + path.sep');
  });

  it('re-checks containment after the output directory exists', () => {
    // The first check ran against an ancestor. Re-checking closes the window in which the
    // directory itself could have been created as a symlink in between.
    const checks = source.match(/assertOutsideContentRoot\(args\.outDir, contentRoot\)/g) ?? [];
    expect(checks.length).toBe(2);
  });

  it('scans every artifact for credential values before writing it', () => {
    // Artifacts are uploaded and downloaded by a human, so they get the record store's guard
    // rather than a weaker one — and the raw model response is the one thing nobody authored.
    expect(source).toContain('assertNoSecretsInArtifact(name, serialized)');
    expect(source).toContain('SECRET_ENV_VARS');
  });

  it('writes every artifact under the validated output directory', () => {
    // The only write helper resolves against args.outDir; nothing else composes a write path.
    expect(source).toContain('path.join(args.outDir, name)');
    const writeCalls = source.match(/fs\.(writeFileSync|mkdirSync|rmSync|appendFileSync)\(/g) ?? [];
    // writeFileSync + mkdirSync in the artifact writer, mkdtempSync/mkdirSync/rmSync for the
    // throwaway validation root, appendFileSync for the Actions summary. No other writers.
    expect(writeCalls.length).toBeLessThanOrEqual(8);
  });

  it('validates content against a throwaway root, never the real one', () => {
    expect(source).toContain('mkdtempSync');
    expect(source).toContain('validateAndPersist({ contentRoot: scratchRoot');
    // The real content root is never passed to anything that writes.
    expect(source).not.toMatch(/writeRecord\(\s*contentRoot/);
    expect(source).not.toMatch(/validateAndPersist\(\{\s*contentRoot,/);
  });

  it('never publishes and never re-runs Gemini', () => {
    // Imports only: the file explains what it refuses to do by naming it, so a check that
    // cannot tell an explanation from a call would fail on its own documentation.
    const imports = source.match(/^\s*import[\s\S]*?from\s+'[^']+';/gm)?.join('\n') ?? '';
    expect(imports).not.toContain('publishRecord');
    expect(imports).not.toContain('generation/publish');
    expect(source).not.toMatch(/publishRecord\(/);
    // The Gemini side of the comparison is the response already on the record.
    expect(source).toContain("provider === 'gemini'");
    expect(source).toContain('requires a non-Gemini provider');
  });
});
