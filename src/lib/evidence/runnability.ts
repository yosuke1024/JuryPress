/**
 * Runnability evidence: the deterministic answer to "could a reader obtain this project and
 * run it?", judged ONLY from the collected evidence bundle. Nothing is fetched here.
 *
 * It lives in src/lib rather than inside scripts/validate-content.ts, which used to own it,
 * because two paths must reach the SAME verdict. The selector applies it before a candidate
 * is reserved; the publication gate applies it again before the site builds. A candidate
 * that cannot satisfy it can never be published, so the only thing a late verdict buys is
 * the cost of finding out: runs season-2-2026-09-04-daily and season-2-2026-09-05-daily each
 * reserved a candidate, spent a generation and an evidence-mapping call, passed the quality
 * gate, and then failed here — leaving a `generated` record that permanently excludes its
 * candidate from re-selection, and a red workflow with nothing published. Two identical
 * rules that disagreed by strictness are what made that possible; there is now one.
 */

import type { Evidence } from '../../schemas/evidence';

/** A canonical dependency-install command in a CI workflow. */
const CI_DEPENDENCY_INSTALL = /\b(?:pip3? install|npm (?:ci|install)|yarn install|pnpm install|bundle install|composer install)\b/;
/** An interpreter invoked on a repository script file — `python scripts/validate/format.py`. */
const CI_SCRIPT_EXECUTION = /\b(?:python3?|node|bash|sh|ruby|perl)\s+[^\s]*\.(?:py|js|mjs|cjs|ts|sh|rb|pl)\b/;
/** A canonical test/build runner execution. */
const CI_RUNNER_EXECUTION = /\b(?:pytest|npm (?:test|run)|yarn test|pnpm test|cargo (?:test|run|build)|go (?:test|run|build)|make)\b/;

/**
 * An Apple-platform build manifest NAMED in the README. `.xcodeproj`, `Package.swift` and
 * `Podfile` are filenames, not prose — unlike the `clone` hint, no product description
 * spells them by accident — so reading them is the same attestation the API presence flags
 * carry, taken from a different evidence.
 *
 * It is taken from a different evidence because those flags are a snapshot frozen at
 * collection time: a bundle collected before the collector recognised an ecosystem reports
 * `package_manifest: false` for a project that plainly has a manifest, and a resumed run
 * reuses its stored bundle rather than re-collecting. Only the Apple manifests are listed;
 * every other ecosystem is already reported by the presence flags, so naming it here would
 * widen the prose surface for nothing.
 */
const NAMED_APPLE_BUILD_MANIFEST = /\.xcodeproj|\.xcworkspace|\bpackage\.swift\b|\bpodfile\b|\bcartfile\b/;

/**
 * Run commands the substring hint list below cannot express.
 *
 * Every entry is a command name followed by a subcommand or an argument, so it matches an
 * instruction rather than prose that happens to contain the word — the lesson the bare
 * `clone` hint taught. The list is what production candidates actually documented and the
 * old list could not read: Nanako0129/sepia (2026-09-04) installs with `npx skills add`,
 * and the modern Python and Node runners (`uv`, `uvx`, `pnpm`, `bun`, `pipx`) had no
 * representation at all while `npm install` and `pip install` did.
 */
const README_RUN_COMMAND = new RegExp([
  // Node package runners. `npx` takes a package name directly; the others take a subcommand.
  '\\bnpx\\s+[@\\w]',
  '\\b(?:pnpm|yarn|bun)\\s+(?:install|add|run|dev|start|build|test|dlx|x)\\b',
  // Python runners. `uv`/`uvx` reach a project without a prior install step, which is
  // precisely the case a `pip install` hint misses.
  '\\buv\\s+(?:run|sync|add|pip|tool)\\b',
  '\\buvx\\s+[@\\w]',
  '\\bpipx\\s+(?:install|run)\\b',
  '\\bpython3?\\s+-m\\s+pip\\s+install\\b',
  // Containers and system package managers.
  '\\bdocker\\s+(?:compose|build)\\b',
  '\\bdocker-compose\\s+up\\b',
  '\\bbrew\\s+install\\b',
  '\\bgo\\s+install\\b',
  '\\bdeno\\s+(?:run|task)\\b',
  // The canonical install one-liner, and executing a script the repository ships.
  'curl[^\\n|]*\\|\\s*(?:ba)?sh\\b',
  '(?:^|\\s)\\./[\\w./-]+\\.sh\\b'
].join('|'), 'm');

/** Extensions of a file that is executed rather than imported. */
const SCRIPT_EXTENSIONS = ['.sh', '.bash', '.zsh', '.ps1', '.bat', '.cmd'];

/** Basenames that ARE a project's install/run entry point, wherever they sit in the tree. */
const ENTRY_POINT_SCRIPT_BASENAMES = new Set([
  'install.sh', 'setup.sh', 'bootstrap.sh', 'run.sh', 'start.sh', 'build.sh',
  'install.ps1', 'install.bat', 'setup.ps1', 'setup.bat'
]);

