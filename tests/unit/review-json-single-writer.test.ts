import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * Structural guarantee (§ publish gate): within the runtime generation/publication pipeline,
 * the ONLY code that writes a review.json is the publish service. Validation and revalidation
 * merely prove the content is buildable; they never materialize a public artifact. This test
 * fails the moment a second writer appears, which is how a "just write review.json and skip
 * the gate" shortcut would otherwise slip in.
 *
 * scripts/bootstrap-initial-content.ts is intentionally excluded: it is a one-time seeder for
 * the pre-existing launch articles, not part of the runtime publish path.
 */
describe('review.json has a single runtime writer', () => {
  const repoRoot = path.join(__dirname, '..', '..');

  const runtimeFiles = [
    'src/lib/generation/publish.ts',
    'src/lib/generation/pipeline.ts',
    'src/lib/generation/validator.ts',
    'src/lib/generation/build-review.ts',
    'src/lib/generation/review-edit.ts',
    'scripts/run-daily.ts',
    'scripts/review.ts',
    'scripts/publish-record.ts'
  ];

  const writesReviewJson = (source: string): boolean => {
    // A filesystem write whose target names review.json, on a single line.
    return source.split('\n').some(line =>
      /writeFileSync|writeFile\(/.test(line) && /review\.json/.test(line)
    );
  };

  it('only publish.ts writes review.json among runtime pipeline files', () => {
    const writers = runtimeFiles.filter(rel =>
      writesReviewJson(fs.readFileSync(path.join(repoRoot, rel), 'utf8'))
    );
    expect(writers).toEqual(['src/lib/generation/publish.ts']);
  });
});
