/**
 * Choosing a representative source file to collect as evidence.
 *
 * The original detector recognised a fixed handful of JavaScript/TypeScript/Go/Python entry
 * filenames at or near the repository root. Every V3 review to date came back with zero source
 * evidence as a result — not because the projects had no source, but because they were Rust or
 * C, or kept their code under crates/<name>/src, cmd/<name> or internal/. A downstream rule
 * that reads "no source evidence" as "technical quality cannot be assessed" is only meaningful
 * if the absence reflects the project rather than this function's blind spots.
 *
 * Selection works over the repository's full file tree (one recursive listing), so it sees the
 * whole layout at once instead of guessing a path to walk. Walking one branch per level was
 * tried first and is too fragile: a Rust workspace's alphabetically-first crate is often a
 * build/proto helper with no core source, and the walk would settle there or miss entirely.
 */

/** Source extensions across the languages JuryPress actually encounters. */
const SOURCE_EXTENSIONS = [
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.go', '.py', '.rs', '.rb', '.php', '.java', '.kt', '.kts', '.scala',
  '.c', '.h', '.cc', '.cpp', '.cxx', '.hpp', '.hh',
  '.cs', '.swift', '.m', '.mm', '.zig', '.dart', '.lua', '.ex', '.exs',
  '.hs', '.ml', '.clj', '.jl', '.r', '.sh'
];

/**
 * Conventional entry-point / primary-source basenames, preferred so the collected evidence is
 * representative rather than incidental (a test helper, a generated stub). Case-insensitive.
 */
const ENTRY_BASENAMES = new Set([
  'main', 'index', 'lib', 'app', 'cli', 'mod', 'program', '__main__', 'server', 'core'
]);

/** A path segment named like a project's own source, which lifts a candidate's rank. */
const SOURCE_DIR_SEGMENTS = new Set([
  'src', 'lib', 'source', 'cmd', 'pkg', 'internal', 'app', 'crates', 'core', 'packages'
]);

/**
 * Path segments that mark code as NOT the project's own implementation: tests, examples,
 * vendored or generated trees, build output. A file under any of these is skipped, so
 * "no source" cannot be satisfied by a test fixture or a bundled dependency.
 */
const EXCLUDED_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'e2e',
  'example', 'examples', 'sample', 'samples', 'demo', 'demos',
  'bench', 'benches', 'benchmark', 'benchmarks', 'fixtures', 'fixture', 'testdata',
  'third_party', 'third-party', 'vendor', 'vendored', 'node_modules',
  'target', 'dist', 'build', 'out', 'bin', 'generated', 'gen', '.git', 'docs', 'doc'
]);

export interface RepoEntry {
  name: string;
  path: string;
  type: 'file' | 'dir' | string;
}

function extensionOf(name: string): string {
  const base = name.slice(name.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return dot <= 0 ? '' : base.slice(dot).toLowerCase();
}

function basenameWithoutExt(pathOrName: string): string {
  const base = pathOrName.slice(pathOrName.lastIndexOf('/') + 1);
  const dot = base.lastIndexOf('.');
  return (dot <= 0 ? base : base.slice(0, dot)).toLowerCase();
}

function isSourcePath(path: string): boolean {
  return SOURCE_EXTENSIONS.includes(extensionOf(path));
}

/** Segments of a path except the filename, lower-cased. */
function dirSegments(path: string): string[] {
  return path.split('/').slice(0, -1).map(s => s.toLowerCase());
}

function isExcluded(path: string): boolean {
  return dirSegments(path).some(seg => EXCLUDED_SEGMENTS.has(seg));
}

/**
 * A representative source file from a full repository tree (an array of blob paths), or null
 * when the tree holds no project source. Ranking, highest first:
 *   1. a conventional entry-point basename (main, lib, index…)
 *   2. living under a source directory (src, crates, cmd…)
 *   3. shallower path, then lexical order — so the choice is deterministic per repository.
 */
export function pickSourceFromTree(paths: readonly string[]): string | null {
  const candidates = paths.filter(p => isSourcePath(p) && !isExcluded(p));
  if (candidates.length === 0) return null;

  const score = (path: string): number => {
    let s = 0;
    if (ENTRY_BASENAMES.has(basenameWithoutExt(path))) s += 100;
    if (dirSegments(path).some(seg => SOURCE_DIR_SEGMENTS.has(seg))) s += 50;
    s -= path.split('/').length; // prefer shallower
    return s;
  };

  return [...candidates].sort((a, b) => {
    const diff = score(b) - score(a);
    if (diff !== 0) return diff;
    if (a.length !== b.length) return a.length - b.length;
    return a.localeCompare(b);
  })[0];
}

/**
 * A source file directly in one directory listing — the root fast path, so a project that
 * keeps code at its top level needs no extra tree request. Prefers a conventional entry point.
 */
export function pickSourceFile(entries: readonly RepoEntry[]): RepoEntry | null {
  const sourceFiles = entries.filter(e => e.type === 'file' && isSourcePath(e.name));
  if (sourceFiles.length === 0) return null;
  const entryPoint = sourceFiles.find(f => ENTRY_BASENAMES.has(basenameWithoutExt(f.name)));
  return entryPoint ?? [...sourceFiles].sort((a, b) => a.name.localeCompare(b.name))[0];
}

/** A root-level source file, when the project keeps code at its top level. */
export function pickRootSourceFile(rootEntries: readonly RepoEntry[]): RepoEntry | null {
  return pickSourceFile(rootEntries);
}
