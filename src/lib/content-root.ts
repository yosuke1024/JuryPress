import path from 'node:path';
import fs from 'node:fs';

export type JuryPressDataMode = 'fixture' | 'production';

export function resolveDataMode(): JuryPressDataMode {
  // Use import.meta.env first (for Astro/Vite), fallback to process.env
  const raw = (typeof import.meta !== 'undefined' && import.meta.env?.JURYPRESS_DATA_MODE) || process.env.JURYPRESS_DATA_MODE;

  if (raw === 'fixture' || raw === 'production') {
    return raw;
  }

  throw new Error(
    'JURYPRESS_DATA_MODE must be explicitly set to fixture or production.'
  );
}

export function resolveContentRoot(): string {
  const mode = resolveDataMode();

  if (mode === 'fixture') {
    return path.resolve(process.cwd(), 'tests', 'fixtures');
  }

  const rawRoot = (typeof import.meta !== 'undefined' && import.meta.env?.JURYPRESS_CONTENT_ROOT) || process.env.JURYPRESS_CONTENT_ROOT;
  const configuredRoot = rawRoot?.trim();

  if (!configuredRoot) {
    throw new Error(
      'JURYPRESS_CONTENT_ROOT is required in production mode.'
    );
  }

  // Reject path traversal explicitly
  const normalized = path.normalize(configuredRoot);
  const parts = normalized.split(path.sep);
  if (parts.includes('..') || parts.includes('.')) {
    throw new Error(
      `Directory traversal attempt detected in JURYPRESS_CONTENT_ROOT: ${configuredRoot}`
    );
  }

  const resolvedRoot = path.resolve(configuredRoot);

  if (!fs.existsSync(resolvedRoot)) {
    throw new Error(
      `Production content root does not exist: ${resolvedRoot}`
    );
  }

  return resolvedRoot;
}
