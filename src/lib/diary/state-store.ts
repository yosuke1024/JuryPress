import * as fs from 'node:fs';
import * as path from 'node:path';
import type { z } from 'zod';
import {
  DIARY_STATE_FILES,
  DiaryCharacterStateSchema,
  DiaryLifeStateSchema,
  DiaryMemoriesSchema,
  DiaryPrivateCanonSchema,
  DiaryRelationshipsSchema,
  type DiaryJurorStates
} from '../../schemas/diary-state';
import type { JudgeSlug } from '../../schemas/jury';
import { JUDGE_SLUGS } from '../../schemas/jury';
import { diaryJurorDir, readJsonIfExists, writeJsonAtomic } from './storage';

/**
 * Reads and writes the five state files that make up one juror's mutable self.
 *
 * Always as a set. Reading four of five and carrying on would mean generating tomorrow's
 * diary against a persona that is missing a layer; writing four of five would leave the
 * persona in a state no event can describe. A partial set is therefore an error, never a
 * recoverable condition — and never something this module silently re-initialises, because
 * a fresh state file would erase the accumulated experiment rather than report the problem.
 */

const STATE_SCHEMAS = {
  canon: DiaryPrivateCanonSchema,
  character: DiaryCharacterStateSchema,
  life: DiaryLifeStateSchema,
  relationships: DiaryRelationshipsSchema,
  memories: DiaryMemoriesSchema
} as const;

type StateKey = keyof typeof STATE_SCHEMAS;

export function jurorStateFilePaths(
  contentRoot: string,
  jurorId: string
): Record<StateKey, string> {
  const dir = diaryJurorDir(contentRoot, jurorId);
  return {
    canon: path.join(dir, DIARY_STATE_FILES.canon),
    character: path.join(dir, DIARY_STATE_FILES.character),
    life: path.join(dir, DIARY_STATE_FILES.life),
    relationships: path.join(dir, DIARY_STATE_FILES.relationships),
    memories: path.join(dir, DIARY_STATE_FILES.memories)
  };
}

export function jurorStatesExist(contentRoot: string, jurorId: string): boolean {
  const paths = jurorStateFilePaths(contentRoot, jurorId);
  return Object.values(paths).some((filePath) => fs.existsSync(filePath));
}

export function anyJurorStatesExist(contentRoot: string): boolean {
  return JUDGE_SLUGS.some((slug) => jurorStatesExist(contentRoot, slug));
}

/** Returns null when this juror has never been bootstrapped; throws when the set is partial. */
export function readJurorStates(
  contentRoot: string,
  jurorId: string
): DiaryJurorStates | null {
  const paths = jurorStateFilePaths(contentRoot, jurorId);
  const present = Object.entries(paths).filter(([, filePath]) => fs.existsSync(filePath));

  if (present.length === 0) return null;
  if (present.length !== Object.keys(paths).length) {
    const missing = Object.entries(paths)
      .filter(([, filePath]) => !fs.existsSync(filePath))
      .map(([name]) => name);
    throw new Error(
      `[Diary State] ${jurorId} has an incomplete state set; missing: ${missing.join(', ')}. ` +
        'Refusing to generate against a partial persona.'
    );
  }

  const parseStateFile = <Schema extends z.ZodTypeAny>(
    schema: Schema,
    key: StateKey
  ): z.infer<Schema> => {
    const parsed = schema.safeParse(readJsonIfExists(paths[key]));
    if (!parsed.success) {
      throw new Error(
        `[Diary State] ${jurorId}/${DIARY_STATE_FILES[key]} failed validation: ${parsed.error.message}`
      );
    }
    return parsed.data;
  };

  const states: DiaryJurorStates = {
    canon: parseStateFile(DiaryPrivateCanonSchema, 'canon'),
    character: parseStateFile(DiaryCharacterStateSchema, 'character'),
    life: parseStateFile(DiaryLifeStateSchema, 'life'),
    relationships: parseStateFile(DiaryRelationshipsSchema, 'relationships'),
    memories: parseStateFile(DiaryMemoriesSchema, 'memories')
  };

  if (states.canon.jurorId !== jurorId) {
    throw new Error(
      `[Diary State] ${jurorId} state files claim to belong to ${states.canon.jurorId}.`
    );
  }

  return states;
}

export function readAllJurorStates(
  contentRoot: string
): Partial<Record<JudgeSlug, DiaryJurorStates>> {
  const all: Partial<Record<JudgeSlug, DiaryJurorStates>> = {};
  for (const slug of JUDGE_SLUGS) {
    const states = readJurorStates(contentRoot, slug);
    if (states) all[slug] = states;
  }
  return all;
}

/**
 * Writes all five files. Re-validates each document first, so a caller that assembled an
 * invalid state cannot persist it even if its own checks were skipped.
 */
export function writeJurorStates(
  contentRoot: string,
  jurorId: string,
  states: DiaryJurorStates
): void {
  const paths = jurorStateFilePaths(contentRoot, jurorId);
  for (const key of Object.keys(STATE_SCHEMAS) as StateKey[]) {
    const parsed = STATE_SCHEMAS[key].parse(states[key]);
    writeJsonAtomic(paths[key], parsed);
  }
}
