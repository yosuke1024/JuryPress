import { describe, expect, it } from 'vitest';
import { adSenseClientId, chooseAd, type AdEnv } from '../../src/lib/ads';

const CLIENT = 'ca-pub-6649925654956606';
const FRAME_PC = 'bb7f80ac211d5c7b63f7ca2e894c8b3f';
const FRAME_SP = '7ee5d214b39609eebc0f0d6d2c9f4939';

const adSenseEnv: AdEnv = {
  PUBLIC_ADSENSE_ENABLED: 'true',
  PUBLIC_ADSENSE_CLIENT_ID: CLIENT,
  PUBLIC_ADSENSE_SLOT_ARTICLE_1: '4230227881',
  PUBLIC_ADSENSE_SLOT_ARTICLE_2: '8489303020',
};

const adMaxEnv: AdEnv = {
  PUBLIC_ADMAX_ENABLED: 'true',
  PUBLIC_ADMAX_ARTICLE_1_PC: FRAME_PC,
  PUBLIC_ADMAX_ARTICLE_1_SP: FRAME_SP,
};

describe('chooseAd', () => {
  it('serves AdSense when this build carries a client and the placement slot', () => {
    expect(chooseAd(adSenseEnv, 'article_1')).toEqual({
      network: 'adsense',
      clientId: CLIENT,
      slotId: '4230227881',
    });
    expect(chooseAd(adSenseEnv, 'article_2')).toEqual({
      network: 'adsense',
      clientId: CLIENT,
      slotId: '8489303020',
    });
  });

  it('serves AdMax when no AdSense client was injected', () => {
    expect(chooseAd(adMaxEnv, 'article_1')).toEqual({
      network: 'admax',
      pcFrameId: FRAME_PC,
      spFrameId: FRAME_SP,
    });
  });

  /**
   * The switch is a deploy-variable change, so the two sets of IDs can sit in
   * the environment at the same time while one is being retired. AdSense
   * winning keeps that transition boring: nothing changes until its client is
   * actually removed from the build.
   */
  it('prefers AdSense when both networks are configured', () => {
    const both = { ...adSenseEnv, ...adMaxEnv };
    expect(chooseAd(both, 'article_1').network).toBe('adsense');
  });

  it('serves one placement with AdMax while the other still has an AdSense slot', () => {
    const mixed: AdEnv = {
      ...adSenseEnv,
      PUBLIC_ADSENSE_SLOT_ARTICLE_2: '',
      ...adMaxEnv,
      PUBLIC_ADMAX_ARTICLE_2_PC: FRAME_PC,
    };
    expect(chooseAd(mixed, 'article_1').network).toBe('adsense');
    expect(chooseAd(mixed, 'article_2')).toEqual({
      network: 'admax',
      pcFrameId: FRAME_PC,
      spFrameId: null,
    });
  });

  it('serves nothing without IDs, and nothing on a noindex build', () => {
    expect(chooseAd({}, 'article_1')).toEqual({ network: 'none' });
    expect(chooseAd({ ...adSenseEnv, JURYPRESS_NOINDEX: 'true' }, 'article_1')).toEqual({
      network: 'none',
    });
    expect(chooseAd({ ...adMaxEnv, JURYPRESS_NOINDEX: 'true' }, 'article_1')).toEqual({
      network: 'none',
    });
  });

  /**
   * A missing CI variable arrives as '' and .env.example ships placeholders,
   * so both have to fail closed: a malformed ID is an absent ID, never a tag
   * emitted against an account that does not exist.
   */
  it('treats a placeholder or malformed ID as absent', () => {
    expect(chooseAd({ ...adSenseEnv, PUBLIC_ADSENSE_CLIENT_ID: 'ca-pub-XXXXXXXXXXXXXXXX' }, 'article_1')).toEqual({
      network: 'none',
    });
    expect(chooseAd({ ...adSenseEnv, PUBLIC_ADSENSE_SLOT_ARTICLE_1: '  ' }, 'article_1')).toEqual({
      network: 'none',
    });
    expect(chooseAd({ ...adMaxEnv, PUBLIC_ADMAX_ARTICLE_1_PC: 'XXXX', PUBLIC_ADMAX_ARTICLE_1_SP: '' }, 'article_1')).toEqual({
      network: 'none',
    });
    // A frame for one category only is still a frame: the other category just
    // gets no ad on that page view.
    expect(chooseAd({ ...adMaxEnv, PUBLIC_ADMAX_ARTICLE_1_PC: '' }, 'article_1')).toEqual({
      network: 'admax',
      pcFrameId: null,
      spFrameId: FRAME_SP,
    });
  });

  it('needs the AdMax enable flag, like AdSense does', () => {
    expect(chooseAd({ ...adMaxEnv, PUBLIC_ADMAX_ENABLED: 'false' }, 'article_1')).toEqual({
      network: 'none',
    });
  });
});

describe('adSenseClientId', () => {
  it('is the site-wide loader gate, and closes on an AdMax build', () => {
    expect(adSenseClientId(adSenseEnv)).toBe(CLIENT);
    expect(adSenseClientId(adMaxEnv)).toBeNull();
    expect(adSenseClientId({ ...adSenseEnv, JURYPRESS_NOINDEX: 'true' })).toBeNull();
    expect(adSenseClientId({ ...adSenseEnv, PUBLIC_ADSENSE_ENABLED: 'false' })).toBeNull();
  });
});
