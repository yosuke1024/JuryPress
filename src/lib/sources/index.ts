import { HackerNewsAdapter } from './hacker_news';
import { GitHubAdapter } from './github';
import { HuggingFaceAdapter } from './hugging_face';
import { CrossSourceAdapter } from './cross_source';
import type { SourceAdapter } from './adapter';

export function getSourceAdapter(sourceId: string): SourceAdapter {
  switch (sourceId) {
    case 'hacker_news_top':
      return new HackerNewsAdapter(sourceId, 'top');
    case 'show_hn':
      return new HackerNewsAdapter(sourceId, 'show');
    case 'github_breakout':
      // Repos created in the last 7 days with >50 stars
      return new GitHubAdapter(sourceId, 'created:>{DATE} stars:>50');
    case 'github_oss':
      // General popular OSS, perhaps we search broadly
      return new GitHubAdapter(sourceId, 'stars:>1000');
    case 'github_developer_tools':
      return new GitHubAdapter(sourceId, 'topic:developer-tools stars:>100');
    case 'huggingface_spaces':
      return new HuggingFaceAdapter(sourceId);
    case 'cross_source':
      return new CrossSourceAdapter(sourceId);
    default:
      throw new Error(`Unknown source adapter: ${sourceId}`);
  }
}
