/**
 * Which ad network serves a placement, decided from the build's environment.
 *
 * Two networks can render the in-article slots: Google AdSense (responsive
 * units) and 忍者AdMax (fixed-size frames). Which one is used is NOT a runtime
 * decision — it is whichever the build was given IDs for, so the answer is
 * visible in the deploy log and cannot drift per reader:
 *
 * - AdSense configured (enabled + valid client + this placement's slot)
 *   → AdSense, exactly as before.
 * - Otherwise AdMax configured (enabled + a frame for this placement)
 *   → AdMax, and no Google ad code loads anywhere on the page.
 * - Neither → no ad, and no ad network is contacted at all.
 *
 * A `noindex` build serves neither: it is a staging artifact, and an ad
 * impression from a page we ask search engines to ignore is an impression
 * from nobody.
 *
 * The AdMax frames are fixed-size by nature of the network, and the size is
 * part of the contract with the console: **300×250 for both categories**,
 * which is the size the article layout reserves. A frame created at another
 * size will overflow or leave a gap, so the ID names carry the placement and
 * the device category, and this module carries the size.
 */

export type AdPlacement = 'article_1' | 'article_2';

/** The 300×250 rectangle both AdMax categories offer (see the module note). */
export const ADMAX_FRAME_SIZE = { width: 300, height: 250 } as const;

export interface AdEnv {
  JURYPRESS_NOINDEX?: string;
  PUBLIC_ADSENSE_ENABLED?: string;
  PUBLIC_ADSENSE_CLIENT_ID?: string;
  PUBLIC_ADSENSE_SLOT_ARTICLE_1?: string;
  PUBLIC_ADSENSE_SLOT_ARTICLE_2?: string;
  PUBLIC_ADMAX_ENABLED?: string;
  PUBLIC_ADMAX_ARTICLE_1_PC?: string;
  PUBLIC_ADMAX_ARTICLE_1_SP?: string;
  PUBLIC_ADMAX_ARTICLE_2_PC?: string;
  PUBLIC_ADMAX_ARTICLE_2_SP?: string;
}

export type AdChoice =
  | { network: 'adsense'; clientId: string; slotId: string }
  | { network: 'admax'; pcFrameId: string | null; spFrameId: string | null }
  | { network: 'none' };

const trimmed = (value: string | undefined): string => (value ?? '').trim();

/** AdSense publisher IDs have a recognisable shape; anything else is a typo. */
const isAdSenseClient = (value: string): boolean => /^ca-pub-\d{16}$/.test(value);

/** AdMax frame IDs are the 32 hex characters of the console's tag URL. */
const isAdMaxFrame = (value: string): boolean => /^[0-9a-f]{32}$/.test(value);

const frameOrNull = (value: string | undefined): string | null => {
  const id = trimmed(value);
  return isAdMaxFrame(id) ? id : null;
};

export function isNoindexBuild(env: AdEnv): boolean {
  return trimmed(env.JURYPRESS_NOINDEX) === 'true';
}

/**
 * The AdSense loader belongs on every page of an AdSense build, not only the
 * ones carrying a unit: Google's site review looks for it site-wide, and an
 * `<ins>` without it renders nothing. An AdMax build loads no Google code at
 * all — AdMax's own loader travels with the unit that needs it.
 */
export function adSenseClientId(env: AdEnv): string | null {
  if (isNoindexBuild(env)) return null;
  if (trimmed(env.PUBLIC_ADSENSE_ENABLED) !== 'true') return null;
  const clientId = trimmed(env.PUBLIC_ADSENSE_CLIENT_ID);
  return isAdSenseClient(clientId) ? clientId : null;
}

export function chooseAd(env: AdEnv, placement: AdPlacement): AdChoice {
  if (isNoindexBuild(env)) return { network: 'none' };

  const clientId = adSenseClientId(env);
  const slotId = trimmed(
    placement === 'article_1' ? env.PUBLIC_ADSENSE_SLOT_ARTICLE_1 : env.PUBLIC_ADSENSE_SLOT_ARTICLE_2,
  );
  if (clientId && slotId) return { network: 'adsense', clientId, slotId };

  if (trimmed(env.PUBLIC_ADMAX_ENABLED) === 'true') {
    const pcFrameId = frameOrNull(
      placement === 'article_1' ? env.PUBLIC_ADMAX_ARTICLE_1_PC : env.PUBLIC_ADMAX_ARTICLE_2_PC,
    );
    const spFrameId = frameOrNull(
      placement === 'article_1' ? env.PUBLIC_ADMAX_ARTICLE_1_SP : env.PUBLIC_ADMAX_ARTICLE_2_SP,
    );
    if (pcFrameId || spFrameId) return { network: 'admax', pcFrameId, spFrameId };
  }

  return { network: 'none' };
}
