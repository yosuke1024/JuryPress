import type { Candidate } from '../../schemas/selection';
import type { SourceAdapter } from './adapter';
import { SourceError } from './adapter';

export interface GitHubAdapterOptions {
  /**
   * How candidates are ranked (sourceRank assignment).
   * - 'stars': absolute star count descending (API order).
   * - 'stars_per_day': stars divided by days since repository creation, descending.
   *   Deterministic for a given run date and API response; favors velocity over
   *   accumulated popularity so young rising projects outrank established giants.
   */
  rankBy?: 'stars' | 'stars_per_day';
}

/** Days a repository is considered at least "one day old" to avoid divide-by-zero spikes. */
const MIN_AGE_DAYS = 1;

/**
 * "GitHub New & Rising" pool: repositories created recently that are gaining
 * stars, with an upper star band excluding projects that have already broken
 * out. Shared by the Tuesday slot and the Sunday cross-source intersection.
 */
export const NEW_AND_RISING_QUERY = 'created:>{DATE:14} stars:20..3000 archived:false fork:false';

export class GitHubAdapter implements SourceAdapter {
  private rankBy: 'stars' | 'stars_per_day';

  constructor(public id: string, private query: string, options: GitHubAdapterOptions = {}) {
    this.rankBy = options.rankBy ?? 'stars';
  }

  async fetchCandidates(date: Date): Promise<Candidate[]> {
    try {
      let q = this.query;

      // Replace dynamic date tokens:
      //   {DATE}   -> run date minus 7 days (legacy)
      //   {DATE:N} -> run date minus N days
      q = q.replace(/\{DATE(?::(\d+))?\}/g, (_match, days) => {
        const offset = days ? parseInt(days, 10) : 7;
        const pastDate = new Date(date);
        pastDate.setDate(pastDate.getDate() - offset);
        return pastDate.toISOString().split('T')[0];
      });

      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=100`;

      const headers: Record<string, string> = {
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'JuryPress/1.0'
      };

      if (process.env.GITHUB_TOKEN) {
        headers['Authorization'] = `Bearer ${process.env.GITHUB_TOKEN}`;
      }

      const response = await fetch(url, { headers });
      if (!response.ok) {
        throw new Error(`Failed to fetch GitHub repos: ${response.status}`);
      }

      const data = await response.json();
      let items: any[] = data.items || [];

      if (this.rankBy === 'stars_per_day') {
        const ageDays = (item: any): number => {
          const created = new Date(item.created_at).getTime();
          const elapsed = (date.getTime() - created) / (1000 * 60 * 60 * 24);
          return Math.max(MIN_AGE_DAYS, elapsed);
        };
        const velocity = (item: any): number => (item.stargazers_count || 0) / ageDays(item);
        items = [...items].sort((a, b) => {
          const dv = velocity(b) - velocity(a);
          if (dv !== 0) return dv;
          if (a.stargazers_count !== b.stargazers_count) return b.stargazers_count - a.stargazers_count;
          return String(a.full_name).localeCompare(String(b.full_name));
        });
      }

      const candidates: Candidate[] = [];
      const collectedAt = new Date().toISOString();
      let rank = 1;

      for (const item of items) {
        const created = new Date(item.created_at).getTime();
        const elapsedDays = Math.max(MIN_AGE_DAYS, (date.getTime() - created) / (1000 * 60 * 60 * 24));
        const starsPerDay = Math.round(((item.stargazers_count || 0) / elapsedDays) * 100) / 100;

        candidates.push({
          source: this.id,
          sourceId: item.id.toString(),
          name: item.full_name,
          canonicalUrl: item.html_url,
          sourceUrl: item.html_url,
          sourceRank: rank++,
          popularityValue: item.stargazers_count,
          popularityUnit: 'stars',
          publishedAt: item.created_at,
          collectedAt,
          metadata: {
            description: item.description,
            language: item.language,
            forks: item.forks_count,
            rank_by: this.rankBy,
            stars_per_day: starsPerDay
          }
        });
      }

      return candidates;
    } catch (e) {
      throw new SourceError('Failed to fetch from GitHub', this.id, e);
    }
  }
}
