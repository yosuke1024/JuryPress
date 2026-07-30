import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runAstroBuild } from '../helpers/astro-build';

/**
 * Builds the real site and inspects the generated diary HTML.
 *
 * Two builds, because two different promises need proving. The fixture build checks that an
 * entry actually renders both languages without JavaScript. The empty build checks the
 * promise that matters to the *other* experiment sharing this repository: diary code ships to
 * public `main`, every content workflow checks out `main`, and so a review build against a
 * content root with no diary in it must keep working exactly as before.
 */
describe('Diary pages (real build, fixture content)', () => {
  let distDir: string;

  beforeAll(() => {
    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-diary-dist-'));
    runAstroBuild(distDir, { JURYPRESS_DATA_MODE: 'fixture' });
  }, 300_000);

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
  });

  const read = (...segments: string[]) =>
    fs.readFileSync(path.join(distDir, ...segments), 'utf8');

  it('builds the index, the entries and every juror archive', () => {
    expect(fs.existsSync(path.join(distDir, 'diary', 'index.html'))).toBe(true);
    for (const slug of ['2026-08-01-alex', '2026-08-02-david', '2026-08-03-lisa', '2026-08-06-alex']) {
      expect(fs.existsSync(path.join(distDir, 'diary', slug, 'index.html'))).toBe(true);
    }
    for (const juror of ['alex', 'david', 'lisa', 'sarah', 'marcus']) {
      expect(fs.existsSync(path.join(distDir, 'diary', 'jurors', juror, 'index.html'))).toBe(true);
    }
  });

  it('renders both languages in the page itself, correctly tagged', () => {
    const html = read('diary', '2026-08-02-david', 'index.html');

    expect(html).toContain('id="entry-en"');
    expect(html).toContain('id="entry-ja"');
    expect(html).toMatch(/id="entry-en"[^>]*lang="en"/);
    expect(html).toMatch(/id="entry-ja"[^>]*lang="ja"/);

    // The prose itself, not a placeholder a script would have to fill in.
    expect(html).toContain('Agreement that fast usually means nobody checked');
    expect(html).toContain('あの速さの合意は');
    expect(html).toContain('The Cold Joint');
    expect(html).toContain('はんだの浮き');
  });

  it('renders the share quotes in both languages without scripting', () => {
    const html = read('diary', '2026-08-02-david', 'index.html');
    expect(html).toContain('Share this entry');
    expect(html).toContain('— David, JuryDiary');
    // The permalink is present as text, so the entry is shareable with JS disabled.
    expect(html).toContain('/diary/2026-08-02-david/');
  });

  it('hides share buttons until scripting can make them work', () => {
    const html = read('diary', '2026-08-02-david', 'index.html');
    expect(html).toMatch(/data-share-native[^>]*hidden/);
    expect(html).toMatch(/data-share-copy-url[^>]*hidden/);
  });

  it('states that the diary is fiction, in both languages, on every diary page', () => {
    for (const page of [
      ['diary', 'index.html'],
      ['diary', '2026-08-02-david', 'index.html'],
      ['diary', 'jurors', 'david', 'index.html']
    ]) {
      const html = read(...page);
      expect(html).toContain('JuryDiary is an autonomous fiction experiment');
      expect(html).toContain('JuryDiaryは、自律生成されるフィクション実験です');
    }
  });

  it('links a work-themed entry to the review behind it', () => {
    const html = read('diary', '2026-08-02-david', 'index.html');
    expect(html).toContain('Reviews behind this entry');
    expect(html).toContain('href="/reviews/fixture-product/"');
  });

  it('does not link a private-themed entry to any review', () => {
    const html = read('diary', '2026-08-01-alex', 'index.html');
    expect(html).not.toContain('Reviews behind this entry');
  });

  it('never publishes internal persona state', () => {
    const html = read('diary', 'jurors', 'david', 'index.html');
    // Private Canon, relationship scores and trait strengths stay out of the site entirely.
    expect(html).not.toContain('workbench under the window');
    expect(html).not.toContain('trust');
    expect(html).not.toContain('emergingTraits');
    expect(html).not.toContain('lastEventId');
  });

  it('renders a juror archive that has no entries yet', () => {
    const html = read('diary', 'jurors', 'marcus', 'index.html');
    expect(html).toContain('has not written a diary entry yet');
  });

  it('shows the archive and the duty roster on the index', () => {
    const html = read('diary', 'index.html');
    expect(html).toContain('Whose turn it is');
    expect(html).toContain('Latest entry');
    expect(html).toContain('The five diarists');
  });

  it('generates an OG card per entry', () => {
    for (const slug of ['2026-08-01-alex', '2026-08-02-david', '2026-08-03-lisa', '2026-08-06-alex']) {
      const file = path.join(distDir, 'diary', 'og', `${slug}.png`);
      expect(fs.existsSync(file)).toBe(true);
      const header = fs.readFileSync(file).subarray(0, 8);
      expect([...header]).toEqual([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
  });

  it('publishes a diary feed and lists the diary in the sitemap', () => {
    const rss = read('diary', 'rss.xml');
    expect((rss.match(/<item>/g) ?? []).length).toBe(4);
    expect(rss).toContain('JuryDiary');

    const sitemap = read('sitemap-0.xml');
    expect(sitemap).toContain('/diary/');
    expect(sitemap).toContain('/diary/2026-08-02-david/');
    expect(sitemap).toContain('/diary/jurors/david/');
  });

  it('adds the diary to the section navigation', () => {
    const html = read('index.html');
    expect(html).toContain('>Diary<');
  });

  /**
   * Explicit reading is only worth anything if a reader can follow it. Both directions of the
   * thread are rendered: the reply says what it answers, and the answered entry gains the
   * reply — which usually lands days later, and is the part worth finding.
   */
  it('shows what a reply was written after reading', () => {
    const html = read('diary', '2026-08-06-alex', 'index.html');
    expect(html).toContain('Written after reading');
    expect(html).toContain('href="/diary/2026-08-03-lisa/"');
    expect(html).toContain('The Corner Again, In Worse Light');
  });

  it('shows the reply on the entry that was answered', () => {
    const html = read('diary', '2026-08-03-lisa', 'index.html');
    expect(html).toContain('One juror answered this');
    expect(html).toContain('href="/diary/2026-08-06-alex/"');
    expect(html).toContain('Four Times, On Purpose');
  });

  it('does not claim a thread on an entry that has none', () => {
    const html = read('diary', '2026-08-01-alex', 'index.html');
    expect(html).not.toContain('Written after reading');
    expect(html).not.toContain('answered this');
  });

  it('escapes entry text rather than injecting it as markup', () => {
    // Everything the model writes is rendered as text; this guards the share payload in
    // particular, which is embedded in an attribute.
    const html = read('diary', '2026-08-02-david', 'index.html');
    expect(html).not.toContain('<script>alert');
    expect(html).toMatch(/data-share-text-en="[^"]*"/);
  });
});

describe('Diary pages (real build, content root with no diary)', () => {
  let distDir: string;
  let contentRoot: string;

  beforeAll(() => {
    contentRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-nodiary-content-'));
    // A production content root that has been initialised but has no reviews and no diary.
    fs.writeFileSync(
      path.join(contentRoot, 'manifest.json'),
      `${JSON.stringify(
        {
          schema_version: '1.0.0',
          data_class: 'production',
          initialized: true,
          reviews: 0,
          ranking_eligible_reviews: 0,
          related_party_reviews: 0
        },
        null,
        2
      )}\n`
    );

    distDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jurypress-nodiary-dist-'));
    runAstroBuild(distDir, {
      JURYPRESS_DATA_MODE: 'production',
      JURYPRESS_CONTENT_ROOT: contentRoot,
      JURYPRESS_SITE_URL: 'https://pixapps.ai'
    });
  }, 300_000);

  afterAll(() => {
    fs.rmSync(distDir, { recursive: true, force: true });
    fs.rmSync(contentRoot, { recursive: true, force: true });
  });

  it('still builds the diary index, explaining that nothing has been written yet', () => {
    const html = fs.readFileSync(path.join(distDir, 'diary', 'index.html'), 'utf8');
    expect(html).toContain('No entries yet');
    expect(html).toContain('JuryDiary is an autonomous fiction experiment');
  });

  it('still builds every juror archive', () => {
    for (const juror of ['alex', 'david', 'lisa', 'sarah', 'marcus']) {
      expect(fs.existsSync(path.join(distDir, 'diary', 'jurors', juror, 'index.html'))).toBe(true);
    }
  });

  it('produces an empty diary feed rather than failing', () => {
    const rss = fs.readFileSync(path.join(distDir, 'diary', 'rss.xml'), 'utf8');
    expect(rss).toContain('JuryDiary');
    expect((rss.match(/<item>/g) ?? []).length).toBe(0);
  });
});
