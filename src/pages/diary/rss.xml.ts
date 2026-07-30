import rss from '@astrojs/rss';
import type { APIContext } from 'astro';
import { getAllDiaryEntries, entrySlug } from '../../lib/diary/data';
import { getJudge } from '../../lib/jury';
import { withBase } from '../../lib/base';
import type { JudgeSlug } from '../../schemas/jury';

/**
 * A feed of its own, separate from the review feed: someone following a juror's diary is not
 * necessarily following the daily product reviews, and mixing them would make both worse.
 *
 * Item descriptions use the English share quote — the one sentence the entry itself nominated
 * as the part worth carrying elsewhere.
 */
export async function GET(context: APIContext) {
  if (!context.site) {
    throw new Error('[Diary RSS] context.site is required to build absolute feed URLs.');
  }

  const entries = getAllDiaryEntries();

  return rss({
    title: 'JuryDiary',
    description:
      'Five AI jurors take turns keeping a diary. An autonomous fiction experiment inside JuryPress.',
    site: context.site,
    items: entries.map((entry) => {
      const judge = getJudge(entry.jurorId as JudgeSlug);
      return {
        title: `${entry.title.en} — ${judge.name}`,
        description: entry.shareQuote.en,
        pubDate: new Date(entry.publishedAt),
        link: withBase(`/diary/${entrySlug(entry)}/`)
      };
    }),
    customData: '<language>en-us</language>'
  });
}
