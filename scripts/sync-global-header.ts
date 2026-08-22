import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * The landing site's deployed files live under `public/` (2026-08-08, when its
 * `pages_build_output_dir` moved from the repository root). This script read them
 * from the root, and that is how the committed copies silently aged: every copy
 * threw ENOENT, the catch logged a cross, and the build carried on with whatever
 * was already in `public/` — a header still calling PixWork and Simple Games
 * "Coming Soon" long after both shipped. So: read from `public/`, and refuse to
 * build rather than fall back on a stale copy.
 */
const ASSETS = ['global-header.js', 'global-header.css', 'brand/pixapps-icon.svg'];

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const landingDir = path.resolve(rootDir, '../pixapps-landing');
  const publicDir = path.join(rootDir, 'public');

  if (!fs.existsSync(landingDir)) {
    console.warn('⚠️ Warning: pixapps-landing directory not found. Skipping global header assets sync.');
    return;
  }

  const landingPublicDir = path.join(landingDir, 'public');

  for (const asset of ASSETS) {
    const from = path.join(landingPublicDir, asset);
    if (fs.existsSync(from)) continue;
    throw new Error(
      `Global header sync source missing: ${from}\n` +
        'pixapps-landing is checked out but does not hold this file where this script expects it. ' +
        'Either the checkout is stale or the landing layout moved again — fix the path here rather than ' +
        `letting the build ship the copy already in ${publicDir}.`
    );
  }

  console.log('Syncing global header assets from pixapps-landing...');

  // The brand icon the header actually draws lives under brand/ on the landing
  // site and the header references it by that absolute path, so the directory has
  // to survive the copy — otherwise the icon only resolves in production, where
  // pixapps-landing serves it, and 404s in local dev.
  fs.mkdirSync(path.join(publicDir, 'brand'), { recursive: true });

  for (const asset of ASSETS) {
    fs.copyFileSync(path.join(landingPublicDir, asset), path.join(publicDir, asset));
  }

  console.log('✅ Global header assets synced successfully.');
}

main();
