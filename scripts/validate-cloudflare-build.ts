import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_REQUIRED_FILES = [
  'deploy/jurypress/index.html',
  'deploy/jurypress/404.html',
  'deploy/jurypress/rss.xml',
  'deploy/jurypress/sitemap-index.xml',
  'deploy/jurypress/judges/index.html',
  'deploy/jurypress/rubric/index.html',
  'deploy/jurypress/rankings/index.html',
  'deploy/jurypress/request-review/index.html',
];

const BANNED_STRINGS = [
  'https://yosuke1024.github.io',
  'localhost:4321',
  'example.com',
  'DEMO FIXTURE',
];

// `undefined` is banned because a literal one in rendered output means a template printed a
// missing value. In a script it means nothing of the kind — it is a language keyword, and
// hand-authored JavaScript is entitled to use it. Astro's own bundles never tripped this
// only because minification rewrites the keyword to `void 0`; `public/global-header.js` is
// copied verbatim, so the day it used the keyword the deploy stopped. Scan scripts for the
// other strings, which stay meaningful there — a localhost URL in a shipped script is still
// a bug — and check this one everywhere else.
const BANNED_STRINGS_EXCEPT_SCRIPTS = ['undefined'];

const REQUIRED_STRINGS = [
  'https://pixapps.ai/jurypress/',
  'A PixApps experiment',
  'Judgie-AI',
];

function checkFilesExist(rootDir: string, mode: string): boolean {
  let ok = true;
  for (const relPath of BASE_REQUIRED_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`Missing required file: ${relPath}`);
      ok = false;
    }
  }

  const fixtureProductPath = path.join(rootDir, 'deploy/jurypress/reviews/fixture-product/index.html');
  if (mode === 'fixture') {
    if (!fs.existsSync(fixtureProductPath)) {
      console.error(`Missing required fixture file: deploy/jurypress/reviews/fixture-product/index.html`);
      ok = false;
    }
  } else if (mode === 'production') {
    if (fs.existsSync(fixtureProductPath)) {
      console.error(`Security Violation: Fixture product exists in production build: ${fixtureProductPath}`);
      ok = false;
    }
  }

  // The diary index is only required once the diary has actually started. Before the first
  // entry exists the section still builds, but asserting on it unconditionally would make
  // every review deploy depend on an experiment that may never have been bootstrapped.
  const contentRoot = process.env.JURYPRESS_CONTENT_ROOT;
  const diaryEntriesDir =
    mode === 'production' && contentRoot
      ? path.join(contentRoot, 'diary', 'entries')
      : path.join(__dirname, '..', 'tests', 'fixtures', 'diary', 'entries');

  if (fs.existsSync(diaryEntriesDir)) {
    const diaryIndexPath = path.join(rootDir, 'deploy/jurypress/diary/index.html');
    if (!fs.existsSync(diaryIndexPath)) {
      console.error('Missing required file: deploy/jurypress/diary/index.html (diary entries exist)');
      ok = false;
    }
  }

  return ok;
}

function scanFilesForStrings(rootDir: string, mode: string): boolean {
  let ok = true;

  function scanDir(dir: string) {
    if (dir.endsWith('~partytown')) {
      return;
    }
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scanDir(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (['.html', '.xml', '.svg', '.js', '.css', '.json'].includes(ext)) {
          const content = fs.readFileSync(fullPath, 'utf8');
          const banned = ext === '.js'
            ? BANNED_STRINGS
            : [...BANNED_STRINGS, ...BANNED_STRINGS_EXCEPT_SCRIPTS];

          for (const needle of banned) {
            // In production, enforce banned strings strictly.
            // (Note: in fixture, some of these like example.com might be allowed in test fixtures, but we keep it banned where possible).
            if (content.includes(needle)) {
              console.error(`Banned string "${needle}" found in file: ${path.relative(rootDir, fullPath)}`);
              ok = false;
            }
          }
        }
      }
    }
  }

  scanDir(path.join(rootDir, 'deploy/jurypress'));

  const indexHtmlPath = path.join(rootDir, 'deploy/jurypress/index.html');
  if (fs.existsSync(indexHtmlPath)) {
    const indexContent = fs.readFileSync(indexHtmlPath, 'utf8');
    for (const req of REQUIRED_STRINGS) {
      if (!indexContent.includes(req)) {
        console.error(`Required string "${req}" not found in index.html`);
        ok = false;
      }
    }
  }

  function checkAssetPaths(dir: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        checkAssetPaths(fullPath);
      } else if (entry.isFile() && path.extname(entry.name) === '.html') {
        const content = fs.readFileSync(fullPath, 'utf8');
        
        // Asset path checks
        if (/src="\s*\/_astro\//.test(content) || /href="\s*\/_astro\//.test(content)) {
          console.error(`Asset path starts with "/_astro/" (missing base path /jurypress/) in ${path.relative(rootDir, fullPath)}`);
          ok = false;
        }
        if (content.includes('/jurypress/jurypress/')) {
          console.error(`Double base path "/jurypress/jurypress/" found in ${path.relative(rootDir, fullPath)}`);
          ok = false;
        }
        if (content.includes('href="/JuryPress/') || content.includes('src="/JuryPress/')) {
          console.error(`Uppercase base path "/JuryPress/" found in ${path.relative(rootDir, fullPath)}`);
          ok = false;
        }
      }
    }
  }
  checkAssetPaths(path.join(rootDir, 'deploy/jurypress'));

  return ok;
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const mode = process.env.JURYPRESS_DATA_MODE || 'production';
  console.log(`Validating Cloudflare build assets for mode: ${mode}`);

  const existsOk = checkFilesExist(rootDir, mode);
  const contentOk = scanFilesForStrings(rootDir, mode);

  if (!existsOk || !contentOk) {
    console.error('Validation failed!');
    process.exit(1);
  }

  console.log('All build assets validated successfully.');
}

main();
