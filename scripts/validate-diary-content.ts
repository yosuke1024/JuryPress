import 'dotenv/config';
import * as fs from 'node:fs';
import { resolveContentRoot } from '../src/lib/content-root';
import { JUDGE_SLUGS } from '../src/schemas/jury';
import { buildDiaryId } from '../src/schemas/diary';
import { readDiaryConfigIfPresent } from '../src/lib/diary/config';
import { diaryRoot } from '../src/lib/diary/storage';
import { readJurorStates, jurorStatesExist } from '../src/lib/diary/state-store';
import { readAllDiaryEntries, readAllDiaryEvents } from '../src/lib/diary/entry-store';
import { readAllDiaryRecords } from '../src/lib/diary/record-store';
import { resolveDutyJuror, daysSinceStart } from '../src/lib/diary/rotation';
import { listReviewSlugs } from '../src/lib/diary/review-context';

/**
 * Structural validation for the diary tree — the `validate:diary` CLI.
 *
 * Kept separate from `validate:content` on purpose. The article workflows run that command as
 * their push-time gate, and wiring diary data into it would mean a corrupt diary file could
 * block a review from publishing. The two experiments share a repository, not a fate.
 *
 * A content root with no diary directory is a pass, not a failure: the site and the pipeline
 * must both work from the moment this code merges until the day the first entry is generated.
 */

interface ValidationReport {
  errors: string[];
  warnings: string[];
  counts: Record<string, number>;
}

function validate(contentRoot: string): ValidationReport {
  const errors: string[] = [];
  const warnings: string[] = [];
  const counts: Record<string, number> = {
    entries: 0,
    events: 0,
    records: 0,
    jurorsWithState: 0
  };

  if (!fs.existsSync(diaryRoot(contentRoot))) {
    console.log('[Diary Validate] No diary directory in this content root. Nothing to validate.');
    return { errors, warnings, counts };
  }

  const config = readDiaryConfigIfPresent(contentRoot);

  // Each of these throws on a malformed file; that is the intended fail-closed behaviour.
  const entries = readAllDiaryEntries(contentRoot);
  const events = readAllDiaryEvents(contentRoot);
  const records = readAllDiaryRecords(contentRoot);
  counts.entries = entries.length;
  counts.events = events.length;
  counts.records = records.length;

  const jurorsWithState = JUDGE_SLUGS.filter((slug) => jurorStatesExist(contentRoot, slug));
  counts.jurorsWithState = jurorsWithState.length;

  for (const slug of jurorsWithState) {
    try {
      readJurorStates(contentRoot, slug);
    } catch (error: any) {
      errors.push(error.message);
    }
  }

  if (entries.length > 0 && !config) {
    errors.push('Entries exist but data/diary/config.json is missing.');
  }
  if (entries.length > 0 && jurorsWithState.length !== JUDGE_SLUGS.length) {
    errors.push(
      `Entries exist but only ${jurorsWithState.length}/${JUDGE_SLUGS.length} jurors have persona state.`
    );
  }

  const eventIds = new Set(events.map((event) => event.eventId));
  const recordsById = new Map(records.map((record) => [record.recordId, record]));
  const seenEntryIds = new Set<string>();
  const reviewSlugs = new Set(listReviewSlugs(contentRoot));

  for (const entry of entries) {
    const expectedId = buildDiaryId(entry.date, entry.jurorId);

    if (entry.id !== expectedId) {
      errors.push(`Entry ${entry.id} does not match its date and juror (expected ${expectedId}).`);
    }
    if (seenEntryIds.has(entry.id)) {
      errors.push(`Duplicate entry id: ${entry.id}.`);
    }
    seenEntryIds.add(entry.id);

    // A published entry whose persona patches were never applied is precisely the split the
    // atomicity rule exists to prevent, so it is an error rather than a warning.
    if (!eventIds.has(entry.id)) {
      errors.push(`Entry ${entry.id} has no corresponding event — persona state may not have been applied.`);
    }

    const record = recordsById.get(entry.id);
    if (!record) {
      errors.push(`Entry ${entry.id} has no generation record.`);
    } else {
      if (record.structural.status !== 'passed') {
        errors.push(`Entry ${entry.id} exists but its record is structural=${record.structural.status}.`);
      }
      if (record.application.status !== 'applied') {
        errors.push(`Entry ${entry.id} exists but its record is application=${record.application.status}.`);
      }
      if (record.publication.status === 'excluded') {
        errors.push(`Entry ${entry.id} exists but its record is excluded.`);
      }
      if (record.theme !== entry.theme) {
        errors.push(`Entry ${entry.id} theme (${entry.theme}) disagrees with its record (${record.theme}).`);
      }
    }

    if (config) {
      if (daysSinceStart(config, entry.date) < 0) {
        errors.push(`Entry ${entry.id} predates the configured start date ${config.startDate}.`);
      } else {
        const dutyJuror = resolveDutyJuror(config, entry.date);
        if (dutyJuror !== entry.jurorId) {
          errors.push(
            `Entry ${entry.id} was written by ${entry.jurorId}, but ${entry.date} belongs to ${dutyJuror}.`
          );
        }
      }
    }

    for (const slug of entry.relatedReviewSlugs) {
      if (!reviewSlugs.has(slug)) {
        // A warning, not an error: a review can be withdrawn after a diary linked to it, and
        // that must not permanently block every future build. The site skips dead links.
        warnings.push(`Entry ${entry.id} links to review "${slug}", which no longer exists.`);
      }
    }
  }

  for (const event of events) {
    if (event.eventId !== buildDiaryId(event.date, event.jurorId)) {
      errors.push(`Event ${event.eventId} does not match its date and juror.`);
    }
    if (event.diaryId !== event.eventId) {
      errors.push(`Event ${event.eventId} references a different diary id (${event.diaryId}).`);
    }
  }

  for (const slug of jurorsWithState) {
    let states;
    try {
      states = readJurorStates(contentRoot, slug);
    } catch {
      continue; // already reported above
    }
    if (!states) continue;

    const marker = states.character.lastEventId;
    if (marker !== 'bootstrap' && !eventIds.has(marker)) {
      errors.push(`${slug} state points at event ${marker}, which does not exist.`);
    }
    for (const [name, doc] of Object.entries(states)) {
      if (doc.lastEventId !== marker) {
        errors.push(`${slug} state files disagree: ${name} is at ${doc.lastEventId}, expected ${marker}.`);
      }
    }
  }

  for (const record of records) {
    if (record.publication.status === 'published') {
      const hasEntry = entries.some((entry) => entry.id === record.recordId);
      if (!hasEntry) {
        errors.push(`Record ${record.recordId} is published but has no entry.`);
      }
    }
  }

  return { errors, warnings, counts };
}

function main(): void {
  const contentRoot = resolveContentRoot();
  console.log(`[Diary Validate] Content root: ${contentRoot}`);

  const report = validate(contentRoot);

  for (const warning of report.warnings) {
    console.warn(`[Diary Validate] WARNING: ${warning}`);
  }

  if (report.errors.length > 0) {
    console.error(`\n[Diary Validate] ${report.errors.length} error(s):`);
    for (const error of report.errors) {
      console.error(`  - ${error}`);
    }
    process.exit(1);
  }

  console.log(
    `[Diary Validate] OK — ${report.counts.entries} entries, ${report.counts.events} events, ` +
      `${report.counts.records} records, ${report.counts.jurorsWithState} jurors with state.`
  );
}

main();
