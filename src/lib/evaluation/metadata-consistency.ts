import type { GitHubMetadataSnapshot } from '../../schemas/evidence';
import type { QualityFinding, RepairRecord } from '../../schemas/generation-record';
import { scannableTextFields } from './public-claims';

export const METADATA_CONSISTENCY_VERSION = '1.1.0';

const SMALL = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight',
  'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen',
  'seventeen', 'eighteen', 'nineteen'];
const TENS = ['twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
const NUMBER = `(?:\\d+(?:,\\d{3})*(?:\\.\\d+)?[km]?|(?:${TENS.join('|')})(?:[ -](?:${SMALL.slice(1, 10).join('|')}))?|${SMALL.join('|')}|single|lone)`;

function metadataPattern(): RegExp {
  return new RegExp(
    '\\b(?:a\\s+)?(' + NUMBER + ')\\s+(GitHub\\s+)?(stars?|forks?|open\\s+issues?)\\b',
    'gi'
  );
}

function metricFor(label: string): 'stars' | 'forks' | 'open_issues' {
  const normalized = label.toLowerCase();
  if (normalized.startsWith('star')) return 'stars';
  if (normalized.startsWith('fork')) return 'forks';
  return 'open_issues';
}

function canonicalLabel(metric: 'stars' | 'forks' | 'open_issues', value: number): string {
  if (metric === 'open_issues') return value === 1 ? 'open issue' : 'open issues';
  if (metric === 'stars') return value === 1 ? 'star' : 'stars';
  return value === 1 ? 'fork' : 'forks';
}

function numericValue(value: string): number {
  const normalized = value.toLowerCase().replace(/,/g, '');
  if (/^\d/.test(normalized)) {
    const multiplier = normalized.endsWith('k') ? 1000 : normalized.endsWith('m') ? 1_000_000 : 1;
    return parseFloat(normalized) * multiplier;
  }
  if (normalized === 'single' || normalized === 'lone') return 1;
  const parts = normalized.split(/[ -]/);
  const tens = TENS.indexOf(parts[0]);
  return tens < 0 ? SMALL.indexOf(parts[0]) : (tens + 2) * 10 + (parts[1] ? SMALL.indexOf(parts[1]) : 0);
}

/**
 * Compare numeric mentions with the SAVED collection snapshot, never live GitHub data.
 * Advisory only: a mention may refer to a competitor, history, or a proposed target. Do not
 * silently replace prose (including human edits) based on a lexical match. Each occurrence
 * gets its path and offset so multiple disagreements in one field remain visible.
 * Qualitative descriptions such as "low traction" and "near-zero stars" are not figures.
 */
export function collectMetadataConsistencyFindings(
  content: unknown,
  snapshot?: GitHubMetadataSnapshot | null
): QualityFinding[] {
  if (!snapshot || !content || typeof content !== 'object') return [];
  const findings: QualityFinding[] = [];
  const pattern = metadataPattern();
  for (const { path, text } of scannableTextFields(content)) {
    for (const match of text.matchAll(pattern)) {
      // Do not misread the tail of a qualitative compound ("near-zero stars"), a
      // negative figure or a decimal as a standalone integer.
      if (match.index! > 0 && /[\w.,-]/.test(text[match.index! - 1])) continue;
      const metric = metricFor(match[3]);
      const expected = snapshot[metric];
      const observed = numericValue(match[1]);
      if (!Number.isSafeInteger(expected) || expected < 0 || observed === expected) continue;
      findings.push({
        code: 'METADATA_NUMBER_MISMATCH',
        path: `$.${path}`,
        message: `Numeric mention "${match[0]}" at offset ${match.index} differs from the saved ` +
          `Source snapshot (${snapshot.snapshot_id}: ${metric}=${expected}). Check the referent ` +
          `and use the saved value for this repository; no prose was automatically rewritten.`,
        severity: 'warning',
        ruleVersion: METADATA_CONSISTENCY_VERSION
      });
    }
  }
  return findings;
}

/**
 * Canonicalize repository metric figures in autonomous model output against the saved
 * collection snapshot. This is deterministic fact repair, not an editorial rewrite: it
 * changes only the numeric phrase and never fetches live data. Human revisions deliberately
 * skip this repair and keep the warning path above, preserving exact text and provenance.
 */
export function repairMetadataConsistency(
  content: unknown,
  snapshot?: GitHubMetadataSnapshot | null
): RepairRecord[] {
  if (!snapshot || !content || typeof content !== 'object') return [];
  const repairs: RepairRecord[] = [];

  const visit = (value: unknown, path: string): void => {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      const childPath = Array.isArray(value) ? path + '[' + key + ']' : path + '.' + key;
      if (typeof child === 'string') {
        const repaired = child.replace(
          metadataPattern(),
          (whole, rawValue: string, github: string | undefined, unit: string, offset: number) => {
            if (offset > 0 && /[\w.,-]/.test(child[offset - 1])) return whole;
            const metric = metricFor(unit);
            const expected = snapshot[metric];
            const observed = numericValue(rawValue);
            if (!Number.isSafeInteger(expected) || expected < 0 || observed === expected) return whole;
            const replacement = String(expected) + ' ' + (github ?? '') + canonicalLabel(metric, expected);
            repairs.push({
              code: 'METADATA_NUMBER_CANONICALIZED',
              path: childPath,
              message: 'Replaced "' + whole + '" with "' + replacement +
                '" from saved Source snapshot ' + snapshot.snapshot_id + '.'
            });
            return replacement;
          }
        );
        if (repaired !== child) (value as Record<string, unknown>)[key] = repaired;
      } else {
        visit(child, childPath);
      }
    }
  };

  visit(content, '$');
  return repairs;
}
