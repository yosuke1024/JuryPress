import { HackerNewsAdapter } from './hacker_news';
import { GitHubAdapter, NEW_AND_RISING_QUERY } from './github';
import { HuggingFaceAdapter } from './hugging_face';
import { CrossSourceAdapter } from './cross_source';
import type { SourceAdapter } from './adapter';

export function getSourceAdapter(sourceId: string): SourceAdapter {
  switch (sourceId) {
    case 'hacker_news_top':
      // "HN Buzz": what the tech community is discussing right now (mainstream slot).
      return new HackerNewsAdapter(sourceId, 'top');
    case 'show_hn':
      // "Show HN Launches": author-announced new projects (core discovery slot).
      return new HackerNewsAdapter(sourceId, 'show');
    case 'github_breakout':
      // "GitHub New & Rising": created in the last 14 days, 20..3000 stars,
      // ranked by star velocity — not by absolute star count.
      return new GitHubAdapter(sourceId, NEW_AND_RISING_QUERY, { rankBy: 'stars_per_day' });
    case 'github_oss':
      // "Hidden Gems": active small projects (10..500 stars, created within a
      // year, pushed within 30 days) ranked by star velocity. Replaces the old
      // all-time stars:>1000 leaderboard walk.
      return new GitHubAdapter(sourceId, 'created:>{DATE:365} pushed:>{DATE:30} stars:10..500 archived:false fork:false', { rankBy: 'stars_per_day' });
    case 'github_developer_tools':
      // "Emerging Developer Tools": recent, actively developed tools in a
      // bounded star band, ranked by star velocity.
      return new GitHubAdapter(sourceId, 'topic:developer-tools created:>{DATE:365} pushed:>{DATE:30} stars:20..5000 archived:false fork:false', { rankBy: 'stars_per_day' });
    case 'huggingface_spaces':
      // "Hugging Face Rising": recently created Spaces ranked by like velocity.
      return new HuggingFaceAdapter(sourceId);
    case 'cross_source':
      // "Cross-source Momentum": HN (Top + Show HN) ∩ GitHub New & Rising.
      return new CrossSourceAdapter(sourceId);
    default:
      throw new Error(`Unknown source adapter: ${sourceId}`);
  }
}
