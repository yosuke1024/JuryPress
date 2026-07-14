import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const REQUIRED_FILES = [
  'deploy/jurypress/index.html',
  'deploy/jurypress/404.html',
  'deploy/jurypress/rss.xml',
  'deploy/jurypress/sitemap-index.xml',
  'deploy/jurypress/reviews/fixture-product/index.html',
  'deploy/jurypress/judges/index.html',
  'deploy/jurypress/rubric/index.html',
  'deploy/jurypress/rankings/index.html',
];

const BANNED_STRINGS = [
  'https://yosuke1024.github.io',
  'localhost:4321',
  'example.com',
  'undefined',
];

const REQUIRED_STRINGS = [
  'https://pixapps.ai/jurypress/',
  'A PixApps experiment',
  'Judgie-AI',
];

function checkFilesExist(rootDir: string): boolean {
  let ok = true;
  for (const relPath of REQUIRED_FILES) {
    const fullPath = path.join(rootDir, relPath);
    if (!fs.existsSync(fullPath)) {
      console.error(`Missing required file: ${relPath}`);
      ok = false;
    }
  }
  return ok;
}

function scanFilesForStrings(rootDir: string): boolean {
  let ok = true;

  function scanDir(dir: string) {
    // Skip partytown directory to avoid false positives on library scripts
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
        
        if (/src="\s*\/_astro\//.test(content) || /href="\s*\/_astro\//.test(content)) {
          console.error(`Asset path starts with "/_astro/" in ${path.relative(rootDir, fullPath)}`);
          ok = false;
        }
        if (content.includes('/jurypress/jurypress/')) {
          console.error(`Double base path "/jurypress/jurypress/" found in ${path.relative(rootDir, fullPath)}`);
          ok = false;
        }
        if (content.includes('href="/JuryPress/') || content.includes('src="/JuryPress/')) {
          console.error(`Uppercase base path "/JuryPress/" found in link/src attributes in ${path.relative(rootDir, fullPath)}`);
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
  console.log('Validating Cloudflare build assets...');

  const existsOk = checkFilesExist(rootDir);
  const contentOk = scanFilesForStrings(rootDir);

  if (!existsOk || !contentOk) {
    console.error('Validation failed!');
    process.exit(1);
  }

  console.log('All build assets validated successfully.');
}

main();
