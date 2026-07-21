import { describe, it, expect } from 'vitest';
import {
  pickSourceFile,
  pickRootSourceFile,
  pickSourceFromTree,
  pickSourceFilesFromTree,
  countSourceFiles,
  type RepoEntry
} from '../../src/lib/evidence/source-detection';

const file = (name: string, path = name): RepoEntry => ({ name, path, type: 'file' });
const dir = (name: string): RepoEntry => ({ name, path: name, type: 'dir' });

/**
 * The failure this fixes: every V3 review came back with zero source evidence because the old
 * detector knew only a few JS/TS/Go/Python entry filenames at the root. The load-bearing cases
 * are the languages and layouts it missed — Rust, C, and code under crates/<name>/src or cmd/.
 */

describe('pickSourceFile (root fast path)', () => {
  it('finds a Rust source file the old detector could not', () => {
    expect(pickSourceFile([file('Cargo.toml'), file('main.rs'), file('README.md')])?.name)
      .toBe('main.rs');
  });

  it.each([
    ['C', 'main.c'], ['C++', 'app.cpp'], ['Java', 'Main.java'],
    ['Ruby', 'app.rb'], ['C#', 'Program.cs'], ['Swift', 'main.swift'], ['Zig', 'main.zig']
  ])('recognises %s source (%s)', (_lang, name) => {
    expect(pickSourceFile([file(name), file('README.md')])?.name).toBe(name);
  });

  it('prefers a conventional entry point over an incidental source file', () => {
    expect(pickSourceFile([file('a_helper.rs'), file('lib.rs'), file('z_util.rs')])?.name).toBe('lib.rs');
  });

  it('is deterministic when there is no entry point', () => {
    expect(pickSourceFile([file('zebra.go'), file('alpha.go')])?.name).toBe('alpha.go');
  });

  it('ignores non-source files and directories', () => {
    expect(pickSourceFile([file('README.md'), file('Cargo.toml'), { name: 'main.rs', path: 'main.rs', type: 'dir' }]))
      .toBeNull();
  });
});

describe('pickRootSourceFile', () => {
  it('finds top-level code', () => {
    expect(pickRootSourceFile([file('main.go'), file('go.mod')])?.name).toBe('main.go');
  });

  it('returns null when code is only in subdirectories, deferring to the tree probe', () => {
    expect(pickRootSourceFile([dir('crates'), file('Cargo.toml')])).toBeNull();
  });
});

describe('pickSourceFromTree', () => {
  it('reaches Rust workspace source the directory walk could not', () => {
    // The grok-build shape: crates/build is a proto helper (alphabetically first, so a
    // one-branch walk settled there); the core crate is deeper.
    const tree = [
      'Cargo.toml',
      'README.md',
      'crates/build/xai-proto-build/build.rs',
      'crates/common/src/lib.rs',
      'crates/tui/src/main.rs'
    ];
    // Seeing the whole tree, an entry-point (main.rs/lib.rs) under a source dir wins over the
    // build helper — regardless of alphabetical order.
    expect(pickSourceFromTree(tree)).toMatch(/crates\/(common\/src\/lib|tui\/src\/main)\.rs/);
    expect(pickSourceFromTree(tree)).not.toContain('xai-proto-build');
  });

  it('prefers an entry point under a source directory', () => {
    const tree = ['pkg/util/helper.go', 'cmd/server/main.go', 'internal/db/conn.go'];
    expect(pickSourceFromTree(tree)).toBe('cmd/server/main.go');
  });

  it('excludes tests, examples, vendored and generated trees', () => {
    // "No source" must not be satisfiable by a test fixture or a bundled dependency.
    const tree = [
      'tests/integration_test.rs',
      'examples/demo.rs',
      'third_party/lib/foo.rs',
      'vendor/dep/bar.go',
      'target/debug/build.rs',
      'src/lib.rs'
    ];
    expect(pickSourceFromTree(tree)).toBe('src/lib.rs');
  });

  it('returns null when the tree holds only tests and vendored code', () => {
    const tree = ['tests/a_test.py', 'node_modules/x/index.js', 'examples/e.py'];
    expect(pickSourceFromTree(tree)).toBeNull();
  });

  it('returns null when the tree has no source at all', () => {
    expect(pickSourceFromTree(['README.md', 'LICENSE', 'docs/guide.md', 'Cargo.toml'])).toBeNull();
  });

  it('prefers a shallower path when scores tie', () => {
    const tree = ['a/b/c/util.rs', 'util.rs'];
    expect(pickSourceFromTree(tree)).toBe('util.rs');
  });

  it('does not treat a dotfile with no extension as source', () => {
    expect(pickSourceFromTree(['.gitignore', 'src/.keep'])).toBeNull();
  });
});

describe('countSourceFiles', () => {
  it('counts the project source, excluding tests, examples and vendored trees', () => {
    const tree = [
      'src/lib.rs', 'src/rtsp.rs', 'src/session/app.rs',
      'tests/it.rs', 'examples/demo.rs', 'third_party/x.rs',
      'README.md', 'Cargo.toml'
    ];
    // 3 real source files; tests/examples/third_party and non-source excluded.
    expect(countSourceFiles(tree)).toBe(3);
  });

  it('is zero for a repo with no source', () => {
    expect(countSourceFiles(['README.md', 'LICENSE', 'docs/g.md'])).toBe(0);
  });
});

describe('countSourceFiles excludes ancillary scripts from the coverage denominator', () => {
  it('does not count build/deploy shell scripts as core source', () => {
    // The confirmed bug: a Go service whose whole implementation is main.go, shipping deploy
    // scripts, was reported as "1 of 4 source files examined" and wrongly capped. Core = 1.
    expect(countSourceFiles(['main.go', 'deploy.sh', 'build.sh', 'ci.sh'])).toBe(1);
  });

  it('still counts real multi-language source', () => {
    expect(countSourceFiles(['a.go', 'b.rs', 'c.py'])).toBe(3);
  });

  it('leaves a shell script pickable so a pure-shell repo still yields source evidence', () => {
    // .sh is excluded from the COUNT but kept in the PICK pool.
    expect(pickSourceFromTree(['setup.sh', 'run.sh'])).not.toBeNull();
    expect(countSourceFiles(['setup.sh', 'run.sh'])).toBe(0); // -> coverage-unknown, fail open
  });
});

describe('pickSourceFilesFromTree (multi-file for a real coverage numerator)', () => {
  it('returns several representative files, entry points first', () => {
    const tree = ['src/util.rs', 'src/main.rs', 'src/lib.rs', 'README.md'];
    const picked = pickSourceFilesFromTree(tree, 3);
    expect(picked.length).toBe(3);
    expect(picked).toContain('src/main.rs');
    expect(picked).toContain('src/lib.rs');
    expect(picked).not.toContain('README.md');
  });

  it('returns fewer than the limit when the repo has fewer source files', () => {
    expect(pickSourceFilesFromTree(['server.py', 'README.md'], 3)).toEqual(['server.py']);
  });

  it('is empty for a repo with no source', () => {
    expect(pickSourceFilesFromTree(['README.md', 'LICENSE'], 3)).toEqual([]);
  });
})
