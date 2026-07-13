import type { Candidate } from '../../schemas/selection';
import type { SourceAdapter } from './adapter';
import { SourceError } from './adapter';

export class GitHubAdapter implements SourceAdapter {
  constructor(public id: string, private query: string) {}

  async fetchCandidates(date: Date): Promise<Candidate[]> {
    try {
      // Date formatting for GitHub API (e.g. past 7 days for breakout)
      const dateStr = date.toISOString().split('T')[0];
      let q = this.query;
      
      // Replace dynamic date token if present
      if (q.includes('{DATE}')) {
        const pastDate = new Date(date);
        pastDate.setDate(pastDate.getDate() - 7);
        q = q.replace('{DATE}', pastDate.toISOString().split('T')[0]);
      }

      const url = `https://api.github.com/search/repositories?q=${encodeURIComponent(q)}&sort=stars&order=desc&per_page=50`;
      
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
      const items = data.items || [];

      const candidates: Candidate[] = [];
      const collectedAt = new Date().toISOString();
      let rank = 1;

      for (const item of items) {
        // Exclude completely empty repos or purely docs (often hard to filter, but we try)
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
            forks: item.forks_count
          }
        });
      }

      return candidates;
    } catch (e) {
      throw new SourceError('Failed to fetch from GitHub', this.id, e);
    }
  }
}
