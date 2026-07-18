import * as fs from 'node:fs';
import * as path from 'node:path';
import { GenerationRecordSchema, type GenerationRecord } from '../../schemas/generation-record';
import { contentHash, recordsDir } from './record-store';

/**
 * The public allow-list: the single gate deciding what the world can see.
 *
 * Stated as an allow-list on purpose. A deny-list ("hide it unless it is excluded") publishes
 * anything it fails to recognise — a new status, a half-written record, a typo in an enum —
 * and the failure mode is silent disclosure of content that was withheld for a reason. This
 * predicate names the exact conjunction that permits publication and refuses everything else,
 * so an unknown state fails closed by construction.
 *
 * All four conditions are load-bearing:
 *
 *   generation.status === 'succeeded'   a response exists and is stored
 *   quality.status    === 'passed'      it cleared validation
 *   publication.status === 'published'  it was explicitly published
 *   validatedContentHash === hash(currentContent)
 *                                       the content that passed IS the content on display —
 *                                       without this, an edit after validation would publish
 *                                       unvalidated text under a passing verdict
 */

export interface VisibilityDecision {
  visible: boolean;
  /** Why the content is withheld. Never rendered publicly; for CLI and CI diagnostics. */
  reason?: string;
}

export function decideVisibility(record: GenerationRecord): VisibilityDecision {
  if (record.generation.status !== 'succeeded') {
    return { visible: false, reason: `generation.status is "${record.generation.status}"` };
  }
  if (record.quality.status !== 'passed') {
    return { visible: false, reason: `quality.status is "${record.quality.status}"` };
  }
  if (record.publication.status !== 'published') {
    return { visible: false, reason: `publication.status is "${record.publication.status}"` };
  }
  if (record.quality.validatedContentHash === null) {
    return { visible: false, reason: 'no validated content hash is recorded' };
  }
  if (record.quality.validatedContentHash !== contentHash(record.editorial.currentContent)) {
    return { visible: false, reason: 'the current content does not match the hash that was validated' };
  }
  return { visible: true };
}

export function isPubliclyVisible(record: GenerationRecord): boolean {
  return decideVisibility(record).visible;
}

/**
 * Slugs that may appear on any public surface, keyed by slug for the site's lookup.
 *
 * A record that does not parse is NOT skipped — it aborts. Skipping would mean an unreadable
 * record silently contributes nothing to the allow-list while its review.json still sits on
 * disk, which is the deny-list failure mode arriving through the back door.
 */
export function loadPublishableSlugs(contentRoot: string): Set<string> {
  const dir = recordsDir(contentRoot);
  const slugs = new Set<string>();
  if (!fs.existsSync(dir)) return slugs;

  for (const file of fs.readdirSync(dir).sort()) {
    if (!file.endsWith('.json')) continue;
    const filePath = path.join(dir, file);
    let raw: unknown;
    try {
      raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error: any) {
      throw new Error(`[Public Gate] Generation record ${file} is not valid JSON: ${error.message}`);
    }
    const parsed = GenerationRecordSchema.safeParse(raw);
    if (!parsed.success) {
      throw new Error(`[Public Gate] Generation record ${file} failed schema validation: ${parsed.error.message}`);
    }
    if (!parsed.data.slug) continue;
    if (isPubliclyVisible(parsed.data)) slugs.add(parsed.data.slug);
  }
  return slugs;
}
