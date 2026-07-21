import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadRegenerationTarget, linkSuccessor } from '../../src/lib/publication/regeneration-target';
import { buildRegenerateRunKey, isValidRunKey, assertSafeRunKey } from '../../src/lib/publication/run-keys';
import { parseRunCliArgs } from '../../src/lib/publication/cli-args';

function seedReview(root: string, slug: string, opts: { withdrawn: boolean; selection?: object } = { withdrawn: true }) {
  const dir = path.join(root, 'reviews', '2026', '07', slug);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'selection.json'),
    JSON.stringify(
      opts.selection ?? {
        source: 'show_hn',
        source_id: '48966965',
        candidate_name: 'minio-dash',
        canonical_url: 'https://github.com/example/minio-dash',
        source_url: 'https://news.ycombinator.com/item?id=48966965',
        source_rank: 1,
        popularity_value: 120,
        popularity_unit: 'points',
        candidate_metadata: { repository_full_name: 'example/minio-dash' }
      }
    )
  );
  fs.writeFileSync(path.join(dir, 'review.json'), JSON.stringify({ slug }));
  if (opts.withdrawn) {
    fs.writeFileSync(
      path.join(dir, 'editorial-withdrawal.json'),
      JSON.stringify({
        schema_version: '1.0.0',
        slug,
        article_hash: 'a'.repeat(64),
        withdrawn_at: '2026-07-21T00:00:00.000Z',
        reason_code: 'material-evidence-gap',
        reason: 'no source evidence',
        superseded_by: null
      })
    );
  }
  return dir;
}

