import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

/**
 * The PixApps global navigation is declared twice.
 *
 * - `pixapps-landing/global-header.js` builds it at runtime for the landing
 *   routes. `scripts/sync-global-header.ts` copies that file into
 *   `public/global-header.js` on every `npm run dev` / `npm run build`, so the
 *   committed copy is the landing's declaration.
 * - `src/components/GlobalHeader.astro` hand-maintains the same list, because
 *   JuryPress renders the header statically at build time and never loads the
 *   landing's script.
 *
 * Nothing made the second copy follow the first, and it silently fell behind:
 * Simple Games shipped under Products on the landing site and JuryPress kept
 * showing three products. This test is the thing that was missing.
 *
 * It compares only what both copies are supposed to agree on — the top-level
 * item order and each dropdown's entries as English renders them. The `ja`
 * labels and the JuryPress self-link legitimately differ (JuryPress is
 * English-only and links to itself by path, the landing by absolute URL).
 */

const root = process.cwd();
const landingHeader = fs.readFileSync(path.join(root, 'public/global-header.js'), 'utf8');
const astroHeader = fs.readFileSync(path.join(root, 'src/components/GlobalHeader.astro'), 'utf8');
const contextNav = fs.readFileSync(
  path.join(root, 'src/components/JuryPressContextNavigation.astro'),
  'utf8'
);

interface Child {
  id: string;
  href: string;
  status: string | null;
}

/** Pull the `children: [...]` array that follows a given `id: '<groupId>'`. */
function childrenBlock(source: string, groupId: string): string {
  const groupAt = source.indexOf(`id: '${groupId}'`);
  if (groupAt === -1) throw new Error(`no nav group '${groupId}' in this header declaration`);

  const open = source.indexOf('children: [', groupAt);
  if (open === -1) throw new Error(`nav group '${groupId}' has no children array`);

  const start = source.indexOf('[', open);
  let depth = 0;
  for (let i = start; i < source.length; i++) {
    if (source[i] === '[') depth++;
    else if (source[i] === ']' && --depth === 0) return source.slice(start + 1, i);
  }
  throw new Error(`nav group '${groupId}' has an unterminated children array`);
}

function parseChildren(source: string, groupId: string): Child[] {
  return childrenBlock(source, groupId)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .map(line => {
      const id = line.match(/id: '([^']*)'/)?.[1];
      const href = line.match(/href: '([^']*)'/)?.[1];
      const status = line.match(/status: \{[^}]*en: '([^']*)'/)?.[1] ?? null;
      if (!id || !href) throw new Error(`unparsable nav entry in '${groupId}': ${line}`);
      return { id, href, status };
    });
}

/** Top-level `id: '...'` values, in declaration order, excluding nested ones. */
function topLevelIds(source: string, dropdowns: string[]): string[] {
  const nested = new Set(dropdowns.flatMap(g => parseChildren(source, g).map(c => c.id)));
  return [...source.matchAll(/id: '([^']*)'/g)]
    .map(m => m[1])
    .filter(id => !nested.has(id));
}

const DROPDOWNS = ['products', 'open-source'];

describe('Global header parity with the landing declaration', () => {
  for (const group of DROPDOWNS) {
    it(`renders the same '${group}' entries as the landing header`, () => {
      expect(parseChildren(astroHeader, group)).toEqual(parseChildren(landingHeader, group));
    });
  }

  it('renders the same top-level items, in the same order', () => {
    expect(topLevelIds(astroHeader, DROPDOWNS)).toEqual(topLevelIds(landingHeader, DROPDOWNS));
  });
});

/**
 * The JuryPress section nav is declared twice as well, and the same drift bit it:
 * Diary reached JuryPressContextNavigation.astro and never reached the drawer list in
 * GlobalHeader.astro. Below 768px the context nav is `display: none`, so the drawer is
 * the only header route into a section — a missing entry there is an unreachable
 * section on mobile, not a cosmetic difference.
 */
function navLinks(source: string, binding: string): Array<{ label: string; href: string }> {
  const at = source.indexOf(`const ${binding} = [`);
  if (at === -1) throw new Error(`no '${binding}' declaration in this component`);

  const start = source.indexOf('[', at);
  const end = source.indexOf('];', start);
  if (end === -1) throw new Error(`'${binding}' has an unterminated array`);

  return source
    .slice(start + 1, end)
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.startsWith('{'))
    .map(line => {
      const label = line.match(/label: '([^']*)'/)?.[1];
      const href = line.match(/withBase\('([^']*)'\)/)?.[1];
      if (!label || !href) throw new Error(`unparsable '${binding}' entry: ${line}`);
      return { label, href };
    });
}

describe('Mobile drawer parity with the JuryPress context nav', () => {
  it('offers every section the context nav offers, in the same order', () => {
    expect(navLinks(astroHeader, 'localNavLinks')).toEqual(navLinks(contextNav, 'navLinks'));
  });
});
