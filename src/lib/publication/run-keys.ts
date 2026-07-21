import { TimezoneUtil } from '../timezone';

/**
 * Run keys identify one publication attempt end to end.
 *
 * - Scheduled daily runs: `season-<season>-YYYY-MM-DD-daily` (JST date). One per day, so
 *   a same-day retry resumes the same run. Legacy bootstrap states appended a slug suffix;
 *   the pattern tolerates it so those runs can still be resumed explicitly.
 * - Manual runs: `season-<season>-manual-<github.run_id>`. github.run_id is stable across
 *   GitHub Actions re-runs (run_attempt is deliberately NOT part of the key), so a retry
 *   of the same workflow run resumes the same candidate while a fresh dispatch gets a new
 *   run id and therefore a new reservation.
 * - Reader-request runs: `season-<season>-request-<issue_number>`. The GitHub Issue number
 *   is the identity of the request, so every dispatch for the same issue resumes the same
 *   run: one issue can never produce two generation records.
 */

const SCHEDULED_RUN_KEY_PATTERN = /^season-\d+-\d{4}-\d{2}-\d{2}-daily(-[a-z0-9][a-z0-9-]*)?$/;
const MANUAL_RUN_KEY_PATTERN = /^season-\d+-manual-\d+$/;
const REQUEST_RUN_KEY_PATTERN = /^season-\d+-request-[1-9]\d*$/;
// A regeneration re-reviews one existing (withdrawn) review. The key carries the workflow run
// id, exactly as a manual run does: a GitHub Actions re-run of the SAME dispatch keeps the id,
// so an in-flight regeneration still resumes; a fresh dispatch gets a new id, so a retry after
// an excluded attempt is a new run rather than resuming the excluded record forever.
const REGENERATE_RUN_KEY_PATTERN = /^season-\d+-regenerate-[a-z0-9][a-z0-9-]*-\d+$/;

export function buildScheduledRunKey(season: number, date?: string | Date): string {
  return TimezoneUtil.getRunKey(season, date);
}

export function buildManualRunKey(season: number, workflowRunId: string): string {
  if (!/^\d+$/.test(workflowRunId)) {
    throw new Error(`Invalid workflow run id for manual run key: "${workflowRunId}"`);
  }
  if (!Number.isInteger(season) || season <= 0) {
    throw new Error(`Invalid season for manual run key: "${season}"`);
  }
  return `season-${season}-manual-${workflowRunId}`;
}

export function buildRequestRunKey(season: number, issueNumber: number): string {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0) {
    throw new Error(`Invalid issue number for request run key: "${issueNumber}"`);
  }
  if (!Number.isInteger(season) || season <= 0) {
    throw new Error(`Invalid season for request run key: "${season}"`);
  }
  return `season-${season}-request-${issueNumber}`;
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export function buildRegenerateRunKey(season: number, targetSlug: string, workflowRunId: string): string {
  if (typeof targetSlug !== 'string' || !SLUG_PATTERN.test(targetSlug)) {
    throw new Error(`Invalid target slug for regenerate run key: "${targetSlug}"`);
  }
  if (!/^\d+$/.test(workflowRunId)) {
    throw new Error(`Invalid workflow run id for regenerate run key: "${workflowRunId}"`);
  }
  if (!Number.isInteger(season) || season <= 0) {
    throw new Error(`Invalid season for regenerate run key: "${season}"`);
  }
  return `season-${season}-regenerate-${targetSlug}-${workflowRunId}`;
}

export function isValidRunKey(runKey: string): boolean {
  return typeof runKey === 'string'
    && (SCHEDULED_RUN_KEY_PATTERN.test(runKey)
      || MANUAL_RUN_KEY_PATTERN.test(runKey)
      || REQUEST_RUN_KEY_PATTERN.test(runKey)
      || REGENERATE_RUN_KEY_PATTERN.test(runKey));
}

/**
 * Fail-closed run-key validation for anything that reaches the filesystem. The allowed
 * patterns already restrict the charset to [a-z0-9-], which excludes every path-traversal
 * vector; the explicit separator checks keep the intent auditable.
 */
export function assertSafeRunKey(runKey: string): void {
  if (typeof runKey !== 'string' || runKey.length === 0 || runKey.length > 200) {
    throw new Error('Run key must be a non-empty string of reasonable length.');
  }
  if (runKey.includes('/') || runKey.includes('\\') || runKey.includes('..') || runKey.includes('\0')) {
    throw new Error(`Run key contains forbidden path characters: "${runKey}"`);
  }
  if (!isValidRunKey(runKey)) {
    throw new Error(`Run key does not match any supported format: "${runKey}"`);
  }
}
