import type { Candidate } from '../../schemas/selection';

export interface SourceAdapter {
  id: string;
  fetchCandidates(date: Date): Promise<Candidate[]>;
}

export class SourceError extends Error {
  constructor(message: string, public source: string, public originalError?: unknown) {
    super(message);
    this.name = 'SourceError';
  }
}