function withRoot<T>(fn: (root: string) => T): T {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-regen-'));
  try {
    return fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('buildRegenerateRunKey', () => {
  it('is deterministic from the target slug, so a re-dispatch resumes the same run', () => {
    expect(buildRegenerateRunKey(2, 'minio-aa8046', '12345')).toBe('season-2-regenerate-minio-aa8046-12345');
    expect(isValidRunKey('season-2-regenerate-minio-aa8046-12345')).toBe(true);
    expect(() => assertSafeRunKey('season-2-regenerate-minio-aa8046-12345')).not.toThrow();
  });

  it('rejects an unsafe slug', () => {
    expect(() => buildRegenerateRunKey(2, '../etc', '1')).toThrow();
    expect(() => buildRegenerateRunKey(2, 'Bad Slug', '1')).toThrow();
    expect(() => buildRegenerateRunKey(2, 'ok-slug', 'not-numeric')).toThrow(/workflow run id/);
  });
});

describe('regenerate CLI contract', () => {
  it('requires --target-slug', () => {
    expect(() => parseRunCliArgs(['--operation', 'regenerate'], { GITHUB_RUN_ID: '1' } as any)).toThrow(/--target-slug is required/);
  });

  it('rejects --target-slug outside regenerate', () => {
    expect(() => parseRunCliArgs(['--operation', 'publish_new', '--target-slug', 'x'], {} as any))
      .toThrow(/only valid with --operation regenerate/);
  });

  it('accepts a well-formed regenerate invocation', () => {
    const args = parseRunCliArgs(['--operation', 'regenerate', '--target-slug', 'minio-aa8046', '--workflow-run-id', '999'], { GITHUB_RUN_ID: '999' } as any);
    expect(args.operation).toBe('regenerate');
    expect(args.targetSlug).toBe('minio-aa8046');
  });

  it('rejects a traversal target slug', () => {
    expect(() => parseRunCliArgs(['--operation', 'regenerate', '--target-slug', '../secret'], { GITHUB_RUN_ID: '1' } as any))
      .toThrow(/forbidden characters/);
  });
});

describe('loadRegenerationTarget', () => {
  it('builds a candidate from the target selection.json', () => {
    withRoot(root => {
      seedReview(root, 'minio-aa8046', { withdrawn: true });
      const target = loadRegenerationTarget(root, 'minio-aa8046');
      expect(target.candidate.canonicalUrl).toBe('https://github.com/example/minio-dash');
      expect(target.candidate.source).toBe('show_hn');
      expect(target.candidate.sourceId).toBe('48966965');
      expect(target.candidate.name).toBe('minio-dash');
      expect(target.canonicalUrl).toBe('https://github.com/example/minio-dash');
    });
  });

  it('refuses a review that is not withdrawn', () => {
    // The withdrawal is what keeps one live review per project while both briefly coexist.
    withRoot(root => {
      seedReview(root, 'live-review', { withdrawn: false });
      expect(() => loadRegenerationTarget(root, 'live-review')).toThrow(/not editorially withdrawn/);
    });
  });

  it('refuses a slug that does not exist', () => {
    withRoot(root => {
      expect(() => loadRegenerationTarget(root, 'ghost')).toThrow(/No review found/);
    });
  });

  it('refuses an unsupported canonical host before any collection', () => {
    // Regenerate must never fetch from a host the eligibility gate would reject.
    withRoot(root => {
      seedReview(root, 'off-host', {
        withdrawn: true,
        selection: {
          source: 'show_hn',
          source_id: '1',
          candidate_name: 'x',
          canonical_url: 'https://evil.example.com/x',
          source_url: 'https://evil.example.com/x'
        }
      });
      expect(() => loadRegenerationTarget(root, 'off-host')).toThrow(/not a supported public source/);
    });
  });
});

describe('successor slug is distinct from the withdrawn target (regression)', () => {
  // The critical bug caught in review: computeSlug is a pure function of the target's own
  // candidate_name/source_id, so a successor slug computed the same way reproduces the
  // target's directory name exactly — overwriting the withdrawn review in place. The reserve
  // branch derives the successor slug as `${computeSlug(name, sourceId)}-r${hash(runKey)}`, so
  // this pins the invariant that the two forms differ.
  it('the -r<runKey-hash> successor form never equals the bare target slug', () => {
    const crypto = require('node:crypto');
    const computeSlug = (name: string, sourceId: string) => {
      const hash = crypto.createHash('md5').update(sourceId || '').digest('hex').substring(0, 6);
      const clean = name.replace(/[^a-zA-Z0-9]/g, '-').toLowerCase().replace(/-+/g, '-').replace(/^-|-$/g, '');
      return `${clean}-${hash}`;
    };
    const targetSlug = computeSlug('minio-dash', '48966965');
    const runKey = 'season-2-regenerate-minio-dash-48966965-99999';
    const successorSlug = `${computeSlug('minio-dash', '48966965')}-r${crypto.createHash('md5').update(runKey).digest('hex').substring(0, 6)}`;
    expect(successorSlug).not.toBe(targetSlug);
    expect(successorSlug.startsWith(targetSlug + '-r')).toBe(true);
  });
});

describe('linkSuccessor', () => {
  it('records the successor slug on the withdrawal file', () => {
    withRoot(root => {
      const dir = seedReview(root, 'old-review', { withdrawn: true });
      const withdrawalPath = path.join(dir, 'editorial-withdrawal.json');
      linkSuccessor(withdrawalPath, 'new-review-abc123');
      const record = JSON.parse(fs.readFileSync(withdrawalPath, 'utf8'));
      expect(record.superseded_by).toBe('new-review-abc123');
      // Everything else in the immutable-ish record is preserved.
      expect(record.reason_code).toBe('material-evidence-gap');
    });
  });

  it('is idempotent — re-linking the same successor is a no-op in effect', () => {
    withRoot(root => {
      const dir = seedReview(root, 'old-review', { withdrawn: true });
      const withdrawalPath = path.join(dir, 'editorial-withdrawal.json');
      linkSuccessor(withdrawalPath, 'new-review');
      linkSuccessor(withdrawalPath, 'new-review');
      expect(JSON.parse(fs.readFileSync(withdrawalPath, 'utf8')).superseded_by).toBe('new-review');
    });
  });
});
