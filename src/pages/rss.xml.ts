import rss from '@astrojs/rss';
import { getAllReviews } from '../lib/data';
import { withBase } from '../lib/base';

export async function GET(context: any) {
  const reviews = getAllReviews();
  // sort by published date descending
  reviews.sort((a, b) => new Date(b.review.published_at).getTime() - new Date(a.review.published_at).getTime());

  return rss({
    title: 'JuryPress',
    description: 'Fully automated AI review media',
    site: context.site || 'https://yosuke1024.github.io/jurypress/',
    items: reviews.map((r) => ({
      title: r.review.evaluation.article.headline,
      pubDate: new Date(r.review.published_at),
      description: r.review.evaluation.article.standfirst,
      link: withBase(`/reviews/${r.slug}/`),
    })),
    customData: `<language>en-us</language>`,
  });
}
