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
 * `astro build` writes intermediate chunks to the shared `<repo>/.astro/.prerender`
 * directory regardless of --outDir, so two builds running at once clobber each other's
 * chunks. Vitest runs test files in parallel, so every test-driven build takes this lock.
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
