import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function copyDirSync(src: string, dest: string) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.isDirectory()) {
      copyDirSync(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const distDir = path.join(rootDir, 'dist');
  const deployDir = path.join(rootDir, 'deploy');
  const jurypressDestDir = path.join(deployDir, 'jurypress');

  console.log('Preparing Cloudflare assets...');

  // 1. deployを削除
  if (fs.existsSync(deployDir)) {
    fs.rmSync(deployDir, { recursive: true, force: true });
  }

  // 2. deploy/jurypressを作成
  fs.mkdirSync(jurypressDestDir, { recursive: true });

  // 3. distの内容をdeploy/jurypressへコピー
  if (!fs.existsSync(distDir)) {
    console.error(`Error: ${distDir} does not exist. Run npm run build first.`);
    process.exit(1);
  }
  copyDirSync(distDir, jurypressDestDir);

  // 4. deploy直下へCloudflare制御ファイルを生成
  // _redirects
  const redirectsContent = `/jurypress /jurypress/ 301\n`;
  fs.writeFileSync(path.join(deployDir, '_redirects'), redirectsContent);

  // _headers
  const headersContent = `/jurypress/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=()

/jurypress/_astro/*
  Cache-Control: public, max-age=31536000, immutable
`;
  fs.writeFileSync(path.join(deployDir, '_headers'), headersContent);

  console.log('Cloudflare assets prepared successfully in deploy/');
}

main();
