import { HackerNewsAdapter } from './hacker_news';
import { GitHubAdapter, NEW_AND_RISING_QUERY } from './github';
import type { SourceAdapter } from './adapter';
import type { Candidate } from '../../schemas/selection';

/**
 * "Cross-source Momentum": candidates visible on more than one channel at once.
 *
 * The Hacker News side is the union of Top and Show HN stories (Show HN is where
 * young projects actually appear), matched against the GitHub New & Rising pool
 * by normalized repository URL. Requiring HN Top alone made the intersection
 * almost always empty, which silently turned Sunday into its fallback source.
 */
export class CrossSourceAdapter implements SourceAdapter {
  id: string;

  constructor(id: string) {
    this.id = id;
  }

  async fetchCandidates(date: Date): Promise<Candidate[]> {
    const hnTop = new HackerNewsAdapter('hacker_news_top', 'top');
    const hnShow = new HackerNewsAdapter('show_hn', 'show');
    const ghAdapter = new GitHubAdapter('github_breakout', NEW_AND_RISING_QUERY, { rankBy: 'stars_per_day' });

    const [topCandidates, showCandidates, ghCandidates] = await Promise.all([
      hnTop.fetchCandidates(date),
      hnShow.fetchCandidates(date),
      ghAdapter.fetchCandidates(date)
    ]);

    const normalize = (url: string) => url.replace(/\/$/, '').toLowerCase();

    // Union of both HN lists; on overlap keep the better (lower) rank.
    const hnMap = new Map<string, Candidate>();
    for (const c of [...topCandidates, ...showCandidates]) {
      const key = normalize(c.canonicalUrl);
      const existing = hnMap.get(key);
      if (!existing || c.sourceRank < existing.sourceRank) hnMap.set(key, c);
    }

    const crossCandidates: Candidate[] = [];

    for (const gh of ghCandidates) {
      const normalizedUrl = normalize(gh.canonicalUrl);
      if (hnMap.has(normalizedUrl)) {
        const hn = hnMap.get(normalizedUrl)!;
        crossCandidates.push({
          source: this.id,
          sourceId: `${hn.sourceId}-${gh.sourceId}`,
          name: gh.name, // Prefer GH name as it's often more canonical
          canonicalUrl: gh.canonicalUrl,
          sourceUrl: hn.sourceUrl, // Keep HN discussion link
          sourceRank: hn.sourceRank + gh.sourceRank, // combined rank, lower is better
          popularityValue: hn.popularityValue + gh.popularityValue,
          popularityUnit: 'combined points/stars',
          collectedAt: new Date().toISOString(),
          metadata: { ...hn.metadata, ...gh.metadata, hn_source: hn.source, hn_rank: hn.sourceRank, gh_rank: gh.sourceRank }
        });
      }
    }

    // Deterministic ordering: best combined rank first, then popularity, then URL.
    crossCandidates.sort((a, b) => {
      if (a.sourceRank !== b.sourceRank) return a.sourceRank - b.sourceRank;
      if (a.popularityValue !== b.popularityValue) return b.popularityValue - a.popularityValue;
      return a.canonicalUrl.localeCompare(b.canonicalUrl);
    });

    // Reassign sequential ranks so downstream ordering matches this sort.
    crossCandidates.forEach((c, i) => { c.sourceRank = i + 1; });

    return crossCandidates;
  }
}
