import * as fs from 'fs';
import * as path from 'path';
import { resolveDataMode, type JuryPressDataMode } from '../content-root';
import { loadSelfHostingSource } from './config';
import { resolveSelfHostingRoot } from './root';
import {
  CheckSuiteSchema,
  ProductRecordSchema,
  type CheckSuite,
  type ProductRecord
} from './schema';

export interface LoadedCatalog {
  /** Absolute path the catalog was read from. Build-time only; never rendered. */
  root: string;
  records: ProductRecord[];
  checks: CheckSuite;
}

/**
 * Reads the catalog. Fails closed in every direction.
 *
 * The distinction this preserves is between *off* and *empty*. A disabled feature returns
 * null from loadCatalogIfEnabled() and the site renders as though self-hosting did not exist.
 * An enabled feature pointed at a catalog with no records returns an empty list — which is a
 * real, correct answer, and the state the catalog is actually in until a product is verified.
 * Collapsing the two would mean a misconfigured root looked exactly like an honest empty
 * catalog, and the section would quietly vanish instead of failing the build.
 */
export function loadCatalog(
  mode: JuryPressDataMode = resolveDataMode(),
  cwd: string = process.cwd()
): LoadedCatalog {
  const source = loadSelfHostingSource(cwd);
  const root = resolveSelfHostingRoot(mode);

  const checks = loadCheckSuite(root, mode, source.supported_schema_versions);
  const records = loadRecords(root, mode, source.supported_schema_versions);

  const seenSlugs = new Map<string, string>();
  const seenReviewSlugs = new Map<string, string>();
  for (const record of records) {
    const previous = seenSlugs.get(record.product.slug);
    if (previous) {
      throw new Error(
        `Self-hosting catalog has two records for product slug "${record.product.slug}".`
      );
    }
    seenSlugs.set(record.product.slug, record.product.slug);

    const claimed = seenReviewSlugs.get(record.review.review_slug);
    if (claimed) {
      throw new Error(
        `Self-hosting records "${claimed}" and "${record.product.slug}" both claim review ` +
          `"${record.review.review_slug}".`
      );
    }
    seenReviewSlugs.set(record.review.review_slug, record.product.slug);
  }

  return { root, records, checks };
}

/**
 * The entry point for rendering: null when the feature is off, a catalog otherwise.
 *
 * Nothing downstream may treat a thrown error as "no catalog". A catalog that is enabled and
 * unreadable stops the build, because the alternative is publishing a site that silently lost
 * a section nobody noticed was missing.
 */
export function loadCatalogIfEnabled(
  mode: JuryPressDataMode = resolveDataMode(),
  cwd: string = process.cwd()
): LoadedCatalog | null {
  if (!loadSelfHostingSource(cwd).enabled) return null;
  return loadCatalog(mode, cwd);
}

function loadCheckSuite(
  root: string,
  mode: JuryPressDataMode,
  supportedVersions: string[]
): CheckSuite {
  const filePath = path.join(root, 'checks', 'checks.json');
  if (!fs.existsSync(filePath)) {
    throw new Error(`Self-hosting check suite is missing: ${filePath}`);
  }

  const suite = parseDocument(filePath, CheckSuiteSchema, 'check suite');
  assertSchemaVersion(suite.schema_version, supportedVersions, 'checks/checks.json');
  assertDataClass(suite.data_class, mode, 'checks/checks.json');
  return suite;
}

function loadRecords(
  root: string,
  mode: JuryPressDataMode,
  supportedVersions: string[]
): ProductRecord[] {
  const dir = path.join(root, 'catalog', 'projects');
  if (!fs.existsSync(dir)) {
    throw new Error(`Self-hosting catalog directory is missing: ${dir}`);
  }

  const records: ProductRecord[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;

    const filePath = path.join(dir, entry.name);
    const relative = `catalog/projects/${entry.name}`;
    const record = parseDocument(filePath, ProductRecordSchema, 'product record');

    assertSchemaVersion(record.schema_version, supportedVersions, relative);
    assertDataClass(record.data_class, mode, relative);

    const expectedName = `${record.product.slug}.json`;
    if (entry.name !== expectedName) {
      throw new Error(
        `Self-hosting record ${relative} declares slug "${record.product.slug}", so its file ` +
          `must be named ${expectedName}.`
      );
    }

    records.push(record);
  }

  return records;
}

function parseDocument<T extends { parse: (input: unknown) => any }>(
  filePath: string,
  schema: T,
  label: string
): ReturnType<T['parse']> {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err: any) {
    throw new Error(`Self-hosting ${label} ${filePath} is not valid JSON: ${err.message}`);
  }

  const parsed = (schema as any).safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Self-hosting ${label} ${filePath} does not match the contract: ${parsed.error.issues
        .map((i: any) => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

function assertSchemaVersion(version: string, supported: string[], where: string): void {
  if (!supported.includes(version)) {
    throw new Error(
      `Self-hosting ${where} is schema_version ${version}, which this site does not support ` +
        `(supported: ${supported.join(', ')}). The catalog contract moved ahead of the site.`
    );
  }
}

function assertDataClass(dataClass: string, mode: JuryPressDataMode, where: string): void {
  const expected = mode === 'production' ? 'production' : 'fixture';
  if (dataClass !== expected) {
    throw new Error(
      `Data classification mismatch for self-hosting ${where}: expected '${expected}', found '${dataClass}'`
    );
  }
}
