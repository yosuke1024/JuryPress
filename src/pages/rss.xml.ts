import rss from '@astrojs/rss';
import { getAllReviews } from '../lib/data';
import { withBase } from '../lib/base';

export async function GET(context: any) {
  if (!context.site) {
    throw new Error("Astro site URL is required for RSS generation");
  }

  const reviews = getAllReviews();
  // sort by published date descending
  reviews.sort((a, b) => new Date(b.review.published_at).getTime() - new Date(a.review.published_at).getTime());

  return rss({
    title: 'JuryPress',
    description: 'Five AI judges evaluate trending products without human editorial review.',
    site: context.site,
    items: reviews.map((r) => ({
      title: r.review.evaluation.product.name,
      pubDate: new Date(r.review.published_at),
      description: r.review.evaluation.article.standfirst,
      link: withBase(`/reviews/${r.slug}/`),
    })),
    customData: `<language>en-us</language>`,
  });
}
