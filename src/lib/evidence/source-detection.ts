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

import { CLAIM_DOMAINS } from './claim-domains';

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
 * Whether a directory segment names the project's own source. Qualified forms count too:
 * `skill-src`, `app_src` and the like are the same convention with a prefix, and missing them
 * left "AI 短劇編劇" ranking its validation-output dumps above the skill definition in
 * `skill-src/` that the review was actually about.
 */
function isSourceDirSegment(segment: string): boolean {
  return SOURCE_DIR_SEGMENTS.has(segment)
    || segment.endsWith('-src') || segment.endsWith('_src')
    || segment.endsWith('-source') || segment.endsWith('_source');
}

/**
 * Path segments that mark code as NOT the project's own implementation: tests, examples,
 * vendored or generated trees, build output. A file under any of these is skipped, so
 * "no source" cannot be satisfied by a test fixture or a bundled dependency.
 *
 * `.github` belongs here for the same reason: no project's implementation lives in its
 * repository-automation directory. It was inert while only code extensions were recognised
 * and matters now that prose can be, below — a documentation project's CI workflow is not
 * the thing being reviewed.
 */
const EXCLUDED_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'e2e',
  'example', 'examples', 'sample', 'samples', 'demo', 'demos',
  'bench', 'benches', 'benchmark', 'benchmarks', 'fixtures', 'fixture', 'testdata',
  'third_party', 'third-party', 'vendor', 'vendored', 'node_modules',
  'target', 'dist', 'build', 'out', 'bin', 'generated', 'gen', '.git', '.github', 'docs', 'doc'
]);

/**
 * Extensions that carry the implementation of a project that ships no code at all — a prompt
 * pack, an agent skill, a spec or rule collection. For those the prose IS the deliverable, and
 * how it is organised (workflow separated from format rules separated from checklists) is
 * precisely what technical quality means for them.
 *
 * Consulted ONLY for a tree with no code file anywhere (see isProseNativeTree). This
 * restriction is the whole safety property: a normal project's README, design notes and CI
 * YAML must never register as source, because "no source evidence" is what makes technical
 * quality Not Assessable, and a rule that anything can satisfy stops meaning anything.
 */
const PROSE_SOURCE_EXTENSIONS = ['.md', '.mdx', '.rst', '.adoc', '.yaml', '.yml'];

/**
 * The documents a repository carries to describe itself. They are about the project rather
 * than being it, so they never count as implementation — README above all: it is already
 * collected as its own evidence kind, and admitting it here would hand every documentation
 * repository a "source file" it does not have.
 */
