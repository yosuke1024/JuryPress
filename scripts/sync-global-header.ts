import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function main() {
  const rootDir = path.resolve(__dirname, '..');
  const landingDir = path.resolve(rootDir, '../pixapps-landing');
  const publicDir = path.join(rootDir, 'public');

  if (fs.existsSync(landingDir)) {
    console.log('Syncing global header assets from pixapps-landing...');
    try {
      fs.copyFileSync(path.join(landingDir, 'global-header.js'), path.join(publicDir, 'global-header.js'));
      fs.copyFileSync(path.join(landingDir, 'global-header.css'), path.join(publicDir, 'global-header.css'));
      fs.copyFileSync(path.join(landingDir, 'logo.png'), path.join(publicDir, 'logo.png'));
      console.log('✅ Global header assets synced successfully.');
    } catch (err) {
      console.error('❌ Failed to sync global header assets:', err);
    }
  } else {
    console.warn('⚠️ Warning: pixapps-landing directory not found. Skipping global header assets sync.');
  }
}

main();
