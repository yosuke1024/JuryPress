import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const repoRoot = path.resolve(__dirname, '..', '..');
const LOCK_PATH = path.join(os.tmpdir(), 'jurypress-astro-build.lock');
const LOCK_TIMEOUT_MS = 300_000;

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Serializes test-driven `astro build`s against each other, because Vitest runs test files in
 * parallel and `astro build` writes intermediate chunks to the shared `<repo>/.astro/.prerender`
 * directory regardless of --outDir: two builds at once clobber each other's chunks.
 *
 * It used to guard a second thing. A fixture-mode build reads `tests/fixtures` —
 * `resolveContentRoot()` hard-codes that path — so the tests that prove the fail-closed data
 * checks by loading a deliberately invalid review wrote one into that tree and took this lock
 * to keep a build from reading it mid-plant. Waiting behind every build in the suite is what
 * made them flaky; they now load from a content root of their own via `loadReviewsFrom()` and
 * leave `tests/fixtures` alone, so nothing outside this file needs the lock.
 */
function withBuildLock<T>(fn: () => T): T {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_PATH);
      break;
    } catch (err: any) {
      if (err.code !== 'EEXIST') throw err;
      if (Date.now() > deadline) {
        // Assume the holder died and take over rather than failing the suite.
        fs.rmSync(LOCK_PATH, { recursive: true, force: true });
        continue;
      }
      sleepSync(100);
    }
  }
  try {
    return fn();
  } finally {
    fs.rmSync(LOCK_PATH, { recursive: true, force: true });
  }
}

/** Runs a real `astro build` into `outDir`, serialized against other test builds. */
export function runAstroBuild(outDir: string, env: Record<string, string>): void {
  const result = withBuildLock(() =>
    spawnSync('npx', ['astro', 'build', '--outDir', outDir], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: { ...process.env, ...env },
      timeout: 240_000
    })
  );
  if (result.status !== 0) {
    throw new Error(`astro build failed:\n${result.stdout}\n${result.stderr}`);
  }
}
