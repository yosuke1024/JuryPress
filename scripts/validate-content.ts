import * as fs from 'fs';
import * as path from 'path';
import { resolveContentRoot, resolveDataMode } from '../src/lib/content-root';
import { getAllReviews } from '../src/lib/data';
import { ReviewSchema } from '../src/schemas/review';
import { SelectionSchema, PublicationStateSchema } from '../src/schemas/selection';
import { EvidenceBundleSchema } from '../src/schemas/evidence';

function validate() {
  console.log("[JuryPress Validation] Starting content validation...");

  const mode = resolveDataMode();
  const contentRoot = resolveContentRoot();

  console.log(`- Mode: ${mode}`);
  console.log(`- Content Root: ${contentRoot}`);

  // 1. Verify that no production files were written to the public checkout "data" folder
  const publicDataDir = path.join(process.cwd(), 'data');
  if (fs.existsSync(publicDataDir)) {
    const hasJsonFiles = (dir: string): boolean => {
      const list = fs.readdirSync(dir);
      for (const file of list) {
        const fullPath = path.join(dir, file);
        if (fs.statSync(fullPath).isDirectory()) {
          if (hasJsonFiles(fullPath)) return true;
        } else if (file.endsWith('.json')) {
          return true;
        }
      }
      return false;
    };
    if (hasJsonFiles(publicDataDir)) {
      throw new Error(`Security Violation: Production data JSON files were detected in the public repository checkout path: ${publicDataDir}`);
    }
  }

  // 2. Validate using data loader
  // This already verifies:
  // - Schema parsing (ReviewSchema, SelectionSchema)
  // - Mode and data_class consistency
  // - No Fixture contamination in production mode
  // - No duplicates (content_id, canonical_url, slug)
  // - Score recalculation consistency
  const reviews = getAllReviews();
  console.log(`- Loaded reviews: ${reviews.length}`);

  // 3. Additional validations (evidence references, publication state)
  const reviewsDir = path.join(contentRoot, 'reviews');
  const pubStateDir = path.join(contentRoot, 'publication-state');

  for (const entry of reviews) {
    const slug = entry.slug;
    const year = entry.year;
    const month = entry.month;

    // Check evidence file schema
    const evidencePath = path.join(reviewsDir, year, month, slug, 'evidence.json');
    if (fs.existsSync(evidencePath)) {
      const rawEvidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
      const bundle = EvidenceBundleSchema.parse(rawEvidence);
      if (mode === 'production' && bundle.data_class !== 'production') {
        throw new Error(`Data classification mismatch for evidence bundle in ${slug}: expected 'production', found '${bundle.data_class}'`);
      }
    }

    // Verify publication state file matching this slug exists in production mode
    if (mode === 'production') {
      const pubStatePath = path.join(pubStateDir, `${slug}.json`);
      if (!fs.existsSync(pubStatePath)) {
        throw new Error(`Missing publication state for slug: ${slug}`);
      }
      const rawPubState = JSON.parse(fs.readFileSync(pubStatePath, 'utf8'));
      const pubState = PublicationStateSchema.parse(rawPubState);
      if (pubState.data_class !== 'production') {
        throw new Error(`Data classification mismatch for publication state of ${slug}: expected 'production', found '${pubState.data_class}'`);
      }
      
      // Update publication state status to 'validated'
      if (pubState.publication_status === 'generated') {
        pubState.publication_status = 'validated';
        fs.writeFileSync(pubStatePath, JSON.stringify(pubState, null, 2));
        console.log(`- Updated publication status of ${slug} to 'validated'`);
      }
    }
  }

  console.log("[JuryPress Validation] SUCCESS: All validation checks passed.");
}

try {
  validate();
} catch (e: any) {
  console.error(`[JuryPress Validation] FAILED: ${e.message}`);
  process.exit(1);
}
