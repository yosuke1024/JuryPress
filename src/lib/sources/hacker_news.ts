import type { Candidate } from '../../schemas/selection';
import type { SourceAdapter } from './adapter';
import { SourceError } from './adapter';

export class HackerNewsAdapter implements SourceAdapter {
  constructor(public id: string, private type: 'top' | 'show') {}

  async fetchCandidates(date: Date): Promise<Candidate[]> {
    try {
      const url = `https://hacker-news.firebaseio.com/v0/${this.type}stories.json`;
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`Failed to fetch HN stories: ${response.status}`);
      }
      
      const storyIds: number[] = await response.json();
      const topIds = storyIds.slice(0, 50); // Get top 50
      
      const candidates: Candidate[] = [];
      const collectedAt = new Date().toISOString();
      let rank = 1;

      for (const id of topIds) {
        const itemUrl = `https://hacker-news.firebaseio.com/v0/item/${id}.json`;
        const itemRes = await fetch(itemUrl);
        if (!itemRes.ok) continue;
        
        const item = await itemRes.json();
        if (!item || item.type !== 'story' || item.dead || item.deleted) continue;
        if (!item.url) continue; // We need a URL to review

        // Parse title to extract potential product name.
        // For Show HN: "Show HN: Product Name - description"
        let name = item.title;
        if (this.type === 'show' && name.startsWith('Show HN:')) {
          name = name.replace(/^Show HN:\s*/, '').split('-')[0].trim();
        }

        candidates.push({
          source: this.id,
          sourceId: id.toString(),
          name: name,
          canonicalUrl: item.url,
          sourceUrl: `https://news.ycombinator.com/item?id=${id}`,
          sourceRank: rank++,
          popularityValue: item.score || 0,
          popularityUnit: 'points',
          publishedAt: new Date(item.time * 1000).toISOString(),
          collectedAt,
          metadata: {
            descendants: item.descendants || 0,
            by: item.by
          }
        });
      }

      return candidates;
    } catch (e) {
      throw new SourceError('Failed to fetch from Hacker News', this.id, e);
    }
  }
}
