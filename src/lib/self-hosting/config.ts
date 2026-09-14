import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';

/**
 * Whether this site reads the self-hosting catalog, and which commit of it.
 *
 * The flag exists so the rest of this module can be merged, reviewed and shipped while the
 * catalog still has nothing listed in it. Off is not a degraded mode: it is the state the
 * site is in until someone adopts a catalog commit on purpose.
 *
 * `adopted_commit` is recorded rather than resolved at build time. The build reads whatever
 * tree JURYPRESS_SELF_HOSTING_ROOT points at; this value is what the workflows are supposed
 * to have checked out there, and P08 is where the two are made to agree. Keeping it here
 * means a rollback is a one-line change to a commit that was already reviewed.
 */
const SelfHostingSourceSchema = z.object({
  $comment: z.string().optional(),
  enabled: z.boolean(),
  repo_url: z.string().url(),
  adopted_commit: z.union([z.string().regex(/^[0-9a-f]{40}$/), z.null()]),
  supported_schema_versions: z.array(z.string().regex(/^\d+\.\d+\.\d+$/)).min(1)
});

export type SelfHostingSource = z.infer<typeof SelfHostingSourceSchema>;

const CONFIG_PATH = ['config', 'self-hosting-source.json'];

let cached: SelfHostingSource | null = null;

export function loadSelfHostingSource(cwd: string = process.cwd()): SelfHostingSource {
  if (cached) return cached;

  const filePath = path.join(cwd, ...CONFIG_PATH);
  if (!fs.existsSync(filePath)) {
    throw new Error(`Self-hosting source config is missing: ${filePath}`);
  }

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err: any) {
    throw new Error(`Self-hosting source config is not valid JSON: ${err.message}`);
  }

  const parsed = SelfHostingSourceSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `Self-hosting source config does not match the schema: ${parsed.error.issues
        .map(i => `${i.path.join('.')}: ${i.message}`)
        .join('; ')}`
    );
  }

  cached = parsed.data;
  return cached;
}

/** Test seam. Nothing that renders calls this. */
export function resetSelfHostingSourceCache(): void {
  cached = null;
}

export function isSelfHostingEnabled(cwd?: string): boolean {
  return loadSelfHostingSource(cwd).enabled;
}
