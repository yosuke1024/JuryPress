import type { APIRoute } from 'astro';
import { getAllDiaryEntries, entrySlug } from '../../../lib/diary/data';
import { getJudge } from '../../../lib/jury';
import { buildDiaryOgSvg } from '../../../lib/diary/og-image';
import { renderOgPng } from '../../../lib/og-image';
import type { DiaryEntry } from '../../../schemas/diary';
import type { JudgeSlug } from '../../../schemas/jury';

export async function getStaticPaths() {
  return getAllDiaryEntries().map((entry) => ({
    params: { entry: entrySlug(entry) },
    props: { entry }
  }));
}

export const GET: APIRoute = async ({ props }) => {
  const entry = props.entry as DiaryEntry;
  const judge = getJudge(entry.jurorId as JudgeSlug);

  // 'raster' selects the bundled Noto faces; the system stack is not available to resvg.
  const png = await renderOgPng(buildDiaryOgSvg(entry, judge, 'raster'));

  return new Response(png, {
    headers: {
      'Content-Type': 'image/png'
    }
  });
};