const REPO_META_BASENAMES = new Set([
  'readme', 'license', 'licence', 'copying', 'notice', 'changelog', 'changes', 'history',
  'contributing', 'code_of_conduct', 'security', 'support', 'governance', 'maintainers',
  'authors', 'owners', 'roadmap'
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

function isProseSourcePath(path: string): boolean {
  return PROSE_SOURCE_EXTENSIONS.includes(extensionOf(path))
    && !REPO_META_BASENAMES.has(basenameWithoutExt(path));
}

/**
 * Whether this repository's implementation is its prose.
 *
 * True only when the tree holds NO code file at all — not "no code outside tests", but none
 * anywhere, exclusions included. A project whose only .ts sits under tests/ is still a code
 * project that organised itself unusually, and judging it on its Markdown would describe
 * something other than what it is.
 *
 * The 2026-08-29 case this exists for: "AI 短劇編劇", a Codex skill of 17 Markdown files and
 * one agent YAML. It had no source by the code-extension list, so technical quality was ruled
 * Not Assessable and the review published unscored — while the judges were, in the same
 * article, assessing exactly that: how its workflow, format rules and checklists are separated.
 * The absence has to reflect the project, not the extension list's blind spots.
 */
export function isProseNativeTree(paths: readonly string[]): boolean {
  if (paths.some(isSourcePath)) return false;
  return paths.some(p => isProseSourcePath(p) && !isExcluded(p));
}

/** The predicate this tree is judged by: code, or prose for a project that ships only prose. */
function sourcePredicateForTree(paths: readonly string[]): (path: string) => boolean {
  return isProseNativeTree(paths) ? isProseSourcePath : isSourcePath;
}

/**
 * A representative source file from a full repository tree (an array of blob paths), or null
 * when the tree holds no project source. Ranking, highest first:
 *   1. a conventional entry-point basename (main, lib, index…)
 *   2. living under a source directory (src, crates, cmd…)
 *   3. shallower path, then lexical order — so the choice is deterministic per repository.
 */
function sourceScore(path: string): number {
  let s = 0;
  if (ENTRY_BASENAMES.has(basenameWithoutExt(path))) s += 100;
  if (dirSegments(path).some(isSourceDirSegment)) s += 50;
  s -= path.split('/').length; // prefer shallower
  return s;
}

function bySourceScoreDesc(a: string, b: string): number {
  const diff = sourceScore(b) - sourceScore(a);
  if (diff !== 0) return diff;
  if (a.length !== b.length) return a.length - b.length;
  return a.localeCompare(b);
}

/**
 * The most representative source files from a repository tree, highest first, up to `limit`.
 * More than one is collected so that coverage — how much of the codebase the review examined —
 * is a real fraction rather than the fixed 1/total it would be from a single file.
 */
export function pickSourceFilesFromTree(paths: readonly string[], limit: number): string[] {
  const isSource = sourcePredicateForTree(paths);
  return paths
    .filter(p => isSource(p) && !isExcluded(p))
    .sort(bySourceScoreDesc)
    .slice(0, Math.max(0, limit));
}

/** The single most representative source file, or null. */
export function pickSourceFromTree(paths: readonly string[]): string | null {
  return pickSourceFilesFromTree(paths, 1)[0] ?? null;
}

/**
 * Risk-surface source files, up to `limit`, excluding paths already picked. The
 * representative picks above favour entry points, which is right for judging what a project
 * IS — and wrong for judging its severe claims: a review that asserts anything about
 * sandboxing, database writes, cost enforcement or failure handling needs the files that
 * implement those paths, not another main.rs. Selection walks the claim domains in their
 * declared order, taking each domain's best-ranked matching file round-robin, so two targeted
 * slots cover two different domains before any domain gets a second file. Deterministic per
 * repository, like every picker here.
 */
export function pickTargetedSourceFiles(
  paths: readonly string[],
  limit: number,
  excludePaths: ReadonlySet<string>
): string[] {
  if (limit <= 0) return [];
  const isSource = sourcePredicateForTree(paths);
  const pool = paths.filter(p => isSource(p) && !isExcluded(p) && !excludePaths.has(p));
  const perDomain = CLAIM_DOMAINS.map(domain =>
    pool.filter(p => domain.pathPattern.test(p.toLowerCase())).sort(bySourceScoreDesc)
  );

  const chosen: string[] = [];
  const chosenSet = new Set<string>();
  while (chosen.length < limit) {
    let took = false;
    for (const candidates of perDomain) {
      if (chosen.length >= limit) break;
      // A file another domain already claimed still covers this one; skip past it.
      const pick = candidates.find(p => !chosenSet.has(p));
      if (pick) {
        chosen.push(pick);
        chosenSet.add(pick);
        took = true;
      }
    }
    if (!took) break;
  }
  return chosen;
}

/**
 * Ancillary source-ish extensions: real files a shell-only project might be reviewed on, but
 * NOT core implementation. They inflate the coverage denominator (a Go service's whole
 * implementation can be one main.go shipping several deploy scripts), so a project fully
 * covered by its one real source file would be wrongly reported as sampled. Excluded from the
 * count, kept in the pick pool so a pure-shell repo still yields some source evidence.
 */
const NON_CORE_EXTENSIONS = new Set(['.sh', '.r', '.lua']);

/**
 * How many of a repository's own CORE source files there are — its implementation, excluding
 * tests, examples, vendored/generated trees, and ancillary scripts. This is the coverage
 * denominator: the review examined `source_count` of these, and a small fraction of a large
 * codebase cannot support a high-confidence claim about the whole architecture.
 */
export function countSourceFiles(paths: readonly string[]): number {
  const isSource = sourcePredicateForTree(paths);
  return paths.filter(
    p => isSource(p) && !isExcluded(p) && !NON_CORE_EXTENSIONS.has(extensionOf(p))
  ).length;
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