/**
 * Directories whose scripts are the project's own entry points. `bin` and `scripts` are the
 * two conventions a reader is told to run something from; `tools` is the same convention
 * under a different name.
 */
const SCRIPT_DIR_SEGMENTS = new Set(['scripts', 'script', 'bin', 'tools', 'tool']);

/**
 * Segments that mark a path as something other than the project's own run path.
 *
 * Deliberately NOT the source detector's EXCLUDED_SEGMENTS: that list exists to answer "is
 * this the implementation being reviewed?" and excludes `bin`, `dist` and `docs` for reasons
 * that do not apply here — a shell script under `bin/` is exactly what a reader runs.
 */
const NON_RUN_PATH_SEGMENTS = new Set([
  'test', 'tests', '__tests__', 'spec', 'specs', 'e2e',
  'example', 'examples', 'sample', 'samples', 'demo', 'demos',
  'fixture', 'fixtures', 'testdata', 'vendor', 'node_modules', 'third_party', 'third-party'
]);

/**
 * The repository-relative path an evidence was collected from, lower-cased, or null when the
 * URL does not name one.
 *
 * Only `raw.githubusercontent.com` is read, and its `/<owner>/<repo>/<ref>/<path>` prefix is
 * dropped so that a repository named `scripts` cannot make every file in it look like a
 * script directory. Every source_code, test_file and ci_workflow evidence ever collected
 * comes from that host; anything else is a project's own website, whose URL path says
 * nothing about the repository layout.
 */
function repositoryPathOf(url: string | undefined): string[] | null {
  if (!url) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.hostname.toLowerCase() !== 'raw.githubusercontent.com') return null;
  const segments = parsed.pathname.split('/').filter(Boolean).map(segment => segment.toLowerCase());
  return segments.length > 3 ? segments.slice(3) : null;
}

/**
 * Whether a collected evidence is an executable script the project ships.
 *
 * The attestation is the collector's, not the article's: the file was fetched from the
 * repository, so it exists there. That is the same class of proof as the API presence flags,
 * read from a different evidence — the reason the Apple manifests are read from the README,
 * applied to the one thing a presence flag has never reported. codejunkie99/fable-orchestrator
 * (2026-09-05) is the case: a skill repository with no package manifest, no container build
 * and no CI, whose `install.sh` sits at the repository root and was collected as evidence.
 */
function shipsExecutableScript(evidences: readonly Evidence[]): boolean {
  return evidences.some(evidence => {
    const segments = repositoryPathOf(evidence.url);
    if (!segments) return false;
    const basename = segments[segments.length - 1];
    const directories = segments.slice(0, -1);
    if (directories.some(segment => NON_RUN_PATH_SEGMENTS.has(segment))) return false;
    if (!SCRIPT_EXTENSIONS.some(extension => basename.endsWith(extension))) return false;
    return ENTRY_POINT_SCRIPT_BASENAMES.has(basename) || directories.some(segment => SCRIPT_DIR_SEGMENTS.has(segment));
  });
}

/**
 * Deterministic runnability evidence, judged ONLY from the collected evidence bundle —
 * nothing is fetched at validation time. Accepted, in priority order:
 *
 *   1. The API metadata attests a package manifest or container build at the repo root.
 *   2. The README names an Apple-platform build manifest the presence flags may predate.
 *   3. The repository's own CI demonstrably executes repository code: the API metadata
 *      independently attests workflows exist AND a collected ci_workflow evidence both
 *      installs dependencies and executes a repository script (or a canonical test/build
 *      runner). A workflow of pure `uses:` actions, an echo-only step, or an install with
 *      nothing executed qualifies under neither pattern and lends no runnability — such a
 *      candidate falls through to the README check and otherwise stays unpublishable.
 *   4. A collected evidence is an executable script the project ships, at an install/run
 *      entry point or under bin/ or scripts/.
 *   5. The README documents an actual run command. The bare `clone` hint became
 *      `git clone`: as a substring it also matched prose like "Open Source Reddit Clone",
 *      which is a product description, not a run instruction.
 */
export function hasRunnabilityEvidence(metadata: any, evidences: readonly Evidence[]): boolean {
  if (metadata?.presence?.package_manifest || metadata?.presence?.container_build) return true;

  const readme = evidences.find(evidence => evidence.type === 'readme')?.summary.toLowerCase() || '';
  if (NAMED_APPLE_BUILD_MANIFEST.test(readme)) return true;

  if (metadata?.presence?.workflows === true) {
    const workflow = evidences.find(evidence => evidence.type === 'ci_workflow')?.summary.toLowerCase() || '';
    if (CI_DEPENDENCY_INSTALL.test(workflow) && (CI_SCRIPT_EXECUTION.test(workflow) || CI_RUNNER_EXECUTION.test(workflow))) {
      return true;
    }
  }

  if (shipsExecutableScript(evidences)) return true;

  const runHints = [
    'npm install', 'pip install', 'cargo install', 'go get', 'docker run', 'git clone', 'execute',
    'xcodebuild', 'swift build', 'swift run', 'pod install'
  ];
  if (runHints.some(value => readme.includes(value))) return true;

  return README_RUN_COMMAND.test(readme);
}
