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
  'undefined',
  'DEMO FIXTURE',
];

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

          for (const banned of BANNED_STRINGS) {
            // In production, enforce banned strings strictly.
            // (Note: in fixture, some of these like example.com might be allowed in test fixtures, but we keep it banned where possible).
            if (content.includes(banned)) {
              console.error(`Banned string "${banned}" found in file: ${path.relative(rootDir, fullPath)}`);
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
