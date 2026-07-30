import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  FONT_STACKS,
  escapeXml,
  estimateTextWidth,
  fitToWidth,
  stripUnsupportedGlyphs,
  type OgFontStack
} from '../og-image';
import type { DiaryEntry } from '../../schemas/diary';
import type { JudgeProfile } from '../../schemas/jury';

/**
 * The social card for one diary entry: a pulled quote, whose juror it is, and the mood.
 *
 * English only, on purpose. The rasteriser is given the bundled Noto Sans/Serif and nothing
 * else, so Japanese would render as blank boxes on the card even though the page itself
 * carries both languages properly. A card that silently drops half its glyphs is worse than
 * one that never promised them.
 *
 * The avatar is embedded as a data URI because the rasteriser has no network and no notion of
 * the site's base path; `stripUnsupportedGlyphs` handles the emoji the fonts cannot draw.
 */

const CANVAS = { width: 1200, height: 630 } as const;
const PALETTE = {
  canvas: '#f4efe6',
  surface: '#fffdf8',
  ink: '#17201d',
  inkMuted: '#5f6762',
  rule: '#d5ccbd',
  ruleStrong: '#aaa091',
  accent: '#b85c2d'
} as const;

const QUOTE_COLUMN_WIDTH = 800;
const MAX_QUOTE_LINES = 5;

/**
 * The vertical band the quote must live inside: below the JuryDiary label and date, above the
 * rule that separates the attribution row. A quote is fitted to this band rather than centred
 * on the canvas — centring a tall block grows it in both directions, and a four-line quote
 * grew straight through the header.
 */
const QUOTE_BAND_TOP = 176;
const QUOTE_BAND_BOTTOM = 466;
const QUOTE_LINE_HEIGHT = 1.26;

function wrapText(
  text: string,
  fontSizePx: number,
  maxWidthPx: number,
  maxLines: number,
  widthFactor = 1
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSizePx, widthFactor) <= maxWidthPx) {
      current = candidate;
      continue;
    }
    if (current) lines.push(current);
    if (lines.length >= maxLines) return lines;
    current = word;
  }

  if (current && lines.length < maxLines) lines.push(current);
  return lines;
}

/**
 * Picks the largest size at which the whole quote fits the column *and* the band. Both bounds
 * matter: width alone would let a long quote overflow downwards, and a line cap alone would
 * let a five-line block at 54px overrun the attribution row.
 */
function fitQuote(text: string): { fontSize: number; lines: string[] } {
  const bandHeight = QUOTE_BAND_BOTTOM - QUOTE_BAND_TOP;
  const sizes = [54, 48, 42, 38, 34, 30];

  for (const fontSize of sizes) {
    const lines = wrapText(text, fontSize, QUOTE_COLUMN_WIDTH, MAX_QUOTE_LINES, 1.02);
    const consumedWholeQuote = lines.join(' ').length >= text.length - 1;
    const blockHeight = lines.length * fontSize * QUOTE_LINE_HEIGHT;
    if (consumedWholeQuote && blockHeight <= bandHeight) return { fontSize, lines };
  }

  // Longer than the card can hold at any size: take what fits and mark the elision.
  const fontSize = sizes[sizes.length - 1];
  const maxLines = Math.max(1, Math.floor(bandHeight / (fontSize * QUOTE_LINE_HEIGHT)));
  const lines = wrapText(text, fontSize, QUOTE_COLUMN_WIDTH, maxLines, 1.02);
  lines[lines.length - 1] = fitToWidth(`${lines[lines.length - 1]}…`, fontSize, QUOTE_COLUMN_WIDTH, 1.02);
  return { fontSize, lines };
}

/**
 * Reads the juror avatar as a data URI. Returns null when unreadable, in which case the card
 * falls back to an initial — a missing portrait must not fail a build.
 */
function readAvatarDataUri(slug: string): string | null {
  try {
    const filePath = path.resolve(process.cwd(), 'public', 'avatars', `${slug}.jpg`);
    const base64 = fs.readFileSync(filePath).toString('base64');
    return `data:image/jpeg;base64,${base64}`;
  } catch {
    return null;
  }
}

