import * as fs from 'fs';
import * as path from 'path';
import { resolveDataMode, type JuryPressDataMode } from '../content-root';

/**
 * Where the self-hosting catalog is read from.
 *
 * Deliberately a *separate* root from JURYPRESS_CONTENT_ROOT. The catalog lives in a public
 * repository with its own contract and its own release cadence; pointing both at one tree
 * would make a catalog update look like a content update to every workflow that pins them.
 *
 * Fixture mode is pinned to tests/fixtures/self-hosting and cannot be redirected, for the
 * same reason resolveContentRoot() pins its own: a test that can aim the loader anywhere
 * stops proving that production cannot.
 */
export function resolveSelfHostingRoot(mode: JuryPressDataMode = resolveDataMode()): string {
  if (mode === 'fixture') {
    return path.resolve(process.cwd(), 'tests', 'fixtures', 'self-hosting');
  }

  const rawRoot =
    (typeof import.meta !== 'undefined' && import.meta.env?.JURYPRESS_SELF_HOSTING_ROOT) ||
    process.env.JURYPRESS_SELF_HOSTING_ROOT;
  const configured = rawRoot?.trim();

  if (!configured) {
    throw new Error(
      'JURYPRESS_SELF_HOSTING_ROOT is required in production mode when the self-hosting ' +
        'feature is enabled. Disable it in config/self-hosting-source.json to build without a catalog.'
    );
  }

  // Same traversal rejection as the content root: a relative or dot-carrying value is a
  // configuration mistake, and resolving it against cwd would silently read the site's own tree.
  const normalized = path.normalize(configured);
  const parts = normalized.split(path.sep);
  if (parts.includes('..') || parts.includes('.')) {
    throw new Error(
      `Directory traversal attempt detected in JURYPRESS_SELF_HOSTING_ROOT: ${configured}`
    );
  }
  if (!path.isAbsolute(normalized)) {
    throw new Error(
      `JURYPRESS_SELF_HOSTING_ROOT must be an absolute path: ${configured}`
    );
  }

  const resolved = path.resolve(normalized);
  if (!fs.existsSync(resolved)) {
    throw new Error(`Self-hosting catalog root does not exist: ${resolved}`);
  }

  return resolved;
}
