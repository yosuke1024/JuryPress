export function withBase(path: string): string {
  const base = import.meta.env.BASE_URL || '/';
  const cleanBase = base.endsWith('/') ? base : base + '/';
  const cleanPath = path.startsWith('/') ? path.slice(1) : path;
  return cleanBase + cleanPath;
}

/**
 * Absolute form of an already-based path, for a canonical or a shareable permalink.
 *
 * `withBase()` alone yields `/jurypress/diary/…`, and a *relative* canonical resolves
 * against whatever origin served the page. On a preview deploy that makes the duplicate
 * declare itself canonical instead of pointing at production — the exact case a canonical
 * exists to prevent.
 *
 * Falls back to the path alone when no site is configured, rather than inventing a host:
 * a fabricated origin would be baked into a permalink and then shared. `astro.config.mjs`
 * requires `JURYPRESS_SITE_URL` in production mode, so production always gets the
 * absolute form.
 */
export function absoluteUrl(path: string, site: URL | undefined): string {
  if (!site) return path;
  // `//foo` is protocol-relative, so `new URL('//diary/', site)` reads `diary` as a
  // *hostname* and yields `https://diary/` — a canonical pointing at a host that does not
  // exist, emitted silently. `BASE_PATH` is operator-set and unnormalized, so a stray
  // extra slash is reachable. A base path is always a path: collapse the leading run.
  return new URL(path.replace(/^\/+/, '/'), site).toString();
}