export function buildDiaryOgSvg(
  entry: DiaryEntry,
  judge: JudgeProfile,
  stack: OgFontStack = 'web'
): string {
  const sans = FONT_STACKS[stack].sans;
  const serif = FONT_STACKS[stack].serif;

  const rawQuote = stripUnsupportedGlyphs(entry.shareQuote.en).replace(/\s+/g, ' ').trim();
  const { fontSize, lines } = fitQuote(rawQuote);
  const quoteLines = lines.map((line) => escapeXml(line));

  const name = escapeXml(fitToWidth(stripUnsupportedGlyphs(judge.name), 30, 360));
  const role = escapeXml(fitToWidth(stripUnsupportedGlyphs(judge.role), 22, 360));
  const mood = escapeXml(fitToWidth(stripUnsupportedGlyphs(entry.mood.en), 22, 420));
  const date = escapeXml(entry.date);

  const avatar = readAvatarDataUri(entry.jurorId);
  const avatarBlock = avatar
    ? `<clipPath id="avatarClip"><circle cx="1010" cy="196" r="72"/></clipPath>
    <image href="${avatar}" x="938" y="124" width="144" height="144"
           preserveAspectRatio="xMidYMid slice" clip-path="url(#avatarClip)"/>
    <circle cx="1010" cy="196" r="72" fill="none" stroke="${PALETTE.ruleStrong}" stroke-width="2"/>`
    : `<circle cx="1010" cy="196" r="72" fill="${PALETTE.surface}" stroke="${PALETTE.ruleStrong}" stroke-width="2"/>
    <text x="1010" y="214" font-family="${serif}" font-size="60" font-weight="700" fill="${PALETTE.ink}" text-anchor="middle">${escapeXml(judge.name.charAt(0))}</text>`;

  // Centred within the band, not on the canvas, so the block can never grow into the header.
  const blockHeight = quoteLines.length * fontSize * QUOTE_LINE_HEIGHT;
  const firstBaseline =
    QUOTE_BAND_TOP + (QUOTE_BAND_BOTTOM - QUOTE_BAND_TOP - blockHeight) / 2 + fontSize * 0.78;
  const quoteTspans = quoteLines
    .map(
      (line, index) =>
        `<text x="80" y="${Math.round(firstBaseline + index * fontSize * QUOTE_LINE_HEIGHT)}" font-family="${serif}" font-size="${fontSize}" font-weight="700" fill="${PALETTE.ink}">${line}</text>`
    )
    .join('\n    ');

  return `<svg width="${CANVAS.width}" height="${CANVAS.height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="${PALETTE.canvas}"/>
    <rect x="30" y="30" width="1140" height="570" fill="none" stroke="${PALETTE.rule}" stroke-width="1"/>

    <text x="80" y="104" font-family="${sans}" font-size="22" font-weight="700" letter-spacing="4" fill="${PALETTE.accent}">JURYDIARY</text>
    <text x="80" y="134" font-family="${sans}" font-size="18" fill="${PALETTE.inkMuted}">${date}</text>

    ${avatarBlock}

    ${quoteTspans}

    <line x1="80" y1="486" x2="1120" y2="486" stroke="${PALETTE.rule}" stroke-width="1"/>

    <text x="80" y="524" font-family="${serif}" font-size="30" font-weight="700" fill="${PALETTE.ink}">${name}</text>
    <text x="80" y="552" font-family="${sans}" font-size="22" fill="${PALETTE.inkMuted}">${role}</text>
    <text x="80" y="580" font-family="${sans}" font-size="22" fill="${PALETTE.accent}">Mood: ${mood}</text>

    <text x="1120" y="524" font-family="${sans}" font-size="20" font-weight="700" fill="${PALETTE.ink}" text-anchor="end">JuryPress</text>
    <text x="1120" y="552" font-family="${sans}" font-size="18" fill="${PALETTE.inkMuted}" text-anchor="end">An autonomous fiction experiment</text>
    <text x="1120" y="580" font-family="${sans}" font-size="18" fill="${PALETTE.inkMuted}" text-anchor="end">PixApps</text>
  </svg>`;
}
