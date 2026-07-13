import { HackerNewsAdapter } from './hacker_news';
import { GitHubAdapter } from './github';
import type { SourceAdapter } from './adapter';
import type { Candidate } from '../../schemas/selection';

export class CrossSourceAdapter implements SourceAdapter {
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async fetchCandidates(date: Date): Promise<Candidate[]> {
    const hnAdapter = new HackerNewsAdapter('hacker_news_top', 'top');
    const ghAdapter = new GitHubAdapter('github_breakout', 'created:>{DATE} stars:>50');

    const [hnCandidates, ghCandidates] = await Promise.all([
      hnAdapter.fetchCandidates(date),
      ghAdapter.fetchCandidates(date)
    ]);

    // Intersection by canonical URL
    const hnMap = new Map(hnCandidates.map(c => [c.canonicalUrl.replace(/\/$/, '').toLowerCase(), c]));
    
    const crossCandidates: Candidate[] = [];
    
    for (const gh of ghCandidates) {
      const normalizedUrl = gh.canonicalUrl.replace(/\/$/, '').toLowerCase();
      if (hnMap.has(normalizedUrl)) {
        const hn = hnMap.get(normalizedUrl)!;
        crossCandidates.push({
          source: this.id,
          sourceId: `${hn.sourceId}-${gh.sourceId}`,
          name: gh.name, // Prefer GH name as it's often more canonical
          canonicalUrl: gh.canonicalUrl,
          sourceUrl: hn.sourceUrl, // Keep HN discussion link
          sourceRank: hn.sourceRank + gh.sourceRank, // combined rank
          popularityValue: hn.popularityValue + gh.popularityValue,
          popularityUnit: 'combined points/stars',
          collectedAt: new Date().toISOString(),
          metadata: { ...hn.metadata, ...gh.metadata }
        });
      }
    }
    
    // Sort by combined popularity
    crossCandidates.sort((a, b) => b.popularityValue - a.popularityValue);
    
    return crossCandidates;
  }
}
